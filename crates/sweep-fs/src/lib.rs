//! Filesystem traversal helpers for the sweep engine.

use camino::{Utf8Path, Utf8PathBuf};
use rayon::prelude::*;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

/// Maximum paths passed to a single `du` invocation (aligned with JS `DU_CHUNK_SIZE`).
pub const DU_CHUNK_SIZE: usize = 50;
/// Stay well under ARG_MAX even with deep monorepo paths (aligned with JS `DU_ARGV_BUDGET`).
pub const DU_ARGV_BUDGET: usize = 96 * 1024;

/// mtime of the path itself in epoch milliseconds, or `None` if it cannot be read.
fn modified_ms(path: &Utf8Path) -> Option<u64> {
    let modified = fs::symlink_metadata(path.as_std_path())
        .ok()?
        .modified()
        .ok()?;
    let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(since_epoch.as_millis()).ok()
}

/// Describes a filesystem entry discovered during a scan walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkEntry {
    pub path: Utf8PathBuf,
    pub name: String,
    pub is_symlink: bool,
    pub entry_type: WalkEntryType,
    pub estimated_bytes: u64,
    /// Own mtime in epoch milliseconds (`lstat`, so a symlink reports itself).
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkEntryType {
    File,
    Directory,
    Symlink,
}

/// Scan configuration subset used during directory walks.
#[derive(Debug, Clone)]
pub struct WalkConfig {
    pub patterns: Vec<String>,
    pub ignore: Vec<String>,
    pub depth: i32,
}

impl Default for WalkConfig {
    fn default() -> Self {
        Self {
            patterns: default_patterns(),
            ignore: Vec::new(),
            depth: -1,
        }
    }
}

impl From<&sweep_types::SweepConfig> for WalkConfig {
    fn from(config: &sweep_types::SweepConfig) -> Self {
        let disabled: std::collections::HashSet<&str> = config
            .disabled_patterns
            .iter()
            .map(String::as_str)
            .collect();
        let patterns = config
            .patterns
            .iter()
            .filter(|p| !disabled.contains(p.as_str()))
            .cloned()
            .collect();

        Self {
            patterns,
            ignore: config.ignore.clone(),
            depth: config.depth,
        }
    }
}

/// Default artifact patterns aligned with the JS reference engine.
/// Only machine-created, ecosystem-canonical names ship enabled - generic
/// names like `dist`/`build`/`out`/`coverage` are opt-in catalog entries
/// (they can hold user-authored files). Keep in sync with
/// `packages/core/src/catalog.ts` (byDefault entries).
pub fn default_patterns() -> Vec<String> {
    vec![
        "node_modules".to_owned(),
        ".next".to_owned(),
        ".turbo".to_owned(),
        ".parcel-cache".to_owned(),
        ".nuxt".to_owned(),
        ".svelte-kit".to_owned(),
        "target".to_owned(),
        ".nyc_output".to_owned(),
        ".vite".to_owned(),
        "*.tsbuildinfo".to_owned(),
    ]
}

/// Opt-in catalog names - curated but ambiguous enough that enabling them is
/// a user decision (the name can hold authored files). Keep in sync with
/// `packages/core/src/catalog.ts` (`byDefault: false` entries).
pub fn opt_in_patterns() -> Vec<String> {
    vec![
        "dist".to_owned(),
        "coverage".to_owned(),
        ".output".to_owned(),
        "bower_components".to_owned(),
        "__pycache__".to_owned(),
        ".venv".to_owned(),
        "venv".to_owned(),
        ".pytest_cache".to_owned(),
        ".mypy_cache".to_owned(),
        ".ruff_cache".to_owned(),
        "*.egg-info".to_owned(),
        ".gradle".to_owned(),
        "obj".to_owned(),
        "Pods".to_owned(),
        "cmake-build-*".to_owned(),
        ".dart_tool".to_owned(),
        "build".to_owned(),
        "out".to_owned(),
    ]
}

/// Trust level the pattern catalog assigns to a scanned entry name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogMatch {
    /// The name is covered by a shipping-default pattern.
    Default,
    /// The name is curated but opt-in - ambiguous enough to hold authored files.
    OptIn,
}

/// Classify an entry name against the catalog (JS `catalogMatchFor` parity):
/// `Default` for shipping-default coverage, `OptIn` for curated opt-in names,
/// `None` for names the catalog does not know. The matched *name* - not which
/// pattern fired - carries the trust level.
pub fn catalog_match_for(name: &str) -> Option<CatalogMatch> {
    static DEFAULT_MATCHER: std::sync::OnceLock<PatternMatcher> = std::sync::OnceLock::new();
    static OPT_IN_MATCHER: std::sync::OnceLock<PatternMatcher> = std::sync::OnceLock::new();
    if DEFAULT_MATCHER
        .get_or_init(|| PatternMatcher::compile(&default_patterns()))
        .matches(name)
    {
        Some(CatalogMatch::Default)
    } else if OPT_IN_MATCHER
        .get_or_init(|| PatternMatcher::compile(&opt_in_patterns()))
        .matches(name)
    {
        Some(CatalogMatch::OptIn)
    } else {
        None
    }
}

/// Result of a scan walk before size estimation.
#[derive(Debug, Clone, Default)]
pub struct WalkResult {
    pub entries: Vec<WalkEntry>,
    pub scanned_dirs: u32,
    /// Directories that could not be read or were already visited under
    /// another path (bind mounts, inode aliases). Aligned with the JS
    /// scanner's `skippedDirs` - both failure and dedupe count here.
    pub skipped_dirs: u32,
}

const SKIP_DIR_NAMES: &[&str] = &[
    ".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "_darcs", ".pijul",
];

/// macOS and Windows filesystems are case-insensitive, so `.GIT` is the same
/// protected directory as `.git` - compare lowercase there (JS parity).
fn is_skip_dir_name(name: &str) -> bool {
    if case_insensitive_fs() {
        SKIP_DIR_NAMES.contains(&name.to_ascii_lowercase().as_str())
    } else {
        SKIP_DIR_NAMES.contains(&name)
    }
}

/// `(scanned_dirs, skipped_dirs, dir)` - throttled, not every directory.
/// `dir` is the path being walked, so progress surfaces can show
/// "scanning x/" instead of only counts.
pub type OnDir<'a> = dyn Fn(u32, u32, &Utf8Path) + Sync + 'a;

/// Callbacks fired during a directory walk so callers can stream matches live.
pub struct WalkHooks<'a> {
    pub on_match: Option<&'a (dyn Fn(&WalkEntry) + Sync)>,
    pub on_dir: Option<&'a OnDir<'a>>,
}

/// Recursively walk `root`, collecting entries whose names match `config.patterns`.
///
/// Matched directories are not descended into (same semantics as the JS scanner).
/// Sibling subtrees are walked in parallel via rayon.
pub fn walk_matched_entries(root: &Utf8Path, config: &WalkConfig) -> WalkResult {
    walk_matched_entries_with_hooks(root, config, None)
}

struct WalkCtx<'a> {
    root: &'a Utf8Path,
    config: &'a WalkConfig,
    matcher: &'a PatternMatcher,
    ignore: Option<&'a IgnoreMatcher>,
    hooks: Option<&'a WalkHooks<'a>>,
    scanned: Option<&'a AtomicU32>,
    skipped: Option<&'a AtomicU32>,
    /// `(dev, ino)` of directories already walked. A bind mount or hardlinked
    /// dir makes one filesystem object reachable under several paths; without
    /// this the walk would revisit it forever at depth -1.
    visited: Option<&'a Mutex<HashSet<(u64, u64)>>>,
}

/// Mirrors the JS scanner's `markDir`: false when the dir cannot be stat'd or
/// was already walked under a different path. The not-a-real-dir refusal runs
/// on every platform; only the (dev, ino) dedupe is unix-specific - Windows
/// dedupes on (volume serial, file index) instead.
fn mark_dir(ctx: &WalkCtx<'_>, dir: &Utf8Path) -> bool {
    let meta = match fs::symlink_metadata(dir.as_std_path()) {
        Ok(meta) => meta,
        Err(_) => return false,
    };
    // A dir swapped for a symlink between read_dir and this lstat would be
    // followed by read_dir below and walked outside the target - refuse
    // anything that is no longer a real directory. Junctions are reparse
    // points and get the same refusal. (Narrows the swap window; eliminating
    // it needs fd-relative walks.)
    if meta.file_type().is_symlink() || meta_is_reparse_point(&meta) || !meta.is_dir() {
        return false;
    }
    let visited = match ctx.visited {
        Some(v) => v,
        None => return true,
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.ino() == 0 {
            return true;
        }
        match visited.lock() {
            Ok(mut guard) => guard.insert((meta.dev(), meta.ino())),
            // A poisoned lock degrades to no dedupe rather than aborting the scan.
            Err(_) => true,
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        match (meta.volume_serial_number(), meta.file_index()) {
            (Some(vol), Some(idx)) if idx != 0 => match visited.lock() {
                Ok(mut guard) => guard.insert((vol, idx)),
                Err(_) => true,
            },
            // Filesystems without file indices (some network drives) cannot
            // dedupe - links are refused above, so no revisit cycle can form.
            _ => true,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (visited, dir);
        true
    }
}

/// Walk with live match/dir hooks. `on_match` fires as soon as an artifact is found,
/// before size estimation, so a TUI can paint rows during the walk.
pub fn walk_matched_entries_with_hooks(
    root: &Utf8Path,
    config: &WalkConfig,
    hooks: Option<&WalkHooks<'_>>,
) -> WalkResult {
    let matcher = PatternMatcher::compile(&config.patterns);
    let ignore = if config.ignore.is_empty() {
        None
    } else {
        Some(IgnoreMatcher::compile(&config.ignore))
    };
    let scanned = AtomicU32::new(0);
    let skipped = AtomicU32::new(0);
    let visited = Mutex::new(HashSet::new());
    let ctx = WalkCtx {
        root,
        config,
        matcher: &matcher,
        ignore: ignore.as_ref(),
        hooks,
        scanned: Some(&scanned),
        skipped: Some(&skipped),
        visited: Some(&visited),
    };
    walk_dir(&ctx, root, 0)
}

fn walk_dir(ctx: &WalkCtx<'_>, dir: &Utf8Path, depth: i32) -> WalkResult {
    if ctx.config.depth != -1 && depth > ctx.config.depth {
        return WalkResult::default();
    }

    let skipped = |mut result: WalkResult| {
        if let Some(counter) = ctx.skipped {
            counter.fetch_add(1, Ordering::Relaxed);
        }
        result.skipped_dirs += 1;
        result
    };

    // Already visited via a bind mount / inode alias, or cannot even be
    // stat'd: nothing below this path is safe to read again.
    if !mark_dir(ctx, dir) {
        return skipped(WalkResult::default());
    }

    let read_dir = match fs::read_dir(dir.as_std_path()) {
        Ok(items) => items,
        Err(_) => return skipped(WalkResult::default()),
    };

    let mut result = WalkResult {
        scanned_dirs: 1,
        ..WalkResult::default()
    };
    if let Some(counter) = ctx.scanned {
        let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
        if n == 1 || n % 8 == 0 {
            if let Some(on_dir) = ctx.hooks.and_then(|h| h.on_dir) {
                let skipped = ctx.skipped.map(|c| c.load(Ordering::Relaxed)).unwrap_or(0);
                on_dir(n, skipped, dir);
            }
        }
    }
    let mut subdirs: Vec<Utf8PathBuf> = Vec::new();

    for item in read_dir.flatten() {
        // Lossy-decode invalid UTF-8 instead of dropping the entry - the JS
        // engine sees the same U+FFFD-mangled name. The mangled path cannot be
        // lstat'd, so the entry ends up counted skipped on both engines rather
        // than invisible on Rust and skipped on JS.
        let file_name = item.file_name().to_string_lossy().into_owned();

        let full_path = dir.join(&file_name);
        if ctx
            .ignore
            .is_some_and(|matcher| matcher.matches(ctx.root, &full_path, &file_name))
        {
            continue;
        }

        let file_type = match item.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let mut is_symlink = file_type.is_symlink();
        let mut is_dir = file_type.is_dir() && !is_symlink;
        let is_file = file_type.is_file() && !is_symlink;

        if is_dir && is_reparse_point_or_symlink(&full_path) {
            is_dir = false;
            is_symlink = true;
        }

        if ctx.matcher.matches(&file_name) {
            let entry_type = if is_symlink {
                WalkEntryType::Symlink
            } else if is_dir {
                WalkEntryType::Directory
            } else {
                WalkEntryType::File
            };

            let modified_ms = modified_ms(&full_path);
            let entry = WalkEntry {
                path: full_path,
                name: file_name,
                is_symlink,
                entry_type,
                estimated_bytes: 0,
                modified_ms,
            };
            if let Some(on_match) = ctx.hooks.and_then(|h| h.on_match) {
                on_match(&entry);
            }
            result.entries.push(entry);
            continue;
        }

        if is_dir {
            if is_skip_dir_name(&file_name) {
                continue;
            }
            subdirs.push(full_path);
        } else if !is_file && !is_symlink {
            if let Ok(meta) = fs::symlink_metadata(full_path.as_std_path()) {
                if meta.is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    if is_skip_dir_name(&file_name) {
                        continue;
                    }
                    subdirs.push(full_path);
                }
            }
        }
    }

    let child_results: Vec<WalkResult> = subdirs
        .par_iter()
        .map(|subdir| walk_dir(ctx, subdir, depth + 1))
        .collect();

    for child in child_results {
        result.entries.extend(child.entries);
        result.scanned_dirs += child.scanned_dirs;
        result.skipped_dirs += child.skipped_dirs;
    }

    result
}

fn case_insensitive_fs() -> bool {
    cfg!(windows) || cfg!(target_os = "macos")
}

struct IgnoreMatcher {
    names: PatternMatcher,
    prefixes: Vec<String>,
    path_globs: Vec<regex_lite::Regex>,
    case_insensitive: bool,
}

impl IgnoreMatcher {
    fn compile(ignore: &[String]) -> Self {
        let case_insensitive = case_insensitive_fs();
        let mut name_patterns = Vec::new();
        let mut prefixes = Vec::new();
        let mut path_globs = Vec::new();

        for raw in ignore {
            let pattern = raw.trim_end_matches('/');
            if pattern.is_empty() {
                continue;
            }
            if pattern.contains('/') {
                let source = if case_insensitive {
                    pattern.to_ascii_lowercase()
                } else {
                    pattern.to_string()
                };
                if pattern.contains('*') || pattern.contains('?') {
                    let escaped = regex_lite::escape(&source);
                    // `?` is glob single-char (.) and `*` is .* - same mapping
                    // as the JS compileIgnoreMatcher.
                    let regex_pattern =
                        format!("^{}$", escaped.replace("\\*", ".*").replace("\\?", "."));
                    if let Ok(re) = regex_lite::Regex::new(&regex_pattern) {
                        path_globs.push(re);
                    }
                } else {
                    prefixes.push(source);
                }
            } else {
                name_patterns.push(pattern.to_string());
            }
        }

        Self {
            names: PatternMatcher::compile_with_case(&name_patterns, case_insensitive),
            prefixes,
            path_globs,
            case_insensitive,
        }
    }

    fn matches(&self, root: &Utf8Path, full_path: &Utf8Path, entry_name: &str) -> bool {
        if self.names.matches(entry_name) {
            return true;
        }
        if self.prefixes.is_empty() && self.path_globs.is_empty() {
            return false;
        }

        let rel = full_path
            .strip_prefix(root)
            .map(|p| p.as_str())
            .unwrap_or(full_path.as_str());
        // On Windows the relative path carries `\` separators while ignore
        // patterns are forward-slash-joined - normalize before comparing
        // (JS compileIgnoreMatcher does the same .replace(/\\/g, "/")).
        let rel = if cfg!(windows) {
            Cow::Owned(rel.replace('\\', "/"))
        } else {
            Cow::Borrowed(rel)
        };
        let rel_key = if self.case_insensitive {
            Cow::Owned(rel.to_ascii_lowercase())
        } else {
            rel
        };

        for prefix in &self.prefixes {
            if rel_key.as_ref() == prefix
                || (rel_key.starts_with(prefix)
                    && rel_key.as_bytes().get(prefix.len()) == Some(&b'/'))
            {
                return true;
            }
        }
        self.path_globs.iter().any(|re| re.is_match(&rel_key))
    }
}

struct PatternMatcher {
    exact: std::collections::HashSet<String>,
    globs: Vec<regex_lite::Regex>,
    case_insensitive: bool,
}

impl PatternMatcher {
    fn compile(patterns: &[String]) -> Self {
        Self::compile_with_case(patterns, case_insensitive_fs())
    }

    fn compile_with_case(patterns: &[String], case_insensitive: bool) -> Self {
        let mut exact = std::collections::HashSet::new();
        let mut globs = Vec::new();

        for pattern in patterns {
            let source = if case_insensitive {
                pattern.to_ascii_lowercase()
            } else {
                pattern.clone()
            };
            if source.contains('*') || source.contains('?') {
                let escaped = regex_lite::escape(&source);
                // `?` is glob single-char (.) - without this a raw `?` would be
                // a regex quantifier on JS while Rust escaped it literally,
                // making the same pattern mean different things per engine.
                let regex_pattern =
                    format!("^{}$", escaped.replace("\\*", ".*").replace("\\?", "."));
                if let Ok(re) = regex_lite::Regex::new(&regex_pattern) {
                    globs.push(re);
                }
            } else {
                exact.insert(source);
            }
        }

        Self {
            exact,
            globs,
            case_insensitive,
        }
    }

    fn matches(&self, name: &str) -> bool {
        let key = if self.case_insensitive {
            Cow::Owned(name.to_ascii_lowercase())
        } else {
            Cow::Borrowed(name)
        };
        if self.exact.contains(key.as_ref()) {
            return true;
        }
        self.globs.iter().any(|re| re.is_match(&key))
    }
}

/// Tree-aware byte estimate aligned with the JS scanner (`du` fast path + walk fallback).
pub fn estimate_bytes(path: &Utf8Path) -> u64 {
    batch_estimate_bytes(&[path])
        .get(path.as_str())
        .copied()
        .unwrap_or_else(|| stat_fallback(path))
}

/// Maximum `du` subprocesses in flight at once; matches the JS scanner's
/// `DU_MAX_INFLIGHT`. `du` is I/O-bound - past a handful of concurrent
/// processes the disk is the wall and extra spawns only add contention.
const DU_MAX_INFLIGHT: usize = 4;

/// Batch `du` estimates for many paths (single subprocess per chunk of 50,
/// chunks in flight concurrently like the JS `ProgressiveSizer`).
pub fn batch_estimate_bytes(paths: &[&Utf8Path]) -> HashMap<String, u64> {
    let mut result = HashMap::new();
    if paths.is_empty() {
        return result;
    }

    let (flag, multiplier) = match std::env::consts::OS {
        "linux" => ("-sb", 1u64),
        "macos" => ("-sk", 1024u64),
        _ => return result,
    };

    let chunks = chunk_paths_for_du(paths);
    // A dedicated small pool bounds concurrency at DU_MAX_INFLIGHT instead of
    // the global rayon pool's thread count - parallel `du` on the same volume
    // thrashes disks long before cores are the limit.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(DU_MAX_INFLIGHT)
        .build();
    let chunk_results: Vec<HashMap<String, u64>> = match pool {
        Ok(pool) => pool.install(|| {
            chunks
                .par_iter()
                .map(|chunk| du_estimate_chunk(flag, multiplier, chunk).unwrap_or_default())
                .collect()
        }),
        Err(_) => chunks
            .iter()
            .map(|chunk| du_estimate_chunk(flag, multiplier, chunk).unwrap_or_default())
            .collect(),
    };
    for chunk_map in chunk_results {
        result.extend(chunk_map);
    }

    result
}

fn chunk_paths_for_du<'a>(paths: &'a [&'a Utf8Path]) -> Vec<&'a [&'a Utf8Path]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut used = 3usize;
    for (index, path) in paths.iter().enumerate() {
        let cost = path.as_str().len() + 1;
        if index > start && (index - start >= DU_CHUNK_SIZE || used + cost > DU_ARGV_BUDGET) {
            chunks.push(&paths[start..index]);
            start = index;
            used = 3;
        }
        used += cost;
    }
    if start < paths.len() {
        chunks.push(&paths[start..]);
    }
    chunks
}

/// Exact recursive size by walking all files under a path (aligned with JS `exactSize`).
pub fn exact_size(path: &Utf8Path) -> u64 {
    let meta = match fs::symlink_metadata(path.as_std_path()) {
        Ok(meta) => meta,
        Err(_) => return 0,
    };

    if meta.file_type().is_symlink() {
        return meta.len();
    }
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }

    walk_size(path)
}

/// Apply size estimates to walk entries, optionally using exact recursive sizing.
pub fn apply_size_estimates(entries: &mut [WalkEntry], exact: bool) {
    if entries.is_empty() {
        return;
    }

    if exact {
        for entry in entries.iter_mut() {
            entry.estimated_bytes = exact_size(&entry.path);
        }
        return;
    }

    let path_refs: Vec<&Utf8Path> = entries.iter().map(|entry| entry.path.as_path()).collect();
    let size_map = batch_estimate_bytes(&path_refs);

    for entry in entries.iter_mut() {
        entry.estimated_bytes = size_map
            .get(entry.path.as_str())
            .copied()
            .unwrap_or_else(|| {
                if entry.entry_type == WalkEntryType::Directory {
                    exact_size(&entry.path)
                } else {
                    stat_fallback(&entry.path)
                }
            });
    }
}

const DU_TIMEOUT: Duration = Duration::from_secs(30);

fn du_estimate_chunk(
    flag: &str,
    multiplier: u64,
    paths: &[&Utf8Path],
) -> Option<HashMap<String, u64>> {
    if paths.is_empty() {
        return Some(HashMap::new());
    }

    let mut command = Command::new("du");
    command.arg(flag);
    // A path that begins with "-" must not be parsed as a du option.
    command.arg("--");
    for path in paths {
        command.arg(path.as_str());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::null());

    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= DU_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return None,
        }
    };

    if !status.success() {
        return None;
    }

    let mut stdout = child.stdout.take()?;
    let mut output = String::new();
    stdout.read_to_string(&mut output).ok()?;

    let mut result = HashMap::new();
    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        let Some(tab) = line.find('\t') else {
            continue;
        };
        let Some(raw) = line[..tab].trim().parse::<u64>().ok() else {
            continue;
        };
        let path = line[tab + 1..].to_owned();
        result.insert(path, raw * multiplier);
    }

    Some(result)
}

fn stat_fallback(path: &Utf8Path) -> u64 {
    // symlink_metadata, not metadata: a symlink candidate's size is the link
    // itself - following it would report the target and misreport freed bytes.
    fs::symlink_metadata(path.as_std_path())
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// True when `meta` (from `symlink_metadata`) describes a Windows reparse
/// point - junctions, symlinks, and other tagged links. Reparse points are
/// the NTFS mechanism behind junctions; unlike a plain `is_symlink()` check
/// this catches directory junctions too. On other platforms nothing here
/// applies - `file_type().is_symlink()` is the whole story.
#[cfg(windows)]
fn meta_is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn meta_is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

fn is_reparse_point_or_symlink(entry_path: &Utf8Path) -> bool {
    let meta = match fs::symlink_metadata(entry_path.as_std_path()) {
        Ok(meta) => meta,
        Err(_) => return false,
    };

    if meta.file_type().is_symlink() {
        return true;
    }

    // Comparing canonicalize() output to the raw path is NOT a reparse check:
    // canonicalize returns verbatim \\?\ paths on Windows while the walked
    // path is not verbatim, so every directory would classify as a link and
    // the walk would never descend. The reparse-point attribute bit is the
    // real signal.
    meta_is_reparse_point(&meta)
}

fn walk_size(path: &Utf8Path) -> u64 {
    let meta = match fs::symlink_metadata(path.as_std_path()) {
        Ok(meta) => meta,
        Err(_) => return 0,
    };

    if meta.file_type().is_symlink() {
        return meta.len();
    }

    // Reparse-point directories (junctions) must not be descended: they can
    // point anywhere, including upward into the tree - that is a cycle, not
    // a subtree. Report only the link's own footprint.
    if meta_is_reparse_point(&meta) {
        return meta.len();
    }

    if meta.is_file() {
        return meta.len();
    }

    if !meta.is_dir() {
        return 0;
    }

    let mut total = 0u64;
    let read_dir = match fs::read_dir(path.as_std_path()) {
        Ok(items) => items,
        Err(_) => return 0,
    };

    for item in read_dir.flatten() {
        let child = Utf8PathBuf::from_path_buf(item.path()).ok();
        let Some(child) = child else { continue };
        if item.file_type().map(|ft| ft.is_symlink()).unwrap_or(false) {
            continue;
        }
        total += walk_size(&child);
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn walk_matched_entries_finds_node_modules() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let nm = root.join("node_modules");
        fs::create_dir_all(nm.as_std_path()).unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(root.join("src").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let result = walk_matched_entries(root, &WalkConfig::default());
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].name, "node_modules");
        assert_eq!(result.scanned_dirs, 2);
    }

    // JS readdir yields U+FFFD-mangled names for invalid UTF-8; the lossy path
    // cannot be lstat'd back to the real entry, so both engines must count the
    // dir as skipped rather than silently dropping it from the walk entirely.
    #[cfg(unix)]
    #[test]
    fn non_utf8_directory_counts_as_skipped() {
        use std::os::unix::ffi::OsStrExt;

        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let weird = dir.path().join(std::ffi::OsStr::from_bytes(b"\xff\xfe"));
        fs::create_dir_all(weird.join("node_modules"))
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let result = walk_matched_entries(root, &WalkConfig::default());
        assert_eq!(result.entries.len(), 0);
        assert_eq!(result.skipped_dirs, 1);
    }

    #[test]
    fn walk_reports_the_artifacts_own_mtime() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join("node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let result = walk_matched_entries(root, &WalkConfig::default());
        let modified = result.entries[0]
            .modified_ms
            .unwrap_or_else(|| panic!("expected an mtime for a freshly created directory"));
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_else(|err| panic!("clock before epoch: {err}"))
            .as_millis();

        assert!(u128::from(modified) <= now, "mtime is in the future");
        assert!(now - u128::from(modified) < 60_000, "mtime is not recent");
    }

    #[test]
    fn walk_finds_nested_target_directory() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join("packages/api/target").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(root.join("packages/web/node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let result = walk_matched_entries(root, &WalkConfig::default());
        let names: Vec<&str> = result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert!(
            names.contains(&"target"),
            "expected nested target match, got: {names:?}"
        );
    }

    #[test]
    fn exact_size_sums_directory_contents() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let artifact = root.join("node_modules");
        fs::create_dir_all(artifact.join("nested").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::write(artifact.join("file.txt").as_std_path(), "hello")
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        fs::write(artifact.join("nested/file2.txt").as_std_path(), "world!!")
            .unwrap_or_else(|err| panic!("write failed: {err}"));

        let size = exact_size(&artifact);
        assert_eq!(size, 5 + 7);
    }

    #[test]
    fn batch_estimate_bytes_returns_map_for_existing_paths() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let artifact = root.join("node_modules");
        fs::create_dir_all(artifact.as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let map = batch_estimate_bytes(&[artifact.as_path()]);
        if std::env::consts::OS == "linux" || std::env::consts::OS == "macos" {
            assert!(map.contains_key(artifact.as_str()));
        }
    }

    #[test]
    fn walk_respects_depth_zero() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join("node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(root.join("a/node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let config = WalkConfig {
            depth: 0,
            ..WalkConfig::default()
        };
        let result = walk_matched_entries(root, &config);
        let names: Vec<&str> = result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["node_modules"]);
    }

    #[test]
    fn walk_honors_ignore_patterns() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join("dist").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(root.join("packages/vendor/dist").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let config = WalkConfig {
            // Explicit patterns - the test covers `ignore`, not the default set.
            patterns: vec!["dist".to_owned()],
            ignore: vec!["packages/vendor".to_owned()],
            ..WalkConfig::default()
        };
        let result = walk_matched_entries(root, &config);
        let names: Vec<&str> = result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["dist"]);
    }

    #[test]
    #[cfg(unix)]
    fn unreadable_subdir_counts_as_skipped() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let locked = root.join("locked");
        fs::create_dir_all(locked.as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::set_permissions(locked.as_std_path(), fs::Permissions::from_mode(0o000))
            .unwrap_or_else(|err| panic!("chmod failed: {err}"));

        // Running as root (or on an ACL-less filesystem) read_dir succeeds
        // anyway - there is nothing deterministic to assert in that case.
        let unreadable = fs::read_dir(locked.as_std_path()).is_err();
        let result = walk_matched_entries(root, &WalkConfig::default());
        fs::set_permissions(locked.as_std_path(), fs::Permissions::from_mode(0o700))
            .unwrap_or_else(|err| panic!("restore chmod failed: {err}"));

        if unreadable {
            assert_eq!(result.skipped_dirs, 1);
        } else {
            assert_eq!(result.skipped_dirs, 0);
        }
    }

    #[test]
    fn walk_honors_custom_patterns() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join("custom-cache").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let config = WalkConfig {
            patterns: vec!["custom-cache".to_owned()],
            ..WalkConfig::default()
        };
        let result = walk_matched_entries(root, &config);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].name, "custom-cache");
    }

    #[test]
    fn walk_skips_git_directory() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join(".git/objects").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(root.join("node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let result = walk_matched_entries(root, &WalkConfig::default());
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].name, "node_modules");
        assert!(result.scanned_dirs < 4);
    }

    #[test]
    fn walk_honors_glob_ignore() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join("foo.cache").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(root.join("node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let config = WalkConfig {
            patterns: vec!["node_modules".to_owned(), "*.cache".to_owned()],
            ignore: vec!["*.cache".to_owned()],
            depth: -1,
        };
        let result = walk_matched_entries(root, &config);
        let names: Vec<&str> = result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["node_modules"]);
    }

    #[test]
    fn question_mark_is_glob_single_char_not_regex_quantifier() {
        // `foo?` must match `foo1` and NOT `foo`/`fo` - aligned with the JS
        // matcher, where a raw `?` would be a regex quantifier.
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::write(root.join("foo1").as_std_path(), "x")
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        fs::write(root.join("foo").as_std_path(), "x")
            .unwrap_or_else(|err| panic!("write failed: {err}"));

        let config = WalkConfig {
            patterns: vec!["foo?".to_owned()],
            ..WalkConfig::default()
        };
        let result = walk_matched_entries(root, &config);
        let names: Vec<&str> = result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["foo1"]);
    }

    #[test]
    #[cfg(unix)]
    fn dir_swapped_for_symlink_is_not_descended() {
        // mark_dir must refuse a path that turned into a symlink between
        // read_dir and the descent check - otherwise read_dir would follow
        // the link and walk outside the target.
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let sub = root.join("sub");
        fs::create_dir_all(sub.as_std_path()).unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let ctx_config = WalkConfig::default();
        let visited = Mutex::new(HashSet::new());
        let ctx = WalkCtx {
            root,
            config: &ctx_config,
            matcher: &PatternMatcher::compile(&ctx_config.patterns),
            ignore: None,
            hooks: None,
            scanned: None,
            skipped: None,
            visited: Some(&visited),
        };

        assert!(mark_dir(&ctx, &sub), "real dir should be visitable");

        fs::remove_dir_all(sub.as_std_path()).unwrap_or_else(|err| panic!("rmdir failed: {err}"));
        std::os::unix::fs::symlink("/", sub.as_std_path())
            .unwrap_or_else(|err| panic!("symlink failed: {err}"));
        assert!(
            !mark_dir(&ctx, &sub),
            "a dir swapped for a symlink must not be descended"
        );
    }

    #[test]
    fn walk_hooks_fire_per_match() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        fs::create_dir_all(root.join("node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(root.join("dist").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let seen = std::sync::Mutex::new(Vec::<String>::new());
        let dirs = AtomicU32::new(0);
        let hooks = WalkHooks {
            on_match: Some(&|entry: &WalkEntry| {
                if let Ok(mut names) = seen.lock() {
                    names.push(entry.name.clone());
                }
            }),
            on_dir: Some(&|count: u32, _skipped: u32, _dir: &Utf8Path| {
                dirs.store(count, Ordering::Relaxed);
            }),
        };

        // Explicit patterns - the test covers hooks, not the default set.
        let config = WalkConfig {
            patterns: vec!["node_modules".to_owned(), "dist".to_owned()],
            ..WalkConfig::default()
        };
        let result = walk_matched_entries_with_hooks(root, &config, Some(&hooks));
        let names = seen.lock().unwrap_or_else(|err| err.into_inner()).clone();
        assert_eq!(names.len(), result.entries.len());
        assert!(names.contains(&"node_modules".to_owned()));
        assert!(names.contains(&"dist".to_owned()));
        assert!(dirs.load(Ordering::Relaxed) >= 1);
    }
}
