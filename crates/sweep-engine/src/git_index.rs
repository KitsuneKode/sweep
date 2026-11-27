//! Which scan candidates hold git-tracked content.
//!
//! Build output is never committed. A candidate that is, or contains, a path
//! in any enclosing repository's index holds authored work whatever its name.
//!
//! 1. Git is the source of truth: when an absolute `git` executable is on
//!    `PATH`, every enclosing repository is queried via a sanitized
//!    `git ls-files -z --cached` invocation (all inherited `GIT_*` variables
//!    cleared, `core.fsmonitor=false`, `LC_ALL=C`). Its answer counts only on
//!    exit 0 with valid NUL-delimited output; any error, timeout, or parse
//!    failure marks every candidate in that repository `unknown`.
//! 2. The native index reader is used only when `git` is unavailable. Its
//!    answer counts only if the repository validates (gitdir resolves, `HEAD`
//!    exists and is readable, the index parses and its SHA-1/SHA-256 checksum
//!    verifies) and the parsed index is non-empty; any validation failure or
//!    empty native result marks every candidate in that repository `unknown`.
//! 3. Candidates are checked against every enclosing repository up to the
//!    filesystem root: tracked if any enclosing repository tracks it, unknown
//!    if any enclosing check is unknown.

use sha2::{Digest, Sha256};
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
const MAX_GIT_STDOUT: u64 = 256 * 1024 * 1024;
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
    let mut root_cache: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for path in paths {
        let Some(parent) = path.parent() else {
            continue;
        };
        for root in find_enclosing_repo_roots(parent, &mut root_cache) {
            by_root.entry(root).or_default().push(path);
        }
    }
    if by_root.is_empty() {
        return TrackedPaths::default();
    }

    let git_binary = resolve_absolute_on_path_in("git", path_env, pathext_env);
    let git_binary = git_binary.as_deref();
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
                let (found_tracked, found_unknown) = tracked_in_repo(root, members, git_binary);
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

fn has_dot_git(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok()
}

/// Every enclosing ancestor holding `.git` (a directory, a gitfile for worktrees
/// and submodules, or even a broken symlink), nearest first up to the
/// filesystem root. Mirrors the JavaScript walk, cache included.
fn find_enclosing_repo_roots(
    start: &Path,
    cache: &mut HashMap<PathBuf, Vec<PathBuf>>,
) -> Vec<PathBuf> {
    let mut chain = Vec::new();
    let mut dir = start.to_path_buf();
    let mut inherited = loop {
        if let Some(cached) = cache.get(&dir) {
            break cached.clone();
        }
        chain.push(dir.clone());
        match dir.parent() {
            Some(parent) if parent != dir => dir = parent.to_path_buf(),
            _ => break Vec::new(),
        }
    };
    for ancestor in chain.into_iter().rev() {
        if has_dot_git(&ancestor) {
            let mut roots = Vec::with_capacity(inherited.len() + 1);
            roots.push(ancestor.clone());
            roots.extend(inherited.iter().cloned());
            inherited = roots;
        }
        cache.insert(ancestor, inherited.clone());
    }
    inherited
}

fn tracked_in_repo(
    root: &Path,
    members: &[&PathBuf],
    git_binary: Option<&Path>,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    // Index paths are `/`-separated bytes relative to the work tree.
    let mut rels: Vec<(Vec<u8>, &PathBuf)> = Vec::new();
    let mut unknown: Vec<PathBuf> = Vec::new();
    for &path in members {
        match path.strip_prefix(root).ok().and_then(|rel| rel.to_str()) {
            Some(text) if !text.is_empty() => {
                rels.push((text.replace('\\', "/").into_bytes(), path));
            }
            _ => unknown.push(path.clone()),
        }
    }
    if rels.is_empty() {
        return (Vec::new(), unknown);
    }
    if let Some(git_binary) = git_binary {
        let (tracked, mut git_unknown) = tracked_via_git(git_binary, root, &rels);
        unknown.append(&mut git_unknown);
        return (tracked, unknown);
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
            unknown.extend(rels.into_iter().map(|(_, path)| path.clone()));
            (Vec::new(), unknown)
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
    /// Native reader cannot validate or read this repository's index cleanly.
    Unsupported,
}

/// Resolve the git directory for `root` (`.git` directory or `gitdir:` file).
fn resolve_gitdir(root: &Path) -> Result<PathBuf, IndexError> {
    let dot_git = root.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).map_err(|_| IndexError::Unsupported)?;
    if meta.is_dir() {
        return Ok(dot_git);
    }
    if !meta.is_file() || meta.len() > 4096 {
        return Err(IndexError::Unsupported);
    }
    // Worktrees and submodules: `gitdir: <path>`, relative to the work tree.
    let text = std::fs::read_to_string(&dot_git).map_err(|_| IndexError::Unsupported)?;
    let trimmed = text.trim_end_matches(['\r', '\n']);
    if trimmed.contains(['\r', '\n', '\0']) {
        return Err(IndexError::Unsupported);
    }
    let gitdir = trimmed
        .strip_prefix("gitdir:")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(IndexError::Unsupported)?;
    let gitdir = Path::new(gitdir);
    let gitdir = if gitdir.is_absolute() {
        gitdir.to_path_buf()
    } else {
        root.join(gitdir)
    };
    if !std::fs::metadata(&gitdir).is_ok_and(|meta| meta.is_dir()) {
        return Err(IndexError::Unsupported);
    }
    Ok(gitdir)
}

/// Confirm `HEAD` exists and is readable as a symbolic ref or commit OID.
fn validate_head(gitdir: &Path) -> Result<(), IndexError> {
    let head_path = gitdir.join("HEAD");
    let file = std::fs::File::open(&head_path).map_err(|_| IndexError::Unsupported)?;
    let meta = file.metadata().map_err(|_| IndexError::Unsupported)?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 4096 {
        return Err(IndexError::Unsupported);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| IndexError::Unsupported)?;
    if bytes.is_empty() || bytes.len() > 4096 {
        return Err(IndexError::Unsupported);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| IndexError::Unsupported)?;
    let line = text.trim();
    if line.is_empty() || line.contains(['\r', '\n', '\0']) {
        return Err(IndexError::Unsupported);
    }
    let is_symref = line
        .strip_prefix("ref:")
        .map(str::trim)
        .is_some_and(|target| !target.is_empty());
    let is_oid =
        (line.len() == 40 || line.len() == 64) && line.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !is_symref && !is_oid {
        return Err(IndexError::Unsupported);
    }
    Ok(())
}

fn read_index_paths(root: &Path) -> Result<Vec<Vec<u8>>, IndexError> {
    let gitdir = resolve_gitdir(root)?;
    validate_head(&gitdir)?;
    let path = gitdir.join("index");
    let file = std::fs::File::open(&path).map_err(|_| IndexError::Unsupported)?;
    let len = file.metadata().map_err(|_| IndexError::Unsupported)?.len();
    if len > MAX_INDEX_BYTES {
        return Err(IndexError::Unsupported);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(MAX_INDEX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IndexError::Unsupported)?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err(IndexError::Unsupported);
    }
    // SHA-1 repositories are the norm; SHA-256 ones store 32-byte names.
    let entries = parse_index(&bytes, 20).or_else(|_| parse_index(&bytes, 32))?;
    if entries.is_empty() {
        return Err(IndexError::Unsupported);
    }
    Ok(entries)
}

fn verify_index_checksum(payload: &[u8], expected: &[u8]) -> bool {
    match expected.len() {
        20 => sha1_digest(payload).as_slice() == expected,
        32 => Sha256::digest(payload).as_slice() == expected,
        _ => false,
    }
}

/// FIPS 180-4 SHA-1 used only to verify git index file integrity checksums.
fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x6745_2301;
    let mut h1: u32 = 0xEFCD_AB89;
    let mut h2: u32 = 0x98BA_DCFE;
    let mut h3: u32 = 0x1032_5476;
    let mut h4: u32 = 0xC3D2_E1F0;

    let compress =
        |block: &[u8; 64], h0: &mut u32, h1: &mut u32, h2: &mut u32, h3: &mut u32, h4: &mut u32| {
            let mut w = [0u32; 80];
            let (words, _) = block.as_chunks::<4>();
            for (slot, chunk) in w.iter_mut().zip(words.iter()) {
                *slot = u32::from_be_bytes(*chunk);
            }
            for i in 16..80 {
                w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
            }
            let (mut a, mut b, mut c, mut d, mut e) = (*h0, *h1, *h2, *h3, *h4);
            for (i, &word) in w.iter().enumerate() {
                let (f, k) = match i {
                    0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                    20..=39 => (b ^ c ^ d, 0x6ED9_EBA1u32),
                    40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC_u32),
                    _ => (b ^ c ^ d, 0xCA62_C1D6u32),
                };
                let temp = a
                    .rotate_left(5)
                    .wrapping_add(f)
                    .wrapping_add(e)
                    .wrapping_add(k)
                    .wrapping_add(word);
                e = d;
                d = c;
                c = b.rotate_left(30);
                b = a;
                a = temp;
            }
            *h0 = h0.wrapping_add(a);
            *h1 = h1.wrapping_add(b);
            *h2 = h2.wrapping_add(c);
            *h3 = h3.wrapping_add(d);
            *h4 = h4.wrapping_add(e);
        };

    let (blocks, rem) = data.as_chunks::<64>();
    for block in blocks {
        compress(block, &mut h0, &mut h1, &mut h2, &mut h3, &mut h4);
    }

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut tail = [0u8; 128];
    tail[..rem.len()].copy_from_slice(rem);
    tail[rem.len()] = 0x80;
    let total_tail = if rem.len() + 1 + 8 <= 64 { 64 } else { 128 };
    tail[total_tail - 8..total_tail].copy_from_slice(&bit_len.to_be_bytes());
    let mut first = [0u8; 64];
    first.copy_from_slice(&tail[..64]);
    compress(&first, &mut h0, &mut h1, &mut h2, &mut h3, &mut h4);
    if total_tail == 128 {
        let mut second = [0u8; 64];
        second.copy_from_slice(&tail[64..128]);
        compress(&second, &mut h0, &mut h1, &mut h2, &mut h3, &mut h4);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

/// Parse the path of every index entry and verify its trailing checksum.
/// Bounds-checked throughout: the file comes from a repository sweep did not create.
fn parse_index(bytes: &[u8], hash_len: usize) -> Result<Vec<Vec<u8>>, IndexError> {
    if bytes.len() < 12 + hash_len {
        return Err(IndexError::Unsupported);
    }
    let (payload, checksum) = bytes.split_at(bytes.len() - hash_len);
    if !verify_index_checksum(payload, checksum) {
        return Err(IndexError::Unsupported);
    }
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

/// Ask `git ls-files -z --cached` with a sanitized environment. Any non-zero
/// exit, timeout, or parse problem makes every path in this repository unknown.
fn tracked_via_git(
    git_binary: &Path,
    root: &Path,
    rels: &[(Vec<u8>, &PathBuf)],
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let all_unknown = || {
        (
            Vec::new(),
            rels.iter().map(|(_, path)| (*path).clone()).collect(),
        )
    };
    let by_rel: HashMap<&[u8], &PathBuf> = rels
        .iter()
        .map(|(rel, path)| (rel.as_slice(), *path))
        .collect();
    let mut tracked = Vec::new();
    let mut chunk: Vec<&str> = Vec::new();
    let mut chunk_bytes = 0;
    let flush = |chunk: &mut Vec<&str>, tracked: &mut Vec<PathBuf>| -> bool {
        if chunk.is_empty() {
            return true;
        }
        let ok = match run_git_ls_files(git_binary, root, chunk) {
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
                true
            }
            None => false,
        };
        chunk.clear();
        ok
    };
    for (rel, _) in rels {
        let Ok(text) = std::str::from_utf8(rel) else {
            return all_unknown();
        };
        if !chunk.is_empty() && chunk_bytes + text.len() + 1 > PATHSPEC_CHUNK_BYTES {
            if !flush(&mut chunk, &mut tracked) {
                return all_unknown();
            }
            chunk_bytes = 0;
        }
        chunk.push(text);
        chunk_bytes += text.len() + 1;
    }
    if !flush(&mut chunk, &mut tracked) {
        return all_unknown();
    }
    tracked.sort();
    tracked.dedup();
    (tracked, Vec::new())
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

fn is_git_env_key(key: &OsStr) -> bool {
    key.as_encoded_bytes()
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"git_"))
}

fn run_git_ls_files(git_binary: &Path, root: &Path, pathspecs: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = Command::new(git_binary);
    cmd.env_clear();
    for (key, value) in std::env::vars_os() {
        if !is_git_env_key(&key) {
            cmd.env(key, value);
        }
    }
    let mut child = cmd
        .args([
            "--no-pager",
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
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("LANGUAGE", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
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
            .take(MAX_GIT_STDOUT + 1)
            .read_to_end(&mut out)
            .ok()
            .and_then(|_| (out.len() as u64 <= MAX_GIT_STDOUT).then_some(out))
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
    if !out.is_empty() && !out.ends_with(b"\0") {
        return None;
    }
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
        let digest = sha1_digest(&out);
        out.extend_from_slice(&digest);
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

    fn run_git(repo: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn missing_index_in_gitfile_target_asks_git_and_marks_unknown() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let empty_gitdir = dir.path().join("not-a-gitdir");
        let preserved_gitdir = dir.path().join("preserved-gitdir");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(candidate.join("pkg"))?;
        std::fs::write(
            candidate.join("pkg").join("index.js"),
            b"module.exports = 1;\n",
        )?;
        std::fs::create_dir_all(&empty_gitdir)?;

        if git_available() {
            assert!(run_git(&repo, &["init", "-q"]));
            assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
            assert!(run_git(&repo, &["config", "user.name", "t"]));
            assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
            assert!(run_git(&repo, &["add", "node_modules/pkg/index.js"]));
            assert!(run_git(&repo, &["commit", "-qm", "init"]));
            std::fs::rename(repo.join(".git"), &preserved_gitdir)?;
        }

        let target = empty_gitdir.to_string_lossy().replace('\\', "/");
        std::fs::write(repo.join(".git"), format!("gitdir: {target}\n"))?;
        assert_eq!(read_index_paths(&repo), Err(IndexError::Unsupported));

        let result = tracked_paths(std::slice::from_ref(&candidate));
        assert!(result.tracked.is_empty());
        assert!(
            result.unknown.contains(&candidate),
            "gitfile pointing at a directory without an index must be unknown, got {result:?}"
        );
        Ok(())
    }

    #[test]
    fn missing_index_in_empty_dot_git_dir_marks_unknown() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(repo.join(".git"))?;
        std::fs::create_dir_all(&candidate)?;

        assert_eq!(read_index_paths(&repo), Err(IndexError::Unsupported));
        let result = tracked_paths(std::slice::from_ref(&candidate));
        assert!(result.tracked.is_empty());
        assert!(result.unknown.contains(&candidate));
        Ok(())
    }

    #[test]
    fn valid_repo_with_deleted_index_matches_git_and_fails_closed_without_git(
    ) -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(candidate.join("pkg"))?;
        std::fs::write(
            candidate.join("pkg").join("index.js"),
            b"module.exports = 1;\n",
        )?;

        assert!(run_git(&repo, &["init", "-q"]));
        assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&repo, &["config", "user.name", "t"]));
        assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&repo, &["add", "node_modules/pkg/index.js"]));
        assert!(run_git(&repo, &["commit", "-qm", "init"]));
        std::fs::remove_file(repo.join(".git").join("index"))?;

        assert_eq!(read_index_paths(&repo), Err(IndexError::Unsupported));

        let with_git = tracked_paths(std::slice::from_ref(&candidate));
        assert!(with_git.tracked.is_empty());
        assert!(
            with_git.unknown.is_empty(),
            "valid repo with deleted index should stay empty when git succeeds, got {with_git:?}"
        );

        let without_git =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(without_git.tracked.is_empty());
        assert!(without_git.unknown.contains(&candidate));
        Ok(())
    }

    #[test]
    fn sha1_matches_nist_vectors_and_corrupt_checksum_is_rejected() {
        assert_eq!(
            hex::encode(sha1_digest(b"")),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        assert_eq!(
            hex::encode(sha1_digest(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex::encode(sha1_digest(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );

        let mut corrupted = index(2, PATHS, &[]);
        let last = corrupted.len() - 1;
        corrupted[last] ^= 0x01;
        assert_eq!(parse_index(&corrupted, 20), Err(IndexError::Unsupported));
    }

    #[test]
    fn is_git_env_key_matches_every_git_prefix_case_insensitively() {
        for key in [
            "GIT_DIR",
            "GIT_INDEX_FILE",
            "GIT_WORK_TREE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_COMMON_DIR",
            "GIT_CEILING_DIRECTORIES",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_CUSTOM_VAR",
            "git_dir",
            "Git_Index_File",
        ] {
            assert!(is_git_env_key(OsStr::new(key)), "expected drop for {key}");
        }
        for keep in ["PATH", "HOME", "LC_ALL", "GIT", "MY_GIT_DIR"] {
            assert!(
                !is_git_env_key(OsStr::new(keep)),
                "expected keep for {keep}"
            );
        }
    }

    #[test]
    fn empty_32_byte_index_in_gitfile_target_without_head_is_unknown() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let fake_gitdir = dir.path().join("fake-gitdir");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(candidate.join("pkg"))?;
        std::fs::write(
            candidate.join("pkg").join("index.js"),
            b"module.exports = 1;\n",
        )?;
        std::fs::create_dir_all(&fake_gitdir)?;
        // 32-byte valid checksummed empty v2 index (same shape `git rm --cached` emits).
        let empty_index = index(2, &[], &[]);
        assert_eq!(empty_index.len(), 32);
        std::fs::write(fake_gitdir.join("index"), &empty_index)?;

        let target = fake_gitdir.to_string_lossy().replace('\\', "/");
        std::fs::write(repo.join(".git"), format!("gitdir: {target}\n"))?;

        assert_eq!(read_index_paths(&repo), Err(IndexError::Unsupported));

        // Both with git on PATH and without git on PATH, the candidate must be unknown.
        let with_git = tracked_paths(std::slice::from_ref(&candidate));
        assert!(with_git.tracked.is_empty());
        assert!(with_git.unknown.contains(&candidate));

        let without_git =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(without_git.tracked.is_empty());
        assert!(without_git.unknown.contains(&candidate));

        // Even with a valid HEAD added, an empty native index must still be unknown without git.
        std::fs::write(fake_gitdir.join("HEAD"), b"ref: refs/heads/main\n")?;
        assert_eq!(read_index_paths(&repo), Err(IndexError::Unsupported));
        let without_git_with_head =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(without_git_with_head.tracked.is_empty());
        assert!(without_git_with_head.unknown.contains(&candidate));
        Ok(())
    }

    #[test]
    fn native_reader_validates_head_and_checksum_when_git_is_unavailable() -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(candidate.join("pkg"))?;
        std::fs::write(
            candidate.join("pkg").join("index.js"),
            b"module.exports = 1;\n",
        )?;

        assert!(run_git(&repo, &["init", "-q"]));
        assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&repo, &["config", "user.name", "t"]));
        assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&repo, &["add", "node_modules/pkg/index.js"]));
        assert!(run_git(&repo, &["commit", "-qm", "init"]));

        // Healthy repo without git on PATH validates and reports tracked.
        let healthy =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(healthy.tracked.contains(&candidate));
        assert!(healthy.unknown.is_empty());

        // Missing HEAD invalidates the native reader.
        let head_path = repo.join(".git").join("HEAD");
        let saved_head = std::fs::read(&head_path)?;
        std::fs::remove_file(&head_path)?;
        let no_head =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(no_head.tracked.is_empty());
        assert!(no_head.unknown.contains(&candidate));
        std::fs::write(&head_path, saved_head)?;

        // Corrupting the index checksum invalidates the native reader.
        let index_path = repo.join(".git").join("index");
        let mut raw = std::fs::read(&index_path)?;
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        std::fs::write(&index_path, raw)?;
        let bad_checksum =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(bad_checksum.tracked.is_empty());
        assert!(bad_checksum.unknown.contains(&candidate));
        Ok(())
    }

    #[test]
    fn nested_repo_does_not_hide_parent_tracked_candidate() -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let parent = dir.path().join("parent");
        let nested = parent.join("nested");
        let candidate = nested.join("node_modules");
        std::fs::create_dir_all(candidate.join("pkg"))?;
        std::fs::write(
            candidate.join("pkg").join("index.js"),
            b"module.exports = 1;\n",
        )?;

        assert!(run_git(&parent, &["init", "-q"]));
        assert!(run_git(&parent, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&parent, &["config", "user.name", "t"]));
        assert!(run_git(&parent, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(
            &parent,
            &["add", "nested/node_modules/pkg/index.js"]
        ));
        assert!(run_git(&parent, &["commit", "-qm", "init"]));
        assert!(run_git(&nested, &["init", "-q"]));

        let with_git = tracked_paths(std::slice::from_ref(&candidate));
        assert!(with_git.tracked.contains(&candidate));
        assert!(with_git.unknown.is_empty());

        let without_git =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(without_git.tracked.contains(&candidate));
        assert!(without_git.unknown.is_empty());
        Ok(())
    }

    #[test]
    fn failing_git_marks_healthy_repo_unknown_without_falling_back_to_native_reader(
    ) -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let bin_dir = dir.path().join("bin");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(candidate.join("pkg"))?;
        std::fs::create_dir_all(&bin_dir)?;
        std::fs::write(
            candidate.join("pkg").join("index.js"),
            b"module.exports = 1;\n",
        )?;

        assert!(run_git(&repo, &["init", "-q"]));
        assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&repo, &["config", "user.name", "t"]));
        assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&repo, &["add", "node_modules/pkg/index.js"]));
        assert!(run_git(&repo, &["commit", "-qm", "init"]));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let fake_git = bin_dir.join("git");
            std::fs::write(&fake_git, b"#!/bin/sh\nexit 1\n")?;
            let mut perms = std::fs::metadata(&fake_git)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake_git, perms)?;
        }
        #[cfg(windows)]
        {
            // A real executable that exits non-zero when invoked with git's flags.
            let fake_git = bin_dir.join("git.exe");
            std::fs::copy(std::env::current_exe()?, &fake_git)?;
        }

        let result = tracked_paths_with_path(
            std::slice::from_ref(&candidate),
            Some(bin_dir.as_os_str()),
            None,
        );
        assert!(result.tracked.is_empty());
        assert!(result.unknown.contains(&candidate));
        Ok(())
    }
}
