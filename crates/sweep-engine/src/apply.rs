//! Apply selected plan candidates with revalidation and filesystem deletes.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use sweep_errors::{EngineError, FailureReasonCode, GuardrailError};
use sweep_types::{
    ApplyReport, EntryType, PathFailure, ScanCandidate, ScanEntry, ScanPlan, PROTOCOL_VERSION,
};

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
        match revalidate_candidate(candidate) {
            Ok(entry) => ready.push(entry),
            Err(failure) => failed_paths.push(failure),
        }
    }

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
}
