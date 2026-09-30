//! `sweep-engine` CLI: JSON stdin/stdout bridge for scan and apply.

use camino::Utf8Path;
use serde::Deserialize;
use serde::Serialize;
use std::io::{self, IsTerminal, Read, Write};
use std::sync::Mutex;
use sweep_engine::{apply_plan, scan_to_plan_with_sweep_config, ScanHooks, ScanOptions};
use sweep_errors::EngineError;
use sweep_types::{ApplyReport, ScanCandidate, ScanPlan, SelectionPolicy, SweepConfig};

/// Exit codes mirror the JS CLI taxonomy (apps/cli/src/errors.ts): the JS
/// wrapper reads the engine's code and re-throws the matching error class, so
/// `sweep apply --engine rust` exits 2 for a guardrail trip just like `--engine js`.
const EXIT_ABORTED: i32 = 1;
const EXIT_GUARDRAIL: i32 = 2;
const EXIT_INVALID_INPUT: i32 = 3;
const EXIT_FAILURE: i32 = 4;

struct CliFailure {
    code: i32,
    message: String,
}

impl CliFailure {
    /// Bad argv or unparseable stdin - the caller's input is wrong.
    fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_INVALID_INPUT,
            message: message.into(),
        }
    }

    /// Everything else - IO, serialization, engine-internal failures.
    fn failure(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_FAILURE,
            message: message.into(),
        }
    }
}

impl From<EngineError> for CliFailure {
    fn from(err: EngineError) -> Self {
        match err {
            EngineError::Guardrail(_) => Self {
                code: EXIT_GUARDRAIL,
                message: err.to_string(),
            },
            EngineError::InvalidPlan { .. } => Self {
                code: EXIT_INVALID_INPUT,
                message: err.to_string(),
            },
            EngineError::Filesystem { .. } => Self::failure(err.to_string()),
        }
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {}", err.message);
        std::process::exit(err.code);
    }
}

fn run() -> Result<(), CliFailure> {
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
            Err(CliFailure {
                code: EXIT_ABORTED,
                message: "missing or unknown subcommand".to_owned(),
            })
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
    #[serde(rename = "scan_progress")]
    ScanProgress {
        #[serde(rename = "scannedDirs")]
        scanned_dirs: u32,
        found: u32,
        #[serde(rename = "skippedDirs")]
        skipped_dirs: u32,
        #[serde(rename = "currentDir", skip_serializing_if = "Option::is_none")]
        current_dir: Option<String>,
    },
    #[serde(rename = "scan_completed")]
    ScanCompleted { summary: ScanCompletedSummary },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanCompletedSummary {
    candidate_count: u32,
    estimated_total_bytes: u64,
    scanned_dirs: u32,
    skipped_dirs: u32,
    exact: bool,
    elapsed_ms: u64,
}

fn run_scan() -> Result<(), CliFailure> {
    let target_dir = std::env::args()
        .nth(2)
        .ok_or_else(|| CliFailure::invalid_input("scan requires a target directory argument"))?;

    let (config, selection_policy, exact, json_stream) = match read_stdin_if_present()? {
        Some(input) => {
            let options: ScanStdinOptions = serde_json::from_str(&input).map_err(|err| {
                CliFailure::invalid_input(format!(
                    "failed to parse scan options JSON from stdin: {err}"
                ))
            })?;
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
        })
        .map_err(CliFailure::failure)?;

        let emitter = StreamEmitter::default();
        let on_entry = |candidate: ScanCandidate| emitter.emit_found(candidate);
        let on_entry_sized = |candidate: ScanCandidate| emitter.emit_updated(candidate);
        let on_progress = |scanned_dirs: u32, found: u32, skipped_dirs: u32, dir: &Utf8Path| {
            // Report the dir relative to the scan root ("." for the root
            // itself) so consumers show "scanning x/" not an absolute path.
            let current_dir = dir
                .strip_prefix(target_utf8)
                .ok()
                .map(|rel| {
                    if rel.as_str().is_empty() {
                        "."
                    } else {
                        rel.as_str()
                    }
                })
                .map(str::to_owned);
            emitter.emit_progress(scanned_dirs, found, skipped_dirs, current_dir);
        };

        let hooks = ScanHooks {
            on_entry: Some(&on_entry),
            on_entry_sized: Some(&on_entry_sized),
            on_progress: Some(&on_progress),
        };

        let scan_started_at = std::time::Instant::now();
        let plan = scan_to_plan_with_sweep_config(
            target_utf8,
            &config,
            &selection_policy,
            ScanOptions { exact, hooks },
        )
        .map_err(CliFailure::from)?;

        if let Some(err) = emitter.into_error() {
            return Err(CliFailure::failure(err));
        }

        write_json_line(&ScanStreamEvent::ScanCompleted {
            summary: ScanCompletedSummary {
                elapsed_ms: scan_started_at.elapsed().as_millis() as u64,
                candidate_count: plan.summary.candidate_count,
                estimated_total_bytes: plan.summary.estimated_total_bytes,
                scanned_dirs: plan.summary.scanned_dirs,
                skipped_dirs: plan.summary.skipped_dirs,
                exact: plan.summary.exact,
            },
        })
        .map_err(CliFailure::failure)?;

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
    .map_err(CliFailure::from)?;
    write_json_stdout(&plan)
}

struct StreamEmitter {
    error: Mutex<Option<String>>,
}

impl Default for StreamEmitter {
    fn default() -> Self {
        Self {
            error: Mutex::new(None),
        }
    }
}

impl StreamEmitter {
    fn emit_found(&self, candidate: ScanCandidate) {
        if self.has_error() {
            return;
        }
        if let Err(err) = write_json_line(&ScanStreamEvent::CandidateFound { candidate }) {
            self.set_error(err);
        }
    }

    fn emit_updated(&self, candidate: ScanCandidate) {
        if self.has_error() {
            return;
        }
        if let Err(err) = write_json_line(&ScanStreamEvent::CandidateUpdated { candidate }) {
            self.set_error(err);
        }
    }

    fn emit_progress(
        &self,
        scanned_dirs: u32,
        found: u32,
        skipped_dirs: u32,
        current_dir: Option<String>,
    ) {
        if self.has_error() {
            return;
        }
        if let Err(err) = write_json_line(&ScanStreamEvent::ScanProgress {
            scanned_dirs,
            found,
            skipped_dirs,
            current_dir,
        }) {
            self.set_error(err);
        }
    }

    fn has_error(&self) -> bool {
        self.error
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(true)
    }

    fn set_error(&self, err: String) {
        if let Ok(mut guard) = self.error.lock() {
            *guard = Some(err);
        }
    }

    fn into_error(self) -> Option<String> {
        self.error
            .into_inner()
            .unwrap_or_else(|err| err.into_inner())
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

/// Same bound as the JS plan-file cap (256 MB) - far past any legitimate
/// ScanPlan, and a runaway writer can't pin the engine in an unbounded read.
/// +1 byte is the oversize probe: read_to_end alone can't tell a truncated
/// stream from one exactly at the cap.
const MAX_STDIN_BYTES: u64 = 256 * 1024 * 1024;

/// Ok(None) means no stdin was piped; errors propagate - a failed or oversized
/// read must not silently fall back to default options (user `ignore` patterns
/// would be dropped, scanning things the config excluded).
fn read_stdin_if_present() -> Result<Option<String>, CliFailure> {
    if io::stdin().is_terminal() {
        return Ok(None);
    }

    let mut buf = Vec::new();
    io::stdin()
        .take(MAX_STDIN_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|err| CliFailure::failure(format!("failed to read stdin: {err}")))?;

    if buf.is_empty() {
        return Ok(None);
    }
    if buf.len() as u64 > MAX_STDIN_BYTES {
        return Err(CliFailure::invalid_input(format!(
            "stdin exceeds the {MAX_STDIN_BYTES}-byte limit"
        )));
    }
    let input = String::from_utf8(buf).map_err(|err| {
        CliFailure::invalid_input(format!("stdin is not valid UTF-8 JSON input: {err}"))
    })?;
    if input.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(input))
}

fn run_apply() -> Result<(), CliFailure> {
    let input = read_stdin_if_present()?.ok_or_else(|| {
        CliFailure::invalid_input("apply requires a ScanPlan JSON document on stdin")
    })?;

    let plan: ScanPlan = serde_json::from_str(&input).map_err(|err| {
        CliFailure::invalid_input(format!("failed to parse ScanPlan JSON: {err}"))
    })?;

    let report: ApplyReport = apply_plan(&plan).map_err(CliFailure::from)?;
    write_json_stdout(&report)
}

fn write_json_stdout<T: Serialize>(value: &T) -> Result<(), CliFailure> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|err| CliFailure::failure(format!("failed to serialize JSON: {err}")))?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(json.as_bytes())
        .map_err(|err| CliFailure::failure(format!("failed to write stdout: {err}")))?;
    stdout
        .write_all(b"\n")
        .map_err(|err| CliFailure::failure(format!("failed to write stdout newline: {err}")))?;
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
