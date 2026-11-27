//! Which scan candidates hold git-tracked content or nested git repositories.
//!
//! Build output is never committed. A candidate that is, or contains, a path
//! in any enclosing repository's index holds authored work whatever its name.
//!
//! 1. Git is the source of truth: when an absolute `git` executable is on
//!    `PATH`, every enclosing repository (including the candidate directory
//!    itself when it holds `.git`) is verified with `git rev-parse --show-toplevel`
//!    and queried once via a sanitized `git ls-files -z --cached --full-name`
//!    invocation (all inherited `GIT_*` variables cleared, network protocols
//!    and hooks disabled, `core.fsmonitor=false`, `LC_ALL=C`). Candidates are
//!    matched locally using the repository's own folding rules
//!    (`core.ignorecase`, `core.precomposeunicode` / macOS NFC). Any mismatch,
//!    error, timeout, or parse failure marks every candidate in that repository
//!    `unknown`.
//! 2. The native index reader is used only when `git` is unavailable. Every
//!    file it opens uses `sweep_fs::open_regular_nofollow` (non-blocking,
//!    no-follow, regular-file check). Its answer counts only if the repository
//!    validates (gitdir resolves, common config parses and resolves
//!    `extensions.objectFormat`, `HEAD` matches the object format, and the
//!    index — including any split-index `sharedindex.<oid>` — parses within
//!    strict resource limits and verifies its checksum for that exact hash
//!    length) with a non-empty index; any validation failure or empty native
//!    result marks every candidate in that repository `unknown`.
//! 3. Directory candidates are walked with a bounded non-symlink-following
//!    search for any `.git` entry inside them (`contains_git_repo`; hitting a
//!    bound or unreadable subdirectory marks the candidate `unknown`).

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

/// Bounded parser limits matching the JavaScript index reader.
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_GIT_STDOUT: u64 = 256 * 1024 * 1024;
const MAX_GIT_META_STDOUT: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: u32 = 500_000;
const MAX_TOTAL_PATH_BYTES: usize = 64 * 1024 * 1024;
const MAX_SPLIT_BITMAP_BITS: usize = 500_000;
const MAX_PATH_BYTES: usize = 64 * 1024;
const POINTER_MAX_BYTES: u64 = 4096;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_WORKERS: usize = 8;

const MAX_NESTED_GIT_DIRS: usize = 100_000;
const MAX_NESTED_GIT_ENTRIES: usize = 1_000_000;
const MAX_NESTED_GIT_DEPTH: usize = 128;

/// Benign cache-only extensions that do not alter the tracked entry set.
/// Every other extension (including unknown uppercase and lowercase extensions)
/// is rejected identically to the JavaScript index parser.
const ALLOWED_CACHE_EXTENSIONS: &[&[u8; 4]] =
    &[b"TREE", b"REUC", b"EOIE", b"IEOT", b"UNTR", b"FSMN"];

/// Classification of repository candidates checked for git-tracked files and
/// nested git repositories.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TrackedPaths {
    /// Paths confirmed to be, or contain, git-tracked files.
    pub tracked: HashSet<PathBuf>,
    /// Paths inside a git repository (or whose nested-repo search hit a bound)
    /// whose tracked status could not be checked.
    pub unknown: HashSet<PathBuf>,
    /// Directory candidates containing a `.git` entry at or below them.
    pub contains_git_repo: HashSet<PathBuf>,
}

/// Classify `paths` into git-tracked, unknown-status, and nested-repo subsets.
///
/// `paths` are absolute. Paths outside any git repository with no nested `.git`
/// appear in none of the sets.
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
    let mut dir_candidates: Vec<&PathBuf> = Vec::new();
    let mut unknown_initial: HashSet<PathBuf> = HashSet::new();

    for path in paths {
        let is_dir = is_real_directory(path);
        let start = if is_dir {
            path.as_path()
        } else if let Some(parent) = path.parent() {
            parent
        } else {
            continue;
        };
        for root in find_enclosing_repo_roots(start, &mut root_cache) {
            by_root.entry(root).or_default().push(path);
        }
        if is_dir {
            dir_candidates.push(path);
        } else if let Err(err) = std::fs::symlink_metadata(path) {
            if err.kind() == std::io::ErrorKind::PermissionDenied {
                unknown_initial.insert(path.clone());
            }
        }
    }

    if by_root.is_empty() && dir_candidates.is_empty() && unknown_initial.is_empty() {
        return TrackedPaths::default();
    }

    let git_binary = resolve_absolute_on_path_in("git", path_env, pathext_env);
    let git_binary = git_binary.as_deref();
    let repos: Vec<(PathBuf, Vec<&PathBuf>)> = by_root.into_iter().collect();
    let result = Mutex::new(TrackedPaths {
        tracked: HashSet::new(),
        unknown: unknown_initial,
        contains_git_repo: HashSet::new(),
    });
    let total_work = repos.len() + dir_candidates.len();
    let next_repo = AtomicUsize::new(0);
    let next_dir = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, MAX_WORKERS)
        .min(total_work.max(1));

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let index = next_repo.fetch_add(1, Ordering::Relaxed);
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
                }
                loop {
                    let index = next_dir.fetch_add(1, Ordering::Relaxed);
                    let Some(&dir) = dir_candidates.get(index) else {
                        break;
                    };
                    match contains_nested_git_dir(dir) {
                        NestedGitStatus::Found => {
                            let mut guard = result
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            guard.contains_git_repo.insert(dir.clone());
                        }
                        NestedGitStatus::Unknown => {
                            let mut guard = result
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            guard.unknown.insert(dir.clone());
                        }
                        NestedGitStatus::NotFound => {}
                    }
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

fn is_real_directory(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_dir() || meta.is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

fn has_dot_git(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok()
}

fn is_dot_git_name(name: &OsStr) -> bool {
    if cfg!(any(target_os = "macos", windows)) {
        name.to_str()
            .is_some_and(|text| text.eq_ignore_ascii_case(".git"))
    } else {
        name == OsStr::new(".git")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NestedGitStatus {
    Found,
    NotFound,
    Unknown,
}

fn contains_nested_git_dir(candidate: &Path) -> NestedGitStatus {
    contains_nested_git_with_limits(
        candidate,
        MAX_NESTED_GIT_DIRS,
        MAX_NESTED_GIT_ENTRIES,
        MAX_NESTED_GIT_DEPTH,
    )
}

fn contains_nested_git_with_limits(
    candidate: &Path,
    max_dirs: usize,
    max_entries: usize,
    max_depth: usize,
) -> NestedGitStatus {
    if !is_real_directory(candidate) {
        return NestedGitStatus::NotFound;
    }
    let mut stack: Vec<(PathBuf, usize)> = vec![(candidate.to_path_buf(), 0)];
    let mut visited_dirs: usize = 0;
    let mut visited_entries: usize = 0;
    let mut saw_error = false;

    while let Some((dir, depth)) = stack.pop() {
        visited_dirs += 1;
        if visited_dirs > max_dirs {
            return NestedGitStatus::Unknown;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                saw_error = true;
                continue;
            }
        };
        for entry in entries {
            visited_entries += 1;
            if visited_entries > max_entries {
                return NestedGitStatus::Unknown;
            }
            let Ok(entry) = entry else {
                saw_error = true;
                continue;
            };
            if is_dot_git_name(&entry.file_name()) {
                return NestedGitStatus::Found;
            }
            let Ok(file_type) = entry.file_type() else {
                saw_error = true;
                continue;
            };
            if file_type.is_symlink() || !file_type.is_dir() {
                continue;
            }
            let child_path = entry.path();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                match std::fs::symlink_metadata(&child_path) {
                    Ok(meta) if meta.file_attributes() & 0x400 != 0 => continue,
                    Ok(_) => {}
                    Err(_) => {
                        saw_error = true;
                        continue;
                    }
                }
            }
            if depth >= max_depth {
                return NestedGitStatus::Unknown;
            }
            if visited_dirs + stack.len() >= max_dirs {
                return NestedGitStatus::Unknown;
            }
            stack.push((child_path, depth + 1));
        }
    }

    if saw_error {
        NestedGitStatus::Unknown
    } else {
        NestedGitStatus::NotFound
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FoldingRules {
    ignore_case: bool,
    precompose_unicode: bool,
}

fn relative_path_bytes(root: &Path, path: &Path) -> Option<Vec<u8>> {
    let rel = path.strip_prefix(root).ok()?;
    #[cfg(windows)]
    {
        let text = rel.to_str()?;
        Some(text.replace('\\', "/").into_bytes())
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Some(rel.as_os_str().as_bytes().to_vec())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let text = rel.to_str()?;
        Some(text.as_bytes().to_vec())
    }
}

fn fold_path_bytes(bytes: &[u8], rules: FoldingRules) -> Vec<u8> {
    if !rules.ignore_case && !rules.precompose_unicode {
        return bytes.to_vec();
    }
    if bytes.is_ascii() {
        return if rules.ignore_case {
            bytes.to_ascii_lowercase()
        } else {
            bytes.to_vec()
        };
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => {
            let normalized: String = if rules.precompose_unicode {
                text.nfc().collect()
            } else {
                text.to_owned()
            };
            if rules.ignore_case {
                normalized.to_lowercase().into_bytes()
            } else {
                normalized.into_bytes()
            }
        }
        Err(_) => {
            if rules.ignore_case {
                bytes.to_ascii_lowercase()
            } else {
                bytes.to_vec()
            }
        }
    }
}

fn match_entries<'a, I>(
    entries: I,
    rels: &[(Vec<u8>, &'a PathBuf)],
    rules: FoldingRules,
) -> HashSet<PathBuf>
where
    I: Iterator<Item = &'a [u8]>,
{
    let mut tracked = HashSet::new();
    if rels.is_empty() {
        return tracked;
    }
    if !rules.ignore_case && !rules.precompose_unicode {
        let mut by_rel: HashMap<&[u8], Vec<&PathBuf>> = HashMap::new();
        for (rel, path) in rels {
            by_rel.entry(rel.as_slice()).or_default().push(*path);
        }
        for file in entries {
            let mut prefix = file;
            loop {
                if let Some(paths) = by_rel.get(prefix) {
                    for path in paths {
                        tracked.insert((*path).clone());
                    }
                }
                match prefix.iter().rposition(|&byte| byte == b'/') {
                    Some(cut) => prefix = &prefix[..cut],
                    None => break,
                }
            }
        }
        return tracked;
    }

    let mut by_key: HashMap<Vec<u8>, Vec<&PathBuf>> = HashMap::new();
    for (rel, path) in rels {
        by_key
            .entry(fold_path_bytes(rel, rules))
            .or_default()
            .push(*path);
    }
    for file in entries {
        let folded = fold_path_bytes(file, rules);
        let mut prefix = folded.as_slice();
        loop {
            if let Some(paths) = by_key.get(prefix) {
                for path in paths {
                    tracked.insert((*path).clone());
                }
            }
            match prefix.iter().rposition(|&byte| byte == b'/') {
                Some(cut) => prefix = &prefix[..cut],
                None => break,
            }
        }
    }
    tracked
}

fn tracked_in_repo(
    root: &Path,
    members: &[&PathBuf],
    git_binary: Option<&Path>,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut repo_root_members: Vec<&PathBuf> = Vec::new();
    let mut rels: Vec<(Vec<u8>, &PathBuf)> = Vec::new();
    let mut unknown: Vec<PathBuf> = Vec::new();
    for &path in members {
        match relative_path_bytes(root, path) {
            Some(rel) if rel.is_empty() => repo_root_members.push(path),
            Some(rel) => rels.push((rel, path)),
            None => unknown.push(path.clone()),
        }
    }
    if repo_root_members.is_empty() && rels.is_empty() {
        return (Vec::new(), unknown);
    }
    if let Some(git_binary) = git_binary {
        let (tracked, mut git_unknown) =
            tracked_via_git(git_binary, root, &repo_root_members, &rels);
        unknown.append(&mut git_unknown);
        return (tracked, unknown);
    }
    match read_index_native(root) {
        Ok((entries, rules)) => {
            let mut tracked = HashSet::new();
            if !entries.is_empty() {
                for path in repo_root_members {
                    tracked.insert(path.clone());
                }
                tracked.extend(match_entries(
                    entries.iter().map(Vec::as_slice),
                    &rels,
                    rules,
                ));
            }
            (tracked.into_iter().collect(), unknown)
        }
        Err(IndexError::Unsupported) => {
            unknown.extend(repo_root_members.into_iter().cloned());
            unknown.extend(rels.into_iter().map(|(_, path)| path.clone()));
            (Vec::new(), unknown)
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum IndexError {
    /// Native reader cannot validate or read this repository's index cleanly.
    Unsupported,
}

/// Open and read a regular file without following symlinks or blocking on
/// FIFOs/device nodes. Returns `Ok(None)` when missing (`NotFound`).
fn read_regular_file_bounded_opt(
    path: &Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, IndexError> {
    let Some(file) = sweep_fs::open_regular_nofollow(path).map_err(|_| IndexError::Unsupported)?
    else {
        return Ok(None);
    };
    let meta = file.metadata().map_err(|_| IndexError::Unsupported)?;
    if !meta.is_file() || meta.len() > max_bytes {
        return Err(IndexError::Unsupported);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IndexError::Unsupported)?;
    if bytes.len() as u64 > max_bytes {
        return Err(IndexError::Unsupported);
    }
    Ok(Some(bytes))
}

fn read_regular_file_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, IndexError> {
    read_regular_file_bounded_opt(path, max_bytes)?.ok_or(IndexError::Unsupported)
}

/// Resolve the git directory for `root` (`.git` directory or `gitdir:` file).
fn resolve_gitdir(root: &Path) -> Result<PathBuf, IndexError> {
    let dot_git = root.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).map_err(|_| IndexError::Unsupported)?;
    if meta.is_dir() {
        return Ok(dot_git);
    }
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > POINTER_MAX_BYTES {
        return Err(IndexError::Unsupported);
    }
    // Worktrees and submodules: `gitdir: <path>`, relative to the work tree.
    let bytes = read_regular_file_bounded(&dot_git, POINTER_MAX_BYTES)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| IndexError::Unsupported)?;
    let trimmed = text.trim_end_matches(['\r', '\n']);
    if trimmed.contains(['\r', '\n', '\0']) {
        return Err(IndexError::Unsupported);
    }
    let gitdir = trimmed
        .strip_prefix("gitdir:")
        .map(|value| value.trim_start_matches([' ', '\t']))
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

/// Resolve the common git directory for `gitdir` (handling linked worktrees).
fn resolve_commondir(gitdir: &Path) -> Result<PathBuf, IndexError> {
    let commondir_file = gitdir.join("commondir");
    let Some(bytes) = read_regular_file_bounded_opt(&commondir_file, POINTER_MAX_BYTES)? else {
        return Ok(gitdir.to_path_buf());
    };
    let text = std::str::from_utf8(&bytes).map_err(|_| IndexError::Unsupported)?;
    let trimmed = text.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() || trimmed.contains(['\r', '\n', '\0']) {
        return Err(IndexError::Unsupported);
    }
    let target = Path::new(trimmed);
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        gitdir.join(target)
    };
    if !std::fs::metadata(&resolved).is_ok_and(|meta| meta.is_dir()) {
        return Err(IndexError::Unsupported);
    }
    Ok(resolved)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NativeRepoConfig {
    hash_len: usize,
    rules: FoldingRules,
    worktree_config: bool,
}

fn parse_git_bool(raw: Option<&str>) -> Result<bool, IndexError> {
    let Some(raw) = raw else {
        return Ok(true);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    if trimmed.eq_ignore_ascii_case("true")
        || trimmed.eq_ignore_ascii_case("yes")
        || trimmed.eq_ignore_ascii_case("on")
        || trimmed == "1"
    {
        return Ok(true);
    }
    if trimmed.eq_ignore_ascii_case("false")
        || trimmed.eq_ignore_ascii_case("no")
        || trimmed.eq_ignore_ascii_case("off")
        || trimmed == "0"
    {
        return Ok(false);
    }
    Err(IndexError::Unsupported)
}

fn unquote_git_config_value(raw: &str) -> Result<String, IndexError> {
    let mut out = String::new();
    let mut in_quotes = false;
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if !in_quotes && (ch == '#' || ch == ';') {
            break;
        }
        if ch == '"' {
            in_quotes = !in_quotes;
            continue;
        }
        if ch == '\\' {
            let Some(next) = chars.next() else {
                return Err(IndexError::Unsupported);
            };
            match next {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'b' => out.push('\x08'),
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                _ => return Err(IndexError::Unsupported),
            }
            continue;
        }
        out.push(ch);
    }
    if in_quotes {
        return Err(IndexError::Unsupported);
    }
    Ok(out.trim().to_owned())
}

fn parse_config_file(
    text: &str,
    repo_format_version: &mut u32,
    object_format: &mut Option<String>,
    ignore_case: &mut Option<bool>,
    precompose_unicode: &mut Option<bool>,
    worktree_config: &mut Option<bool>,
) -> Result<(), IndexError> {
    let mut section = String::new();
    let mut has_subsection = false;

    for raw_line in text.lines() {
        let line = raw_line.trim_start();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        // Fail closed on line continuations to avoid misparsing multi-line config values.
        if raw_line.trim_end_matches('\r').ends_with('\\') {
            return Err(IndexError::Unsupported);
        }
        if let Some(rest) = line.strip_prefix('[') {
            let Some(close) = rest.find(']') else {
                return Err(IndexError::Unsupported);
            };
            let header = rest[..close].trim();
            let trailing = rest[close + 1..].trim();
            if !trailing.is_empty() && !trailing.starts_with('#') && !trailing.starts_with(';') {
                return Err(IndexError::Unsupported);
            }
            let (sec_name, sub) = if let Some(quote_start) = header.find('"') {
                (header[..quote_start].trim(), true)
            } else {
                (header, false)
            };
            section = sec_name.to_ascii_lowercase();
            has_subsection = sub;
            if section == "include" || section == "includeif" {
                return Err(IndexError::Unsupported);
            }
            continue;
        }
        if has_subsection {
            continue;
        }
        let (key_raw, val_raw) = match line.split_once('=') {
            Some((k, v)) => (k.trim().to_owned(), Some(unquote_git_config_value(v)?)),
            None => (unquote_git_config_value(line)?, None),
        };
        let key = key_raw.to_ascii_lowercase();
        match (section.as_str(), key.as_str()) {
            ("core", "repositoryformatversion") => {
                let val = val_raw.as_deref().ok_or(IndexError::Unsupported)?;
                let parsed: u32 = val.parse().map_err(|_| IndexError::Unsupported)?;
                if parsed > 1 {
                    return Err(IndexError::Unsupported);
                }
                *repo_format_version = parsed;
            }
            ("core", "ignorecase") => {
                *ignore_case = Some(parse_git_bool(val_raw.as_deref())?);
            }
            ("core", "precomposeunicode") => {
                *precompose_unicode = Some(parse_git_bool(val_raw.as_deref())?);
            }
            ("core", "worktree") => {
                return Err(IndexError::Unsupported);
            }
            ("extensions", "objectformat") => {
                let val = val_raw
                    .as_deref()
                    .ok_or(IndexError::Unsupported)?
                    .to_ascii_lowercase();
                *object_format = Some(val);
            }
            ("extensions", "worktreeconfig") => {
                *worktree_config = Some(parse_git_bool(val_raw.as_deref())?);
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_native_repo_config(gitdir: &Path) -> Result<NativeRepoConfig, IndexError> {
    let commondir = resolve_commondir(gitdir)?;
    let config_path = commondir.join("config");
    let config_bytes = read_regular_file_bounded(&config_path, MAX_CONFIG_BYTES)?;
    let config_text = std::str::from_utf8(&config_bytes).map_err(|_| IndexError::Unsupported)?;

    let mut repo_format_version: u32 = 0;
    let mut object_format: Option<String> = None;
    let mut ignore_case: Option<bool> = None;
    let mut precompose_unicode: Option<bool> = None;
    let mut worktree_config: Option<bool> = None;

    parse_config_file(
        config_text,
        &mut repo_format_version,
        &mut object_format,
        &mut ignore_case,
        &mut precompose_unicode,
        &mut worktree_config,
    )?;

    let has_worktree_config = repo_format_version >= 1 && worktree_config.unwrap_or(false);
    if has_worktree_config {
        let wt_config_path = gitdir.join("config.worktree");
        if let Some(wt_bytes) = read_regular_file_bounded_opt(&wt_config_path, MAX_CONFIG_BYTES)? {
            let wt_text = std::str::from_utf8(&wt_bytes).map_err(|_| IndexError::Unsupported)?;
            parse_config_file(
                wt_text,
                &mut repo_format_version,
                &mut object_format,
                &mut ignore_case,
                &mut precompose_unicode,
                &mut worktree_config,
            )?;
        }
    }

    let hash_len = if repo_format_version >= 1 {
        match object_format.as_deref() {
            None | Some("sha1") => 20,
            Some("sha256") => 32,
            Some(_) => return Err(IndexError::Unsupported),
        }
    } else {
        20
    };

    Ok(NativeRepoConfig {
        hash_len,
        rules: FoldingRules {
            ignore_case: ignore_case.unwrap_or(false),
            precompose_unicode: precompose_unicode.unwrap_or(false) || cfg!(target_os = "macos"),
        },
        worktree_config: has_worktree_config,
    })
}

/// Confirm `HEAD` exists as a regular file and is readable as a symbolic ref
/// or commit OID matching `hash_len`.
fn validate_head(gitdir: &Path, hash_len: usize) -> Result<(), IndexError> {
    let head_path = gitdir.join("HEAD");
    let bytes = read_regular_file_bounded(&head_path, POINTER_MAX_BYTES)?;
    if bytes.is_empty() {
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
    let expected_hex_len = hash_len * 2;
    let is_oid =
        line.len() == expected_hex_len && line.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !is_symref && !is_oid {
        return Err(IndexError::Unsupported);
    }
    Ok(())
}

fn read_index_entries(gitdir: &Path, hash_len: usize) -> Result<Vec<Vec<u8>>, IndexError> {
    let path = gitdir.join("index");
    let bytes = read_regular_file_bounded(&path, MAX_INDEX_BYTES)?;
    let parsed = parse_index_raw(&bytes, hash_len, true, MAX_TOTAL_PATH_BYTES)?;
    let Some(split) = parsed.split_link else {
        let mut paths = parsed.paths;
        paths.sort_unstable();
        paths.dedup();
        return Ok(paths);
    };

    // Validate overlay ordering: first `replace_bitmap.set_count` entries must
    // have empty names (replacements), and all later entries must be non-empty.
    let replace_count = split.replace_bitmap.set_count;
    if parsed.paths.len() < replace_count {
        return Err(IndexError::Unsupported);
    }
    for entry_path in &parsed.paths[..replace_count] {
        if !entry_path.is_empty() {
            return Err(IndexError::Unsupported);
        }
    }
    for entry_path in &parsed.paths[replace_count..] {
        if entry_path.is_empty() {
            return Err(IndexError::Unsupported);
        }
    }

    let mut all_paths: Vec<Vec<u8>> = Vec::new();
    if split.base_oid.iter().all(|&b| b == 0) {
        if split.delete_bitmap.set_count > 0 || split.replace_bitmap.set_count > 0 {
            return Err(IndexError::Unsupported);
        }
    } else {
        let mut hex = String::with_capacity(split.base_oid.len() * 2);
        for byte in &split.base_oid {
            use std::fmt::Write as _;
            let _ = write!(&mut hex, "{byte:02x}");
        }
        let shared_path = gitdir.join(format!("sharedindex.{hex}"));
        let shared_bytes = read_regular_file_bounded(&shared_path, MAX_INDEX_BYTES)?;
        let base_parsed = parse_index_raw(&shared_bytes, hash_len, false, MAX_TOTAL_PATH_BYTES)?;
        if base_parsed.checksum != split.base_oid {
            return Err(IndexError::Unsupported);
        }
        let base_count = base_parsed.paths.len();
        if split
            .delete_bitmap
            .highest_set_bit()
            .is_some_and(|bit| bit >= base_count)
            || split
                .replace_bitmap
                .highest_set_bit()
                .is_some_and(|bit| bit >= base_count)
            || split.delete_bitmap.overlaps(&split.replace_bitmap)
        {
            return Err(IndexError::Unsupported);
        }
        for (idx, base_path) in base_parsed.paths.into_iter().enumerate() {
            if split.delete_bitmap.has(idx) {
                continue;
            }
            all_paths.push(base_path);
        }
    }
    for entry_path in parsed.paths.into_iter().skip(replace_count) {
        all_paths.push(entry_path);
    }
    all_paths.sort_unstable();
    all_paths.dedup();
    Ok(all_paths)
}

fn read_index_native(root: &Path) -> Result<(Vec<Vec<u8>>, FoldingRules), IndexError> {
    let gitdir = resolve_gitdir(root)?;
    let config = read_native_repo_config(&gitdir)?;
    let _ = config.worktree_config;
    validate_head(&gitdir, config.hash_len)?;
    let entries = read_index_entries(&gitdir, config.hash_len)?;
    if entries.is_empty() {
        return Err(IndexError::Unsupported);
    }
    Ok((entries, config.rules))
}

/// Compact bounded bitset decoded from Git's EWAH bitmap format.
#[derive(Debug, PartialEq, Eq)]
struct EwahBitmap {
    bit_size: usize,
    bits: Vec<u8>,
    set_count: usize,
    highest: Option<usize>,
}

impl EwahBitmap {
    fn empty() -> Self {
        Self {
            bit_size: 0,
            bits: Vec::new(),
            set_count: 0,
            highest: None,
        }
    }

    fn has(&self, index: usize) -> bool {
        if index >= self.bit_size {
            return false;
        }
        self.bits
            .get(index >> 3)
            .is_some_and(|&byte| (byte & (1u8 << (index & 7))) != 0)
    }

    fn highest_set_bit(&self) -> Option<usize> {
        self.highest
    }

    fn overlaps(&self, other: &Self) -> bool {
        self.bits
            .iter()
            .zip(other.bits.iter())
            .any(|(&a, &b)| (a & b) != 0)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SplitIndexLink {
    base_oid: Vec<u8>,
    delete_bitmap: EwahBitmap,
    replace_bitmap: EwahBitmap,
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedIndex {
    paths: Vec<Vec<u8>>,
    checksum: Vec<u8>,
    split_link: Option<SplitIndexLink>,
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

fn verify_index_checksum(bytes: &[u8], hash_len: usize) -> Result<Vec<u8>, IndexError> {
    if bytes.len() < 12 + hash_len {
        return Err(IndexError::Unsupported);
    }
    let payload_end = bytes.len() - hash_len;
    let (payload, trailer) = bytes.split_at(payload_end);
    let matches = match hash_len {
        20 => sha1_digest(payload).as_slice() == trailer,
        32 => Sha256::digest(payload).as_slice() == trailer,
        _ => false,
    };
    if !matches {
        return Err(IndexError::Unsupported);
    }
    Ok(trailer.to_vec())
}

/// Parse the path of every index entry and verify its trailing checksum.
/// Bounds-checked throughout: the file comes from a repository sweep did not create.
#[cfg_attr(not(test), allow(dead_code))]
fn parse_index(bytes: &[u8], hash_len: usize) -> Result<Vec<Vec<u8>>, IndexError> {
    let parsed = parse_index_raw(bytes, hash_len, false, MAX_TOTAL_PATH_BYTES)?;
    let mut paths = parsed.paths;
    paths.sort_unstable();
    paths.dedup();
    Ok(paths)
}

fn parse_index_raw(
    bytes: &[u8],
    hash_len: usize,
    allow_split_index: bool,
    max_total_path_bytes: usize,
) -> Result<ParsedIndex, IndexError> {
    if bytes.len() < 12 + hash_len {
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
    let min_entry_bytes = if version == 4 {
        40 + hash_len + 4
    } else {
        40 + hash_len + 8
    };
    let max_possible = (bytes.len() - 12 - hash_len) / min_entry_bytes;
    if count > MAX_ENTRIES || (count as usize) > max_possible {
        return Err(IndexError::Unsupported);
    }

    // Verify trailing checksum before allocating entries or decoding paths.
    let checksum = verify_index_checksum(bytes, hash_len)?;

    let mut paths: Vec<Vec<u8>> = Vec::with_capacity((count as usize).min(1 << 16));
    let mut previous: Vec<u8> = Vec::new();
    let mut total_path_bytes = 0usize;

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
            let decoded_len = keep
                .checked_add(suffix.len())
                .ok_or(IndexError::Unsupported)?;
            if decoded_len > MAX_PATH_BYTES {
                return Err(IndexError::Unsupported);
            }
            total_path_bytes = total_path_bytes
                .checked_add(decoded_len)
                .ok_or(IndexError::Unsupported)?;
            if total_path_bytes > max_total_path_bytes {
                return Err(IndexError::Unsupported);
            }
            let mut path = Vec::with_capacity(decoded_len);
            path.extend_from_slice(&previous[..keep]);
            path.extend_from_slice(suffix);
            path
        } else {
            let name = reader.until_nul()?;
            // A short name's length is stored exactly; 0xfff means "longer".
            if name_len < 0x0fff && name.len() != name_len {
                return Err(IndexError::Unsupported);
            }
            if name.len() > MAX_PATH_BYTES {
                return Err(IndexError::Unsupported);
            }
            total_path_bytes = total_path_bytes
                .checked_add(name.len())
                .ok_or(IndexError::Unsupported)?;
            if total_path_bytes > max_total_path_bytes {
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
        if path.is_empty() && !allow_split_index {
            return Err(IndexError::Unsupported);
        }
        previous.clone_from(&path);
        paths.push(path);
    }

    // Extensions follow the entries, then the trailing checksum.
    let mut split_link = None;
    while reader.remaining() > hash_len {
        let signature = reader.take(4)?;
        let size = reader.u32()? as usize;
        let body = reader.take(size)?;
        if signature == b"link" {
            if !allow_split_index {
                return Err(IndexError::Unsupported);
            }
            split_link = Some(parse_split_link(body, hash_len)?);
        } else if !ALLOWED_CACHE_EXTENSIONS.iter().any(|ext| *ext == signature) {
            return Err(IndexError::Unsupported);
        }
    }
    if reader.remaining() != hash_len {
        return Err(IndexError::Unsupported);
    }
    if paths.iter().any(Vec::is_empty) && split_link.is_none() {
        return Err(IndexError::Unsupported);
    }
    Ok(ParsedIndex {
        paths,
        checksum,
        split_link,
    })
}

fn parse_split_link(body: &[u8], hash_len: usize) -> Result<SplitIndexLink, IndexError> {
    let mut reader = Reader { bytes: body, at: 0 };
    let base_oid = reader.take(hash_len)?.to_vec();
    if reader.remaining() == 0 {
        return Ok(SplitIndexLink {
            base_oid,
            delete_bitmap: EwahBitmap::empty(),
            replace_bitmap: EwahBitmap::empty(),
        });
    }
    let delete_bitmap = read_ewah_bitmap(&mut reader)?;
    let replace_bitmap = read_ewah_bitmap(&mut reader)?;
    if reader.remaining() != 0 {
        return Err(IndexError::Unsupported);
    }
    Ok(SplitIndexLink {
        base_oid,
        delete_bitmap,
        replace_bitmap,
    })
}

fn read_ewah_bitmap(reader: &mut Reader<'_>) -> Result<EwahBitmap, IndexError> {
    let bit_size = reader.u32()? as usize;
    let word_count = reader.u32()? as usize;
    if bit_size > MAX_SPLIT_BITMAP_BITS {
        return Err(IndexError::Unsupported);
    }
    let required_bytes = word_count
        .checked_mul(8)
        .and_then(|n| n.checked_add(4))
        .ok_or(IndexError::Unsupported)?;
    if required_bytes > reader.remaining() {
        return Err(IndexError::Unsupported);
    }

    let max_uncompressed_words = bit_size.div_ceil(64);
    let mut bits = vec![0u8; bit_size.div_ceil(8)];
    let mut words_read = 0usize;
    let mut uncompressed_words = 0usize;
    let mut set_count = 0usize;
    let mut highest: Option<usize> = None;

    while words_read < word_count {
        let rlw = reader.u64()?;
        words_read += 1;
        let running_bit = (rlw & 1) != 0;
        let running_words =
            usize::try_from((rlw >> 1) & 0xffff_ffff).map_err(|_| IndexError::Unsupported)?;
        let literal_words = usize::try_from(rlw >> 33).map_err(|_| IndexError::Unsupported)?;
        if words_read
            .checked_add(literal_words)
            .is_none_or(|n| n > word_count)
        {
            return Err(IndexError::Unsupported);
        }
        let next_uncompressed = uncompressed_words
            .checked_add(running_words)
            .and_then(|n| n.checked_add(literal_words))
            .ok_or(IndexError::Unsupported)?;
        if next_uncompressed > max_uncompressed_words {
            return Err(IndexError::Unsupported);
        }

        let start_bit = uncompressed_words
            .checked_mul(64)
            .ok_or(IndexError::Unsupported)?;
        if running_bit && running_words > 0 {
            let end_bit = bit_size.min(
                start_bit.saturating_add(
                    running_words
                        .checked_mul(64)
                        .ok_or(IndexError::Unsupported)?,
                ),
            );
            if end_bit > start_bit {
                let start_byte = start_bit >> 3;
                let full_end_byte = end_bit >> 3;
                for slot in &mut bits[start_byte..full_end_byte] {
                    *slot = 0xff;
                }
                let tail_bits = end_bit & 7;
                if tail_bits > 0 {
                    bits[full_end_byte] = (1u8 << tail_bits) - 1;
                }
                set_count += end_bit - start_bit;
                highest = Some(end_bit - 1);
            }
        }
        uncompressed_words += running_words;

        for _ in 0..literal_words {
            let word = reader.u64()?;
            words_read += 1;
            let word_bit_base = uncompressed_words
                .checked_mul(64)
                .ok_or(IndexError::Unsupported)?;
            if word != 0 {
                let limit = 64.min(bit_size.saturating_sub(word_bit_base));
                for b in 0..limit {
                    if ((word >> b) & 1) != 0 {
                        let bit = word_bit_base + b;
                        bits[bit >> 3] |= 1u8 << (bit & 7);
                        set_count += 1;
                        highest = Some(bit);
                    }
                }
            }
            uncompressed_words += 1;
        }
    }
    // Trailing rlw_pos.
    let _ = reader.u32()?;
    if bit_size == 0 {
        Ok(EwahBitmap::empty())
    } else {
        Ok(EwahBitmap {
            bit_size,
            bits,
            set_count,
            highest,
        })
    }
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

    fn u64(&mut self) -> Result<u64, IndexError> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
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
            if value > MAX_PATH_BYTES {
                return Err(IndexError::Unsupported);
            }
        }
        Ok(value)
    }
}

#[cfg(any(windows, test))]
fn normalize_win_canonical(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('/', "\\");
    let stripped = if raw
        .as_bytes()
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(br"\\?\UNC\"))
    {
        format!(r"\\{}", &raw[8..])
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        raw
    };
    let trimmed = if stripped.len() > 3 && stripped.ends_with('\\') {
        stripped.trim_end_matches('\\')
    } else {
        stripped.as_str()
    };
    trimmed.to_lowercase()
}

fn same_repo_root(expected: &Path, reported: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (std::fs::metadata(expected), std::fs::metadata(reported)) {
            if a.ino() != 0 && b.ino() != 0 {
                return a.dev() == b.dev() && a.ino() == b.ino();
            }
        }
    }
    let (Ok(a), Ok(b)) = (
        std::fs::canonicalize(expected),
        std::fs::canonicalize(reported),
    ) else {
        return false;
    };
    #[cfg(windows)]
    {
        normalize_win_canonical(&a) == normalize_win_canonical(&b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn verify_git_toplevel(git_binary: &Path, root: &Path) -> bool {
    let Some(stdout) = run_git_command(
        git_binary,
        root,
        &["rev-parse", "--show-toplevel"],
        MAX_GIT_META_STDOUT,
    ) else {
        return false;
    };
    let mut trimmed = stdout.as_slice();
    while let Some(&last) = trimmed.last() {
        if last == b'\n' || last == b'\r' {
            trimmed = &trimmed[..trimmed.len() - 1];
        } else {
            break;
        }
    }
    if trimmed.is_empty() || trimmed.iter().any(|&b| b == 0 || b == b'\n' || b == b'\r') {
        return false;
    }
    #[cfg(unix)]
    let reported = {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(OsStr::from_bytes(trimmed))
    };
    #[cfg(not(unix))]
    let reported = {
        let Ok(text) = std::str::from_utf8(trimmed) else {
            return false;
        };
        PathBuf::from(text)
    };
    same_repo_root(root, &reported)
}

fn read_git_folding_config(git_binary: &Path, root: &Path) -> Option<FoldingRules> {
    let stdout = run_git_command(
        git_binary,
        root,
        &["config", "--list", "--null"],
        MAX_GIT_META_STDOUT,
    )?;
    if !stdout.is_empty() && !stdout.ends_with(b"\0") {
        return None;
    }
    let mut ignore_case = false;
    let mut precompose_unicode = false;
    for entry in stdout.split(|&byte| byte == 0).filter(|e| !e.is_empty()) {
        let (key, val) = match entry.iter().position(|&b| b == b'\n') {
            Some(cut) => (&entry[..cut], Some(&entry[cut + 1..])),
            None => (entry, None),
        };
        if key == b"core.ignorecase" {
            let val_str = match val {
                Some(v) => Some(std::str::from_utf8(v).ok()?),
                None => None,
            };
            ignore_case = parse_git_bool(val_str).ok()?;
        } else if key == b"core.precomposeunicode" {
            let val_str = match val {
                Some(v) => Some(std::str::from_utf8(v).ok()?),
                None => None,
            };
            precompose_unicode = parse_git_bool(val_str).ok()?;
        }
    }
    Some(FoldingRules {
        ignore_case,
        precompose_unicode: precompose_unicode || cfg!(target_os = "macos"),
    })
}

/// Verify the repository root and list all tracked paths once via
/// `git ls-files -z --cached --full-name`, then match candidates locally
/// using the repository's folding rules.
fn tracked_via_git(
    git_binary: &Path,
    root: &Path,
    repo_root_members: &[&PathBuf],
    rels: &[(Vec<u8>, &PathBuf)],
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let all_unknown = || {
        let mut out: Vec<PathBuf> = repo_root_members.iter().map(|p| (*p).clone()).collect();
        out.extend(rels.iter().map(|(_, path)| (*path).clone()));
        (Vec::new(), out)
    };
    if !verify_git_toplevel(git_binary, root) {
        return all_unknown();
    }
    let Some(stdout) = run_git_command(
        git_binary,
        root,
        &["ls-files", "-z", "--cached", "--full-name"],
        MAX_GIT_STDOUT,
    ) else {
        return all_unknown();
    };
    if !stdout.is_empty() && !stdout.ends_with(b"\0") {
        return all_unknown();
    }
    let entries: Vec<&[u8]> = stdout
        .split(|&byte| byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut tracked: HashSet<PathBuf> = HashSet::new();
    for path in repo_root_members {
        tracked.insert((*path).clone());
    }
    if rels.is_empty() {
        return (tracked.into_iter().collect(), Vec::new());
    }

    // Pass 1: exact match (plus NFC on macOS where precompose equivalence is always active).
    let base_rules = FoldingRules {
        ignore_case: false,
        precompose_unicode: cfg!(target_os = "macos"),
    };
    tracked.extend(match_entries(entries.iter().copied(), rels, base_rules));

    let remaining: Vec<(Vec<u8>, &PathBuf)> = rels
        .iter()
        .filter(|(_, path)| !tracked.contains(*path))
        .map(|(rel, path)| (rel.clone(), *path))
        .collect();
    if remaining.is_empty() {
        return (tracked.into_iter().collect(), Vec::new());
    }

    // Only query `git config` when case or Unicode folding could actually match a remaining candidate.
    let max_rules = FoldingRules {
        ignore_case: true,
        precompose_unicode: true,
    };
    let potential = match_entries(entries.iter().copied(), &remaining, max_rules);
    if !potential.is_empty() {
        let Some(rules) = read_git_folding_config(git_binary, root) else {
            return all_unknown();
        };
        if rules != base_rules {
            tracked.extend(match_entries(entries.iter().copied(), &remaining, rules));
        }
    }

    (tracked.into_iter().collect(), Vec::new())
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

#[cfg(any(windows, test))]
fn strip_outer_quotes(entry: &str) -> &str {
    entry
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(entry)
}

#[cfg(any(windows, test))]
fn is_windows_absolute_dir(dir: &str) -> bool {
    if dir.trim().is_empty() {
        return false;
    }
    let bytes = dir.as_bytes();
    let drive_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let unc_abs = bytes.len() >= 3
        && ((bytes[0] == b'\\' && bytes[1] == b'\\') || (bytes[0] == b'/' && bytes[1] == b'/'))
        && bytes[2] != b'\\'
        && bytes[2] != b'/';
    drive_abs || unc_abs
}

/// Resolve a bare command name using only absolute `PATH` directories.
/// Skips empty, whitespace-only, `.`, and relative entries on every platform.
fn resolve_absolute_on_path_in(
    binary: &str,
    path_env: Option<&OsStr>,
    #[cfg_attr(not(windows), allow(unused_variables))] pathext_env: Option<&OsStr>,
) -> Option<PathBuf> {
    let path_env = path_env?;
    #[cfg(windows)]
    {
        let raw_path = path_env.to_str()?;
        let extensions = windows_shell_free_extensions(pathext_env);
        for raw_dir in raw_path.split(';') {
            let dir_str = strip_outer_quotes(raw_dir);
            if !is_windows_absolute_dir(dir_str) {
                continue;
            }
            let dir = Path::new(dir_str);
            let literal = dir.join(binary);
            if std::fs::metadata(&literal).is_ok_and(|meta| meta.is_file()) {
                return Some(literal);
            }
            for ext in &extensions {
                let candidate = dir.join(format!("{binary}{ext}"));
                if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
                    return Some(candidate);
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        for dir in std::env::split_paths(path_env) {
            if dir.as_os_str().is_empty()
                || dir.to_str().is_some_and(|text| text.trim().is_empty())
                || !dir.is_absolute()
            {
                continue;
            }
            #[cfg(unix)]
            {
                let candidate = dir.join(binary);
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
            #[cfg(not(unix))]
            {
                let candidate = dir.join(binary);
                if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

fn is_git_env_key(key: &OsStr) -> bool {
    key.as_encoded_bytes()
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"git_"))
}

#[cfg(not(unix))]
struct EmptyHooksGuard(PathBuf);

#[cfg(not(unix))]
impl EmptyHooksGuard {
    fn create() -> Option<Self> {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let pid = std::process::id();
        let base = std::env::temp_dir();
        for _ in 0..16 {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = base.join(format!("sweep-no-hooks-{pid}-{n}"));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Some(Self(dir)),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return None,
            }
        }
        None
    }
}

#[cfg(not(unix))]
impl Drop for EmptyHooksGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn build_git_command(
    git_binary: &Path,
    root: &Path,
    subcommand_args: &[&str],
    hooks_path: &Path,
) -> Command {
    let mut cmd = Command::new(git_binary);
    cmd.env_clear();
    for (key, value) in std::env::vars_os() {
        if !is_git_env_key(&key) {
            cmd.env(key, value);
        }
    }
    let mut hooks_arg = std::ffi::OsString::from("core.hooksPath=");
    hooks_arg.push(hooks_path);
    cmd.args([
        "--no-pager",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.git.allow=never",
        "-c",
        "protocol.ssh.allow=never",
        "-c",
        "protocol.http.allow=never",
        "-c",
        "protocol.https.allow=never",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.quotePath=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
    ])
    .arg(hooks_arg)
    .arg("-C")
    .arg(root)
    .args(subcommand_args)
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
    .stderr(Stdio::null());
    cmd
}

fn run_git_command(
    git_binary: &Path,
    root: &Path,
    subcommand_args: &[&str],
    max_stdout: u64,
) -> Option<Vec<u8>> {
    #[cfg(unix)]
    let mut child = build_git_command(git_binary, root, subcommand_args, Path::new("/dev/null"))
        .spawn()
        .ok()?;
    #[cfg(not(unix))]
    let hooks_guard = EmptyHooksGuard::create()?;
    #[cfg(not(unix))]
    let mut child = build_git_command(git_binary, root, subcommand_args, &hooks_guard.0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        stdout
            .by_ref()
            .take(max_stdout + 1)
            .read_to_end(&mut out)
            .ok()
            .and_then(|_| (out.len() as u64 <= max_stdout).then_some(out))
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

    fn encode_varint(value: usize) -> Vec<u8> {
        let mut bytes = vec![u8::try_from(value & 0x7f).unwrap_or(0)];
        let mut v = value >> 7;
        while v > 0 {
            v -= 1;
            bytes.push(0x80 | u8::try_from(v & 0x7f).unwrap_or(0));
            v >>= 7;
        }
        bytes.reverse();
        bytes
    }

    fn entry(path: &[u8], version: u32, hash_len: usize, previous: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 40];
        out.extend(std::iter::repeat_n(0xab, hash_len));
        let flags = u16::try_from(path.len().min(0x0fff)).unwrap_or(0x0fff);
        out.extend_from_slice(&flags.to_be_bytes());
        if version == 4 {
            let common = previous
                .iter()
                .zip(path)
                .take_while(|(a, b)| a == b)
                .count();
            let strip = previous.len() - common;
            out.extend_from_slice(&encode_varint(strip));
            out.extend_from_slice(&path[common..]);
            out.push(0);
        } else {
            out.extend_from_slice(path);
            let fixed = 40 + hash_len + 2;
            let padded = (fixed + path.len() + 8) & !7;
            out.resize(padded, 0);
        }
        out
    }

    fn index_with_hash(
        version: u32,
        paths: &[&[u8]],
        extensions: &[(&[u8; 4], &[u8])],
        hash_len: usize,
    ) -> Vec<u8> {
        let mut out = b"DIRC".to_vec();
        out.extend_from_slice(&version.to_be_bytes());
        out.extend_from_slice(&u32::try_from(paths.len()).unwrap_or(0).to_be_bytes());
        let mut previous: &[u8] = b"";
        for path in paths {
            out.extend_from_slice(&entry(path, version, hash_len, previous));
            previous = path;
        }
        for (signature, body) in extensions {
            out.extend_from_slice(*signature);
            out.extend_from_slice(&u32::try_from(body.len()).unwrap_or(0).to_be_bytes());
            out.extend_from_slice(body);
        }
        if hash_len == 32 {
            let digest = Sha256::digest(&out);
            out.extend_from_slice(digest.as_slice());
        } else {
            let digest = sha1_digest(&out);
            out.extend_from_slice(&digest);
        }
        out
    }

    fn index(version: u32, paths: &[&[u8]], extensions: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        index_with_hash(version, paths, extensions, 20)
    }

    fn build_ewah_rlw(
        bit_size: u32,
        running_bit: bool,
        running_words: u32,
        literals: &[u64],
    ) -> Vec<u8> {
        let word_count = u32::try_from(1 + literals.len()).unwrap_or(1);
        let mut out = Vec::new();
        out.extend_from_slice(&bit_size.to_be_bytes());
        out.extend_from_slice(&word_count.to_be_bytes());
        let rlw = u64::from(running_bit)
            | (u64::from(running_words) << 1)
            | ((literals.len() as u64) << 33);
        out.extend_from_slice(&rlw.to_be_bytes());
        for &lit in literals {
            out.extend_from_slice(&lit.to_be_bytes());
        }
        out.extend_from_slice(&0u32.to_be_bytes());
        out
    }

    const PATHS: &[&[u8]] = &[b"apps/web/dist/vendor.js", b"dist-x/a", b"src/main.rs"];

    fn contains_exact(entries: &[Vec<u8>], rel: &[u8]) -> bool {
        let p = PathBuf::from("/fake");
        let matched = match_entries(
            entries.iter().map(Vec::as_slice),
            &[(rel.to_vec(), &p)],
            FoldingRules {
                ignore_case: false,
                precompose_unicode: false,
            },
        );
        matched.contains(&p)
    }

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
            assert!(contains_exact(&entries, b"apps/web/dist"));
            assert!(contains_exact(&entries, b"src/main.rs"));
            assert!(
                !contains_exact(&entries, b"dist"),
                "dist-x must not count as dist"
            );
            assert!(!contains_exact(&entries, b"apps/web/dis"));
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
    fn verifies_trailing_sha1_and_sha256_checksums() {
        for hash_len in [20usize, 32] {
            let valid = index_with_hash(2, PATHS, &[], hash_len);
            assert!(parse_index(&valid, hash_len).is_ok());

            let mut flipped_body = valid.clone();
            flipped_body[15] ^= 0x01;
            assert_eq!(
                parse_index(&flipped_body, hash_len),
                Err(IndexError::Unsupported)
            );

            let mut flipped_trailer = valid;
            let last = flipped_trailer.len() - 1;
            flipped_trailer[last] ^= 0x80;
            assert_eq!(
                parse_index(&flipped_trailer, hash_len),
                Err(IndexError::Unsupported)
            );
        }
    }

    #[test]
    fn rejects_unknown_uppercase_and_lowercase_extensions_identically() {
        let split = index(2, PATHS, &[(b"link", b"0123456789")]);
        assert_eq!(parse_index(&split, 20), Err(IndexError::Unsupported));
        for sig in [b"sdir", b"XXXX", b"MAND", b"xxxx"] {
            let idx = index(2, PATHS, &[(sig, b"payload")]);
            assert_eq!(
                parse_index(&idx, 20),
                Err(IndexError::Unsupported),
                "extension {:?} must be rejected",
                sig
            );
        }
        for allowed in ALLOWED_CACHE_EXTENSIONS {
            let idx = index(2, PATHS, &[(allowed, b"payload")]);
            assert!(
                parse_index(&idx, 20).is_ok(),
                "allowed extension {:?} should pass",
                allowed
            );
        }
    }

    #[test]
    fn rejects_v4_path_compression_bomb_within_memory_bounds() {
        let prefix = "a/".repeat(30_000);
        let mut owned: Vec<Vec<u8>> = Vec::with_capacity(1501);
        owned.push(format!("{prefix}0000").into_bytes());
        for i in 1..=1500 {
            owned.push(format!("{prefix}{i:04}").into_bytes());
        }
        let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
        let bomb = index(4, &refs, &[]);
        assert!(bomb.len() < 300 * 1024);
        assert_eq!(
            parse_index_raw(&bomb, 20, false, 4 * 1024 * 1024),
            Err(IndexError::Unsupported)
        );
    }

    #[test]
    fn rejects_ewah_compression_bombs_in_bounded_time_and_memory() {
        let base_oid = [0x22u8; 20];
        let empty_ewah = [0u8; 12];

        let mut ones_bomb = base_oid.to_vec();
        ones_bomb.extend_from_slice(&build_ewah_rlw(500_000, true, 100_000, &[]));
        ones_bomb.extend_from_slice(&empty_ewah);
        let idx_ones = index(2, &[b"a"], &[(b"link", &ones_bomb)]);

        let mut zeros_bomb = base_oid.to_vec();
        zeros_bomb.extend_from_slice(&build_ewah_rlw(100, false, 0x0fff_ffff, &[]));
        zeros_bomb.extend_from_slice(&empty_ewah);
        let idx_zeros = index(2, &[b"a"], &[(b"link", &zeros_bomb)]);

        let start = Instant::now();
        assert_eq!(
            parse_index_raw(&idx_ones, 20, true, MAX_TOTAL_PATH_BYTES),
            Err(IndexError::Unsupported)
        );
        assert_eq!(
            parse_index_raw(&idx_zeros, 20, true, MAX_TOTAL_PATH_BYTES),
            Err(IndexError::Unsupported)
        );
        assert!(start.elapsed() < Duration::from_millis(500));
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
    fn seeded_fuzz_corpus_stays_bounded_and_never_panics() {
        let mut seed: u32 = 0x5eed_1234;
        let mut next_u32 = || -> u32 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed
        };

        let baseline = index(4, &[b"a/b/c.rs", b"a/b/d.rs", b"z.txt"], &[(b"TREE", b"x")]);
        let start = Instant::now();
        let cap = 2 * 1024 * 1024;
        let mut peak_decoded_bytes = 0usize;

        for iter in 0..2000usize {
            let sample = match iter % 4 {
                0 => {
                    let mut buf = baseline.clone();
                    let mutations = 1 + (next_u32() as usize % 6);
                    for _ in 0..mutations {
                        let pos = next_u32() as usize % (buf.len() - 20).max(1);
                        buf[pos] = (next_u32() & 0xff) as u8;
                    }
                    let payload_end = buf.len() - 20;
                    let digest = sha1_digest(&buf[..payload_end]);
                    buf[payload_end..].copy_from_slice(&digest);
                    buf
                }
                1 => {
                    let len = 12 + (next_u32() as usize % 256);
                    let mut body = vec![0u8; len];
                    body[..4].copy_from_slice(b"DIRC");
                    body[4..8].copy_from_slice(&(2 + (next_u32() % 4)).to_be_bytes());
                    body[8..12].copy_from_slice(&(next_u32() % 10_000).to_be_bytes());
                    for byte in &mut body[12..] {
                        *byte = (next_u32() & 0xff) as u8;
                    }
                    let digest = sha1_digest(&body);
                    body.extend_from_slice(&digest);
                    body
                }
                2 => {
                    let len = next_u32() as usize % 512;
                    (0..len).map(|_| (next_u32() & 0xff) as u8).collect()
                }
                _ => {
                    let link_len = next_u32() as usize % 96;
                    let link_body: Vec<u8> =
                        (0..link_len).map(|_| (next_u32() & 0xff) as u8).collect();
                    index(2, &[b"x"], &[(b"link", &link_body)])
                }
            };
            if let Ok(parsed) = parse_index_raw(&sample, 20, true, cap) {
                let bytes: usize = parsed.paths.iter().map(Vec::len).sum();
                peak_decoded_bytes = peak_decoded_bytes.max(bytes);
            }
            if let Ok(parsed) = parse_index_raw(&sample, 32, true, cap) {
                let bytes: usize = parsed.paths.iter().map(Vec::len).sum();
                peak_decoded_bytes = peak_decoded_bytes.max(bytes);
            }
        }

        assert!(peak_decoded_bytes <= cap);
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn git_command_forces_c_locale_and_sanitized_env() {
        let hooks = Path::new("/dev/null");
        let cmd = build_git_command(
            Path::new("/usr/bin/git"),
            Path::new("/tmp/repo"),
            &["ls-files", "-z", "--cached", "--full-name"],
            hooks,
        );
        let envs: HashMap<_, _> = cmd.get_envs().collect();
        assert_eq!(envs.get(OsStr::new("LC_ALL")), Some(&Some(OsStr::new("C"))));
        assert_eq!(envs.get(OsStr::new("LANG")), Some(&Some(OsStr::new("C"))));
        assert_eq!(
            envs.get(OsStr::new("GIT_NO_LAZY_FETCH")),
            Some(&Some(OsStr::new("1")))
        );
        assert_eq!(
            envs.get(OsStr::new("GIT_NO_REPLACE_OBJECTS")),
            Some(&Some(OsStr::new("1")))
        );
        assert_eq!(
            envs.get(OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(&Some(OsStr::new("0")))
        );
        assert_eq!(
            envs.get(OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(&Some(OsStr::new("0")))
        );
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        for flag in [
            "protocol.allow=never",
            "protocol.file.allow=never",
            "protocol.git.allow=never",
            "protocol.ssh.allow=never",
            "protocol.http.allow=never",
            "protocol.https.allow=never",
            "core.fsmonitor=false",
            "gc.auto=0",
            "maintenance.auto=false",
        ] {
            assert!(args.contains(&flag.to_owned()), "missing {flag}");
        }
        assert!(args.contains(&format!("core.hooksPath={}", hooks.display())));
    }

    #[test]
    fn split_index_validates_trailer_bitmaps_overlay_and_reads_without_git(
    ) -> Result<(), std::io::Error> {
        let dir = tempfile::tempdir()?;
        let tmp = dir.path();
        let git_dir = tmp.join(".git");
        std::fs::create_dir_all(&git_dir)?;
        std::fs::write(git_dir.join("HEAD"), b"ref: refs/heads/main\n")?;
        std::fs::write(
            git_dir.join("config"),
            b"[core]\n\trepositoryformatversion = 0\n",
        )?;

        let base_bytes = index(2, &[b"dist/deleted.js", b"dist/kept.js"], &[]);
        let base_trailer = &base_bytes[base_bytes.len() - 20..];
        let hex: String = base_trailer.iter().map(|b| format!("{b:02x}")).collect();
        let shared_path = git_dir.join(format!("sharedindex.{hex}"));
        std::fs::write(&shared_path, &base_bytes)?;

        // 1. Trailer mismatch must be rejected.
        let wrong_oid = [0x99u8; 20];
        let wrong_hex: String = wrong_oid.iter().map(|b| format!("{b:02x}")).collect();
        std::fs::write(
            git_dir.join(format!("sharedindex.{wrong_hex}")),
            &base_bytes,
        )?;
        let mut mismatch_link = wrong_oid.to_vec();
        mismatch_link.extend_from_slice(&[0u8; 12]);
        mismatch_link.extend_from_slice(&[0u8; 12]);
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"out/added.js"], &[(b"link", &mismatch_link)]),
        )?;
        assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));

        // 2. Out-of-range delete bit must be rejected.
        let mut oor_link = base_trailer.to_vec();
        oor_link.extend_from_slice(&build_ewah_rlw(3, false, 0, &[0b100]));
        oor_link.extend_from_slice(&[0u8; 12]);
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"out/added.js"], &[(b"link", &oor_link)]),
        )?;
        assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));

        // 3. Overlapping delete and replace bit must be rejected.
        let mut overlap_link = base_trailer.to_vec();
        overlap_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        overlap_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b""], &[(b"link", &overlap_link)]),
        )?;
        assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));

        // 4. Overlay order mismatch must be rejected.
        let mut bad_overlay = base_trailer.to_vec();
        bad_overlay.extend_from_slice(&[0u8; 12]);
        bad_overlay.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"not-empty"], &[(b"link", &bad_overlay)]),
        )?;
        assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));

        // 5. Valid split index: delete bit 0, replace bit 1, overlay = ["", "out/added.js"].
        let mut valid_link = base_trailer.to_vec();
        valid_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        valid_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b10]));
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"", b"out/added.js"], &[(b"link", &valid_link)]),
        )?;

        let Ok((paths, _)) = read_index_native(tmp) else {
            panic!("read_index_native should parse valid split index without git");
        };
        assert!(contains_exact(&paths, b"dist/kept.js"));
        assert!(contains_exact(&paths, b"out/added.js"));
        assert!(!contains_exact(&paths, b"dist/deleted.js"));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_and_fifo_index_without_blocking() -> Result<(), std::io::Error> {
        let dir = tempfile::tempdir()?;
        let tmp = dir.path();
        let git_dir = tmp.join(".git");
        std::fs::create_dir_all(&git_dir)?;
        std::fs::write(git_dir.join("HEAD"), b"ref: refs/heads/main\n")?;
        std::fs::write(
            git_dir.join("config"),
            b"[core]\n\trepositoryformatversion = 0\n",
        )?;
        let real = tmp.join("real-index");
        std::fs::write(&real, index(2, &[b"a.txt"], &[]))?;

        // Symlinked index rejected.
        let idx_path = git_dir.join("index");
        std::os::unix::fs::symlink(&real, &idx_path)?;
        assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));
        std::fs::remove_file(&idx_path)?;

        // FIFO index rejected without blocking.
        let status = Command::new("mkfifo")
            .arg(&idx_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if status.is_ok_and(|s| s.success()) {
            let start = Instant::now();
            assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));
            assert!(start.elapsed() < Duration::from_millis(500));
            std::fs::remove_file(&idx_path)?;
        }

        // Symlinked and FIFO sharedindex.<oid> rejected without blocking.
        let shared_oid = [0x44u8; 20];
        let shared_hex: String = shared_oid.iter().map(|b| format!("{b:02x}")).collect();
        let shared_path = git_dir.join(format!("sharedindex.{shared_hex}"));
        let mut link = shared_oid.to_vec();
        link.extend_from_slice(&[0u8; 24]);
        std::fs::write(&idx_path, index(2, &[b"x.txt"], &[(b"link", &link)]))?;
        std::os::unix::fs::symlink(&real, &shared_path)?;
        assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));
        std::fs::remove_file(&shared_path)?;

        let shared_fifo = Command::new("mkfifo")
            .arg(&shared_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if shared_fifo.is_ok_and(|s| s.success()) {
            let start = Instant::now();
            assert_eq!(read_index_native(tmp), Err(IndexError::Unsupported));
            assert!(start.elapsed() < Duration::from_millis(500));
        }
        Ok(())
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
    fn windows_path_quote_stripping_and_absolute_check() {
        assert_eq!(
            strip_outer_quotes(r#""C:\Program Files\Git\cmd""#),
            r"C:\Program Files\Git\cmd"
        );
        assert_eq!(strip_outer_quotes(r"C:\Git\cmd"), r"C:\Git\cmd");
        assert!(is_windows_absolute_dir(r"C:\Program Files\Git\cmd"));
        assert!(is_windows_absolute_dir(r"\\server\share\bin"));
        assert!(!is_windows_absolute_dir("C:relative"));
        assert!(!is_windows_absolute_dir(r"\root-relative"));
        assert!(!is_windows_absolute_dir("   "));
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
        std::fs::write(repo.join(".git").join("HEAD"), b"ref: refs/heads/main\n")?;
        std::fs::write(
            repo.join(".git").join("config"),
            b"[core]\n\trepositoryformatversion = 0\n",
        )?;
        // First confirm the same fixture without the `link` extension succeeds cleanly.
        let valid = index(2, &[b"dist/vendor.js"], &[]);
        std::fs::write(repo.join(".git").join("index"), valid)?;
        let ok = tracked_paths_with_path(
            &[repo_dist.clone(), outside_dist.clone()],
            Some(OsStr::new("")),
            None,
        );
        assert!(ok.tracked.contains(&repo_dist));
        assert!(ok.unknown.is_empty());

        // Now add a malformed split index extension so the index parser itself rejects it.
        let split = index(2, &[b"dist/vendor.js"], &[(b"link", b"0123456789")]);
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
        let mut cmd = Command::new("git");
        cmd.env_clear();
        for (key, value) in std::env::vars_os() {
            if !is_git_env_key(&key) {
                cmd.env(key, value);
            }
        }
        cmd.arg("-C")
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
        assert_eq!(read_index_native(&repo), Err(IndexError::Unsupported));

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

        assert_eq!(read_index_native(&repo), Err(IndexError::Unsupported));
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

        assert_eq!(read_index_native(&repo), Err(IndexError::Unsupported));

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

        assert_eq!(read_index_native(&repo), Err(IndexError::Unsupported));

        // Both with git on PATH and without git on PATH, the candidate must be unknown.
        let with_git = tracked_paths(std::slice::from_ref(&candidate));
        assert!(with_git.tracked.is_empty());
        assert!(with_git.unknown.contains(&candidate));

        let without_git =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(without_git.tracked.is_empty());
        assert!(without_git.unknown.contains(&candidate));

        // Even with a valid HEAD + config added, an empty native index must still be unknown without git.
        std::fs::write(fake_gitdir.join("HEAD"), b"ref: refs/heads/main\n")?;
        std::fs::write(
            fake_gitdir.join("config"),
            b"[core]\n\trepositoryformatversion = 0\n",
        )?;
        assert_eq!(read_index_native(&repo), Err(IndexError::Unsupported));
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

    #[cfg(unix)]
    #[test]
    fn backslash_directory_name_is_preserved_on_unix() -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let candidate = repo.join(r"a\b").join("node_modules");
        std::fs::create_dir_all(candidate.join("pkg"))?;
        std::fs::write(
            candidate.join("pkg").join("index.js"),
            b"module.exports = 1;\n",
        )?;

        assert!(run_git(&repo, &["init", "-q"]));
        assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&repo, &["config", "user.name", "t"]));
        assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&repo, &["add", r"a\b/node_modules/pkg/index.js"]));
        assert!(run_git(&repo, &["commit", "-qm", "init"]));

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
    fn broken_inner_git_inside_healthy_outer_repo_marks_unknown_via_toplevel_mismatch(
    ) -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        let candidate = inner.join("node_modules");
        std::fs::create_dir_all(inner.join(".git"))?;
        std::fs::create_dir_all(&candidate)?;
        std::fs::write(outer.join("readme.txt"), b"outer\n")?;

        assert!(run_git(&outer, &["init", "-q"]));
        assert!(run_git(&outer, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&outer, &["config", "user.name", "t"]));
        assert!(run_git(&outer, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&outer, &["add", "readme.txt"]));
        assert!(run_git(&outer, &["commit", "-qm", "init"]));

        // inner/.git has no HEAD, so `git -C inner` discovers `outer` instead of `inner`.
        let with_git = tracked_paths(std::slice::from_ref(&candidate));
        assert!(with_git.tracked.is_empty());
        assert!(with_git.unknown.contains(&candidate));
        Ok(())
    }

    #[test]
    fn nested_candidates_both_marked_tracked_when_inner_has_tracked_file() -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let outer_cand = repo.join("dist");
        let inner_cand = outer_cand.join("cache");
        std::fs::create_dir_all(&inner_cand)?;
        std::fs::write(inner_cand.join("work.js"), b"1\n")?;

        assert!(run_git(&repo, &["init", "-q"]));
        assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&repo, &["config", "user.name", "t"]));
        assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&repo, &["add", "dist/cache/work.js"]));
        assert!(run_git(&repo, &["commit", "-qm", "init"]));

        let result = tracked_paths(&[outer_cand.clone(), inner_cand.clone()]);
        assert!(result.tracked.contains(&outer_cand));
        assert!(result.tracked.contains(&inner_cand));
        assert!(result.unknown.is_empty());
        Ok(())
    }

    #[test]
    fn candidate_as_repo_and_nested_repo_inside_candidate_are_detected() -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;

        // 1. node_modules is itself a git repository with commits.
        let self_repo = dir.path().join("proj-a").join("node_modules");
        std::fs::create_dir_all(self_repo.join("pkg"))?;
        std::fs::write(self_repo.join("pkg").join("index.js"), b"1\n")?;
        assert!(run_git(&self_repo, &["init", "-q"]));
        assert!(run_git(
            &self_repo,
            &["config", "user.email", "t@example.com"]
        ));
        assert!(run_git(&self_repo, &["config", "user.name", "t"]));
        assert!(run_git(&self_repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&self_repo, &["add", "pkg/index.js"]));
        assert!(run_git(&self_repo, &["commit", "-qm", "init"]));

        // 2. node_modules/pkg is a nested repo inside a gitignored node_modules.
        let outer = dir.path().join("proj-b");
        let nested_nm = outer.join("node_modules");
        let nested_pkg = nested_nm.join("pkg");
        std::fs::create_dir_all(&nested_pkg)?;
        std::fs::write(outer.join(".gitignore"), b"node_modules\n")?;
        std::fs::write(nested_pkg.join("index.js"), b"1\n")?;
        assert!(run_git(&outer, &["init", "-q"]));
        assert!(run_git(&outer, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&outer, &["config", "user.name", "t"]));
        assert!(run_git(&outer, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&outer, &["add", ".gitignore"]));
        assert!(run_git(&outer, &["commit", "-qm", "init"]));
        assert!(run_git(&nested_pkg, &["init", "-q"]));
        assert!(run_git(
            &nested_pkg,
            &["config", "user.email", "t@example.com"]
        ));
        assert!(run_git(&nested_pkg, &["config", "user.name", "t"]));
        assert!(run_git(&nested_pkg, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&nested_pkg, &["add", "index.js"]));
        assert!(run_git(&nested_pkg, &["commit", "-qm", "init"]));

        let result = tracked_paths(&[self_repo.clone(), nested_nm.clone()]);
        assert!(result.tracked.contains(&self_repo));
        assert!(result.contains_git_repo.contains(&self_repo));
        assert!(!result.tracked.contains(&nested_nm));
        assert!(result.contains_git_repo.contains(&nested_nm));
        assert!(result.unknown.is_empty());
        Ok(())
    }

    #[test]
    fn nested_git_bound_hit_returns_unknown() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let cand = dir.path().join("node_modules");
        std::fs::create_dir_all(cand.join("a").join("b").join("c"))?;
        assert_eq!(
            contains_nested_git_with_limits(&cand, 2, 100, 10),
            NestedGitStatus::Unknown
        );
        assert_eq!(
            contains_nested_git_with_limits(&cand, 100, 100, 1),
            NestedGitStatus::Unknown
        );
        assert_eq!(
            contains_nested_git_with_limits(&cand, 100, 100, 10),
            NestedGitStatus::NotFound
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn fifo_head_does_not_block_and_marks_unknown_without_git() -> std::io::Result<()> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(repo.join(".git"))?;
        std::fs::create_dir_all(&candidate)?;
        std::fs::write(
            repo.join(".git").join("config"),
            b"[core]\n\trepositoryformatversion = 0\n",
        )?;
        let valid = index(2, &[b"node_modules/pkg/index.js"], &[]);
        std::fs::write(repo.join(".git").join("index"), valid)?;

        let head_path = repo.join(".git").join("HEAD");
        let c_path = CString::new(head_path.as_os_str().as_bytes())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(rc, 0, "mkfifo failed");

        let started = Instant::now();
        let result =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "FIFO HEAD must not block"
        );
        assert!(result.tracked.is_empty());
        assert!(result.unknown.contains(&candidate));
        Ok(())
    }

    #[test]
    fn sha256_repo_with_sha1_index_marks_unknown_without_git() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let candidate = repo.join("node_modules");
        std::fs::create_dir_all(repo.join(".git"))?;
        std::fs::create_dir_all(&candidate)?;
        std::fs::write(repo.join(".git").join("HEAD"), b"ref: refs/heads/main\n")?;
        std::fs::write(
            repo.join(".git").join("config"),
            b"[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n",
        )?;
        // A valid SHA-1 index inside a SHA-256 repository must be rejected.
        let sha1_idx = index(2, &[b"src/other.js"], &[]);
        std::fs::write(repo.join(".git").join("index"), sha1_idx)?;

        assert_eq!(read_index_native(&repo), Err(IndexError::Unsupported));
        let result =
            tracked_paths_with_path(std::slice::from_ref(&candidate), Some(OsStr::new("")), None);
        assert!(result.tracked.is_empty());
        assert!(result.unknown.contains(&candidate));
        Ok(())
    }

    #[test]
    fn ignorecase_and_precompose_unicode_folding_match_candidates() -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let nm_lower = repo.join("node_modules");
        std::fs::create_dir_all(nm_lower.join("pkg"))?;
        std::fs::write(nm_lower.join("pkg").join("index.js"), b"1\n")?;
        assert!(run_git(&repo, &["init", "-q"]));
        assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&repo, &["config", "user.name", "t"]));
        assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&repo, &["add", "node_modules/pkg/index.js"]));
        assert!(run_git(&repo, &["commit", "-qm", "init"]));
        assert!(run_git(&repo, &["config", "core.ignorecase", "true"]));

        let nm_upper = repo.join("Node_Modules");
        let with_git = tracked_paths(std::slice::from_ref(&nm_upper));
        assert!(with_git.tracked.contains(&nm_upper));
        assert!(with_git.unknown.is_empty());

        let without_git =
            tracked_paths_with_path(std::slice::from_ref(&nm_upper), Some(OsStr::new("")), None);
        assert!(without_git.tracked.contains(&nm_upper));
        assert!(without_git.unknown.is_empty());

        // Unicode NFC vs NFD equivalence when core.precomposeunicode = true.
        let nfc_dir = repo.join("caf\u{00e9}").join("node_modules");
        std::fs::create_dir_all(nfc_dir.join("pkg"))?;
        std::fs::write(nfc_dir.join("pkg").join("index.js"), b"1\n")?;
        assert!(run_git(
            &repo,
            &["config", "core.precomposeunicode", "true"]
        ));
        assert!(run_git(
            &repo,
            &["add", "caf\u{00e9}/node_modules/pkg/index.js"]
        ));
        assert!(run_git(&repo, &["commit", "-qm", "nfc"]));

        let nfd_candidate = repo.join("cafe\u{0301}").join("node_modules");
        let with_git_nfd = tracked_paths(std::slice::from_ref(&nfd_candidate));
        assert!(with_git_nfd.tracked.contains(&nfd_candidate));
        assert!(with_git_nfd.unknown.is_empty());

        let without_git_nfd = tracked_paths_with_path(
            std::slice::from_ref(&nfd_candidate),
            Some(OsStr::new("")),
            None,
        );
        assert!(without_git_nfd.tracked.contains(&nfd_candidate));
        assert!(without_git_nfd.unknown.is_empty());
        Ok(())
    }

    #[test]
    fn normalize_win_canonical_handles_verbatim_unc_slashes_and_case() {
        assert_eq!(
            normalize_win_canonical(Path::new(
                r"\\?\C:\Users\RunnerAdmin\AppData\Local\Temp\repo"
            )),
            normalize_win_canonical(Path::new("c:/users/runneradmin/appdata/local/temp/repo/"))
        );
        assert_eq!(
            normalize_win_canonical(Path::new(r"\\?\UNC\Server\Share\Repo\")),
            r"\\server\share\repo"
        );
        assert_eq!(
            normalize_win_canonical(Path::new(r"\\?\unc\SERVER\share\repo")),
            r"\\server\share\repo"
        );
        assert_eq!(normalize_win_canonical(Path::new(r"\\?\C:\")), r"c:\");
        assert_eq!(normalize_win_canonical(Path::new("C:/")), r"c:\");
        assert_ne!(
            normalize_win_canonical(Path::new(r"\\?\C:\repo-a")),
            normalize_win_canonical(Path::new(r"C:\repo-b"))
        );
    }

    #[test]
    fn aliased_repo_root_matches_git_toplevel_and_distinct_root_does_not() -> std::io::Result<()> {
        if !git_available() {
            return Ok(());
        }
        let dir = tempfile::tempdir()?;
        let repo = dir.path().join("repo");
        let other = dir.path().join("other");
        let dist = repo.join("dist");
        let nm = repo.join("node_modules");
        std::fs::create_dir_all(&dist)?;
        std::fs::create_dir_all(&nm)?;
        std::fs::create_dir_all(&other)?;
        std::fs::write(dist.join("vendor.js"), b"1\n")?;
        std::fs::write(nm.join("a.js"), b"2\n")?;

        assert!(run_git(&repo, &["init", "-q"]));
        assert!(run_git(&repo, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&repo, &["config", "user.name", "t"]));
        assert!(run_git(&repo, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&repo, &["add", "dist/vendor.js"]));
        assert!(run_git(&repo, &["commit", "-qm", "init"]));

        assert!(same_repo_root(&repo, &repo));
        assert!(!same_repo_root(&repo, &other));

        #[cfg(unix)]
        {
            let alias = dir.path().join("repo-alias");
            std::os::unix::fs::symlink(&repo, &alias)?;
            assert!(same_repo_root(&alias, &repo));

            let aliased_dist = alias.join("dist");
            let aliased_nm = alias.join("node_modules");
            let result = tracked_paths(&[aliased_dist.clone(), aliased_nm.clone()]);
            assert!(result.tracked.contains(&aliased_dist));
            assert!(!result.tracked.contains(&aliased_nm));
            assert!(result.unknown.is_empty());

            // A broken inner .git inside the aliased outer repo must still fail closed.
            let broken_inner = alias.join("broken-inner");
            let broken_cand = broken_inner.join("node_modules");
            std::fs::create_dir_all(broken_inner.join(".git"))?;
            std::fs::create_dir_all(&broken_cand)?;
            let broken_result = tracked_paths(std::slice::from_ref(&broken_cand));
            assert!(broken_result.tracked.is_empty());
            assert!(broken_result.unknown.contains(&broken_cand));
        }

        #[cfg(windows)]
        {
            let forward = PathBuf::from(repo.to_string_lossy().replace('\\', "/"));
            assert!(same_repo_root(&repo, &forward));
            let result = tracked_paths(&[dist.clone(), nm.clone()]);
            assert!(result.tracked.contains(&dist));
            assert!(!result.tracked.contains(&nm));
            assert!(result.unknown.is_empty());
        }

        Ok(())
    }

    #[test]
    fn core_worktree_in_config_or_worktree_config_marks_unknown_without_git() -> std::io::Result<()>
    {
        let dir = tempfile::tempdir()?;
        let alt_wt = dir.path().join("alt-worktree");
        std::fs::create_dir_all(&alt_wt)?;

        // Case 1: core.worktree in .git/config.
        let repo1 = dir.path().join("repo-main");
        let cand1 = repo1.join("node_modules");
        std::fs::create_dir_all(repo1.join(".git"))?;
        std::fs::create_dir_all(&cand1)?;
        std::fs::write(repo1.join(".git").join("HEAD"), b"ref: refs/heads/main\n")?;
        std::fs::write(
            repo1.join(".git").join("config"),
            format!(
                "[core]\n\trepositoryformatversion = 0\n\tworktree = {}\n",
                alt_wt.to_string_lossy().replace('\\', "/")
            ),
        )?;
        std::fs::write(
            repo1.join(".git").join("index"),
            index(2, &[b"node_modules/pkg/index.js"], &[]),
        )?;
        assert_eq!(read_index_native(&repo1), Err(IndexError::Unsupported));
        let res1 =
            tracked_paths_with_path(std::slice::from_ref(&cand1), Some(OsStr::new("")), None);
        assert!(res1.tracked.is_empty());
        assert!(res1.unknown.contains(&cand1));

        // Case 2: core.worktree in .git/config.worktree with extensions.worktreeConfig = true.
        let repo2 = dir.path().join("repo-wt");
        let cand2 = repo2.join("node_modules");
        std::fs::create_dir_all(repo2.join(".git"))?;
        std::fs::create_dir_all(&cand2)?;
        std::fs::write(repo2.join(".git").join("HEAD"), b"ref: refs/heads/main\n")?;
        std::fs::write(
            repo2.join(".git").join("config"),
            b"[core]\n\trepositoryformatversion = 1\n[extensions]\n\tworktreeconfig = true\n",
        )?;
        std::fs::write(
            repo2.join(".git").join("config.worktree"),
            format!(
                "[core]\n\tworktree = {}\n",
                alt_wt.to_string_lossy().replace('\\', "/")
            ),
        )?;
        std::fs::write(
            repo2.join(".git").join("index"),
            index(2, &[b"node_modules/pkg/index.js"], &[]),
        )?;
        assert_eq!(read_index_native(&repo2), Err(IndexError::Unsupported));
        let res2 =
            tracked_paths_with_path(std::slice::from_ref(&cand2), Some(OsStr::new("")), None);
        assert!(res2.tracked.is_empty());
        assert!(res2.unknown.contains(&cand2));
        Ok(())
    }
}
