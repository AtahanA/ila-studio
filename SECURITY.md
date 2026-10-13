# Security policy

## Supported versions

Only the latest 0.x release gets fixes.

## Reporting a vulnerability

Please report a vulnerability in private, not in a public issue. On the GitHub page of the repository open
**Security**, then **Report a vulnerability**, or go straight to
<https://github.com/AtahanA/ila-studio/security/advisories/new>.

Say which version you used, what you did and what happened. Take user names, paths, IP addresses and signal
names of your design out of everything you send. The project is looked after by one person, so an answer can
take some days.

## What is trusted, and what is not

ILA Studio starts other programs and talks to hardware. This section says what it treats as code and what as
data, so that you can tell a vulnerability from behaviour that is meant.

### Profiles and Tcl scripts are code

This is by design, and reports about it are not vulnerabilities:

- A profile names the programs that are started (`tools.vivado`, and for the hook mode `tools.xsct`,
  `tools.nm`, `tools.objdump`) and may name a Tcl script that Vivado runs (`tools.tcl_script`). The selected
  profile is used with every hardware job.
- The field "Vivado Tcl Script (.tcl)" and the option `--tcl` name a script that Vivado runs.
- The bundled script `scripts\vivado_ila_repl.tcl` carries out the commands that the Python driver sends it.
  That is how the two work together.
- `capture.out` of a profile decides where capture files are written.
- At start the application checks whether the probe file of every profile in `profiles\` exists. A profile
  whose `hardware.ltx` is a network path makes Windows contact that server.

**Only use a profile or a Tcl script that you would also run as a program,** and read one that somebody else
wrote before you use it.

### Data must never run

These are data. If one of them can make the program run code, or read or write a file it was not pointed at,
that is a vulnerability and in scope:

- probe files (`.ltx`) and capture files (`.csv`, `.csv.gz`, `.ila`);
- what is typed into the GUI: the hw_server address, the device filter, a trigger, a capture name, the name of
  a profile;
- in a profile: the address, paths, filters, the trigger, `capture.radix`, `capture.capture_mode`,
  `capture.format`, `capture.position` and `capture.timeout_min`.

Known gaps:

- The hook mode hands `hardware.core_filter` to xsct through `cmd /c` as it is written.

A capture file is read a piece at a time, and one that holds more than 2 GB of text is refused (for a `.csv.gz`
or a `.ila`: the text it unpacks to). A probe file is read whole, and only up to 64 MB.

### Network

- ILA Studio opens connections to the hw_server you name. It checks that the address answers; then Vivado
  connects to it and, in hook mode, xsct.
- It connects to one other place, and only when both of these hold: **you have switched crash reports on**
  (the bug button in the header; they are off by default), and the program has a report address (a build from
  source has none, unless `ILA_SENTRY_DSN` was set while it was built or is set when it is started). Then an
  error of the program is sent to that Sentry server. While crash reports are off, nothing is sent to it and
  no connection to it is made, not at start-up either (for the moment they are switched off, see the next
  point). The one exception is yours to make: in a program that has a report address, the error screen of a
  window has a button **Send this error report**, which sends that one error. The backend cannot tell a
  press of that button from a call by the page: it takes such a report only for an error screen, and twice
  in a run.
- Switching off holds from that moment: no error is reported, and a report that still waited to be sent is
  dropped at the last step before the network. A report whose transfer had already begun is completed (it is
  given up after 15 seconds); every report has a connection of its own, which is closed with the server's
  answer, so none stays open. A second copy of the program that runs at the same time is switched off as well,
  when it notices the change: at the latest when its window next gets the focus.
- A report holds the error text and where in the program it happened, the time, the versions of the program
  and of Windows, the processor architecture and the Rust version of the build. It holds no captures, profiles,
  logs, probe files or settings as such, and not the name of the PC as the reporting library would add it (a
  name inside an error text stays, see below). The names of user folders, the server of a network path and
  IPv4 addresses are taken out of its texts, where they stand in their usual notation. **Other names are not
  recognised and are sent as they stand in the error text**: a probe name, a file or folder name, a host
  called by its name, a user name that stands alone. The
  [README](README.md#crash-reports-optional-off-by-default) lists what a report holds, which notations are
  recognised, and which are known not to be.
- `ILA_SENTRY_DSN`, set in the environment the program is started from, replaces the report address with the
  one it names: for a Sentry of your own. Set to a text that is no address (`ILA_SENTRY_DSN=off`), it takes the
  report address away, and crash reports cannot be switched on. Whoever can set that variable decides where
  reports go, but not that they go: the choice is remembered together with the server it was made for. If the
  program is later started with another report address - a different `ILA_SENTRY_DSN`, or none any more -
  crash reports are off again until you tick the box. The panel behind the bug button shows the server.
- To an address that begins with `https://`, reports are sent by the backend with the TLS of Windows, checked
  against the certificates Windows trusts. An `ILA_SENTRY_DSN` that begins with `http://` is accepted, and
  reports to it are sent **without encryption**; the panel says so, unless the address is on this PC. A proxy
  named in `ALL_PROXY`, `HTTPS_PROXY` or `HTTP_PROXY` is used if there is one; the proxy of the Windows
  settings is not. The receiving server sees the IP address a report comes from, as any server does, and may
  store it.
- There is no other telemetry and no update check, and the page cannot load anything from the network or send
  anything itself. What Vivado itself sends, and what the WebView2 runtime of Windows sends, is not in the hands of this project.
- The hw_server protocol is the one Vivado uses: plain TCP, with no authentication and no encryption. Whoever
  can reach that port can drive the JTAG chain, with or without this tool. Use it on networks you trust.

### Hardware

- The device is never programmed. The JTAG clock of the cable is changed when needed and put back when the
  session ends. A session that is killed cannot put it back; the next connect repairs that.
- Hook mode halts and resumes a CPU on the board, and with `--plant` sets a breakpoint. Use it only where a
  halted CPU does no harm.

### Files on your PC

- `ila_log.txt`, the `session.log` of each capture folder and the saved profiles hold local paths, the
  hw_server address, device and cable names and probe names. Read them before you attach them to an issue.
- The page remembers its last settings (among them the path of the probe file and the hw_server address, and
  whether crash reports are switched on, with the address of the report server they were switched on for,
  without its key) in the WebView storage of the application under `%LOCALAPPDATA%`.
- Short-lived helper files are written to `%TEMP%`: a stop flag for a running job, and a small script for the
  cable repair.
- The executable runs the `ila_bridge.py` it finds in its own folder. If there is none, it looks in the four
  folders above it, then in the working directory and the folder above that. Keep the program in a folder that only you can write to.

### Releases

Release executables are not signed, so Windows may warn when one is started. Compare the SHA-256 sum that is
published with a release, or build from source.

## Known limitations

- Windows only.
- The characters `&`, `%` and quotes in the path of the program folder or of a tool are not supported: the
  tools are started through `cmd /c`. Paths with spaces or non-ASCII characters are untested.
