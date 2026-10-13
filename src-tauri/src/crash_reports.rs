// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

// Crash reports: an error of the program, sent to a Sentry project - but only once the user has switched that
// on. This tool runs in labs where a program must not send anything to a third party, and an error text holds
// what such a lab keeps to itself: paths with user names, the address of the hw_server, names from a design.
// So the rules are:
//  - Without a report address (ILA_SENTRY_DSN, see report_address) nothing here is set up at all.
//  - Consent is off when the program starts. Every event - a panic of this backend, an error the page hands
//    over - goes through `before_send`, which drops it while consent is off and scrubs it otherwise. A report
//    that waits to be sent is asked about once more at the last step before the network (see SenderGate).
//  - The consent is one for the address the reports go to: the page stores it together with that address, and
//    does not hand it over at a start that has another one (see destination).
//  - Only this backend sends. The page has no Sentry code and no network access of its own (the CSP).
//  - Nothing but error events leaves: see EventsOnly.

use sentry::integrations::backtrace::ProcessStacktraceIntegration;
use sentry::integrations::contexts::ContextIntegration;
use sentry::integrations::panic::PanicIntegration;
use sentry::protocol::{Context, EnvelopeItem, Event, Exception, Frame, Level, Map, Mechanism, Stacktrace};
use sentry::types::{Dsn, Scheme, Uuid};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use ureq::middleware::{Middleware, MiddlewareNext};
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

use super::{blocking, lock};

/// The longest text a report carries in one place: a message of this length says all there is to say.
const MAX_TEXT: usize = 2000;
/// The most frames taken from a stack of the page (V8 itself stops at ten unless told otherwise).
const MAX_FRAMES: usize = 50;
/// The most errors of the page one run reports: an error that comes back with every frame must not flood.
const MAX_REPORTS: usize = 20;
/// The most of them a run sends by hand ("Send this error report"): one for the error screen of each window.
const MAX_BY_HAND: usize = 2;
/// How long one report may take to go out before the sender gives it up.
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
const TEST_MESSAGE: &str = "ILA Studio test report";
const NO_ADDRESS: &str = "This build has no address to send reports to.";

// ---------------------------------------------------------------- Report address

/// Where reports go. ILA_SENTRY_DSN of the running program comes first: with it a company points the reports at
/// a Sentry of its own (and a test at a local stand-in). Without it, the address the build was given - a
/// release is built with ILA_SENTRY_DSN set, a build from source has none. No address is written in the sources,
/// and SENTRY_DSN, which the SDK would read by itself, is not looked at: the options below always carry one.
/// The second value says whether the address is that of the running program's own variable.
fn report_address() -> Option<(Dsn, bool)> {
    let run_time = std::env::var("ILA_SENTRY_DSN").ok();
    let dsn = choose_address(run_time.as_deref(), option_env!("ILA_SENTRY_DSN"))?;
    Some((dsn, run_time.is_some()))
}

/// A variable that is set at run time decides alone. If it cannot be read as an address there is none: falling
/// back would send the reports of somebody who named a server of their own to the one of the build.
fn choose_address(run_time: Option<&str>, build_time: Option<&str>) -> Option<Dsn> {
    run_time.or(build_time)?.trim().parse().ok()
}

/// The address the reports go to, without its key: `scheme://host:port/project`. The page stores the consent of
/// the user together with it (src/crashReports.ts): a box ticked for one server says nothing about another -
/// the one a later start is given with ILA_SENTRY_DSN, or that of the build when the variable is gone.
fn destination(dsn: &Dsn) -> String {
    format!("{}://{}:{}{}{}", dsn.scheme(), dsn.host(), dsn.port(), dsn.path(), dsn.project_id())
}

/// Reports to this address cross a network in clear text: it begins with http:// and is not on this PC. Such an
/// address is taken - a company may run its Sentry so inside its network - and the page says what it means.
fn unencrypted(dsn: &Dsn) -> bool {
    // an IPv6 address stands in brackets
    let host = dsn.host().trim_start_matches('[').trim_end_matches(']');
    let on_this_pc = host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    dsn.scheme() == Scheme::Http && !on_this_pc
}

// ---------------------------------------------------------------- Scrubbing

fn is_separator(byte: u8) -> bool {
    byte == b'\\' || byte == b'/'
}

/// A byte no file or folder name holds: where a name in a path ends, whatever follows it.
fn ends_name(byte: u8) -> bool {
    is_separator(byte) || byte < 0x20 || matches!(byte, b'"' | b'<' | b'>' | b'|' | b':' | b'*' | b'?')
}

/// How many bytes from `start` on are of the kind `wanted`.
fn run(bytes: &[u8], start: usize, wanted: impl Fn(u8) -> bool) -> usize {
    bytes.get(start..).map_or(0, |rest| rest.iter().take_while(|b| wanted(**b)).count())
}

/// `text` with the pieces `find` points out replaced by `mark`. `find` is asked at every byte that is not inside
/// a piece already taken, and answers with the range to replace. All it may cut at are ASCII bytes, so a letter
/// of several bytes is never split.
fn replace_found(text: &str, mark: &str, find: impl Fn(&[u8], usize) -> Option<(usize, usize)>) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        match find(bytes, at) {
            Some((start, end)) if end > start => {
                out.push_str(&text[copied..start]);
                out.push_str(mark);
                copied = end;
                at = end;
            }
            _ => at += 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// The marks the scrubber leaves where it took something out.
const MARKS: [&str; 3] = ["<user>", "<host>", "<ip>"];

/// A folder that holds user folders: `Users`, `home`, and the hidden shares home folders are redirected to
/// (`home$`, `users$`), in any letter case.
fn holds_user_folders(name: &[u8]) -> bool {
    let name = name.strip_suffix(b"$").unwrap_or(name);
    name.eq_ignore_ascii_case(b"users") || name.eq_ignore_ascii_case(b"home")
}

/// The name of a user folder taken out: `C:\Users\<name>\...`, `/Users/<name>/...`, `/home/<name>/...`,
/// `\\server\home$\<name>\...`, with either separator (also doubled, as in a path written into JSON) and in any
/// letter case. The name ends at the next separator - a name may hold spaces, so where none follows, the rest
/// of the line up to a character no name holds goes with it. Better some words too many than half a name left.
fn without_user_folders(text: &str) -> String {
    replace_found(text, "<user>", |bytes, at| {
        if !is_separator(bytes[at]) || (at > 0 && is_separator(bytes[at - 1])) {
            return None;
        }
        let folder = at + run(bytes, at, is_separator);
        let end = folder + run(bytes, folder, |b| !ends_name(b));
        let name = end + run(bytes, end, is_separator);
        if name == end || !holds_user_folders(&bytes[folder..end]) {
            return None;
        }
        let mut name_end = name + run(bytes, name, |b| !ends_name(b));
        // "/home/users/<name>": which of the two is the name cannot be told, so both go
        if holds_user_folders(&bytes[name..name_end]) {
            let next = name_end + run(bytes, name_end, is_separator);
            let more = run(bytes, next, |b| !ends_name(b));
            if more > 0 {
                name_end = next + more;
            }
        }
        Some((name, name_end))
    })
}

/// Where a network path can begin: not inside a word or a path (`a//b`, `C:\\dir` as JSON writes it), not in a
/// URL (`http://host/`), and not right behind something that was taken out (`C:\\Users\\<user>\\AppData`: the
/// path goes on there) - but after `file:`, and after a word and a colon in front of backslashes
/// (`Error:\\server\x`).
fn begins_path(bytes: &[u8], at: usize, slashes: usize) -> bool {
    let Some(before) = at.checked_sub(1).map(|i| bytes[i]) else {
        return true;
    };
    if before == b':' {
        let word = bytes[..at - 1].iter().rev().take_while(|b| b.is_ascii_alphanumeric()).count();
        // file://server/share (and file:////server/share) is a network path, file:///C:/dir is none
        if bytes[at - 1 - word..at - 1].eq_ignore_ascii_case(b"file") {
            return slashes != 3;
        }
        // one letter is a drive, and forward slashes after a word are a URL
        return word != 1 && bytes[at] == b'\\';
    }
    // (`\\?\` and the path behind it are one path)
    let prefix = before == b'?' && at > 1 && is_separator(bytes[at - 2]);
    let goes_on = prefix || before.is_ascii_alphanumeric() || matches!(before, b'.' | b'_' | b'-');
    !goes_on && !MARKS.iter().any(|mark| bytes[..at].ends_with(mark.as_bytes()))
}

/// Past `?\UNC\` and `.\UNC\`, the long form of a network path (separators may be doubled); `at` if there is
/// none.
fn after_unc_prefix(bytes: &[u8], at: usize) -> usize {
    if !matches!(bytes.get(at), Some(b'?' | b'.')) {
        return at;
    }
    let unc = at + 1 + run(bytes, at + 1, is_separator);
    if unc == at + 1 || !bytes.get(unc..unc + 3).is_some_and(|word| word.eq_ignore_ascii_case(b"UNC")) {
        return at;
    }
    let host = unc + 3 + run(bytes, unc + 3, is_separator);
    if host == unc + 3 {
        at
    } else {
        host
    }
}

/// The server of a network path taken out: `\\server\share\...`, `//server/share/...` (the form ila_capture.py
/// gives every path for Tcl), `\\?\UNC\server\share\...`, `file://server/share/...`. Only where a path begins
/// (see begins_path), and not the `\\?\` and `\\.\` Windows puts in front of a local path. The host of any
/// other URL (`http://host/...`) is a host called by its name, and stays.
fn without_unc_hosts(text: &str) -> String {
    replace_found(text, "<host>", |bytes, at| {
        // the cheap look first: only the first of a row of separators is asked about the row
        if !is_separator(bytes[at]) || (at > 0 && is_separator(bytes[at - 1])) {
            return None;
        }
        let slashes = run(bytes, at, is_separator);
        if slashes < 2 || !begins_path(bytes, at, slashes) {
            return None;
        }
        let host = after_unc_prefix(bytes, at + slashes);
        let end = host + run(bytes, host, |b| !ends_name(b) && b != b' ');
        let named = end > host && !matches!(&bytes[host..end], b"?" | b".");
        (named && bytes.get(end).copied().is_some_and(is_separator)).then_some((host, end))
    })
}

/// The length of the IPv4 address `bytes` begin with: four numbers up to 255 with dots between them. A fifth
/// number makes it a version (1.2.3.4.5) - unless that is a port, which some tools write behind a dot
/// (192.0.2.44.3121): a number above 255 with no sixth behind it.
fn ipv4_len(bytes: &[u8]) -> Option<usize> {
    let mut at = 0;
    for part in 0..4 {
        if part > 0 {
            if bytes.get(at) != Some(&b'.') {
                return None;
            }
            at += 1;
        }
        let digits = run(bytes, at, |b| b.is_ascii_digit());
        // the length first: a row of twenty digits is no part of an address, and too large to be added up
        if digits == 0 || digits > 3 {
            return None;
        }
        let number = bytes[at..at + digits].iter().fold(0u32, |n, d| n * 10 + u32::from(d - b'0'));
        if number > 255 {
            return None;
        }
        at += digits;
    }
    let fifth = if bytes.get(at) == Some(&b'.') { run(bytes, at + 1, |b| b.is_ascii_digit()) } else { 0 };
    if fifth == 0 {
        return Some(at);
    }
    let after = at + 1 + fifth;
    let sixth = bytes.get(after) == Some(&b'.') && bytes.get(after + 1).is_some_and(u8::is_ascii_digit);
    // (the length first, as above)
    let port = fifth > 3 || bytes[at + 1..after].iter().fold(0u32, |n, d| n * 10 + u32::from(d - b'0')) > 255;
    (port && !sixth).then_some(at)
}

/// IPv4 addresses taken out; a port stays. An address is left alone only as a part of a longer row of numbers,
/// and behind a `v` that begins a word: `2017.4`, `0.4.0`, `10.0.19045.4651`, `1.2.3.4.5` and `v1.2.3.4` are
/// versions. Any other letter in front, or a `_`, does not make an address a word: `hw_server_192.0.2.44`.
/// (A version of four numbers written without its `v` goes as an address would. When in doubt: out.)
fn without_ipv4(text: &str) -> String {
    replace_found(text, "<ip>", |bytes, at| {
        let inside = match at.checked_sub(1).map(|i| bytes[i]) {
            Some(b'.') => at > 1 && bytes[at - 2].is_ascii_digit(),
            // "v1.2.3.4" and "-V1.2.3.4", but not "srv192.0.2.44"
            Some(b'v' | b'V') => at < 2 || !bytes[at - 2].is_ascii_alphanumeric(),
            Some(before) => before.is_ascii_digit(),
            None => false,
        };
        if inside || !bytes[at].is_ascii_digit() {
            return None;
        }
        ipv4_len(&bytes[at..]).map(|len| (at, at + len))
    })
}

/// What a report may carry of a text: no name of a user folder, no server of a network path, no IPv4 address,
/// and no more than MAX_TEXT characters. A name inside the text that is none of these - a probe, a file, a host
/// called by its name - is NOT recognised and stays: that is why crash reports are off until switched on. Nor
/// is a path in another notation (URL-encoded: `C%3A%5CUsers%5C...`), a user folder that lies elsewhere
/// (`D:\Profiles\<name>`), or an IPv6 address.
fn scrub_text(text: &str) -> String {
    // The user folder first: of "\\Users\\name" (a path without a drive, as JSON writes it) the server pass
    // would take "Users" for a server, and the name would no longer be found. The cut last: a path or an
    // address that the cut halves is no longer recognised.
    let clean = without_ipv4(&without_unc_hosts(&without_user_folders(text)));
    match clean.char_indices().nth(MAX_TEXT) {
        Some((end, _)) => format!("{}...", &clean[..end]),
        None => clean,
    }
}

/// Every text in the event, wherever it is: a message, the path of a stack frame, a value three levels down -
/// and the names of the fields as well: those of a map (tags, extra) are texts like any other.
fn scrub_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = scrub_text(text),
        Value::Array(items) => items.iter_mut().for_each(scrub_value),
        Value::Object(fields) => {
            *fields = std::mem::take(fields)
                .into_iter()
                .map(|(name, mut value)| {
                    scrub_value(&mut value);
                    (scrub_text(&name), value)
                })
                .collect();
        }
        _ => {}
    }
}

/// The event as it may leave: without the name of this PC (the SDK fills it in as "server_name") and of its
/// user, and with every text scrubbed. The texts are reached through the JSON form of the event - that is the
/// form it is sent in, so nothing can be sent that was not walked. An event that does not come back from that
/// form is not sent at all.
fn scrub_event(mut event: Event<'static>) -> Option<Event<'static>> {
    event.server_name = None;
    event.user = None;
    if let Some(Context::Device(device)) = event.contexts.get_mut("device") {
        device.name = None;
    }
    let mut value = serde_json::to_value(&event).ok()?;
    scrub_value(&mut value);
    serde_json::from_value(value).ok()
}

// ---------------------------------------------------------------- The gate

thread_local! {
    /// The id of the one report the user asked for by hand ("Send this error report"), on the thread that hands
    /// it to the client. The pass is for that event and not for the thread: a panic of the thread at this very
    /// moment is another event, and is dropped like any other while consent is off.
    static ASKED_FOR: Cell<Option<Uuid>> = const { Cell::new(None) };
}

/// Lets one report through although consent is off; ends when it is dropped.
struct AskedFor;

impl AskedFor {
    fn now(event_id: Uuid) -> AskedFor {
        ASKED_FOR.set(Some(event_id));
        AskedFor
    }
}

impl Drop for AskedFor {
    fn drop(&mut self) {
        ASKED_FOR.set(None);
    }
}

/// A panic as an event: what the integration makes of it, and the place in the source it happened at. A release
/// build is stripped of its symbols, so there the stack is a row of addresses and this line is what tells.
fn panic_event(info: &std::panic::PanicHookInfo<'_>) -> Option<Event<'static>> {
    let mut event = PanicIntegration::new().event_from_panic_info(info);
    if let Some(place) = info.location() {
        let place = format!("{}:{}:{}", place.file(), place.line(), place.column());
        event.extra.insert("location".to_string(), place.into());
    }
    Some(event)
}

/// The options of the client - all of them set here, none taken from the environment (`sentry::init` would
/// read SENTRY_DSN, SENTRY_RELEASE, SENTRY_ENVIRONMENT and SSL_VERIFY). `before_send` is the one gate every
/// event passes: while `enabled` is off it drops the event, otherwise it scrubs it. The transport is added by
/// `init`; the tests put their own in its place.
fn client_options(dsn: Dsn, enabled: Arc<AtomicBool>) -> sentry::ClientOptions {
    let mut options = sentry::ClientOptions::new()
        .release(concat!("ila-studio@", env!("CARGO_PKG_VERSION")))
        .environment(if cfg!(debug_assertions) { "development" } else { "production" })
        .send_default_pii(false)
        .max_breadcrumbs(0)
        // chosen one by one: the OS and Rust versions, the panic hook, and which frames of a stack are ours
        .default_integrations(false)
        .add_integration(ContextIntegration::new())
        .add_integration(PanicIntegration::new().add_extractor(panic_event))
        .add_integration(ProcessStacktraceIntegration)
        .before_send(move |event| {
            if !enabled.load(Ordering::Relaxed) && ASKED_FOR.get() != Some(event.event_id) {
                return None;
            }
            scrub_event(event)
        });
    options.dsn = Some(dsn);
    options
}

// ---------------------------------------------------------------- Sending

/// What became of the last request of the sender.
enum Answer {
    /// the HTTP status the report server answered with
    Status(u16),
    /// why the server could not be reached
    Failed(String),
    /// the server was not asked: crash reports had been switched off while the report waited
    Withheld,
}

/// For the reports the user sends by hand (the test report, "Send this error report"), who is told whether
/// they arrived.
static LAST_ANSWER: Mutex<Option<Answer>> = Mutex::new(None);

/// How many reports the user has sent by hand are on their way out (see SenderPass).
static BY_HAND: AtomicUsize = AtomicUsize::new(0);

/// Open while a report the user sends by hand is on its way: the sender lets it through although crash reports
/// are off.
struct SenderPass;

impl SenderPass {
    fn open() -> SenderPass {
        BY_HAND.fetch_add(1, Ordering::Relaxed);
        SenderPass
    }
}

impl Drop for SenderPass {
    fn drop(&mut self) {
        BY_HAND.fetch_sub(1, Ordering::Relaxed);
    }
}

/// May a report that reaches the network now still leave? `before_send` asked when the error happened; this is
/// asked when the report is sent, which can be much later: the sender sends one report at a time, and a server
/// that does not answer keeps it busy for SEND_TIMEOUT while others wait.
fn still_wanted(enabled: &AtomicBool) -> bool {
    enabled.load(Ordering::Relaxed) || BY_HAND.load(Ordering::Relaxed) > 0
}

/// Every request of the sender passes here (a "middleware" of the HTTP client), on the thread of the sender and
/// as its last step before the network. A report that waited while crash reports were switched off is withheld
/// here; of every other, the answer is noted and handed on.
struct SenderGate(Arc<AtomicBool>);

impl Middleware for SenderGate {
    fn handle(
        &self,
        mut request: ureq::http::Request<ureq::SendBody>,
        next: MiddlewareNext,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        if !still_wanted(&self.0) {
            *lock(&LAST_ANSWER) = Some(Answer::Withheld);
            // (the SDK takes it for a report that could not be sent, and drops it)
            return Err(ureq::Error::Io(std::io::Error::other("crash reports were switched off")));
        }
        // A connection of its own for each report, closed with the answer. Kept for the next report, as the
        // HTTP client would, it stays open long after the box is unticked: a connection to the report server
        // while crash reports are off.
        request.headers_mut().insert(ureq::http::header::CONNECTION, ureq::http::HeaderValue::from_static("close"));
        let answer = next.handle(request);
        *lock(&LAST_ANSWER) = Some(match &answer {
            Ok(response) => Answer::Status(response.status().as_u16()),
            Err(e) => Answer::Failed(e.to_string()),
        });
        answer
    }
}

/// Only error events leave. The SDK counts the events `before_send` dropped and adds that count ("client
/// report") to the next envelope it sends: a trace of the time before consent was given. That, and any other
/// kind of item a later version of the SDK may add by itself, is taken out here, at the last step before the
/// network.
fn events_only(envelope: sentry::Envelope) -> Option<sentry::Envelope> {
    envelope.filter(|item: &EnvelopeItem| matches!(item, EnvelopeItem::Event(_)))
}

struct EventsOnly(Arc<dyn sentry::Transport>);

impl sentry::Transport for EventsOnly {
    fn send_envelope(&self, envelope: sentry::Envelope) {
        if let Some(envelope) = events_only(envelope) {
            self.0.send_envelope(envelope);
        }
    }

    fn flush(&self, timeout: Duration) -> bool {
        self.0.flush(timeout)
    }

    fn shutdown(&self, timeout: Duration) -> bool {
        self.0.shutdown(timeout)
    }
}

/// The sender: the SDK's own ureq transport (one background thread, blocking HTTP), with an HTTP client set up
/// here. Left to itself the SDK checks the server against a list of authorities compiled into the program; this
/// one asks Windows, so that the Sentry of a company - whose authority is known to its PCs only - can be
/// reached. A proxy named in ALL_PROXY / HTTPS_PROXY / HTTP_PROXY is used (ureq reads them by default; the
/// proxy of the Windows settings it reads only with a feature that is not switched on). It carries the consent
/// of the user, for the gate of the sender.
struct ReportTransport(Arc<AtomicBool>);

// The HTTP client has the TLS of Windows only when it is built with its feature "native-tls" (Cargo.toml).
// Without it this would still compile, and the sender would stop with a panic at the first https address -
// which no test here would notice, as none goes to the network. This line does not compile then.
const _: Option<ureq::unversioned::transport::NativeTlsConnector> = None;

impl sentry::TransportFactory for ReportTransport {
    fn create_transport_with_options(&self, options: sentry::TransportOptions) -> Arc<dyn sentry::Transport> {
        let tls = TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier);
        let agent = ureq::Agent::config_builder()
            .tls_config(tls.build())
            // a server that does not answer must not hold the sender, and what waits behind it, for good
            .timeout_global(Some(SEND_TIMEOUT))
            .middleware(SenderGate(self.0.clone()))
            .build()
            .new_agent();
        let http = sentry::transports::UreqHttpTransportOptions::from(options).with_agent(agent).build();
        Arc::new(EventsOnly(Arc::new(http)))
    }
}

/// Crash reporting of this run. It exists only in a program that has a report address.
struct Reports {
    client: Arc<sentry::Client>,
    /// the consent of the user: off at start, set by the page from the preference it stores
    enabled: Arc<AtomicBool>,
    limiter: Mutex<Limiter>,
    /// the host the reports go to, for the page to show: the user is told where, not only that
    server: String,
    /// that host comes from ILA_SENTRY_DSN of the running program, not from the build
    own_server: bool,
    /// the address without its key, which the page stores the consent with (see destination)
    destination: String,
    /// reports to it cross a network in clear text (see unencrypted)
    unencrypted: bool,
}

static REPORTS: OnceLock<Reports> = OnceLock::new();

/// Call first thing at start, on the main thread. With a report address the client is set up at once - so that
/// the panic hook is in place - but it sends nothing before the user's consent arrives (see client_options).
pub fn init() {
    let Some((dsn, own_server)) = report_address() else {
        return;
    };
    let (server, destination, unencrypted) = (dsn.host().to_string(), destination(&dsn), unencrypted(&dsn));
    let enabled = Arc::new(AtomicBool::new(false));
    let mut options = client_options(dsn, enabled.clone());
    options.transport = Some(Arc::new(ReportTransport(enabled.clone())));
    let client = Arc::new(sentry::Client::from(options));
    // the panic hook finds the client through the hub; every thread started from now on has it in its own
    sentry::Hub::main().bind_client(Some(client.clone()));
    let limiter = Mutex::default();
    let _ = REPORTS.set(Reports { client, enabled, limiter, server, own_server, destination, unencrypted });
}

/// Gives a report that is on its way out the time to leave; returns at once when none is.
pub fn flush(timeout: Duration) {
    if let Some(reports) = REPORTS.get() {
        reports.client.flush(Some(timeout));
    }
}

// ---------------------------------------------------------------- Errors of the page

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub enum ErrorSource {
    /// an uncaught error (the "error" event of the window)
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "unhandledrejection")]
    UnhandledRejection,
    /// an error while rendering, caught by the ErrorBoundary of the page
    #[serde(rename = "render")]
    Render,
}

impl ErrorSource {
    fn name(self) -> &'static str {
        match self {
            ErrorSource::Error => "error",
            ErrorSource::UnhandledRejection => "unhandledrejection",
            ErrorSource::Render => "render",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportWindow {
    Main,
    Analysis,
}

/// An error as the page hands it over (src/crashReports.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendReport {
    message: String,
    /// the stack as V8 writes it
    stack: Option<String>,
    /// the components React was rendering
    component_stack: Option<String>,
    source: ErrorSource,
    window: ReportWindow,
    /// "Send this error report" was pressed: this one goes although reports are switched off
    once: Option<bool>,
}

impl FrontendReport {
    /// Is this the one report the user sends by hand? `once` is what the page says, and the backend cannot tell
    /// a press of the button from a call of the page. So it counts for what the button sends and nothing else:
    /// an error while a window was drawn. Of any other error `once` says nothing: that report is one like
    /// every other, and dropped while crash reports are off.
    fn by_hand(&self) -> bool {
        self.once == Some(true) && self.source == ErrorSource::Render
    }

    /// The texts bounded, before anything is done with them: the page decides how long a text it hands over.
    /// Generously: what a report carries of each (MAX_TEXT) is cut off by the scrubber, after it has looked for
    /// paths and addresses. Cut down to that here, a path at the cut would lose the part it is recognised by.
    fn bound(&mut self) {
        let bound = |text: &mut String, most: usize| {
            if let Some((end, _)) = text.char_indices().nth(most) {
                text.truncate(end);
            }
        };
        bound(&mut self.message, 4 * MAX_TEXT);
        for text in [&mut self.stack, &mut self.component_stack].into_iter().flatten() {
            bound(text, 10 * MAX_TEXT);
        }
    }
}

/// What became of an error the page handed over.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// handed to the sender
    Sent,
    /// crash reports are switched off
    Off,
    /// this build has no report address
    Unavailable,
    /// this run has reported the same message already
    Duplicate,
    /// this run has sent all the reports it may: MAX_REPORTS, or MAX_BY_HAND by hand
    Limit,
}

/// What a run has reported of the page: each message once, and MAX_REPORTS messages at most.
#[derive(Default)]
struct Limiter {
    seen: HashSet<String>,
    /// how many of them were sent by hand
    by_hand: usize,
}

impl Limiter {
    fn admit(&mut self, message: &str) -> Outcome {
        if self.seen.contains(message) {
            Outcome::Duplicate
        } else if self.seen.len() >= MAX_REPORTS {
            Outcome::Limit
        } else {
            self.seen.insert(message.to_string());
            Outcome::Sent
        }
    }

    /// The same for a report sent by hand, of which a run sends MAX_BY_HAND: that is all the button can ask for,
    /// and so all that is given to whatever else may call in its name.
    fn admit_by_hand(&mut self, message: &str) -> Outcome {
        if self.by_hand >= MAX_BY_HAND && !self.seen.contains(message) {
            return Outcome::Limit;
        }
        let admitted = self.admit(message);
        self.by_hand += usize::from(admitted == Outcome::Sent);
        admitted
    }
}

/// Function, file, line and column of one line of a V8 stack ("at render (http://host/app.js:10:5)"), as far
/// as the line has them.
fn parse_js_frame(line: &str) -> Option<Frame> {
    let rest = line.trim().strip_prefix("at ")?.trim();
    let (function, place) = match rest.strip_suffix(')').and_then(|r| r.split_once(" (")) {
        Some((function, place)) => (Some(function.trim()), place),
        None => (None, rest),
    };
    // from the right: the file is a URL or a Windows path and has colons of its own
    let mut parts = place.rsplitn(3, ':');
    let numbers = (parts.next().and_then(|n| n.parse().ok()), parts.next().and_then(|n| n.parse().ok()));
    let (filename, lineno, colno) = match (numbers, parts.next()) {
        ((Some(column), Some(line)), Some(file)) => (Some(file), Some(line), Some(column)),
        // no position: "index 0" of Promise.all, "native", "<anonymous>"
        _ => (None, None, None),
    };
    if function.is_none() && filename.is_none() {
        return None;
    }
    Some(Frame {
        function: function.filter(|f| !f.is_empty()).map(str::to_string),
        filename: filename.map(str::to_string),
        lineno,
        colno,
        in_app: Some(true),
        ..Default::default()
    })
}

/// The frames of a V8 stack text, the innermost first as V8 lists them. Its first line is "Type: message";
/// lines that are no frames are skipped.
fn parse_js_stack(stack: &str) -> Vec<Frame> {
    stack.lines().filter_map(parse_js_frame).take(MAX_FRAMES).collect()
}

/// The kind of error a V8 stack begins with ("TypeError: ..." gives TypeError), if it begins with one.
fn js_error_type(stack: &str) -> Option<&str> {
    let (name, _) = stack.lines().next()?.split_once(':')?;
    let is_name = !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    is_name.then_some(name)
}

/// An error of the page as an event: one exception with the frames of its stack where they can be read, the
/// stack as text where they cannot.
fn frontend_event(report: &FrontendReport) -> Event<'static> {
    let stack = report.stack.as_deref().unwrap_or("").trim();
    let frames = parse_js_stack(stack);
    let fallback = if report.source == ErrorSource::UnhandledRejection { "UnhandledRejection" } else { "Error" };
    let mut extra = Map::new();
    if frames.is_empty() && !stack.is_empty() {
        extra.insert("stack".to_string(), stack.into());
    }
    if let Some(components) = report.component_stack.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        extra.insert("component_stack".to_string(), components.into());
    }
    let mut tags = Map::new();
    tags.insert("source".to_string(), report.source.name().to_string());
    let window = if report.window == ReportWindow::Main { "main" } else { "analysis" };
    tags.insert("window".to_string(), window.to_string());
    Event {
        platform: "javascript".into(),
        level: Level::Error,
        exception: vec![Exception {
            ty: js_error_type(stack).unwrap_or(fallback).to_string(),
            value: Some(report.message.clone()),
            // Sentry wants the innermost frame last
            stacktrace: Stacktrace::from_frames_reversed(frames),
            mechanism: Some(Mechanism {
                ty: report.source.name().to_string(),
                handled: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        }]
        .into(),
        tags,
        extra,
        ..Default::default()
    }
}

/// Sends an error of the page, if that is wanted: reports are switched on, or this one was asked for by hand.
fn report_page_error(
    client: &sentry::Client,
    enabled: &AtomicBool,
    limiter: &Mutex<Limiter>,
    report: &FrontendReport,
) -> Outcome {
    let by_hand = report.by_hand();
    if !by_hand && !enabled.load(Ordering::Relaxed) {
        return Outcome::Off;
    }
    let admitted = if by_hand {
        lock(limiter).admit_by_hand(&report.message)
    } else {
        lock(limiter).admit(&report.message)
    };
    if admitted != Outcome::Sent {
        return admitted;
    }
    // (an event has an id of its own from the moment it is made)
    let event = frontend_event(report);
    let _asked_for = by_hand.then(|| AskedFor::now(event.event_id));
    // a nil id: the gate dropped it after all (switched off at this very moment)
    if client.capture_event(event, None).is_nil() {
        Outcome::Off
    } else {
        Outcome::Sent
    }
}

// ---------------------------------------------------------------- Tauri Commands

/// `available`: this program has a report address. `enabled`: the user has switched crash reports on.
/// `server` and `ownServer`: where the reports go, and whether that was named when the program was started.
/// `destination`: the address the page stores the consent with. `unencrypted`: reports to it are not encrypted.
#[tauri::command]
pub async fn crash_reports_state() -> Result<Value, String> {
    Ok(match REPORTS.get() {
        Some(reports) => json!({
            "available": true,
            "enabled": reports.enabled.load(Ordering::Relaxed),
            "server": reports.server,
            "ownServer": reports.own_server,
            "destination": reports.destination,
            "unencrypted": reports.unencrypted,
        }),
        None => json!({
            "available": false,
            "enabled": false,
            "server": null,
            "ownServer": false,
            "destination": null,
            "unencrypted": false,
        }),
    })
}

/// The consent of the user, as the page stores it; it does nothing in a program without a report address.
#[tauri::command]
pub async fn set_crash_reports(enabled: bool) -> Result<(), String> {
    if let Some(reports) = REPORTS.get() {
        reports.enabled.store(enabled, Ordering::Relaxed);
    }
    Ok(())
}

/// An error of the page (src/crashReports.ts). One the user sends by hand (`once`) is waited for: whoever
/// pressed the button is told whether the report arrived, as an error if it did not.
#[tauri::command]
pub async fn report_frontend_error(report: FrontendReport) -> Result<Outcome, String> {
    let Some(reports) = REPORTS.get() else {
        return Ok(Outcome::Unavailable);
    };
    let mut report = report;
    report.bound();
    if !report.by_hand() {
        return Ok(report_page_error(&reports.client, &reports.enabled, &reports.limiter, &report));
    }
    blocking(move || {
        // What still waits in the sender from the time crash reports were on would leave together with this
        // report, once the sender is told to let one through. So the sender is emptied first: it withholds
        // what waits, and only a report that is on the network already takes its time.
        if !reports.client.flush(Some(SEND_TIMEOUT + Duration::from_secs(2))) {
            return Err("The report was not sent: the sender is still busy with an earlier one. Try again.".to_string());
        }
        let _pass = SenderPass::open();
        *lock(&LAST_ANSWER) = None;
        let outcome = report_page_error(&reports.client, &reports.enabled, &reports.limiter, &report);
        if outcome == Outcome::Sent {
            wait_for_answer(&reports.client)?;
        }
        Ok(outcome)
    })
    .await
}

/// Waits until the report that was just handed to the sender has gone out, and says how that went: the SDK
/// sends in the background and tells nobody, so the answer is the one the gate of the sender saw last. (Should
/// another report leave in the same moment, it may be the answer to that one.)
fn wait_for_answer(client: &sentry::Client) -> Result<(), String> {
    let gone = client.flush(Some(SEND_TIMEOUT + Duration::from_secs(2)));
    told(lock(&LAST_ANSWER).take(), gone)
}

/// What the user is told of the answer to a report sent by hand; `gone`: the sender has come to its end.
fn told(answer: Option<Answer>, gone: bool) -> Result<(), String> {
    match answer {
        Some(Answer::Status(status)) if (200..300).contains(&status) => Ok(()),
        Some(Answer::Status(429)) => Err("The report server takes no more reports for now (HTTP 429). Try again later.".to_string()),
        Some(Answer::Status(status)) => Err(format!("The report server refused the report (HTTP {status}).")),
        Some(Answer::Failed(e)) => Err(format!("The report server could not be reached: {e}")),
        // the box was unticked while the report waited: nothing was sent, and the server is not to blame
        Some(Answer::Withheld) => Err("The report was not sent: crash reports were switched off.".to_string()),
        // nothing was asked of the server: after an HTTP 429 the sender keeps the pause the server asked for
        None if gone => Err("The report was not sent: the report server has asked for a pause. Try again later.".to_string()),
        None => Err("The report has not gone out yet: the sender is still busy with an earlier one.".to_string()),
    }
}

/// "Send a test report": one message, so that whoever set up the report address can see that it arrives. The
/// answer is the id the report has in Sentry - given only when the server took it.
#[tauri::command]
pub async fn send_test_crash_report() -> Result<String, String> {
    blocking(|| {
        let reports = REPORTS.get().ok_or(NO_ADDRESS)?;
        *lock(&LAST_ANSWER) = None;
        let event = Event { message: Some(TEST_MESSAGE.to_string()), level: Level::Info, ..Default::default() };
        let id = reports.client.capture_event(event, None);
        // a nil id: the gate dropped it
        if id.is_nil() {
            return Err("Crash reports are switched off.".to_string());
        }
        wait_for_answer(&reports.client)?;
        Ok(id.simple().to_string())
    })
    .await
}

// ---------------------------------------------------------------- Tests

// Nothing here reaches a network: the events are looked at where the SDK hands them to its transport. Every name
// and address in the test data is invented.
#[cfg(test)]
mod tests {
    use super::*;
    use sentry::protocol::{DeviceContext, User};

    fn test_options(enabled: &Arc<AtomicBool>) -> sentry::ClientOptions {
        client_options("https://public@sentry.invalid/1".parse().expect("a DSN"), enabled.clone())
    }

    fn message(text: &str) -> Event<'static> {
        Event { message: Some(text.to_string()), ..Default::default() }
    }

    fn page_error(text: &str) -> FrontendReport {
        FrontendReport {
            message: text.to_string(),
            stack: None,
            component_stack: None,
            source: ErrorSource::Error,
            window: ReportWindow::Main,
            once: None,
        }
    }

    #[test]
    fn choose_address_takes_the_run_time_variable_first() {
        let dsn = |text: &str| Some(text.parse::<Dsn>().expect("a DSN"));
        let build = "https://build@sentry.invalid/1";
        let own = "http://own@127.0.0.1:9000/2";
        assert_eq!(choose_address(None, None), None);
        assert_eq!(choose_address(None, Some(build)), dsn(build));
        assert_eq!(choose_address(Some(own), Some(build)), dsn(own));
        assert_eq!(choose_address(Some(&format!(" {own}\n")), None), dsn(own));
        // a build without the secret gets an empty text, not none
        assert_eq!(choose_address(None, Some("")), None);
        // what is set at run time decides alone: no falling back to the server of the build
        assert_eq!(choose_address(Some("not an address"), Some(build)), None);
        assert_eq!(choose_address(Some(""), Some(build)), None);
    }

    #[test]
    fn destination_is_the_address_without_its_key() {
        let of = |text: &str| destination(&text.parse().expect("a DSN"));
        assert_eq!(of("https://public@sentry.invalid/1"), "https://sentry.invalid:443/1");
        assert_eq!(of("http://own@127.0.0.1:9000/2"), "http://127.0.0.1:9000/2");
        assert_eq!(of("https://public:secret@sentry.invalid/behind/a/proxy/42"), "https://sentry.invalid:443/behind/a/proxy/42");
        assert_eq!(of("http://own@[::1]:9000/2"), "http://[::1]:9000/2");
        // the same place under another key, and written with its port
        assert_eq!(of("https://other@sentry.invalid:443/1"), of("https://public@sentry.invalid/1"));
        // another server, port, project or scheme is another place: the consent given for the first is none for it
        let first = of("https://public@sentry.invalid/1");
        for other in [
            "https://public@reports.invalid/1",
            "https://public@sentry.invalid:8443/1",
            "https://public@sentry.invalid/2",
            "http://public@sentry.invalid/1",
            "https://public@sentry.invalid/behind/1",
        ] {
            assert_ne!(of(other), first, "{other}");
        }
    }

    #[test]
    fn unencrypted_is_an_http_address_that_is_not_on_this_pc() {
        let is = |text: &str| unencrypted(&text.parse().expect("a DSN"));
        for text in ["http://own@192.0.2.10:9000/2", "http://own@sentry.lab.invalid/2", "http://own@[2001:db8::1]:9000/2"] {
            assert!(is(text), "{text}");
        }
        for text in [
            "https://public@sentry.invalid/1",
            "https://own@192.0.2.10:9000/2",
            "http://own@127.0.0.1:9000/2",
            "http://own@127.8.9.10/2",
            "http://own@localhost:9000/2",
            "http://own@[::1]:9000/2",
        ] {
            assert!(!is(text), "{text}");
        }
    }

    #[test]
    fn scrub_text_takes_the_user_folder_out_of_a_path() {
        assert_eq!(scrub_text(r"C:\Users\somebody\project\top.ltx"), r"C:\Users\<user>\project\top.ltx");
        assert_eq!(scrub_text("C:/Users/somebody/project/top.ltx"), "C:/Users/<user>/project/top.ltx");
        assert_eq!(scrub_text(r"c:\users\SomeBody\x"), r"c:\users\<user>\x");
        assert_eq!(scrub_text("/home/somebody/work/a.csv"), "/home/<user>/work/a.csv");
        assert_eq!(scrub_text("/Users/somebody/work/a.csv"), "/Users/<user>/work/a.csv");
        assert_eq!(scrub_text("file:///C:/Users/somebody/app/index.js:10:5"), "file:///C:/Users/<user>/app/index.js:10:5");
        // doubled separators: a path as it stands inside JSON
        assert_eq!(scrub_text(r"C:\\Users\\somebody\\x"), r"C:\\Users\\<user>\\x");
        // (the folders behind the name are no servers of a network path, for all their doubled separators)
        assert_eq!(scrub_text(r"C:\\Users\\somebody\\AppData\\Local\\x"), r"C:\\Users\\<user>\\AppData\\Local\\x");
        assert_eq!(scrub_text("/home/somebody//work/a.csv"), "/home/<user>//work/a.csv");
        // the short form Windows gives a long name
        assert_eq!(scrub_text(r"C:\Users\SOMEBO~1\AppData\Local\Temp"), r"C:\Users\<user>\AppData\Local\Temp");
        // the hidden shares home folders are redirected to
        assert_eq!(scrub_text(r"H:\home$\somebody\Documents\top.ltx"), r"H:\home$\<user>\Documents\top.ltx");
        assert_eq!(scrub_text(r"\\fileserver\Users$\somebody\top.ltx"), r"\\<host>\Users$\<user>\top.ltx");
        // one of the two folders inside the other: the name may be the first or the second, and both go
        assert_eq!(scrub_text("/home/users/somebody/work/a.csv"), "/home/<user>/work/a.csv");
        assert_eq!(scrub_text(r"\\fileserver\home\Users\somebody\a.csv"), r"\\<host>\home\<user>\a.csv");
        assert_eq!(scrub_text(r"C:\Users\Home\Documents"), r"C:\Users\<user>");
        assert_eq!(scrub_text("/home/users"), "/home/<user>");
    }

    #[test]
    fn scrub_text_takes_a_user_folder_at_the_end_and_several_in_one_text() {
        assert_eq!(scrub_text(r"cannot open C:\Users\somebody"), r"cannot open C:\Users\<user>");
        assert_eq!(scrub_text(r#"cannot open "C:\Users\somebody""#), r#"cannot open "C:\Users\<user>""#);
        assert_eq!(
            scrub_text(r"copy C:\Users\one\a.csv to D:\Users\two\b.csv failed"),
            r"copy C:\Users\<user>\a.csv to D:\Users\<user>\b.csv failed"
        );
        // a name may hold spaces: it goes whole
        assert_eq!(scrub_text(r"C:\Users\Some Body\x.csv"), r"C:\Users\<user>\x.csv");
        // Questionable, pinned as it is: without a separator behind the name, the words up to a character no
        // name holds go with it.
        assert_eq!(scrub_text(r"C:\Users\somebody is not a folder: error 3"), r"C:\Users\<user>: error 3");
    }

    #[test]
    fn scrub_text_leaves_what_only_looks_like_a_user_folder() {
        for text in [r"C:\Users", r"C:\Users\", "/home/", "/homework/a", r"C:\usersettings\a", "users/somebody", r"C:\Users\<user>\x"] {
            assert_eq!(scrub_text(text), text);
        }
    }

    #[test]
    fn scrub_text_takes_the_server_out_of_a_network_path() {
        assert_eq!(scrub_text(r"\\labserver\designs\top.ltx"), r"\\<host>\designs\top.ltx");
        assert_eq!(scrub_text(r#"open("\\labserver\designs\top.ltx")"#), r#"open("\\<host>\designs\top.ltx")"#);
        assert_eq!(scrub_text(r"\\labserver\Users\somebody\top.ltx"), r"\\<host>\Users\<user>\top.ltx");
        assert_eq!(scrub_text(r"\\192.0.2.10\designs\top.ltx"), r"\\<host>\designs\top.ltx");
        // as it stands inside JSON
        assert_eq!(scrub_text(r#""\\\\labserver\\designs""#), r#""\\\\<host>\\designs""#);
        // no network paths: a local path with the prefix of Windows, doubled separators, an escape in a text
        for text in [r"\\?\C:\work\top.ltx", r"\\.\COM3", r"C:\\work\\top.ltx", r"a \\n b"] {
            assert_eq!(scrub_text(text), text);
        }
        // Questionable, pinned as it is: a server named without a share cannot be told from such an escape,
        // and stays.
        assert_eq!(scrub_text(r"\\labserver"), r"\\labserver");
        assert_eq!(scrub_text(r"\\?\C:\Users\somebody\top.ltx"), r"\\?\C:\Users\<user>\top.ltx");
    }

    #[test]
    fn scrub_text_takes_the_server_out_of_a_network_path_in_its_other_forms() {
        // with forward slashes: the form ila_capture.py gives every path for Tcl, so the one Vivado names in an error
        assert_eq!(scrub_text("//labserver/designs/top.ltx"), "//<host>/designs/top.ltx");
        assert_eq!(scrub_text(r"\\labserver/designs\top.ltx"), r"\\<host>/designs\top.ltx");
        // the long form of Windows, also as JSON writes it
        assert_eq!(scrub_text(r"\\?\UNC\labserver\share\top.ltx"), r"\\?\UNC\<host>\share\top.ltx");
        assert_eq!(scrub_text(r"\\.\unc\labserver\share\top.ltx"), r"\\.\unc\<host>\share\top.ltx");
        assert_eq!(scrub_text(r"\\\\?\\UNC\\labserver\\share\\top.ltx"), r"\\\\?\\UNC\\<host>\\share\\top.ltx");
        // as a URL of a file - which has no server when it begins with three slashes
        assert_eq!(scrub_text("file://labserver/designs/top.ltx"), "file://<host>/designs/top.ltx");
        assert_eq!(scrub_text("file:////labserver/designs/top.ltx"), "file:////<host>/designs/top.ltx");
        assert_eq!(scrub_text("file:///C:/work/top.ltx"), "file:///C:/work/top.ltx");
        // behind any character a path can begin after, not only a space or a quote
        assert_eq!(scrub_text(r"Error:\\labserver\share\x"), r"Error:\\<host>\share\x");
        assert_eq!(scrub_text(r"<\\labserver\share\x>"), r"<\\<host>\share\x>");
        assert_eq!(scrub_text(r"log>\\labserver\share\x"), r"log>\\<host>\share\x");
        assert_eq!(scrub_text(r"\\labserver@SSL\share\x"), r"\\<host>\share\x");
        // no network paths: a URL (its host is one called by its name, and stays), a path that goes on, a
        // drive as JSON writes it, a comment
        for text in [
            "http://tauri.localhost/assets/index.js:10:5",
            "https://reports.example.org//doubled/path",
            "src//components/Header.tsx",
            r"C:\work\\caps\w1.csv",
            r"D:\\caps\\w1.csv",
            "a // b/c",
            "the pipe \\\\.\\pipe\\name",
        ] {
            assert_eq!(scrub_text(text), text);
        }
        // Questionable, pinned as it is: a path without a drive as JSON writes it cannot be told from a network
        // path, so its first folder goes as a server would. The name is what matters, and it is gone.
        assert_eq!(scrub_text(r"\\Users\\somebody\\AppData\\x"), r"\\<host>\\<user>\\AppData\\x");
    }

    // The texts of the privacy review: each went out with a name or an address in it (finding 2). `labserver`,
    // `fileserver`, `SomeName`, `somebody` and the addresses stand for what a lab keeps to itself.
    #[test]
    fn scrub_text_takes_out_what_the_review_saw_leave() {
        assert_eq!(
            scrub_text(r#"couldn't open "//labserver/designs/top.ltx": no such file or directory"#),
            r#"couldn't open "//<host>/designs/top.ltx": no such file or directory"#
        );
        assert_eq!(
            scrub_text(r"cannot read \\?\UNC\labserver\share\top.ltx (and \\labserver\share\ok.ltx)"),
            r"cannot read \\?\UNC\<host>\share\top.ltx (and \\<host>\share\ok.ltx)"
        );
        // (the path in the notation of a URL is NOT recognised, and the README says so: its name stays)
        assert_eq!(
            scrub_text(concat!(
                r"target hw_server_192.0.2.44, file C%3A%5CUsers%5CSomeName%5Cx.csv, ",
                r"home share \\fileserver\home$\SomeName\Documents\top.ltx, plain C:\Users\SomeName\y at 192.0.2.44:3121"
            )),
            concat!(
                r"target hw_server_<ip>, file C%3A%5CUsers%5CSomeName%5Cx.csv, ",
                r"home share \\<host>\home$\<user>\Documents\top.ltx, plain C:\Users\<user>\y at <ip>:3121"
            )
        );
        assert_eq!(
            scrub_text(concat!(
                r"review panic reading C:\Users\SomeName\captures\w1.csv from hw_server 192.0.2.44:3121 ",
                "and //labserver/designs/top.ltx"
            )),
            r"review panic reading C:\Users\<user>\captures\w1.csv from hw_server <ip>:3121 and //<host>/designs/top.ltx"
        );
        // what the same review found unchanged by the scrubber alone
        assert_eq!(scrub_text(r"Error:\\labserver\share\x"), r"Error:\\<host>\share\x");
        assert_eq!(scrub_text(r"<\\labserver\share\x>"), r"<\\<host>\share\x>");
        assert_eq!(scrub_text("file://labserver/designs/top.ltx"), "file://<host>/designs/top.ltx");
        assert_eq!(scrub_text("ip192.0.2.44"), "ip<ip>");
        assert_eq!(scrub_text("192.0.2.44.3121"), "<ip>.3121");
        // NOT recognised, and the README says so: a user folder that lies elsewhere
        assert_eq!(scrub_text(r"D:\Profiles\somebody\x"), r"D:\Profiles\somebody\x");
    }

    // The fourth text of the review: a message of the page that was cut to MAX_TEXT before it was scrubbed, so
    // that the server of a path at the cut had lost the share it is recognised by. It is cut after it now.
    #[test]
    fn a_long_message_of_the_page_is_scrubbed_before_it_is_cut() {
        let scrubbed = |text: String| {
            let mut report = page_error(&text);
            report.bound();
            let event = scrub_event(frontend_event(&report)).expect("an event");
            event.exception.values[0].value.clone().expect("a message")
        };
        let server = scrubbed(format!(r"{} \\labserver\designs\top.ltx", "y".repeat(1988)));
        assert_eq!(server, format!(r"{} \\<host>\de...", "y".repeat(1988)));
        let address = scrubbed(format!("{} 192.0.2.77:3121 is not reachable", "x".repeat(1989)));
        assert_eq!(address, format!("{} <ip>:3121 ...", "x".repeat(1989)));
        let folder = scrubbed(format!(r"{} C:\Users\somebody\x.csv", "z".repeat(1988)));
        assert_eq!(folder, format!(r"{} C:\Users\<u...", "z".repeat(1988)));

        // what the page hands over is still bounded, each text by itself
        let mut report = FrontendReport {
            stack: Some("s".repeat(50 * MAX_TEXT)),
            component_stack: Some("\u{e4}".repeat(50 * MAX_TEXT)),
            ..page_error(&"m".repeat(50 * MAX_TEXT))
        };
        report.bound();
        assert_eq!(report.message.chars().count(), 4 * MAX_TEXT);
        assert_eq!(report.stack.as_deref().map(|s| s.chars().count()), Some(10 * MAX_TEXT));
        assert_eq!(report.component_stack.as_deref().map(|s| s.chars().count()), Some(10 * MAX_TEXT));
        assert_eq!(scrubbed("m".repeat(50 * MAX_TEXT)), format!("{}...", "m".repeat(MAX_TEXT)));
    }

    #[test]
    fn scrub_text_takes_ipv4_addresses_out_and_keeps_the_port() {
        assert_eq!(scrub_text("hw_server at 192.0.2.44:3121 is not reachable"), "hw_server at <ip>:3121 is not reachable");
        assert_eq!(scrub_text("192.0.2.44"), "<ip>");
        assert_eq!(scrub_text("TCP:192.0.2.44:3121 and 198.51.100.7."), "TCP:<ip>:3121 and <ip>.");
        assert_eq!(scrub_text("(127.0.0.1)"), "(<ip>)");
        assert_eq!(scrub_text("http://192.0.2.44:8080/x"), "http://<ip>:8080/x");
        assert_eq!(scrub_text("::ffff:192.0.2.44 in 192.0.2.0/24"), "::ffff:<ip> in <ip>/24");
        // glued to a word: a letter or a "_" in front does not make an address a part of the word
        assert_eq!(scrub_text("hw_server_192.0.2.44"), "hw_server_<ip>");
        assert_eq!(scrub_text("ip192.0.2.44, srv192.0.2.45 and dev192.0.2.46x"), "ip<ip>, srv<ip> and dev<ip>x");
        // the port behind a dot, as some tools write it
        assert_eq!(scrub_text("192.0.2.44.3121 > 198.51.100.7.31210:"), "<ip>.3121 > <ip>.31210:");
        // Changed on purpose (this line stood among the versions below, expected to stay): a row of four
        // numbers behind a "_" is as much "hw_server_192.0.2.44" as it is a build number. When in doubt: out.
        assert_eq!(scrub_text("build_1.2.3.4"), "build_<ip>");
        // Questionable, pinned as it is: a fifth number up to 255 reads as a part of a version, so an address
        // with a low port behind a dot stays.
        assert_eq!(scrub_text("192.0.2.44.80"), "192.0.2.44.80");
    }

    #[test]
    fn scrub_text_leaves_versions_and_other_numbers() {
        for text in [
            "Vivado 2017.4",
            "ila-studio@0.4.0",
            "Windows 10.0.26200",
            "10.0.19045.4651",
            "1.2.3.4.5",
            "1.2.3.4.5.6",
            "1.2.3.4.3121.6",
            "v1.2.3.4",
            "V1.2.3.4",
            "vivado_v10.1.2.3",
            "300.1.1.1",
            "1.2.3",
            "1..2.3.4",
            "6034482 Hz",
            // longer than any number type holds
            "the index is 18446744073709551615",
            "340282366920938463463374607431768211456.1.2.3",
            "1.2.3.99999999999999999999",
        ] {
            assert_eq!(scrub_text(text), text);
        }
    }

    #[test]
    fn scrub_text_keeps_text_outside_ascii_and_cuts_at_a_letter() {
        let text = "Gr\u{f6}\u{df}e der Datei \u{2013} \u{6ce2}\u{5f62}";
        assert_eq!(scrub_text(text), text);
        assert_eq!(scrub_text("C:\\Users\\J\u{fc}rgen M\u{fc}ller\\\u{dc}bung.csv"), "C:\\Users\\<user>\\\u{dc}bung.csv");
        assert_eq!(scrub_text("/home/\u{6ce2}\u{5f62}"), "/home/<user>");

        let long = "\u{e4}".repeat(MAX_TEXT + 500);
        let cut = scrub_text(&long);
        assert_eq!(cut, format!("{}...", "\u{e4}".repeat(MAX_TEXT)));
        let exact = "x".repeat(MAX_TEXT);
        assert_eq!(scrub_text(&exact), exact);
        // an address that the cut would have halved is gone before it is cut
        let at_the_cut = format!("{} 192.0.2.44", "x".repeat(MAX_TEXT - 6));
        assert!(!scrub_text(&at_the_cut).contains("192"));
    }

    #[test]
    fn scrub_text_takes_a_long_text_of_nothing_but_separators_or_digits() {
        // what the page hands over is bounded, not chosen: the longest it may be, of the bytes the scrubber stops at
        for byte in [
            "\\", "/", "9", ".", "1.", " \\\\", "/home/", "\u{e4}", " //", ":\\\\", "file://", "\\\\?\\UNC\\", "/home/users/",
            "192.0.2.1.", "x:", "<user>//",
        ] {
            let text = byte.repeat(10 * MAX_TEXT / byte.len());
            let started = std::time::Instant::now();
            assert!(scrub_text(&text).chars().count() <= MAX_TEXT + 3, "{byte:?}");
            assert!(started.elapsed() < Duration::from_secs(2), "{byte:?} took {:?}", started.elapsed());
        }
    }

    #[test]
    fn scrub_text_changes_nothing_the_second_time() {
        for text in [
            r"boom C:\Users\somebody\x at 192.0.2.44:3121",
            r"\\labserver\Users\some body\a",
            "plain",
            r#"{"path":"\\\\labserver\\designs\\top.ltx","home":"C:\\Users\\somebody\\AppData\\x"}"#,
            "//labserver/designs/top.ltx at 192.0.2.44.3121, /home/users/somebody//work",
            r"\\?\UNC\labserver\home$\somebody\x and file://labserver/x and hw_server_192.0.2.44",
            // (found by the generated texts below: the "UNC" of the long form went as a server the second time)
            r"\\?\\\UNC/44\\x",
        ] {
            let once = scrub_text(text);
            assert_eq!(scrub_text(&once), once);
        }
    }

    // Texts nobody chose: thrown together from the pieces the scrubber looks for, to find the one it stumbles
    // over. Whatever comes, it must not panic (it runs inside the panic hook, where a panic ends the program),
    // must cut between two characters, and - while a text is not cut - must find nothing more to take out of
    // what it has scrubbed.
    #[test]
    fn scrub_text_takes_any_text() {
        const PIECES: [&str; 40] = [
            "\\", "\\\\", "/", "//", ":", ".", " ", "\"", "$", "?", "_", "-", ">", "<", "v", "%5C", "\n", "0", "1", "44", "192",
            "255", "256", "3121", "Users", "users", "home", "UNC", "file", "C", "labserver", "somebody", "top.ltx", "<user>",
            "<host>", "<ip>", "\u{e4}", "\u{6ce2}", "\u{1f600}", "a b",
        ];
        // (a small generator of its own: the same texts in every run)
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = |below: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % below as u64) as usize
        };
        for _ in 0..20_000 {
            let text: String = (0..1 + next(40)).map(|_| PIECES[next(PIECES.len())]).collect();
            let once = scrub_text(&text);
            assert!(once.chars().count() <= MAX_TEXT + 3, "{text:?}");
            assert_eq!(scrub_text(&once), once, "of {text:?}");
        }
        // long ones, which are cut: between two characters, or the cut itself would have panicked
        for _ in 0..200 {
            let text: String = (0..2 * MAX_TEXT).map(|_| PIECES[next(PIECES.len())]).collect();
            let cut = scrub_text(&text);
            assert_eq!(cut.chars().count(), MAX_TEXT + 3, "{text:?}");
            assert!(cut.ends_with("..."));
        }
    }

    #[test]
    fn scrub_event_takes_out_the_names_of_the_pc_and_its_user() {
        let mut event = message(r"failed in C:\Users\somebody\x");
        event.server_name = Some("lab-pc-17".into());
        event.user = Some(User { username: Some("somebody".to_string()), ..Default::default() });
        let device = DeviceContext { name: Some("lab-pc-17".to_string()), arch: Some("x86_64".to_string()), ..Default::default() };
        event.contexts.insert("device".to_string(), device.into());

        let event = scrub_event(event).expect("an event");
        assert_eq!(event.server_name, None);
        assert_eq!(event.user, None);
        assert_eq!(event.message.as_deref(), Some(r"failed in C:\Users\<user>\x"));
        let Some(Context::Device(device)) = event.contexts.get("device") else {
            panic!("the device context is gone");
        };
        assert_eq!(device.name, None);
        assert_eq!(device.arch.as_deref(), Some("x86_64"));
        assert!(!serde_json::to_string(&event).expect("JSON").contains("lab-pc-17"));
    }

    #[test]
    fn scrub_event_reaches_every_text() {
        let mut event = message("m 192.0.2.44");
        event.exception = vec![Exception {
            ty: "Error".to_string(),
            value: Some(r"v C:\Users\somebody\a".to_string()),
            stacktrace: Some(Stacktrace {
                frames: vec![Frame {
                    function: Some("load".to_string()),
                    filename: Some("file:///C:/Users/somebody/app.js".to_string()),
                    abs_path: Some(r"C:\Users\somebody\src\lib.rs".to_string()),
                    lineno: Some(7),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }]
        .into();
        event.tags.insert("where".to_string(), "/home/somebody/x".to_string());
        event.extra.insert("deep".to_string(), json!({ "list": [{ "path": r"\\labserver\share\a" }, "198.51.100.7:3121"] }));

        let event = scrub_event(event).expect("an event");
        let text = serde_json::to_string(&event).expect("JSON");
        for gone in ["somebody", "labserver", "192.0.2.44", "198.51.100.7"] {
            assert!(!text.contains(gone), "{gone} is still in {text}");
        }
        let frame = &event.exception.values[0].stacktrace.as_ref().expect("a stack").frames[0];
        assert_eq!(frame.filename.as_deref(), Some("file:///C:/Users/<user>/app.js"));
        assert_eq!(frame.abs_path.as_deref(), Some(r"C:\Users\<user>\src\lib.rs"));
        assert_eq!((frame.function.as_deref(), frame.lineno), (Some("load"), Some(7)));
        assert_eq!(event.tags["where"], "/home/<user>/x");
        assert_eq!(event.extra["deep"], json!({ "list": [{ "path": r"\\<host>\share\a" }, "<ip>:3121"] }));
    }

    #[test]
    fn scrub_event_reaches_the_names_of_the_fields() {
        // (no event of today is named by a text: every name is a constant. The README says "every text".)
        let mut event = message("m");
        event.tags.insert(r"\\labserver\share".to_string(), "t".to_string());
        event.extra.insert(r"C:\Users\somebody\x at 192.0.2.44".to_string(), json!({ "/home/somebody/y": 1 }));

        let event = scrub_event(event).expect("an event");
        assert_eq!(event.tags.keys().collect::<Vec<_>>(), [r"\\<host>\share"]);
        assert_eq!(event.extra[r"C:\Users\<user>\x at <ip>"], json!({ "/home/<user>/y": 1 }));
        let text = serde_json::to_string(&event).expect("JSON");
        for gone in ["somebody", "labserver", "192.0.2.44"] {
            assert!(!text.contains(gone), "{gone} is still in {text}");
        }
    }

    #[test]
    fn scrub_event_keeps_an_event_that_holds_nothing_private() {
        let mut event = frontend_event(&FrontendReport {
            stack: Some("TypeError: x is undefined\n    at render (http://tauri.localhost/assets/index.js:10:5)".to_string()),
            component_stack: Some("\n    at Header\n    at App".to_string()),
            ..page_error("x is undefined")
        });
        event.release = Some("ila-studio@0.4.0".into());
        event.environment = Some("development".into());
        // whole seconds: the time is sent as a number of seconds, and comes back as exact only so
        event.timestamp = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        assert_eq!(scrub_event(event.clone()), Some(event));
    }

    #[test]
    fn nothing_is_sent_while_crash_reports_are_off() {
        let enabled = Arc::new(AtomicBool::new(false));
        let events = sentry::test::with_captured_events_options(
            || {
                sentry::capture_event(message("boom"));
                sentry::capture_message("another", Level::Error);
            },
            test_options(&enabled),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn an_event_is_scrubbed_and_sent_while_crash_reports_are_on() {
        let enabled = Arc::new(AtomicBool::new(true));
        let events = sentry::test::with_captured_events_options(
            || {
                sentry::capture_event(message(r"boom C:\Users\somebody\x at 192.0.2.44:3121"));
            },
            test_options(&enabled),
        );
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.message.as_deref(), Some(r"boom C:\Users\<user>\x at <ip>:3121"));
        // the contexts integration has put the name of this PC there; it does not leave
        assert_eq!(event.server_name, None);
        assert_eq!(event.user, None);
        assert_eq!(event.release.as_deref(), Some(concat!("ila-studio@", env!("CARGO_PKG_VERSION"))));
        let environment = if cfg!(debug_assertions) { "development" } else { "production" };
        assert_eq!(event.environment.as_deref(), Some(environment));
        assert!(event.breadcrumbs.is_empty());
        assert!(event.contexts.contains_key("os"), "the version of the system is part of a report");
    }

    #[test]
    fn the_switch_is_looked_at_for_every_event() {
        let enabled = Arc::new(AtomicBool::new(false));
        let events = sentry::test::with_captured_events_options(
            || {
                sentry::capture_event(message("before"));
                enabled.store(true, Ordering::Relaxed);
                sentry::capture_event(message("while on"));
                enabled.store(false, Ordering::Relaxed);
                sentry::capture_event(message("after"));
            },
            test_options(&enabled),
        );
        let messages: Vec<_> = events.iter().filter_map(|e| e.message.as_deref()).collect();
        assert_eq!(messages, ["while on"]);
    }

    /// What the button "Send this error report" hands over: an error while a window was drawn, with `once`.
    fn by_hand(text: &str) -> FrontendReport {
        FrontendReport { once: Some(true), source: ErrorSource::Render, ..page_error(text) }
    }

    #[test]
    fn a_report_asked_for_by_hand_is_sent_while_crash_reports_are_off() {
        let enabled = Arc::new(AtomicBool::new(false));
        let limiter = Mutex::default();
        let mut outcomes = Vec::new();
        let events = sentry::test::with_captured_events_options(
            || {
                let client = sentry::Hub::current().client().expect("a client");
                let send = |report: &FrontendReport| report_page_error(&client, &enabled, &limiter, report);
                outcomes.push(send(&page_error("not asked for")));
                // (an error of the kind the button sends: `once` counts for no other, see the next test)
                outcomes.push(send(&by_hand(r"asked for, C:\Users\somebody\x")));
                // the one report was let through, not the switch turned
                outcomes.push(send(&page_error("not asked for either")));
                sentry::capture_event(message("nor this"));
            },
            test_options(&enabled),
        );
        assert_eq!(outcomes, [Outcome::Off, Outcome::Sent, Outcome::Off]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].exception.values[0].value.as_deref(), Some(r"asked for, C:\Users\<user>\x"));
    }

    #[test]
    fn a_report_by_hand_is_what_the_button_sends_and_no_more() {
        let enabled = Arc::new(AtomicBool::new(false));
        let limiter = Mutex::default();
        let mut outcomes = Vec::new();
        let events = sentry::test::with_captured_events_options(
            || {
                let client = sentry::Hub::current().client().expect("a client");
                let send = |report: &FrontendReport| report_page_error(&client, &enabled, &limiter, report);
                // `once` on an error the button does not send: a script of the page calling by itself
                for source in [ErrorSource::Error, ErrorSource::UnhandledRejection] {
                    outcomes.push(send(&FrontendReport { once: Some(true), source, ..page_error("once, by a script") }));
                }
                // one for the error screen of each window, the same once - and that is all of a run
                outcomes.push(send(&by_hand("the main window")));
                outcomes.push(send(&by_hand("the main window")));
                outcomes.push(send(&by_hand("the analysis window")));
                outcomes.push(send(&by_hand("a third")));
                outcomes.push(send(&by_hand("a fourth")));
                outcomes.push(send(&by_hand("the main window")));
            },
            test_options(&enabled),
        );
        use Outcome::{Duplicate, Limit, Off, Sent};
        assert_eq!(outcomes, [Off, Off, Sent, Duplicate, Sent, Limit, Limit, Duplicate]);
        let sent: Vec<_> = events.iter().map(|e| e.exception.values[0].value.as_deref()).collect();
        assert_eq!(sent, [Some("the main window"), Some("the analysis window")]);

        // while crash reports are on, such an error is one like every other: sent, and not counted as by hand
        let enabled = Arc::new(AtomicBool::new(true));
        let limiter = Mutex::default();
        let events = sentry::test::with_captured_events_options(
            || {
                let client = sentry::Hub::current().client().expect("a client");
                let report = FrontendReport { once: Some(true), ..page_error("once, while on") };
                assert_eq!(report_page_error(&client, &enabled, &limiter, &report), Outcome::Sent);
            },
            test_options(&enabled),
        );
        assert_eq!((events.len(), lock(&limiter).by_hand), (1, 0));
    }

    // The scenario of the privacy review (finding 7): the pass was set for the thread, and whatever the thread
    // reported while it was set went through - a panic at that moment, with consent off.
    #[test]
    fn the_pass_of_a_report_by_hand_is_for_that_report_alone() {
        let enabled = Arc::new(AtomicBool::new(false));
        let events = sentry::test::with_captured_events_options(
            || {
                let asked_for = frontend_event(&by_hand("the one that was asked for"));
                let _asked = AskedFor::now(asked_for.event_id);
                // (printed by the panic hook of the test run as well: that is not a failure)
                let _ = std::panic::catch_unwind(|| panic!("a panic while the one report by hand is being made"));
                sentry::capture_event(message("nor any other event of this thread"));
                sentry::capture_event(asked_for);
            },
            test_options(&enabled),
        );
        let sent: Vec<_> = events.iter().map(|e| e.exception.values[0].value.as_deref()).collect();
        assert_eq!(sent, [Some("the one that was asked for")]);
        assert_eq!(ASKED_FOR.get(), None, "the pass ends with its guard");
    }

    #[test]
    fn the_sender_is_asked_again_before_a_report_leaves() {
        // (BY_HAND is of the whole program: no other test here opens a pass)
        let enabled = AtomicBool::new(false);
        assert!(!still_wanted(&enabled), "switched off while the report waited: it stays");
        {
            let _pass = SenderPass::open();
            assert!(still_wanted(&enabled), "the one report sent by hand goes although they are off");
        }
        assert!(!still_wanted(&enabled), "the pass ends with its guard");
        enabled.store(true, Ordering::Relaxed);
        assert!(still_wanted(&enabled));
    }

    #[test]
    fn told_says_what_became_of_a_report_sent_by_hand() {
        assert_eq!(told(Some(Answer::Status(200)), true), Ok(()));
        let why = |answer| told(answer, true).expect_err("not arrived");
        assert_eq!(why(Some(Answer::Status(403))), "The report server refused the report (HTTP 403).");
        assert!(why(Some(Answer::Status(429))).contains("HTTP 429"));
        assert_eq!(
            why(Some(Answer::Failed("io: timeout".to_string()))),
            "The report server could not be reached: io: timeout"
        );
        // withheld by the gate of the sender: the box was unticked while the report waited. That is not the
        // server's doing, and is not said to be.
        let withheld = why(Some(Answer::Withheld));
        assert_eq!(withheld, "The report was not sent: crash reports were switched off.");
        assert!(!withheld.contains("server"));
        assert!(why(None).contains("asked for a pause"));
        assert!(told(None, false).expect_err("not gone").contains("still busy"));
    }

    #[test]
    fn the_count_of_dropped_events_does_not_leave_with_the_next_one() {
        let enabled = Arc::new(AtomicBool::new(false));
        let envelopes = sentry::test::with_captured_envelopes_options(
            || {
                sentry::capture_event(message("dropped: reports were off"));
                enabled.store(true, Ordering::Relaxed);
                sentry::capture_event(message("sent"));
            },
            test_options(&enabled),
        );
        assert_eq!(envelopes.len(), 1);
        // this is what the SDK hands to the transport: the event, and the count of what was dropped before
        let kinds = |envelope: &sentry::Envelope| -> Vec<&'static str> {
            envelope
                .items()
                .map(|item| match item {
                    EnvelopeItem::Event(_) => "event",
                    EnvelopeItem::ClientReport(_) => "client report",
                    _ => "other",
                })
                .collect()
        };
        assert_eq!(kinds(&envelopes[0]), ["event", "client report"]);

        let leaves = events_only(envelopes[0].clone()).expect("the event is left");
        assert_eq!(kinds(&leaves), ["event"]);
        assert_eq!(leaves.event().and_then(|e| e.message.as_deref()), Some("sent"));

        // an envelope without an event does not leave at all
        let mut report_only = sentry::Envelope::new();
        for item in envelopes[0].items().filter(|item| !matches!(item, EnvelopeItem::Event(_))) {
            report_only.add_item(item.clone());
        }
        assert_eq!(report_only.items().count(), 1);
        assert_eq!(events_only(report_only), None);
    }

    #[test]
    fn a_panic_is_reported_with_its_place_only_while_crash_reports_are_on() {
        let enabled = Arc::new(AtomicBool::new(false));
        let events = sentry::test::with_captured_events_options(
            || {
                // (both are printed by the panic hook of the test run as well: that is not a failure)
                let _ = std::panic::catch_unwind(|| panic!("while off"));
                enabled.store(true, Ordering::Relaxed);
                let _ = std::panic::catch_unwind(|| panic!("{}", r"while on, in C:\Users\somebody\x"));
            },
            test_options(&enabled),
        );
        assert_eq!(events.len(), 1);
        let exception = &events[0].exception.values[0];
        assert_eq!(exception.ty, "panic");
        assert_eq!(exception.value.as_deref(), Some(r"while on, in C:\Users\<user>\x"));
        let place = events[0].extra["location"].as_str().expect("a place");
        assert!(place.contains("crash_reports.rs:"), "{place}");
    }

    #[test]
    fn limiter_reports_a_message_once_and_no_more_than_the_limit() {
        let mut limiter = Limiter::default();
        assert_eq!(limiter.admit("a"), Outcome::Sent);
        assert_eq!(limiter.admit("a"), Outcome::Duplicate);
        for i in 1..MAX_REPORTS {
            assert_eq!(limiter.admit(&format!("message {i}")), Outcome::Sent, "message {i}");
        }
        assert_eq!(limiter.admit("one too many"), Outcome::Limit);
        // what was reported is still known as that
        assert_eq!(limiter.admit("a"), Outcome::Duplicate);
        assert_eq!(limiter.admit("message 5"), Outcome::Duplicate);
    }

    #[test]
    fn page_errors_are_limited_for_a_run() {
        let enabled = Arc::new(AtomicBool::new(true));
        let limiter = Mutex::default();
        let mut outcomes = Vec::new();
        let events = sentry::test::with_captured_events_options(
            || {
                let client = sentry::Hub::current().client().expect("a client");
                for i in 0..MAX_REPORTS + 3 {
                    outcomes.push(report_page_error(&client, &enabled, &limiter, &page_error(&format!("error {i}"))));
                    outcomes.push(report_page_error(&client, &enabled, &limiter, &page_error(&format!("error {i}"))));
                }
                // asked for by hand: the limit holds for it as well
                outcomes.push(report_page_error(&client, &enabled, &limiter, &by_hand("asked for")));
            },
            test_options(&enabled),
        );
        assert_eq!(events.len(), MAX_REPORTS);
        assert_eq!(outcomes.iter().filter(|o| **o == Outcome::Sent).count(), MAX_REPORTS);
        assert_eq!(outcomes[..4], [Outcome::Sent, Outcome::Duplicate, Outcome::Sent, Outcome::Duplicate]);
        assert_eq!(outcomes[2 * MAX_REPORTS..], [Outcome::Limit; 7]);
    }

    #[test]
    fn parse_js_frame_reads_function_file_line_and_column() {
        let read = |line: &str| {
            parse_js_frame(line).map(|f| (f.function, f.filename, f.lineno, f.colno))
        };
        let frame = |function: Option<&str>, file: Option<&str>, line: Option<u64>, column: Option<u64>| {
            Some((function.map(str::to_string), file.map(str::to_string), line, column))
        };
        let url = "http://tauri.localhost/assets/index-Ab3.js";
        assert_eq!(read(&format!("    at render ({url}:10:5)")), frame(Some("render"), Some(url), Some(10), Some(5)));
        assert_eq!(read(&format!("    at {url}:40:12")), frame(None, Some(url), Some(40), Some(12)));
        assert_eq!(read(&format!("at new Plot ({url}:1:2)")), frame(Some("new Plot"), Some(url), Some(1), Some(2)));
        assert_eq!(read(&format!("at async Object.load ({url}:3:4)")), frame(Some("async Object.load"), Some(url), Some(3), Some(4)));
        // a Windows path has a colon of its own
        assert_eq!(read(r"at load (C:\work\app.js:7:9)"), frame(Some("load"), Some(r"C:\work\app.js"), Some(7), Some(9)));
        assert_eq!(read("at <anonymous>:1:1"), frame(None, Some("<anonymous>"), Some(1), Some(1)));
        // no position
        assert_eq!(read("at async Promise.all (index 0)"), frame(Some("async Promise.all"), None, None, None));
        assert_eq!(read("at Array.map (<anonymous>)"), frame(Some("Array.map"), None, None, None));
        // no frames
        for line in ["TypeError: x is undefined", "", "    at ", "at somewhere", "Error: at the end"] {
            assert_eq!(read(line), None, "{line:?}");
        }
    }

    #[test]
    fn parse_js_stack_skips_what_is_no_frame_and_stops_at_the_limit() {
        let stack = "Error: two\nlines of message\n    at inner (http://h/a.js:1:2)\n    at outer (http://h/a.js:3:4)\n";
        let functions: Vec<_> = parse_js_stack(stack).into_iter().map(|f| f.function).collect();
        assert_eq!(functions, [Some("inner".to_string()), Some("outer".to_string())]);
        assert!(parse_js_stack("").is_empty());
        assert!(parse_js_stack("just a text").is_empty());

        let deep: String = (0..MAX_FRAMES + 10).map(|i| format!("    at f{i} (http://h/a.js:{i}:1)\n")).collect();
        assert_eq!(parse_js_stack(&deep).len(), MAX_FRAMES);
    }

    #[test]
    fn js_error_type_is_the_name_the_stack_begins_with() {
        assert_eq!(js_error_type("TypeError: x is undefined\n    at a (b:1:2)"), Some("TypeError"));
        assert_eq!(js_error_type("Error: boom"), Some("Error"));
        assert_eq!(js_error_type("boom"), None);
        assert_eq!(js_error_type("could not read: the file is gone"), None);
        assert_eq!(js_error_type(": x"), None);
        assert_eq!(js_error_type(""), None);
    }

    #[test]
    fn frontend_event_is_an_exception_of_the_page() {
        let event = frontend_event(&FrontendReport {
            stack: Some("RangeError: too deep\n    at inner (http://h/a.js:1:2)\n    at outer (http://h/a.js:3:4)".to_string()),
            component_stack: Some("\n    at Plot\n    at App".to_string()),
            source: ErrorSource::Render,
            window: ReportWindow::Analysis,
            ..page_error("too deep")
        });
        assert_eq!(event.platform, "javascript");
        assert_eq!(event.level, Level::Error);
        assert_eq!((event.tags["source"].as_str(), event.tags["window"].as_str()), ("render", "analysis"));
        let exception = &event.exception.values[0];
        assert_eq!((exception.ty.as_str(), exception.value.as_deref()), ("RangeError", Some("too deep")));
        let mechanism = exception.mechanism.as_ref().expect("a mechanism");
        assert_eq!((mechanism.ty.as_str(), mechanism.handled), ("render", Some(false)));
        // the innermost frame last
        let frames = &exception.stacktrace.as_ref().expect("a stack").frames;
        let functions: Vec<_> = frames.iter().map(|f| f.function.as_deref()).collect();
        assert_eq!(functions, [Some("outer"), Some("inner")]);
        assert_eq!(event.extra["component_stack"], "at Plot\n    at App");
        assert!(!event.extra.contains_key("stack"), "the stack was read: it is not sent as text as well");
    }

    #[test]
    fn frontend_event_carries_a_stack_it_cannot_read_as_text() {
        let event = frontend_event(&FrontendReport {
            stack: Some("render@http://h/a.js:1:2".to_string()),
            source: ErrorSource::UnhandledRejection,
            ..page_error("rejected")
        });
        let exception = &event.exception.values[0];
        assert_eq!(exception.ty, "UnhandledRejection");
        assert_eq!(exception.stacktrace, None);
        assert_eq!(event.extra["stack"], "render@http://h/a.js:1:2");
        // nothing but the message
        let event = frontend_event(&page_error("plain"));
        assert_eq!(event.exception.values[0].ty, "Error");
        assert!(event.extra.is_empty());
    }

    #[test]
    fn a_report_of_the_page_is_read_as_the_page_writes_it() {
        let report: FrontendReport = serde_json::from_value(json!({
            "message": "boom",
            "stack": "Error: boom",
            "componentStack": "at App",
            "source": "unhandledrejection",
            "window": "analysis",
            "once": true,
        }))
        .expect("a report");
        assert_eq!(report.source, ErrorSource::UnhandledRejection);
        assert_eq!(report.window, ReportWindow::Analysis);
        assert_eq!((report.component_stack.as_deref(), report.once), (Some("at App"), Some(true)));
        // the short form, and what the page must not make up
        let short = serde_json::from_value::<FrontendReport>(json!({ "message": "m", "source": "error", "window": "main" }));
        assert!(short.is_ok());
        let odd = serde_json::from_value::<FrontendReport>(json!({ "message": "m", "source": "log", "window": "main" }));
        assert!(odd.is_err());
        assert_eq!(serde_json::to_value(Outcome::Duplicate).expect("JSON"), json!("duplicate"));
    }
}
