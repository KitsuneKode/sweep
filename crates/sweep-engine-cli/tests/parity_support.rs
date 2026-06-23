//! Shared helpers for JS/Rust scan plan parity tests.

use camino::Utf8PathBuf;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use sweep_engine::scan_to_plan;
use sweep_types::ScanPlan;

const FIXTURE_ROOT_PLACEHOLDER: &str = "__FIXTURE_ROOT__";

fn stable_candidate_id(path: &str, name: &str) -> String {
    let digest = Sha256::digest(format!("{path}:{name}").as_bytes());
    let hex = format!("{digest:x}");
    format!("cand_{}", &hex[..16])
}

/// Repository-relative path to `tests/fixtures`.
pub fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .canonicalize()
        .unwrap_or_else(|err| panic!("failed to resolve fixtures root: {err}"))
}

pub fn fixture_dir(name: &str) -> PathBuf {
    fixtures_root().join(name)
}

pub fn load_golden_plan(name: &str) -> Value {
    let path = fixture_dir(name).join("expected.plan.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read golden plan at {}: {err}", path.display()));
    let mut value = serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("golden plan at {} is invalid JSON: {err}", path.display()));
    sort_plan_value(&mut value);
    value
}

pub fn run_rust_scan_normalized(name: &str) -> Value {
    let fixture = fixture_dir(name);
    let fixture_utf8 = Utf8PathBuf::from_path_buf(fixture.clone()).unwrap_or_else(|_| {
        panic!("fixture path is not valid UTF-8: {}", fixture.display());
    });

    let plan = scan_to_plan(&fixture_utf8)
        .unwrap_or_else(|err| panic!("rust scan failed for {}: {err}", name));
    normalize_plan_value(&plan, &fixture)
}

pub fn normalize_plan_value(plan: &ScanPlan, fixture_root: &Path) -> Value {
    let root = fixture_root
        .canonicalize()
        .unwrap_or_else(|err| panic!("failed to canonicalize {}: {err}", fixture_root.display()))
        .to_string_lossy()
        .into_owned();

    let mut value = serde_json::to_value(plan)
        .unwrap_or_else(|err| panic!("failed to serialize ScanPlan: {err}"));

    let replace_root = |text: String| -> String {
        if text.starts_with(&root) {
            text.replacen(&root, FIXTURE_ROOT_PLACEHOLDER, 1)
        } else {
            text
        }
    };

    value["targetDir"] = Value::String(FIXTURE_ROOT_PLACEHOLDER.to_owned());
    value["createdAt"] = Value::String("1970-01-01T00:00:00.000Z".to_owned());
    value["summary"]["estimatedTotalBytes"] = Value::Number(0.into());

    let selected_paths: std::collections::HashSet<String> = value
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|candidate| {
            let id = candidate.get("id").and_then(Value::as_str)?;
            let path = candidate.get("path").and_then(Value::as_str)?;
            let selected = value
                .get("selectedCandidateIds")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(Value::as_str)
                .any(|selected_id| selected_id == id);
            if !selected {
                return None;
            }
            Some(replace_root(path.to_owned()))
        })
        .collect();

    if let Some(candidates) = value.get_mut("candidates").and_then(Value::as_array_mut) {
        for candidate in candidates.iter_mut() {
            if let Some(path) = candidate.get("path").and_then(Value::as_str) {
                let normalized_path = replace_root(path.to_owned());
                candidate["path"] = Value::String(normalized_path.clone());
                if let Some(name) = candidate.get("name").and_then(Value::as_str) {
                    candidate["id"] = Value::String(stable_candidate_id(&normalized_path, name));
                }
            }
            candidate["estimatedBytes"] = Value::Number(0.into());
        }
    }

    let selected_ids: Vec<Value> = {
        let candidates = value
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        candidates
            .iter()
            .filter(|candidate| {
                candidate
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| selected_paths.contains(path))
            })
            .filter_map(|candidate| candidate.get("id").cloned())
            .collect()
    };
    if let Some(selected) = value
        .get_mut("selectedCandidateIds")
        .and_then(Value::as_array_mut)
    {
        *selected = selected_ids;
    }

    sort_plan_value(&mut value);

    value
}

fn sort_plan_value(value: &mut Value) {
    if let Some(candidates) = value.get_mut("candidates").and_then(Value::as_array_mut) {
        candidates.sort_by(|left, right| {
            left.get("path")
                .and_then(Value::as_str)
                .cmp(&right.get("path").and_then(Value::as_str))
        });
    }

    let ordered_ids = value
        .get("candidates")
        .and_then(Value::as_array)
        .map(|candidates| {
            let selected: std::collections::HashSet<&str> = value
                .get("selectedCandidateIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();

            candidates
                .iter()
                .filter_map(|candidate| candidate.get("id").and_then(Value::as_str))
                .filter(|id| selected.contains(id))
                .map(|id| Value::String(id.to_owned()))
                .collect::<Vec<_>>()
        });

    if let (Some(ids), Some(ordered)) = (
        value
            .get_mut("selectedCandidateIds")
            .and_then(Value::as_array_mut),
        ordered_ids,
    ) {
        *ids = ordered;
    }
}
