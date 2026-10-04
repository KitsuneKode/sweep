//! Filesystem traversal helpers for the sweep engine.

mod budget;
mod concurrency;
mod identity;
#[cfg(target_os = "linux")]
mod removal;
pub use budget::ResourceBudget;
pub use identity::{file_identity, FileIdentity};
#[cfg(target_os = "linux")]
pub use removal::RemovalRoot;

use camino::{Utf8Path, Utf8PathBuf};
use crossbeam_deque::{Injector, Steal, Stealer, Worker};
use rayon::prelude::*;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};

/// Describes a filesystem entry discovered during a scan walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkEntry {
    pub identity: Option<sweep_types::FilesystemIdentity>,
    pub path: Utf8PathBuf,
    pub name: String,
    pub is_symlink: bool,
    pub entry_type: WalkEntryType,
    pub estimated_bytes: u64,
    /// `false` once sizing ran and part of the subtree was unreadable - the
    /// byte count is a partial sum (protocol `bytesKnown`). Stays `false` on
    /// discovery stubs: "not sized yet" is not "known".
    pub bytes_known: bool,
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
    pub resource_error: Option<String>,
}

impl WalkResult {
    fn merge(&mut self, other: WalkResult) {
        self.entries.extend(other.entries);
        self.scanned_dirs += other.scanned_dirs;
        self.skipped_dirs += other.skipped_dirs;
        self.resource_error = self.resource_error.take().or(other.resource_error);
    }
}

const SKIP_DIR_NAMES: &[&str] = &[
    ".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "_darcs", ".pijul",
];

/// macOS and Windows filesystems are case-insensitive, so `.GIT` is the same
/// protected directory as `.git` - compare lowercase there (JS parity).
fn is_skip_dir_name(name: &str) -> bool {
    if case_insensitive_fs() {
        SKIP_DIR_NAMES.contains(&name.to_lowercase().as_str())
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
/// Sibling subtrees are walked on a bounded work-stealing pool - discovery
/// order is therefore not lexicographic; callers that need stable output sort
/// the plan by path (as `buildPlan` already does).
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
    visited: Option<&'a VisitedDirs>,
    budget: &'a ResourceBudget,
}

/// Mirrors the JS scanner's `markDir`: false when the dir cannot be stat'd or
/// was already walked under a different path. The not-a-real-dir refusal runs
/// on every platform; only the (dev, ino) dedupe is unix-specific - Windows
/// dedupes on (volume serial, file index) instead.
/// Visited-directory set shared by all walk threads. One mutex per shard keeps
/// a deep tree's per-dir `lstat`+insert off a single contended lock.
struct VisitedDirs {
    shards: [Mutex<HashSet<(u64, u64)>>; 16],
}

impl VisitedDirs {
    fn new() -> Self {
        Self {
            shards: std::array::from_fn(|_| Mutex::new(HashSet::new())),
        }
    }

    /// Returns false if `(dev, ino)` was already inserted - an inode alias
    /// (bind mount, hardlinked dir) would otherwise loop the walk forever.
    fn insert(&self, dev: u64, ino: u64, budget: &ResourceBudget) -> bool {
        let shard = &self.shards[(ino as usize) & 15];
        match shard.lock() {
            Ok(mut guard) => {
                if guard.contains(&(dev, ino)) {
                    return false;
                }
                budget.identity() && guard.insert((dev, ino))
            }
            // A poisoned lock degrades to no dedupe rather than aborting the scan.
            Err(_) => true,
        }
    }
}

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
        visited.insert(meta.dev(), meta.ino(), ctx.budget)
    }
    #[cfg(windows)]
    {
        match file_identity(dir.as_std_path(), &meta) {
            Ok(Some(id)) => visited.insert(id.device, id.inode, ctx.budget),
            _ => false,
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
///
/// Discovery runs on one bounded worker pool over a work-stealing deque: each
/// thread drains its own LIFO (depth-first - the shape ripgrep's walker moved
/// to after BFS pinned ~1GB on wide trees), steals from the shared injector or
/// sibling workers when idle, and accumulates matches locally with no locking.
pub fn walk_matched_entries_with_hooks(
    root: &Utf8Path,
    config: &WalkConfig,
    hooks: Option<&WalkHooks<'_>>,
) -> WalkResult {
    walk_matched_entries_with_budget(root, config, hooks, &ResourceBudget::default())
}

pub fn walk_matched_entries_with_budget(
    root: &Utf8Path,
    config: &WalkConfig,
    hooks: Option<&WalkHooks<'_>>,
    budget: &ResourceBudget,
) -> WalkResult {
    let matcher = PatternMatcher::compile(&config.patterns);
    let ignore = if config.ignore.is_empty() {
        None
    } else {
        Some(IgnoreMatcher::compile(&config.ignore))
    };
    let scanned = AtomicU32::new(0);
    let skipped = AtomicU32::new(0);
    let visited = VisitedDirs::new();
    let ctx = WalkCtx {
        root,
        config,
        matcher: &matcher,
        ignore: ignore.as_ref(),
        hooks,
        scanned: Some(&scanned),
        skipped: Some(&skipped),
        visited: Some(&visited),
        budget,
    };

    let (worker_count, _) = concurrency::scan_workers();

    let injector = Injector::<DirJob>::new();
    if !budget.queue_dir(root.as_str().len()) {
        return WalkResult {
            resource_error: budget.error(),
            ..WalkResult::default()
        };
    }
    injector.push((root.to_path_buf(), 0));
    let workers: Vec<Worker<DirJob>> = (0..worker_count).map(|_| Worker::new_lifo()).collect();
    // Stealers are Sync handles; each Worker is moved into its own thread.
    let stealers: Vec<Stealer<DirJob>> = workers.iter().map(Worker::stealer).collect();
    // Jobs queued or in flight - zero means every queue is empty and no worker
    // is mid-scan, which is the termination condition.
    let pending = AtomicUsize::new(1);
    let stopped = AtomicBool::new(false);
    let stopped_ref = &stopped;

    // Bind shared state as references up front so each spawned closure copies
    // the `&` instead of trying to move the values into the map's FnMut.
    let (ctx_ref, injector_ref, stealers_ref, pending_ref) = (&ctx, &injector, &stealers, &pending);
    let mut result = WalkResult::default();
    std::thread::scope(|scope| {
        let handles: Vec<_> = workers
            .into_iter()
            .enumerate()
            .map(|(index, local)| {
                scope.spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        walk_worker(
                            ctx_ref,
                            local,
                            injector_ref,
                            stealers_ref,
                            pending_ref,
                            stopped_ref,
                            index,
                        )
                    }));
                    match result {
                        Ok(result) => result,
                        Err(payload) => {
                            stopped_ref.store(true, Ordering::Release);
                            std::panic::resume_unwind(payload)
                        }
                    }
                })
            })
            .collect();
        for handle in handles {
            match handle.join() {
                Ok(piece) => result.merge(piece),
                // Propagate worker panics instead of silently keeping a
                // partial walk - the scan must not report "done" on a tree it
                // only half-read.
                Err(payload) => std::panic::resume_unwind(payload),
            }
        }
    });
    result
}

/// `(directory, depth)` unit of work for the walk pool.
type DirJob = (Utf8PathBuf, i32);

/// Dirents seen per directory before the listing is declared untrustworthy.
/// No budget otherwise bounds enumeration: a hostile FUSE/NFS dir returning
/// an endless stream would spin a scan forever with flat memory. JS parity:
/// MAX_DIR_ENTRIES.
const MAX_DIR_ENTRIES: u64 = 4_000_000;

fn walk_worker(
    ctx: &WalkCtx<'_>,
    local: Worker<DirJob>,
    injector: &Injector<DirJob>,
    stealers: &[Stealer<DirJob>],
    pending: &AtomicUsize,
    stopped: &AtomicBool,
    index: usize,
) -> WalkResult {
    let mut result = WalkResult::default();
    let mut idle = 0u32;
    loop {
        if stopped.load(Ordering::Acquire) || ctx.budget.failed() {
            break;
        }
        let job = local.pop().or_else(|| {
            // Shared injector first (it feeds bursts of fresh work), then
            // round-robin steals from siblings starting past ourselves.
            match injector.steal_batch_and_pop(&local) {
                Steal::Success(job) => return Some(job),
                Steal::Retry | Steal::Empty => {}
            }
            let n = stealers.len();
            for offset in 1..n {
                match stealers[(index + offset) % n].steal() {
                    Steal::Success(job) => return Some(job),
                    Steal::Retry | Steal::Empty => continue,
                }
            }
            None
        });

        let Some((dir, depth)) = job else {
            // Every queue came up empty - the scan is over only when no task
            // is still in flight (a worker mid-scan may yet push children).
            if pending.load(Ordering::Acquire) == 0 {
                break;
            }
            // Sparse tails need not burn seven CPU cores while one reader
            // waits on the disk. Brief spins, then bounded sleep; stop and
            // termination are rechecked on every iteration.
            idle = idle.saturating_add(1);
            if idle < 16 {
                std::thread::yield_now();
            } else {
                std::thread::sleep(std::time::Duration::from_micros(100));
            }
            continue;
        };

        idle = 0;
        ctx.budget.dequeue_directory();
        let (piece, children) = scan_dir(ctx, &dir, depth);
        // Children are queued and counted BEFORE the parent's slot releases:
        // fetch_add-then-fetch_sub keeps `pending` from transiently reading
        // zero while a thief could already hold one of these children.
        pending.fetch_add(children.len(), Ordering::AcqRel);
        for child in children {
            local.push(child);
        }
        result.merge(piece);
        pending.fetch_sub(1, Ordering::AcqRel);
    }
    result
}

/// Scan one directory: return its matches plus the descendable child dirs as
/// fresh jobs. Never recurses - the worker pool owns the schedule.
fn scan_dir(ctx: &WalkCtx<'_>, dir: &Utf8Path, depth: i32) -> (WalkResult, Vec<DirJob>) {
    if ctx.config.depth != -1 && depth > ctx.config.depth {
        return (WalkResult::default(), Vec::new());
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
        return (skipped(WalkResult::default()), Vec::new());
    }
    // Only an admitted directory draws on maxDirectories - an alias that
    // failed mark_dir is a skip, not a lifetime admission. JS parity: the
    // charge follows markDir, so alias-dense trees can't exhaust the walk
    // budget before real dirs even start.
    if !ctx.budget.admit_directory() {
        return (WalkResult::default(), Vec::new());
    }

    let read_dir = match fs::read_dir(dir.as_std_path()) {
        Ok(items) => items,
        Err(_) => return (skipped(WalkResult::default()), Vec::new()),
    };

    scan_dir_entries(ctx, dir, depth, read_dir)
}

fn scan_dir_entries(
    ctx: &WalkCtx<'_>,
    dir: &Utf8Path,
    depth: i32,
    entries: impl Iterator<Item = std::io::Result<fs::DirEntry>>,
) -> (WalkResult, Vec<DirJob>) {
    let mut incomplete = false;
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
    let mut seen: u64 = 0;

    for item in entries {
        if ctx.budget.failed() {
            break;
        }
        // An unbounded dirent stream must not spin the walk forever - past
        // the cap the listing is incomplete and the dir counts as skipped,
        // like a mid-read error (JS parity).
        seen += 1;
        if seen > MAX_DIR_ENTRIES {
            incomplete = true;
            break;
        }
        let item = match item {
            Ok(item) => item,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        // The wire contract carries UTF-8 paths. Lossy conversion can name a
        // different, real entry containing U+FFFD, so never use it for paths.
        // Sizing below an already selected artifact still uses raw OsStrings.
        let file_name = item.file_name();
        let Some(file_name) = file_name.to_str() else {
            incomplete = true;
            continue;
        };

        let file_type = match item.file_type() {
            Ok(ft) => ft,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };

        // Dirents report symlinks authoritatively on unix - an lstat here
        // would only re-answer the same question. Junctions are the Windows
        // hazard: they surface as plain dirs in dirents, so the reparse check
        // stays an lstat there. A dir swapped for a link after readdir is
        // caught by mark_dir's lstat before descent regardless.
        #[cfg(windows)]
        let (mut is_symlink, mut is_dir) = {
            let is_symlink = file_type.is_symlink();
            (is_symlink, file_type.is_dir() && !is_symlink)
        };
        #[cfg(not(windows))]
        let (mut is_symlink, mut is_dir) = {
            let is_symlink = file_type.is_symlink();
            (is_symlink, file_type.is_dir() && !is_symlink)
        };
        let is_file = file_type.is_file() && !is_symlink;
        let matched = ctx.matcher.matches(file_name);

        // Cheap reject before any path allocation: a leaf that matches no
        // pattern produces nothing and descends nowhere, so ignore rules are
        // irrelevant to it. `is_skip_dir_name` is a basename check - a skipped
        // dir never needs its path either.
        if !matched {
            if is_file || is_symlink {
                continue;
            }
            if is_dir && is_skip_dir_name(file_name) {
                continue;
            }
        }

        // From here the entry is a candidate, a descent target, or a dirent
        // the filesystem could not classify - all of which need the path.
        let full_path = dir.join(file_name);
        if ctx
            .ignore
            .is_some_and(|matcher| matcher.matches(ctx.root, &full_path, file_name))
        {
            continue;
        }

        #[cfg(windows)]
        if is_dir && is_reparse_point_or_symlink(&full_path) {
            is_dir = false;
            is_symlink = true;
        }

        // DT_UNKNOWN dirents (NFSv3, CIFS/SMB, FUSE) classify nothing - lstat
        // once so the candidate entry_type AND the descent decision both see
        // the real type. A failed lstat means the entry vanished or is
        // unreadable: the listing is incomplete either way (JS parity: the
        // "?" arm marks midReadError the same).
        if !is_symlink && !is_dir && !is_file {
            match fs::symlink_metadata(full_path.as_std_path()) {
                Ok(meta) => {
                    let ft = meta.file_type();
                    is_symlink = ft.is_symlink();
                    is_dir = ft.is_dir() && !is_symlink;
                    // Entry_type below reads "everything else is a file" -
                    // after the lstat a socket/fifo still lands on File,
                    // matching the JS entryType fallback.
                }
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            }
        }

        if matched {
            if !ctx.budget.candidate(full_path.as_str().len(), 0) {
                break;
            }
            let entry_type = if is_symlink {
                WalkEntryType::Symlink
            } else if is_dir {
                WalkEntryType::Directory
            } else {
                WalkEntryType::File
            };

            let metadata = fs::symlink_metadata(full_path.as_std_path()).ok();
            let identity = metadata
                .as_ref()
                .and_then(|meta| file_identity(full_path.as_std_path(), meta).ok().flatten())
                .map(FileIdentity::snapshot);
            let modified_ms = metadata
                .as_ref()
                .and_then(|meta| meta.modified().ok())
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok());
            let entry = WalkEntry {
                identity,
                path: full_path,
                name: file_name.to_owned(),
                is_symlink,
                entry_type,
                estimated_bytes: 0,
                bytes_known: false,
                modified_ms,
            };
            if let Some(on_match) = ctx.hooks.and_then(|h| h.on_match) {
                on_match(&entry);
            }
            result.entries.push(entry);
            continue;
        }

        if ctx.config.depth != -1 && depth >= ctx.config.depth {
            continue;
        }
        // The skip-name check repeats here, not only in the dirent-type fast
        // path above: a DT_UNKNOWN dirent only learns it is a dir from the
        // lstat, and its name was never checked.
        if is_dir && !is_skip_dir_name(file_name) {
            if !ctx.budget.queue_dir(full_path.as_str().len()) {
                break;
            }
            subdirs.push(full_path);
        }
    }

    if incomplete {
        result.skipped_dirs += 1;
        if let Some(counter) = ctx.skipped {
            counter.fetch_add(1, Ordering::Relaxed);
        }
    }

    (
        result,
        subdirs.into_iter().map(|dir| (dir, depth + 1)).collect(),
    )
}

fn case_insensitive_fs() -> bool {
    cfg!(windows) || cfg!(target_os = "macos")
}

struct IgnoreMatcher {
    names: PatternMatcher,
    prefixes: Vec<String>,
    path_globs: Vec<String>,
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
                    pattern.to_lowercase()
                } else {
                    pattern.to_string()
                };
                if pattern.contains('*') || pattern.contains('?') {
                    // Same linear `*`/`?` matcher as the scan patterns -
                    // `?` means "one char" identically on both paths.
                    path_globs.push(source);
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
            Cow::Owned(rel.to_lowercase())
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
        self.path_globs
            .iter()
            .any(|glob| glob_match(glob, &rel_key))
    }
}

/// Linear `*`/`?` glob match - the two-pointer-with-star-backtracking shape
/// libc `glob(3)` uses, so a hostile pattern can never put the walk into
/// regex backtracking (audit A01). `*` matches any run including `/`; `?`
/// matches exactly one unit. ASCII takes the byte slice (zero-alloc); the
/// char path matches `?` per `char`, where JS matches per UTF-16 code unit -
/// a lone `?` against an astral-plane name is the one defined divergence.
fn glob_match(pattern: &str, name: &str) -> bool {
    if pattern.is_ascii() && name.is_ascii() {
        return glob_match_units(pattern.as_bytes(), name.as_bytes(), b'*', b'?');
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    glob_match_units(&pattern, &name, '*', '?')
}

fn glob_match_units<T: PartialEq + Copy>(pattern: &[T], name: &[T], star: T, question: T) -> bool {
    let (mut p, mut s) = (0usize, 0usize);
    // Last `*` position and the name offset it has consumed so far - on a
    // mismatch the star resumes one unit further along the name.
    let (mut star_p, mut star_s) = (usize::MAX, usize::MAX);
    while s < name.len() {
        if p < pattern.len() && (pattern[p] == question || pattern[p] == name[s]) {
            p += 1;
            s += 1;
        } else if p < pattern.len() && pattern[p] == star {
            star_p = p;
            p += 1;
            star_s = s;
        } else if star_p != usize::MAX {
            p = star_p + 1;
            star_s += 1;
            s = star_s;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == star {
        p += 1;
    }
    p == pattern.len()
}

struct PatternMatcher {
    exact: std::collections::HashSet<String>,
    globs: Vec<String>,
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
                pattern.to_lowercase()
            } else {
                pattern.clone()
            };
            if source.contains('*') || source.contains('?') {
                globs.push(source);
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
            Cow::Owned(name.to_lowercase())
        } else {
            Cow::Borrowed(name)
        };
        if self.exact.contains(key.as_ref()) {
            return true;
        }
        self.globs.iter().any(|glob| glob_match(glob, &key))
    }
}

/// Tree-aware byte estimate aligned with the JS scanner's `du` fast path.
/// Returns just the bytes - callers needing completeness use `apparent_size`.
pub fn estimate_bytes(path: &Utf8Path) -> u64 {
    apparent_size(path).bytes
}

/// One sizing pool is shared by candidate jobs and subdivision jobs. Nested
/// Rayon work stays on the CPU-aware workers instead of creating a pool per
/// candidate or using the unbounded CPU-sized global pool.
fn sizing_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(concurrency::scan_workers().1)
            .build()
            .ok()
    })
    .as_ref()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubtreeSize {
    pub bytes: u64,
    pub complete: bool,
}

impl SubtreeSize {
    fn merge(&mut self, other: Self) {
        match self
            .bytes
            .checked_add(other.bytes)
            .filter(|&n| n <= 9_007_199_254_740_991)
        {
            Some(bytes) => self.bytes = bytes,
            None => {
                self.bytes = u64::MAX;
                self.complete = false;
            }
        }
        self.complete &= other.complete;
    }
}

struct SizeContext<'a> {
    budget: &'a ResourceBudget,
    cancelled: Option<&'a AtomicBool>,
    exact: bool,
    parallel: bool,
    /// Per-job caps on the transient dedup sets and pending queue. These sets
    /// die with the job, so they bound peak memory - not a cumulative total.
    dedup_cap: usize,
    pending_cap: usize,
    pending: AtomicUsize,
    path_bytes: AtomicUsize,
    links: Mutex<HashSet<(u64, u64)>>,
    dirs: Mutex<HashSet<(u64, u64)>>,
}

impl SizeContext<'_> {
    fn stopped(&self) -> bool {
        self.budget.failed()
            || self
                .cancelled
                .is_some_and(|flag| flag.load(Ordering::Acquire))
    }
}

impl Drop for SizeContext<'_> {
    fn drop(&mut self) {
        let links = self
            .links
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .len();
        let dirs = self.dirs.get_mut().unwrap_or_else(|p| p.into_inner()).len();
        self.budget.release_sizing_identities(links + dirs);
        self.budget
            .release_sizing_directories(*self.pending.get_mut(), *self.path_bytes.get_mut());
    }
}

/// Admits a directory to the job-local queue. The walk already bounded these
/// paths globally; this caps the in-flight stack per sizing job only.
fn queue_sizing_dir(
    ctx: &SizeContext<'_>,
    children: &mut Vec<std::path::PathBuf>,
    path: std::path::PathBuf,
) -> bool {
    if ctx.pending.fetch_add(1, Ordering::Relaxed) >= ctx.pending_cap {
        ctx.pending.fetch_sub(1, Ordering::Relaxed);
        return false;
    }
    let bytes = path.as_os_str().len();
    if !ctx.budget.sizing_directory(bytes) {
        ctx.pending.fetch_sub(1, Ordering::Relaxed);
        return false;
    }
    ctx.path_bytes.fetch_add(bytes, Ordering::Relaxed);
    children.push(path);
    true
}

fn price_sizing_inode(
    meta: &fs::Metadata,
    ctx: &SizeContext<'_>,
    path: impl FnOnce() -> std::path::PathBuf,
) -> SubtreeSize {
    let exact = ctx.exact;
    let links = &ctx.links;
    let mut complete = true;
    if exact {
        return SubtreeSize {
            bytes: if meta.is_file() { meta.len() } else { 0 },
            complete,
        };
    }
    // GNU du's usable_st_size excludes directories and special inodes.
    let mut bytes = meta.len();
    if meta.is_dir() || (!meta.is_file() && !meta.is_symlink()) {
        bytes = 0;
    } else {
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            let _ = path;
            if meta.nlink() > 1 {
                file_identity(Path::new(""), meta)
            } else {
                Ok(None)
            }
        };
        #[cfg(not(unix))]
        let identity = file_identity(&path(), meta);
        let identity = match identity {
            Ok(identity) => identity,
            Err(_) => {
                return SubtreeSize {
                    bytes,
                    complete: false,
                }
            }
        };
        #[cfg(windows)]
        if identity.is_none() {
            return SubtreeSize {
                bytes,
                complete: false,
            };
        }
        let Some(identity) = identity.filter(|id| id.links > 1) else {
            return SubtreeSize { bytes, complete };
        };
        let mut seen = links.lock().unwrap_or_else(|p| p.into_inner());
        let key = (identity.device, identity.inode);
        if seen.contains(&key) {
            bytes = 0;
        } else if seen.len() >= ctx.dedup_cap || !ctx.budget.sizing_identity() {
            // Set at cap: count the link anyway (overcount, flagged partial)
            // rather than undercounting zero or killing the scan.
            complete = false;
        } else {
            seen.insert(key);
        }
    }
    SubtreeSize { bytes, complete }
}

const SIZE_DIR_BATCH: usize = 64;
const SIZE_PAR_DEPTH: u8 = 3;

fn size_children(
    children: &mut Vec<std::path::PathBuf>,
    ctx: &SizeContext<'_>,
    depth: u8,
) -> SubtreeSize {
    let initial = SubtreeSize {
        bytes: 0,
        complete: true,
    };
    let result = if ctx.parallel && depth < SIZE_PAR_DEPTH && children.len() >= 4 {
        children
            .par_iter()
            .map(|path| size_directories(path, ctx, depth + 1))
            .reduce(
                || initial,
                |mut a, b| {
                    a.merge(b);
                    a
                },
            )
    } else {
        children.iter().fold(initial, |mut total, path| {
            total.merge(size_directories(path, ctx, SIZE_PAR_DEPTH));
            total
        })
    };
    children.clear();
    result
}

/// Read directory entries without retaining per-file paths. A DirEntry's
/// metadata does not follow symlinks; on Unix it can use its directory fd.
/// Child directories are subdivided in bounded batches at the first three
/// levels; below that a local LIFO replaces recursion. Deep trees hold no fd
/// per ancestor and cannot exhaust the stack just by increasing depth.
fn size_directories(root: &Path, ctx: &SizeContext<'_>, depth: u8) -> SubtreeSize {
    let mut pending = vec![root.to_path_buf()];
    let mut total = SubtreeSize {
        bytes: 0,
        complete: true,
    };
    while let Some(dir) = pending.pop() {
        ctx.pending.fetch_sub(1, Ordering::Relaxed);
        let bytes = dir.as_os_str().len();
        ctx.path_bytes.fetch_sub(bytes, Ordering::Relaxed);
        ctx.budget.release_sizing_directories(1, bytes);
        if ctx.stopped() {
            total.complete = false;
            break;
        }
        let meta = match fs::symlink_metadata(&dir) {
            Ok(meta) => meta,
            Err(_) => {
                total.complete = false;
                continue;
            }
        };
        // Revalidate each queued directory. A directory replaced by a link
        // is priced as the link and never deliberately followed. Pathname
        // operations still have a residual swap window before read_dir.
        if !meta.is_dir() || meta.is_symlink() || meta_is_reparse_point(&meta) {
            total.merge(price_sizing_inode(&meta, ctx, || dir.clone()));
            continue;
        }
        let identity = match file_identity(&dir, &meta) {
            Ok(identity) => identity,
            Err(_) => {
                total.complete = false;
                continue;
            }
        };
        #[cfg(windows)]
        if identity.is_none() {
            total.complete = false;
            continue;
        }
        if let Some(identity) = identity {
            let key = (identity.device, identity.inode);
            let mut dirs = ctx.dirs.lock().unwrap_or_else(|p| p.into_inner());
            // Skip repeats and capped-set inserts alike - without the dedup
            // entry a hardlinked-dir cycle could recurse forever.
            if dirs.contains(&key) || dirs.len() >= ctx.dedup_cap || !ctx.budget.sizing_identity() {
                total.complete = false;
                continue;
            }
            dirs.insert(key);
        }
        total.merge(price_sizing_inode(&meta, ctx, || dir.clone()));
        let items = match fs::read_dir(&dir) {
            Ok(items) => items,
            Err(_) => {
                total.complete = false;
                continue;
            }
        };
        let mut children = Vec::with_capacity(SIZE_DIR_BATCH);
        for item in items {
            if ctx.stopped() {
                total.complete = false;
                break;
            }
            let item = match item {
                Ok(item) => item,
                Err(_) => {
                    total.complete = false;
                    continue;
                }
            };
            let ft = match item.file_type() {
                Ok(ft) => ft,
                Err(_) => {
                    total.complete = false;
                    continue;
                }
            };
            // On Unix a directory dirent needs no separate stat until its job
            // starts. Windows must inspect reparse attributes first.
            #[cfg(not(windows))]
            if ft.is_dir() {
                let path = item.path();
                if !queue_sizing_dir(ctx, &mut children, path) {
                    total.complete = false;
                    break;
                }
            }
            #[cfg(windows)]
            if ft.is_dir() {
                match item.metadata() {
                    Ok(meta) if !meta_is_reparse_point(&meta) => {
                        let path = item.path();
                        if !queue_sizing_dir(ctx, &mut children, path) {
                            total.complete = false;
                            break;
                        }
                    }
                    Ok(meta) => {
                        total.merge(price_sizing_inode(&meta, ctx, || item.path()));
                    }
                    Err(_) => total.complete = false,
                }
            }
            if !ft.is_dir() {
                match item.metadata() {
                    Ok(meta)
                        if meta.is_dir() && !meta.is_symlink() && !meta_is_reparse_point(&meta) =>
                    {
                        let path = item.path();
                        if !queue_sizing_dir(ctx, &mut children, path) {
                            total.complete = false;
                            break;
                        }
                    }
                    Ok(meta) => {
                        total.merge(price_sizing_inode(&meta, ctx, || item.path()));
                    }
                    Err(_) => total.complete = false,
                }
            }
            if children.len() >= SIZE_DIR_BATCH {
                if depth < SIZE_PAR_DEPTH {
                    total.merge(size_children(&mut children, ctx, depth));
                } else {
                    pending.append(&mut children);
                }
            }
        }
        if depth < SIZE_PAR_DEPTH {
            total.merge(size_children(&mut children, ctx, depth));
        } else {
            pending.append(&mut children);
        }
    }
    if total.bytes > 9_007_199_254_740_991 {
        ctx.budget.fail("byte counter overflow");
    }
    total.complete &= !ctx.stopped();
    total
}

pub fn measure_size_with_budget(
    path: &Utf8Path,
    exact: bool,
    budget: &ResourceBudget,
) -> SubtreeSize {
    measure_size_with_budget_controlled(path, exact, budget, None)
}

/// Cancel a read-only preflight inside large subtrees without poisoning the
/// resource budget. Blocking filesystem syscalls themselves remain blocking.
pub fn measure_size_with_budget_controlled(
    path: &Utf8Path,
    exact: bool,
    budget: &ResourceBudget,
    cancelled: Option<&AtomicBool>,
) -> SubtreeSize {
    if budget.failed() || cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return SubtreeSize {
            bytes: 0,
            complete: false,
        };
    }
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => {
            return SubtreeSize {
                bytes: 0,
                complete: false,
            }
        }
    };
    if meta.is_symlink() || meta_is_reparse_point(&meta) || !meta.is_dir() {
        if meta.len() > 9_007_199_254_740_991 {
            budget.fail("byte counter overflow");
            return SubtreeSize {
                bytes: 0,
                complete: false,
            };
        }
        return SubtreeSize {
            bytes: if exact && !meta.is_file() && !meta.is_symlink() {
                0
            } else {
                meta.len()
            },
            complete: true,
        };
    }
    // No admission charge: the walk already bounded this path globally. Sizing
    // bounds its own transient state via per-job caps; a scan-level failure
    // still propagates through `budget.failed()` polls inside the job.
    if budget.failed() {
        return SubtreeSize {
            bytes: 0,
            complete: false,
        };
    }
    let (dedup_cap, pending_cap) = budget.sizing_caps();
    let root_bytes = path.as_std_path().as_os_str().len();
    if !budget.sizing_directory(root_bytes) {
        return SubtreeSize {
            bytes: 0,
            complete: false,
        };
    }
    let ctx = SizeContext {
        budget,
        cancelled,
        exact,
        parallel: sizing_pool().is_some(),
        dedup_cap,
        pending_cap,
        pending: AtomicUsize::new(1),
        path_bytes: AtomicUsize::new(root_bytes),
        links: Mutex::new(HashSet::new()),
        dirs: Mutex::new(HashSet::new()),
    };
    let run = || size_directories(path.as_std_path(), &ctx, 0);
    match sizing_pool() {
        Some(pool) => pool.install(run),
        None => run(),
    }
}

/// GNU du -sb apparent size on Linux, counting repeated hard links once.
pub fn apparent_size(path: &Utf8Path) -> SubtreeSize {
    measure_size_with_budget(path, false, &ResourceBudget::default())
}

/// Files-only size with JS exactSize semantics: interior links are skipped.
pub fn exact_size(path: &Utf8Path) -> SubtreeSize {
    measure_size_with_budget(path, true, &ResourceBudget::default())
}

pub fn batch_estimate_bytes(paths: &[&Utf8Path]) -> HashMap<String, SubtreeSize> {
    let run = || {
        paths
            .par_iter()
            .map(|path| (path.as_str().to_owned(), apparent_size(path)))
            .collect()
    };
    match sizing_pool() {
        Some(pool) => pool.install(run),
        None => paths
            .iter()
            .map(|path| (path.as_str().to_owned(), apparent_size(path)))
            .collect(),
    }
}

pub fn apply_size_estimates(entries: &mut [WalkEntry], exact: bool) {
    apply_size_estimates_with_budget(entries, exact, &ResourceBudget::default());
}

pub fn apply_size_estimates_with_budget(
    entries: &mut [WalkEntry],
    exact: bool,
    budget: &ResourceBudget,
) {
    let apply_one = |entry: &mut WalkEntry| {
        let size = measure_size_with_budget(&entry.path, exact, budget);
        entry.estimated_bytes = size.bytes;
        entry.bytes_known = size.complete;
    };
    match sizing_pool() {
        Some(pool) => pool.install(|| entries.par_iter_mut().for_each(apply_one)),
        None => entries.iter_mut().for_each(apply_one),
    }
}

/// Dispatcher runs outside the sizing pool, so waiting for discoveries or
/// permits never parks one of its workers. In-flight candidate jobs are capped
/// independently of the input channel; subdivision stays on the same pool.
pub fn size_entries_progressively(
    receiver: std::sync::mpsc::Receiver<WalkEntry>,
    exact: bool,
    on_sized: &(dyn Fn(&WalkEntry, SubtreeSize) + Sync),
) {
    size_entries_progressively_with_budget(receiver, exact, on_sized, &ResourceBudget::default());
}

pub fn size_entries_progressively_with_budget(
    receiver: std::sync::mpsc::Receiver<WalkEntry>,
    exact: bool,
    on_sized: &(dyn Fn(&WalkEntry, SubtreeSize) + Sync),
    budget: &ResourceBudget,
) {
    let Some(pool) = sizing_pool() else {
        for entry in receiver {
            on_sized(&entry, measure_size_with_budget(&entry.path, exact, budget));
        }
        return;
    };
    let pending = (Mutex::new(0usize), Condvar::new());
    pool.in_place_scope(|scope| {
        for entry in receiver {
            let mut count = pending.0.lock().unwrap_or_else(|p| p.into_inner());
            while *count >= 32 {
                count = pending.1.wait(count).unwrap_or_else(|p| p.into_inner());
            }
            *count += 1;
            drop(count);
            let pending = &pending;
            scope.spawn(move |_| {
                struct Permit<'a>(&'a (Mutex<usize>, Condvar));
                impl Drop for Permit<'_> {
                    fn drop(&mut self) {
                        let mut count = self.0 .0.lock().unwrap_or_else(|p| p.into_inner());
                        *count -= 1;
                        self.0 .1.notify_one();
                    }
                }
                let _permit = Permit(pending);
                on_sized(&entry, measure_size_with_budget(&entry.path, exact, budget));
            });
        }
    });
}

/// Size of the entry itself (lstat, so symlinks report the link). The
/// no-recursion fallback for paths that can't be walked.
pub fn stat_fallback(path: &Utf8Path) -> u64 {
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

/// Junction/reparse detection - only Windows surfaces links as dirent dirs.
#[cfg(windows)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use sweep_types::ScanLimits;
    use tempfile::tempdir;

    #[test]
    fn cancelled_sizing_returns_incomplete_and_refunds_queued_paths() {
        let dir = tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        fs::write(dir.path().join("file"), b"keep").unwrap_or_else(|e| panic!("write: {e}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("path"));
        let budget = ResourceBudget::new(ScanLimits {
            max_queued_dirs: 1,
            max_identities: 1,
            ..ScanLimits::default()
        });
        let cancel = AtomicBool::new(true);
        for exact in [true, false] {
            assert_eq!(
                measure_size_with_budget_controlled(root, exact, &budget, Some(&cancel)),
                SubtreeSize {
                    bytes: 0,
                    complete: false
                }
            );
            // Exercise cancellation after a sizing job's path reservation.
            let bytes = root.as_std_path().as_os_str().len();
            assert!(budget.sizing_directory(bytes));
            let ctx = SizeContext {
                budget: &budget,
                cancelled: Some(&cancel),
                exact,
                parallel: false,
                dedup_cap: 1,
                pending_cap: 1,
                pending: AtomicUsize::new(1),
                path_bytes: AtomicUsize::new(bytes),
                links: Mutex::new(HashSet::new()),
                dirs: Mutex::new(HashSet::new()),
            };
            assert_eq!(
                size_directories(root.as_std_path(), &ctx, 0),
                SubtreeSize {
                    bytes: 0,
                    complete: false
                }
            );
            drop(ctx);
            assert!(budget.sizing_directory(bytes));
            budget.release_sizing_directories(1, bytes);
            assert!(budget.sizing_identity());
            budget.release_sizing_identities(1);
            assert!(!budget.failed());
        }
        cancel.store(false, Ordering::Release);
        assert_eq!(
            measure_size_with_budget_controlled(root, false, &budget, Some(&cancel)),
            SubtreeSize {
                bytes: 4,
                complete: true
            }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn discovery_does_not_alias_invalid_utf8_to_a_real_replacement_name() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        fs::write(
            dir.path().join(std::ffi::OsStr::from_bytes(b"\xff.tmp")),
            b"invalid",
        )
        .unwrap_or_else(|e| panic!("write: {e}"));
        let valid = dir.path().join("\u{fffd}.tmp");
        fs::write(&valid, b"valid").unwrap_or_else(|e| panic!("write: {e}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("path"));
        let result = walk_matched_entries(
            root,
            &WalkConfig {
                patterns: vec!["*.tmp".to_owned()],
                ignore: vec![],
                depth: -1,
            },
        );
        assert_eq!(
            result.entries.len(),
            1,
            "invalid bytes must never name another entry"
        );
        assert_eq!(result.entries[0].path.as_std_path(), valid);
        assert_eq!(result.skipped_dirs, 1);
    }

    #[test]
    fn worker_callback_panic_does_not_strand_other_walkers() {
        let dir = tempdir().unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
        fs::create_dir(dir.path().join("node_modules"))
            .unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
        let root =
            Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("fixture path not UTF-8"));
        let callback = |_: &WalkEntry| panic!("injected callback failure");
        let hooks = WalkHooks {
            on_match: Some(&callback),
            on_dir: None,
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            walk_matched_entries_with_hooks(root, &WalkConfig::default(), Some(&hooks));
        }));
        assert!(result.is_err());
    }

    #[test]
    fn apparent_inode_pricing_excludes_directory_metadata() {
        let dir = tempdir().unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
        let meta = fs::symlink_metadata(dir.path())
            .unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
        let budget = ResourceBudget::default();
        let (dedup_cap, pending_cap) = budget.sizing_caps();
        let mut ctx = SizeContext {
            exact: false,
            parallel: false,
            budget: &budget,
            cancelled: None,
            dedup_cap,
            pending_cap,
            pending: AtomicUsize::new(0),
            path_bytes: AtomicUsize::new(0),
            links: Mutex::new(HashSet::new()),
            dirs: Mutex::new(HashSet::new()),
        };
        assert_eq!(
            price_sizing_inode(&meta, &ctx, || dir.path().to_owned()).bytes,
            0
        );
        ctx.exact = true;
        assert_eq!(
            price_sizing_inode(&meta, &ctx, || dir.path().to_owned()).bytes,
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn sizing_dedup_cap_overcounts_but_stays_incomplete() {
        // Past the per-job dedup cap a hardlinked file counts again - the
        // estimate becomes an honest upper bound instead of a dead scan.
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let source = dir.path().join("source");
        fs::write(&source, vec![0u8; 64]).unwrap_or_else(|err| panic!("write failed: {err}"));
        fs::hard_link(&source, dir.path().join("copy"))
            .unwrap_or_else(|err| panic!("link failed: {err}"));
        // The root directory and one inode fill the shared cap=2, so both
        // links count and the result is a flagged upper bound, not a dead scan.
        let other = dir.path().join("other");
        fs::write(&other, vec![0u8; 64]).unwrap_or_else(|err| panic!("write failed: {err}"));
        fs::hard_link(&other, dir.path().join("other2"))
            .unwrap_or_else(|err| panic!("link failed: {err}"));
        let budget = ResourceBudget::new(ScanLimits {
            max_identities: 2,
            ..ScanLimits::default()
        });
        let size = measure_size_with_budget(
            Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("path not UTF-8")),
            false,
            &budget,
        );
        assert_eq!(size.bytes, 192); // source once; other+other2 overcounted
        assert!(!size.complete);
        assert!(budget.sizing_identity());
        assert!(budget.sizing_identity());
        assert!(!budget.sizing_identity());
        budget.release_sizing_identities(2);
        // And critically: the shared budget was never tripped by sizing.
        assert!(!budget.failed());
    }

    #[cfg(unix)]
    #[test]
    fn parallel_sizing_deduplicates_links_across_directory_batches() {
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let source = dir.path().join("source");
        fs::write(&source, vec![0u8; 100]).unwrap_or_else(|err| panic!("write failed: {err}"));
        for i in 0..140 {
            let child = dir.path().join(format!("child-{i}"));
            fs::create_dir(&child).unwrap_or_else(|err| panic!("mkdir failed: {err}"));
            fs::hard_link(&source, child.join("shared"))
                .unwrap_or_else(|err| panic!("link failed: {err}"));
            fs::write(child.join("unique"), b"abc")
                .unwrap_or_else(|err| panic!("write failed: {err}"));
        }
        let root =
            Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("fixture path not UTF-8"));
        assert_eq!(
            apparent_size(root),
            SubtreeSize {
                bytes: 520,
                complete: true
            }
        );
        // Exact mode intentionally counts each regular file path, matching JS.
        assert_eq!(
            exact_size(root),
            SubtreeSize {
                bytes: 14520,
                complete: true
            }
        );
    }

    #[test]
    fn sizing_handles_deep_subtrees_and_non_utf8_files() {
        let dir = tempdir().unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
        let root =
            Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("fixture path not UTF-8"));
        let mut path = dir.path().to_path_buf();
        for _ in 0..300 {
            path.push("d");
            fs::create_dir(&path).unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
            fs::write(path.join("file"), b"abc")
                .unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
        }
        assert_eq!(
            exact_size(root),
            SubtreeSize {
                bytes: 900,
                complete: true
            }
        );
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::ffi::OsStrExt;
            fs::write(path.join(std::ffi::OsStr::from_bytes(b"\xff")), b"abcd")
                .unwrap_or_else(|err| panic!("fixture operation failed: {err}"));
            assert_eq!(exact_size(root).bytes, 904);
        }
    }

    /// `du -sb` semantics: files and symlinks count their own `lstat` size,
    /// directories contribute only their children, links are never followed.
    #[cfg(target_os = "linux")]
    #[test]
    fn apparent_size_matches_du_sb() {
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let tree = root.join("node_modules");
        fs::create_dir_all(tree.join("nested/deep").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::write(tree.join("a.bin").as_std_path(), vec![0u8; 4096])
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        fs::write(tree.join("nested/b.bin").as_std_path(), vec![0u8; 17])
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        std::os::unix::fs::symlink("a.bin", tree.join("link").as_std_path())
            .unwrap_or_else(|err| panic!("symlink failed: {err}"));

        let output = std::process::Command::new("du")
            .arg("-sb")
            .arg("--")
            .arg(tree.as_str())
            .output()
            .unwrap_or_else(|err| panic!("du failed: {err}"));
        let du_bytes: u64 = String::from_utf8_lossy(&output.stdout)
            .split('\t')
            .next()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or_else(|| panic!("could not parse du output"));

        let size = apparent_size(&tree);
        assert_eq!(size.bytes, du_bytes);
        assert!(size.complete);
    }

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

    // Paths that cannot be represented by the UTF-8 wire contract make the
    // containing directory incomplete; they never become lossy path aliases.
    #[cfg(target_os = "linux")]
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
        assert_eq!(size.bytes, 5 + 7);
        assert!(size.complete);
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
            assert!(map[artifact.as_str()].complete);
        }
    }

    /// An unreadable subtree must not pretend to be fully priced: partial
    /// bytes stay, `complete` flips false, and the wire field follows it.
    #[test]
    #[cfg(unix)]
    fn unreadable_subtree_marks_size_incomplete() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let artifact = root.join("node_modules");
        let locked = artifact.join("locked");
        fs::create_dir_all(locked.as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::write(artifact.join("ok.bin").as_std_path(), vec![0u8; 100])
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        fs::write(locked.join("hidden.bin").as_std_path(), vec![0u8; 50])
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        fs::set_permissions(locked.as_std_path(), fs::Permissions::from_mode(0o000))
            .unwrap_or_else(|err| panic!("chmod failed: {err}"));

        // Root and ACL-less filesystems read right past the lock - there is
        // nothing deterministic to assert when the platform ignores it.
        if fs::read_dir(locked.as_std_path()).is_err() {
            let apparent = apparent_size(&artifact);
            let exact = exact_size(&artifact);
            fs::set_permissions(locked.as_std_path(), fs::Permissions::from_mode(0o700))
                .unwrap_or_else(|err| panic!("restore chmod failed: {err}"));

            assert!(!apparent.complete);
            assert!(!exact.complete);
            assert_eq!(apparent.bytes, 100);
            assert_eq!(exact.bytes, 100);
        } else {
            fs::set_permissions(locked.as_std_path(), fs::Permissions::from_mode(0o700))
                .unwrap_or_else(|err| panic!("restore chmod failed: {err}"));
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
    fn apparent_size_dedups_hardlinks() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let artifact = root.join("node_modules");
        fs::create_dir_all(artifact.join("nested").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::write(artifact.join("original.bin").as_std_path(), vec![0u8; 4096])
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        // pnpm-style: the same inode linked twice inside one subtree. `du -sb`
        // counts it once; so do we.
        fs::hard_link(
            artifact.join("original.bin").as_std_path(),
            artifact.join("nested/link.bin").as_std_path(),
        )
        .unwrap_or_else(|err| panic!("hardlink failed: {err}"));

        assert_eq!(apparent_size(&artifact).bytes, 4096);
        // Exact mode matches JS `exactSize`: statSync per file, no dedup.
        assert_eq!(exact_size(&artifact).bytes, 4096 * 2);
    }

    #[test]
    fn glob_match_is_linear_under_pathological_patterns() {
        // Audit A01: a pattern of many stars against a long non-matching name
        // must finish bounded - the old regexes could backtrack hard here.
        let pattern = "*a".repeat(64) + "*b";
        let name = "a".repeat(200);
        let start = std::time::Instant::now();
        let result = glob_match(&pattern, &name);
        assert!(
            start.elapsed() < std::time::Duration::from_millis(100),
            "pathological glob took {:?}",
            start.elapsed()
        );
        assert!(!result);
    }

    #[test]
    fn unicode_case_folding_matches_the_js_policy() {
        let matcher = PatternMatcher::compile_with_case(&["Ä*".to_owned(), "ΟΣ".to_owned()], true);
        assert!(matcher.matches("ä-cache"));
        assert!(matcher.matches("ος"));
        assert!(glob_match("?", "🦊"));
        assert!(!glob_match("??", "🦊"));
    }

    #[test]
    fn glob_match_semantics() {
        assert!(glob_match("dist*", "dist"));
        assert!(glob_match("dist*", "dist-esm"));
        assert!(glob_match("*.map", "app.js.map"));
        assert!(glob_match("?", "x"));
        assert!(glob_match("*", "anything/with/slashes"));
        assert!(!glob_match("?", ""));
        assert!(!glob_match("?", "xy"));
        assert!(!glob_match("dist", "dist2"));
        assert!(!glob_match("*.map", "app.map.js"));
        assert!(glob_match("", ""));
        assert!(glob_match("a*c*e", "abXcdYe"));
        assert!(!glob_match("a*c*e", "abXcdYef"));
        assert!(!glob_match("a*c*e", "abXcdYfx"));
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
    fn directory_iterator_errors_are_reported_once() {
        let dir = tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("path encoding"));
        let config = WalkConfig::default();
        let matcher = PatternMatcher::compile(&config.patterns);
        let skipped = AtomicU32::new(0);
        let ctx = WalkCtx {
            root,
            config: &config,
            matcher: &matcher,
            ignore: None,
            hooks: None,
            scanned: None,
            skipped: Some(&skipped),
            visited: None,
            budget: &ResourceBudget::default(),
        };
        let errors = (0..3).map(|_| Err(std::io::Error::other("injected iterator error")));
        let (result, jobs) = scan_dir_entries(&ctx, root, 0, errors);
        assert_eq!(result.skipped_dirs, 1);
        assert_eq!(skipped.load(Ordering::Relaxed), 1);
        assert!(jobs.is_empty());
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
        let visited = VisitedDirs::new();
        let ctx = WalkCtx {
            root,
            config: &ctx_config,
            matcher: &PatternMatcher::compile(&ctx_config.patterns),
            ignore: None,
            hooks: None,
            scanned: None,
            skipped: None,
            visited: Some(&visited),
            budget: &ResourceBudget::default(),
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
