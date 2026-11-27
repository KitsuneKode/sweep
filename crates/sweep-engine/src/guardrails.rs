//! Scan-path guardrails aligned with the TypeScript reference (`guardrails.ts`).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use sweep_errors::{EngineError, GuardrailError};

const PROTECTED_VCS_DIR_NAMES: &[&str] = &[
    ".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "_darcs", ".pijul",
];

/// Names that identify or configure a project, never build output. A pattern -
/// including one from an untrusted repository's `.sweeprc` - can match them,
/// but they classify as blocked so no policy or flag can select them.
/// TS parity: `PROTECTED_PROJECT_NAMES` in `guardrails.ts`.
const PROTECTED_PROJECT_NAMES: &[&str] = &[
    "src",
    ".sweeprc",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "bun.lock",
    "bun.lockb",
    "deno.json",
    "deno.jsonc",
    "deno.lock",
    "cargo.toml",
    "cargo.lock",
    "go.mod",
    "go.sum",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "pipfile",
    "pipfile.lock",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "gemfile",
    "gemfile.lock",
    "composer.json",
    "composer.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "mix.exs",
    "mix.lock",
    "pubspec.yaml",
    "pubspec.lock",
    "package.swift",
];

/// Fresh identities catch canonical system aliases and same-device bind
/// aliases. Mounts may change during a long UI session, so do not cache these.
fn aliases_protected_root(resolved: &Path, roots: &HashSet<PathBuf>) -> bool {
    let Ok(target_path) = std::fs::canonicalize(resolved) else {
        return false;
    };
    let Ok(target_meta) = std::fs::metadata(&target_path) else {
        return false;
    };
    let Ok(Some(target_id)) = sweep_fs::file_identity(&target_path, &target_meta) else {
        return false;
    };
    roots.iter().any(|root| {
        let Ok(path) = std::fs::canonicalize(root) else {
            return false;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            return false;
        };
        let Ok(Some(id)) = sweep_fs::file_identity(&path, &meta) else {
            return false;
        };
        target_id.device == id.device && target_id.inode == id.inode
    })
}

/// Blocked-root + depth policy on one normalized absolute path.
fn assert_resolved_safe(resolved: &Path) -> Result<(), EngineError> {
    let roots = blocked_roots();
    let is_blocked = if roots.contains(resolved) {
        true
    } else if cfg!(windows) || cfg!(target_os = "macos") {
        // Case-insensitive filesystems make /USERS/name the same directory as
        // /Users/name - fold both sides or the case-variant walks past.
        let folded = resolved.to_string_lossy().to_lowercase();
        roots
            .iter()
            .any(|root| root.to_string_lossy().to_lowercase() == folded)
    } else {
        false
    };

    if is_blocked
        || is_prefix_blocked(resolved)
        || path_has_protected_vcs_segment(&resolved.to_string_lossy())
        || aliases_protected_root(resolved, &roots)
    {
        return Err(GuardrailError::ProtectedPath {
            path: format!(
                "Refusing to operate on protected path: {}\n  \
                 sweep must be run inside a project directory, not at a system root.",
                resolved.display()
            ),
        }
        .into());
    }

    let root = filesystem_root(resolved);
    let relative_parts = path_segments_below_root(resolved, &root);
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

/// Assert that the target directory is safe to operate on.
pub fn assert_safe_cwd(target_path: &str) -> Result<(), EngineError> {
    if target_path.contains('\0') {
        return Err(GuardrailError::ProtectedPath {
            path: target_path.to_owned(),
        }
        .into());
    }

    // Strip Windows verbatim prefixes (`\\?\`, `\\?\UNC\`) before lexical
    // normalization so verbatim spellings are judged identically to normal
    // paths.
    let cleaned = strip_verbatim_str(target_path);

    // `..` is not rejected here: normalization collapses it first, then the
    // blocked-root and depth checks judge the result - same order as the JS
    // `resolve()` path, so `scan foo/../bar` behaves identically on both.
    // Relative input is absolutized against cwd first - otherwise
    // `sweep-engine apply` with a relative targetDir would check a fragment
    // against absolute blocked roots and silently pass.
    let resolved = if Path::new(&cleaned).is_absolute() {
        normalize_path(&cleaned)
    } else {
        normalize_path(
            &std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("/"))
                .join(&cleaned)
                .to_string_lossy(),
        )
    };

    assert_resolved_safe(&resolved)?;

    // A symlinked spelling can launder a forbidden root: `x -> /` passes the
    // lexical checks while scanning `/`. When the target exists, run the same
    // checks on the canonical path too (verbatim `\\?\` prefix stripped so it
    // compares like the lexical spelling).
    if let Ok(canonical_raw) = std::fs::canonicalize(&resolved) {
        let canonical = normalize_path(&strip_verbatim_str(&canonical_raw.to_string_lossy()));
        let same = if cfg!(windows) || cfg!(target_os = "macos") {
            canonical.to_string_lossy().to_lowercase() == resolved.to_string_lossy().to_lowercase()
        } else {
            canonical == resolved
        };
        if !same {
            assert_resolved_safe(&canonical)?;
        }
    }

    Ok(())
}

/// Drop Windows verbatim prefixes (`\\?\` and `\\?\UNC\`, including `/`
/// variants) so lexical and canonical paths compare consistently against
/// blocked roots and prefixes. JS parity: `stripWindowsVerbatimPrefix`.
fn strip_verbatim_str_for(input: &str, is_windows: bool) -> String {
    if !is_windows {
        return input.to_owned();
    }
    let bytes = input.as_bytes();
    if bytes.len() >= 4
        && (bytes[0] == b'\\' || bytes[0] == b'/')
        && (bytes[1] == b'\\' || bytes[1] == b'/')
        && bytes[2] == b'?'
        && (bytes[3] == b'\\' || bytes[3] == b'/')
    {
        let rest = &input[4..];
        if rest.len() >= 4
            && rest.as_bytes()[..3].eq_ignore_ascii_case(b"unc")
            && (rest.as_bytes()[3] == b'\\' || rest.as_bytes()[3] == b'/')
        {
            return format!("\\\\{}", &rest[4..]);
        }
        return rest.to_owned();
    }
    input.to_owned()
}

pub(crate) fn strip_verbatim_str(input: &str) -> String {
    strip_verbatim_str_for(input, cfg!(windows))
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

    // Patterns are filenames, not essays - same bound as the JS side
    // (`MAX_PATTERN_LENGTH` in guardrails.ts): <=128 code points and <=256
    // UTF-16 units. `pattern.len()` would count UTF-8 bytes and reject ~70
    // CJK chars the JS engine accepts.
    if pattern.chars().count() > 128 || pattern.encode_utf16().count() > 256 {
        return Err(GuardrailError::ProtectedPath {
            path: format!(
                "Pattern exceeds 128 characters: \"{}…\"",
                pattern.chars().take(64).collect::<String>()
            ),
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

/// macOS system trees two segments deep. JS parity: `DARWIN_SYSTEM_ROOTS`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const DARWIN_SYSTEM_ROOTS: &[&str] = &[
    "/private/etc",
    "/private/var",
    "/private/tmp",
    "/System/Library",
    "/System/Applications",
    "/System/Volumes",
    "/Library/Caches",
    "/Library/Application Support",
    "/Library/Developer",
    "/Library/Frameworks",
    "/Users/Shared",
    "/opt/homebrew",
];

/// Unix OS trees whose entire subtrees are refused as scan targets.
/// `/usr` and `/var` stay exact-match in `blocked_roots` so `/var/www`,
/// `/var/tmp`, macOS `/var/folders`, and `/usr/local/...` stay usable.
/// JS parity: `UNIX_PREFIX_BLOCKED_ROOTS` in `guardrails.ts`.
#[cfg_attr(windows, allow(dead_code))]
const UNIX_PREFIX_BLOCKED_ROOTS: &[&str] = &[
    "/etc", "/sys", "/proc", "/dev", "/boot", "/bin", "/sbin", "/lib", "/lib64", "/run",
];

fn prefix_blocked_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .map(|drive| PathBuf::from(format!("{}:\\Windows", drive as char)))
            .collect()
    }
    #[cfg(not(windows))]
    {
        #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
        let mut roots: Vec<PathBuf> = UNIX_PREFIX_BLOCKED_ROOTS
            .iter()
            .map(PathBuf::from)
            .collect();
        #[cfg(target_os = "macos")]
        roots.push(PathBuf::from("/private/etc"));
        roots
    }
}

fn is_prefix_blocked(resolved: &Path) -> bool {
    let prefixes = prefix_blocked_roots();
    if cfg!(windows) || cfg!(target_os = "macos") {
        let sep = std::path::MAIN_SEPARATOR;
        let candidate = resolved.to_string_lossy().to_lowercase();
        prefixes.iter().any(|prefix| {
            let p = prefix.to_string_lossy().to_lowercase();
            candidate == p || candidate.starts_with(&format!("{p}{sep}"))
        })
    } else {
        prefixes.iter().any(|prefix| resolved.starts_with(prefix))
    }
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
        PathBuf::from("/run"),
        PathBuf::from("/tmp"),
    ]);

    if let Some(home) = home_dir() {
        roots.insert(home);
    }

    // One-segment roots (/System, /Library, /private, /Users) already fail the
    // depth rule; these two-segment system trees would otherwise pass it.
    #[cfg(target_os = "macos")]
    roots.extend(DARWIN_SYSTEM_ROOTS.iter().map(PathBuf::from));

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
            // MSYS/Git-for-Windows layouts put real system trees here.
            roots.insert(PathBuf::from(format!("{root}usr")));
            roots.insert(PathBuf::from(format!("{root}usr\\local")));
            roots.insert(PathBuf::from(format!("{root}etc")));
        }
    }

    roots
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    // std::env::home_dir mirrors os.homedir(): env vars first, then the
    // passwd/registry fallback - so $HOME-unset scans still get home-dir
    // protection. JS parity.
    std::env::home_dir()
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
/// Case-insensitive on macOS/Windows filesystems, matching the JS engine -
/// `.GIT` is the same directory as `.git` there.
pub fn path_has_protected_vcs_segment(entry_path: &str) -> bool {
    let case_insensitive = cfg!(windows) || cfg!(target_os = "macos");
    entry_path.split(['/', '\\']).any(|segment| {
        if case_insensitive {
            let lower = segment.to_ascii_lowercase();
            PROTECTED_VCS_DIR_NAMES.contains(&lower.as_str())
        } else {
            PROTECTED_VCS_DIR_NAMES.contains(&segment)
        }
    })
}

/// Whether an entry name is a protected project file (manifest, lockfile,
/// `.sweeprc`, `src`) or an env file (`.env`, `.env.local`, ...). Compared
/// case-insensitively everywhere: `Cargo.toml` and `cargo.toml` are both
/// authored files on every platform.
pub fn is_protected_project_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || PROTECTED_PROJECT_NAMES.contains(&lower.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_identity_files_are_protected() {
        for name in [
            "src",
            "package.json",
            "Cargo.toml",
            ".env",
            ".env.local",
            ".sweeprc",
            "go.mod",
        ] {
            assert!(is_protected_project_name(name), "{name}");
        }
        for name in [
            "node_modules",
            "target",
            ".next",
            "dist",
            "environment",
            ".envrc-cache",
        ] {
            assert!(!is_protected_project_name(name), "{name}");
        }
    }

    #[test]
    fn assert_safe_cwd_rejects_root() {
        match assert_safe_cwd("/") {
            Err(EngineError::Guardrail(_)) => {}
            other => panic!("expected guardrail error, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn canonical_system_aliases_are_protected() -> std::io::Result<()> {
        for root in ["/bin", "/etc", "/var", "/tmp"] {
            let canonical = std::fs::canonicalize(root)?;
            assert!(assert_safe_cwd(&canonical.to_string_lossy()).is_err());
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn two_segment_macos_system_trees_are_protected() {
        for root in DARWIN_SYSTEM_ROOTS {
            assert!(assert_safe_cwd(root).is_err(), "{root} should be refused");
        }
        assert!(assert_safe_cwd("/system/library").is_err());
        assert!(assert_safe_cwd("/private/etc/ssh").is_err());
        assert!(assert_safe_cwd("/ETC/ssh").is_err());
        assert!(assert_safe_cwd("/Users/Shared/projects/app").is_ok());
        assert!(assert_safe_cwd("/private/var/folders/xy/T/project").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn unix_os_subtrees_are_prefix_blocked_while_var_and_usr_stay_exact() {
        for path in [
            "/etc/systemd",
            "/etc/ssh",
            "/sys/class",
            "/proc/sys",
            "/dev/disk",
            "/boot/grub",
            "/bin/sub",
            "/sbin/sub",
            "/lib/x86_64-linux-gnu",
            "/lib64/sub",
            "/run/user/1000",
        ] {
            assert!(assert_safe_cwd(path).is_err(), "{path} should be refused");
        }
        assert!(assert_safe_cwd("/var/www/site").is_ok());
        assert!(assert_safe_cwd("/var/tmp/sweep-test/project").is_ok());
        assert!(assert_safe_cwd("/usr/local/src/project").is_ok());
        assert!(assert_safe_cwd("/etcetera/project").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_os_subtrees_and_verbatim_prefixes_are_refused() {
        for path in [
            r"C:\Windows\System32",
            r"C:\Windows\WinSxS",
            r"c:\windows\temp",
            r"D:\Windows\System32",
            r"\\?\C:\Windows",
            r"\\?\C:\Windows\System32",
            r"\\?\c:\windows\winsxs",
            r"\\?\C:\",
        ] {
            assert!(assert_safe_cwd(path).is_err(), "{path} should be refused");
        }
        assert!(assert_safe_cwd(r"C:\WindowsBackup\project").is_ok());
        assert!(assert_safe_cwd(r"\\?\C:\Projects\myapp").is_ok());
    }

    #[test]
    fn strip_verbatim_handles_windows_drive_and_unc_and_noop_on_posix() {
        assert_eq!(
            strip_verbatim_str_for(r"\\?\C:\Windows\System32", true),
            r"C:\Windows\System32"
        );
        assert_eq!(
            strip_verbatim_str_for("//?/C:/Windows/System32", true),
            "C:/Windows/System32"
        );
        assert_eq!(
            strip_verbatim_str_for(r"\\?\UNC\server\share\dir", true),
            r"\\server\share\dir"
        );
        assert_eq!(
            strip_verbatim_str_for(r"\\?\unc\server\share\dir", true),
            r"\\server\share\dir"
        );
        assert_eq!(
            strip_verbatim_str_for(r"\\?\C:\Windows", false),
            r"\\?\C:\Windows"
        );
    }

    #[test]
    fn vcs_target_segments_are_protected() {
        let target = std::env::temp_dir().join("sweep-project/.git/objects");
        assert!(assert_safe_cwd(&target.to_string_lossy()).is_err());
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
