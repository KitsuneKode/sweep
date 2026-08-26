//! `sweep-engine` CLI: JSON stdin/stdout bridge for scan and apply.

use camino::Utf8Path;
use serde::Deserialize;
use serde::Serialize;
use std::cell::RefCell;
use std::io::{self, IsTerminal, Read, Write};
use sweep_engine::{apply_plan, scan_to_plan_with_sweep_config, ScanHooks, ScanOptions};
use sweep_types::{ApplyReport, ScanCandidate, ScanPlan, SelectionPolicy, SweepConfig};

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match std::env::args().nth(1).as_deref() {
        Some("scan") => run_scan(),
        Some("apply") => run_apply(),
        Some("--version" | "-V") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => {
            eprintln!(
                "usage: sweep-engine scan <target-dir>  # optional ScanOptions JSON on stdin"
            );
            eprintln!("       sweep-engine apply               # reads ScanPlan JSON from stdin");
            Err("missing or unknown subcommand".to_owned())
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanStdinOptions {
    config: SweepConfig,
    selection_policy: SelectionPolicy,
    #[serde(default)]
    exact: bool,
    #[serde(default)]
    json_stream: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum ScanStreamEvent {
    #[serde(rename = "scan_started")]
    ScanStarted {
        #[serde(rename = "targetDir")]
        target_dir: String,
    },
    #[serde(rename = "candidate_found")]
    CandidateFound { candidate: ScanCandidate },
    #[serde(rename = "candidate_updated")]
    CandidateUpdated { candidate: ScanCandidate },
    #[serde(rename = "scan_completed")]
    ScanCompleted { summary: ScanCompletedSummary },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanCompletedSummary {
    candidate_count: u32,
    estimated_total_bytes: u64,
    scanned_dirs: u32,
    exact: bool,
}

fn run_scan() -> Result<(), String> {
    let target_dir = std::env::args()
        .nth(2)
        .ok_or_else(|| "scan requires a target directory argument".to_owned())?;

    let (config, selection_policy, exact, json_stream) = match read_stdin_if_present() {
        Some(input) => {
            let options: ScanStdinOptions = serde_json::from_str(&input)
                .map_err(|err| format!("failed to parse scan options JSON from stdin: {err}"))?;
            (
                options.config,
                options.selection_policy,
                options.exact,
                options.json_stream,
            )
        }
        None => (
            default_sweep_config(),
            SelectionPolicy::default(),
            false,
            false,
        ),
    };

    let target_utf8 = Utf8Path::new(&target_dir);

    if json_stream {
        write_json_line(&ScanStreamEvent::ScanStarted {
            target_dir: target_dir.clone(),
        })?;

        let emitter = StreamEmitter::default();
        let mut on_entry = |candidate: ScanCandidate| emitter.emit_found(candidate);
        let mut on_entry_sized = |candidate: ScanCandidate| emitter.emit_updated(candidate);

        let hooks = ScanHooks {
            on_entry: Some(&mut on_entry),
            on_entry_sized: Some(&mut on_entry_sized),
        };

        let plan = scan_to_plan_with_sweep_config(
            target_utf8,
            &config,
            &selection_policy,
            ScanOptions { exact, hooks },
        )
        .map_err(|err| err.to_string())?;

        if let Some(err) = emitter.into_error() {
            return Err(err);
        }

        write_json_line(&ScanStreamEvent::ScanCompleted {
            summary: ScanCompletedSummary {
                candidate_count: plan.summary.candidate_count,
                estimated_total_bytes: plan.summary.estimated_total_bytes,
                scanned_dirs: plan.summary.scanned_dirs,
                exact: plan.summary.exact,
            },
        })?;

        return Ok(());
    }

    let plan = scan_to_plan_with_sweep_config(
        target_utf8,
        &config,
        &selection_policy,
        ScanOptions {
            exact,
            hooks: ScanHooks::default(),
        },
    )
    .map_err(|err| err.to_string())?;
    write_json_stdout(&plan)
}

#[derive(Default)]
struct StreamEmitter {
    error: RefCell<Option<String>>,
}

impl StreamEmitter {
    fn emit_found(&self, candidate: ScanCandidate) {
        if self.error.borrow().is_some() {
            return;
        }
        if let Err(err) = write_json_line(&ScanStreamEvent::CandidateFound { candidate }) {
            *self.error.borrow_mut() = Some(err);
        }
    }

    fn emit_updated(&self, candidate: ScanCandidate) {
        if self.error.borrow().is_some() {
            return;
        }
        if let Err(err) = write_json_line(&ScanStreamEvent::CandidateUpdated { candidate }) {
            *self.error.borrow_mut() = Some(err);
        }
    }

    fn into_error(self) -> Option<String> {
        self.error.into_inner()
    }
}

fn default_sweep_config() -> SweepConfig {
    SweepConfig {
        patterns: sweep_fs::default_patterns(),
        disabled_patterns: Vec::new(),
        ignore: Vec::new(),
        max_size_gb: 10.0,
        depth: -1,
    }
}

fn read_stdin_if_present() -> Option<String> {
    if io::stdin().is_terminal() {
        return None;
    }

    let mut input = String::new();
    match io::stdin().read_to_string(&mut input) {
        Ok(_) if input.trim().is_empty() => None,
        Ok(_) => Some(input),
        Err(_) => None,
    }
}

fn run_apply() -> Result<(), String> {
    let input = read_stdin_if_present()
        .ok_or_else(|| "apply requires a ScanPlan JSON document on stdin".to_owned())?;

    let plan: ScanPlan = serde_json::from_str(&input)
        .map_err(|err| format!("failed to parse ScanPlan JSON: {err}"))?;

    let report: ApplyReport = apply_plan(&plan).map_err(|err| err.to_string())?;
    write_json_stdout(&report)
}

fn write_json_stdout<T: Serialize>(value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|err| format!("failed to serialize JSON: {err}"))?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(json.as_bytes())
        .map_err(|err| format!("failed to write stdout: {err}"))?;
    stdout
        .write_all(b"\n")
        .map_err(|err| format!("failed to write stdout newline: {err}"))?;
    Ok(())
}

fn write_json_line<T: Serialize>(value: &T) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    write_json_line_to(value, &mut stdout)
}

fn write_json_line_to<T: Serialize, W: Write>(value: &T, writer: &mut W) -> Result<(), String> {
    let json =
        serde_json::to_string(value).map_err(|err| format!("failed to serialize JSON: {err}"))?;
    writer
        .write_all(json.as_bytes())
        .map_err(|err| format!("failed to write stdout: {err}"))?;
    writer
        .write_all(b"\n")
        .map_err(|err| format!("failed to write stdout newline: {err}"))?;
    Ok(())
}
