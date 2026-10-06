//! Serde models aligned with `@kitsunekode/sweep-protocol`.

pub const PROTOCOL_VERSION: &str = "1";

/// Logical operation bounds. Defaults match the TypeScript protocol package.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ScanLimits {
    pub max_candidates: u32,
    pub max_directories: u32,
    pub max_queued_dirs: u32,
    pub max_identities: u32,
    pub max_path_bytes: u32,
    pub max_retained_bytes: u32,
    pub max_combined_bytes: u32,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_candidates: 100_000,
            max_directories: 250_000,
            max_queued_dirs: 32_768,
            max_identities: 500_000,
            max_path_bytes: 64 * 1024 * 1024,
            max_retained_bytes: 128 * 1024 * 1024,
            max_combined_bytes: 256 * 1024 * 1024,
        }
    }
}

/// Returns the active sweep protocol version string.
pub fn protocol_version() -> &'static str {
    PROTOCOL_VERSION
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepConfig {
    pub patterns: Vec<String>,
    #[serde(rename = "disabledPatterns", default)]
    pub disabled_patterns: Vec<String>,
    pub ignore: Vec<String>,
    #[serde(rename = "maxSizeGB")]
    pub max_size_gb: f64,
    pub depth: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskTier {
    Safe,
    Caution,
    Dangerous,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectionMode {
    Default,
    Safe,
    All,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionPolicy {
    pub mode: SelectionMode,
    pub include_dangerous: bool,
}

impl Default for SelectionPolicy {
    fn default() -> Self {
        Self {
            mode: SelectionMode::Default,
            include_dangerous: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesystemIdentity {
    pub platform: String,
    pub device: String,
    pub inode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<FilesystemIdentity>,
    pub path: String,
    pub name: String,
    pub estimated_bytes: u64,
    /// `Some(false)` when sizing hit unreadable inodes - `estimated_bytes` is
    /// a partial sum. `None` on wire means an old producer (treated as known).
    /// New scans always emit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_known: Option<bool>,
    /// Last-modified time of the artifact itself, in epoch milliseconds.
    /// Omitted from JSON when the stat failed, matching the TS protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
    pub is_symlink: bool,
    pub entry_type: EntryType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCandidate {
    #[serde(flatten)]
    pub entry: ScanEntry,
    pub id: String,
    pub kind: String,
    pub risk_tier: RiskTier,
    pub reasons: Vec<String>,
    pub selected_by_default: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RiskCounts {
    pub safe: u32,
    pub caution: u32,
    pub dangerous: u32,
    pub blocked: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPlanSummary {
    pub candidate_count: u32,
    pub estimated_total_bytes: u64,
    pub scanned_dirs: u32,
    /// Unreadable or deduped directories. The JS engine omits the key at
    /// zero; `skip_serializing_if` keeps the wire shape identical.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub skipped_dirs: u32,
    pub exact: bool,
    pub selected_count: u32,
    pub risk_counts: RiskCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPlan {
    pub protocol_version: String,
    pub target_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_identity: Option<FilesystemIdentity>,
    pub selection_policy: SelectionPolicy,
    pub candidates: Vec<ScanCandidate>,
    pub summary: ScanPlanSummary,
    pub selected_candidate_ids: Vec<String>,
    pub created_at: String,
}

impl ScanPlan {
    pub fn empty(target_dir: impl Into<String>, created_at: impl Into<String>) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: target_dir.into(),
            target_identity: None,
            selection_policy: SelectionPolicy::default(),
            candidates: Vec::new(),
            summary: ScanPlanSummary {
                candidate_count: 0,
                estimated_total_bytes: 0,
                scanned_dirs: 0,
                skipped_dirs: 0,
                exact: true,
                selected_count: 0,
                risk_counts: RiskCounts::default(),
            },
            selected_candidate_ids: Vec::new(),
            created_at: created_at.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathFailure {
    pub path: String,
    pub code: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub candidate_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub covered_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub protocol_version: String,
    pub target_dir: String,
    pub selected_candidate_ids: Vec<String>,
    pub deleted_count: u32,
    pub failed_count: u32,
    pub total_bytes_freed: u64,
    pub failed_paths: Vec<PathFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcomes: Option<Vec<ApplyOutcome>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
}

impl ApplyReport {
    pub fn empty(plan: &ScanPlan) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            target_dir: plan.target_dir.clone(),
            selected_candidate_ids: plan.selected_candidate_ids.clone(),
            deleted_count: 0,
            failed_count: 0,
            total_bytes_freed: 0,
            failed_paths: Vec::new(),
            outcomes: Some(Vec::new()),
            interrupted: Some(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_matches_typescript_protocol() {
        assert_eq!(protocol_version(), "1");
        assert_eq!(PROTOCOL_VERSION, "1");
    }

    #[test]
    fn scan_plan_serializes_with_camel_case_fields() {
        let plan = ScanPlan::empty("/tmp/project", "2026-01-01T00:00:00.000Z");
        let json = serde_json::to_value(&plan).unwrap_or_else(|err| {
            panic!("failed to serialize ScanPlan: {err}");
        });

        assert_eq!(json["protocolVersion"], "1");
        assert_eq!(json["targetDir"], "/tmp/project");
        assert!(json["candidates"].is_array());
        assert!(json["summary"]["riskCounts"]["safe"].is_number());
    }
}
