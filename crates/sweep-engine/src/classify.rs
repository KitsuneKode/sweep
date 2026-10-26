//! Risk tier and reasons for a walked entry. JS parity: `classifyEntry` in
//! `packages/core/src/planner.ts` and `packages/core/src/classification.ts`
//! apply the same rules in the same order with the same reason strings.

use std::path::{Component, Path};
use sweep_fs::{WalkEntry, WalkEntryType};
use sweep_types::RiskTier;

use crate::guardrails;

/// Home-relative toolchain, package-manager, editor and app-data trees.
const HOME_TOOL_DIRS: &[&[&str]] = &[
    &[".bun"],
    &[".cargo"],
    &[".rustup"],
    &[".npm"],
    &[".nvm"],
    &[".yarn"],
    &[".volta"],
    &[".fnm"],
    &[".deno"],
    &[".pnpm-store"],
    &[".local"],
    &[".config"],
    &[".cache"],
    &[".vscode"],
    &[".vscode-server"],
    &[".cursor"],
    &[".cursor-server"],
    &["Library"],
    &["AppData"],
];

/// OS temp space inside a tool dir hosts ordinary scratch projects.
const HOME_TOOL_EXCEPTIONS: &[&[&str]] = &[&["AppData", "Local", "Temp"]];

/// System install locations; `/var` is listed by subdirectory because
/// `/var/www` holds projects and macOS `/var/folders` is the temp root.
const SYSTEM_TOOL_DIRS: &[&[&str]] = &[
    &["usr"],
    &["opt"],
    &["snap"],
    &["nix"],
    &["var", "lib"],
    &["var", "cache"],
    &["var", "opt"],
    &["var", "db"],
    &["private", "var", "db"],
    &["Applications"],
    &["System"],
    &["Library"],
    &["Program Files"],
    &["Program Files (x86)"],
    &["ProgramData"],
];

const CASE_FOLD: bool = cfg!(windows) || cfg!(target_os = "macos");

fn fold(segment: &str) -> String {
    if CASE_FOLD {
        segment.to_lowercase()
    } else {
        segment.to_owned()
    }
}

/// Path segments with the Windows drive kept as a leading `c:` segment, the
/// same shape as JS `normalize(path).split(sep)`.
fn segments_of(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(fold(&prefix.as_os_str().to_string_lossy())),
            Component::Normal(part) => Some(fold(&part.to_string_lossy())),
            _ => None,
        })
        .collect()
}

fn starts_with_segments(segments: &[String], prefix: &[&str]) -> bool {
    prefix.len() <= segments.len()
        && prefix
            .iter()
            .zip(segments)
            .all(|(part, segment)| fold(part) == *segment)
}

fn without_drive(segments: &[String]) -> &[String] {
    match segments.first() {
        Some(first)
            if first.len() == 2
                && first.ends_with(':')
                && first.starts_with(|c: char| c.is_ascii_alphabetic()) =>
        {
            &segments[1..]
        }
        _ => segments,
    }
}

/// True when `path` lies inside a toolchain, package-manager, editor or system
/// install tree, or inside a macOS `.app` bundle. A home with no segments
/// disables the home rules.
pub(crate) fn is_inside_tool_home(path: &Path, home: Option<&Path>) -> bool {
    let segments = segments_of(path);
    if segments.iter().any(|segment| segment.ends_with(".app")) {
        return true;
    }
    let rooted = without_drive(&segments);
    if SYSTEM_TOOL_DIRS
        .iter()
        .any(|prefix| starts_with_segments(rooted, prefix))
    {
        return true;
    }
    let home_segments = home.map(segments_of).unwrap_or_default();
    if home_segments.is_empty() || !segments.starts_with(&home_segments) {
        return false;
    }
    let below = &segments[home_segments.len()..];
    if HOME_TOOL_EXCEPTIONS
        .iter()
        .any(|prefix| starts_with_segments(below, prefix))
    {
        return false;
    }
    HOME_TOOL_DIRS
        .iter()
        .any(|prefix| starts_with_segments(below, prefix))
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

    if protected_vcs || protected_project {
        return (RiskTier::Blocked, reasons);
    }
    if input.is_symlink {
        return (RiskTier::Caution, reasons);
    }
    // Only names a shipping-default pattern covers can earn the safe tier.
    // Opt-in catalog names (dist, build, out, ...) can hold authored files.
    if catalog != Some(sweep_fs::CatalogMatch::Default) {
        return (RiskTier::Dangerous, reasons);
    }
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
            (RiskTier::Dangerous, reasons)
        }
        None => (RiskTier::Safe, reasons),
    }
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
            "/home/dev/.local/share/nvim/lazy/blink.cmp/target",
            "/home/dev/Applications/Editor.app/Contents/Resources/app/node_modules",
            "/usr/share/cursor/resources/app/node_modules",
            "/opt/homebrew/lib/node_modules",
            "/var/lib/docker/overlay2/abc/diff/app/node_modules",
            "/nix/store/abc-pkg/lib/node_modules",
        ] {
            assert!(is_inside_tool_home(Path::new(path), home), "{path}");
        }
        for path in [
            "/home/dev/Projects/app/node_modules",
            "/home/devops/.bun/node_modules",
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

    #[cfg(windows)]
    #[test]
    fn windows_app_data_is_protected_but_temp_is_not() {
        let home = Some(Path::new(r"C:\Users\dev"));
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
