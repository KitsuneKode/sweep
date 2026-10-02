//! Apply selected plan candidates with revalidation and filesystem deletes.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sweep_errors::{EngineError, FailureReasonCode, GuardrailError};
use sweep_types::{
    ApplyOutcome, ApplyReport, EntryType, PathFailure, ScanCandidate, ScanEntry, ScanPlan,
    PROTOCOL_VERSION,
};

use crate::guardrails;

/// Apply a [`ScanPlan`]: revalidate selected candidates, delete ready entries, return a report.
pub fn apply_plan(plan: &ScanPlan) -> Result<ApplyReport, EngineError> {
    apply_plan_controlled(plan, &AtomicBool::new(false), &mut |_| {})
}

/// Stops before the next destructive operation; a running removal finishes.
pub fn apply_plan_controlled(
    plan: &ScanPlan,
    cancelled: &AtomicBool,
    on_deleted: &mut dyn FnMut(&str),
) -> Result<ApplyReport, EngineError> {
    apply_plan_controlled_with_limit(plan, cancelled, &mut |_| {}, on_deleted, None)
}

pub fn apply_plan_controlled_with_limit(
    plan: &ScanPlan,
    cancelled: &AtomicBool,
    on_begin: &mut dyn FnMut(&str),
    on_deleted: &mut dyn FnMut(&str),
    max_bytes: Option<u64>,
) -> Result<ApplyReport, EngineError> {
    if plan.protocol_version != PROTOCOL_VERSION {
        return Err(EngineError::Guardrail(
            GuardrailError::UnsupportedProtocolVersion {
                found: plan.protocol_version.clone(),
                expected: PROTOCOL_VERSION.to_owned(),
            },
        ));
    }

    guardrails::assert_safe_cwd(&plan.target_dir)?;
    let budget = sweep_fs::ResourceBudget::default();
    if plan.selected_candidate_ids.len()
        > sweep_types::ScanLimits::default().max_candidates as usize
    {
        budget.fail("maxCandidates");
    }
    let mut observed_bytes = 0u64;
    for candidate in &plan.candidates {
        if !budget.candidate(candidate.entry.path.len()) {
            break;
        }
        observed_bytes = observed_bytes
            .checked_add(candidate.entry.estimated_bytes)
            .filter(|&n| n <= 9_007_199_254_740_991)
            .ok_or_else(|| EngineError::InvalidPlan {
                message: "byte counter overflow".to_owned(),
            })?;
    }
    if plan.summary.estimated_total_bytes > 9_007_199_254_740_991 {
        return Err(EngineError::InvalidPlan {
            message: "byte counter overflow".to_owned(),
        });
    }
    if let Some(message) = budget.error() {
        return Err(EngineError::ResourceLimit { message });
    }

    // Vec::contains would make selection O(candidates × selected); the plan
    // format keeps `selected_candidate_ids` a Vec on the wire, so build the
    // lookup once here (JS already uses a Set).
    let selected_ids: std::collections::HashSet<&str> = plan
        .selected_candidate_ids
        .iter()
        .map(String::as_str)
        .collect();
    let selected: Vec<&ScanCandidate> = plan
        .candidates
        .iter()
        .filter(|candidate| selected_ids.contains(candidate.id.as_str()))
        .collect();

    let known_ids: std::collections::HashSet<&str> =
        plan.candidates.iter().map(|c| c.id.as_str()).collect();
    if known_ids.len() != plan.candidates.len()
        || selected_ids.iter().any(|id| !known_ids.contains(id))
    {
        return Err(EngineError::InvalidPlan {
            message: "duplicate candidate IDs or unknown selection".to_owned(),
        });
    }

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

    let mut outcomes: Vec<ApplyOutcome> = selected
        .iter()
        .map(|c| ApplyOutcome {
            candidate_id: c.id.clone(),
            status: "unattempted".to_owned(),
            covered_by: None,
        })
        .collect();
    let outcome_index: std::collections::HashMap<&str, usize> = selected
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.as_str(), i))
        .collect();
    for candidate in &selected {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        outcomes[outcome_index[candidate.id.as_str()]].status = "failed".to_owned();
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
            Ok(entry) => {
                outcomes[outcome_index[candidate.id.as_str()]].status = "unattempted".to_owned();
                ready.push(entry);
            }
            Err(failure) => failed_paths.push(failure),
        }
    }

    let ready = deduplicate_nested_entries(ready);
    if let Some(limit) = max_bytes.filter(|_| !cancelled.load(Ordering::Acquire)) {
        let mut sizes = std::collections::HashMap::new();
        for entry in &ready {
            if cancelled.load(Ordering::Acquire) {
                break;
            }
            let size = sweep_fs::measure_size_with_budget(
                camino::Utf8Path::new(&entry.path),
                plan.summary.exact,
                &budget,
            );
            if let Some(message) = budget.error() {
                return Err(EngineError::ResourceLimit { message });
            }
            sizes.insert(entry.path.clone(), size);
        }
        let mut total = 0u64;
        for entry in &ready {
            if cancelled.load(Ordering::Acquire) {
                break;
            }
            let size = sizes
                .get(&entry.path)
                .ok_or_else(|| EngineError::InvalidPlan {
                    message: "missing refreshed size".to_owned(),
                })?;
            if !size.complete {
                return Err(GuardrailError::CurrentSizeUnavailable {
                    path: entry.path.clone(),
                }
                .into());
            }

            total = total
                .checked_add(size.bytes)
                .filter(|&n| n <= 9_007_199_254_740_991)
                .ok_or_else(|| EngineError::InvalidPlan {
                    message: "refreshed byte counter overflow".to_owned(),
                })?;
        }
        if total > limit {
            return Err(GuardrailError::SizeLimitExceeded {
                selected_bytes: total,
            }
            .into());
        }
    }
    let mut deleted_count = 0u32;
    let mut total_bytes_freed = 0u64;

    let mut retained_ids = std::collections::HashMap::new();
    for c in &selected {
        if outcomes[outcome_index[c.id.as_str()]].status == "unattempted" {
            retained_ids
                .entry(dedupe_key(&c.entry.path))
                .or_insert(c.id.as_str());
        }
    }
    let mut removed = std::collections::HashMap::new();
    let mut removed_dirs = std::collections::HashMap::new();
    for entry in ready {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let key = dedupe_key(&entry.path);
        let id = retained_ids[key.as_str()];
        on_begin(id);
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        match delete_entry(&entry, real_root.as_deref()) {
            Ok(()) => {
                deleted_count += 1;
                total_bytes_freed += entry.estimated_bytes; // preflight checked all candidate bytes before any removal
                outcomes[outcome_index[id]].status = "deleted".to_owned();
                removed.insert(key.clone(), id);
                if entry.entry_type == EntryType::Directory && !entry.is_symlink {
                    removed_dirs.insert(key, id);
                }
                on_deleted(id);
            }
            Err(failure) => {
                outcomes[outcome_index[id]].status = "failed".to_owned();
                failed_paths.push(failure);
            }
        }
    }
    for c in &selected {
        let index = outcome_index[c.id.as_str()];
        if outcomes[index].status != "unattempted" {
            continue;
        }
        let key = dedupe_key(&c.entry.path);
        let mut covering = removed.get(&key).copied();
        let mut parent = Path::new(&key).parent();
        while covering.is_none() {
            let Some(path) = parent else {
                break;
            };
            covering = removed_dirs.get(path.to_string_lossy().as_ref()).copied();
            parent = path.parent();
        }
        if let Some(id) = covering {
            outcomes[index].status = "covered".to_owned();
            outcomes[index].covered_by = Some(id.to_owned());
        }
    }

    Ok(ApplyReport {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        target_dir: plan.target_dir.clone(),
        selected_candidate_ids: selected.iter().map(|c| c.id.clone()).collect(),
        deleted_count,
        failed_count: failed_paths.len() as u32,
        total_bytes_freed,
        failed_paths,
        outcomes: Some(outcomes),
        interrupted: Some(cancelled.load(Ordering::Acquire)),
    })
}

fn revalidate_candidate(
    candidate: &ScanCandidate,
    real_root: Option<&Path>,
) -> Result<ScanEntry, PathFailure> {
    let path = Path::new(candidate.entry.path.as_str());
    if let Some(root) = real_root {
        validate_real_parent(path, root)?;
    }
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
                    // A symlinked ancestor can place a lexical-clean path
                    // inside VCS metadata (sub -> repo/.git): check the
                    // canonical path too. JS parity.
                    if guardrails::path_has_protected_vcs_segment(&real_candidate.to_string_lossy())
                    {
                        return Err(path_failure(
                            &candidate.entry.path,
                            FailureReasonCode::ProtectedPath,
                            "candidate resolves inside protected VCS metadata".to_owned(),
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

/// Comparison key for dedupe: lexical-abs path, case-folded where the
/// filesystem folds. A forged plan can smuggle duplicates through spelling
/// variants (`a/../b`, case) that byte-order compare differently. JS parity.
fn dedupe_key(path: &str) -> String {
    let normalized = lexical_abs(Path::new(path)).to_string_lossy().into_owned();
    if cfg!(windows) || cfg!(target_os = "macos") {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn deduplicate_nested_entries(entries: Vec<ScanEntry>) -> Vec<ScanEntry> {
    // Key once per entry - computing inside the comparator would be O(n log n)
    // keys instead of O(n).
    let mut keyed: Vec<(String, ScanEntry)> = entries
        .into_iter()
        .map(|entry| (dedupe_key(&entry.path), entry))
        .collect();
    keyed.sort_by(|left, right| left.0.cmp(&right.0));
    let mut retained: Vec<ScanEntry> = Vec::new();
    let mut retained_exact = std::collections::HashSet::new();
    let mut retained_dirs = std::collections::HashSet::new();
    for (key, entry) in keyed {
        // Exact-path duplicates dedupe too - a crafted plan listing the same
        // path twice would otherwise double-delete and report a phantom
        // "missing" failure. Ancestor probing walks the entry's own parent
        // chain against retained directory keys: O(n * depth), not O(n²).
        // Aligned with the JS deduplicateNestedEntries.
        if retained_exact.contains(&key) {
            continue;
        }
        let mut inside_retained = false;
        let mut current = Path::new(key.as_str()).parent().map(Path::to_path_buf);
        while let Some(dir) = current {
            if retained_dirs.contains(dir.to_string_lossy().as_ref()) {
                inside_retained = true;
                break;
            }
            current = dir.parent().map(Path::to_path_buf);
        }
        if inside_retained {
            continue;
        }
        retained_exact.insert(key.clone());
        if entry.entry_type == EntryType::Directory && !entry.is_symlink {
            retained_dirs.insert(key);
        }
        retained.push(entry);
    }
    retained
}

fn delete_entry(entry: &ScanEntry, real_root: Option<&Path>) -> Result<(), PathFailure> {
    let path = Path::new(entry.path.as_str());

    if let Some(root) = real_root {
        // Shrink the validate-then-delete race: an ancestor swapped for a
        // symlink after revalidation redirects remove_dir_all outside the
        // target. Re-canonicalize the parent right before the delete - the
        // escape window shrinks to the syscall itself. JS parity.
        validate_real_parent(path, root)?;
        // Type-flip check: a real dir swapped for a symlink since validation
        // must not be deleted through or unlinked as the wrong kind.
        match fs::symlink_metadata(path) {
            Ok(meta) => {
                let now_symlink = meta.file_type().is_symlink();
                let now_type = if now_symlink {
                    EntryType::Symlink
                } else if meta.is_dir() {
                    EntryType::Directory
                } else {
                    EntryType::File
                };
                if now_symlink != entry.is_symlink {
                    return Err(path_failure(
                        &entry.path,
                        FailureReasonCode::ChangedSymlinkState,
                        "entry symlink state changed since validation".to_owned(),
                    ));
                }
                if now_type != entry.entry_type {
                    return Err(path_failure(
                        &entry.path,
                        FailureReasonCode::ChangedEntryType,
                        "entry type changed since validation".to_owned(),
                    ));
                }
            }
            Err(err) => {
                return Err(path_failure(
                    &entry.path,
                    classify_io_error(&err),
                    err.to_string(),
                ));
            }
        }
    }

    let result = if entry.is_symlink {
        // Directory junctions and dir symlinks on Windows are dir reparse
        // points - remove_file refuses them, so fall back to remove_dir
        // (deletes the link itself, never the target). Matches the JS
        // unlink -> rmdir fallback.
        fs::remove_file(path).or_else(|_| fs::remove_dir(path))
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

/// Unlink never follows a leaf symlink, but it does resolve its ancestors.
/// Share this check between revalidation and the destructive boundary.
fn validate_real_parent(path: &Path, root: &Path) -> Result<(), PathFailure> {
    let display = path.to_string_lossy();
    let parent = path.parent().ok_or_else(|| {
        path_failure(
            &display,
            FailureReasonCode::OutsideTarget,
            "candidate has no parent".to_owned(),
        )
    })?;
    let real_parent = fs::canonicalize(parent)
        .map_err(|err| path_failure(&display, classify_io_error(&err), err.to_string()))?;
    if !real_parent.starts_with(root) {
        return Err(path_failure(
            &display,
            FailureReasonCode::OutsideTarget,
            "parent resolves outside containment root".to_owned(),
        ));
    }
    if guardrails::path_has_protected_vcs_segment(&real_parent.to_string_lossy()) {
        return Err(path_failure(
            &display,
            FailureReasonCode::ProtectedPath,
            "parent resolves inside protected VCS metadata".to_owned(),
        ));
    }
    Ok(())
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

    #[cfg(unix)]
    #[test]
    fn protect_symlink_candidates_beneath_vcs_aliases() {
        let dir = tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let git = dir.path().join(".git");
        fs::create_dir(&git).unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        let kept = dir.path().join("kept");
        fs::write(&kept, "keep").unwrap_or_else(|err| panic!("write failed: {err}"));
        std::os::unix::fs::symlink(&kept, git.join("node_modules"))
            .unwrap_or_else(|err| panic!("symlink failed: {err}"));
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&git, &alias)
            .unwrap_or_else(|err| panic!("symlink failed: {err}"));
        let path = alias.join("node_modules").to_string_lossy().into_owned();
        let selected = candidate(&path, "node_modules", EntryType::Symlink, true);
        let root =
            fs::canonicalize(dir.path()).unwrap_or_else(|err| panic!("canonicalize failed: {err}"));
        let validation = revalidate_candidate(&selected, Some(&root));
        assert!(validation.is_err(), "VCS symlink passed revalidation");
        assert!(
            delete_entry(&selected.entry, Some(&root)).is_err(),
            "VCS symlink passed delete-time checks"
        );
        assert!(fs::symlink_metadata(git.join("node_modules")).is_ok());
        assert!(kept.exists());
    }

    #[test]
    fn cancellation_preserves_first_operation_and_partitions_nested_selections() {
        let dir = tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let first = dir.path().join("a");
        let nested = first.join("nested");
        let last = dir.path().join("z");
        fs::create_dir_all(&nested).unwrap_or_else(|e| panic!("mkdir: {e}"));
        fs::create_dir_all(&last).unwrap_or_else(|e| panic!("mkdir: {e}"));
        let mut plan = ScanPlan::empty(dir.path().to_string_lossy().into_owned(), "test");
        plan.candidates = vec![
            candidate(&first.to_string_lossy(), "a", EntryType::Directory, false),
            candidate(
                &nested.to_string_lossy(),
                "nested",
                EntryType::Directory,
                false,
            ),
            candidate(&last.to_string_lossy(), "z", EntryType::Directory, false),
        ];
        plan.selected_candidate_ids = plan.candidates.iter().map(|c| c.id.clone()).collect();
        let cancel = AtomicBool::new(false);
        let report = apply_plan_controlled(&plan, &cancel, &mut |_| {
            cancel.store(true, Ordering::Release)
        })
        .unwrap_or_else(|e| panic!("apply: {e}"));
        assert_eq!(report.deleted_count, 1);
        assert_eq!(report.interrupted, Some(true));
        assert!(!first.exists());
        assert!(last.exists());
        let outcomes = report
            .outcomes
            .unwrap_or_else(|| panic!("missing outcomes"));
        assert_eq!(
            outcomes
                .iter()
                .map(|o| o.status.as_str())
                .collect::<Vec<_>>(),
            vec!["deleted", "covered", "unattempted"]
        );
        assert_eq!(outcomes[1].covered_by.as_deref(), Some("cand_a"));
    }

    fn candidate(path: &str, name: &str, entry_type: EntryType, is_symlink: bool) -> ScanCandidate {
        ScanCandidate {
            entry: ScanEntry {
                path: path.to_owned(),
                name: name.to_owned(),
                estimated_bytes: 0,
                bytes_known: None,
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
                        bytes_known: None,
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
                    bytes_known: None,
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
