//! Sweep engine library for scan and apply flows.

mod apply;
mod guardrails;

use camino::Utf8Path;
use chrono::SecondsFormat;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use sweep_errors::EngineError;
use sweep_fs::{
    apply_size_estimates_with_budget, walk_matched_entries_with_budget, ResourceBudget, WalkConfig,
    WalkEntry, WalkHooks,
};
use sweep_types::{
    ApplyReport, EntryType, RiskTier, ScanCandidate, ScanPlan, ScanPlanSummary, SelectionMode,
    SelectionPolicy, SweepConfig, PROTOCOL_VERSION,
};

/// Options controlling scan behavior (exact sizing, progressive hooks).
#[derive(Default)]
pub struct ScanOptions<'a> {
    pub exact: bool,
    pub hooks: ScanHooks<'a>,
    pub limits: sweep_types::ScanLimits,
}

/// `(scanned_dirs, found, skipped_dirs, current_dir)` - aligned with the
/// JS `onProgress({ scannedDirs, found, skippedDirs, currentDir })`
/// payload; `current_dir` is the path being walked.
pub type OnProgress<'a> = dyn Fn(u32, u32, u32, &Utf8Path) + Sync + 'a;

/// Progressive scan callbacks aligned with the JS scanner hooks.
///
/// Callbacks are `Fn + Sync` so the rayon walk can emit matches from worker threads.
#[derive(Default)]
pub struct ScanHooks<'a> {
    pub on_entry: Option<&'a (dyn Fn(ScanCandidate) + Sync)>,
    pub on_entry_sized: Option<&'a (dyn Fn(ScanCandidate) + Sync)>,
    pub on_progress: Option<&'a OnProgress<'a>>,
}

/// Scan `target_dir` with default patterns and produce a protocol-aligned [`ScanPlan`].
pub fn scan_to_plan(target_dir: &Utf8Path) -> Result<ScanPlan, EngineError> {
    scan_to_plan_with_config(
        target_dir,
        &WalkConfig::default(),
        &SelectionPolicy::default(),
        ScanOptions::default(),
    )
}

/// Scan with explicit walk and selection configuration.
pub fn scan_to_plan_with_config(
    target_dir: &Utf8Path,
    walk_config: &WalkConfig,
    selection_policy: &SelectionPolicy,
    options: ScanOptions<'_>,
) -> Result<ScanPlan, EngineError> {
    if target_dir.as_str().is_empty() {
        return Err(EngineError::InvalidPlan {
            message: "target directory must not be empty".to_owned(),
        });
    }
    // JS parity: loadConfig rejects depth < -1. The walk would otherwise
    // answer invalid input with a successful empty plan - the "nothing to
    // clean" direction is the dangerous one.
    if walk_config.depth < -1 {
        return Err(EngineError::InvalidPlan {
            message: format!(
                "depth must be -1 or a non-negative integer (got {})",
                walk_config.depth
            ),
        });
    }

    guardrails::assert_safe_cwd(target_dir.as_str())?;

    let meta = std::fs::symlink_metadata(target_dir).map_err(|err| EngineError::InvalidPlan {
        message: format!("cannot read scan root {target_dir}: {err}"),
    })?;
    if !meta.is_dir() || meta.is_symlink() {
        return Err(EngineError::InvalidPlan {
            message: format!("scan root is not a real directory: {target_dir}"),
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(EngineError::InvalidPlan {
                message: format!("scan root is a reparse point: {target_dir}"),
            });
        }
    }
    // Failure at the root is different from skipped subdirectories. Do not
    // turn an unreadable root into a successful empty cleanup plan.
    std::fs::read_dir(target_dir).map_err(|err| EngineError::InvalidPlan {
        message: format!("cannot read scan root {target_dir}: {err}"),
    })?;

    let budget = ResourceBudget::new(options.limits);
    let on_entry = options.hooks.on_entry;
    let on_progress = options.hooks.on_progress;
    let on_entry_sized = options.hooks.on_entry_sized;
    let found = std::sync::atomic::AtomicU32::new(0);

    // Sizer workers consume discoveries over this channel while the walk is
    // still running, so `on_entry_sized` fires as each in-process size job
    // resolves instead of every candidate popping in one burst after
    // traversal - the JS scanner's ProgressiveSizer shape, on real threads.
    let progressive = on_entry_sized.is_some();
    // Bounded for backpressure: the walk stalls if it outruns the sizers by a
    // few chunks instead of queueing every candidate in memory.
    let (entry_tx, entry_rx) = mpsc::sync_channel::<WalkEntry>(SIZER_QUEUE_BOUND);
    let shared = SizerShared {
        results: Mutex::new(HashMap::new()),
        emit_sized: on_entry_sized,
    };
    let walk = std::thread::scope(|scope| {
        // A single dispatcher feeds the shared eight-thread sizing pool.
        // Both candidate jobs and nested directory jobs use that pool; no
        // size job parks a Rayon worker waiting for discovery or queue space.
        let sizer = if progressive {
            let shared_ref = &shared;
            let exact = options.exact;
            let budget = &budget;
            Some(scope.spawn(move || {
                sweep_fs::size_entries_progressively_with_budget(
                    entry_rx,
                    exact,
                    &|entry, size| record_sized(shared_ref, entry, size),
                    budget,
                )
            }))
        } else {
            None
        };
        // Scoped so the closures - and their borrow of `entry_tx` - drop before
        // the sender does below.
        let walk = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let on_match = |entry: &WalkEntry| {
                found.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if let Some(cb) = on_entry {
                    cb(to_candidate(
                        entry,
                        sweep_fs::SubtreeSize {
                            bytes: 0,
                            complete: false,
                        },
                    ));
                }
                // The found line is fully buffered before the entry reaches a
                // sizer - an update can never overtake its own discovery event.
                if progressive {
                    let _ = entry_tx.send(entry.clone());
                }
            };
            let on_dir = |dirs: u32, skipped_dirs: u32, dir: &Utf8Path| {
                if let Some(cb) = on_progress {
                    cb(
                        dirs,
                        found.load(std::sync::atomic::Ordering::Relaxed),
                        skipped_dirs,
                        dir,
                    );
                }
            };
            let hooks = WalkHooks {
                on_match: Some(&on_match),
                on_dir: Some(&on_dir),
            };
            walk_matched_entries_with_budget(target_dir, walk_config, Some(&hooks), &budget)
        }));
        // Dropping the sender closes the channel so the sizers drain and exit.
        drop(entry_tx);
        if let Some(handle) = sizer {
            if let Err(payload) = handle.join() {
                std::panic::resume_unwind(payload);
            }
        }
        match walk {
            Ok(walk) => walk,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    });
    if let Some(message) = budget.error() {
        return Err(EngineError::ResourceLimit { message });
    }
    let mut entries = walk.entries;
    let scanned_dirs = walk.scanned_dirs;
    let skipped_dirs = walk.skipped_dirs;

    if progressive {
        apply_progressive_sizes(&mut entries, &shared)?;
    } else {
        apply_size_estimates_with_budget(&mut entries, options.exact, &budget);
    }

    if let Some(message) = budget.error() {
        return Err(EngineError::ResourceLimit { message });
    }
    let candidates: Vec<ScanCandidate> = entries
        .into_iter()
        .map(|entry| {
            to_candidate(
                &entry,
                sweep_fs::SubtreeSize {
                    bytes: entry.estimated_bytes,
                    complete: entry.bytes_known,
                },
            )
        })
        .collect();

    build_plan(
        target_dir.as_str(),
        candidates,
        scanned_dirs,
        skipped_dirs,
        selection_policy,
        options.exact,
    )
}

/// `(entry, bytes)` -> emit a sized candidate event.
type OnSized<'a> = dyn Fn(ScanCandidate) + Sync + 'a;

/// Shared state between the sizer dispatcher and its scoped worker threads.
struct SizerShared<'a> {
    /// path -> resolved size; authoritative for the final plan's sizes.
    results: Mutex<HashMap<String, sweep_fs::SubtreeSize>>,
    emit_sized: Option<&'a OnSized<'a>>,
}

/// Discoveries wait in a bounded channel before the dispatcher admits at
/// most 32 candidate jobs onto the shared sizing pool.
const SIZER_QUEUE_BOUND: usize = 256;

fn record_sized(shared: &SizerShared, entry: &WalkEntry, size: sweep_fs::SubtreeSize) {
    shared
        .results
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(entry.path.as_str().to_owned(), size);
    if let Some(emit) = shared.emit_sized {
        emit(to_candidate(entry, size));
    }
}

/// Consume sizing results as entries are finalized, releasing duplicate paths.
fn apply_progressive_sizes(
    entries: &mut [WalkEntry],
    shared: &SizerShared,
) -> Result<(), EngineError> {
    let mut results = shared.results.lock().unwrap_or_else(|p| p.into_inner());
    for entry in entries {
        let size = results
            .remove(entry.path.as_str())
            .ok_or_else(|| EngineError::InvalidPlan {
                message: format!("sizer did not report {}", entry.path),
            })?;
        entry.estimated_bytes = size.bytes;
        entry.bytes_known = size.complete;
    }
    Ok(())
}

/// Scan with protocol [`SweepConfig`] and selection policy from the JS bridge.
pub fn scan_to_plan_with_sweep_config(
    target_dir: &Utf8Path,
    config: &SweepConfig,
    selection_policy: &SelectionPolicy,
    options: ScanOptions<'_>,
) -> Result<ScanPlan, EngineError> {
    guardrails::assert_safe_config_patterns(config)?;
    scan_to_plan_with_config(
        target_dir,
        &WalkConfig::from(config),
        selection_policy,
        options,
    )
}

/// Apply a previously produced [`ScanPlan`] and return an [`ApplyReport`].
pub fn apply_plan(plan: &ScanPlan) -> Result<ApplyReport, EngineError> {
    apply::apply_plan(plan)
}

pub use apply::{apply_plan_controlled, apply_plan_controlled_with_limit};

fn build_plan(
    target_dir: &str,
    candidates: Vec<ScanCandidate>,
    scanned_dirs: u32,
    skipped_dirs: u32,
    selection_policy: &SelectionPolicy,
    exact: bool,
) -> Result<ScanPlan, EngineError> {
    let selected_candidate_ids = compile_selected_candidate_ids(&candidates, selection_policy);
    let estimated_total_bytes = candidates
        .iter()
        .try_fold(0u64, |total, c| {
            total
                .checked_add(c.entry.estimated_bytes)
                .filter(|&n| n <= 9_007_199_254_740_991)
        })
        .ok_or_else(|| EngineError::ResourceLimit {
            message: "byte counter overflow; scan is incomplete".to_owned(),
        })?;
    let risk_counts = count_risk_tiers(&candidates);
    let candidate_count =
        u32::try_from(candidates.len()).map_err(|_| EngineError::ResourceLimit {
            message: "candidate counter overflow".to_owned(),
        })?;
    let selected_count =
        u32::try_from(selected_candidate_ids.len()).map_err(|_| EngineError::ResourceLimit {
            message: "selection counter overflow".to_owned(),
        })?;
    // `exact` advertises byte-accurate totals; a partial subtree silently
    // undercounts, so unknown candidates demote the claim.
    let exact = exact
        && candidates
            .iter()
            .all(|c| c.entry.bytes_known != Some(false));

    Ok(ScanPlan {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        target_dir: target_dir.to_owned(),
        selection_policy: selection_policy.clone(),
        candidates,
        summary: ScanPlanSummary {
            candidate_count,
            estimated_total_bytes,
            scanned_dirs,
            skipped_dirs,
            exact,
            selected_count,
            risk_counts,
        },
        selected_candidate_ids,
        created_at: iso_timestamp_now(),
    })
}

fn iso_timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn to_candidate(entry: &WalkEntry, size: sweep_fs::SubtreeSize) -> ScanCandidate {
    let path = entry.path.as_str().to_owned();
    let id = format!("cand_{}", hash_string(&format!("{}:{}", path, entry.name)));
    let kind = candidate_kind_from_name(&entry.name);
    let risk_tier = infer_risk_tier(&path, entry.is_symlink, &entry.name);
    let reasons = infer_reasons(&path, entry.is_symlink, &entry.name);
    let selected_by_default = risk_tier == RiskTier::Safe;

    ScanCandidate {
        entry: sweep_types::ScanEntry {
            path,
            name: entry.name.clone(),
            estimated_bytes: size.bytes,
            bytes_known: Some(size.complete),
            modified_ms: entry.modified_ms,
            is_symlink: entry.is_symlink,
            entry_type: match entry.entry_type {
                sweep_fs::WalkEntryType::File => EntryType::File,
                sweep_fs::WalkEntryType::Directory => EntryType::Directory,
                sweep_fs::WalkEntryType::Symlink => EntryType::Symlink,
            },
        },
        id,
        kind,
        risk_tier,
        reasons,
        selected_by_default,
    }
}

fn compile_selected_candidate_ids(
    candidates: &[ScanCandidate],
    selection_policy: &SelectionPolicy,
) -> Vec<String> {
    candidates
        .iter()
        .filter(|candidate| should_select_candidate(candidate, selection_policy))
        .map(|candidate| candidate.id.clone())
        .collect()
}

fn should_select_candidate(candidate: &ScanCandidate, selection_policy: &SelectionPolicy) -> bool {
    if candidate.risk_tier == RiskTier::Blocked {
        return false;
    }
    if candidate.risk_tier == RiskTier::Dangerous && !selection_policy.include_dangerous {
        return false;
    }

    match selection_policy.mode {
        SelectionMode::None => false,
        SelectionMode::Safe => candidate.risk_tier == RiskTier::Safe,
        SelectionMode::All => true,
        SelectionMode::Default => candidate.selected_by_default,
    }
}

fn count_risk_tiers(candidates: &[ScanCandidate]) -> sweep_types::RiskCounts {
    let mut counts = sweep_types::RiskCounts::default();
    for candidate in candidates {
        match candidate.risk_tier {
            RiskTier::Safe => counts.safe += 1,
            RiskTier::Caution => counts.caution += 1,
            RiskTier::Dangerous => counts.dangerous += 1,
            RiskTier::Blocked => counts.blocked += 1,
        }
    }
    counts
}

fn candidate_kind_from_name(name: &str) -> String {
    match name {
        "node_modules" | "dist" | "build" | "out" | ".next" | ".nuxt" | ".svelte-kit"
        | ".turbo" | ".vite" | ".parcel-cache" | "target" | "coverage" | ".nyc_output" => {
            name.to_owned()
        }
        _ if name.ends_with(".tsbuildinfo") => "tsbuildinfo".to_owned(),
        _ => "custom".to_owned(),
    }
}

fn infer_risk_tier(path: &str, is_symlink: bool, name: &str) -> RiskTier {
    if guardrails::path_has_protected_vcs_segment(path) {
        RiskTier::Blocked
    } else if is_symlink {
        RiskTier::Caution
    } else if sweep_fs::catalog_match_for(name) == Some(sweep_fs::CatalogMatch::Default) {
        // Only names a shipping-default pattern covers earn the safe tier.
        // Opt-in catalog names (dist, build, out, coverage, ...) are dangerous
        // for the same reason they are opt-in - the name can hold authored
        // files. Enabling a pattern consents to scanning, never selection.
        RiskTier::Safe
    } else {
        RiskTier::Dangerous
    }
}

fn infer_reasons(path: &str, is_symlink: bool, name: &str) -> Vec<String> {
    let mut reasons = Vec::new();
    if guardrails::path_has_protected_vcs_segment(path) {
        reasons.push("protected-vcs-path".to_owned());
    }
    if is_symlink {
        reasons.push("symlink".to_owned());
    }
    match sweep_fs::catalog_match_for(name) {
        Some(sweep_fs::CatalogMatch::Default) => reasons.push("default-pattern".to_owned()),
        Some(sweep_fs::CatalogMatch::OptIn) => reasons.push("opt-in-pattern".to_owned()),
        None => reasons.push("custom-pattern".to_owned()),
    }
    reasons
}

/// SHA-256 hash aligned with the JS reference (`planner.ts` `hashString`).
fn hash_string(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    // sha2 0.11 returns hybrid_array::Array, which dropped LowerHex; encode the
    // eight bytes the 16-char prefix actually uses.
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_scan_root_is_a_failure() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        let path = dir.path().join("missing");
        let root = Utf8Path::from_path(&path).unwrap_or_else(|| panic!("fixture path not UTF-8"));
        assert!(scan_to_plan(root).is_err());
    }

    #[test]
    fn a_discovery_panic_closes_the_progressive_sizing_channel() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir failed: {err}"));
        std::fs::create_dir(dir.path().join("node_modules"))
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        let root =
            Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("fixture path not UTF-8"));
        let on_entry = |_: ScanCandidate| panic!("injected discovery failure");
        let on_sized = |_: ScanCandidate| {};
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = scan_to_plan_with_config(
                root,
                &WalkConfig::default(),
                &SelectionPolicy::default(),
                ScanOptions {
                    exact: false,
                    hooks: ScanHooks {
                        on_entry: Some(&on_entry),
                        on_entry_sized: Some(&on_sized),
                        on_progress: None,
                    },
                    ..ScanOptions::default()
                },
            );
        }));
        assert!(result.is_err());
    }
    use sweep_errors::GuardrailError;
    use tempfile::tempdir;

    #[test]
    fn hash_string_matches_js_reference_for_ascii_path() {
        let sample = "/tmp/project/node_modules:node_modules";
        assert_eq!(hash_string(sample), "6b664301bddbfa84");
    }

    #[test]
    fn scan_to_plan_finds_node_modules_directory() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let nm_path = root.join("node_modules");
        std::fs::create_dir_all(nm_path.as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let plan = scan_to_plan(root).unwrap_or_else(|err| panic!("scan failed: {err}"));
        assert_eq!(plan.protocol_version, PROTOCOL_VERSION);
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].entry.name, "node_modules");
        assert_ne!(plan.created_at, "1970-01-01T00:00:00.000Z");

        let expected_id = format!(
            "cand_{}",
            hash_string(&format!("{}:node_modules", nm_path.as_str()))
        );
        assert_eq!(plan.candidates[0].id, expected_id);
    }

    /// A subtree the sizer cannot fully read keeps partial bytes but must
    /// admit it: `bytes_known` flips false and `summary.exact` demotes, so the
    /// host never presents an undercount as a byte-accurate total.
    #[test]
    #[cfg(unix)]
    fn plan_marks_unreadable_subtree_size_unknown() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        let nm = root.join("node_modules");
        let locked = nm.join("locked");
        std::fs::create_dir_all(locked.as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
        std::fs::write(locked.join("hidden.bin").as_std_path(), vec![0u8; 32])
            .unwrap_or_else(|err| panic!("write failed: {err}"));
        std::fs::set_permissions(locked.as_std_path(), std::fs::Permissions::from_mode(0o000))
            .unwrap_or_else(|err| panic!("chmod failed: {err}"));

        // Root / ACL-less platforms ignore the lock - nothing to assert then.
        if std::fs::read_dir(locked.as_std_path()).is_err() {
            let options = ScanOptions {
                exact: true,
                ..ScanOptions::default()
            };
            let plan = scan_to_plan_with_config(
                root,
                &WalkConfig::default(),
                &SelectionPolicy::default(),
                options,
            )
            .unwrap_or_else(|err| panic!("scan failed: {err}"));
            std::fs::set_permissions(locked.as_std_path(), std::fs::Permissions::from_mode(0o700))
                .unwrap_or_else(|err| panic!("restore chmod failed: {err}"));

            assert_eq!(plan.candidates.len(), 1);
            assert_eq!(
                plan.candidates[0].entry.bytes_known,
                Some(false),
                "partial subtree must report bytes_known=false"
            );
            assert!(
                !plan.summary.exact,
                "exact must demote when any candidate size is unknown"
            );
        } else {
            std::fs::set_permissions(locked.as_std_path(), std::fs::Permissions::from_mode(0o700))
                .unwrap_or_else(|err| panic!("restore chmod failed: {err}"));
        }
    }

    #[test]
    fn opt_in_catalog_names_are_dangerous_never_preselected() {
        // A curated name like `dist` can hold authored files - that is exactly
        // why it ships disabled. Enabling the pattern consents to scanning for
        // it, not to selecting it (JS `inferRiskTier` parity).
        for name in ["dist", "build", "out", "coverage", "pkg.egg-info"] {
            let tier = infer_risk_tier("/tmp/proj/x", false, name);
            assert_eq!(tier, RiskTier::Dangerous, "{name} should be dangerous");
            let reasons = infer_reasons("/tmp/proj/x", false, name);
            assert!(
                reasons.iter().any(|reason| reason == "opt-in-pattern"),
                "{name} should carry opt-in-pattern reason, got {reasons:?}"
            );
        }
    }

    #[test]
    fn default_catalog_name_keeps_safe_tier_regardless_of_match_source() {
        let tier = infer_risk_tier("/tmp/proj/x", false, "node_modules");
        assert_eq!(tier, RiskTier::Safe);
        let reasons = infer_reasons("/tmp/proj/x", false, "node_modules");
        assert!(reasons.iter().any(|reason| reason == "default-pattern"));
    }

    #[test]
    fn unknown_names_stay_dangerous_with_custom_reason() {
        let tier = infer_risk_tier("/tmp/proj/x", false, "my-cache");
        assert_eq!(tier, RiskTier::Dangerous);
        let reasons = infer_reasons("/tmp/proj/x", false, "my-cache");
        assert!(reasons.iter().any(|reason| reason == "custom-pattern"));
    }

    #[test]
    fn scan_to_plan_rejects_shallow_target() {
        match scan_to_plan(Utf8Path::new("/tmp")) {
            Err(EngineError::Guardrail(_)) => {}
            other => panic!("expected guardrail error, got {other:?}"),
        }
    }

    #[test]
    fn progressive_hooks_fire_before_sizing_completes() {
        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        std::fs::create_dir_all(root.join("node_modules").as_std_path())
            .unwrap_or_else(|err| panic!("mkdir failed: {err}"));

        let order = std::sync::Mutex::new(Vec::<&'static str>::new());
        let on_entry = |_candidate: ScanCandidate| {
            if let Ok(mut steps) = order.lock() {
                steps.push("entry");
            }
        };
        let on_entry_sized = |_candidate: ScanCandidate| {
            if let Ok(mut steps) = order.lock() {
                steps.push("sized");
            }
        };

        let hooks = ScanHooks {
            on_entry: Some(&on_entry),
            on_entry_sized: Some(&on_entry_sized),
            on_progress: None,
        };

        scan_to_plan_with_config(
            root,
            &WalkConfig::default(),
            &SelectionPolicy::default(),
            ScanOptions {
                exact: false,
                hooks,
                ..ScanOptions::default()
            },
        )
        .unwrap_or_else(|err| panic!("scan failed: {err}"));

        let order = order.into_inner().unwrap_or_else(|err| err.into_inner());
        assert!(order.contains(&"entry"));
        assert!(order.contains(&"sized"));
        assert!(
            order.iter().position(|&step| step == "entry")
                < order.iter().position(|&step| step == "sized")
        );
    }

    /// Regression: sized events must interleave with discoveries, not burst at
    /// the end. Under the old post-walk sizing phase every `sized` landed after
    /// the last `entry`. Timing alone can't pin this (a fast walk can finish
    /// before a size job resolves), so the walk-side callback blocks once at
    /// entry 30 until the sizer has emitted at least one update - if the old
    /// behavior returns, no update can fire while the walk is stalled and the
    /// timeout fails the test. `exact` mode keeps sizing work tiny so the
    /// interleave doesn't depend on filesystem latency.
    #[test]
    fn sized_events_interleave_with_discoveries() {
        use std::sync::{Condvar, Mutex as StdMutex};
        use std::time::{Duration, Instant};

        let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| {
            panic!("tempdir path is not valid UTF-8");
        });
        const COUNT: usize = 100;
        for index in 0..COUNT {
            let path = root.join(format!("pkg-{index:03}/node_modules"));
            std::fs::create_dir_all(path.as_std_path())
                .unwrap_or_else(|err| panic!("mkdir failed: {err}"));
            std::fs::write(path.join("dep.js").as_std_path(), b"x")
                .unwrap_or_else(|err| panic!("write failed: {err}"));
        }

        let order = StdMutex::new(Vec::<&'static str>::new());
        let sized_gate = StdMutex::new(false);
        let sized_ready = Condvar::new();
        let entry_count = std::sync::atomic::AtomicUsize::new(0);

        let on_entry = |_candidate: ScanCandidate| {
            if let Ok(mut steps) = order.lock() {
                steps.push("entry");
            }
            // Once 30 discoveries are queued the sizer has work; park every
            // producer (all rayon walk threads run this callback) until the
            // sizer proves it is live. Gating a single thread lets sibling
            // workers finish the walk anyway, which is exactly the regression
            // this test exists to catch.
            if entry_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 >= 30 {
                let gate = sized_gate
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut gate = gate;
                while !*gate {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    let (guard, _) = sized_ready
                        .wait_timeout(gate, remaining)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    gate = guard;
                }
            }
        };
        let on_entry_sized = |_candidate: ScanCandidate| {
            if let Ok(mut steps) = order.lock() {
                steps.push("sized");
            }
            if let Ok(mut gate) = sized_gate.lock() {
                *gate = true;
            }
            sized_ready.notify_all();
        };
        let hooks = ScanHooks {
            on_entry: Some(&on_entry),
            on_entry_sized: Some(&on_entry_sized),
            on_progress: None,
        };

        let plan = scan_to_plan_with_config(
            root,
            &WalkConfig::default(),
            &SelectionPolicy::default(),
            ScanOptions {
                exact: true,
                hooks,
                ..ScanOptions::default()
            },
        )
        .unwrap_or_else(|err| panic!("scan failed: {err}"));

        let order = order.into_inner().unwrap_or_else(|err| err.into_inner());
        let entries = order.iter().filter(|&&s| s == "entry").count();
        let sized = order.iter().filter(|&&s| s == "sized").count();
        let first_sized = order.iter().position(|&s| s == "sized");
        let last_entry = order.iter().rposition(|&s| s == "entry");

        assert_eq!(entries, COUNT);
        // Every candidate gets exactly one size update - no stub left at 0.
        assert_eq!(sized, COUNT);
        assert!(plan.candidates.iter().all(|c| c.entry.estimated_bytes > 0));
        // Interleave proof: sizing started while discovery was still running.
        assert!(
            first_sized < last_entry,
            "sized events arrived only after the walk finished (first sized at \
             {first_sized:?}, last entry at {last_entry:?})"
        );
    }

    #[test]
    fn resource_failures_reject_both_streaming_and_final_scans() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        for name in ["node_modules", "target"] {
            std::fs::create_dir(dir.path().join(name)).unwrap_or_else(|e| panic!("fixture: {e}"));
        }
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("encoding"));
        let sized = |_: ScanCandidate| {};
        for progressive in [false, true] {
            let result = scan_to_plan_with_config(
                root,
                &WalkConfig::default(),
                &SelectionPolicy::default(),
                ScanOptions {
                    limits: sweep_types::ScanLimits {
                        max_candidates: 1,
                        ..sweep_types::ScanLimits::default()
                    },
                    hooks: ScanHooks {
                        on_entry_sized: progressive.then_some(&sized),
                        ..ScanHooks::default()
                    },
                    ..ScanOptions::default()
                },
            );
            assert!(result.is_err_and(|e| e.to_string().contains("maxCandidates")));
        }
    }

    #[test]
    fn sizing_does_not_charge_the_walk_admission_budget() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        std::fs::create_dir_all(dir.path().join("node_modules/nested"))
            .unwrap_or_else(|e| panic!("fixture: {e}"));
        let root = Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("encoding"));
        for exact in [false, true] {
            // A candidate's subtree was already admitted when it matched -
            // sizing re-walks it under per-job caps, not cumulative counters.
            let result = scan_to_plan_with_config(
                root,
                &WalkConfig::default(),
                &SelectionPolicy::default(),
                ScanOptions {
                    exact,
                    limits: sweep_types::ScanLimits {
                        max_directories: 2,
                        ..sweep_types::ScanLimits::default()
                    },
                    ..ScanOptions::default()
                },
            );
            assert!(result.is_ok());
        }
    }

    #[test]
    fn apply_plan_rejects_unsupported_protocol_version() {
        let mut plan = ScanPlan::empty("/tmp", "1970-01-01T00:00:00.000Z");
        plan.protocol_version = "99".to_owned();

        match apply_plan(&plan) {
            Err(EngineError::Guardrail(GuardrailError::UnsupportedProtocolVersion { .. })) => {}
            other => panic!("expected unsupported protocol version, got {other:?}"),
        }
    }
}
