//! Which scan candidates hold git-tracked content.
//!
//! Build output is never committed. A candidate that is, or contains, a path
//! in its repository's index holds authored work whatever its name. This is
//! the same question `git ls-files --cached -- <paths>` answers, answered by
//! reading `.git/index` directly: no process per repository, and none of the
//! repository's config (a hostile clone's `core.fsmonitor` names a program)
//! is ever consulted. Repositories are checked in parallel.
//!
//! Index layouts this reader does not handle in full (a split index, a sparse
//! index, an unknown version, an oversized file) fall back to the hardened
//! `git ls-files` invocation the JavaScript implementation uses. When neither
//! the index reader nor `git` can answer for a repository, those candidates are
//! reported as `unknown` so callers fail closed rather than treating them as
//! untracked.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Larger indexes exist only in very large monorepos; git reads those fine.
const MAX_INDEX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: u32 = 20_000_000;
const MAX_PATH_BYTES: usize = 64 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const PATHSPEC_CHUNK_BYTES: usize = 64 * 1024;
const MAX_WORKERS: usize = 8;

/// Classification of repository candidates checked for git-tracked files.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TrackedPaths {
    /// Paths confirmed to be, or contain, git-tracked files.
    pub tracked: HashSet<PathBuf>,
    /// Paths inside a git repository whose tracked status could not be checked.
    pub unknown: HashSet<PathBuf>,
}

/// Classify `paths` into git-tracked and unknown-status subsets.
///
/// `paths` are absolute. Paths outside any git repository appear in neither set.
pub fn tracked_paths(paths: &[PathBuf]) -> TrackedPaths {
    tracked_paths_with_path(
        paths,
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("PATHEXT").as_deref(),
    )
}

fn tracked_paths_with_path(
    paths: &[PathBuf],
    path_env: Option<&OsStr>,
    pathext_env: Option<&OsStr>,
) -> TrackedPaths {
    let mut by_root: HashMap<PathBuf, Vec<&PathBuf>> = HashMap::new();
    let mut root_cache: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    for path in paths {
        let Some(parent) = path.parent() else {
            continue;
        };
        if let Some(root) = find_repo_root(parent, &mut root_cache) {
            by_root.entry(root).or_default().push(path);
        }
    }

    let repos: Vec<(PathBuf, Vec<&PathBuf>)> = by_root.into_iter().collect();
    let result = Mutex::new(TrackedPaths::default());
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, MAX_WORKERS)
        .min(repos.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some((root, members)) = repos.get(index) else {
                    break;
                };
                let (found_tracked, found_unknown) =
                    tracked_in_repo(root, members, path_env, pathext_env);
                if !found_tracked.is_empty() || !found_unknown.is_empty() {
                    let mut guard = result
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    guard.tracked.extend(found_tracked);
                    guard.unknown.extend(found_unknown);
                }
            });
        }
    });
    let mut out = result
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    out.unknown.retain(|path| !out.tracked.contains(path));
    out
}

/// Nearest ancestor holding `.git` (a directory, or a file for worktrees
/// and submodules). Mirrors the JavaScript walk, cache included.
fn find_repo_root(start: &Path, cache: &mut HashMap<PathBuf, Option<PathBuf>>) -> Option<PathBuf> {
    let mut visited = Vec::new();
    let mut dir = start.to_path_buf();
    let found = loop {
        if let Some(cached) = cache.get(&dir) {
            break cached.clone();
        }
        visited.push(dir.clone());
        if dir.join(".git").exists() {
            break Some(dir);
        }
        match dir.parent() {
            Some(parent) if parent != dir => dir = parent.to_path_buf(),
            _ => break None,
        }
    };
    for seen in visited {
        cache.insert(seen, found.clone());
    }
    found
}

fn tracked_in_repo(
    root: &Path,
    members: &[&PathBuf],
    path_env: Option<&OsStr>,
    pathext_env: Option<&OsStr>,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    // Index paths are `/`-separated bytes relative to the work tree.
    let mut rels: Vec<(Vec<u8>, &PathBuf)> = Vec::new();
    let mut unknown: Vec<PathBuf> = Vec::new();
    for &path in members {
        match path.strip_prefix(root).ok().and_then(|rel| rel.to_str()) {
            Some(text) => rels.push((text.replace('\\', "/").into_bytes(), path)),
            None => unknown.push(path.clone()),
        }
    }
    if rels.is_empty() {
        return (Vec::new(), unknown);
    }
    match read_index_paths(root) {
        Ok(entries) => {
            let tracked = rels
                .into_iter()
                .filter(|(rel, _)| contains_tracked(&entries, rel))
                .map(|(_, path)| path.clone())
                .collect();
            (tracked, unknown)
        }
        Err(IndexError::Unsupported) => {
            let (tracked, mut git_unknown) = tracked_via_git(root, &rels, path_env, pathext_env);
            unknown.append(&mut git_unknown);
            (tracked, unknown)
        }
    }
}

/// `entries` is sorted. A candidate is tracked when an entry equals it or
/// lies beneath it. `-` and `.` sort before `/`, so `dist-x` sits between
/// `dist` and `dist/a`: search for the `dist/` prefix explicitly.
fn contains_tracked(entries: &[Vec<u8>], rel: &[u8]) -> bool {
    if entries
        .binary_search_by(|entry| entry.as_slice().cmp(rel))
        .is_ok()
    {
        return true;
    }
    let mut prefix = rel.to_vec();
    prefix.push(b'/');
    let at = entries.partition_point(|entry| entry.as_slice() < prefix.as_slice());
    entries
        .get(at)
        .is_some_and(|entry| entry.starts_with(&prefix))
}

#[derive(Debug, PartialEq, Eq)]
enum IndexError {
    /// Hand this repository to `git` instead.
    Unsupported,
}

/// The index file `git` itself would read for this work tree.
fn index_file(root: &Path) -> Result<Option<PathBuf>, IndexError> {
    let dot_git = root.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).map_err(|_| IndexError::Unsupported)?;
    if meta.is_dir() {
        return Ok(Some(dot_git.join("index")));
    }
    if !meta.is_file() || meta.len() > 4096 {
        return Err(IndexError::Unsupported);
    }
    // Worktrees and submodules: `gitdir: <path>`, relative to the work tree.
    let text = std::fs::read_to_string(&dot_git).map_err(|_| IndexError::Unsupported)?;
    let gitdir = text
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(IndexError::Unsupported)?;
    let gitdir = Path::new(gitdir);
    let gitdir = if gitdir.is_absolute() {
        gitdir.to_path_buf()
    } else {
        root.join(gitdir)
    };
    if !gitdir.is_dir() {
        return Err(IndexError::Unsupported);
    }
    Ok(Some(gitdir.join("index")))
}

fn read_index_paths(root: &Path) -> Result<Vec<Vec<u8>>, IndexError> {
    let Some(path) = index_file(root)? else {
        return Ok(Vec::new());
    };
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        // No index yet: nothing staged, nothing committed - `git ls-files` agrees.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(IndexError::Unsupported),
    };
    let len = file.metadata().map_err(|_| IndexError::Unsupported)?.len();
    if len > MAX_INDEX_BYTES {
        return Err(IndexError::Unsupported);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(MAX_INDEX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IndexError::Unsupported)?;
    // SHA-1 repositories are the norm; SHA-256 ones store 32-byte names.
    parse_index(&bytes, 20).or_else(|_| parse_index(&bytes, 32))
}

/// Parse the path of every index entry. Bounds-checked throughout: the file
/// comes from a repository sweep did not create.
fn parse_index(bytes: &[u8], hash_len: usize) -> Result<Vec<Vec<u8>>, IndexError> {
    let mut reader = Reader { bytes, at: 0 };
    if reader.take(4)? != b"DIRC" {
        return Err(IndexError::Unsupported);
    }
    let version = reader.u32()?;
    if !(2..=4).contains(&version) {
        return Err(IndexError::Unsupported);
    }
    let count = reader.u32()?;
    if count > MAX_ENTRIES {
        return Err(IndexError::Unsupported);
    }
    let mut paths: Vec<Vec<u8>> = Vec::with_capacity(count.min(1 << 20) as usize);
    let mut previous: Vec<u8> = Vec::new();
    for _ in 0..count {
        let start = reader.at;
        // ctime, mtime, dev, ino, mode, uid, gid, size: ten u32 fields.
        reader.take(40)?;
        reader.take(hash_len)?;
        let flags = reader.u16()?;
        let extended = flags & 0x4000 != 0;
        if extended {
            if version < 3 {
                return Err(IndexError::Unsupported);
            }
            reader.take(2)?;
        }
        let name_len = usize::from(flags & 0x0fff);
        let path = if version == 4 {
            let strip = reader.varint()?;
            let suffix = reader.until_nul()?;
            let keep = previous
                .len()
                .checked_sub(strip)
                .ok_or(IndexError::Unsupported)?;
            let mut path = previous[..keep].to_vec();
            path.extend_from_slice(suffix);
            path
        } else {
            let name = reader.until_nul()?;
            // A short name's length is stored exactly; 0xfff means "longer".
            if name_len < 0x0fff && name.len() != name_len {
                return Err(IndexError::Unsupported);
            }
            // Entries pad with NULs to a multiple of eight bytes, the
            // terminating NUL included.
            let fixed = reader.at - start - name.len() - 1;
            let padded = (fixed + name.len() + 8) & !7;
            let pad = padded - (reader.at - start);
            let padding = reader.take(pad)?;
            if padding.iter().any(|&byte| byte != 0) {
                return Err(IndexError::Unsupported);
            }
            name.to_vec()
        };
        if path.is_empty() || path.len() > MAX_PATH_BYTES {
            return Err(IndexError::Unsupported);
        }
        previous.clone_from(&path);
        paths.push(path);
    }
    // Extensions follow the entries, then the trailing checksum. A split
    // index keeps entries elsewhere; a sparse index collapses directories.
    while reader.remaining() > hash_len {
        let signature = reader.take(4)?;
        let size = reader.u32()? as usize;
        if signature == b"link" || signature == b"sdir" {
            return Err(IndexError::Unsupported);
        }
        reader.take(size)?;
    }
    if reader.remaining() != hash_len {
        return Err(IndexError::Unsupported);
    }
    paths.sort_unstable();
    paths.dedup();
    Ok(paths)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], IndexError> {
        let end = self.at.checked_add(n).ok_or(IndexError::Unsupported)?;
        let slice = self
            .bytes
            .get(self.at..end)
            .ok_or(IndexError::Unsupported)?;
        self.at = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, IndexError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, IndexError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn until_nul(&mut self) -> Result<&'a [u8], IndexError> {
        let rest = self.bytes.get(self.at..).ok_or(IndexError::Unsupported)?;
        let len = rest
            .iter()
            .take(MAX_PATH_BYTES + 1)
            .position(|&byte| byte == 0)
            .ok_or(IndexError::Unsupported)?;
        let name = &rest[..len];
        self.at += len + 1;
        Ok(name)
    }

    /// git's offset varint (index v4 path prefix lengths).
    fn varint(&mut self) -> Result<usize, IndexError> {
        let mut byte = self.take(1)?[0];
        let mut value = usize::from(byte & 0x7f);
        while byte & 0x80 != 0 {
            byte = self.take(1)?[0];
            value = value
                .checked_add(1)
                .and_then(|v| v.checked_mul(128))
                .and_then(|v| v.checked_add(usize::from(byte & 0x7f)))
                .ok_or(IndexError::Unsupported)?;
        }
        Ok(value)
    }
}

/// The JavaScript implementation's invocation, unchanged: no fsmonitor, no
/// untracked cache, no optional locks, literal pathspecs after `--`.
fn tracked_via_git(
    root: &Path,
    rels: &[(Vec<u8>, &PathBuf)],
    path_env: Option<&OsStr>,
    pathext_env: Option<&OsStr>,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let Some(git_binary) = resolve_absolute_on_path_in("git", path_env, pathext_env) else {
        return (
            Vec::new(),
            rels.iter().map(|(_, path)| (*path).clone()).collect(),
        );
    };
    let by_rel: HashMap<&[u8], &PathBuf> = rels
        .iter()
        .map(|(rel, path)| (rel.as_slice(), *path))
        .collect();
    let mut tracked = Vec::new();
    let mut unknown = Vec::new();
    let mut chunk: Vec<&str> = Vec::new();
    let mut chunk_bytes = 0;
    let flush = |chunk: &mut Vec<&str>, tracked: &mut Vec<PathBuf>, unknown: &mut Vec<PathBuf>| {
        if chunk.is_empty() {
            return;
        }
        match run_git_ls_files(&git_binary, root, chunk) {
            Some(stdout) => {
                for file in stdout.split(|&byte| byte == 0).filter(|f| !f.is_empty()) {
                    let mut rel = file;
                    loop {
                        if let Some(path) = by_rel.get(rel) {
                            tracked.push((*path).clone());
                            break;
                        }
                        match rel.iter().rposition(|&byte| byte == b'/') {
                            Some(cut) => rel = &rel[..cut],
                            None => break,
                        }
                    }
                }
            }
            None => {
                for &rel in chunk.iter() {
                    if let Some(path) = by_rel.get(rel.as_bytes()) {
                        unknown.push((*path).clone());
                    }
                }
            }
        }
        chunk.clear();
    };
    for (rel, path) in rels {
        let Ok(text) = std::str::from_utf8(rel) else {
            unknown.push((*path).clone());
            continue;
        };
        if !chunk.is_empty() && chunk_bytes + text.len() + 1 > PATHSPEC_CHUNK_BYTES {
            flush(&mut chunk, &mut tracked, &mut unknown);
            chunk_bytes = 0;
        }
        chunk.push(text);
        chunk_bytes += text.len() + 1;
    }
    flush(&mut chunk, &mut tracked, &mut unknown);
    tracked.sort();
    tracked.dedup();
    unknown.sort();
    unknown.dedup();
    (tracked, unknown)
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && (meta.permissions().mode() & 0o111) != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn windows_shell_free_extensions(pathext: Option<&OsStr>) -> Vec<String> {
    let raw = pathext.and_then(OsStr::to_str).unwrap_or(".COM;.EXE");
    let mut ordered = Vec::new();
    for entry in raw.split(';') {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = if trimmed.starts_with('.') {
            trimmed.to_ascii_lowercase()
        } else {
            format!(".{}", trimmed.to_ascii_lowercase())
        };
        if (normalized == ".exe" || normalized == ".com") && !ordered.contains(&normalized) {
            ordered.push(normalized);
        }
    }
    if ordered.is_empty() {
        vec![".exe".to_string(), ".com".to_string()]
    } else {
        ordered
    }
}

/// Resolve a bare command name using only absolute `PATH` directories.
/// Skips empty, whitespace-only, `.`, and relative entries on every platform.
fn resolve_absolute_on_path_in(
    binary: &str,
    path_env: Option<&OsStr>,
    #[cfg_attr(not(windows), allow(unused_variables))] pathext_env: Option<&OsStr>,
) -> Option<PathBuf> {
    let path_env = path_env?;
    for dir in std::env::split_paths(path_env) {
        if dir.as_os_str().is_empty()
            || dir.to_str().is_some_and(|text| text.trim().is_empty())
            || !dir.is_absolute()
        {
            continue;
        }
        #[cfg(windows)]
        {
            let has_ext = Path::new(binary).extension().is_some();
            if has_ext {
                let candidate = dir.join(binary);
                if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
                    return Some(candidate);
                }
            } else {
                for ext in windows_shell_free_extensions(pathext_env) {
                    let candidate = dir.join(format!("{binary}{ext}"));
                    if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
                        return Some(candidate);
                    }
                }
            }
        }
        #[cfg(unix)]
        {
            let candidate = dir.join(binary);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let candidate = dir.join(binary);
            if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
                return Some(candidate);
            }
        }
    }
    None
}

fn run_git_ls_files(git_binary: &Path, root: &Path, pathspecs: &[&str]) -> Option<Vec<u8>> {
    let mut child = Command::new(git_binary)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.quotePath=false",
            "-C",
        ])
        .arg(root)
        .args(["ls-files", "-z", "--cached", "--"])
        .args(pathspecs)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        stdout
            .by_ref()
            .take(256 * 1024 * 1024)
            .read_to_end(&mut out)
            .ok()
            .map(|_| out)
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().ok().flatten()?;
    status
        .filter(std::process::ExitStatus::success)
        .map(|_| out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &[u8], version: u32, previous: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 40];
        out.extend_from_slice(&[0xab; 20]);
        let flags = u16::try_from(path.len().min(0x0fff)).unwrap_or(0x0fff);
        out.extend_from_slice(&flags.to_be_bytes());
        if version == 4 {
            let common = previous
                .iter()
                .zip(path)
                .take_while(|(a, b)| a == b)
                .count();
            let strip = previous.len() - common;
            assert!(strip < 128, "test helper encodes single-byte varints");
            out.push(u8::try_from(strip).unwrap_or(0));
            out.extend_from_slice(&path[common..]);
            out.push(0);
        } else {
            out.extend_from_slice(path);
            let padded = (62 + path.len() + 8) & !7;
            out.resize(padded, 0);
        }
        out
    }

    fn index(version: u32, paths: &[&[u8]], extensions: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut out = b"DIRC".to_vec();
        out.extend_from_slice(&version.to_be_bytes());
        out.extend_from_slice(&u32::try_from(paths.len()).unwrap_or(0).to_be_bytes());
        let mut previous: &[u8] = b"";
        for path in paths {
            out.extend_from_slice(&entry(path, version, previous));
            previous = path;
        }
        for (signature, body) in extensions {
            out.extend_from_slice(*signature);
            out.extend_from_slice(&u32::try_from(body.len()).unwrap_or(0).to_be_bytes());
            out.extend_from_slice(body);
        }
        out.extend_from_slice(&[0u8; 20]);
        out
    }

    const PATHS: &[&[u8]] = &[b"apps/web/dist/vendor.js", b"dist-x/a", b"src/main.rs"];

    #[test]
    fn reads_v2_v3_and_v4_indexes_alike() {
        for version in [2, 3, 4] {
            let parsed = parse_index(&index(version, PATHS, &[]), 20);
            assert_eq!(
                parsed.as_deref().map(<[Vec<u8>]>::len),
                Ok(3),
                "version {version}"
            );
            let entries = parsed.unwrap_or_default();
            assert!(contains_tracked(&entries, b"apps/web/dist"));
            assert!(contains_tracked(&entries, b"src/main.rs"));
            assert!(
                !contains_tracked(&entries, b"dist"),
                "dist-x must not count as dist"
            );
            assert!(!contains_tracked(&entries, b"apps/web/dis"));
        }
    }

    #[test]
    fn layouts_it_cannot_read_in_full_go_to_git() {
        let split = index(2, PATHS, &[(b"link", b"0123456789")]);
        assert_eq!(parse_index(&split, 20), Err(IndexError::Unsupported));
        let sparse = index(2, PATHS, &[(b"sdir", b"")]);
        assert_eq!(parse_index(&sparse, 20), Err(IndexError::Unsupported));
        // Ordinary extensions (cached tree, end-of-index) are skipped.
        let tree = index(2, PATHS, &[(b"TREE", b"payload")]);
        assert!(parse_index(&tree, 20).is_ok());
    }

    #[test]
    fn hostile_or_truncated_indexes_never_panic() {
        let good = index(4, PATHS, &[]);
        for cut in 0..good.len() {
            let _ = parse_index(&good[..cut], 20);
        }
        let mut lying = index(2, PATHS, &[]);
        lying[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(parse_index(&lying, 20), Err(IndexError::Unsupported));
        assert_eq!(parse_index(b"NOPE", 20), Err(IndexError::Unsupported));
    }

    #[test]
    fn path_lookup_skips_empty_and_relative_entries() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let bin_dir = dir.path().join("bin");
        std::fs::create_dir_all(&bin_dir)?;
        let name = if cfg!(windows) { "git.exe" } else { "git" };
        let planted = bin_dir.join(name);
        std::fs::write(&planted, b"#!/bin/sh\nexit 0\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&planted)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&planted, perms)?;
        }

        let sep = if cfg!(windows) { ";" } else { ":" };
        let missing = if cfg!(windows) {
            "C:\\nonexistent-sweep-git"
        } else {
            "/nonexistent-sweep-git"
        };
        let bad_entries = [
            String::new(),
            format!("{sep}{missing}"),
            format!("{missing}{sep}"),
            format!("{missing}{sep}{sep}{missing}"),
            " ".to_string(),
            ".".to_string(),
            "bin".to_string(),
            format!(".{}bin", std::path::MAIN_SEPARATOR),
        ];
        for raw in &bad_entries {
            assert_eq!(
                resolve_absolute_on_path_in("git", Some(OsStr::new(raw)), None),
                None,
                "must skip PATH entry {raw:?}"
            );
        }

        let with_abs = format!("{sep}.{sep}bin{sep}{}", bin_dir.display());
        assert_eq!(
            resolve_absolute_on_path_in("git", Some(OsStr::new(&with_abs)), None),
            Some(planted)
        );
        Ok(())
    }

    #[test]
    fn unsupported_index_without_git_marks_repo_paths_unknown() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let outside = dir.path().join("outside");
        let repo_dist = repo.join("dist");
        let outside_dist = outside.join("dist");
        std::fs::create_dir_all(repo.join(".git"))?;
        std::fs::create_dir_all(&repo_dist)?;
        std::fs::create_dir_all(&outside_dist)?;
        // Split index extension forces fallback to git.
        let split = index(2, PATHS, &[(b"link", b"0123456789")]);
        std::fs::write(repo.join(".git").join("index"), split)?;

        let result = tracked_paths_with_path(
            &[repo_dist.clone(), outside_dist.clone()],
            Some(OsStr::new("")),
            None,
        );
        assert!(result.tracked.is_empty());
        assert!(result.unknown.contains(&repo_dist));
        assert!(!result.unknown.contains(&outside_dist));
        Ok(())
    }
}
