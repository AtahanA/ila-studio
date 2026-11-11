<div align="center">

<img src="docs/images/icon.png" alt="" width="112" height="112">

# ILA Studio

Capture and analysis GUI for Vivado ILA (Integrated Logic Analyzer) cores

[![CI][badge-ci]][ci]
[![Latest release][badge-release]][releases]
[![Licence: GPL-3.0-or-later][badge-licence]](LICENSE)
[![Platform: Windows][badge-platform]](#requirements)

[![Vivado: tested with 2017.4][badge-vivado]](#status)
[![Python 3.8 or newer][badge-python]](#requirements)
[![Tauri 2][badge-tauri]][tauri]
[![React 19][badge-react]][react]
[![Rust 1.90 or newer][badge-rust]](#requirements)

[Quick start](#quick-start-without-hardware) &middot;
[First capture](#first-capture-with-hardware) &middot;
[User guide](docs/user-guide.md) &middot;
[Troubleshooting](#troubleshooting) &middot;
[Changelog](CHANGELOG.md)

</div>

ILA Studio is a Windows desktop application for FPGA engineers who debug with the ILA (Integrated Logic
Analyzer) cores of AMD Vivado (formerly Xilinx). It reads the probe file of a design, sets a trigger, takes
single or continuous captures over JTAG, and shows each capture at once in a waveform viewer and in a signal
analysis view with plots, cursors, measurements and spectra. It drives a separately installed Vivado in the
background and needs Python 3; captures are ordinary `.csv` / `.ila` files on disk.

![Signal Analysis showing the demo capture: three buses plotted over the sample axis, with the trigger marked](docs/images/signal-analysis.png)

## Status

- Version 0.4.0, the first public release.
- Developed and tested with **Vivado 2017.4**, a **Zynq-7000** device and a **SmartLynq** cable through a remote
  hw_server, on Windows. Other Vivado versions, device families and cables are untested; two differences are
  known and listed under [Known limitations](#known-limitations). Reports are welcome, good or bad.
- Windows only for now, and tried by hand only on Windows 11, with Python 3.12 and 3.13. Windows 10 is meant to
  work, but nobody has run the application there yet. Python 3.8, the oldest that is accepted, has only the
  automated tests behind it: they pass on 3.8 and 3.13 (run for every pull request, with a recorder in place
  of Vivado), but the application has not been started with a 3.8 interpreter. A report from Windows 10 or
  with Python 3.8 is welcome, good or bad.
- The interface can be tried without any hardware: see [Quick start](#quick-start-without-hardware).

## Not an AMD product

ILA Studio is an independent open-source project. It is not affiliated with, endorsed by or supported by
Advanced Micro Devices, Inc. AMD, Xilinx, Vivado, Vitis, Zynq, MicroBlaze and SmartLynq are trademarks of Advanced Micro Devices,
Inc. and/or its subsidiaries, used here only to describe the tools and hardware this software works with. This
project contains no AMD software: a separately installed and licensed Vivado or Vivado Lab Edition is required
for hardware work.

## Features

- Reads a Vivado probe file (`.ltx`) directly: ILA cores, signal names and widths, without starting Vivado.
  [More](docs/user-guide.md#probe-file-hw_server-and-jtag)
- Three capture modes: at once, on a trigger rule built with a few clicks, or window after window until
  stopped. [More](docs/user-guide.md#trigger-and-capture-modes)
- Keeps the Vivado session open between captures, so only the first one waits for Vivado to start. Two Vivado
  processes can take turns in a continuous capture. [More](docs/user-guide.md#the-hardware-session)
- Sets the JTAG clock by the debug hub clock of the design, and repairs a cable that Vivado can no longer
  connect to ("bad enum default").
- Designs with several ILA cores; a number format (unsigned, signed, hex) for each bus in the CSV.
  [More](docs/user-guide.md#the-probe-list)
- Waveform viewer for logic traces and buses, with zoom, pan and a trigger marker.
  [More](docs/user-guide.md#waveform-viewer)
- Signal Analysis: stacked plots, time and value cursors, measurements, phase and delay between signals, FFT,
  comparison of up to eight captures, a pop-out window. [More](docs/user-guide.md#signal-analysis)
- Profiles: save the whole set-up under a name and get it back. [More](docs/user-guide.md#profiles-and-save)
- A command line for unattended work: repeated captures, continuous recording, captures timed by the
  firmware of the board (hook mode), statistics. [More](docs/user-guide.md#command-line)

## Requirements

To run:

- Windows 10 or 11, with the Microsoft Edge WebView2 Runtime (part of Windows 11; install it from Microsoft on
  a Windows 10 PC that lacks it). Windows 10 has not been tried yet: see [Status](#status).
- **Python 3.8 or newer.** Only the standard library is used; there is nothing to `pip install`. The
  application looks for it in this order: the path in the environment variable `ILA_PYTHON`, then `PATH`, then
  `py -3`. A Python of MSYS2 (a MinGW build) or of Cygwin is passed over on the way and only taken when there
  is no other, unless `ILA_PYTHON` names it. Each start writes the interpreter in use into `ila_log.txt`.
  Python 3.8 has run the automated tests only: see [Status](#status).
- For hardware work: **Vivado or Vivado Lab Edition**, and a running hw_server that the JTAG cable is attached
  to. Vivado is looked for in this order: `tools.vivado` of the selected profile (without one:
  `C:\Xilinx\Vivado\2017.4\bin\vivado.bat`); `vivado` / `vivado_lab` on `PATH`; the folder in `XILINX_VIVADO`,
  and `Xilinx\Vivado\<version>` or `Xilinx\Vivado_Lab\<version>` on `C:`, `D:` or `E:` - also in the order of
  newer installers, `Xilinx\<version>\Vivado` or `AMDDesignTools\<version>\Vivado` - of which the highest
  version is taken.
- Only for the hook mode of the command line: `xsct` and the GNU `nm` / `objdump` of the target CPU, from
  Vitis or the Xilinx SDK.

To build:

- Node.js 20.19+, 22.13+ or 24+ (the `engines` of `package.json`: what Vite, ESLint and Vitest all accept).
- Rust 1.90 or newer (the `rust-version` of `src-tauri/Cargo.toml`) with the MSVC build tools; see the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Quick start without hardware

From a release: download `ila-studio-<version>-windows-x64.zip` from the
[Releases page](https://github.com/AtahanA/ila-studio/releases), unpack it into a folder you can write to, and
start `ila-studio.exe` in the folder `ila-studio-<version>-windows-x64` that it holds. The executable is not
signed, so Windows may warn when it is started: see [SECURITY.md](SECURITY.md#releases).

From the source:

```powershell
git clone https://github.com/AtahanA/ila-studio.git
cd ila-studio
npm ci
npm run tauri dev
```

The first start from the source compiles a few hundred Rust crates and takes several minutes; later starts are
much faster. When the window is up, click **Demo Data** (top right) and open the tab **Signal Analysis**. The
demo needs Python, not Vivado.

![The capture page after Demo Data: hardware settings and capture modes on the left, the probe list on the right](docs/images/capture-page.png)

## First capture with hardware

1. Make sure hw_server runs where the JTAG cable is attached, and that the bitstream with the ILA is loaded.
2. Under **Vivado Probe File (.ltx)** click **Browse** and pick the probe file of that bitstream. The probes
   appear in the list on the right. Both forms in which Vivado writes the file are read: XML, and the JSON of
   newer versions. If the status line says `Failed to parse LTX` instead, the file is not a probe file (see
   [Troubleshooting](#troubleshooting)).
3. Enter the address under **hw_server URL**: `127.0.0.1:3121` for this PC, otherwise `<host>:3121`. Leave
   **Device Filter** at `*` and **JTAG Clock (TCK)** at `Auto`.
4. Click **Connect** (bottom right). Vivado starts, which takes tens of seconds, and the cores, their depth
   and the probes are read from the device.
5. Choose a mode and press the capture button: **Just Capture** captures at once. For **Capture on Rule**
   click **Set Trigger** on a probe, choose the edge or value, then **Arm & Capture on Trigger**. **Constant
   Capture** runs until **Stop Capture**.
6. The capture appears in the viewer and in **Signal Analysis**, and as a file under `captures\`.
7. **Disconnect** closes Vivado and gives the cable its JTAG clock back. Closing the window does the same.

The [user guide](docs/user-guide.md) describes every control.

## Building the portable folder

```powershell
.\make_distribute.ps1               # release build, then copy everything into distribute\
.\make_distribute.ps1 -NoBuild      # copy only: the Python / Tcl side changed, the executable did not
.\make_distribute.ps1 -AllProfiles  # also copy your own profiles (for a folder that stays on your PC)
```

The build needs the tools listed under Requirements and `npm ci`. `distribute\` then holds `ila-studio.exe`,
`ila_bridge.py`, `ila_capture.py`, `xsct_repl.tcl`, `scripts\vivado_ila_repl.tcl`, `profiles\example-*.json`,
the licence, this file and the documents it links to (`docs\`, `SECURITY.md`, `CONTRIBUTING.md`,
`CHANGELOG.md`). Copy the whole folder to the PC that needs it and start `ila-studio.exe`. The executable must
stay next to the Python scripts, and the folder must be writable, because captures, profiles and the log are
written into it.

There is no installer: the executable drives the Python and Tcl scripts next to it and writes its data
beside them, which an installer does not provide for.

`.\run_gui.ps1` starts `distribute\ila-studio.exe` if it exists, else a local release build, else
`npm run tauri dev`. If PowerShell refuses to run scripts:
`powershell -ExecutionPolicy Bypass -File .\run_gui.ps1`. A release build runs only the scripts of its own
folder. The local one in `src-tauri\target\release` has none beside it: the script names their folder in the
environment variable `ILA_HOME`, and so must you (the full path of the folder with `ila_bridge.py`) to start
that executable yourself.

## Where data is written

Everything is written next to `ila_bridge.py`: in the repository in a development build, in the portable
folder when the program runs from one (`ila-studio-<version>-windows-x64\` unpacked from a release, or
`distribute\`).

| What | Where |
|---|---|
| Captures | `captures\<date>_<time>_unit\` with `index.csv` and `session.log` (another folder if the selected profile sets `capture.out`) |
| Saved profiles | `profiles\<name>.json`, with `.json.orig` / `.json.bak` copies of what was there before |
| Log of all hardware jobs, and of the Python each start found (one line) | `ila_log.txt` |

All of this is ignored by git; only the two shipped example profiles are tracked. The logs and the saved profiles
contain local paths, the hw_server address and probe names: **read them before you share them.** The page also
remembers its last settings in the WebView storage of the application under `%LOCALAPPDATA%`.

## Crash reports (optional, off by default)

ILA Studio can report its own errors to its developers through [Sentry](https://sentry.io), an error-collecting
service. **Nothing is sent unless you switch this on.** The bug button in the header of the main window opens a
panel with the box **Send crash reports**; the choice is remembered on this PC, together with the server it was
made for, and is taken back in the same place.

Unticking the box holds from that moment: no error is reported any more, and a report that was still waiting
to be sent is not sent. Only a report whose transfer had already begun is completed; it is given up after 15
seconds. The pop-out window follows at once. Another copy of the program that runs at the same time follows
when it notices the change, at the latest when its window next gets the focus.

While it is on, a report is sent when the program runs into an error: an error of the page that nothing caught,
an error while a window is drawn, or a crash (panic) of the backend. A report contains:

- the error text, the kind of error, and where in the program it happened. For an error of the page that is
  the stack: function names, the paths of the program's own files and line numbers (for an error while a
  window is drawn, also the components that were being drawn; for an error that names its cause, the text and
  the stack of the cause as well). For a crash of the backend it is the source file, line and column of the
  crash. A release is built without the names a stack is made of: its stack, which would name no place in
  the program and be a row of addresses in its code, is left out. A development build (`npm run tauri dev`)
  has them, and adds function names, source paths, line numbers and those addresses;
- the time, a random id, the version of ILA Studio and whether it is a release or a development build, the
  version of Windows, the processor architecture (`x86_64`), the Rust version the program was built with, the
  name and version of the reporting library, and which window it was (main or analysis);
- a few fixed technical labels (the platform, the severity, how the error was caught, the parts of the
  reporting library in use), and for a crash of the backend two more random ids.

The request that carries a report also names the HTTP library, the public key of the report address and the
time the program was started. That time is the same in every report of a run: it tells the receiver which
reports belong together and how long the program had been running.

It never contains captures, profiles, `ila_log.txt`, the probe file or your settings as such, nor what you did
before the error. A single value of them can be part of an error text: the path of the probe file, the
hw_server address. The name of the PC, which the reporting library would add, is removed.

Before a report leaves, these are taken out of every text in it:

- the name of a user folder, which is the folder below `Users` or `home`: `C:\Users\<name>\...`,
  `/home/<name>/...`, also on a share (`\\server\home$\<name>\...`);
- the server of a network path: `\\server\share\...`, `//server/share/...`, `\\?\UNC\server\share\...`,
  `file://server/share/...`;
- the names of this PC and of its user, as Windows gives them when the program starts (`%COMPUTERNAME%` and
  the host name; `%USERNAME%` and the name of the folder `%USERPROFILE%`), wherever one stands as a word of
  its own: `D:\Profiles\<name>\...`, "access denied for <name>", `<pc>:3121`, also as a URL writes it
  (`C%3A%5CUsers%5C<name>`). The letters A to Z are found in either case; a name with other letters is found
  as Windows writes it, with all its letters small and with all of them capital. The words every report is
  made of are not searched for them - the names of its fields and of its parts, the platform, the severity,
  the version of ILA Studio, whether it is a release or a development build, the reporting library and what
  it has in use - so a PC called `STUDIO` leaves `ila-studio` as it is. The kind of an error, how it was
  caught and the window are searched as a text is: on a PC called `MAIN`, the report says `<host>` for the
  main window;
- IPv4 addresses (a port behind one stays);
- IPv6 addresses, in brackets (`[2001:db8::10]:3121`: the port stays, as does a zone such as `%eth0`) and
  standing free (`2001:db8::10`, `fe80::1`). Written behind a free address, a port stays if the address has
  all its eight groups; behind a shortened one it is taken for one more group of the address, where it can
  be one, and goes with it.

A text is cut after 2,000 characters. **Nothing else is recognised.** Sent as they stand in an error text:

- the name of a probe, of a file or of a folder - whatever the failing step was working with;
- another host that is called by its name, also in a URL (`http://host/...`), and the name of a Windows
  domain; a server named without a share (`\\server`), or in a path written directly behind a word, with no
  space or quote between (`-o\\server\share`);
- the name of another user or of another PC that stands alone, and the folder of another user that is not
  below `Users` or `home` (`D:\Profiles\<name>`);
- the name of this PC or of its user where it is shorter than four characters (a user called `lab` would be
  taken out of every other sentence), where a letter or a digit stands directly in front of it or behind it
  (`<name>2`), and where only a part of it stands there (one word of a name of two);
- a path in another notation, such as URL-encoded (`C%3A%5CUsers%5C<name>`): the name in it goes only if it
  is that of the user of this PC;
- an IPv4 address that reads as a part of a version number: inside a longer row of numbers (`1.2.3.4.5`, so
  also an address with a port below 256 written behind a dot) or behind a `v` (`v1.2.3.4`);
- an IPv6 address that reads as something else. Without brackets, a shortened one whose groups all begin
  with a letter and that has no single colon (`fe80::a`) is written like a name in the program's own stack
  (`core::fmt`), and stays. So does one that stands in a row of numbers (`1.2.3.4.5::1`), directly in front
  of a letter or a `_`, or in the square brackets of an index (`x[::1]`). Directly behind a letter or a
  `_`, what stands up to the first single colon is taken for a part of that word: `srv2001:db8::10` becomes
  `srv2001:<ip>`, and `srvfe80::1` stays;
- an IPv6 address or a name of this PC directly in front of `:\\`, if it ends in a single letter (that reads
  as the letter of a drive), or in the word `file` with three backslashes behind the colon.

That is why crash reports are off by default. Leave them off where such names must not leave the building.

- **Where reports go.** The panel names the server. A build from source has no report address and cannot send
  ("This build has no address to send reports to."), unless the environment variable `ILA_SENTRY_DSN` held one
  while the program was built, or names one when it is started.
- **A Sentry of your own.** Set `ILA_SENTRY_DSN` to the DSN of your Sentry project before you start the program:
  reports then go there, and nowhere else. Set to a text that is no DSN (`ILA_SENTRY_DSN=off`), it leaves the
  program without a report address: crash reports cannot be switched on at all. An address that begins with
  `http://` is accepted, for a Sentry inside your own network: reports to it are **not encrypted**, and the
  panel says so (unless the address is on this PC).
- **The choice belongs to the server.** It is remembered together with the address it was made for: scheme,
  host, port and project. If the program is later started with another report address - a different
  `ILA_SENTRY_DSN`, or none any more - crash reports are off, the remembered choice is dropped, and they stay
  off until you tick the box again. One choice is remembered for each Windows user: of two copies of the
  program that run with different report addresses, only one can have the box ticked.
- **One report by hand.** While crash reports are off, the error screen of a window ("ILA Studio ran into an
  error and cannot show this window.") offers **Send this error report**, which sends that one error. A run
  of the program sends two such reports at most. A build without a report address has no such button.
- **Send a test report** in the panel sends one report that says only "ILA Studio test report", and shows the id
  it has on the server, or why it did not arrive.

Like any server, the one that receives a report sees the IP address it comes from, and a Sentry server may
store it with the report. A report is sent by the backend of the program, not by its page, on a connection of
its own that is closed with the answer of the server. To an address that begins with `https://` it is sent
with the TLS of Windows and the certificates Windows trusts. A proxy named in `ALL_PROXY`, `HTTPS_PROXY` or
`HTTP_PROXY` is used; the proxy of the Windows settings is not, so on a network that reaches the internet only
through that one, reports do not arrive.

## Profiles

A profile is a JSON file with the set-up of one board: hw_server, probe file, trigger, capture settings. The
**Save** button writes one; the Profile list applies one. Two examples are in [`profiles/`](profiles/). All
keys are described in [docs/profile-schema.md](docs/profile-schema.md).

## Command line

`ila_capture.py` works without the GUI. Its commands are `check`, `info`, `capture`, `watch`, `hook`,
`convert`, `stats` and `summary`; options such as `--profile` stand before or after the command.

```powershell
python ila_capture.py --help
python ila_capture.py --profile profiles\example-basic.json check
python ila_bridge.py demo-capture
python ila_capture.py stats captures\demo_ila_*.csv
python ila_capture.py summary captures
```

See the [command line section](docs/user-guide.md#command-line) of the user guide.

## How it is put together

```
GUI (React)  --invoke-->  Rust (async commands, never on the UI thread)
                              |  spawns, reads line by line
                              v
                         ila_bridge.py  --drives-->  ila_capture.py Session
                                                          |  stdin/stdout REPL
                                                          v
                                               vivado -mode tcl  scripts/vivado_ila_repl.tcl
```

- The GUI is a Tauri v2 application: a React 19 / TypeScript page in a WebView and a small Rust backend.
- All hardware work is done by Python (`ila_bridge.py`, `ila_capture.py`), which keeps one Vivado in Tcl mode
  running and sends it one command for each line.
- Only the ILA is touched: the device is never programmed. Stop and closing the window end a job in order, so
  that Vivado exits and the cable gets its JTAG clock back.
  [More](docs/user-guide.md#how-it-is-put-together)

## Troubleshooting

| What you see | Cause | What the tool does / what to do |
|---|---|---|
| `Python 3 was not found. Install Python 3.8 or newer, or set the ILA_PYTHON environment variable to the full path of python.exe.` | No Python 3.8+ on `PATH`. At start it shows as "Could not read the profiles: ...". | Install Python; the next action looks for it again. If it is still not found, restart the application: a running program does not see a `PATH` that an installer has changed. Or set `ILA_PYTHON` before starting the application. |
| `Vivado not found (tools.vivado is ...)` | Vivado is in none of the places that are searched. | Any one of these: put Vivado's `bin` folder on `PATH`; set `XILINX_VIVADO` to the installation folder; install under `Xilinx\Vivado` on `C:`, `D:` or `E:`; write the full path of `vivado.bat` as `tools.vivado` into a profile. |
| `Failed to parse LTX: ...` | The file is not a probe file as Vivado writes one: neither the XML form nor the JSON form (which begins with `{ "ltx_root"`). What follows the colon says where reading it ended - or that the file is larger than 64 MB, the most a probe file is read up to. | Pick the `.ltx` that the implementation run wrote for the bitstream on the board. |
| `the probe file does not name the debug hub clock, so TCK (...) was not limited to hub clock / 2.5`, in the message of a connect or a capture | With the JTAG clock on `Auto`: the probe file has no entry for the clock of the debug hub, so there was nothing to hold the cable's own frequency against. | Nothing, while the captures work. If the core stays IDLE, choose a JTAG clock at or below hub clock / 2.5 yourself. |
| `ila_bridge.py was not found in ...` | The executable is not in the folder of the scripts: it was copied without them, or it is a local release build that was started directly. A release build does not look in other folders. | Keep `ila-studio.exe` in its folder with the scripts: the one unpacked from the release archive, or the one that `make_distribute.ps1` made. Start a local release build with `run_gui.ps1`, or set `ILA_HOME` to the full path of the folder with the scripts. |
| `hw_server at ... is not reachable` | Wrong address, network, cable off. | Checked in 3 s before Vivado is started. Check the address and the cable. |
| `[Common 17-70] Application Exception: bad enum default`, then no hardware targets | The cable runs at a TCK frequency Vivado cannot represent (a SmartLynq asked for 6 MHz reports 6034482 Hz), left behind by an earlier session while another client (e.g. an SDK debug session) kept the cable open. | Detected and repaired automatically (xsdb puts the cable back to 10 MHz, then the connect is retried). On a hw_server with several cables, every cable that runs at such a frequency is put back; where the selected profile names a cable with `hardware.target_filter`, only that one is. A cable that was left alone is named in the log (`TCK_LEFT`), and in the message when the connect still fails: it may then be the one in the way. Every session also restores the cable's frequency when it ends. Seen in ANOTHER Vivado while ILA Studio is connected: click Disconnect here first. |
| `the ILA core does not run: it is still IDLE after being armed` | TCK too fast for the debug hub clock, or the ILA clock is stopped. In a session that has been open for a while: another program has changed the cable's JTAG clock. | Use `Auto` (or a frequency at or below hub clock / 2.5). Where the message says that the probe file does not name the hub clock, `Auto` has nothing to go by: choose the frequency yourself. A kept session reconnects by itself and tries the capture once more; otherwise Disconnect and Connect. |
| `no ILA core found on ...: Vivado sees the device but no debug hub in it` | The FPGA is not configured yet (right after power-up), its debug hub clock is not running, or the bitstream has no ILA / the `.ltx` belongs to another build. | Wait for the board to boot, load the matching bitstream / pick the matching `.ltx`. |
| `the JTAG chain is empty` | The cable answers but sees no device. | Power the board. |
| `probe X is not a probe of the selected ILA core (...): it belongs to core N ...` | The trigger names a probe of another ILA core of the design. | Select that core (chips under "Detected ILA Cores"), or choose a trigger probe of the selected core. |
| `The Tcl script ... is older than this program` | The program was updated without its `scripts` folder, or the "Vivado Tcl Script" field names a copy from an earlier release. | Update the whole folder, and clear the Tcl script field: an empty field uses the bundled script, whatever the selected profile names. |
| `not triggered within N min` | The trigger condition did not occur. | Raise the timeout or check the condition with a `Just Capture`. |

## Known limitations

- Windows only. The code has paths for Linux, but they have never been run.
- Tested with one Vivado version, one device family and one kind of cable (see [Status](#status)).
- A probe file in the JSON form that newer Vivado versions write (it begins with `{ "ltx_root"`) is read as
  the JSON probe files of AMD's public chipscopy examples are laid out: no such file written by a Vivado of
  our own, and no board with such a design, was at hand to try it with. If **Browse** / **Parse File** show
  no probes or wrong ones for your file, **Connect** still lists the cores and probes of the device. If the
  message of **Connect** says `the probe file does not name the debug hub clock`, `Auto` has not lowered
  the JTAG clock: if the core then stays IDLE, choose a frequency at or below hub clock / 2.5 yourself.
- The search for a Vivado in the folder order of newer installers (`Xilinx\<version>\Vivado`) is written from
  the layout of such an installation and has not been run against one.
- The last changes before this release (how addresses, paths and triggers are written into the Tcl commands
  for Vivado; that hook mode takes away a breakpoint it planted before the run ends; that the repair of
  `bad enum default` keeps to the cable that `hardware.target_filter` names, where it names one) were checked
  against a Tcl interpreter and stand-ins for the tools, and by the tests, not yet against Vivado, xsct or xsdb
  themselves.
- Untested: a program folder or a user profile whose path has spaces or non-ASCII characters. That Vivado and
  xsct are started correctly from a path with spaces or `&` - of the program folder, of a tool or of a Tcl
  script - was checked with stand-ins for the tools, not yet with the tools themselves. Not supported: `%` in
  such a path (a hardware job is then refused with a message that says so) and `^`. The automatic repair of
  `bad enum default` cannot start xsdb when the path of the folder Vivado is installed in holds `&` (or, with
  no space in it, one of `( ) , ; =`): the message of the connect then gives the xsdb commands that put the
  cable back by hand.
- A profile and a custom Tcl script are run as code: use only those you trust. See [SECURITY.md](SECURITY.md).
- No installer, and the executables are not signed.
- Hook mode exists on the command line only.

## Contributing, security, changes

[CONTRIBUTING.md](CONTRIBUTING.md) says how to report a problem, how to build and which checks to run.
[SECURITY.md](SECURITY.md) says what is trusted and how to report a vulnerability in private.
[CHANGELOG.md](CHANGELOG.md) lists what changed in each version.

## Licence

Copyright (C) 2026 Atahan Aggunlu

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3 of the License, or (at your
option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License
for more details. The full text is in [LICENSE](LICENSE) (SPDX: `GPL-3.0-or-later`).

In plain words: you are free to use, study, change and share this software. Whoever passes it on, changed or
unchanged, as source or as a built program, must do so under the same licence and make the corresponding
source available. The software comes without warranty, and it drives
live hardware: it changes the JTAG clock of a cable and, in hook mode, halts and resumes a CPU. You use it at
your own risk.

## Third-party software

ILA Studio is built with [Tauri](https://tauri.app), [React](https://react.dev), [Vite](https://vite.dev),
[Lucide](https://lucide.dev) icons and, for the crash reports, the
[Sentry SDK for Rust](https://github.com/getsentry/sentry-rust). Their licences, and those of the libraries they
bring along, apply to binary distributions: every release archive holds `THIRD-PARTY-NOTICES.md`, which lists
them with their licence texts (of Microsoft's WebView2 loader, which is linked into the executable, it gives
only where that licence is found). `python tools/third_party_notices.py` writes that file; see the release
checklist in [CONTRIBUTING.md](CONTRIBUTING.md#release-checklist).

<!-- The badges at the top of this page. CI and the release are read from GitHub. The others are fixed texts
     that repeat what Status and Requirements say: change them together. -->
[badge-ci]: https://img.shields.io/github/actions/workflow/status/AtahanA/ila-studio/ci.yml?branch=main&label=CI&logo=github&logoColor=white
[badge-release]: https://img.shields.io/github/v/release/AtahanA/ila-studio?label=release
[badge-licence]: https://img.shields.io/badge/licence-GPL--3.0--or--later-blue
[badge-platform]: https://img.shields.io/badge/platform-Windows-0078D4
[badge-vivado]: https://img.shields.io/badge/Vivado-tested%20with%202017.4-6E40C9
[badge-python]: https://img.shields.io/badge/Python-3.8%2B-3776AB?logo=python&logoColor=white
[badge-tauri]: https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white
[badge-react]: https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white
[badge-rust]: https://img.shields.io/badge/Rust-1.90%2B-CE422B?logo=rust&logoColor=white
[ci]: https://github.com/AtahanA/ila-studio/actions/workflows/ci.yml
[releases]: https://github.com/AtahanA/ila-studio/releases
[tauri]: https://tauri.app
[react]: https://react.dev
