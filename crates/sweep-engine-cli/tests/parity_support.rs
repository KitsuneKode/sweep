//! Shared helpers for JS/Rust scan plan parity tests.

use camino::Utf8PathBuf;
use serde_json::Value;
use std::path::{Path, PathBuf};
use sweep_engine::scan_to_plan;
use sweep_types::ScanPlan;

const FIXTURE_ROOT_PLACEHOLDER: &str = "__FIXTURE_ROOT__";

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
    serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("golden plan at {} is invalid JSON: {err}", path.display()))
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

    if let Some(candidates) = value.get_mut("candidates").and_then(Value::as_array_mut) {
        for candidate in candidates {
            if let Some(path) = candidate.get("path").and_then(Value::as_str) {
                candidate["path"] = Value::String(replace_root(path.to_owned()));
            }
            candidate["estimatedBytes"] = Value::Number(0.into());
        }
    }

    value
}
