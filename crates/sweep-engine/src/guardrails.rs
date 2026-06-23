//! Scan-path guardrails aligned with the TypeScript reference (`guardrails.ts`).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use sweep_errors::{EngineError, GuardrailError};

const PROTECTED_VCS_DIR_NAMES: &[&str] = &[".git", ".svn", ".hg", ".bzr"];

/// Assert that the target directory is safe to operate on.
pub fn assert_safe_cwd(target_path: &str) -> Result<(), EngineError> {
    if target_path.contains('\0') {
        return Err(GuardrailError::ProtectedPath {
            path: target_path.to_owned(),
        }
        .into());
    }

    if target_path.contains("..") {
        return Err(GuardrailError::ProtectedPath {
            path: format!("Path traversal detected: {target_path}"),
        }
        .into());
    }

    let resolved = normalize_path(target_path);

    if blocked_roots().contains(&resolved) {
        return Err(GuardrailError::ProtectedPath {
            path: format!(
                "Refusing to operate on protected path: {}\n  \
                 sweep must be run inside a project directory, not at a system root.",
                resolved.display()
            ),
        }
        .into());
    }

    let root = filesystem_root(&resolved);
    let relative_parts = path_segments_below_root(&resolved, &root);
    if relative_parts.len() < 2 {
        return Err(GuardrailError::ProtectedPath {
            path: format!(
                "Path is too shallow to be a project directory: {}\n  \
                 Expected at least 2 path segments below filesystem root.",
                resolved.display()
            ),
        }
        .into());
    }

    Ok(())
}

/// Assert that a pattern string is safe (won't escape the target directory).
pub fn assert_safe_pattern(pattern: &str) -> Result<(), EngineError> {
    if pattern.trim().is_empty() {
        return Err(GuardrailError::ProtectedPath {
            path: "Pattern must not be empty.".to_owned(),
        }
        .into());
    }

    if pattern != pattern.trim() {
        return Err(GuardrailError::ProtectedPath {
            path: format!("Pattern must not have leading or trailing whitespace: \"{pattern}\""),
        }
        .into());
    }

    if pattern.contains('\0') {
        return Err(GuardrailError::ProtectedPath {
            path: format!("Pattern contains null byte: {pattern:?}"),
        }
        .into());
    }

    if pattern.starts_with('/') {
        return Err(GuardrailError::ProtectedPath {
            path: format!(
                "Patterns must not start with /: \"{pattern}\"\n  \
                 Use directory names or glob patterns like \"*.tsbuildinfo\"."
            ),
        }
        .into());
    }

    if pattern.contains("..") {
        return Err(GuardrailError::ProtectedPath {
            path: format!("Patterns must not contain \"..\" traversal: \"{pattern}\""),
        }
        .into());
    }

    Ok(())
}

/// Validate all pattern strings in a sweep config before scanning.
pub fn assert_safe_config_patterns(config: &sweep_types::SweepConfig) -> Result<(), EngineError> {
    for pattern in &config.patterns {
        assert_safe_pattern(pattern)?;
    }
    for pattern in &config.disabled_patterns {
        assert_safe_pattern(pattern)?;
    }
    for pattern in &config.ignore {
        assert_safe_pattern(pattern)?;
    }
    Ok(())
}

fn blocked_roots() -> HashSet<PathBuf> {
    let mut roots = HashSet::from([
        PathBuf::from("/"),
        PathBuf::from("/home"),
        PathBuf::from("/usr"),
        PathBuf::from("/usr/local"),
        PathBuf::from("/etc"),
        PathBuf::from("/opt"),
        PathBuf::from("/var"),
        PathBuf::from("/bin"),
        PathBuf::from("/sbin"),
        PathBuf::from("/lib"),
        PathBuf::from("/lib64"),
        PathBuf::from("/boot"),
        PathBuf::from("/sys"),
        PathBuf::from("/proc"),
        PathBuf::from("/dev"),
    ]);

    if let Some(home) = home_dir() {
        roots.insert(home);
    }

    #[cfg(windows)]
    {
        for drive in b'A'..=b'Z' {
            let letter = drive as char;
            let root = format!("{letter}:\\");
            roots.insert(PathBuf::from(&root));
            roots.insert(PathBuf::from(format!("{root}Windows")));
            roots.insert(PathBuf::from(format!("{root}Program Files")));
            roots.insert(PathBuf::from(format!("{root}Program Files (x86)")));
            roots.insert(PathBuf::from(format!("{root}Users")));
            roots.insert(PathBuf::from(format!("{root}ProgramData")));
        }
    }

    roots
}

fn home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    #[cfg(windows)]
    {
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            if !userprofile.is_empty() {
                return Some(PathBuf::from(userprofile));
            }
        }
    }
    None
}

fn normalize_path(path: &str) -> PathBuf {
    let path = Path::new(path);
    let mut normalized = PathBuf::new();
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

fn filesystem_root(path: &Path) -> PathBuf {
    if cfg!(windows) {
        path.components()
            .next()
            .map(|component| PathBuf::from(component.as_os_str()))
            .unwrap_or_else(|| PathBuf::from("/"))
    } else {
        PathBuf::from("/")
    }
}

fn path_segments_below_root(resolved: &Path, parsed_root: &Path) -> Vec<String> {
    resolved
        .strip_prefix(parsed_root)
        .unwrap_or(resolved)
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

/// Whether any path segment is a protected VCS metadata directory.
pub fn path_has_protected_vcs_segment(entry_path: &str) -> bool {
    entry_path
        .split(['/', '\\'])
        .any(|segment| PROTECTED_VCS_DIR_NAMES.contains(&segment))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assert_safe_cwd_rejects_root() {
        match assert_safe_cwd("/") {
            Err(EngineError::Guardrail(_)) => {}
            other => panic!("expected guardrail error, got {other:?}"),
        }
    }

    #[test]
    fn assert_safe_cwd_rejects_shallow_tmp() {
        match assert_safe_cwd("/tmp") {
            Err(EngineError::Guardrail(_)) => {}
            other => panic!("expected guardrail error, got {other:?}"),
        }
    }

    #[test]
    fn assert_safe_cwd_allows_project_path() {
        assert!(assert_safe_cwd("/tmp/user/project").is_ok());
    }

    #[test]
    fn assert_safe_pattern_rejects_absolute_paths() {
        match assert_safe_pattern("/etc") {
            Err(EngineError::Guardrail(_)) => {}
            other => panic!("expected guardrail error, got {other:?}"),
        }
    }
}
