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

#[cfg(unix)]
#[test]
fn native_apply_signals_flush_a_complete_interrupted_partition() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;
    for signal in [libc::SIGINT, libc::SIGTERM] {
        let dir = tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        // Enough output to exceed a pipe buffer, so the child cannot finish
        // all removals before the first event is read and the signal sent.
        for i in 0..2000 {
            std::fs::create_dir(dir.path().join(format!("artifact-{i}")))
                .unwrap_or_else(|e| panic!("mkdir: {e}"));
        }
        let root = camino::Utf8Path::from_path(dir.path()).unwrap_or_else(|| panic!("path"));
        let plan = sweep_engine::scan_to_plan_with_config(
            root,
            &sweep_fs::WalkConfig {
                patterns: vec!["artifact-*".to_owned()],
                ignore: vec![],
                depth: -1,
            },
            &sweep_types::SelectionPolicy {
                mode: sweep_types::SelectionMode::All,
                include_dangerous: true,
            },
            sweep_engine::ScanOptions::default(),
        )
        .unwrap_or_else(|e| panic!("scan: {e}"));
        let mut child = std::process::Command::new(assert_cmd::cargo::cargo_bin!("sweep-engine"))
            .args(["apply", "--json-control"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("spawn: {e}"));
        let mut input = child.stdin.take().unwrap_or_else(|| panic!("stdin"));
        writeln!(input, "{}", serde_json::json!({"plan":plan}))
            .unwrap_or_else(|e| panic!("write: {e}"));
        writeln!(input, "{{\"type\":\"start\"}}").unwrap_or_else(|e| panic!("write: {e}"));
        let mut lines =
            BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout"))).lines();
        let mut first_deleted = false;
        while let Some(Ok(line)) = lines.next() {
            let event: serde_json::Value =
                serde_json::from_str(&line).unwrap_or_else(|e| panic!("event: {e}"));
            if event["type"] == "apply_deleted" {
                first_deleted = true;
                break;
            }
        }
        assert!(first_deleted);
        // SAFETY: sends a cancellation signal only to this owned child PID.
        assert_eq!(unsafe { libc::kill(child.id() as libc::pid_t, signal) }, 0);
        let mut report = None;
        for line in lines {
            let event: serde_json::Value =
                serde_json::from_str(&line.unwrap_or_else(|e| panic!("read: {e}")))
                    .unwrap_or_else(|e| panic!("event: {e}"));
            if event["type"] == "apply_completed" {
                report = Some(
                    serde_json::from_value::<ApplyReport>(event["report"].clone())
                        .unwrap_or_else(|e| panic!("report: {e}")),
                );
            }
        }
        drop(input);
        let output = child
            .wait_with_output()
            .unwrap_or_else(|e| panic!("wait: {e}"));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report = report.unwrap_or_else(|| panic!("missing report after signal {signal}"));
        assert_eq!(report.interrupted, Some(true));
        assert!(report.deleted_count > 0 && report.deleted_count < 2000);
        // Cancellation can now interrupt one in-flight directory. That
        // candidate is failed/possibly partial; future work is unattempted.
        assert!(report.failed_count <= 1);
        assert!(report
            .failed_paths
            .iter()
            .all(|failure| failure.error.contains("descendants")));
        let outcomes = report.outcomes.unwrap_or_default();
        assert_eq!(outcomes.len(), 2000);
        assert!(outcomes
            .iter()
            .all(|o| o.status == "deleted" || o.status == "failed" || o.status == "unattempted"));
        let remaining = std::fs::read_dir(dir.path())
            .unwrap_or_else(|e| panic!("read: {e}"))
            .count();
        assert_eq!(remaining + report.deleted_count as usize, 2000);
    }
}
