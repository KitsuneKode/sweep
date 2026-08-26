//! Filesystem traversal helpers for the sweep engine.

use camino::{Utf8Path, Utf8PathBuf};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Maximum paths passed to a single `du` invocation (aligned with JS `DU_CHUNK_SIZE`).
pub const DU_CHUNK_SIZE: usize = 50;
/// Stay well under ARG_MAX even with deep monorepo paths (aligned with JS `DU_ARGV_BUDGET`).
pub const DU_ARGV_BUDGET: usize = 96 * 1024;

/// Describes a filesystem entry discovered during a scan walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkEntry {
    pub path: Utf8PathBuf,
    pub name: String,
    pub is_symlink: bool,
    pub entry_type: WalkEntryType,
    pub estimated_bytes: u64,
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
pub fn default_patterns() -> Vec<String> {
    vec![
        "node_modules".to_owned(),
        "dist".to_owned(),
        "build".to_owned(),
        "out".to_owned(),
        ".next".to_owned(),
        ".turbo".to_owned(),
        ".parcel-cache".to_owned(),
        ".nuxt".to_owned(),
        ".svelte-kit".to_owned(),
        "target".to_owned(),
        "coverage".to_owned(),
        ".nyc_output".to_owned(),
        ".vite".to_owned(),
        "*.tsbuildinfo".to_owned(),
    ]
}

/// Result of a scan walk before size estimation.
#[derive(Debug, Clone, Default)]
pub struct WalkResult {
    pub entries: Vec<WalkEntry>,
    pub scanned_dirs: u32,
}

const SKIP_DIR_NAMES: &[&str] = &[".git", ".svn", ".hg", ".bzr"];

/// Recursively walk `root`, collecting entries whose names match `config.patterns`.
///
/// Matched directories are not descended into (same semantics as the JS scanner).
/// Sibling subtrees are walked in parallel via rayon.
pub fn walk_matched_entries(root: &Utf8Path, config: &WalkConfig) -> WalkResult {
    let matcher = PatternMatcher::compile(&config.patterns);
    walk_dir(root, root, 0, config, &matcher)
}

fn walk_dir(
    root: &Utf8Path,
    dir: &Utf8Path,
    depth: i32,
    config: &WalkConfig,
    matcher: &PatternMatcher,
) -> WalkResult {
    if config.depth != -1 && depth > config.depth {
        return WalkResult::default();
    }

    let read_dir = match fs::read_dir(dir.as_std_path()) {
        Ok(items) => items,
        Err(_) => return WalkResult::default(),
    };

    let mut result = WalkResult {
        scanned_dirs: 1,
        ..WalkResult::default()
    };
    let mut subdirs: Vec<Utf8PathBuf> = Vec::new();

    for item in read_dir.flatten() {
        let file_name = match item.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };

        let full_path = dir.join(&file_name);
        if should_ignore(root, &full_path, &file_name, &config.ignore) {
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

        if matcher.matches(&file_name) {
            let entry_type = if is_symlink {
                WalkEntryType::Symlink
            } else if is_dir {
                WalkEntryType::Directory
            } else {
                WalkEntryType::File
            };

            result.entries.push(WalkEntry {
                path: full_path,
                name: file_name,
                is_symlink,
                entry_type,
                estimated_bytes: 0,
            });
            continue;
        }

        if is_dir {
            if SKIP_DIR_NAMES.contains(&file_name.as_str()) {
                continue;
            }
            subdirs.push(full_path);
        } else if !is_file && !is_symlink {
            if let Ok(meta) = fs::symlink_metadata(full_path.as_std_path()) {
                if meta.is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    if SKIP_DIR_NAMES.contains(&file_name.as_str()) {
                        continue;
                    }
                    subdirs.push(full_path);
                }
            }
        }
    }

    let child_results: Vec<WalkResult> = subdirs
        .par_iter()
        .map(|subdir| walk_dir(root, subdir, depth + 1, config, matcher))
        .collect();

    for child in child_results {
        result.entries.extend(child.entries);
        result.scanned_dirs += child.scanned_dirs;
    }

    result
}

fn should_ignore(
    root: &Utf8Path,
    full_path: &Utf8Path,
    entry_name: &str,
    ignore: &[String],
) -> bool {
    let rel = full_path
        .strip_prefix(root)
        .map(|p| p.as_str())
        .unwrap_or(full_path.as_str());

    for pattern in ignore {
        let pattern = pattern.trim_end_matches('/');
        if pattern.contains('/') {
            if rel == pattern || rel.starts_with(&format!("{pattern}/")) {
                return true;
            }
        } else if entry_name == pattern {
            return true;
        }
    }
    false
}

struct PatternMatcher {
    exact: std::collections::HashSet<String>,
    globs: Vec<regex_lite::Regex>,
}

impl PatternMatcher {
    fn compile(patterns: &[String]) -> Self {
        let mut exact = std::collections::HashSet::new();
        let mut globs = Vec::new();

        for pattern in patterns {
            if pattern.contains('*') {
                let escaped = regex_lite::escape(pattern);
                let regex_pattern = format!("^{}$", escaped.replace("\\*", ".*"));
                if let Ok(re) = regex_lite::Regex::new(&regex_pattern) {
                    globs.push(re);
                }
            } else {
                exact.insert(pattern.clone());
            }
        }

        Self { exact, globs }
    }

    fn matches(&self, name: &str) -> bool {
        if self.exact.contains(name) {
            return true;
        }
        self.globs.iter().any(|re| re.is_match(name))
    }
}

/// Tree-aware byte estimate aligned with the JS scanner (`du` fast path + walk fallback).
pub fn estimate_bytes(path: &Utf8Path) -> u64 {
    batch_estimate_bytes(&[path])
        .get(path.as_str())
        .copied()
        .unwrap_or_else(|| stat_fallback(path))
}

/// Batch `du` estimates for many paths (single subprocess per chunk of 50).
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

    for chunk in chunk_paths_for_du(paths) {
        let Some(chunk_map) = du_estimate_chunk(flag, multiplier, chunk) else {
            continue;
        };
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
    fs::metadata(path.as_std_path())
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn is_reparse_point_or_symlink(entry_path: &Utf8Path) -> bool {
    let meta = match fs::symlink_metadata(entry_path.as_std_path()) {
        Ok(meta) => meta,
        Err(_) => return false,
    };

    if meta.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    if meta.is_dir() {
        if let Ok(real) = std::fs::canonicalize(entry_path.as_std_path()) {
            let resolved = normalize_path_buf(entry_path.as_std_path());
            return normalize_path_buf(&real) != resolved;
        }
    }

    false
}

#[cfg(windows)]
fn normalize_path_buf(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut normalized = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn walk_size(path: &Utf8Path) -> u64 {
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
}
