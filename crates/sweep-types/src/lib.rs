//! Serde models aligned with `@kitsunekode/sweep-protocol`.

pub const PROTOCOL_VERSION: &str = "1";

fn safe_integer<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = <u64 as serde::Deserialize>::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom(
            "integer exceeds protocol safe-integer bound",
        ));
    }
    Ok(value)
}

fn optional_safe_integer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    safe_integer(deserializer).map(Some)
}

// Optional protocol fields may be absent, but the schemas do not permit null.
fn present_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

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
    pub max_size_gb: Option<f64>,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanEntry {
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub identity: Option<FilesystemIdentity>,
    pub path: String,
    pub name: String,
    #[serde(deserialize_with = "safe_integer")]
    pub estimated_bytes: u64,
    /// `Some(false)` when sizing hit unreadable inodes - `estimated_bytes` is
    /// a partial sum. `None` on wire means an old producer (treated as known).
    /// New scans always emit it.
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub bytes_known: Option<bool>,
    /// Last-modified time of the artifact itself, in epoch milliseconds.
    /// Omitted from JSON when the stat failed, matching the TS protocol.
    #[serde(
        default,
        deserialize_with = "optional_safe_integer",
        skip_serializing_if = "Option::is_none"
    )]
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
#[serde(rename_all = "camelCase", from = "CandidateInput")]
pub struct ScanCandidate {
    #[serde(flatten)]
    pub entry: ScanEntry,
    pub id: String,
    pub kind: String,
    pub risk_tier: RiskTier,
    pub reasons: Vec<String>,
    pub selected_by_default: bool,
}

// Serde does not support deny_unknown_fields with flatten. Keep the public
// entry model and flat serialized shape; explicitly decode the flat input.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidateInput {
    #[serde(default, deserialize_with = "present_value")]
    identity: Option<FilesystemIdentity>,
    path: String,
    name: String,
    #[serde(deserialize_with = "safe_integer")]
    estimated_bytes: u64,
    #[serde(default, deserialize_with = "present_value")]
    bytes_known: Option<bool>,
    #[serde(default, deserialize_with = "optional_safe_integer")]
    modified_ms: Option<u64>,
    is_symlink: bool,
    entry_type: EntryType,
    id: String,
    #[serde(deserialize_with = "artifact_kind")]
    kind: String,
    risk_tier: RiskTier,
    reasons: Vec<String>,
    selected_by_default: bool,
}

fn artifact_kind<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let kind = <String as serde::Deserialize>::deserialize(deserializer)?;
    match kind.as_str() {
        "node_modules" | "dist" | "build" | "out" | ".next" | ".nuxt" | ".svelte-kit"
        | ".turbo" | ".vite" | ".parcel-cache" | "target" | "coverage" | ".nyc_output"
        | "tsbuildinfo" | "custom" => Ok(kind),
        _ => Err(serde::de::Error::custom("unknown artifact kind")),
    }
}

impl From<CandidateInput> for ScanCandidate {
    fn from(input: CandidateInput) -> Self {
        Self {
            entry: ScanEntry {
                identity: input.identity,
                path: input.path,
                name: input.name,
                estimated_bytes: input.estimated_bytes,
                bytes_known: input.bytes_known,
                modified_ms: input.modified_ms,
                is_symlink: input.is_symlink,
                entry_type: input.entry_type,
            },
            id: input.id,
            kind: input.kind,
            risk_tier: input.risk_tier,
            reasons: input.reasons,
            selected_by_default: input.selected_by_default,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanPlanSummary {
    pub candidate_count: u32,
    #[serde(deserialize_with = "safe_integer")]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanPlan {
    pub protocol_version: String,
    pub target_dir: String,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
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

    #[test]
    fn native_plan_input_rejects_schema_drift_and_unsafe_numbers() -> Result<(), serde_json::Error>
    {
        let mut value =
            serde_json::to_value(ScanPlan::empty("/tmp/project", "2026-01-01T00:00:00.000Z"))?;
        value["candidates"] = serde_json::json!([{
            "id": "one", "path": "/tmp/project/dist", "name": "dist",
            "estimatedBytes": 1, "modifiedMs": 1, "isSymlink": false,
            "entryType": "directory", "kind": "dist", "riskTier": "safe",
            "reasons": [], "selectedByDefault": true
        }]);
        assert!(serde_json::from_value::<ScanPlan>(value.clone()).is_ok());
        for pointer in [
            "",
            "/summary",
            "/summary/riskCounts",
            "/selectionPolicy",
            "/candidates/0",
        ] {
            let mut invalid = value.clone();
            if let Some(object) = invalid
                .pointer_mut(pointer)
                .and_then(serde_json::Value::as_object_mut)
            {
                object.insert("unexpected".to_owned(), serde_json::json!(true));
            }
            assert!(
                serde_json::from_value::<ScanPlan>(invalid).is_err(),
                "unknown field at {pointer}"
            );
        }
        for pointer in [
            "/candidates/0/estimatedBytes",
            "/candidates/0/modifiedMs",
            "/summary/estimatedTotalBytes",
        ] {
            let mut invalid = value.clone();
            if let Some(field) = invalid.pointer_mut(pointer) {
                *field = serde_json::json!(9_007_199_254_740_992u64);
            }
            assert!(
                serde_json::from_value::<ScanPlan>(invalid).is_err(),
                "unsafe integer at {pointer}"
            );
        }
        value["candidates"][0]["kind"] = serde_json::json!("unrecognized-artifact");
        assert!(serde_json::from_value::<ScanPlan>(value).is_err());
        Ok(())
    }
}
