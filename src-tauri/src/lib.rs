// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

mod crash_reports;

// Every command below is `async` and does its work on the blocking thread pool. A plain (synchronous) Tauri
// command runs on the main thread - the one that also runs the window - so a command that waits for Python or
// Vivado there freezes the whole UI for as long as the child process takes.

// ---------------------------------------------------------------- Data Models

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub profile: Option<String>,
    pub ltx: Option<String>,
    pub tcl: Option<String>,
    pub server: Option<String>,
    pub device: Option<String>,
    pub ila_index: Option<u32>,
    /// the cell name of that core as the probe file has it: what the core is chosen by on the device
    pub ila_cell: Option<String>,
    pub jtag_hz: Option<u64>,
    pub omit_jtag_freq: Option<bool>,
    /// how many Vivado engines the hardware session is to run (1, or 2 with "Twin Turbo")
    pub engines: Option<u32>,
    pub trigger: String, // "now" or "<probe> <compare-value>"
    pub position: u32,
    pub timeout_min: Option<f64>,
    pub format: String, // "both", "csv", "ila"
    pub capture_name: String,
    pub continuous: Option<bool>,
    /// how single probes are written into the CSV: net name without bus range -> "unsigned" | "signed" | "hex"
    pub probe_formats: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareQueryRequest {
    pub server: Option<String>,
    pub ltx: Option<String>,
    pub tcl: Option<String>,
    pub device: Option<String>,
    pub jtag_hz: Option<u64>,
    pub omit_jtag_freq: Option<bool>,
    pub ila_index: Option<u32>,
    pub ila_cell: Option<String>,
    pub profile: Option<String>,
    pub engines: Option<u32>,
}

// ---------------------------------------------------------------- App State

/// The one hardware operation (query / capture / disconnect) that may be in flight: its bridge process and the
/// file whose appearance asks it to stop in order.
#[derive(Debug, Clone)]
pub struct HwJob {
    /// counts up with every job: the bridge process, and so the pid, is the same for all of them
    id: u64,
    pid: u32,
    stop_file: PathBuf,
    kind: &'static str,
}

/// The bridge process that takes the hardware jobs ("ila_bridge.py serve"). It stays up between jobs and keeps
/// the Vivado session of the last one open, so the next job starts at once instead of after Vivado's start-up.
struct HwServer {
    child: Child,
    stdin: ChildStdin,
    /// what it prints, line by line (stderr marked true); "@@STATE" lines are taken out by the reader
    rx: mpsc::Receiver<(bool, String)>,
}

#[derive(Default)]
pub struct AppState {
    job: Arc<Mutex<Option<HwJob>>>,
    server: Arc<Mutex<Option<HwServer>>>,
    /// what the bridge last said about its Vivado session ("@@STATE"); Null before the first job
    session: Arc<Mutex<Value>>,
}

/// The three things a hardware job needs of the application state.
#[derive(Clone)]
struct HwHandles {
    job: Arc<Mutex<Option<HwJob>>>,
    server: Arc<Mutex<Option<HwServer>>>,
    session: Arc<Mutex<Value>>,
}

impl AppState {
    fn handles(&self) -> HwHandles {
        HwHandles { job: self.job.clone(), server: self.server.clone(), session: self.session.clone() }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------- Helper Functions

#[cfg(windows)]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: without it every console child of this GUI process opens its own console window
    cmd.creation_flags(0x0800_0000)
}

#[cfg(not(windows))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Where ila_bridge.py is looked for, in this order. The folder of the executable comes first: that is where
/// the scripts are in a distribution, and by itself a release build looks nowhere else - a file of that name
/// in a folder above it, or in the folder the program happened to be started from, is not its script and must
/// not be run. An executable that is kept apart from its scripts is told their folder in ILA_HOME (run_gui.ps1
/// does that for a local release build); only a full path counts there, a relative one would lead back to the
/// working directory. A development build (target\debug) finds the repository by itself: in the four folders
/// above the executable, then in the working directory and the folder above that.
fn root_candidates(exe_dir: Option<&Path>, named: Option<&Path>, cwd: &Path, development: bool) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.extend(exe_dir.map(Path::to_path_buf));
    candidates.extend(named.filter(|dir| dir.is_absolute()).map(Path::to_path_buf));
    if development {
        if let Some(dir) = exe_dir {
            candidates.extend(dir.ancestors().skip(1).take(4).map(Path::to_path_buf));
        }
        candidates.extend(cwd.ancestors().take(2).map(Path::to_path_buf));
    }
    candidates
}

/// The folder that holds ila_bridge.py (see root_candidates). Where none of them does, it is the folder the
/// message about that names: the one of the executable in a release build, the working directory in a
/// development build.
fn project_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
        let named = std::env::var_os("ILA_HOME").map(PathBuf::from);
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let development = cfg!(debug_assertions);
        root_candidates(exe_dir.as_deref(), named.as_deref(), &cwd, development)
            .into_iter()
            .find(|c| c.join("ila_bridge.py").is_file())
            .unwrap_or(if development { cwd } else { exe_dir.unwrap_or(cwd) })
    })
    .clone()
}

/// The real Python interpreter. "python" on PATH is often the WindowsApps launcher stub, which takes seconds
/// to start; it is asked once for `sys.executable` and the answer is used directly from then on. Only a find
/// is remembered: a Python installed while the app is open is picked up at the next command.
fn python_exe() -> Result<PathBuf, String> {
    static PYTHON: Mutex<Option<PathBuf>> = Mutex::new(None);
    let mut found = PYTHON.lock().unwrap_or_else(|e| e.into_inner());
    if found.is_none() {
        let python = find_python()?;
        // Once in a run of the program: which interpreter runs the scripts is what a fault of the hardware path
        // may come down to, and nothing else in the log says it.
        append_log(&project_root().join("ila_log.txt"), &python.asked, &python.note());
        *found = Some(python.exe);
    }
    Ok(found.clone().expect("set above"))
}

/// What a candidate is asked. An old interpreter fails at the assert, so that one which happens to come first
/// on PATH is not chosen; any other says where it really is, what build it is, and the time for its line in the
/// log - that is written in local time, which the standard library of Rust does not know.
const PYTHON_PROBE: &str = "import sys; assert sys.version_info >= (3, 8); import sysconfig, datetime; \
    print(sys.executable); print(sysconfig.get_platform()); print(sys.platform); print(sys.version.split()[0]); \
    print(datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3])";

/// How long a candidate may take to answer. It runs while python_exe holds its lock, with every other command
/// waiting behind it; a launcher stub or a first start under a virus scanner takes seconds, not this long.
const PROBE_LIMIT: Duration = Duration::from_secs(30);

/// A Python interpreter, as it answered PYTHON_PROBE.
#[derive(Debug, Clone, PartialEq)]
struct Python {
    exe: PathBuf,
    /// sysconfig.get_platform(): "win-amd64" for the Python of python.org, "mingw_x86_64_ucrt_gnu" for one of MSYS2
    platform: String,
    /// sys.platform: "win32" for a MinGW build as well, "cygwin" or "msys" for the Python of those environments
    sys_platform: String,
    version: String,
    /// when it answered, as the log writes a time
    asked: String,
    /// ILA_PYTHON names it
    named: bool,
}

impl Python {
    /// The answer of an interpreter, which is one line for each thing it was asked.
    fn from_answer(answer: &str, named: bool) -> Option<Python> {
        let mut lines = answer.lines().map(|line| line.trim().to_string());
        Some(Python {
            exe: PathBuf::from(lines.next().filter(|exe| !exe.is_empty())?),
            platform: lines.next()?,
            sys_platform: lines.next()?,
            version: lines.next()?,
            asked: lines.next()?,
            named,
        })
    }

    /// Not the Python of python.org or of the Store, but a MinGW build, as MSYS2 has it, or the Python of Cygwin
    /// or MSYS. That is another program in details - its path separator is "/" - and the hardware path has never
    /// been run with it. It is told by what the interpreter says of itself, not by the folder it is in.
    fn other_build(&self) -> bool {
        self.platform.to_ascii_lowercase().starts_with("mingw") || matches!(self.sys_platform.as_str(), "cygwin" | "msys")
    }

    /// What the log says about the interpreter in use.
    fn note(&self) -> String {
        let why = if self.named {
            ", named by ILA_PYTHON"
        } else if self.other_build() {
            " - not a standard Python for Windows (a MinGW or Cygwin build); it is used because no other was found"
        } else {
            ""
        };
        format!("Python {} ({}): {}{}", self.version, self.platform, self.exe.display(), why)
    }
}

/// The interpreter to use, of the answers in the order of the search: the first standard one, or the one
/// ILA_PYTHON names, whatever it is. A MinGW or Cygwin build that comes first on PATH is put behind the others
/// and not refused: for somebody it is the only Python. The answers are taken only as far as needed - no
/// candidate behind the chosen one is started.
fn pick_python(answers: impl Iterator<Item = Python>) -> Option<Python> {
    let mut spare = None;
    for python in answers {
        if python.named || !python.other_build() {
            return Some(python);
        }
        spare.get_or_insert(python);
    }
    spare
}

/// Starts a candidate and takes its answer. There is none from a candidate that cannot be started, is too old
/// or names a file that is not there; one that does not answer in time is ended and put on the list `silent`.
fn ask_python(exe: &Path, pre: &[&str], named: bool, silent: &mut Vec<String>) -> Option<Python> {
    let mut cmd = Command::new(exe);
    cmd.args(pre).args(["-c", PYTHON_PROBE]).stdin(Stdio::null());
    match output_within(no_window(&mut cmd), PROBE_LIMIT) {
        Ok(Some(out)) if out.status.success() => {
            Python::from_answer(&String::from_utf8_lossy(&out.stdout), named).filter(|python| python.exe.is_file())
        }
        Ok(None) => {
            silent.push(exe.display().to_string());
            None
        }
        _ => None,
    }
}

fn find_python() -> Result<Python, String> {
    // each with the arguments that go in front, and whether ILA_PYTHON names it
    let mut candidates: Vec<(PathBuf, Vec<&str>, bool)> = Vec::new();
    if let Ok(p) = std::env::var("ILA_PYTHON") {
        candidates.push((PathBuf::from(p), vec![], true));
    }
    let mut stubs = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let is_stub = dir.to_string_lossy().to_lowercase().contains("windowsapps");
            for name in ["python.exe", "python3.exe", "python3", "python"] {
                let c = dir.join(name);
                if c.is_file() {
                    if is_stub {
                        stubs.push((c, vec![], false));
                    } else {
                        candidates.push((c, vec![], false));
                    }
                    break;
                }
            }
        }
    }
    candidates.extend(stubs);
    // app execution aliases do not always show up as files, so the bare names are tried as well
    candidates.push((PathBuf::from("python"), vec![], false));
    candidates.push((PathBuf::from("py"), vec!["-3"], false));
    let mut silent: Vec<String> = Vec::new();
    let found = pick_python(candidates.iter().filter_map(|(exe, pre, named)| ask_python(exe, pre, *named, &mut silent)));
    found.ok_or_else(|| {
        let mut message = "Python 3 was not found. Install Python 3.8 or newer, or set the ILA_PYTHON environment variable to the full path of python.exe.".to_string();
        if !silent.is_empty() {
            silent.dedup();
            message += &format!(" (No answer within {}, and ended: {}.)", limit_text(PROBE_LIMIT), silent.join(", "));
        }
        message
    })
}

/// One line at the end of ila_log.txt, in the form the bridge writes its own. A log that cannot be written is
/// no reason to fail.
fn append_log(log: &Path, time: &str, text: &str) {
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = file.write_all(format!("[{time}] {text}\n").as_bytes());
    }
}

/// A time limit as a message names it.
fn limit_text(limit: Duration) -> String {
    let secs = limit.as_secs();
    if secs >= 60 && secs.is_multiple_of(60) { format!("{} min", secs / 60) } else { format!("{secs} s") }
}

/// Reads a pipe of a child process to its end on a thread of its own, and hands over what came.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut all = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut all);
        }
        let _ = tx.send(all);
    });
    rx
}

/// Runs a command to its end and takes what it printed, as `Command::output` does - but for no longer than
/// `limit`: a child that is still running then is ended, with everything it started, and the answer is `None`.
/// `output` itself takes no limit. Both pipes are read on threads of their own while the wait goes on: a child
/// that prints more than a pipe holds would otherwise wait for its reader for good.
fn output_within(cmd: &mut Command, limit: Duration) -> std::io::Result<Option<std::process::Output>> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            kill_tree(child.id());
            // should the tree not have gone that way: the child itself at least
            if child.kill().is_ok() {
                let _ = child.wait();
            }
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    // The pipes end with the child - unless something it started lives on and holds them. That is given the
    // rest of the limit (a moment at least: what the child printed last is still on its way), not for ever.
    let until = deadline.max(Instant::now() + Duration::from_secs(2));
    let left = || until.saturating_duration_since(Instant::now());
    match (stdout.recv_timeout(left()), stderr.recv_timeout(left())) {
        (Ok(stdout), Ok(stderr)) => Ok(Some(std::process::Output { status, stdout, stderr })),
        _ => Ok(None),
    }
}

fn bridge_command() -> Result<Command, String> {
    let root = project_root();
    let bridge = root.join("ila_bridge.py");
    if !bridge.is_file() {
        return Err(format!(
            "ila_bridge.py was not found in {} - keep the executable in the same folder as the Python scripts, or name their folder in the environment variable ILA_HOME.",
            root.display()
        ));
    }
    let mut cmd = Command::new(python_exe()?);
    cmd.arg(&bridge)
        .current_dir(&root)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        // no __pycache__ in the program folder: that is where the scripts are
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null());
    no_window(&mut cmd);
    Ok(cmd)
}

// How long the offline commands of the bridge may take. A hardware job has its limit in run_hw_job; these had
// none, and one that hung - a file on a drive that does not answer, a virus scanner that holds the interpreter -
// was waited for without end. Each command has its own: what is ample for a probe file would cut the reading of
// a large capture off.
/// list-profiles looks whether the probe file of every profile is there, and Windows takes tens of seconds to
/// give up on each one that is on a server it cannot reach.
const LIST_PROFILES_LIMIT: Duration = Duration::from_secs(5 * 60);
/// A probe file is small: what takes long is the drive it is on.
const PARSE_LTX_LIMIT: Duration = Duration::from_secs(2 * 60);
/// The demo data, which is a million rows at most: seconds.
const DEMO_CAPTURE_LIMIT: Duration = Duration::from_secs(5 * 60);

/// How long the reading of a capture file of this size may take. The bridge reads the file whole. A million
/// samples of the demo data - 40 MB as CSV, and far more samples than an ILA holds - take one or two seconds on
/// a desktop PC: the five minutes are for a slow PC and a slow drive. A file can be larger than that all the
/// same, and a compressed one holds many times its size - so every 10 MB add a minute: a large capture that is
/// slow to read is not what the limit is there to end.
fn capture_read_limit(bytes: u64) -> Duration {
    Duration::from_secs(5 * 60 + bytes / (10 * 1024 * 1024) * 60)
}

/// Run an offline bridge command and parse the single JSON document it prints. One that has not ended within
/// `limit` is ended, and the answer says so.
fn bridge_json(args: &[&str], limit: Duration) -> Result<Value, String> {
    let command = args.first().copied().unwrap_or("");
    let output = output_within(bridge_command()?.args(args), limit)
        .map_err(|e| format!("Failed to start the Python bridge: {e}"))?
        .ok_or_else(|| {
            format!(
                "ila_bridge.py {command} did not finish within {} and was ended: Python hangs, or a file it reads is very large or on a drive that does not answer.",
                limit_text(limit)
            )
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        return Err(format!("ila_bridge.py {command} failed: {detail}"));
    }
    serde_json::from_str(stdout.trim().trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Unreadable answer from ila_bridge.py {command}: {e}"))
}

/// A capture file as the page shows it ("parse-csv" of the bridge).
fn read_capture(path: &str, max_samples: &str) -> Result<Value, String> {
    let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    reject_error(bridge_json(&["parse-csv", "--file", path, "--max-samples", max_samples], capture_read_limit(bytes))?)
}

/// A bridge answer of the form {"error": "..."} is a failure, not data.
fn reject_error(value: Value) -> Result<Value, String> {
    match value.get("error").and_then(Value::as_str) {
        Some(e) => Err(e.to_string()),
        None => Ok(value),
    }
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

/// The bridge starts `cmd /c vivado.bat`, which starts Vivado: only killing the tree ends all of them.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = no_window(&mut cmd).status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

fn set_session(app: &AppHandle, session: &Mutex<Value>, value: Value) {
    *lock(session) = value.clone();
    let _ = app.emit("ila-session", value);
}

/// Reads what the bridge prints. "@@STATE" lines - its Vivado session opened or closed - are acted on here, at
/// any time; everything else goes to whichever job is listening. When stdout ends, the bridge is gone, and with
/// it any session it held.
fn read_lines<R: Read + Send + 'static>(
    stream: R,
    is_err: bool,
    tx: mpsc::Sender<(bool, String)>,
    app: AppHandle,
    session: Arc<Mutex<Value>>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    if !is_err {
                        if let Some(payload) = line.strip_prefix("@@STATE ") {
                            if let Ok(v) = serde_json::from_str::<Value>(payload) {
                                set_session(&app, &session, v);
                            }
                            continue;
                        }
                    }
                    if tx.send((is_err, line)).is_err() {
                        break;
                    }
                }
            }
        }
        if !is_err {
            let was_connected = lock(&session).get("connected").and_then(Value::as_bool) == Some(true);
            if was_connected {
                set_session(&app, &session, json!({ "connected": false, "reason": "the bridge process ended" }));
            }
        }
    });
}

fn spawn_server(app: &AppHandle, session: &Arc<Mutex<Value>>) -> Result<HwServer, String> {
    let mut cmd = bridge_command()?;
    cmd.arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start the Python bridge: {e}"))?;
    let stdin = child.stdin.take().ok_or("The Python bridge has no input pipe.")?;
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    if let Some(out) = child.stdout.take() {
        read_lines(out, false, tx.clone(), app.clone(), session.clone());
    }
    if let Some(err) = child.stderr.take() {
        read_lines(err, true, tx, app.clone(), session.clone());
    }
    Ok(HwServer { child, stdin, rx })
}

/// End the bridge in order: closing its input is its signal to close the Vivado session (which puts the cable's
/// JTAG clock back) and exit. Only one that does not go within `grace` is killed.
fn shutdown_server(server: &Mutex<Option<HwServer>>, grace: Duration) {
    let Some(HwServer { mut child, stdin, rx }) = lock(server).take() else {
        return;
    };
    drop(stdin);
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if Instant::now() >= deadline => {
                kill_tree(child.id());
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    drop(rx);
}

const MAX_LOG_LINES: usize = 5000;
/// Label of the pop-out window that shows only the signal analysis.
const ANALYSIS_WINDOW: &str = "analysis";

/// Run a hardware command of the bridge to its answer. Progress lines go to the UI as "ila-log" events while it
/// runs, each finished capture as an "ila-capture" event; the returned value is the bridge's "@@RESULT" with
/// the whole log attached. Only one such job may run at a time - they would fight over the same JTAG cable.
/// `args` is the command line of the hardware command; the bridge process that carries it out stays up
/// afterwards and keeps its Vivado session for the next job.
fn run_hw_job(
    app: &AppHandle,
    hw: &HwHandles,
    kind: &'static str,
    args: Vec<String>,
    timeout: Duration,
) -> Result<Value, String> {
    let stop_file = std::env::temp_dir().join(format!("ila_studio_stop_{}_{}.flag", std::process::id(), kind));

    // the job slot first: it is what "one at a time" and the Stop button go by
    {
        let mut slot = lock(&hw.job);
        if let Some(running) = slot.as_ref() {
            return Err(format!(
                "Another hardware operation ({}) is still running - stop it or wait for it to finish.",
                running.kind
            ));
        }
        static NEXT_JOB: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT_JOB.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *slot = Some(HwJob { id, pid: 0, stop_file: stop_file.clone(), kind });
    }
    let _ = fs::remove_file(&stop_file);

    // held for the whole job: nobody else talks to the bridge meanwhile
    let mut server_slot = lock(&hw.server);
    let alive = match server_slot.as_mut() {
        Some(server) => matches!(server.child.try_wait(), Ok(None)),
        None => false,
    };
    if !alive {
        *server_slot = None;
        match spawn_server(app, &hw.session) {
            Ok(server) => *server_slot = Some(server),
            Err(e) => {
                *lock(&hw.job) = None;
                return Err(e);
            }
        }
    }
    let server = server_slot.as_mut().expect("set above");
    let pid = server.child.id();
    if let Some(job) = lock(&hw.job).as_mut() {
        job.pid = pid;
    }

    let mut result: Option<Value> = None;
    // a ring: after hours of continuous capture it is the END of the log that explains how the run ended
    let mut log: VecDeque<String> = VecDeque::new();
    let handle = |is_err: bool, line: String, result: &mut Option<Value>, log: &mut VecDeque<String>| {
        if !is_err {
            if let Some(payload) = line.strip_prefix("@@RESULT ") {
                *result = Some(serde_json::from_str(payload).unwrap_or_else(
                    |_| json!({ "success": false, "message": "The bridge sent an answer that cannot be read." }),
                ));
                return;
            }
            if let Some(payload) = line.strip_prefix("@@CAPTURE ") {
                if let Ok(v) = serde_json::from_str::<Value>(payload) {
                    let _ = app.emit("ila-capture", v);
                }
                return;
            }
        }
        if line.is_empty() {
            return;
        }
        let _ = app.emit("ila-log", &line);
        if log.len() == MAX_LOG_LINES {
            log.pop_front();
        }
        log.push_back(line);
    };

    // what the bridge said since the last job (a kept session closing by itself, say) belongs to no job: it is
    // shown in the log, but an answer among it is not the answer to this request
    while let Ok((is_err, line)) = server.rx.try_recv() {
        if !line.starts_with("@@RESULT ") {
            let mut ignored: Option<Value> = None;
            handle(is_err, line, &mut ignored, &mut log);
        }
    }

    let request = json!({ "argv": args, "stop_file": stop_file.to_string_lossy() }).to_string();
    let sent = server.stdin.write_all(request.as_bytes()).and_then(|_| server.stdin.write_all(b"\n")).and_then(|_| server.stdin.flush());

    let started = Instant::now();
    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;
    let mut gone = sent.is_err();
    while result.is_none() && !gone {
        match server.rx.recv_timeout(Duration::from_millis(100)) {
            Ok((is_err, line)) => handle(is_err, line, &mut result, &mut log),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => gone = true,
        }
        if result.is_some() || gone {
            break;
        }
        match server.child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                gone = true;
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    timed_out = true;
                    kill_tree(pid);
                    let _ = server.child.wait();
                    gone = true;
                }
            }
            Err(_) => gone = true,
        }
    }
    if gone {
        // it ended (or was ended by Stop's last resort, or by the timeout): take what it still said
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            match server.rx.recv_timeout(Duration::from_millis(100)) {
                Ok((is_err, line)) => handle(is_err, line, &mut result, &mut log),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !matches!(server.child.try_wait(), Ok(None)) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if matches!(server.child.try_wait(), Ok(None)) {
            kill_tree(pid);
            let _ = server.child.wait();
        }
        *server_slot = None; // the next job starts a new one
    }
    drop(server_slot);

    let stop_requested = stop_file.exists();
    *lock(&hw.job) = None;
    let _ = fs::remove_file(&stop_file);

    let mut value = result.unwrap_or_else(|| {
        if stop_requested {
            // ended on request before the bridge could answer: that is a stop, not a failure
            return json!({ "success": false, "stopped": true, "message": "Stopped: the session was ended before it answered." });
        }
        let last = log.iter().rev().find(|l| !l.trim().is_empty()).cloned().unwrap_or_default();
        json!({
            "success": false,
            "message": if last.is_empty() {
                format!("The Python bridge ended without an answer (exit code {exit_code:?}).")
            } else {
                last
            },
        })
    });
    if let Some(obj) = value.as_object_mut() {
        if timed_out {
            obj.insert("success".into(), Value::Bool(false));
            obj.insert(
                "message".into(),
                Value::String(format!("Timed out after {} s; the session was ended.", timeout.as_secs())),
            );
        }
        let text = log.iter().map(String::as_str).collect::<Vec<_>>().join("\n");
        obj.insert("log".into(), Value::String(text));
    }
    Ok(value)
}

/// Ask a job to end in order and wait for it: the stop file, then up to `grace` for the bridge to close the
/// Vivado session (which also puts the cable's JTAG clock back), and only then the kill.
fn stop_job(jobs: &Mutex<Option<HwJob>>, job: &HwJob, grace: Duration) -> bool {
    let _ = fs::write(&job.stop_file, b"stop");
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
        if lock(jobs).as_ref().map(|j| j.id) != Some(job.id) {
            return true; // that job is over (another one may have started meanwhile: it is not ours to end)
        }
    }
    // the last resort; with it goes the bridge and the Vivado session it kept (the next job starts new ones)
    let pid = lock(jobs).as_ref().filter(|j| j.id == job.id).map(|j| j.pid).unwrap_or(0);
    if pid != 0 {
        kill_tree(pid);
    }
    false
}

struct HwArgs {
    profile: Option<String>,
    ltx: Option<String>,
    tcl: Option<String>,
    server: Option<String>,
    device: Option<String>,
    ila_index: Option<u32>,
    ila_cell: Option<String>,
    jtag_hz: Option<u64>,
    omit_jtag_freq: Option<bool>,
    engines: Option<u32>,
}

fn push_hw_args(args: &mut Vec<String>, hw: HwArgs) {
    let mut opt = |flag: &str, value: Option<String>| {
        if let Some(v) = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            args.push(flag.to_string());
            args.push(v);
        }
    };
    opt("--profile", hw.profile);
    opt("--ltx", hw.ltx);
    opt("--tcl", hw.tcl);
    opt("--server", hw.server);
    opt("--device", hw.device);
    opt("--ila-index", hw.ila_index.map(|i| i.to_string()));
    // the core by name: its position in the device's list need not be its position in the probe file
    opt("--ila-cell", hw.ila_cell);
    // 0 = automatic: the cable default, lowered when it is too fast for the design's debug hub. It is always
    // sent, so that the choice made in the UI wins over a frequency stored in the profile.
    let hz = if hw.omit_jtag_freq == Some(true) { 0 } else { hw.jtag_hz.unwrap_or(0) };
    opt("--jtag-hz", Some(hz.to_string()));
    // always sent as well: the session then has as many Vivado engines as the box in the UI says
    opt("--engines", Some(hw.engines.unwrap_or(1).clamp(1, 3).to_string()));
}

/// A name as a file name can carry it: letters, digits, "_", "-" and "." of ASCII, anything else as "_".
fn clean_file_stem(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') { c } else { '_' })
        .collect();
    // no leading dash either: the name is a command-line argument, and "-x" would be read as an option. Dots
    // and dashes go off the front together: taken one kind after the other, "-.x" would keep its dot.
    cleaned.trim_start_matches(['.', '-']).trim_end_matches('.').to_string()
}

/// Windows keeps a few names for its devices, in any letter case and whatever follows the first dot: no file
/// of such a name comes into being.
fn is_device_name(stem: &str) -> bool {
    let first = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(first.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (first.len() == 4
            && (first.starts_with("COM") || first.starts_with("LPT"))
            && first.as_bytes()[3].is_ascii_digit())
}

/// The name the files of a capture get. A device name gets a "_" in front, as a profile of such a name does:
/// Vivado would be asked to write aux.csv, and the error would not lead back to the name.
fn safe_file_stem(name: &str) -> String {
    let mut cleaned = clean_file_stem(name);
    if cleaned.is_empty() {
        return "capture".to_string();
    }
    if is_device_name(&cleaned) {
        cleaned.insert(0, '_');
    }
    cleaned
}

/// The file a profile of this name is saved in. A name without a single letter or digit of ASCII would be a row
/// of underscores, and a device name of Windows is no file.
fn profile_file_name(name: &str) -> String {
    let mut stem: String = clean_file_stem(name).chars().take(80).collect();
    if !stem.chars().any(|c| c.is_ascii_alphanumeric()) {
        stem = "profile".to_string();
    }
    if is_device_name(&stem) {
        stem.insert(0, '_');
    }
    format!("{stem}.json")
}

// ---------------------------------------------------------------- Tauri Commands

#[tauri::command]
async fn list_profiles() -> Result<Value, String> {
    blocking(|| bridge_json(&["list-profiles"], LIST_PROFILES_LIMIT)).await
}

/// The profile file of the folder that is called `name`, as the folder writes it: a profile of the list is named
/// by its file, and nothing else is taken for one - not a path, not a stream of a file.
fn listed_profile_file(dir: &Path, name: &str) -> Option<String> {
    let wanted = name.to_lowercase();
    fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let file = entry.file_name().to_string_lossy().to_string();
        let lower = file.to_lowercase();
        (lower == wanted && lower.ends_with(".json") && entry.path().is_file()).then_some(file)
    })
}

/// Does this file hold the profile of this name (in whatever case it was typed)?
fn holds_profile(path: &Path, name: &str) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|data| data.get("name").and_then(Value::as_str).map(|n| n.trim().to_lowercase() == name.to_lowercase()))
        .unwrap_or(false)
}

/// The file a new profile of this name goes into. Different names can come out as one file name ("a b" and
/// "a/b"; every name without a letter of ASCII): a file that holds ANOTHER profile is not in the way then - the
/// new one gets a name of its own beside it, with a number.
fn new_profile_file(dir: &Path, name: &str) -> String {
    let first = profile_file_name(name);
    if !dir.join(&first).exists() || holds_profile(&dir.join(&first), name) {
        return first;
    }
    // one ".json", that of the file: a name that ends in ".json" itself keeps its own in front of the number
    let stem = first.strip_suffix(".json").unwrap_or(&first);
    (2..1000)
        .map(|n| format!("{stem}-{n}.json"))
        .find(|file| !dir.join(file).exists() || holds_profile(&dir.join(file), name))
        .unwrap_or(first)
}

/// A profile without the date of its save. A page that has not changed, saved again, differs in nothing else -
/// and as JSON the order of its keys, which the list of profiles does not keep, is no difference either.
fn undated(mut profile: Value) -> Value {
    let date = profile.pointer("/gui/saved").and_then(Value::as_str).map(str::to_string);
    if let Some(gui) = profile.get_mut("gui").and_then(Value::as_object_mut) {
        gui.remove("saved");
    }
    let note = profile.get("_comment").and_then(Value::as_str).map(str::to_string);
    if let (Some(date), Some(note)) = (date, note) {
        profile["_comment"] = Value::String(note.replacen(&date, "", 1));
    }
    profile
}

fn read_only(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.permissions().readonly()).unwrap_or(false)
}

/// A copy takes the read-only mark of its source along; a kept copy must stay replaceable.
fn make_writable(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        let mut permissions = meta.permissions();
        if permissions.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

/// "Save configuration" of the page: writes a profile into the folder list-profiles reads (profiles, next to
/// ila_bridge.py). `text` is the profile as JSON, laid out by the page. `file` names the profile file of that
/// folder that is to be replaced (the page saves under the name of a profile it lists); without it the file is
/// named after `name`. A file that is there is only replaced when `overwrite` says so - the answer then tells
/// the page to ask. What it held is kept beside it (the answer says as what): a profile written by hand once
/// and for good as <file>.orig, anything else as <file>.bak, the state before the last save.
#[tauri::command]
async fn save_profile(
    name: String,
    text: String,
    overwrite: Option<bool>,
    file: Option<String>,
) -> Result<Value, String> {
    blocking(move || {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Give the configuration a name.".to_string());
        }
        let data: Value = serde_json::from_str(&text).map_err(|e| format!("The configuration is not valid JSON: {e}"))?;
        if !data.is_object() {
            return Err("The configuration is not a profile (a JSON object).".to_string());
        }
        let dir = project_root().join("profiles");
        fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        let filename = match file.map(|f| f.trim().to_string()).filter(|f| !f.is_empty()) {
            Some(f) => listed_profile_file(&dir, &f).ok_or_else(|| format!("{f} is not a profile of the profiles folder."))?,
            None => new_profile_file(&dir, &name),
        };
        let path = dir.join(&filename);
        let there = path.exists();
        let answer = |saved: bool, kept: Option<String>| {
            json!({ "saved": saved, "exists": there, "kept": kept, "filename": filename, "path": path.to_string_lossy() })
        };
        if there && overwrite != Some(true) {
            return Ok(answer(false, None));
        }
        let text = text.trim_end().to_string() + "\n";
        let before = if there { fs::read_to_string(&path).ok() } else { None };
        // it holds this already (the day of the save aside): nothing to write, and nothing to push out of the
        // copy that is kept from the save before
        let held = before.as_deref().and_then(|old| serde_json::from_str::<Value>(old).ok());
        if before.as_deref() == Some(text.as_str()) || held.is_some_and(|old| undated(old) == undated(data.clone())) {
            return Ok(answer(true, None));
        }
        if there && read_only(&path) {
            return Err(format!("{} is read-only: it was not replaced.", path.display()));
        }
        // written beside it first and then put in its place: a profile is never left half written
        let fresh = dir.join(format!("{filename}.tmp"));
        fs::write(&fresh, &text).map_err(|e| format!("Could not write {}: {e}", fresh.display()))?;
        if !there {
            return match fs::rename(&fresh, &path) {
                Ok(()) => Ok(answer(true, None)),
                Err(e) => {
                    let _ = fs::remove_file(&fresh);
                    Err(format!("Could not write {}: {e}", path.display()))
                }
            };
        }
        // What was there: copied first, and given its name only when the profile is in place - a save that fails
        // must not cost the copy kept from the save before. A profile nobody saved from the page (no section
        // "gui": written by hand, or not readable at all) is kept under a name no later save takes.
        let by_hand = before
            .as_deref()
            .and_then(|old| serde_json::from_str::<Value>(old).ok())
            .is_none_or(|old| !old.get("gui").is_some_and(Value::is_object));
        let orig = format!("{filename}.orig");
        let keep_as = if by_hand && !dir.join(&orig).exists() { orig } else { format!("{filename}.bak") };
        let copy = dir.join(format!("{filename}.bak.tmp"));
        let put = || -> Result<(), String> {
            fs::copy(&path, &copy).map_err(|e| format!("Could not keep the profile that was there ({}): {e}", copy.display()))?;
            make_writable(&copy);
            fs::rename(&fresh, &path).map_err(|e| format!("Could not write {}: {e}", path.display()))
        };
        if let Err(e) = put() {
            let _ = fs::remove_file(&fresh);
            let _ = fs::remove_file(&copy);
            return Err(e);
        }
        make_writable(&dir.join(&keep_as));
        // The profile is saved. Should the copy not get its name (the .bak is open in another program), it is not
        // left under the working name: the next save writes over that before it has saved anything.
        let kept = match fs::rename(&copy, dir.join(&keep_as)) {
            Ok(()) => keep_as,
            Err(_) => {
                let spare = format!("{filename}.bak.kept");
                make_writable(&dir.join(&spare));
                match fs::rename(&copy, dir.join(&spare)) {
                    Ok(()) => spare,
                    Err(_) => format!("{filename}.bak.tmp"),
                }
            }
        };
        Ok(answer(true, Some(kept)))
    })
    .await
}

#[tauri::command]
async fn parse_ltx(path: String) -> Result<Value, String> {
    blocking(move || bridge_json(&["parse-ltx", "--ltx", &path], PARSE_LTX_LIMIT)).await
}

#[tauri::command]
async fn load_csv_data(file_path: String, max_samples: Option<usize>) -> Result<Value, String> {
    blocking(move || read_capture(&file_path, &max_samples.unwrap_or(4096).to_string())).await
}

/// The most captures one import brings into the list (the list itself holds no more).
const MAX_IMPORT: usize = 2000;
/// How far below a folder that was named its captures are looked for: the folder that holds the session folders
/// may be given as well as a session folder itself.
const IMPORT_DEPTH: usize = 2;

/// Is this file an ILA capture? A session folder also holds index.csv (and run_summary.csv), which are none:
/// only what Vivado exports - and the demo data - begins with this column. A compressed CSV and a .ila are
/// taken by their names; reading them tells.
fn is_capture_file(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.ends_with(".ila") || name.ends_with(".csv.gz") {
        return true;
    }
    if !name.ends_with(".csv") {
        return false;
    }
    const START: &[u8] = b"Sample in Buffer,";
    let mut head = [0u8; 17];
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head == START
}

/// Folder and name without ".csv" / ".csv.gz" / ".ila", in lower case: what a capture's files have in common.
fn capture_stem(path: &Path) -> (String, String) {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let cut = [".csv.gz", ".csv", ".ila"].iter().find(|ext| name.ends_with(*ext)).map_or(0, |ext| ext.len());
    (path.parent().map(|d| d.to_string_lossy().to_lowercase()).unwrap_or_default(), name[..name.len() - cut].to_string())
}

/// A name in the order one counts in: every run of digits is compared as a number, so that window 10000 of a run
/// comes after window 9999 and not between 1000 and 1001.
fn natural_key(text: &str) -> Vec<(bool, usize, String)> {
    let mut key = Vec::new();
    let mut run = String::new();
    let mut digits = false;
    let mut flush = |run: &mut String, digits: bool| {
        if run.is_empty() {
            return;
        }
        if digits {
            let number = run.trim_start_matches('0');
            key.push((false, number.len(), number.to_string()));
        } else {
            key.push((true, 0, run.clone()));
        }
        run.clear();
    };
    for c in text.to_lowercase().chars() {
        if c.is_ascii_digit() != digits {
            flush(&mut run, digits);
            digits = c.is_ascii_digit();
        }
        run.push(c);
    }
    flush(&mut run, digits);
    key
}

fn is_plain_csv(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("csv"))
}

/// Which of the forms a capture is written in this file is, by its name: 0 for .csv, 1 for .csv.gz, 2 for .ila -
/// the order they are taken in where a capture exists in several, which is that of "summary" in ila_capture.py.
fn capture_form(path: &Path) -> Option<usize> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    [".csv", ".csv.gz", ".ila"].iter().position(|ext| name.ends_with(ext))
}

/// A capture that exists in several forms next to each other is one capture: the .csv is taken, it reads
/// fastest, without one the .csv.gz ("watch" compresses each CSV), and the .ila only where it is all there is.
/// The others of `paths` are dropped; what stays keeps its order.
fn drop_twins(paths: &mut Vec<PathBuf>) {
    let mut best: HashMap<(String, String), usize> = HashMap::new();
    for path in paths.iter() {
        if let Some(form) = capture_form(path) {
            let taken = best.entry(capture_stem(path)).or_insert(form);
            *taken = (*taken).min(form);
        }
    }
    paths.retain(|p| capture_form(p).is_none_or(|form| best.get(&capture_stem(p)) == Some(&form)));
}

/// The capture files in `dir` and, `depth` levels down, in its folders - each folder's in the order of their
/// names, which for a session is the order they were taken in. `skipped` counts the CSVs that are no captures.
/// It stops one capture beyond what an import takes, so that the caller can tell there were more.
fn collect_captures(dir: &Path, depth: usize, found: &mut Vec<PathBuf>, skipped: &mut usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    drop_twins(&mut paths);
    paths.sort_by_cached_key(|p| natural_key(&p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    for path in paths {
        if found.len() > MAX_IMPORT {
            return;
        }
        if path.is_dir() {
            if depth > 0 {
                collect_captures(&path, depth - 1, found, skipped);
            }
        } else if is_capture_file(&path) {
            found.push(path);
        } else if is_plain_csv(&path) {
            *skipped += 1;
        }
    }
}

/// What an import of these files and folders brings: the captures among them, in the order of their paths, with
/// the time each file was written.
#[tauri::command]
async fn scan_capture_paths(paths: Vec<String>) -> Result<Value, String> {
    blocking(move || {
        let mut found: Vec<PathBuf> = Vec::new();
        let mut skipped = 0usize;
        for given in &paths {
            let path = PathBuf::from(given);
            if path.is_dir() {
                collect_captures(&path, IMPORT_DEPTH, &mut found, &mut skipped);
            } else if is_capture_file(&path) {
                found.push(path);
            } else if path.is_file() {
                skipped += 1;
            }
        }
        drop_twins(&mut found); // of files that were named one by one
        found.sort_by_cached_key(|p| natural_key(&p.to_string_lossy()));
        found.dedup();
        let truncated = found.len() > MAX_IMPORT;
        found.truncate(MAX_IMPORT);
        let files: Vec<Value> = found
            .iter()
            .map(|p| {
                let modified = fs::metadata(p)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                json!({ "path": p.to_string_lossy(), "modifiedMs": modified })
            })
            .collect();
        Ok(json!({ "files": files, "skipped": skipped, "truncated": truncated }))
    })
    .await
}

/// Where the captures of this installation are written, as the place a file dialog starts in.
#[tauri::command]
async fn captures_folder() -> Result<String, String> {
    let root = project_root();
    let captures = root.join("captures");
    Ok(if captures.is_dir() { captures } else { root }.to_string_lossy().to_string())
}

#[tauri::command]
async fn create_demo_capture(samples: Option<u32>) -> Result<Value, String> {
    blocking(move || {
        // bounded: the bridge writes one row per sample, and nothing else limits what the page may ask for
        let count = samples.unwrap_or(2048).clamp(1, 1_000_000).to_string();
        let made = bridge_json(&["demo-capture", "--samples", &count], DEMO_CAPTURE_LIMIT)?;
        let path = made["filePath"].as_str().ok_or("The demo capture was not written.")?.to_string();
        read_capture(&path, "4096")
    })
    .await
}

#[tauri::command]
async fn run_single_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CaptureRequest,
) -> Result<Value, String> {
    let hw = state.handles();
    blocking(move || {
        let mut args = vec!["capture".to_string()];
        push_hw_args(
            &mut args,
            HwArgs {
                profile: request.profile,
                ltx: request.ltx,
                tcl: request.tcl,
                server: request.server,
                device: request.device,
                ila_index: request.ila_index,
                ila_cell: request.ila_cell,
                jtag_hz: request.jtag_hz,
                omit_jtag_freq: request.omit_jtag_freq,
                engines: request.engines,
            },
        );
        let continuous = request.continuous == Some(true);
        let trigger = request.trigger.trim();
        // bounded: Duration::from_secs_f64 panics on a number too large to represent, and a panic ends the app
        let wait_min = request.timeout_min.filter(|m| m.is_finite() && *m > 0.0).unwrap_or(1.0).min(7.0 * 24.0 * 60.0);
        let format = if matches!(request.format.as_str(), "both" | "csv" | "ila") { request.format.as_str() } else { "csv" };
        args.extend(
            [
                "--name", &safe_file_stem(&request.capture_name),
                "--trigger", if trigger.is_empty() { "now" } else { trigger },
                "--position", &request.position.to_string(),
                "--timeout-min", &wait_min.to_string(),
                "--format", format,
                "--count", if continuous { "0" } else { "1" },
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        // Always sent, an empty choice too: what the probe list shows is what is written, whatever a profile
        // may list of its own.
        let formats = request.probe_formats.unwrap_or_default();
        args.push("--probe-formats".to_string());
        args.push(serde_json::to_string(&formats).unwrap_or_else(|_| "{}".to_string()));
        // Twice the trigger wait plus Vivado start-up, upload and shutdown: a capture that fails in a session
        // kept open from an earlier job is tried once more in a fresh one, with a new wait. A continuous run
        // ends on Stop.
        let limit = if continuous {
            Duration::from_secs(7 * 24 * 3600)
        } else {
            Duration::from_secs_f64(2.0 * wait_min * 60.0 + 900.0)
        };
        run_hw_job(&app, &hw, "capture", args, limit)
    })
    .await
}

fn query_args(command: &str, request: HardwareQueryRequest) -> Vec<String> {
    let mut args = vec![command.to_string()];
    push_hw_args(
        &mut args,
        HwArgs {
            profile: request.profile,
            ltx: request.ltx,
            tcl: request.tcl,
            server: request.server,
            device: request.device,
            ila_index: request.ila_index,
            ila_cell: request.ila_cell,
            jtag_hz: request.jtag_hz,
            omit_jtag_freq: request.omit_jtag_freq,
            engines: request.engines,
        },
    );
    args
}

#[tauri::command]
async fn query_hardware_info(
    app: AppHandle,
    state: State<'_, AppState>,
    request: HardwareQueryRequest,
) -> Result<Value, String> {
    let hw = state.handles();
    blocking(move || {
        run_hw_job(&app, &hw, "hardware query", query_args("query-hardware", request), Duration::from_secs(600))
    })
    .await
}

/// Close the Vivado session the bridge keeps open between jobs: Vivado exits and the cable gets its JTAG clock
/// back. The next hardware job (or "Connect") opens a new one.
#[tauri::command]
async fn disconnect_hardware(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let hw = state.handles();
    blocking(move || {
        if lock(&hw.server).is_none() {
            return Ok(json!({ "success": true, "message": "No hardware session was open." }));
        }
        run_hw_job(&app, &hw, "disconnect", vec!["disconnect".to_string()], Duration::from_secs(120))
    })
    .await
}

/// What the bridge last reported about its Vivado session: {"connected": bool, "device", "tckHz", "server"}.
#[tauri::command]
async fn hardware_session(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(lock(&state.session).clone())
}

/// What "Stop" found, as data (StopAnswer in src/types.ts). The page goes by these fields and never by the
/// wording of a sentence: a sentence is for people, and rewording one must not change what the page does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct StopAnswer {
    /// a job was in flight when the stop arrived; false: there was nothing to stop
    running: bool,
    /// it stayed silent beyond the grace and was killed, the bridge and its session with it
    killed: bool,
}

/// The body of stop_hardware_job, on the job slot alone so that a test can call it: the job in flight is asked
/// to end and waited for (see stop_job), and the answer says whether there was one at all.
fn stop_running_job(jobs: &Mutex<Option<HwJob>>, grace: Duration) -> StopAnswer {
    let Some(job) = lock(jobs).clone() else {
        return StopAnswer { running: false, killed: false };
    };
    StopAnswer { running: true, killed: !stop_job(jobs, &job, grace) }
}

/// Ask the running hardware job to end. The bridge and the Tcl side watch for the stop file and then end the
/// job in order; the Vivado session stays open for the next one. That normally takes about a second; the long
/// grace is for a stop that arrives while Vivado is still starting or a large upload is being written - only a
/// job that stays silent beyond it is killed, and with it the bridge and its session (the next job starts new
/// ones; a killed session cannot put the cable's JTAG clock back, which the next connect repairs).
#[tauri::command]
async fn stop_hardware_job(state: State<'_, AppState>) -> Result<StopAnswer, String> {
    let jobs = state.job.clone();
    blocking(move || Ok(stop_running_job(&jobs, Duration::from_secs(90)))).await
}

/// The kind of hardware job in flight, if any. The page asks at start-up: after a reload its own state is gone
/// while the job runs on, and without this it could neither show nor stop it.
#[tauri::command]
async fn current_hardware_job(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(lock(&state.job).as_ref().map(|j| j.kind.to_string()))
}

/// The analysis view in a window of its own, so it can sit on another screen. The page is the same bundle; it
/// shows the analysis instead of the whole app because of the window label (see src/main.tsx).
#[tauri::command]
async fn open_analysis_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(ANALYSIS_WINDOW) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, ANALYSIS_WINDOW, tauri::WebviewUrl::App("index.html".into()))
        .title("ILA Signal Analysis")
        .inner_size(1300.0, 860.0)
        .min_inner_size(820.0, 520.0)
        .build()
        .map_err(|e| format!("Could not open the analysis window: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn close_analysis_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ANALYSIS_WINDOW) {
        window.close().map_err(|e| format!("Could not close the analysis window: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn analysis_window_open(app: AppHandle) -> Result<bool, String> {
    Ok(app.get_webview_window(ANALYSIS_WINDOW).is_some())
}

#[tauri::command]
async fn open_log_file() -> Result<String, String> {
    blocking(|| {
        let log = project_root().join("ila_log.txt");
        if !log.exists() {
            fs::write(&log, b"").map_err(|e| format!("Could not create {}: {e}", log.display()))?;
        }
        Command::new("notepad.exe")
            .arg(&log)
            .spawn()
            .map_err(|e| format!("Could not open {}: {e}", log.display()))?;
        Ok(log.to_string_lossy().to_string())
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // before anything else, so that a panic anywhere below can be reported - if the user has switched that on
    crash_reports::init();
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            // Closing the window must not leave Vivado behind, holding the JTAG target - but it gets the same
            // orderly stop as the Stop button first, because a killed session cannot put the cable's JTAG
            // clock back. The process lives on without a window for those few seconds at most.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == ANALYSIS_WINDOW {
                    // only the pop-out went away: the main window shows the analysis in its tab again
                    let _ = window.app_handle().emit("analysis-window-closed", ());
                    return;
                }
                // the main window: the pop-out goes with it, or the app would live on as that window alone
                if let Some(popout) = window.app_handle().get_webview_window(ANALYSIS_WINDOW) {
                    let _ = popout.destroy();
                }
                let hw = window.state::<AppState>().handles();
                let job = lock(&hw.job).clone();
                if let Some(job) = job {
                    stop_job(&hw.job, &job, Duration::from_secs(15));
                    let _ = fs::remove_file(&job.stop_file);
                }
                // and the session that was kept open between jobs: the bridge closes it when its input ends
                shutdown_server(&hw.server, Duration::from_secs(12));
                // Last, when the hardware is let go: a crash report that is still on its way out gets two
                // seconds to leave. Usually none is, and this does not wait at all.
                crash_reports::flush(Duration::from_secs(2));
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            save_profile,
            parse_ltx,
            load_csv_data,
            scan_capture_paths,
            captures_folder,
            create_demo_capture,
            run_single_capture,
            query_hardware_info,
            stop_hardware_job,
            current_hardware_job,
            disconnect_hardware,
            hardware_session,
            open_analysis_window,
            close_analysis_window,
            analysis_window_open,
            open_log_file,
            crash_reports::crash_reports_state,
            crash_reports::set_crash_reports,
            crash_reports::report_frontend_error,
            crash_reports::send_test_crash_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------- Tests

// Only the helpers that need neither Python nor Vivado nor a window. Every name in the test data is invented.
#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own for one test, below the system's temporary folder; it goes when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(test: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("ila_studio_test_{}_{test}", std::process::id()));
            let _ = fs::remove_dir_all(&dir); // what a run that was killed left behind
            fs::create_dir_all(&dir).expect("temporary folder");
            Scratch(dir)
        }

        /// Writes a file below the folder (with the folders on the way) and returns its path.
        fn file(&self, name: &str, content: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().expect("a file is in a folder")).expect("folder");
            fs::write(&path, content).expect("file");
            path
        }

        /// A path below the folder as it is written here, whatever the platform's separator.
        fn relative(&self, path: &Path) -> String {
            path.strip_prefix(&self.0).expect("below the folder").to_string_lossy().replace('\\', "/")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const CAPTURE: &str = "Sample in Buffer,Sample in Window,TRIGGER,u_top/clk_en\n0,0,0,1\n";

    #[test]
    fn clean_file_stem_keeps_what_a_file_name_can_carry() {
        assert_eq!(clean_file_stem(" my capture 01 "), "my_capture_01");
        assert_eq!(clean_file_stem("a/b\\c:d"), "a_b_c_d");
        assert_eq!(clean_file_stem("cap_run-001.v2"), "cap_run-001.v2");
        // one "_" for a letter outside ASCII, however many bytes it takes
        assert_eq!(clean_file_stem("\u{e4}\u{f6}\u{fc}"), "___");
    }

    #[test]
    fn clean_file_stem_takes_dots_and_a_leading_dash_off() {
        assert_eq!(clean_file_stem("--name"), "name");
        assert_eq!(clean_file_stem("..."), "");
        assert_eq!(clean_file_stem(".hidden."), "hidden");
        assert_eq!(clean_file_stem("-"), "");
        assert_eq!(clean_file_stem(".-x"), "x");
        // in whatever order they stand in front: a name begins with neither
        assert_eq!(clean_file_stem("-.x"), "x");
        assert_eq!(clean_file_stem("-.-..x-.y."), "x-.y");
        assert_eq!(clean_file_stem("-."), "");
    }

    #[test]
    fn safe_file_stem_never_comes_out_empty() {
        for name in ["", "   ", "...", "-", "--", "-.", ".-."] {
            assert_eq!(safe_file_stem(name), "capture", "{name:?}");
        }
        assert_eq!(safe_file_stem("cap_run_001"), "cap_run_001");
    }

    #[test]
    fn safe_file_stem_keeps_clear_of_the_device_names_of_windows() {
        assert_eq!(safe_file_stem("CON"), "_CON");
        assert_eq!(safe_file_stem("nul"), "_nul");
        assert_eq!(safe_file_stem(" aux "), "_aux");
        // whatever follows the first dot does not make it a file of its own
        assert_eq!(safe_file_stem("con.x"), "_con.x");
        assert_eq!(safe_file_stem("aux."), "_aux");
        assert_eq!(safe_file_stem("COM1"), "_COM1");
        assert_eq!(safe_file_stem("lpt9"), "_lpt9");
        assert_eq!(safe_file_stem("COM10"), "COM10");
        assert_eq!(safe_file_stem("COMX"), "COMX");
        assert_eq!(safe_file_stem("console"), "console");
        assert_eq!(safe_file_stem("aux_adc"), "aux_adc");
    }

    #[test]
    fn profile_file_name_is_the_cleaned_name_with_json() {
        assert_eq!(profile_file_name("My Board"), "My_Board.json");
        assert_eq!(profile_file_name("my-board adc capture"), "my-board_adc_capture.json");
        // nothing a reader could tell apart is left of these
        assert_eq!(profile_file_name(""), "profile.json");
        assert_eq!(profile_file_name("\u{e4}\u{f6}\u{fc}"), "profile.json");
        assert_eq!(profile_file_name("_-_"), "profile.json");
        assert_eq!(profile_file_name("-."), "profile.json");
        assert_eq!(profile_file_name(&"a".repeat(100)), format!("{}.json", "a".repeat(80)));
    }

    #[test]
    fn profile_file_name_keeps_clear_of_the_device_names_of_windows() {
        assert_eq!(profile_file_name("CON"), "_CON.json");
        assert_eq!(profile_file_name("nul"), "_nul.json");
        // whatever follows the first dot does not make it a file of its own
        assert_eq!(profile_file_name("con.x"), "_con.x.json");
        assert_eq!(profile_file_name("COM1"), "_COM1.json");
        assert_eq!(profile_file_name("lpt9"), "_lpt9.json");
        assert_eq!(profile_file_name("COM10"), "COM10.json");
        assert_eq!(profile_file_name("COMX"), "COMX.json");
        assert_eq!(profile_file_name("console"), "console.json");
    }

    #[test]
    fn natural_key_compares_digits_as_numbers() {
        assert!(natural_key("w9999") < natural_key("w10000"));
        assert_eq!(natural_key("A2"), natural_key("a2"));
        assert_eq!(natural_key("x007"), natural_key("x7"));
        assert!(natural_key("cap_2.csv") < natural_key("cap_10.csv"));
        assert!(natural_key("").is_empty());

        let mut names = vec!["cap_10", "cap_2", "cap_1"];
        names.sort_by_key(|n| natural_key(n));
        assert_eq!(names, ["cap_1", "cap_2", "cap_10"]);
    }

    #[test]
    fn capture_stem_is_folder_and_name_without_the_capture_extension() {
        let folder = PathBuf::from("Caps");
        assert_eq!(capture_stem(&folder.join("W0001.CSV")), ("caps".to_string(), "w0001".to_string()));
        assert_eq!(capture_stem(Path::new("w1.csv.gz")), (String::new(), "w1".to_string()));
        assert_eq!(capture_stem(Path::new("w1.ila")).1, "w1");
        // anything else keeps its name whole
        assert_eq!(capture_stem(Path::new("notes.txt")).1, "notes.txt");
        assert_eq!(capture_stem(Path::new("w1.csv.bak")).1, "w1.csv.bak");
    }

    #[cfg(windows)]
    #[test]
    fn capture_stem_of_a_windows_path() {
        assert_eq!(capture_stem(Path::new("C:\\Caps\\W0001.CSV")), ("c:\\caps".to_string(), "w0001".to_string()));
    }

    #[test]
    fn drop_twins_keeps_the_plain_csv_of_a_capture() {
        let at = |name: &str| PathBuf::from("caps").join(name);
        let mut paths = vec![at("a.csv"), at("a.ila"), at("a.csv.gz"), at("b.ila"), at("A.ILA"), at("c.csv.gz")];
        drop_twins(&mut paths);
        assert_eq!(paths, [at("a.csv"), at("b.ila"), at("c.csv.gz")]);

        // the same name in another folder is another capture
        let mut paths = vec![at("a.csv"), PathBuf::from("other").join("a.ila")];
        drop_twins(&mut paths);
        assert_eq!(paths.len(), 2);

        // without a plain .csv the compressed one is taken, and the .ila only where it is all there is
        let mut paths = vec![at("d.ila"), at("d.csv.gz")];
        drop_twins(&mut paths);
        assert_eq!(paths, [at("d.csv.gz")]);

        // what is kept stays in its order, and a file that is no capture is nobody's twin
        let mut paths = vec![at("f.ila"), at("e.csv.gz"), at("e.txt"), at("E.ila"), at("e"), at("f.txt")];
        drop_twins(&mut paths);
        assert_eq!(paths, [at("f.ila"), at("e.csv.gz"), at("e.txt"), at("e"), at("f.txt")]);
    }

    #[test]
    fn is_capture_file_goes_by_the_first_column_of_a_csv() {
        let dir = Scratch::new("is_capture_file");
        assert!(is_capture_file(&dir.file("w1.csv", CAPTURE)));
        assert!(is_capture_file(&dir.file("W2.CSV", CAPTURE)));
        assert!(is_capture_file(&dir.file("bare.csv", "Sample in Buffer,")));
        // what a session folder holds beside its captures
        assert!(!is_capture_file(&dir.file("index.csv", "file,trigger,samples\nw1.csv,now,1024\n")));
        assert!(!is_capture_file(&dir.file("short.csv", "a,b\n1")));
        assert!(!is_capture_file(&dir.file("empty.csv", "")));
        assert!(!is_capture_file(&dir.file("notes.txt", CAPTURE)));
        assert!(!is_capture_file(&dir.0.join("missing.csv")));
        // a byte order mark in front (a CSV saved again by a spreadsheet) hides the column: not taken
        assert!(!is_capture_file(&dir.file("marked.csv", &format!("\u{feff}{CAPTURE}"))));
    }

    #[test]
    fn is_capture_file_takes_ila_and_gz_by_their_names() {
        let dir = Scratch::new("is_capture_file_names");
        assert!(is_capture_file(&dir.file("w1.ila", "")));
        assert!(is_capture_file(&dir.file("w1.csv.gz", "")));
        assert!(is_capture_file(&dir.file("W2.ILA", "not an archive")));
        // not even looked at: reading them is what tells
        assert!(is_capture_file(&dir.0.join("missing.ila")));
    }

    #[test]
    fn collect_captures_walks_in_natural_order_and_counts_the_other_csvs() {
        let dir = Scratch::new("collect_captures");
        for name in ["cap_10.csv", "cap_2.csv", "cap_1.csv", "session_a/w10.csv", "session_a/w2.csv"] {
            dir.file(name, CAPTURE);
        }
        dir.file("cap_1.ila", ""); // the twin of cap_1.csv
        // what "watch --format both" leaves of a window: no plain .csv, and still one capture
        dir.file("cap_3.ila", "");
        dir.file("cap_3.csv.gz", "");
        dir.file("index.csv", "file,trigger\n");
        dir.file("notes.txt", "");
        dir.file("session_a/run_summary.csv", "window,rows\n");
        dir.file("session_a/deeper/d1.csv", CAPTURE);
        dir.file("session_a/deeper/deepest/x1.csv", CAPTURE);

        let mut found = Vec::new();
        let mut skipped = 0;
        collect_captures(&dir.0, IMPORT_DEPTH, &mut found, &mut skipped);
        let names: Vec<String> = found.iter().map(|p| dir.relative(p)).collect();
        // a folder takes its place among the files by its name; the third level down is not looked into
        assert_eq!(
            names,
            [
                "cap_1.csv", "cap_2.csv", "cap_3.csv.gz", "cap_10.csv", "session_a/deeper/d1.csv", "session_a/w2.csv",
                "session_a/w10.csv",
            ]
        );
        assert_eq!(skipped, 2);

        let mut found = Vec::new();
        let mut skipped = 0;
        collect_captures(&dir.0, 0, &mut found, &mut skipped);
        let names: Vec<String> = found.iter().map(|p| dir.relative(p)).collect();
        assert_eq!(names, ["cap_1.csv", "cap_2.csv", "cap_3.csv.gz", "cap_10.csv"]);
        assert_eq!(skipped, 1);

        // a folder that is not there holds nothing
        let mut found = Vec::new();
        collect_captures(&dir.0.join("missing"), IMPORT_DEPTH, &mut found, &mut skipped);
        assert!(found.is_empty());
    }

    #[test]
    fn collect_captures_stops_one_beyond_what_an_import_takes() {
        let dir = Scratch::new("collect_captures_limit");
        for i in 0..MAX_IMPORT + 5 {
            dir.file(&format!("w{i}.ila"), "");
        }
        let mut found = Vec::new();
        let mut skipped = 0;
        collect_captures(&dir.0, 0, &mut found, &mut skipped);
        assert_eq!(found.len(), MAX_IMPORT + 1);
        assert_eq!(dir.relative(&found[0]), "w0.ila");
        assert_eq!(dir.relative(&found[MAX_IMPORT]), format!("w{MAX_IMPORT}.ila"));
    }

    #[test]
    fn listed_profile_file_takes_only_a_json_file_of_the_folder() {
        let dir = Scratch::new("listed_profile_file");
        dir.file("My_Board.json", "{}");
        dir.file("notes.txt", "");
        dir.file("folder.json/inside.txt", "");
        let listed = |name: &str| listed_profile_file(&dir.0, name);
        // in whatever case it was asked for, the answer is the name as the folder writes it
        assert_eq!(listed("my_board.JSON"), Some("My_Board.json".to_string()));
        assert_eq!(listed("My_Board"), None);
        assert_eq!(listed("..\\My_Board.json"), None);
        assert_eq!(listed("./My_Board.json"), None);
        assert_eq!(listed("My_Board.json:stream"), None);
        assert_eq!(listed("notes.txt"), None);
        assert_eq!(listed("folder.json"), None);
        assert_eq!(listed_profile_file(&dir.0.join("missing"), "My_Board.json"), None);
    }

    #[test]
    fn holds_profile_goes_by_the_name_in_the_file() {
        let dir = Scratch::new("holds_profile");
        let file = dir.file("a.json", r#"{"name": " My Board ", "hardware": {}}"#);
        assert!(holds_profile(&file, "my board"));
        assert!(holds_profile(&file, "MY BOARD"));
        assert!(!holds_profile(&file, "my-board"));
        assert!(!holds_profile(&dir.file("b.json", "not json"), "my board"));
        assert!(!holds_profile(&dir.file("c.json", r#"{"name": 7}"#), "7"));
        assert!(!holds_profile(&dir.file("d.json", r#"{"hardware": {}}"#), ""));
        assert!(!holds_profile(&dir.0.join("missing.json"), "my board"));
    }

    #[test]
    fn new_profile_file_gets_a_number_where_another_profile_has_the_name() {
        let dir = Scratch::new("new_profile_file");
        assert_eq!(new_profile_file(&dir.0, "a b"), "a_b.json");
        dir.file("a_b.json", r#"{"name": "a/b"}"#);
        // the profile that is in the file is saved into it again; another one of the same file name is not
        assert_eq!(new_profile_file(&dir.0, "a/b"), "a_b.json");
        assert_eq!(new_profile_file(&dir.0, "a b"), "a_b-2.json");
        dir.file("a_b-2.json", r#"{"name": "a?b"}"#);
        assert_eq!(new_profile_file(&dir.0, "a b"), "a_b-3.json");
        dir.file("a_b-3.json", r#"{"name": "A B"}"#);
        assert_eq!(new_profile_file(&dir.0, "a b"), "a_b-3.json");
    }

    #[test]
    fn new_profile_file_of_a_name_that_ends_in_json() {
        let dir = Scratch::new("new_profile_file_json");
        assert_eq!(new_profile_file(&dir.0, "x.json"), "x.json.json");
        dir.file("x.json.json", r#"{"name": "another"}"#);
        // the number goes behind the name as it was typed: only the ".json" of the file is taken off for it
        assert_eq!(new_profile_file(&dir.0, "x.json"), "x.json-2.json");
    }

    #[test]
    fn undated_takes_the_day_of_the_save_out_and_nothing_else() {
        let saved = |date: &str| {
            json!({
                "name": "my-board",
                "_comment": format!("Saved on {date} from the page"),
                "gui": { "saved": date, "mode": "rule" },
            })
        };
        assert_eq!(undated(saved("2025-01-01")), undated(saved("2025-06-30")));
        assert_eq!(
            undated(saved("2025-01-01")),
            json!({ "name": "my-board", "_comment": "Saved on  from the page", "gui": { "mode": "rule" } })
        );
        // the date is taken out of the note once: a second mention is the user's own text
        let twice = json!({ "_comment": "2025-01-01, as on 2025-01-01", "gui": { "saved": "2025-01-01" } });
        assert_eq!(undated(twice), json!({ "_comment": ", as on 2025-01-01", "gui": {} }));
        // a profile written by hand has no date of a save
        let by_hand = json!({ "name": "my-board", "_comment": "2025-01-01", "hardware": { "url": "localhost:3121" } });
        assert_eq!(undated(by_hand.clone()), by_hand);
    }

    #[test]
    fn reject_error_turns_an_error_answer_into_a_failure() {
        assert_eq!(reject_error(json!({ "error": "no such file" })), Err("no such file".to_string()));
        let data = json!({ "signals": [], "totalSamples": 0 });
        assert_eq!(reject_error(data.clone()), Ok(data));
        // only a text is a message
        let odd = json!({ "error": 5 });
        assert_eq!(reject_error(odd.clone()), Ok(odd));
    }

    /// A job as the slot holds it. No process stands behind it (pid 0), so the last resort of a stop has
    /// nothing to kill.
    fn job_in_flight(scratch: &Scratch) -> HwJob {
        HwJob { id: 7, pid: 0, stop_file: scratch.0.join("stop.flag"), kind: "capture" }
    }

    // The page reads these two fields by name (StopAnswer in src/types.ts): the names and what they mean are
    // the contract between the two languages.
    #[test]
    fn stop_with_no_job_in_flight_answers_that_nothing_ran() {
        let slot: Mutex<Option<HwJob>> = Mutex::new(None);
        let answer = stop_running_job(&slot, Duration::from_secs(5));
        assert_eq!(answer, StopAnswer { running: false, killed: false });
        assert_eq!(serde_json::to_value(answer).expect("an answer of two fields"), json!({ "running": false, "killed": false }));
    }

    #[test]
    fn stop_asks_the_job_in_flight_with_its_stop_file_and_waits_for_it() {
        let scratch = Scratch::new("stop_in_order");
        let job = job_in_flight(&scratch);
        let slot = Arc::new(Mutex::new(Some(job.clone())));
        // the job: it ends when it finds the stop file, as the bridge does
        let (running, stop_file) = (slot.clone(), job.stop_file.clone());
        let ended = std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(20);
            while Instant::now() < until && !stop_file.exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
            let asked = fs::read(&stop_file).ok();
            *lock(&running) = None;
            asked
        });
        let answer = stop_running_job(&slot, Duration::from_secs(20));
        assert_eq!(ended.join().expect("the job"), Some(b"stop".to_vec()));
        assert_eq!(serde_json::to_value(answer).expect("an answer of two fields"), json!({ "running": true, "killed": false }));
    }

    #[test]
    fn stop_reports_a_job_that_did_not_end_within_the_grace() {
        let scratch = Scratch::new("stop_last_resort");
        let slot = Mutex::new(Some(job_in_flight(&scratch)));
        let answer = stop_running_job(&slot, Duration::ZERO);
        assert_eq!(serde_json::to_value(answer).expect("an answer of two fields"), json!({ "running": true, "killed": true }));
        // the slot is the job's own to clear, when it ends
        assert!(lock(&slot).is_some());
    }

    fn no_hw_args() -> HwArgs {
        HwArgs {
            profile: None,
            ltx: None,
            tcl: None,
            server: None,
            device: None,
            ila_index: None,
            ila_cell: None,
            jtag_hz: None,
            omit_jtag_freq: None,
            engines: None,
        }
    }

    fn pushed(hw: HwArgs) -> Vec<String> {
        let mut args = vec!["capture".to_string()];
        push_hw_args(&mut args, hw);
        args
    }

    #[test]
    fn push_hw_args_always_sends_the_jtag_frequency_and_the_engines() {
        assert_eq!(pushed(no_hw_args()), ["capture", "--jtag-hz", "0", "--engines", "1"]);
    }

    #[test]
    fn push_hw_args_drops_what_is_empty_and_keeps_the_order() {
        let args = pushed(HwArgs {
            profile: Some(" profiles/example-board.json ".to_string()),
            ltx: Some("top.ltx".to_string()),
            tcl: Some(String::new()),
            server: Some("localhost:3121".to_string()),
            device: Some("   ".to_string()),
            ila_index: Some(2),
            ila_cell: Some("u_ila_demo".to_string()),
            jtag_hz: Some(6_000_000),
            omit_jtag_freq: Some(false),
            engines: Some(2),
        });
        assert_eq!(
            args,
            [
                "capture", "--profile", "profiles/example-board.json", "--ltx", "top.ltx", "--server", "localhost:3121",
                "--ila-index", "2", "--ila-cell", "u_ila_demo", "--jtag-hz", "6000000", "--engines", "2",
            ]
        );
    }

    #[test]
    fn push_hw_args_jtag_frequency_left_to_the_cable() {
        let args = pushed(HwArgs { jtag_hz: Some(6_000_000), omit_jtag_freq: Some(true), ..no_hw_args() });
        assert_eq!(args, ["capture", "--jtag-hz", "0", "--engines", "1"]);
        let args = pushed(HwArgs { jtag_hz: Some(6_000_000), ..no_hw_args() });
        assert_eq!(args, ["capture", "--jtag-hz", "6000000", "--engines", "1"]);
    }

    #[test]
    fn push_hw_args_keeps_the_engines_between_one_and_three() {
        for (asked, sent) in [(0, "1"), (1, "1"), (3, "3"), (9, "3")] {
            let args = pushed(HwArgs { engines: Some(asked), ..no_hw_args() });
            assert_eq!(args.last().map(String::as_str), Some(sent), "{asked} engines");
        }
    }

    /// Full paths of folders that need not be there: an executable five folders deep, and a working directory.
    fn exe_and_cwd() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join("ila_studio_roots");
        (base.join("a").join("b").join("c").join("d").join("bin"), base.join("work").join("here"))
    }

    #[test]
    fn root_candidates_of_a_release_build_are_its_own_folder_and_nothing_else() {
        let (exe, cwd) = exe_and_cwd();
        // not the folders above it, and not the folder it was started from
        assert_eq!(root_candidates(Some(&exe), None, &cwd, false), [exe.as_path()]);
        // without a folder of its own there is nowhere to look
        assert!(root_candidates(None, None, &cwd, false).is_empty());
    }

    #[test]
    fn root_candidates_take_the_folder_ila_home_names_after_the_own_one() {
        let (exe, cwd) = exe_and_cwd();
        let scripts = std::env::temp_dir().join("ila_studio_roots").join("scripts");
        assert_eq!(root_candidates(Some(&exe), Some(&scripts), &cwd, false), [exe.as_path(), scripts.as_path()]);
        assert_eq!(root_candidates(None, Some(&scripts), &cwd, false), [scripts.as_path()]);
        // only a full path: anything else would be read from the working directory
        for relative in ["scripts", ".", "..", ""] {
            assert_eq!(root_candidates(Some(&exe), Some(Path::new(relative)), &cwd, false), [exe.as_path()], "{relative:?}");
        }
        // a development build takes it at the same place, before it walks
        let development = root_candidates(Some(&exe), Some(&scripts), &cwd, true);
        assert_eq!(development[..3], [exe.clone(), scripts, exe.parent().expect("five deep").to_path_buf()]);
    }

    #[test]
    fn root_candidates_of_a_development_build_walk_up_as_before() {
        let (exe, cwd) = exe_and_cwd();
        // target\debug is two folders below src-tauri and three below the repository
        let mut walk: Vec<PathBuf> = exe.ancestors().take(5).map(Path::to_path_buf).collect();
        walk.extend(cwd.ancestors().take(2).map(Path::to_path_buf));
        assert_eq!(walk.len(), 7);
        assert_eq!(root_candidates(Some(&exe), None, &cwd, true), walk);
        assert_eq!(root_candidates(None, None, &cwd, true), walk[5..]);
    }

    /// An answer as PYTHON_PROBE prints it.
    fn answer(exe: &str, platform: &str, sys_platform: &str) -> String {
        format!("{exe}\r\n{platform}\r\n{sys_platform}\r\n3.12.4\r\n2025-06-30 12:00:00.123\r\n")
    }

    fn python(exe: &str, platform: &str, sys_platform: &str, named: bool) -> Python {
        Python::from_answer(&answer(exe, platform, sys_platform), named).expect("a whole answer")
    }

    #[test]
    fn python_from_answer_takes_one_line_for_each_thing_asked() {
        let found = python("C:\\Python312\\python.exe", "win-amd64", "win32", false);
        assert_eq!(
            found,
            Python {
                exe: PathBuf::from("C:\\Python312\\python.exe"),
                platform: "win-amd64".to_string(),
                sys_platform: "win32".to_string(),
                version: "3.12.4".to_string(),
                asked: "2025-06-30 12:00:00.123".to_string(),
                named: false,
            }
        );
        assert!(python("python.exe", "win-amd64", "win32", true).named);
        // what a launcher stub without a Python behind it prints, or an answer that was cut off, is none
        assert_eq!(Python::from_answer("", false), None);
        assert_eq!(Python::from_answer("\r\nwin-amd64\r\nwin32\r\n3.12.4\r\n2025-06-30 12:00:00.123\r\n", false), None);
        assert_eq!(Python::from_answer("C:\\Python312\\python.exe\nwin-amd64\nwin32\n3.12.4\n", false), None);
    }

    #[test]
    fn python_other_build_goes_by_what_the_interpreter_says_of_itself() {
        assert!(!python("C:\\Python312\\python.exe", "win-amd64", "win32", false).other_build());
        assert!(!python("C:\\Python312-arm\\python.exe", "win-arm64", "win32", false).other_build());
        assert!(!python("/usr/bin/python3", "linux-x86_64", "linux", false).other_build());
        assert!(python("C:\\msys64\\ucrt64\\bin\\python.exe", "mingw_x86_64_ucrt_gnu", "win32", false).other_build());
        assert!(python("C:\\msys64\\mingw64\\bin\\python.exe", "mingw_x86_64", "win32", false).other_build());
        assert!(python("C:\\msys64\\usr\\bin\\python.exe", "cygwin-3.5.4-x86_64", "cygwin", false).other_build());
        assert!(python("C:\\msys64\\usr\\bin\\python.exe", "msys-3.5.4-x86_64", "msys", false).other_build());
        // not by the folder: a standard Python may be installed anywhere, and a MinGW one copied anywhere
        assert!(!python("C:\\msys64\\ucrt64\\bin\\python.exe", "win-amd64", "win32", false).other_build());
        assert!(python("C:\\Python312\\python.exe", "mingw_x86_64_ucrt_gnu", "win32", false).other_build());
    }

    #[test]
    fn pick_python_puts_a_mingw_build_behind_a_standard_one() {
        let mingw = python("C:\\msys64\\ucrt64\\bin\\python.exe", "mingw_x86_64_ucrt_gnu", "win32", false);
        let cygwin = python("C:\\cygwin64\\bin\\python3.exe", "cygwin-3.5.4-x86_64", "cygwin", false);
        let standard = python("C:\\Python312\\python.exe", "win-amd64", "win32", false);
        let store = python("C:\\Store\\python3.12.exe", "win-amd64", "win32", false);

        // PATH has the MinGW one first: the standard one behind it is taken, and nothing behind that is asked
        let mut answers = vec![mingw.clone(), cygwin.clone(), standard.clone(), store.clone()].into_iter();
        assert_eq!(pick_python(answers.by_ref()), Some(standard.clone()));
        assert_eq!(answers.next(), Some(store.clone()));

        // a standard one that comes first is taken at once, as it always was
        let mut answers = vec![standard.clone(), mingw.clone()].into_iter();
        assert_eq!(pick_python(answers.by_ref()), Some(standard.clone()));
        assert_eq!(answers.next(), Some(mingw.clone()));

        // not refused: where there is no other, the first of them is the Python
        assert_eq!(pick_python(vec![mingw.clone(), cygwin.clone()].into_iter()), Some(mingw.clone()));
        assert_eq!(pick_python(std::iter::empty()), None);
    }

    #[test]
    fn pick_python_takes_what_ila_python_names_whatever_it_is() {
        let named = python("D:\\tools\\ucrt64\\bin\\python.exe", "mingw_x86_64_ucrt_gnu", "win32", true);
        let standard = python("C:\\Python312\\python.exe", "win-amd64", "win32", false);
        let mut answers = vec![named.clone(), standard.clone()].into_iter();
        assert_eq!(pick_python(answers.by_ref()), Some(named));
        assert_eq!(answers.next(), Some(standard));
    }

    #[test]
    fn python_note_names_the_interpreter_and_why_an_unusual_one_is_used() {
        let exe = "C:\\Python312\\python.exe";
        assert_eq!(python(exe, "win-amd64", "win32", false).note(), format!("Python 3.12.4 (win-amd64): {exe}"));
        assert_eq!(
            python(exe, "win-amd64", "win32", true).note(),
            format!("Python 3.12.4 (win-amd64): {exe}, named by ILA_PYTHON")
        );
        let mingw = "C:\\msys64\\ucrt64\\bin\\python.exe";
        assert_eq!(
            python(mingw, "mingw_x86_64_ucrt_gnu", "win32", false).note(),
            format!(
                "Python 3.12.4 (mingw_x86_64_ucrt_gnu): {mingw} - not a standard Python for Windows (a MinGW or \
                 Cygwin build); it is used because no other was found"
            )
        );
        assert_eq!(
            python(mingw, "mingw_x86_64_ucrt_gnu", "win32", true).note(),
            format!("Python 3.12.4 (mingw_x86_64_ucrt_gnu): {mingw}, named by ILA_PYTHON")
        );
    }

    #[test]
    fn append_log_adds_a_line_in_the_form_of_the_bridge() {
        let dir = Scratch::new("append_log");
        let log = dir.file("ila_log.txt", "[2025-06-30 11:59:00.000] ---- serve: ended\n");
        append_log(&log, "2025-06-30 12:00:00.123", "Python 3.12.4 (win-amd64): C:\\Python312\\python.exe");
        assert_eq!(
            fs::read_to_string(&log).expect("the log"),
            "[2025-06-30 11:59:00.000] ---- serve: ended\n\
             [2025-06-30 12:00:00.123] Python 3.12.4 (win-amd64): C:\\Python312\\python.exe\n"
        );
        // a log that is not there yet is begun; one that cannot be written is no failure
        let fresh = dir.0.join("fresh.txt");
        append_log(&fresh, "2025-06-30 12:00:01.000", "one line");
        assert_eq!(fs::read_to_string(&fresh).expect("the log"), "[2025-06-30 12:00:01.000] one line\n");
        append_log(&dir.0.join("missing").join("ila_log.txt"), "2025-06-30 12:00:02.000", "nowhere");
        assert!(!dir.0.join("missing").exists());
    }

    #[test]
    fn limit_text_is_in_minutes_where_they_are_whole() {
        assert_eq!(limit_text(Duration::from_secs(30)), "30 s");
        assert_eq!(limit_text(Duration::from_secs(90)), "90 s");
        assert_eq!(limit_text(Duration::from_secs(120)), "2 min");
        assert_eq!(limit_text(LIST_PROFILES_LIMIT), "5 min");
    }

    #[test]
    fn capture_read_limit_grows_with_the_file() {
        const MB: u64 = 1024 * 1024;
        // a file that is not there has no size: what then takes long is not the reading
        assert_eq!(capture_read_limit(0), Duration::from_secs(5 * 60));
        assert_eq!(capture_read_limit(9 * MB), Duration::from_secs(5 * 60));
        assert_eq!(capture_read_limit(10 * MB), Duration::from_secs(6 * 60));
        assert_eq!(capture_read_limit(40 * MB), Duration::from_secs(9 * 60));
        assert_eq!(capture_read_limit(1024 * MB), Duration::from_secs(107 * 60));
        // always whole minutes, as the message names them
        assert_eq!(limit_text(capture_read_limit(25 * MB + 7)), "7 min");
        // no size overflows it
        assert!(capture_read_limit(u64::MAX) > capture_read_limit(1024 * MB));
    }

    /// A command of the system: `line` as cmd.exe runs it on Windows, `script` as sh does elsewhere.
    fn shell(line: &str, script: &str) -> Command {
        let mut cmd = if cfg!(windows) { Command::new("cmd") } else { Command::new("sh") };
        if cfg!(windows) {
            cmd.args(["/d", "/c", line]);
        } else {
            cmd.args(["-c", script]);
        }
        cmd.stdin(Stdio::null());
        cmd
    }

    #[test]
    fn output_within_takes_what_a_command_printed_and_how_it_ended() {
        let out = output_within(&mut shell("echo one& echo two 1>&2& exit 3", "echo one; echo two 1>&2; exit 3"), Duration::from_secs(60))
            .expect("started")
            .expect("ended in time");
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "one");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "two");
    }

    #[test]
    fn output_within_reads_more_than_a_pipe_holds_from_both_pipes() {
        let dir = Scratch::new("output_within_large");
        // far beyond the buffer of a pipe: a child whose pipes nobody reads would stop here and never end
        let row = "0123456789abcdef".repeat(4) + "\n";
        let big = dir.file("big.txt", &row.repeat(8192));
        let size = fs::metadata(&big).expect("written").len() as usize;
        assert!(size > 500_000);
        // The error pipe first: a reader that took one pipe after the other would wait at the wrong one. The file
        // is named from its folder: a path would have to be quoted, and cmd.exe has its own idea of quotes.
        let mut cmd = shell("type big.txt 1>&2& type big.txt", "cat big.txt 1>&2; cat big.txt");
        cmd.current_dir(&dir.0);
        let out = output_within(&mut cmd, Duration::from_secs(60)).expect("started").expect("ended in time");
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), size);
        assert_eq!(out.stderr.len(), size);
    }

    #[test]
    fn output_within_ends_a_command_that_takes_longer_than_its_limit() {
        let dir = Scratch::new("output_within_limit");
        // Three seconds of doing nothing, then a file - written by a shell that the command started, on Windows,
        // where ending the command alone would leave that one running.
        let mut slow = shell(
            "cmd /d /c ping -n 4 127.0.0.1 ^>nul ^& echo late^>late.txt",
            "sleep 3; echo late > late.txt",
        );
        slow.current_dir(&dir.0);
        let started = Instant::now();
        let out = output_within(&mut slow, Duration::from_millis(300)).expect("started");
        assert!(out.is_none(), "it was not waited for");
        assert!(started.elapsed() >= Duration::from_millis(300));
        // it was ended, not just left alone: the file never comes
        std::thread::sleep(Duration::from_millis(3500));
        assert!(!dir.0.join("late.txt").exists());
    }

    #[test]
    fn output_within_lets_a_command_that_is_in_time_finish() {
        let dir = Scratch::new("output_within_in_time");
        // the same command with a limit it keeps: the file is there, so the test above ends what would write it
        let mut slow = shell(
            "cmd /d /c ping -n 2 127.0.0.1 ^>nul ^& echo late^>late.txt",
            "sleep 1; echo late > late.txt",
        );
        slow.current_dir(&dir.0);
        let out = output_within(&mut slow, Duration::from_secs(60)).expect("started").expect("ended in time");
        assert!(out.status.success());
        assert!(dir.0.join("late.txt").exists());
    }

    #[test]
    fn output_within_says_when_a_command_cannot_be_started() {
        let mut missing = Command::new("ila_studio_no_such_program");
        assert!(output_within(&mut missing, Duration::from_secs(5)).is_err());
    }
}
