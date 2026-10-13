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
- in a profile: the address, paths, filters, the trigger, `capture.radix` and `capture.capture_mode`.

Known gaps:

- `capture.format`, `capture.position` and `capture.timeout_min` are not checked when they come from a profile.
- On the command line of `ila_capture.py` the hw_server address is not checked the way the GUI checks it, and
  the hook mode hands it and `hardware.core_filter` to xsct through `cmd /c` as they are written.
- A capture or probe file is read into memory whole, without a size limit.

### Network

- ILA Studio opens connections to one place only: the hw_server you name. It checks that the address answers;
  then Vivado connects to it and, in hook mode, xsct. It has no telemetry and no update check, and its page
  cannot load anything from the network. What Vivado itself sends, and what the WebView2 runtime of Windows sends, is not in the hands of this project.
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
- The page remembers its last settings (among them the path of the probe file and the hw_server address) in
  the WebView storage of the application under `%LOCALAPPDATA%`.
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
