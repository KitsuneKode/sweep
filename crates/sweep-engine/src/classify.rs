//! Risk tier and reasons for a walked entry. JS parity: `classifyEntry` in
//! `packages/core/src/planner.ts` and `packages/core/src/classification.ts`
//! apply the same rules in the same order with the same reason strings.

use std::path::Path;
use sweep_fs::{WalkEntry, WalkEntryType};
use sweep_types::RiskTier;

use crate::guardrails;

/// Non-blocking informational reason for candidates inside cloud-synced folders.
const CLOUD_SYNC_REASON: &str = "cloud-sync";

/// Home-relative toolchain, package-manager, editor, and desktop app trees.
const HOME_TOOL_DIRS: &[&[&str]] = &[
    &[".bun"],
    &[".cargo"],
    &[".rustup"],
    &[".npm"],
    &[".npm-global"],
    &[".nvm"],
    &[".nodenv"],
    &[".yarn"],
    &[".volta"],
    &[".fnm"],
    &[".deno"],
    &[".pnpm-store"],
    &[".mise"],
    &[".asdf"],
    &[".pyenv"],
    &[".poetry"],
    &[".conda"],
    &["miniconda3"],
    &["anaconda3"],
    &["miniforge3"],
    &["mambaforge"],
    &[".uv"],
    &[".pipx"],
    &[".rbenv"],
    &[".rvm"],
    &[".gem"],
    &["go", "pkg"],
    &[".sdkman"],
    &[".gradle"],
    &[".m2"],
    &[".composer"],
    &[".pub-cache"],
    &[".android"],
    &[".flutter"],
    &[".local"],
    &[".config"],
    &[".cache"],
    &[".var", "app"],
    &["snap"],
    &["scoop"],
    &[".vscode"],
    &[".vscode-insiders"],
    &[".vscode-oss"],
    &[".vscode-server"],
    &[".cursor"],
    &[".cursor-server"],
    &[".windsurf"],
    &[".windsurf-server"],
    &[".zed"],
    &[".claude"],
    &[".codex"],
    &[".gemini"],
    &[".t3", "userdata"],
    &["Applications"],
    &["Library"],
    &["AppData"],
];

/// Carve-outs inside tool dirs: OS temp space and agent worktrees host ordinary projects.
const HOME_TOOL_EXCEPTIONS: &[&[&str]] = &[&["AppData", "Local", "Temp"], &[".codex", "worktrees"]];

/// System install locations and OS trees matched across platforms (after
/// stripping a Windows drive letter, when present); `/var` is listed by
/// subdirectory because `/var/www` holds projects and macOS `/var/folders` is
/// the temp root.
const SYSTEM_TOOL_DIRS: &[&[&str]] = &[
    &["usr"],
    &["opt"],
    &["snap"],
    &["nix"],
    &["home", "linuxbrew", ".linuxbrew"],
    &["var", "lib"],
    &["var", "cache"],
    &["var", "opt"],
    &["var", "db"],
    &["private", "var", "db"],
    &["Applications"],
    &["System"],
    &["Library"],
    &["Windows"],
    &["Program Files"],
    &["Program Files (x86)"],
    &["ProgramData"],
];

/// Unix-only OS roots. Applied only to paths without a Windows drive letter or
/// UNC prefix so Windows project roots such as `C:\dev\...` or `D:\bin\...`
/// are not demoted as tool homes. `/run` is omitted so
/// `/run/media/<user>/<drive>` and `/run/user/<uid>/gvfs` stay cleanable.
const UNIX_SYSTEM_TOOL_DIRS: &[&[&str]] = &[
    &["etc"],
    &["private", "etc"],
    &["sys"],
    &["proc"],
    &["dev"],
    &["boot"],
    &["bin"],
    &["sbin"],
    &["lib"],
    &["lib64"],
];

/// Carve-outs inside `UNIX_SYSTEM_TOOL_DIRS` (e.g. Linux `/dev/shm` tmpfs).
const UNIX_SYSTEM_TOOL_EXCEPTIONS: &[&[&str]] = &[&["dev", "shm"]];

/// Home-relative cloud-synced folders. Candidates inside them stay at their
/// normal tier and selection, and carry the non-blocking `cloud-sync` reason.
const CLOUD_SYNC_HOME_DIRS: &[&[&str]] = &[
    &["Dropbox"],
    &["OneDrive"],
    &["Google Drive"],
    &["My Drive"],
    &["Library", "CloudStorage"],
];

/// Home-relative first-segment prefixes for org-named cloud-sync folders.
const CLOUD_SYNC_HOME_PREFIXES: &[&str] = &["OneDrive - "];

#[derive(Clone, Copy, PartialEq, Eq)]
enum PathPrefixKind {
    None,
    Drive,
    Unc,
}

fn fold_segment(segment: &str, case_fold: bool) -> String {
    if case_fold {
        segment.to_lowercase()
    } else {
        segment.to_owned()
    }
}

fn normalize_segments(rest: &str, split_backslash: bool, case_fold: bool) -> Vec<String> {
    let mut out = Vec::new();
    let iter: Box<dyn Iterator<Item = &str>> = if split_backslash {
        Box::new(rest.split(['/', '\\']))
    } else {
        Box::new(rest.split('/'))
    };
    for part in iter {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop();
            continue;
        }
        out.push(fold_segment(part, case_fold));
    }
    out
}

fn split_path_segments(
    path: &str,
    is_windows: bool,
    case_fold: bool,
) -> (Vec<String>, PathPrefixKind) {
    let cleaned = guardrails::strip_verbatim_str_for(path, is_windows);
    if is_windows {
        let bytes = cleaned.as_bytes();
        if bytes.len() >= 2
            && (bytes[0] == b'\\' || bytes[0] == b'/')
            && (bytes[1] == b'\\' || bytes[1] == b'/')
        {
            let rest = &cleaned[2..];
            let mut parts = rest.splitn(3, ['/', '\\']);
            if let (Some(server), Some(share)) = (parts.next(), parts.next()) {
                if !server.is_empty() && !share.is_empty() {
                    let prefix = fold_segment(&format!("\\\\{server}\\{share}"), case_fold);
                    let mut segments = vec![prefix];
                    if let Some(tail) = parts.next() {
                        segments.extend(normalize_segments(tail, true, case_fold));
                    }
                    return (segments, PathPrefixKind::Unc);
                }
            }
        }
        if bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes.len() == 2 || bytes[2] == b'\\' || bytes[2] == b'/')
        {
            let drive = fold_segment(&cleaned[..2], case_fold);
            let mut segments = vec![drive];
            if bytes.len() > 2 {
                segments.extend(normalize_segments(&cleaned[3..], true, case_fold));
            }
            return (segments, PathPrefixKind::Drive);
        }
        return (
            normalize_segments(&cleaned, true, case_fold),
            PathPrefixKind::None,
        );
    }
    (
        normalize_segments(&cleaned, false, case_fold),
        PathPrefixKind::None,
    )
}

fn starts_with_segments(segments: &[String], prefix: &[&str], case_fold: bool) -> bool {
    prefix.len() <= segments.len()
        && prefix
            .iter()
            .zip(segments)
            .all(|(part, segment)| fold_segment(part, case_fold) == *segment)
}

fn segments_below_home<'a>(
    segments: &'a [String],
    home: Option<&str>,
    is_windows: bool,
    case_fold: bool,
) -> Option<&'a [String]> {
    let home = home?;
    let (home_segments, home_prefix) = split_path_segments(home, is_windows, case_fold);
    let min_home_segments = if home_prefix == PathPrefixKind::None {
        1
    } else {
        2
    };
    if home_segments.len() < min_home_segments || !segments.starts_with(&home_segments) {
        return None;
    }
    Some(&segments[home_segments.len()..])
}

/// True when an ancestor directory of `path` is a macOS application bundle
/// (`*.app` with a `Contents/Info.plist` file). Ordinary project folders named
/// like `example.app` lack `Contents/Info.plist` and are not treated as bundles.
fn has_macos_app_bundle_ancestor(path: &Path) -> bool {
    for ancestor in path.ancestors().skip(1) {
        let Some(name) = ancestor.file_name() else {
            continue;
        };
        if name
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".app")
            && std::fs::metadata(ancestor.join("Contents").join("Info.plist"))
                .is_ok_and(|meta| meta.is_file())
        {
            return true;
        }
    }
    false
}

/// Platform-parameterized core of `is_inside_tool_home` so Windows drive/UNC
/// and POSIX rules can be verified deterministically on every host OS.
fn is_inside_tool_home_for(
    path: &str,
    home: Option<&str>,
    is_windows: bool,
    is_macos: bool,
) -> bool {
    let case_fold = is_windows || is_macos;
    let (segments, prefix_kind) = split_path_segments(path, is_windows, case_fold);

    match prefix_kind {
        PathPrefixKind::None => {
            if SYSTEM_TOOL_DIRS
                .iter()
                .any(|prefix| starts_with_segments(&segments, prefix, case_fold))
            {
                return true;
            }
            if !UNIX_SYSTEM_TOOL_EXCEPTIONS
                .iter()
                .any(|prefix| starts_with_segments(&segments, prefix, case_fold))
                && UNIX_SYSTEM_TOOL_DIRS
                    .iter()
                    .any(|prefix| starts_with_segments(&segments, prefix, case_fold))
            {
                return true;
            }
        }
        PathPrefixKind::Drive => {
            let rooted = &segments[1..];
            if SYSTEM_TOOL_DIRS
                .iter()
                .any(|prefix| starts_with_segments(rooted, prefix, case_fold))
            {
                return true;
            }
        }
        PathPrefixKind::Unc => {}
    }

    if let Some(below) = segments_below_home(&segments, home, is_windows, case_fold) {
        if !HOME_TOOL_EXCEPTIONS
            .iter()
            .any(|prefix| starts_with_segments(below, prefix, case_fold))
            && HOME_TOOL_DIRS
                .iter()
                .any(|prefix| starts_with_segments(below, prefix, case_fold))
        {
            return true;
        }
    }

    is_macos && has_macos_app_bundle_ancestor(Path::new(path))
}

/// True when `path` lies inside a toolchain, package-manager, editor or system
/// install tree, or (on macOS) inside a real `.app` bundle containing
/// `Contents/Info.plist`. A home with no segments disables the home rules.
pub(crate) fn is_inside_tool_home(path: &Path, home: Option<&Path>) -> bool {
    let path_str = path.to_string_lossy();
    let home_str = home.map(|p| p.to_string_lossy());
    is_inside_tool_home_for(
        &path_str,
        home_str.as_deref(),
        cfg!(windows),
        cfg!(target_os = "macos"),
    )
}

/// Platform-parameterized core of `is_inside_cloud_sync_dir`.
fn is_inside_cloud_sync_dir_for(
    path: &str,
    home: Option<&str>,
    is_windows: bool,
    is_macos: bool,
) -> bool {
    let case_fold = is_windows || is_macos;
    let (segments, _) = split_path_segments(path, is_windows, case_fold);
    let Some(below) = segments_below_home(&segments, home, is_windows, case_fold) else {
        return false;
    };
    if below.is_empty() {
        return false;
    }

    if CLOUD_SYNC_HOME_DIRS
        .iter()
        .any(|prefix| below.len() > prefix.len() && starts_with_segments(below, prefix, case_fold))
    {
        return true;
    }

    let first = &below[0];
    below.len() > 1
        && CLOUD_SYNC_HOME_PREFIXES.iter().any(|prefix| {
            let folded = fold_segment(prefix, case_fold);
            first.starts_with(&folded) && first.len() > folded.len()
        })
}

/// True when `path` lies inside a cloud-synced folder under `home` (`~/Dropbox`,
/// `~/OneDrive`, `~/OneDrive - <Org>`, `~/Google Drive`, `~/My Drive`, or
/// macOS `~/Library/CloudStorage/*`). Informational only.
pub(crate) fn is_inside_cloud_sync_dir(path: &Path, home: Option<&Path>) -> bool {
    let path_str = path.to_string_lossy();
    let home_str = home.map(|p| p.to_string_lossy());
    is_inside_cloud_sync_dir_for(
        &path_str,
        home_str.as_deref(),
        cfg!(windows),
        cfg!(target_os = "macos"),
    )
}

/// Inputs to classification, separated from `WalkEntry` so tests can supply
/// a home directory and marker result without touching the filesystem.
pub(crate) struct ClassifyInput<'a> {
    pub path: &'a str,
    pub name: &'a str,
    pub is_symlink: bool,
    pub entry_type: WalkEntryType,
    pub has_project_marker: bool,
}

pub(crate) fn classify_with_home(
    input: &ClassifyInput<'_>,
    home: Option<&Path>,
) -> (RiskTier, Vec<String>) {
    let mut reasons = Vec::new();
    let protected_vcs = guardrails::path_has_protected_vcs_segment(input.path);
    if protected_vcs {
        reasons.push("protected-vcs-path".to_owned());
    }
    let protected_project = guardrails::is_protected_project_name(input.name);
    if protected_project {
        reasons.push("protected-project-file".to_owned());
    }
    if input.is_symlink {
        reasons.push("symlink".to_owned());
    }
    let catalog = sweep_fs::catalog_match_for(input.name);
    reasons.push(
        match catalog {
            Some(sweep_fs::CatalogMatch::Default) => "default-pattern",
            Some(sweep_fs::CatalogMatch::OptIn) => "opt-in-pattern",
            None => "custom-pattern",
        }
        .to_owned(),
    );

    let tier = if protected_vcs || protected_project {
        RiskTier::Blocked
    } else if input.is_symlink {
        RiskTier::Caution
    } else if catalog != Some(sweep_fs::CatalogMatch::Default) {
        // Only names a shipping-default pattern covers can earn the safe tier.
        // Opt-in catalog names (dist, build, out, ...) can hold authored files.
        RiskTier::Dangerous
    } else {
        // A default name is still only presumed safe in context: right entry
        // type, outside tool/system install trees, and with a project marker
        // where the name is an ordinary word.
        let context = match sweep_fs::artifact_rule_for(input.name) {
            Some(rule) if rule.entry_type != input.entry_type => Some("entry-type-mismatch"),
            _ if is_inside_tool_home(Path::new(input.path), home) => Some("tool-home"),
            _ if !input.has_project_marker => Some("no-project-marker"),
            _ => None,
        };
        match context {
            Some(reason) => {
                reasons.push(reason.to_owned());
                RiskTier::Dangerous
            }
            None => RiskTier::Safe,
        }
    };

    if is_inside_cloud_sync_dir(Path::new(input.path), home) {
        reasons.push(CLOUD_SYNC_REASON.to_owned());
    }

    (tier, reasons)
}

pub(crate) fn classify(entry: &WalkEntry) -> (RiskTier, Vec<String>) {
    let input = ClassifyInput {
        path: entry.path.as_str(),
        name: &entry.name,
        is_symlink: entry.is_symlink,
        entry_type: entry.entry_type,
        has_project_marker: entry.has_project_marker,
    };
    classify_with_home(&input, guardrails::home_dir().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(path: &str, name: &str, entry_type: WalkEntryType) -> ClassifyInput<'static> {
        let path: &'static str = Box::leak(path.to_owned().into_boxed_str());
        let name: &'static str = Box::leak(name.to_owned().into_boxed_str());
        ClassifyInput {
            path,
            name,
            is_symlink: false,
            entry_type,
            has_project_marker: true,
        }
    }

    fn classify_in(input: &ClassifyInput<'_>) -> (RiskTier, Vec<String>) {
        classify_with_home(input, Some(Path::new("/home/dev")))
    }

    #[test]
    fn file_named_target_is_a_type_mismatch() {
        let (tier, reasons) = classify_in(&input("/p/docs/target", "target", WalkEntryType::File));
        assert_eq!(tier, RiskTier::Dangerous);
        assert_eq!(reasons, ["default-pattern", "entry-type-mismatch"]);
    }

    #[test]
    fn target_without_marker_is_not_presumed_safe() {
        let mut entry = input("/p/notes/target", "target", WalkEntryType::Directory);
        entry.has_project_marker = false;
        let (tier, reasons) = classify_in(&entry);
        assert_eq!(tier, RiskTier::Dangerous);
        assert_eq!(reasons, ["default-pattern", "no-project-marker"]);
    }

    #[test]
    fn target_with_marker_stays_safe() {
        let (tier, reasons) = classify_in(&input(
            "/p/crate/target",
            "target",
            WalkEntryType::Directory,
        ));
        assert_eq!(tier, RiskTier::Safe);
        assert_eq!(reasons, ["default-pattern"]);
    }

    #[test]
    fn tool_home_outranks_marker_and_names_the_reason() {
        let (tier, reasons) = classify_in(&input(
            "/home/dev/.bun/install/global/node_modules",
            "node_modules",
            WalkEntryType::Directory,
        ));
        assert_eq!(tier, RiskTier::Dangerous);
        assert_eq!(reasons, ["default-pattern", "tool-home"]);
    }

    #[test]
    fn symlink_keeps_caution_without_context_reason() {
        let mut entry = input("/p/target", "target", WalkEntryType::Symlink);
        entry.is_symlink = true;
        entry.has_project_marker = false;
        assert_eq!(
            classify_in(&entry),
            (
                RiskTier::Caution,
                vec!["symlink".to_owned(), "default-pattern".to_owned()]
            )
        );
    }

    #[test]
    fn tool_home_paths_match_js_cases() {
        let home = Some(Path::new("/home/dev"));
        for path in [
            "/home/dev/.bun/install/global/node_modules",
            "/home/dev/.npm-global/lib/node_modules",
            "/home/dev/.asdf/installs/nodejs/22/lib/node_modules",
            "/home/dev/.mise/installs/node/22/lib/node_modules",
            "/home/dev/.nodenv/versions/22/lib/node_modules",
            "/home/dev/.pyenv/versions/3.12/lib/node_modules",
            "/home/dev/.poetry/venv/node_modules",
            "/home/dev/.conda/envs/ml/node_modules",
            "/home/dev/miniconda3/envs/ml/node_modules",
            "/home/dev/anaconda3/envs/ml/node_modules",
            "/home/dev/miniforge3/envs/ml/node_modules",
            "/home/dev/mambaforge/envs/ml/node_modules",
            "/home/dev/.uv/tools/ruff/node_modules",
            "/home/dev/.pipx/venvs/tool/node_modules",
            "/home/dev/.rbenv/versions/3.3/node_modules",
            "/home/dev/.rvm/gems/node_modules",
            "/home/dev/.gem/ruby/node_modules",
            "/home/dev/go/pkg/mod/node_modules",
            "/home/dev/.sdkman/candidates/java/node_modules",
            "/home/dev/.gradle/caches/node_modules",
            "/home/dev/.m2/repository/node_modules",
            "/home/dev/.composer/vendor/node_modules",
            "/home/dev/.pub-cache/hosted/node_modules",
            "/home/dev/.android/avd/node_modules",
            "/home/dev/.flutter/packages/node_modules",
            "/home/dev/.var/app/com.example.App/data/node_modules",
            "/home/dev/snap/code/current/node_modules",
            "/home/dev/scoop/apps/node/current/node_modules",
            "/home/dev/.vscode-insiders/extensions/ext/node_modules",
            "/home/dev/.vscode-oss/extensions/ext/node_modules",
            "/home/dev/.windsurf/extensions/ext/node_modules",
            "/home/dev/.windsurf-server/bin/node_modules",
            "/home/dev/.zed/extensions/node_modules",
            "/home/dev/.claude/plugins/node_modules",
            "/home/dev/.codex/skills/node_modules",
            "/home/dev/.gemini/extensions/node_modules",
            "/home/dev/.t3/userdata/node_modules",
            "/home/dev/.local/share/nvim/lazy/blink.cmp/target",
            "/home/dev/Applications/Editor.app/Contents/Resources/app/node_modules",
            "/usr/share/cursor/resources/app/node_modules",
            "/opt/homebrew/lib/node_modules",
            "/home/linuxbrew/.linuxbrew/lib/node_modules",
            "/etc/nginx/node_modules",
            "/private/etc/nginx/node_modules",
            "/sys/class/target",
            "/proc/sys/target",
            "/dev/disk/target",
            "/boot/grub/target",
            "/bin/sub/node_modules",
            "/sbin/sub/node_modules",
            "/lib/sub/node_modules",
            "/lib64/sub/node_modules",
            "/var/lib/docker/overlay2/abc/diff/app/node_modules",
            "/nix/store/abc-pkg/lib/node_modules",
        ] {
            assert!(is_inside_tool_home(Path::new(path), home), "{path}");
        }
        for path in [
            "/home/dev/Projects/app/node_modules",
            "/home/dev/Projects/example.app/node_modules",
            "/home/dev/go/src/proj/node_modules",
            "/home/dev/go/src/github.com/me/app/node_modules",
            "/home/dev/.t3/worktrees/x/node_modules",
            "/home/dev/.codex/worktrees/x/node_modules",
            "/home/dev/Dropbox/proj/node_modules",
            "/home/dev/OneDrive/Documents/proj/node_modules",
            "/home/dev/OneDrive - Contoso/proj/node_modules",
            "/home/dev/Google Drive/proj/node_modules",
            "/home/dev/My Drive/proj/node_modules",
            "/home/devops/.bun/node_modules",
            "/home/linuxbrew/Projects/app/node_modules",
            "/run/media/u/Data/proj/node_modules",
            "/run/user/1000/gvfs/smb/proj/node_modules",
            "/dev/shm/build/node_modules",
            "/var/www/site/node_modules",
            "/var/folders/xy/T/sweep-test/node_modules",
            "/tmp/sweep-test/node_modules",
            "/srv/app/node_modules",
        ] {
            assert!(!is_inside_tool_home(Path::new(path), home), "{path}");
        }
        assert!(!is_inside_tool_home(
            Path::new("/.bun/node_modules"),
            Some(Path::new("/"))
        ));
        assert!(is_inside_tool_home(
            Path::new("/usr/share/x/node_modules"),
            None
        ));
    }

    #[test]
    fn windows_drive_and_unc_paths_skip_unix_system_roots_cross_platform() {
        let win_home = Some(r"C:\Users\dev");
        for path in [
            r"C:\dev\app\node_modules",
            r"D:\bin\x\node_modules",
            r"C:\etc\project\node_modules",
            r"\\?\C:\dev\app\node_modules",
            r"\\server\share\dev\app\node_modules",
            r"\\?\UNC\server\share\dev\app\node_modules",
            r"C:\Users\dev\AppData\Local\Temp\t\node_modules",
            r"C:\Users\dev\go\src\proj\node_modules",
            r"C:\Users\dev\.t3\worktrees\x\node_modules",
            r"C:\Users\dev\.codex\worktrees\x\node_modules",
            r"C:\Users\dev\OneDrive\Documents\proj\node_modules",
        ] {
            assert!(
                !is_inside_tool_home_for(path, win_home, true, false),
                "{path} should stay safe"
            );
        }
        for path in [
            r"C:\Windows\System32\target",
            r"c:\windows\winsxs\target",
            r"\\?\C:\Windows\System32\target",
            r"D:\Program Files\App\resources\node_modules",
            r"C:\Users\dev\AppData\Roaming\npm\node_modules",
            r"C:\Users\dev\go\pkg\mod\node_modules",
            r"C:\Users\dev\.t3\userdata\node_modules",
            r"C:\Users\dev\.codex\skills\node_modules",
        ] {
            assert!(
                is_inside_tool_home_for(path, win_home, true, false),
                "{path} should be protected"
            );
        }

        let posix_home = Some("/home/dev");
        assert!(is_inside_tool_home_for(
            "/dev/disk/target",
            posix_home,
            false,
            false
        ));
        assert!(is_inside_tool_home_for(
            "/etc/nginx/node_modules",
            posix_home,
            false,
            false
        ));
        assert!(!is_inside_tool_home_for(
            "/dev/shm/build/node_modules",
            posix_home,
            false,
            false
        ));
        assert!(!is_inside_tool_home_for(
            "/run/media/u/Data/proj/node_modules",
            posix_home,
            false,
            false
        ));
    }

    #[test]
    fn cloud_sync_folders_add_informational_reason_without_demoting() {
        let home = Some(Path::new("/home/dev"));
        for path in [
            "/home/dev/Dropbox/proj/node_modules",
            "/home/dev/OneDrive/Documents/proj/node_modules",
            "/home/dev/OneDrive - Contoso/proj/node_modules",
            "/home/dev/Google Drive/proj/node_modules",
            "/home/dev/My Drive/proj/node_modules",
        ] {
            assert!(is_inside_cloud_sync_dir(Path::new(path), home), "{path}");
            let (tier, reasons) =
                classify_with_home(&input(path, "node_modules", WalkEntryType::Directory), home);
            assert_eq!(tier, RiskTier::Safe, "{path}");
            assert_eq!(reasons, ["default-pattern", "cloud-sync"], "{path}");
        }

        let cloud_storage = "/home/dev/Library/CloudStorage/GoogleDrive-me/proj/node_modules";
        assert!(is_inside_cloud_sync_dir(Path::new(cloud_storage), home));
        let (tier, reasons) = classify_with_home(
            &input(cloud_storage, "node_modules", WalkEntryType::Directory),
            home,
        );
        assert_eq!(tier, RiskTier::Dangerous);
        assert_eq!(reasons, ["default-pattern", "tool-home", "cloud-sync"]);

        for path in [
            "/home/dev/Projects/app/node_modules",
            "/home/dev/DropboxBackup/proj/node_modules",
            "/home/dev/OneDriveBackup/proj/node_modules",
            "/home/dev/OneDrive - /proj/node_modules",
            "/home/dev/Library/CloudStorage",
            "/tmp/Dropbox/proj/node_modules",
        ] {
            assert!(!is_inside_cloud_sync_dir(Path::new(path), home), "{path}");
        }

        assert!(is_inside_cloud_sync_dir_for(
            r"C:\Users\dev\onedrive - acme corp\proj\node_modules",
            Some(r"C:\Users\dev"),
            true,
            false,
        ));
    }

    #[test]
    fn app_bundle_detection_requires_macos_and_info_plist() -> std::io::Result<()> {
        let base = std::env::temp_dir().join(format!("sweep-app-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project_nm = base.join("example.app/node_modules");
        std::fs::create_dir_all(&project_nm)?;
        let bundle_nm = base.join("Editor.app/Contents/Resources/app/node_modules");
        std::fs::create_dir_all(&bundle_nm)?;
        std::fs::write(base.join("Editor.app/Contents/Info.plist"), "<plist/>\n")?;

        let home = Some(Path::new("/home/dev"));
        assert!(!has_macos_app_bundle_ancestor(&project_nm));
        assert!(has_macos_app_bundle_ancestor(&bundle_nm));
        let fake_plist_dir = base.join("Fake.app/Contents/Info.plist");
        std::fs::create_dir_all(&fake_plist_dir)?;
        assert!(!has_macos_app_bundle_ancestor(
            &fake_plist_dir.join("node_modules")
        ));

        assert!(!is_inside_tool_home(&project_nm, home));
        let expected_bundle = cfg!(target_os = "macos");
        assert_eq!(is_inside_tool_home(&bundle_nm, home), expected_bundle);

        let _ = std::fs::remove_dir_all(&base);
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn windows_app_data_is_protected_but_temp_and_c_dev_are_not() {
        let home = Some(Path::new(r"C:\Users\dev"));
        assert!(!is_inside_tool_home(
            Path::new(r"C:\dev\app\node_modules"),
            home
        ));
        assert!(!is_inside_tool_home(
            Path::new(r"D:\bin\x\node_modules"),
            home
        ));
        assert!(is_inside_tool_home(
            Path::new(r"C:\Users\dev\AppData\Roaming\npm\node_modules"),
            home
        ));
        assert!(!is_inside_tool_home(
            Path::new(r"C:\Users\dev\AppData\Local\Temp\t\node_modules"),
            home
        ));
        assert!(is_inside_tool_home(
            Path::new(r"D:\Program Files\App\resources\node_modules"),
            home
        ));
        assert!(is_inside_tool_home(
            Path::new(r"C:\Windows\System32\target"),
            home
        ));
        assert!(is_inside_tool_home(
            Path::new(r"\\?\C:\Windows\System32\target"),
            home
        ));
        assert!(is_inside_tool_home(
            Path::new(r"\\?\C:\Users\dev\.bun\node_modules"),
            home
        ));
        assert!(is_inside_tool_home(
            Path::new(r"C:\Users\dev\scoop\apps\node\node_modules"),
            home
        ));
    }

    #[test]
    fn every_default_pattern_has_an_artifact_rule() {
        for pattern in sweep_fs::default_patterns() {
            let probe = pattern.replace('*', "x");
            assert!(
                sweep_fs::artifact_rule_for(&probe).is_some(),
                "default pattern {pattern} has no artifact rule"
            );
        }
    }
}
