//! Sweep engine library for scan and apply flows.

mod apply;

use camino::Utf8Path;
use sha2::{Digest, Sha256};
use sweep_errors::EngineError;
use sweep_fs::{estimate_bytes, walk_matched_entries, WalkConfig, WalkEntryType};
use sweep_types::{
    ApplyReport, EntryType, RiskTier, ScanCandidate, ScanPlan, ScanPlanSummary, SelectionMode,
    SelectionPolicy, SweepConfig, PROTOCOL_VERSION,
};

/// Scan `target_dir` with default patterns and produce a protocol-aligned [`ScanPlan`].
pub fn scan_to_plan(target_dir: &Utf8Path) -> Result<ScanPlan, EngineError> {
    scan_to_plan_with_config(
        target_dir,
        &WalkConfig::default(),
        &SelectionPolicy::default(),
    )
}

/// Scan with explicit walk and selection configuration.
pub fn scan_to_plan_with_config(
    target_dir: &Utf8Path,
    walk_config: &WalkConfig,
    selection_policy: &SelectionPolicy,
) -> Result<ScanPlan, EngineError> {
    if target_dir.as_str().is_empty() {
        return Err(EngineError::InvalidPlan {
            message: "target directory must not be empty".to_owned(),
        });
    }

    let walk = walk_matched_entries(target_dir, walk_config);
    let candidates: Vec<ScanCandidate> = walk.entries.iter().map(to_candidate).collect();

    Ok(build_plan(
        target_dir.as_str(),
        &candidates,
        walk.scanned_dirs,
        selection_policy,
    ))
}

/// Scan with protocol [`SweepConfig`] and selection policy from the JS bridge.
pub fn scan_to_plan_with_sweep_config(
    target_dir: &Utf8Path,
    config: &SweepConfig,
    selection_policy: &SelectionPolicy,
) -> Result<ScanPlan, EngineError> {
    scan_to_plan_with_config(target_dir, &WalkConfig::from(config), selection_policy)
}

/// Apply a previously produced [`ScanPlan`] and return an [`ApplyReport`].
pub fn apply_plan(plan: &ScanPlan) -> Result<ApplyReport, EngineError> {
    apply::apply_plan(plan)
}

fn build_plan(
    target_dir: &str,
    candidates: &[ScanCandidate],
    scanned_dirs: u32,
    selection_policy: &SelectionPolicy,
) -> ScanPlan {
    let selected_candidate_ids = compile_selected_candidate_ids(candidates, selection_policy);
    let estimated_total_bytes: u64 = candidates.iter().map(|c| c.entry.estimated_bytes).sum();
    let risk_counts = count_risk_tiers(candidates);

    ScanPlan {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        target_dir: target_dir.to_owned(),
        selection_policy: selection_policy.clone(),
        candidates: candidates.to_vec(),
        summary: ScanPlanSummary {
            candidate_count: candidates.len() as u32,
            estimated_total_bytes,
            scanned_dirs,
            exact: false,
            selected_count: selected_candidate_ids.len() as u32,
            risk_counts,
        },
        selected_candidate_ids,
        created_at: "1970-01-01T00:00:00.000Z".to_owned(),
    }
}

fn to_candidate(entry: &sweep_fs::WalkEntry) -> ScanCandidate {
    let path = entry.path.as_str().to_owned();
    let id = format!("cand_{}", hash_string(&format!("{}:{}", path, entry.name)));
    let kind = candidate_kind_from_name(&entry.name);
    let risk_tier = infer_risk_tier(entry.is_symlink, &kind);
    let reasons = infer_reasons(entry.is_symlink, &kind);
    let selected_by_default = risk_tier != RiskTier::Dangerous && risk_tier != RiskTier::Blocked;

    ScanCandidate {
        entry: sweep_types::ScanEntry {
            path,
            name: entry.name.clone(),
            estimated_bytes: estimate_bytes(&entry.path),
            is_symlink: entry.is_symlink,
            entry_type: match entry.entry_type {
                WalkEntryType::File => EntryType::File,
                WalkEntryType::Directory => EntryType::Directory,
                WalkEntryType::Symlink => EntryType::Symlink,
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

fn infer_risk_tier(is_symlink: bool, kind: &str) -> RiskTier {
    if is_symlink {
        RiskTier::Caution
    } else if kind == "custom" {
        RiskTier::Dangerous
    } else {
        RiskTier::Safe
    }
}

fn infer_reasons(is_symlink: bool, kind: &str) -> Vec<String> {
    let mut reasons = Vec::new();
    if is_symlink {
        reasons.push("symlink".to_owned());
    }
    if kind == "custom" {
        reasons.push("custom-pattern".to_owned());
    } else {
        reasons.push("default-pattern".to_owned());
    }
    reasons
}

/// SHA-256 hash aligned with the JS reference (`planner.ts` `hashString`).
fn hash_string(input: &str) -> String {
    let result = Sha256::digest(input.as_bytes());
    let hex = format!("{:x}", result);
    hex[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
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

        let expected_id = format!(
            "cand_{}",
            hash_string(&format!("{}:node_modules", nm_path.as_str()))
        );
        assert_eq!(plan.candidates[0].id, expected_id);
    }

    #[test]
    fn apply_plan_rejects_unsupported_protocol_version() {
        let mut plan = ScanPlan::empty("/tmp", "1970-01-01T00:00:00.000Z");
        plan.protocol_version = "99".to_owned();

        let err = apply_plan(&plan).unwrap_err();
        assert!(matches!(
            err,
            EngineError::Guardrail(GuardrailError::UnsupportedProtocolVersion { .. })
        ));
    }
}
