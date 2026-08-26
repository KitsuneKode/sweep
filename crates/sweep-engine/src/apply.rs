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

        match revalidate_candidate(candidate) {
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

fn revalidate_candidate(candidate: &ScanCandidate) -> Result<ScanEntry, PathFailure> {
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
        let is_inside = retained.iter().any(|parent| {
            parent.entry_type == EntryType::Directory
                && !parent.is_symlink
                && (entry.path.starts_with(&format!("{}/", parent.path))
                    || entry.path.starts_with(&format!("{}\\", parent.path)))
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
