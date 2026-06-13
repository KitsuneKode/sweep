//! `sweep-engine` CLI: JSON stdin/stdout bridge for scan and apply stubs.

use camino::Utf8Path;
use std::io::{self, Read, Write};
use sweep_engine::{apply_plan, scan_to_plan};
use sweep_types::{ApplyReport, ScanPlan};

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
        _ => {
            eprintln!("usage: sweep-engine scan <target-dir>");
            eprintln!("       sweep-engine apply   # reads ScanPlan JSON from stdin");
            Err("missing or unknown subcommand".to_owned())
        }
    }
}

fn run_scan() -> Result<(), String> {
    let target_dir = std::env::args().nth(2).ok_or_else(|| {
        "scan requires a target directory argument".to_owned()
    })?;

    let plan = scan_to_plan(Utf8Path::new(&target_dir))
        .map_err(|err| err.to_string())?;
    write_json_stdout(&plan)
}

fn run_apply() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|err| format!("failed to read stdin: {err}"))?;

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
