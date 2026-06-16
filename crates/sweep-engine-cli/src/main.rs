//! `sweep-engine` CLI: JSON stdin/stdout bridge for scan and apply.

use camino::Utf8Path;
use serde::Deserialize;
use std::io::{self, Read, Write};
use sweep_engine::{apply_plan, scan_to_plan_with_sweep_config};
use sweep_types::{ApplyReport, ScanPlan, SelectionPolicy, SweepConfig};

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
}

fn run_scan() -> Result<(), String> {
    let target_dir = std::env::args()
        .nth(2)
        .ok_or_else(|| "scan requires a target directory argument".to_owned())?;

    let (config, selection_policy) = match read_stdin_if_present() {
        Some(input) => {
            let options: ScanStdinOptions = serde_json::from_str(&input)
                .map_err(|err| format!("failed to parse scan options JSON from stdin: {err}"))?;
            (options.config, options.selection_policy)
        }
        None => (default_sweep_config(), SelectionPolicy::default()),
    };

    let plan =
        scan_to_plan_with_sweep_config(Utf8Path::new(&target_dir), &config, &selection_policy)
            .map_err(|err| err.to_string())?;
    write_json_stdout(&plan)
}

fn default_sweep_config() -> SweepConfig {
    SweepConfig {
        patterns: sweep_fs::default_patterns(),
        ignore: Vec::new(),
        max_size_gb: 10.0,
        depth: -1,
    }
}

fn read_stdin_if_present() -> Option<String> {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        return None;
    }
    if input.trim().is_empty() {
        None
    } else {
        Some(input)
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

fn write_json_stdout<T: serde::Serialize>(value: &T) -> Result<(), String> {
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
