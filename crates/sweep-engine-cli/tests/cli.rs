use assert_cmd::Command;
use sweep_types::{ApplyReport, ScanPlan, PROTOCOL_VERSION};
use tempfile::tempdir;

#[test]
fn scan_subcommand_emits_scan_plan_json() {
    let dir = tempdir().unwrap_or_else(|err| panic!("failed to create tempdir: {err}"));
    let target = dir.path().to_string_lossy().into_owned();

    let output = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .arg("scan")
        .arg(&target)
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine scan: {err}"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let plan: ScanPlan = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|err| panic!("stdout was not valid ScanPlan JSON: {err}"));
    assert_eq!(plan.protocol_version, PROTOCOL_VERSION);
    assert_eq!(plan.target_dir, target);
}

#[test]
fn apply_subcommand_reads_plan_from_stdin() {
    let plan = ScanPlan::empty("/tmp/project", "1970-01-01T00:00:00.000Z");
    let input = serde_json::to_string(&plan).unwrap_or_else(|err| {
        panic!("failed to serialize ScanPlan: {err}");
    });

    let output = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .arg("apply")
        .write_stdin(input.as_bytes())
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine apply: {err}"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let report: ApplyReport = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|err| panic!("stdout was not valid ApplyReport JSON: {err}"));
    assert_eq!(report.protocol_version, PROTOCOL_VERSION);
    assert_eq!(report.target_dir, plan.target_dir);
}
