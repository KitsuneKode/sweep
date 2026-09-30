//! Apply selected plan candidates with revalidation and filesystem deletes.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use sweep_errors::{EngineError, FailureReasonCode, GuardrailError};
use sweep_types::{
    ApplyReport, EntryType, PathFailure, ScanCandidate, ScanEntry, ScanPlan, PROTOCOL_VERSION,
};

use crate::guardrails;

/// Apply a [`ScanPlan`]: revalidate selected candidates, delete ready entries, return a report.
pub fn apply_plan(plan: &ScanPlan) -> Result<ApplyReport, EngineError> {
    if plan.protocol_version != PROTOCOL_VERSION {
        return Err(EngineError::Guardrail(
            GuardrailError::UnsupportedProtocolVersion {
                found: plan.protocol_version.clone(),
                expected: PROTOCOL_VERSION.to_owned(),
            },
        ));
    }

    guardrails::assert_safe_cwd(&plan.target_dir)?;

    let selected: Vec<&ScanCandidate> = plan
        .candidates
        .iter()
        .filter(|candidate| plan.selected_candidate_ids.contains(&candidate.id))
        .collect();

    if selected.is_empty() {
        return Ok(ApplyReport::empty(plan));
    }

    // Resolve the target once: lexical containment alone is not enough - a
    // directory inside the tree can be swapped for a symlink between scan and
    // apply, and rm would then recurse through it outside the target.
    // If the root itself cannot be canonicalized, every candidate fails
    // symlink_metadata anyway, so skipping the check loses nothing.
    let real_root = fs::canonicalize(&plan.target_dir).ok();

    let mut ready: Vec<ScanEntry> = Vec::new();
    let mut failed_paths: Vec<PathFailure> = Vec::new();

    for candidate in selected {
        if !is_path_within_root(&candidate.entry.path, &plan.target_dir) {
            failed_paths.push(path_failure(
                &candidate.entry.path,
                FailureReasonCode::OutsideTarget,
                "candidate path is outside the plan target directory".to_owned(),
            ));
            continue;
        }

        // A plan file is untrusted input: riskTier is attacker-controlled, so
        // safety classifications are re-derived from the path. The scanner
        // never emits the target root itself or anything inside VCS metadata -
        // a plan that selects them was hand-made. Aligned with the JS engine's
        // revalidateCandidates. Case-insensitive filesystems make "/TMP/PROJ"
        // the same directory as "/tmp/proj", so compare case-folded there.
        if same_resolved_path(&candidate.entry.path, &plan.target_dir) {
            failed_paths.push(path_failure(
                &candidate.entry.path,
                FailureReasonCode::ProtectedPath,
                "candidate path is the plan target directory itself".to_owned(),
            ));
            continue;
        }
        if guardrails::path_has_protected_vcs_segment(&candidate.entry.path) {
            failed_paths.push(path_failure(
                &candidate.entry.path,
                FailureReasonCode::ProtectedPath,
                "candidate path is inside protected VCS metadata".to_owned(),
            ));
            continue;
        }

        match revalidate_candidate(candidate, real_root.as_deref()) {
            Ok(entry) => ready.push(entry),
            Err(failure) => failed_paths.push(failure),
        }
    }

    let ready = deduplicate_nested_entries(ready);
    let mut deleted_count = 0u32;
    let mut total_bytes_freed = 0u64;

    for entry in ready {
        match delete_entry(&entry) {
            Ok(()) => {
                deleted_count += 1;
                total_bytes_freed += entry.estimated_bytes;
            }
            Err(failure) => failed_paths.push(failure),
        }
    }

    Ok(ApplyReport {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        target_dir: plan.target_dir.clone(),
        selected_candidate_ids: plan.selected_candidate_ids.clone(),
        deleted_count,
        failed_count: failed_paths.len() as u32,
        total_bytes_freed,
        failed_paths,
    })
}

fn revalidate_candidate(
    candidate: &ScanCandidate,
    real_root: Option<&Path>,
) -> Result<ScanEntry, PathFailure> {
    let path = Path::new(candidate.entry.path.as_str());
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) => {
            return Err(path_failure(
                &candidate.entry.path,
                classify_io_error(&err),
                err.to_string(),
            ));
        }
    };

    let is_symlink = meta.file_type().is_symlink();
    let entry_type = if is_symlink {
        EntryType::Symlink
    } else if meta.is_dir() {
        EntryType::Directory
    } else {
        EntryType::File
    };

    if is_symlink != candidate.entry.is_symlink {
        return Err(path_failure(
            &candidate.entry.path,
            FailureReasonCode::ChangedSymlinkState,
            "candidate type changed since plan creation".to_owned(),
        ));
    }

    if entry_type != candidate.entry.entry_type {
        return Err(path_failure(
            &candidate.entry.path,
            FailureReasonCode::ChangedEntryType,
            "candidate entry type changed since plan creation".to_owned(),
        ));
    }

    // Symlink candidates are unlinked (the link removed, never followed), so
    // real containment only matters for real entries - an ancestor swapped to
    // a symlink pointing outside the root must not be deleted through.
    if !is_symlink {
        if let Some(root) = real_root {
            match fs::canonicalize(path) {
                Ok(real_candidate) => {
                    // Canonical equality means the candidate IS the target root
                    // spelled differently (case-variant, symlinked parent) -
                    // never deletable.
                    if real_candidate == root {
                        return Err(path_failure(
                            &candidate.entry.path,
                            FailureReasonCode::ProtectedPath,
                            "candidate path resolves to the plan target directory itself"
                                .to_owned(),
                        ));
                    }
                    if !real_candidate.starts_with(root) {
                        return Err(path_failure(
                            &candidate.entry.path,
                            FailureReasonCode::OutsideTarget,
                            "candidate resolves outside the plan target directory".to_owned(),
                        ));
                    }
                }
                Err(err) => {
                    return Err(path_failure(
                        &candidate.entry.path,
                        classify_io_error(&err),
                        err.to_string(),
                    ));
                }
            }
        }
    }

    Ok(candidate.entry.clone())
}

fn is_path_within_root(candidate_path: &str, root_path: &str) -> bool {
    let candidate = lexical_abs(Path::new(candidate_path));
    let root = lexical_abs(Path::new(root_path));
    if candidate == root {
        return true;
    }
    match candidate.strip_prefix(&root) {
        Ok(relative) => {
            let rel = relative.to_string_lossy();
            !rel.is_empty() && !rel.starts_with("..")
        }
        Err(_) => false,
    }
}

/// Resolved-path equality, case-folded where the filesystem is (macOS/Windows).
/// A case-variant spelling of the same directory must not slip past the
/// root-protection check on a case-insensitive volume.
fn same_resolved_path(a: &str, b: &str) -> bool {
    let ra = lexical_abs(Path::new(a));
    let rb = lexical_abs(Path::new(b));
    if ra == rb {
        return true;
    }
    if cfg!(windows) || cfg!(target_os = "macos") {
        ra.to_string_lossy().to_lowercase() == rb.to_string_lossy().to_lowercase()
    } else {
        false
    }
}

fn lexical_abs(path: &Path) -> std::path::PathBuf {
    use std::path::{Component, PathBuf};
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn deduplicate_nested_entries(mut entries: Vec<ScanEntry>) -> Vec<ScanEntry> {
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let mut retained: Vec<ScanEntry> = Vec::new();
    for entry in entries {
        // Exact-path duplicates dedupe too - a crafted plan listing the same
        // path twice would otherwise double-delete and report a phantom
        // "missing" failure. Aligned with the JS deduplicateNestedEntries.
        let is_inside = retained.iter().any(|parent| {
            entry.path == parent.path
                || (parent.entry_type == EntryType::Directory
                    && !parent.is_symlink
                    && (entry.path.starts_with(&format!("{}/", parent.path))
                        || entry.path.starts_with(&format!("{}\\", parent.path))))
        });
        if !is_inside {
            retained.push(entry);
        }
    }
    retained
}

fn delete_entry(entry: &ScanEntry) -> Result<(), PathFailure> {
    let path = Path::new(entry.path.as_str());
    let result = if entry.is_symlink {
        fs::remove_file(path)
    } else {
        fs::remove_dir_all(path).or_else(|err| {
            if entry.entry_type == EntryType::File {
                fs::remove_file(path)
            } else {
                Err(err)
            }
        })
    };

    result.map_err(|err| path_failure(&entry.path, classify_io_error(&err), err.to_string()))
}

fn path_failure(path: &str, code: FailureReasonCode, error: String) -> PathFailure {
    PathFailure {
        path: path.to_owned(),
        code: code.as_str().to_owned(),
        error,
    }
}

fn classify_io_error(err: &std::io::Error) -> FailureReasonCode {
    match err.kind() {
        ErrorKind::NotFound => FailureReasonCode::Missing,
        ErrorKind::PermissionDenied => FailureReasonCode::PermissionDenied,
        ErrorKind::WouldBlock | ErrorKind::AddrInUse => FailureReasonCode::Busy,
        _ => {
            let message = err.to_string();
            if message.contains("ENOENT") {
                FailureReasonCode::Missing
            } else if message.contains("EACCES") || message.contains("EPERM") {
                FailureReasonCode::PermissionDenied
            } else if message.contains("EBUSY") {
                FailureReasonCode::Busy
            } else {
                FailureReasonCode::FilesystemError
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sweep_types::{RiskTier, ScanCandidate, ScanPlanSummary, SelectionPolicy};
    use tempfile::tempdir;

    fn candidate(path: &str, name: &str, entry_type: EntryType, is_symlink: bool) -> ScanCandidate {
        ScanCandidate {
            entry: ScanEntry {
                path: path.to_owned(),
                name: name.to_owned(),
                estimated_bytes: 0,
                modified_ms: None,
                is_symlink,
                entry_type,
            },
            id: format!("cand_{name}"),
            kind: name.to_owned(),
            risk_tier: RiskTier::Safe,
            reasons: vec!["default-pattern".to_owned()],
            selected_by_default: true,
        }
    }

    #[test]
    fn apply_plan_deletes_selected_directory() {
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy();
        let artifact = dir.path().join("node_modules");
        fs::create_dir_all(&artifact).unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let artifact_path = artifact.to_string_lossy().into_owned();
        let plan = ScanPlan {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: root.to_string(),
            selection_policy: SelectionPolicy::default(),
            candidates: vec![candidate(
                &artifact_path,
                "node_modules",
                EntryType::Directory,
                false,
            )],
            summary: ScanPlanSummary {
                candidate_count: 1,
                estimated_total_bytes: 0,
                scanned_dirs: 1,
                skipped_dirs: 0,
                exact: false,
                selected_count: 1,
                risk_counts: Default::default(),
            },
            selected_candidate_ids: vec!["cand_node_modules".to_owned()],
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
        };

        let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
        assert_eq!(report.deleted_count, 1);
        assert_eq!(report.failed_count, 0);
        assert!(!artifact.exists());
    }

    #[test]
    fn apply_plan_rejects_outside_target_candidates() {
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy();
        let artifact = dir.path().join("node_modules");
        fs::create_dir_all(&artifact).unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let artifact_path = artifact.to_string_lossy().into_owned();
        let outside_path = "/tmp/outside-node_modules".to_owned();
        let plan = ScanPlan {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: root.to_string(),
            selection_policy: SelectionPolicy::default(),
            candidates: vec![
                candidate(&artifact_path, "node_modules", EntryType::Directory, false),
                ScanCandidate {
                    entry: ScanEntry {
                        path: outside_path.clone(),
                        name: "node_modules".to_owned(),
                        estimated_bytes: 0,
                        modified_ms: None,
                        is_symlink: false,
                        entry_type: EntryType::Directory,
                    },
                    id: "cand_outside".to_owned(),
                    kind: "node_modules".to_owned(),
                    risk_tier: RiskTier::Safe,
                    reasons: vec!["default-pattern".to_owned()],
                    selected_by_default: true,
                },
            ],
            summary: ScanPlanSummary {
                candidate_count: 2,
                estimated_total_bytes: 0,
                scanned_dirs: 1,
                skipped_dirs: 0,
                exact: false,
                selected_count: 2,
                risk_counts: Default::default(),
            },
            selected_candidate_ids: vec!["cand_node_modules".to_owned(), "cand_outside".to_owned()],
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
        };

        let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
        assert_eq!(report.deleted_count, 1);
        assert_eq!(report.failed_count, 1);
        assert_eq!(
            report.failed_paths[0].code,
            FailureReasonCode::OutsideTarget.as_str()
        );
        assert_eq!(report.failed_paths[0].path, outside_path);
        assert!(!artifact.exists());
    }

    #[test]
    #[cfg(unix)]
    fn apply_plan_rejects_candidate_behind_symlinked_ancestor() {
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let outside = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy();

        let sub = dir.path().join("sub");
        fs::create_dir_all(sub.join("node_modules"))
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        // The candidate passes a lexical root check, but "sub" now resolves
        // outside the target - removal must not recurse through the link.
        fs::remove_dir_all(&sub).unwrap_or_else(|err| panic!("rmdir failed: {err}"));
        std::os::unix::fs::symlink(outside.path(), &sub)
            .unwrap_or_else(|err| panic!("symlink failed: {err}"));
        let victim = outside.path().join("node_modules");
        fs::create_dir_all(&victim).unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let candidate_path = sub.join("node_modules").to_string_lossy().into_owned();
        let plan = ScanPlan {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: root.to_string(),
            selection_policy: SelectionPolicy::default(),
            candidates: vec![candidate(
                &candidate_path,
                "node_modules",
                EntryType::Directory,
                false,
            )],
            summary: ScanPlanSummary {
                candidate_count: 1,
                estimated_total_bytes: 0,
                scanned_dirs: 1,
                skipped_dirs: 0,
                exact: false,
                selected_count: 1,
                risk_counts: Default::default(),
            },
            selected_candidate_ids: vec!["cand_node_modules".to_owned()],
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
        };

        let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
        assert_eq!(report.deleted_count, 0);
        assert_eq!(report.failed_count, 1);
        assert_eq!(
            report.failed_paths[0].code,
            FailureReasonCode::OutsideTarget.as_str()
        );
        assert!(victim.exists());
    }

    #[test]
    fn apply_plan_refuses_target_root_as_candidate() {
        // A forged plan can name the target root itself as a candidate - the
        // scanner never emits it, but apply must not remove_dir_all the whole
        // project (including its .git).
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy().into_owned();
        fs::create_dir_all(dir.path().join(".git"))
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let root_for_candidate = root.clone();
        let plan = ScanPlan {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: root.clone(),
            selection_policy: SelectionPolicy::default(),
            candidates: vec![candidate(
                &root_for_candidate,
                "project",
                EntryType::Directory,
                false,
            )],
            summary: ScanPlanSummary {
                candidate_count: 1,
                estimated_total_bytes: 0,
                scanned_dirs: 1,
                skipped_dirs: 0,
                exact: false,
                selected_count: 1,
                risk_counts: Default::default(),
            },
            selected_candidate_ids: vec!["cand_project".to_owned()],
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
        };

        let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
        assert_eq!(report.deleted_count, 0);
        assert_eq!(report.failed_count, 1);
        assert_eq!(
            report.failed_paths[0].code,
            FailureReasonCode::ProtectedPath.as_str()
        );
        assert!(dir.path().join(".git").exists());
    }

    #[test]
    fn apply_plan_refuses_root_spelled_with_dot_segments() {
        // "target/." and "target/sub/.." resolve to the target root - the
        // canonical-equality check must catch spellings past the lexical one.
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy().into_owned();
        fs::create_dir_all(dir.path().join(".git"))
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        fs::create_dir_all(dir.path().join("sub"))
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        for spelling in [format!("{root}/."), format!("{root}/sub/..")] {
            let plan = ScanPlan {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                target_dir: root.clone(),
                selection_policy: SelectionPolicy::default(),
                candidates: vec![candidate(&spelling, "project", EntryType::Directory, false)],
                summary: ScanPlanSummary {
                    candidate_count: 1,
                    estimated_total_bytes: 0,
                    scanned_dirs: 1,
                    skipped_dirs: 0,
                    exact: false,
                    selected_count: 1,
                    risk_counts: Default::default(),
                },
                selected_candidate_ids: vec!["cand_project".to_owned()],
                created_at: "1970-01-01T00:00:00.000Z".to_owned(),
            };

            let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
            assert_eq!(report.deleted_count, 0, "spelling {spelling} deleted root");
            assert_eq!(
                report.failed_paths[0].code,
                FailureReasonCode::ProtectedPath.as_str()
            );
        }
        assert!(dir.path().join(".git").exists());
    }

    #[test]
    fn apply_plan_refuses_vcs_metadata_candidates() {
        // riskTier is plan-controlled JSON - a forged "safe" tier must not
        // bypass the VCS protection applied at scan time.
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy();
        let git_dir = dir.path().join(".git");
        fs::create_dir_all(git_dir.join("objects"))
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let git_path = git_dir.to_string_lossy().into_owned();
        let plan = ScanPlan {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: root.to_string(),
            selection_policy: SelectionPolicy::default(),
            candidates: vec![ScanCandidate {
                entry: ScanEntry {
                    path: git_path,
                    name: ".git".to_owned(),
                    estimated_bytes: 0,
                    modified_ms: None,
                    is_symlink: false,
                    entry_type: EntryType::Directory,
                },
                id: "cand_git".to_owned(),
                kind: "node_modules".to_owned(),
                risk_tier: RiskTier::Safe,
                reasons: vec!["default-pattern".to_owned()],
                selected_by_default: true,
            }],
            summary: ScanPlanSummary {
                candidate_count: 1,
                estimated_total_bytes: 0,
                scanned_dirs: 1,
                skipped_dirs: 0,
                exact: false,
                selected_count: 1,
                risk_counts: Default::default(),
            },
            selected_candidate_ids: vec!["cand_git".to_owned()],
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
        };

        let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
        assert_eq!(report.deleted_count, 0);
        assert_eq!(
            report.failed_paths[0].code,
            FailureReasonCode::ProtectedPath.as_str()
        );
        assert!(git_dir.exists());
    }

    #[test]
    fn apply_plan_deduplicates_exact_path_duplicates() {
        // The same path listed under two ids must delete once - the second
        // removal would ENOENT into a phantom "missing" failure.
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy();
        let artifact = dir.path().join("node_modules");
        fs::create_dir_all(&artifact).unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let artifact_path = artifact.to_string_lossy().into_owned();
        let mut dupe = candidate(&artifact_path, "node_modules", EntryType::Directory, false);
        dupe.id = "cand_dupe".to_owned();
        let plan = ScanPlan {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: root.to_string(),
            selection_policy: SelectionPolicy::default(),
            candidates: vec![
                candidate(&artifact_path, "node_modules", EntryType::Directory, false),
                dupe,
            ],
            summary: ScanPlanSummary {
                candidate_count: 2,
                estimated_total_bytes: 0,
                scanned_dirs: 1,
                skipped_dirs: 0,
                exact: false,
                selected_count: 2,
                risk_counts: Default::default(),
            },
            selected_candidate_ids: vec!["cand_node_modules".to_owned(), "cand_dupe".to_owned()],
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
        };

        let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
        assert_eq!(report.deleted_count, 1);
        assert_eq!(report.failed_count, 0);
        assert!(!artifact.exists());
    }

    #[test]
    fn apply_plan_deduplicates_nested_directory_candidates() {
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let root = dir.path().to_string_lossy();
        let parent = dir.path().join("dist");
        let child = parent.join("nested");
        fs::create_dir_all(&child).unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let parent_path = parent.to_string_lossy().into_owned();
        let child_path = child.to_string_lossy().into_owned();
        let mut parent_candidate = candidate(&parent_path, "dist", EntryType::Directory, false);
        parent_candidate.entry.estimated_bytes = 100;
        let mut child_candidate = candidate(&child_path, "nested", EntryType::Directory, false);
        child_candidate.id = "cand_nested".to_owned();
        child_candidate.entry.estimated_bytes = 40;

        let plan = ScanPlan {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: root.to_string(),
            selection_policy: SelectionPolicy::default(),
            candidates: vec![parent_candidate, child_candidate],
            summary: ScanPlanSummary {
                candidate_count: 2,
                estimated_total_bytes: 140,
                scanned_dirs: 2,
                skipped_dirs: 0,
                exact: false,
                selected_count: 2,
                risk_counts: Default::default(),
            },
            selected_candidate_ids: vec!["cand_dist".to_owned(), "cand_nested".to_owned()],
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
        };

        let report = apply_plan(&plan).unwrap_or_else(|err| panic!("apply failed: {err}"));
        assert_eq!(report.deleted_count, 1);
        assert_eq!(report.failed_count, 0);
        assert_eq!(report.total_bytes_freed, 100);
        assert!(!parent.exists());
    }
}
