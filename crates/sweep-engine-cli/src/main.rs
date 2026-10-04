//! `sweep-engine` CLI: JSON stdin/stdout bridge for scan and apply.

use camino::Utf8Path;
use serde::Deserialize;
use serde::Serialize;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use sweep_engine::{
    apply_plan_controlled_with_limit, scan_to_plan_with_sweep_config, ScanHooks, ScanOptions,
};
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
            EngineError::ResourceLimit { .. } => Self {
                code: EXIT_GUARDRAIL,
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

/// `std::env::args()` panics on non-UTF-8 argv - a hostile or mangled
/// argument must produce an invalid_input error, not an abort.
fn arg(n: usize) -> Result<Option<String>, CliFailure> {
    match std::env::args_os().nth(n) {
        Some(os) => match os.to_str() {
            Some(s) => Ok(Some(s.to_owned())),
            None => Err(CliFailure::invalid_input(format!(
                "argument {n} is not valid UTF-8"
            ))),
        },
        None => Ok(None),
    }
}

fn run() -> Result<(), CliFailure> {
    match arg(1)?.as_deref() {
        Some("scan") => run_scan(),
        Some("apply") => run_apply(),
        Some("--capabilities") => {
            write_json_stdout(&serde_json::json!({"applyControl": true, "planIdentity": true}))
        }
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
    #[serde(default)]
    limits: sweep_types::ScanLimits,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum ScanStreamEvent {
    #[serde(rename = "scan_started")]
    ScanStarted {
        #[serde(rename = "targetIdentity", skip_serializing_if = "Option::is_none")]
        target_identity: Option<sweep_types::FilesystemIdentity>,
        #[serde(rename = "targetDir")]
        target_dir: String,
    },
    /// Candidates stream out in batches: the emitter accumulates events and
    /// flushes on a ~16ms cadence, so a busy scan costs a few dozen writes
    /// (and reader-side parses) instead of one per candidate.
    #[serde(rename = "candidates_found")]
    CandidatesFound { candidates: Vec<ScanCandidate> },
    #[serde(rename = "candidates_updated")]
    CandidatesUpdated { candidates: Vec<ScanCandidate> },
    #[serde(rename = "scan_progress")]
    ScanProgress {
        #[serde(rename = "scannedDirs")]
        scanned_dirs: u32,
        found: u32,
        #[serde(rename = "skippedDirs")]
        skipped_dirs: u32,
        /// Candidates whose size resolved so far - powers a real progress
        /// meter on the host instead of a queue-coverage bar.
        #[serde(rename = "sizedCount")]
        sized_count: u32,
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
    let target_dir = arg(2)?
        .ok_or_else(|| CliFailure::invalid_input("scan requires a target directory argument"))?;

    let (config, selection_policy, exact, json_stream, limits) = match read_stdin_if_present()? {
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
                options.limits,
            )
        }
        None => (
            default_sweep_config(),
            SelectionPolicy::default(),
            false,
            false,
            sweep_types::ScanLimits::default(),
        ),
    };

    // The JS side rejects patterns past this length at config load; the engine
    // re-checks because stdin JSON is itself an untrusted boundary - nothing
    // stops a caller from feeding a megabyte glob straight to the walk.
    const MAX_PATTERN_LENGTH: usize = 128;
    for pattern in config.patterns.iter().chain(config.ignore.iter()) {
        if pattern.chars().count() > MAX_PATTERN_LENGTH {
            return Err(CliFailure {
                code: EXIT_GUARDRAIL,
                message: format!(
                    "pattern exceeds {MAX_PATTERN_LENGTH} characters: {:?}…",
                    pattern.chars().take(64).collect::<String>()
                ),
            });
        }
    }

    let target_utf8 = Utf8Path::new(&target_dir);

    if json_stream {
        let target_identity = std::fs::symlink_metadata(&target_dir)
            .ok()
            .and_then(|meta| {
                sweep_fs::file_identity(std::path::Path::new(&target_dir), &meta)
                    .ok()
                    .flatten()
            })
            .map(sweep_fs::FileIdentity::snapshot);
        write_json_line(&ScanStreamEvent::ScanStarted {
            target_identity,
            target_dir: target_dir.clone(),
        })
        .map_err(CliFailure::failure)?;

        let emitter = StreamEmitter::default();
        let sized = AtomicUsize::new(0);
        // Last walk snapshot. Sizing outlives the walk, so sized completions
        // re-emit it with a fresh count; otherwise the meter would freeze at
        // the last walk value until the terminal flush.
        let last_walk = std::sync::Mutex::new(None::<(u32, u32, u32, Option<String>)>);
        let on_entry = |candidate: ScanCandidate| emitter.emit_found(candidate);
        let on_entry_sized = |candidate: ScanCandidate| {
            let count = sized.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some((dirs, found, skipped, dir)) =
                last_walk.lock().unwrap_or_else(|p| p.into_inner()).clone()
            {
                emitter.emit_progress(dirs, found, skipped, dir, count as u32);
            }
            emitter.emit_updated(candidate);
        };
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
            *last_walk.lock().unwrap_or_else(|p| p.into_inner()) =
                Some((scanned_dirs, found, skipped_dirs, current_dir.clone()));
            emitter.emit_progress(
                scanned_dirs,
                found,
                skipped_dirs,
                current_dir,
                sized.load(Ordering::Relaxed) as u32,
            );
        };

        let hooks = ScanHooks {
            on_entry: Some(&on_entry),
            on_entry_sized: Some(&on_entry_sized),
            on_progress: Some(&on_progress),
        };

        let scan_started_at = std::time::Instant::now();
        let plan = std::thread::scope(|scope| {
            let (stop, receiver) = std::sync::mpsc::channel::<()>();
            let emitter_ref = &emitter;
            scope.spawn(move || {
                while matches!(
                    receiver.recv_timeout(EMIT_FLUSH_INTERVAL),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ) {
                    emitter_ref.flush_if_due();
                }
            });
            let plan = scan_to_plan_with_sweep_config(
                target_utf8,
                &config,
                &selection_policy,
                ScanOptions {
                    exact,
                    hooks,
                    limits,
                },
            );
            // Drop wakes the timer immediately on success or failure. A
            // pending sparse update does not require another discovery or
            // completed size job to reach stdout.
            drop(stop);
            plan
        })
        .map_err(CliFailure::from)?;

        // Drain pending candidates before the terminal event so completed
        // stays last on the wire.
        emitter.finish();
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
            limits,
        },
    )
    .map_err(CliFailure::from)?;
    write_json_stdout(&plan)
}

struct StreamEmitter<W: Write = io::Stdout> {
    error: Mutex<Option<String>>,
    state: Mutex<EmitterState<W>>,
}

/// Pending stream output. Found and updated candidates accumulate into
/// batches; progress events coalesce to the latest. A flush writes the batch
/// lines then flushes the `BufWriter`, so each flush is one syscall burst.
struct EmitterState<W: Write> {
    out: io::BufWriter<W>,
    found: Vec<ScanCandidate>,
    updated: Vec<ScanCandidate>,
    progress: Option<(u32, u32, u32, Option<String>, u32)>,
    /// Estimated serialized bytes of the pending found+updated batches.
    pending_bytes: usize,
    last_flush: std::time::Instant,
    flushed_once: bool,
}

/// Flush once this many candidates are pending - bounds latency when the
/// walk outpaces the progress heartbeat.
const EMIT_BATCH_AT: usize = 64;
/// The host caps one event line at 4 MB (`MAX_EVENT_LINE`). 64 candidates
/// with near-maximal paths could exceed that and get the engine killed
/// mid-scan, so batches also flush on a byte budget well under the cap.
const EMIT_BATCH_BYTES: usize = 1024 * 1024;

/// Exact serialized size of one candidate. An estimate that counts raw
/// string lengths undercounts escape-heavy names (a `"` costs 2 wire bytes,
/// a C0 control 6) and a full batch could sail past the host's per-line cap
/// while the estimate stayed green. The extra serialize per candidate is
/// microseconds against a flush that syscalls anyway.
fn candidate_wire_bytes(candidate: &ScanCandidate) -> usize {
    serde_json::to_string(candidate)
        .map(|s| s.len() + 1)
        .unwrap_or_else(|_| {
            // Serialization can't fail in practice; fall back to a safe upper
            // bound (8x escaping) rather than zero if it ever does.
            8 * (candidate.id.len()
                + candidate.entry.path.len()
                + candidate.entry.name.len()
                + candidate.kind.len()
                + candidate.reasons.iter().map(|r| r.len()).sum::<usize>())
                + 256
        })
}
/// Flush at most this often on progress heartbeats. The TUI coalesces into
/// 60ms windows, so a faster cadence only buys syscalls, not freshness.
const EMIT_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);

impl Default for StreamEmitter {
    fn default() -> Self {
        Self::new(io::BufWriter::with_capacity(64 * 1024, io::stdout()))
    }
}

impl<W: Write> StreamEmitter<W> {
    fn new(out: io::BufWriter<W>) -> Self {
        Self {
            error: Mutex::new(None),
            state: Mutex::new(EmitterState {
                out,
                found: Vec::new(),
                updated: Vec::new(),
                progress: None,
                pending_bytes: 0,
                last_flush: std::time::Instant::now(),
                flushed_once: false,
            }),
        }
    }

    fn emit_found(&self, candidate: ScanCandidate) {
        let bytes = candidate_wire_bytes(&candidate);
        self.push(|state| {
            state.pending_bytes += bytes;
            state.found.push(candidate);
        });
    }

    fn emit_updated(&self, candidate: ScanCandidate) {
        let bytes = candidate_wire_bytes(&candidate);
        self.push(|state| {
            state.pending_bytes += bytes;
            state.updated.push(candidate);
        });
    }

    fn flush_if_due(&self) {
        if self.has_error() {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.last_flush.elapsed() >= EMIT_FLUSH_INTERVAL
            && (!state.found.is_empty() || !state.updated.is_empty() || state.progress.is_some())
        {
            self.flush_locked(&mut state);
        }
    }

    /// Progress is the heartbeat: store the latest snapshot and flush if the
    /// cadence window elapsed, so pending candidates ride each flush "time to
    /// time" without a syscall per directory.
    fn emit_progress(
        &self,
        scanned_dirs: u32,
        found: u32,
        skipped_dirs: u32,
        current_dir: Option<String>,
        sized_count: u32,
    ) {
        if self.has_error() {
            return;
        }
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.progress = Some((scanned_dirs, found, skipped_dirs, current_dir, sized_count));
        if state.last_flush.elapsed() >= EMIT_FLUSH_INTERVAL {
            self.flush_locked(&mut state);
        }
    }

    fn push(&self, f: impl FnOnce(&mut EmitterState<W>)) {
        if self.has_error() {
            return;
        }
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut state);
        // The very first candidates flush immediately so time-to-first-row is
        // instant; afterwards batches accumulate to the size/cadence bounds.
        // The cadence check also lives here (not only on progress heartbeats):
        // once the walk ends, sizing tails produce no progress events, and
        // without this a sparse tail would sit buffered until 64 pending or
        // scan end (plan A09).
        if !state.flushed_once
            || state.found.len() + state.updated.len() >= EMIT_BATCH_AT
            || state.pending_bytes >= EMIT_BATCH_BYTES
            || state.last_flush.elapsed() >= EMIT_FLUSH_INTERVAL
        {
            self.flush_locked(&mut state);
        }
    }

    /// Write pending events and flush the buffer before the caller emits the
    /// terminal `scan_completed` line.
    fn finish(&self) {
        if self.has_error() {
            return;
        }
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        self.flush_locked(&mut state);
    }

    /// Found batches always precede updated batches within a flush: a
    /// candidate's found event is enqueued before its own update can be, so
    /// stream order preserves the found-then-updated invariant.
    fn flush_locked(&self, state: &mut EmitterState<W>) {
        let result = (|| -> Result<(), String> {
            state.pending_bytes = 0;
            if !state.found.is_empty() {
                let event = ScanStreamEvent::CandidatesFound {
                    candidates: std::mem::take(&mut state.found),
                };
                write_json_line_to(&event, &mut state.out)?;
            }
            if !state.updated.is_empty() {
                let event = ScanStreamEvent::CandidatesUpdated {
                    candidates: std::mem::take(&mut state.updated),
                };
                write_json_line_to(&event, &mut state.out)?;
            }
            if let Some((scanned_dirs, found, skipped_dirs, current_dir, sized_count)) =
                state.progress.take()
            {
                write_json_line_to(
                    &ScanStreamEvent::ScanProgress {
                        scanned_dirs,
                        found,
                        skipped_dirs,
                        sized_count,
                        current_dir,
                    },
                    &mut state.out,
                )?;
            }
            state
                .out
                .flush()
                .map_err(|err| format!("failed to flush stdout: {err}"))?;
            Ok(())
        })();
        if let Err(err) = result {
            self.set_error(err);
        }
        state.last_flush = std::time::Instant::now();
        state.flushed_once = true;
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
        // Parity with DEFAULT_CONFIG.ignore in config.ts: sweep's own trash
        // dirs must never surface as candidates on a bare engine scan.
        ignore: vec![".sweep-trash-*".to_owned()],
        max_size_gb: 10.0,
        depth: -1,
    }
}

/// Same bound as the JS plan-file cap (64 MB) - far past any legitimate
/// ScanPlan, and a runaway writer can't pin the engine in an unbounded read.
/// +1 byte is the oversize probe: read_to_end alone can't tell a truncated
/// stream from one exactly at the cap.
const MAX_STDIN_BYTES: u64 = 64 * 1024 * 1024;

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
    install_apply_control()?;
    // arg(), not env::args(): args() panics on non-UTF-8 argv - a mangled
    // argument must produce an invalid_input error, not an abort.
    if arg(2)?.as_deref() == Some("--json-control") {
        return run_apply_controlled();
    }

    let input = read_stdin_if_present()?.ok_or_else(|| {
        CliFailure::invalid_input("apply requires a ScanPlan JSON document on stdin")
    })?;

    let plan: ScanPlan = serde_json::from_str(&input).map_err(|err| {
        CliFailure::invalid_input(format!("failed to parse ScanPlan JSON: {err}"))
    })?;

    let report: ApplyReport =
        apply_plan_controlled_with_limit(&plan, &APPLY_CANCELLED, &mut |_| {}, &mut |_| {}, None)
            .map_err(CliFailure::from)?;
    write_json_stdout(&report)?;
    if report.interrupted == Some(true) {
        return Err(CliFailure {
            code: EXIT_ABORTED,
            message: "apply interrupted; see outcome report".to_owned(),
        });
    }
    Ok(())
}

/// One-shot process: the detached stdin reader lives until main exits. Never
/// join a reader waiting for an open host pipe after the final report.
// One controlled apply per CLI process. Static lifetime also lets the Windows
// console callback signal cancellation without pointers, allocation or locks.
static APPLY_CANCELLED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn unix_apply_signal(_signal: libc::c_int) {
    APPLY_CANCELLED.store(true, Ordering::Release);
}

fn install_apply_control() -> Result<(), CliFailure> {
    #[cfg(unix)]
    {
        // SAFETY: zero is a valid initial sigaction representation on the
        // supported Unix targets. Its mask is initialized by sigemptyset.
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = unix_apply_signal as *const () as usize;
        action.sa_flags = libc::SA_RESTART;
        // SAFETY: callback has the signal ABI and static lifetime; it only
        // stores a lock-free boolean. Pointers reference live initialized
        // storage. No borrowed pointers, allocation, locks or unwinding.
        let failed = unsafe {
            libc::sigemptyset(&mut action.sa_mask) != 0
                || libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut()) != 0
                || libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut()) != 0
        };
        if failed {
            return Err(CliFailure::failure(format!(
                "cannot install apply cancellation: {}",
                io::Error::last_os_error()
            )));
        }
    }
    #[cfg(windows)]
    install_console_control()?;
    Ok(())
}

#[cfg(windows)]
unsafe extern "system" fn console_control(event: u32) -> windows_sys::core::BOOL {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};
    if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT {
        APPLY_CANCELLED.store(true, Ordering::Release);
        return 1;
    }
    0
}

#[cfg(windows)]
fn install_console_control() -> Result<(), CliFailure> {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    // SAFETY: callback has the documented ABI and static lifetime. It touches
    // only a static atomic, never unwinds, and retains no borrowed data.
    if unsafe { SetConsoleCtrlHandler(Some(console_control), 1) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    // Headless processes have no console and cannot receive console events.
    if error.raw_os_error() == Some(6) {
        return Ok(());
    }
    Err(CliFailure::failure(format!(
        "cannot install console cancellation: {error}"
    )))
}

fn run_apply_controlled() -> Result<(), CliFailure> {
    let mut reader = BufReader::new(io::stdin());
    let mut line = Vec::new();
    reader
        .by_ref()
        .take(MAX_STDIN_BYTES + 1)
        .read_until(b'\n', &mut line)
        .map_err(|e| CliFailure::invalid_input(e.to_string()))?;
    if line.len() as u64 > MAX_STDIN_BYTES || line.last() != Some(&b'\n') {
        return Err(CliFailure::invalid_input(
            "apply control requires a bounded plan line",
        ));
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        plan: ScanPlan,
        max_size_bytes: Option<u64>,
    }
    let request: Request = serde_json::from_slice(&line)
        .map_err(|e| CliFailure::invalid_input(format!("invalid plan: {e}")))?;
    // Establish the control stream explicitly. A closed/malformed initial
    // channel must fail before any filesystem operation can start.
    let mut start = Vec::new();
    reader
        .by_ref()
        .take(1025)
        .read_until(b'\n', &mut start)
        .map_err(|e| CliFailure::invalid_input(e.to_string()))?;
    if start.len() > 1024
        || start.last() != Some(&b'\n')
        || serde_json::from_slice::<serde_json::Value>(&start).ok()
            != Some(serde_json::json!({"type":"start"}))
    {
        return Err(CliFailure::invalid_input(
            "apply control requires a start message",
        ));
    }
    let cancelled = &APPLY_CANCELLED;
    let control = cancelled;
    std::thread::spawn(move || {
        let mut request = Vec::new();
        // EOF, invalid control, or cancellation all stop further scheduling.
        let _ = reader.take(1025).read_until(b'\n', &mut request);
        control.store(true, Ordering::Release);
    });
    let report = apply_plan_controlled_with_limit(
        &request.plan,
        cancelled,
        &mut |id| {
            if write_json_line(&serde_json::json!({"type":"apply_begin", "candidateId":id}))
                .is_err()
            {
                cancelled.store(true, Ordering::Release);
            }
        },
        &mut |id| {
            if write_json_line(&serde_json::json!({"type":"apply_deleted", "candidateId":id}))
                .is_err()
            {
                cancelled.store(true, Ordering::Release);
            }
        },
        request.max_size_bytes,
    )
    .map_err(CliFailure::from)?;
    write_json_line(&serde_json::json!({"type":"apply_completed", "report": report}))
        .map_err(CliFailure::failure)
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

#[cfg(test)]
mod tests {
    use super::*;
    use sweep_types::{EntryType, RiskTier, ScanEntry};

    fn candidate(name: &str) -> ScanCandidate {
        ScanCandidate {
            entry: ScanEntry {
                identity: None,
                path: format!("/tmp/sweep-emitter/{name}"),
                name: name.to_owned(),
                estimated_bytes: 1,
                bytes_known: Some(true),
                modified_ms: None,
                is_symlink: false,
                entry_type: EntryType::Directory,
            },
            id: format!("cand_{name}"),
            kind: name.to_owned(),
            risk_tier: RiskTier::Safe,
            reasons: vec!["default-pattern".to_owned()],
            selected_by_default: true,
        }
    }

    fn emitter_lines(emitter: &StreamEmitter<Vec<u8>>) -> Vec<String> {
        let state = emitter.state.lock().unwrap_or_else(|p| p.into_inner());
        String::from_utf8_lossy(state.out.get_ref())
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// Plan A09: once the walk ends there are no progress heartbeats left to
    /// carry a flush, so a sparse sizing tail must still drain updates on the
    /// cadence check inside `push` - not at 64 pending or scan end.
    #[test]
    fn sparse_sizing_tail_flushes_on_cadence_without_progress() {
        let emitter = StreamEmitter::new(io::BufWriter::new(Vec::new()));

        emitter.emit_found(candidate("node_modules"));
        // First batch bypasses buffering for instant time-to-first-row.
        assert_eq!(emitter_lines(&emitter).len(), 1);

        emitter.emit_updated(candidate("node_modules"));
        assert_eq!(
            emitter_lines(&emitter).len(),
            1,
            "update inside the cadence window stays buffered"
        );

        std::thread::sleep(EMIT_FLUSH_INTERVAL + std::time::Duration::from_millis(10));
        emitter.emit_updated(candidate("dist"));
        let lines = emitter_lines(&emitter);
        assert_eq!(
            lines.len(),
            2,
            "cadence-elapsed push must flush without a progress heartbeat, got {lines:?}"
        );
        assert!(lines[1].contains("candidates_updated"));
    }

    #[test]
    fn timer_flushes_an_idle_pending_size_without_another_event() {
        let emitter = StreamEmitter::new(io::BufWriter::new(Vec::new()));
        emitter.emit_found(candidate("node_modules"));
        emitter.emit_updated(candidate("node_modules"));
        assert_eq!(emitter_lines(&emitter).len(), 1);
        {
            let mut state = emitter.state.lock().unwrap_or_else(|p| p.into_inner());
            state.last_flush -= EMIT_FLUSH_INTERVAL;
        }
        emitter.flush_if_due();
        let lines = emitter_lines(&emitter);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("candidates_updated"));
        emitter.flush_if_due();
        assert_eq!(emitter_lines(&emitter).len(), 2);
    }

    /// The wire-byte estimate must measure the escaped form - a raw-len
    /// estimate undercounts quote/backslash/control-heavy names by ~2x.
    #[test]
    fn candidate_wire_bytes_counts_escaped_size_not_raw_len() {
        let hostile = "a\"b\\c\nd".repeat(64);
        let mut escaped = candidate(&hostile);
        escaped.id = hostile.clone();
        escaped.entry.path = format!("/t/{hostile}");
        let exact = serde_json::to_string(&escaped)
            .map(|s| s.len())
            .unwrap_or(0);
        assert!(exact > hostile.len() * 2);
        assert!(candidate_wire_bytes(&escaped) > exact);
    }

    /// The progress event carries `sizedCount` so hosts can draw an honest
    /// sizing meter; without it the only number available was queue coverage,
    /// which reads 100% while work is still in flight.
    #[test]
    fn progress_event_includes_sized_count() {
        let emitter = StreamEmitter::new(io::BufWriter::new(Vec::new()));
        emitter.emit_progress(10, 3, 0, Some("a/b".to_owned()), 1);
        {
            let mut state = emitter.state.lock().unwrap_or_else(|p| p.into_inner());
            state.last_flush -= EMIT_FLUSH_INTERVAL;
        }
        emitter.flush_if_due();
        let lines = emitter_lines(&emitter);
        assert_eq!(lines.len(), 1);
        let event: serde_json::Value = match serde_json::from_str(&lines[0]) {
            Ok(event) => event,
            Err(err) => panic!("emitted line is not valid JSON: {err}"),
        };
        assert_eq!(event["type"], "scan_progress");
        assert_eq!(event["sizedCount"], 1);
        assert_eq!(event["scannedDirs"], 10);
    }
}
