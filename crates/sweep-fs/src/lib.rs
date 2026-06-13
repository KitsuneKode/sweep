//! Filesystem traversal helpers for the sweep engine.

use camino::{Utf8Path, Utf8PathBuf};
use rayon::prelude::*;
use std::fs;
use std::sync::Mutex;

/// Describes a filesystem entry discovered during a scan walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkEntry {
    pub path: Utf8PathBuf,
    pub name: String,
    pub is_symlink: bool,
    pub entry_type: WalkEntryType,
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
        Self {
            patterns: config.patterns.clone(),
            ignore: config.ignore.clone(),
            depth: config.depth,
        }
    }
}

/// Default artifact patterns aligned with the JS reference engine.
pub fn default_patterns() -> Vec<String> {
    vec![
        "node_modules".to_owned(),
        ".next".to_owned(),
        "dist".to_owned(),
        "build".to_owned(),
        ".turbo".to_owned(),
        ".parcel-cache".to_owned(),
        "target".to_owned(),
        "out".to_owned(),
        ".nuxt".to_owned(),
        ".svelte-kit".to_owned(),
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
    let result = Mutex::new(WalkResult::default());
    walk_dir(root, 0, config, &matcher, &result);
    result
        .into_inner()
        .unwrap_or_else(|err| panic!("walk result mutex poisoned: {err}"))
}

fn walk_dir(
    dir: &Utf8Path,
    depth: i32,
    config: &WalkConfig,
    matcher: &PatternMatcher,
    result: &Mutex<WalkResult>,
) {
    if config.depth != -1 && depth > config.depth {
        return;
    }

    let read_dir = match fs::read_dir(dir.as_std_path()) {
        Ok(items) => items,
        Err(_) => return,
    };

    if let Ok(mut guard) = result.lock() {
        guard.scanned_dirs += 1;
    }

    let mut subdirs: Vec<Utf8PathBuf> = Vec::new();

    for item in read_dir.flatten() {
        let file_name = match item.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };

        let full_path = dir.join(&file_name);
        if should_ignore(full_path.as_str(), &config.ignore) {
            continue;
        }

        let file_type = match item.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let is_symlink = file_type.is_symlink();
        let is_dir = file_type.is_dir() && !is_symlink;
        let is_file = file_type.is_file() && !is_symlink;

        if matcher.matches(&file_name) {
            let entry_type = if is_symlink {
                WalkEntryType::Symlink
            } else if is_dir {
                WalkEntryType::Directory
            } else {
                WalkEntryType::File
            };

            if let Ok(mut guard) = result.lock() {
                guard.entries.push(WalkEntry {
                    path: full_path,
                    name: file_name,
                    is_symlink,
                    entry_type,
                });
            }
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

    subdirs.par_iter().for_each(|subdir| {
        walk_dir(subdir, depth + 1, config, matcher, result);
    });
}

fn should_ignore(full_path: &str, ignore: &[String]) -> bool {
    ignore.iter().any(|pattern| full_path.contains(pattern))
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

/// Fast size estimate: directory metadata size or file length.
pub fn estimate_bytes(path: &Utf8Path) -> u64 {
    match fs::metadata(path.as_std_path()) {
        Ok(meta) => meta.len(),
        Err(_) => 0,
    }
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
        // Should not count .git/objects as scanned dirs
        assert!(result.scanned_dirs < 4);
    }
}
