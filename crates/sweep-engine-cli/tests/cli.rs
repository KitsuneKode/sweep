use assert_cmd::Command;
use sweep_types::{ApplyReport, ScanPlan, PROTOCOL_VERSION};
use tempfile::tempdir;

#[test]
fn usage_errors_are_distinct_from_cooperative_interruption() {
    Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate engine: {err}"))
        .arg("unknown-subcommand")
        .assert()
        .code(2);
}

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
    let owned = tempdir().unwrap_or_else(|err| panic!("fixture: {err}"));
    let plan = ScanPlan::empty(
        owned.path().to_string_lossy().into_owned(),
        "1970-01-01T00:00:00.000Z",
    );
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

#[test]
fn tracked_status_reports_unknown_when_index_fallback_has_no_git_on_path() {
    let root = tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"));
    let repo = root.path().join("repo");
    let outside = root.path().join("outside");
    let repo_candidate = repo.join("node_modules");
    let outside_candidate = outside.join("node_modules");
    std::fs::create_dir_all(repo.join(".git")).unwrap_or_else(|err| panic!("mkdir: {err}"));
    // Unparseable index forces the native reader onto the git fallback path.
    std::fs::write(repo.join(".git").join("index"), b"NOT_A_VALID_INDEX")
        .unwrap_or_else(|err| panic!("write: {err}"));
    std::fs::create_dir_all(&repo_candidate).unwrap_or_else(|err| panic!("mkdir: {err}"));
    std::fs::create_dir_all(&outside_candidate).unwrap_or_else(|err| panic!("mkdir: {err}"));

    let stdin = format!(
        "{}\0{}\0",
        repo_candidate.display(),
        outside_candidate.display()
    );
    let output = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .args(["tracked", "--status"])
        .env("PATH", "")
        .write_stdin(stdin.as_bytes())
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine tracked: {err}"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let records: Vec<&str> = std::str::from_utf8(&output.stdout)
        .unwrap_or_else(|err| panic!("utf8: {err}"))
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
    assert_eq!(records.first().copied(), Some("SWEEP_TRACKED_V3"));
    assert!(records.contains(&format!("U\t{}", repo_candidate.display()).as_str()));
    assert!(!records.contains(&format!("T\t{}", repo_candidate.display()).as_str()));
    assert!(!records.contains(&format!("U\t{}", outside_candidate.display()).as_str()));
}

#[test]
fn tracked_gitfile_without_index_marks_unknown_and_fails_legacy_mode() {
    let root = tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"));
    let repo = root.path().join("repo");
    let empty_gitdir = root.path().join("empty-gitdir");
    let preserved_gitdir = root.path().join("preserved-gitdir");
    let candidate = repo.join("node_modules");
    std::fs::create_dir_all(candidate.join("pkg")).unwrap_or_else(|err| panic!("mkdir: {err}"));
    std::fs::write(
        candidate.join("pkg").join("index.js"),
        b"module.exports = 1;\n",
    )
    .unwrap_or_else(|err| panic!("write: {err}"));
    std::fs::create_dir_all(&empty_gitdir).unwrap_or_else(|err| panic!("mkdir: {err}"));

    let has_git = std::process::Command::new("git")
        .arg("--version")
        .status()
        .is_ok_and(|s| s.success());
    if has_git {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "t"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["add", "node_modules/pkg/index.js"],
            vec!["commit", "-qm", "init"],
        ] {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .status()
                .is_ok_and(|s| s.success()));
        }
        std::fs::rename(repo.join(".git"), &preserved_gitdir)
            .unwrap_or_else(|err| panic!("rename .git: {err}"));
    }

    let target = empty_gitdir.to_string_lossy().replace('\\', "/");
    std::fs::write(repo.join(".git"), format!("gitdir: {target}\n"))
        .unwrap_or_else(|err| panic!("write gitfile: {err}"));

    let stdin = format!("{}\0", candidate.display());
    let status_out = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .args(["tracked", "--status"])
        .write_stdin(stdin.as_bytes())
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine tracked --status: {err}"));
    assert!(
        status_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&status_out.stderr)
    );
    let records: Vec<&str> = std::str::from_utf8(&status_out.stdout)
        .unwrap_or_else(|err| panic!("utf8: {err}"))
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
    assert_eq!(records.first().copied(), Some("SWEEP_TRACKED_V3"));
    assert!(records.contains(&format!("U\t{}", candidate.display()).as_str()));
    assert!(!records.contains(&format!("T\t{}", candidate.display()).as_str()));

    let legacy_out = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .arg("tracked")
        .write_stdin(stdin.as_bytes())
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine tracked: {err}"));
    assert_eq!(
        legacy_out.status.code(),
        Some(4),
        "legacy tracked must exit non-zero when any path is unknown; stdout={} stderr={}",
        String::from_utf8_lossy(&legacy_out.stdout),
        String::from_utf8_lossy(&legacy_out.stderr)
    );
}

#[test]
fn tracked_valid_repo_with_deleted_index_stays_empty_in_both_modes() {
    let has_git = std::process::Command::new("git")
        .arg("--version")
        .status()
        .is_ok_and(|s| s.success());
    if !has_git {
        return;
    }
    let root = tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"));
    let repo = root.path().join("repo");
    let candidate = repo.join("node_modules");
    std::fs::create_dir_all(candidate.join("pkg")).unwrap_or_else(|err| panic!("mkdir: {err}"));
    std::fs::write(
        candidate.join("pkg").join("index.js"),
        b"module.exports = 1;\n",
    )
    .unwrap_or_else(|err| panic!("write: {err}"));

    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "t"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["add", "node_modules/pkg/index.js"],
        vec!["commit", "-qm", "init"],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .status()
            .is_ok_and(|s| s.success()));
    }
    std::fs::remove_file(repo.join(".git").join("index"))
        .unwrap_or_else(|err| panic!("remove index: {err}"));

    let stdin = format!("{}\0", candidate.display());
    let status_out = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .args(["tracked", "--status"])
        .write_stdin(stdin.as_bytes())
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine tracked --status: {err}"));
    assert!(
        status_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&status_out.stderr)
    );
    let records: Vec<&str> = std::str::from_utf8(&status_out.stdout)
        .unwrap_or_else(|err| panic!("utf8: {err}"))
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
    assert_eq!(records, vec!["SWEEP_TRACKED_V3"]);

    let legacy_out = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .arg("tracked")
        .write_stdin(stdin.as_bytes())
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine tracked: {err}"));
    assert!(
        legacy_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&legacy_out.stderr)
    );
    assert!(legacy_out.stdout.is_empty());
}

#[test]
fn tracked_ignores_inherited_git_env_and_handles_nested_and_empty_index_gitfile() {
    let has_git = std::process::Command::new("git")
        .arg("--version")
        .status()
        .is_ok_and(|s| s.success());
    if !has_git {
        return;
    }
    let root = tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"));
    let run_git = |cwd: &std::path::Path, args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .status()
                .is_ok_and(|s| s.success()),
            "git {args:?} failed in {}",
            cwd.display()
        );
    };

    // Empty repo + 32-byte empty index to try to spoof GIT_DIR / GIT_INDEX_FILE.
    let empty_repo = root.path().join("empty-repo");
    std::fs::create_dir_all(&empty_repo).unwrap_or_else(|err| panic!("mkdir: {err}"));
    run_git(&empty_repo, &["init", "-q"]);
    run_git(&empty_repo, &["config", "user.email", "t@example.com"]);
    run_git(&empty_repo, &["config", "user.name", "t"]);
    run_git(&empty_repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(empty_repo.join("a.txt"), b"x\n").unwrap_or_else(|err| panic!("write: {err}"));
    run_git(&empty_repo, &["add", "a.txt"]);
    run_git(&empty_repo, &["rm", "--cached", "-q", "a.txt"]);
    let empty_index = empty_repo.join(".git").join("index");
    assert_eq!(
        std::fs::metadata(&empty_index)
            .unwrap_or_else(|err| panic!("stat empty index: {err}"))
            .len(),
        32
    );

    // 1. Healthy parent repo tracking nested/node_modules/pkg/index.js with `git init` in nested.
    let parent = root.path().join("parent");
    let nested = parent.join("nested");
    let nested_nm = nested.join("node_modules");
    std::fs::create_dir_all(nested_nm.join("pkg")).unwrap_or_else(|err| panic!("mkdir: {err}"));
    std::fs::write(
        nested_nm.join("pkg").join("index.js"),
        b"module.exports = 1;\n",
    )
    .unwrap_or_else(|err| panic!("write: {err}"));
    run_git(&parent, &["init", "-q"]);
    run_git(&parent, &["config", "user.email", "t@example.com"]);
    run_git(&parent, &["config", "user.name", "t"]);
    run_git(&parent, &["config", "commit.gpgsign", "false"]);
    run_git(&parent, &["add", "nested/node_modules/pkg/index.js"]);
    run_git(&parent, &["commit", "-qm", "init"]);
    run_git(&nested, &["init", "-q"]);

    // 2. Gitfile target with 32-byte empty index and no HEAD.
    let broken_repo = root.path().join("broken-repo");
    let broken_gitdir = root.path().join("broken-gitdir");
    let broken_nm = broken_repo.join("node_modules");
    std::fs::create_dir_all(broken_nm.join("pkg")).unwrap_or_else(|err| panic!("mkdir: {err}"));
    std::fs::create_dir_all(&broken_gitdir).unwrap_or_else(|err| panic!("mkdir: {err}"));
    std::fs::write(
        broken_nm.join("pkg").join("index.js"),
        b"module.exports = 1;\n",
    )
    .unwrap_or_else(|err| panic!("write: {err}"));
    std::fs::copy(&empty_index, broken_gitdir.join("index"))
        .unwrap_or_else(|err| panic!("copy empty index: {err}"));
    let target = broken_gitdir.to_string_lossy().replace('\\', "/");
    std::fs::write(broken_repo.join(".git"), format!("gitdir: {target}\n"))
        .unwrap_or_else(|err| panic!("write gitfile: {err}"));

    let stdin = format!("{}\0{}\0", nested_nm.display(), broken_nm.display());
    let output = Command::cargo_bin("sweep-engine")
        .unwrap_or_else(|err| panic!("failed to locate sweep-engine binary: {err}"))
        .args(["tracked", "--status"])
        .env("GIT_DIR", empty_repo.join(".git"))
        .env("GIT_INDEX_FILE", &empty_index)
        .env("GIT_WORK_TREE", &empty_repo)
        .write_stdin(stdin.as_bytes())
        .output()
        .unwrap_or_else(|err| panic!("failed to run sweep-engine tracked --status: {err}"));
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let records: Vec<&str> = std::str::from_utf8(&output.stdout)
        .unwrap_or_else(|err| panic!("utf8: {err}"))
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
    assert_eq!(records.first().copied(), Some("SWEEP_TRACKED_V3"));
    assert!(records.contains(&format!("T\t{}", nested_nm.display()).as_str()));
    assert!(records.contains(&format!("U\t{}", broken_nm.display()).as_str()));
    assert!(!records.contains(&format!("T\t{}", broken_nm.display()).as_str()));
}
