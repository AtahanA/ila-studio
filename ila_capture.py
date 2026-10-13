#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Capture Xilinx/Vivado ILA data over JTAG and write it to CSV/.ila files on the PC.

Drives two long-running processes that talk to the same hw_server:
  * Vivado Hardware Manager (scripts/vivado_ila_repl.tcl): arm the ILA, upload, write CSV + .ila
  * xsct (xsct_repl.tcl), only for hook mode: watch the CPU, read a variable at a breakpoint, resume

Everything project-specific (tool paths, hw_server, probe names, hook symbols, file naming) lives in a JSON
profile, so a new board or module needs a new profile, not new code. See docs/profile-schema.md and
profiles/example-*.json.

Commands
  check                     validate a profile without touching hardware
  info                      connect and print the ILA cores, core properties and probe list
  capture --name N          one capture now (or on --trigger); --count N repeats it in the same session
  hook                      capture driven by a software hook: wait for the CPU to halt at the hook symbol,
                            read the info struct, capture, resume. Repeats until --count/--minutes.
  watch                     record continuously: arm, collect, re-arm, write, forever. The CPU is never
                            touched. Reports how much of the timeline was actually covered.
  convert PATH...           make ILA CSVs decimal; for a folder, also extract a CSV from every .ila
  stats FILE...             statistics of existing .csv/.ila files (no hardware)
  summary DIR               one row per capture in a folder: edges, event counts, timing (no hardware)

All CSVs this tool writes are decimal: multi-bit probes as unsigned decimal, 1-bit probes 0/1.

Needs Python 3.8+. The Xilinx tools are launched through cmd /c on Windows and directly elsewhere; only the
Windows path has been exercised.
"""
import argparse, concurrent.futures, csv, datetime, glob, gzip, json, math, os, queue, re, shutil, statistics, subprocess, sys, tempfile, threading, time, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_PROFILE = {
    "name": "default",
    # Only defaults, for a profile that names no tools: where Vivado 2017.4 and the SDK 2019.1 are installed when
    # nothing is changed in their installers. Vivado is searched for when the file named here or in the profile
    # is not there: on PATH, then in the installation the XILINX_VIVADO environment variable names and in the
    # usual installation folders (see resolve_vivado). xsct, nm and objdump are used by the "hook" command only
    # and are taken as written, so a profile for hook mode states them.
    "tools": {
        "vivado": r"C:\Xilinx\Vivado\2017.4\bin\vivado.bat",
        "xsct": r"C:\Xilinx\SDK\2019.1\bin\xsct.bat",
        "nm": r"C:\Xilinx\SDK\2019.1\gnu\aarch32\nt\gcc-arm-none-eabi\bin\arm-none-eabi-nm.exe",
        "objdump": r"C:\Xilinx\SDK\2019.1\gnu\aarch32\nt\gcc-arm-none-eabi\bin\arm-none-eabi-objdump.exe",
    },
    "hardware": {
        "url": "127.0.0.1:3121",          # hw_server; both Vivado and xsct connect here
        "ltx": "",                         # probe file from the implementation run (required)
        "device_filter": "*",              # e.g. "xc7z020*" when the chain has several devices
        "target_filter": "*",              # JTAG target glob when several cables are connected
        # TCK frequency. 0 keeps the cable default (usually 10 MHz). Upload time scales almost inversely with it;
        # too high and the readback comes back corrupt (loudly - Vivado refuses it). Measured on a Zynq-7000
        # over a remote hw_server: 10 MHz 1205 ms, 15 MHz 830 ms, 20 MHz 643 ms, 30 MHz corrupt.
        "jtag_frequency_hz": 0,
        "ila_index": 0,                    # which ILA core of the device ("info" lists them)
        "core_filter": "",                 # xsct target filter, e.g. name =~ "*Cortex-A9*#0*"
    },
    "capture": {
        "trigger": "now",                  # "now" or "<probe> <compare-value>", e.g. "frame_start eq1'bR"
        "position": 1000,                  # samples kept before the trigger
        "timeout_min": 1,                  # minutes to wait for the trigger
        "format": "both",                  # both | ila | csv
        "sample_period_ns": 0,             # ILA clock period; 0 = unknown, times are reported in samples
        "radix": "UNSIGNED",               # DISPLAY_RADIX for multi-bit probes: UNSIGNED, SIGNED or HEX
        # how single probes are written into the CSV where that differs from the line above, by net name with or
        # without the hierarchy: {"adc_data": "signed", "top/u1/status": "hex"}. unsigned | signed | hex
        "probe_format": {},
        "capture_mode": "ALWAYS",          # ALWAYS, or BASIC when the core was built with capture control
        "out": os.path.join(os.getcwd(), "captures"),
    },
    "hook": {                              # only needed by the "hook" command
        "symbol": "",                      # empty function the target calls, used as breakpoint
        "info_symbol": "",                 # volatile struct the target fills before the call
        "magic": 0,                        # first word of the struct, written last by the target
        "fields": [],                      # names of the words after the magic, in order
        "signed_fields": [],               # of those, the ones to read as signed 32-bit
        "sequence_field": "",              # field that counts steps; going backwards means the target rebooted
        "end_value": None,                 # sequence value meaning "the last capture is ready, then stop"
        "name_template": "",               # e.g. "run{run}_step{step:03d}" - {run} and the fields
        "mode": "capture_now",             # capture_now | arm_and_collect_next
        # branch-and-link mnemonics to look for in the disassembly, so a breakpoint on the CALLING line is
        # recognised too: ARM/AArch64 bl, MicroBlaze brlid/bralid, RISC-V jal/jalr, x86 call
        "call_mnemonics": ["bl", "brlid", "bralid", "jal", "jalr", "call"],
    },
    "stats": {
        "mode": "none",                    # magnitude | none (none = no statistics, only edges/ctrl; set magnitude + value_probe for statistics of the values)
        "value_probe": "",                 # multi-bit probe the statistics are computed on
        "valid_probe": "",                 # optional 1-bit probe: only samples where it is 1 are used
        "threshold": 0,                    # optional detection threshold in value_probe units
        "reference_probe": "",             # optional: its distinct values are recorded per capture
        "ctrl_probes": [],                 # 1-bit probes whose values during the capture are recorded
        "event_probes": [],                # 1-bit probes whose rising edges are counted/timed
        "warn_if_high": [],                # ctrl probes that must stay 0; a 1 produces a WARNING in the log
    },
}


def load_profile(path):
    """Profile JSON merged over DEFAULT_PROFILE (section by section), so a profile only states what differs."""
    prof = {k: dict(v) if isinstance(v, dict) else v for k, v in DEFAULT_PROFILE.items()}
    if path:
        with open(path, encoding="utf-8") as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(prof.get(k), dict):
                prof[k].update(v)
            else:
                prof[k] = v
    if isinstance(prof.get("hook", {}).get("magic"), str):
        prof["hook"]["magic"] = int(prof["hook"]["magic"], 0)
    return prof


def apply_overrides(prof, args):
    """Command-line hardware options win over the profile, so one profile (or none) serves any .ltx."""
    hw = prof["hardware"]
    if args.ltx:
        hw["ltx"] = os.path.abspath(args.ltx)
    if args.server:
        hw["url"] = args.server if ":" in args.server else args.server + ":3121"
    if args.device:
        hw["device_filter"] = args.device
    if args.ila_index is not None:
        hw["ila_index"] = args.ila_index
    if getattr(args, "ila_cell", None):
        hw["ila_cell"] = args.ila_cell
    if args.jtag_hz is not None:
        hw["jtag_frequency_hz"] = args.jtag_hz
    return prof


# Without this a parent that has no console (a GUI) gets a console window per child, and closing that window
# sends Ctrl-C to Vivado in the middle of a session.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def kill_tree(p):
    """cmd /c vivado.bat is a chain of processes: killing the first one leaves Vivado running and holding the
    JTAG target, so the whole tree goes."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)
    try:
        p.kill()
    except Exception:
        pass


# What this driver asks of the REPL script beyond what every version of it had, and the one line of plain Tcl
# that asks any script for it (Session.check_script). An application updated without its scripts folder runs
# this driver against an older script; most of it still works, which is why it has to be said.
SCRIPT_NEEDS = ("ila_recheck", "ila_probe_radix", "ila_capture_keep", "ila_write_last", "ila_select", "ila_where")
SCRIPT_CHECK = ("set ::ILA_CHECK {}; foreach p {" + " ".join(SCRIPT_NEEDS) + "} "
                "{ if {[llength [info procs $p]] == 0} { lappend ::ILA_CHECK $p } }; "
                "if {![info exists ::JTAG_LEAVE]} { lappend ::ILA_CHECK ::JTAG_LEAVE }; "
                'format "version=%s;missing=%s" [expr {[info exists ::ILA_REPL_VERSION] ? $::ILA_REPL_VERSION : 0}] '
                "[join $::ILA_CHECK ,]")


class Repl:
    """A Tcl process speaking the @@RC/@@RES/@@END protocol on stdout."""
    def __init__(self, argv, name, log):
        self.name, self.log, self.dead = name, log, False
        # One command at a time: two threads speaking to one process would get each other's answers. `writing`
        # is the command another thread is still running here (a file being written, see capture_split).
        self.lock = threading.Lock()
        self.writing = None
        # errors="backslashreplace": one byte outside the code page in Vivado's output must not kill the reader
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, errors="backslashreplace", bufsize=1, cwd=HERE,
                                  creationflags=NO_WINDOW)
        self.q = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        self.log(f"[{self.name}] started, process {self.p.pid}", quiet=True)    # which Vivado is which, in the log
        try:
            self._wait_ready()
        except BaseException:
            kill_tree(self.p)                   # the caller never gets this object, so nobody else could
            raise

    def _reader(self):
        try:
            for line in self.p.stdout:
                self.q.put(line.rstrip("\r\n"))
        finally:
            self.q.put(None)                    # always: a waiting cmd() must learn that nothing more will come

    def _wait_ready(self, timeout=180):
        deadline = time.time() + timeout
        tail = []
        while True:
            try:
                line = self.q.get(timeout=max(0.1, deadline - time.time()))
            except queue.Empty:
                raise RuntimeError(f"{self.name} did not print @@READY within {timeout} s") from None
            if line is None:
                raise RuntimeError(f"{self.name} exited during start-up: {' | '.join(tail[-3:]) or 'no output'}")
            self.log(f"[{self.name}] {line}", quiet=True)
            if line.startswith("@@READY"):
                return
            if line.strip():
                tail.append(line.strip())

    def cmd(self, tcl, timeout=600, check=True):
        # A timeout is raised as RuntimeError like every other failure, so callers need one except clause, and
        # the process is marked dead: after a timeout the unread reply would be handed to the NEXT command,
        # which silently shifts every later answer by one.
        with self.lock:
            if self.dead:
                raise RuntimeError(f"{self.name} is no longer usable (it timed out or exited)")
            try:
                # One command is one line. Every ASCII control character in it becomes a space, not the line
                # feed alone: a carriage return may end a line for the Tcl side as well, and what came after
                # it would then be run as a command of its own.
                self.p.stdin.write(re.sub(r"[\x00-\x1f\x7f]", " ", tcl) + "\n"); self.p.stdin.flush()
            except OSError as e:                # the process is gone: say so in the one exception type callers catch
                self.dead = True
                raise RuntimeError(f"{self.name} is no longer running ({e})") from None
            rc, res, t0 = None, "", time.time()
            while True:
                try:
                    line = self.q.get(timeout=max(1, timeout - (time.time() - t0)))
                except queue.Empty:
                    self.dead = True
                    raise RuntimeError(f"{self.name}: '{tcl[:60]}' timed out after {timeout} s")
                if line is None:
                    self.dead = True
                    raise RuntimeError(f"{self.name} exited")
                if line.startswith("@@RC "):
                    rc = int(line[5:])
                elif line.startswith("@@RES "):
                    res = line[6:]
                elif line.startswith("@@END"):
                    break
                else:
                    self.log(f"[{self.name}] {line}", quiet=True)
        if check and rc != 0:
            raise RuntimeError(f"{self.name}: '{tcl}' failed: {res}")
        return res

    def settle(self, timeout=660):
        """Wait until the command another thread is running here has answered (the file of the last window is
        written). Whether it worked is the business of whoever started it; this only makes the process free."""
        running, self.writing = self.writing, None
        if running is not None:
            try:
                running.result(timeout=timeout)
            except Exception:
                pass

    def close(self):
        """Ask for an orderly exit - the Tcl side then puts the cable's TCK back - but do not sit through Vivado's
        own shutdown: after "Exiting Vivado" it lingers about 20 s when a hardware target was open."""
        self.settle(120)                        # "exit" must not land in the middle of a file being written
        try:
            if not self.dead and self.p.poll() is None:
                self.p.stdin.write("exit\n"); self.p.stdin.flush()
                t0 = time.time()
                while time.time() - t0 < 60:
                    line = self.q.get(timeout=60)
                    if line is None:
                        break
                    try:
                        self.log(f"[{self.name}] {line}", quiet=True)
                    except Exception:
                        # Nobody is listening any more (the application was killed and took its pipe along).
                        # That must not end the wait: Vivado is in the middle of putting the cable's JTAG clock
                        # back, and the kill below would cut that short.
                        pass
                    if "Exiting Vivado" in line:
                        break
        except Exception:
            pass
        kill_tree(self.p)


def tcl_path(p):
    p = p.replace("\\", "/")
    if "{" in p or "}" in p:                     # a brace of its own could end the braces early: escaped instead
        return tcl_word(p)
    return "{" + p + "}"


def tcl_word(s):
    """Any text as one Tcl word, e.g. a net name with "[3]" or a brace in it."""
    if not re.search(r"[{}\\\s]", s):
        return "{" + s + "}"
    return '"' + re.sub(r'([\\\[\]$"{}])', r"\\\1", s) + '"'


def tcl_trigger(trig):
    """A trigger condition as the braced word the capture commands take. What it says is for the Tcl side to
    judge (ila_set_trigger). Refused here is only one whose braces do not pair up: the word would end early, or
    not at all, and what follows it would be read as Tcl."""
    trig = str(trig)
    depth, i = 0, 0
    while i < len(trig) and depth >= 0:
        if trig[i] == "\\":
            # Tcl does not count a brace that stands behind a backslash, so neither is it counted here; and a
            # backslash at the very end would do that to the closing brace of the word itself
            i += 1
            if i == len(trig):
                depth = -1
        elif trig[i] in "{}":
            depth += 1 if trig[i] == "{" else -1
        i += 1
    if depth:
        raise RuntimeError(f"the trigger {trig!r} cannot be used: its braces do not pair up (or it ends in a "
                           f"backslash)")
    return "{" + trig + "}"


# capture.radix and capture.capture_mode are written into the capture commands as they stand, and the Tcl side
# hands them to Vivado (DISPLAY_RADIX of the probes, CONTROL.CAPTURE_MODE of the core) without looking at them.
# They come from a profile, so anything but the words meant is refused before it could be run as Tcl. A radix
# beyond these three is refused as well (binary, octal): the CSV readers below take a column for hex or decimal.
RADIXES = ("UNSIGNED", "SIGNED", "HEX")
CAPTURE_MODES = ("ALWAYS", "BASIC")


def capture_words(cap):
    """(radix, capture_mode) of a capture section, as they go into the Tcl commands. An empty one is the default
    and any letter case is taken; they are sent in capitals, as Vivado writes them (the Tcl side would drop a
    spelling Vivado refuses without a word). RuntimeError for anything else."""
    words, wrong = [], []
    for key, known in (("radix", RADIXES), ("capture_mode", CAPTURE_MODES)):
        word = str(cap.get(key) or known[0]).strip()
        if word.upper() not in known:
            wrong.append(f"capture.{key} is {cap.get(key)!r}: it must be one of {', '.join(known)}")
        words.append(word.upper())
    if wrong:
        raise RuntimeError("; ".join(wrong))
    return words


def resolve_vivado(path):
    """The configured Vivado if it exists, else the one on PATH, else the newest installation in the usual
    places - so a profile written on another PC (or one that just says "vivado") still starts."""
    if path and os.path.isfile(path):
        return path
    found = shutil.which(path) if path else None
    for exe in ("vivado", "vivado_lab"):
        found = found or shutil.which(exe)
    if found:
        return found
    drives = ("C:\\", "D:\\", "E:\\", "/opt", "/tools")
    roots = [os.environ.get("XILINX_VIVADO", "")] + [os.path.join(d, "Xilinx", sub, "*") for d in drives
                                                      for sub in ("Vivado", "Vivado_Lab")]
    # newer installers put the version first: <root>\<version>\Vivado, the root being Xilinx or AMDDesignTools
    roots += [os.path.join(d, vendor, "*", sub) for d in drives for vendor in ("Xilinx", "AMDDesignTools")
              for sub in ("Vivado", "Vivado_Lab")]
    hits = [h for r in roots if r for exe in ("vivado.bat", "vivado_lab.bat", "vivado", "vivado_lab")
            for h in glob.glob(os.path.join(r, "bin", exe))]
    if hits:
        def version(h):                          # ...\Vivado\2017.4\bin\vivado.bat or ...\2025.2\Vivado\bin\vivado.bat
            home = os.path.dirname(os.path.dirname(h))
            names = (os.path.basename(home), os.path.basename(os.path.dirname(home)))
            return next((n for n in names if n[:1].isdigit()), names[0])
        return max(hits, key=version)
    raise RuntimeError(f"Vivado not found (tools.vivado is {path or 'empty'}). Any one of these lets it be found: "
                       f"Vivado's bin folder on PATH; the XILINX_VIVADO environment variable set to the installation "
                       f"folder (the one that holds bin); an installation under Xilinx\\Vivado, Xilinx\\Vivado_Lab, "
                       f"Xilinx\\<version>\\Vivado or AMDDesignTools\\<version>\\Vivado on C:, D: or E: (/opt/Xilinx "
                       f"or /tools/Xilinx elsewhere); the full path of vivado.bat as tools.vivado of a profile")


def resolve_tcl(path):
    """The REPL script: an explicit one (relative names are looked up next to this file too, since that is where
    a GUI's "scripts\\vivado_ila_repl.tcl" lives), else the one shipped with this driver, which is
    scripts/vivado_ila_repl.tcl next to this file."""
    cands = [path, os.path.join(HERE, path)] if path else []
    cands.append(os.path.join(HERE, "scripts", "vivado_ila_repl.tcl"))
    for c in cands:
        if os.path.isfile(c):
            return os.path.abspath(c)
    raise RuntimeError(f"Tcl script not found: {path or cands[-1]}")


def launch(exe, *args):
    """Windows needs cmd /c for the .bat wrappers Xilinx ships; elsewhere the executable is run directly."""
    argv = [exe, *args]
    return ["cmd", "/c"] + argv if os.name == "nt" else argv


def expand(paths):
    r"""Expand globs ourselves: cmd.exe and PowerShell do not, so 'stats captures\*\*.csv' would otherwise
    arrive as a literal pattern and fail with a bare FileNotFoundError."""
    out = []
    for p in paths:
        hits = sorted(glob.glob(p))
        out.extend(hits or [p])
    return out


# ---------------------------------------------------------------- CSV radix
# A Vivado ILA CSV has no radix metadata, so the radix of a multi-bit column is inferred from its values:
# a HEX export is zero-padded to the full width (6 digits for [23:0]), a decimal value never has leading zeros.
# Guessing wrong silently changes every number, so the rule is applied per column and ambiguity is resolved
# from the rest of the file.
BUS_RE = re.compile(r"\[(\d+):(\d+)\]$")


def bus_columns(hdr):
    """{column index: bit width} of the multi-bit probe columns ('.../name[23:0]')."""
    out = {}
    for i, c in enumerate(hdr):
        m = BUS_RE.search(c.strip())
        if m and m.group(1) != m.group(2):
            out[i] = abs(int(m.group(1)) - int(m.group(2))) + 1
    return out


def is_data_row(row):
    return bool(row) and row[0].strip().isdigit()


def column_radixes(hdr, rows):
    """{column index: 'hex' | 'dec'} for the multi-bit columns (rows = split data rows).
    Hex beyond doubt: values written "0x..." (the way this tool writes a probe asked for in hex). Otherwise
    clearly hex: a value with a-f, or zero-padded to the hex width. Clearly decimal: a sign, or a length other
    than the hex width. A column that fits both (only full-width digit strings without a leading zero) follows
    the file: hex if another column is clearly hex WITHOUT saying so (Vivado's default export, where every
    column is), otherwise decimal - a "0x" column says nothing about its neighbours."""
    clear, ambiguous, bare_hex = {}, [], False
    for i, w in bus_columns(hdr).items():
        n = (w + 3) // 4
        is_hex = is_dec = prefixed = bare = False
        for v in {r[i].strip() for r in rows if i < len(r)}:
            if not v:
                continue
            if v[:2] in ("0x", "0X"):
                prefixed = True
                continue
            bare = True
            if any(ch in "abcdefABCDEF" for ch in v):
                is_hex = True
            elif v[0] in "+-" or len(v) != n:
                is_dec = True
            elif n > 1 and v[0] == "0":
                is_hex = True
        if (is_hex and is_dec) or (prefixed and bare):
            raise ValueError(f"column {hdr[i]}: both hex and decimal values")
        if prefixed or is_hex or is_dec:
            clear[i] = "dec" if is_dec else "hex"
            bare_hex = bare_hex or is_hex
        else:
            ambiguous.append(i)
    default = "hex" if bare_hex else "dec"
    return {**clear, **{i: default for i in ambiguous}}


def read_ila_text(path):
    """Text of a Vivado ILA CSV (plain or gzipped), or of the waveform.csv inside a .ila archive (a .ila is a
    zip, and its waveform.csv is byte-identical to write_hw_ila_data -csv_file)."""
    if path.lower().endswith(".ila"):
        with zipfile.ZipFile(path) as z:
            return z.read("waveform.csv").decode("ascii")
    op = gzip.open if path.lower().endswith(".gz") else open
    with op(path, "rb") as f:
        return f.read().decode("ascii")


def load_ila(path):
    """(header, data rows, {column index: radix}) of an ILA CSV or .ila archive."""
    lines = [l.split(",") for l in read_ila_text(path).splitlines()]
    data = [r for r in lines[1:] if is_data_row(r)]
    return lines[0], data, column_radixes(lines[0], data)


def ila_text_to_decimal(text):
    """(text, names of converted columns): every hex multi-bit column rewritten in unsigned decimal. Nothing
    else changes: header, 1-bit columns, separators and line ends stay byte-identical."""
    nl = "\r\n" if "\r\n" in text[:100000] else "\n"
    lines = [l.split(",") for l in text.split(nl)]
    data = [r for r in lines[1:] if is_data_row(r)]
    hexcols = [i for i, r in column_radixes(lines[0], data).items() if r == "hex"]
    if not hexcols:
        return text, []
    for r in data:
        for i in hexcols:
            if i < len(r) and r[i].strip():
                r[i] = str(int(r[i], 16))
    for r in lines[1:]:                          # a radix row (newer Vivado versions) keeps matching the data
        if r and r[0].strip().lower().startswith("radix"):
            for i in hexcols:
                if i < len(r):
                    r[i] = "UNSIGNED"
    return nl.join(",".join(r) for r in lines), [lines[0][i].split("/")[-1] for i in hexcols]


def _write_text(path, text):
    op = gzip.open if path.lower().endswith(".gz") else open
    try:
        with op(path + ".tmp", "wb") as f:
            f.write(text.encode("ascii"))
        os.replace(path + ".tmp", path)
    except BaseException:
        _unlink(path + ".tmp")          # a full disk must not leave .tmp files behind
        raise


def _unlink(path):
    try:
        os.remove(path)
    except OSError:
        pass


def ila_csv_to_decimal(src, dst=None):
    """Write the ILA CSV of src (.csv, or the waveform.csv of a .ila) to dst (default src, in place) with every
    multi-bit column in unsigned decimal. Replaced atomically, keeps the modification time of src.
    Returns the converted column names; [] and nothing written when src already is a decimal CSV."""
    dst = dst or src
    if dst.lower().endswith(".ila"):
        raise ValueError(f"{dst}: the .ila archive is never rewritten, give a .csv destination")
    new, cols = ila_text_to_decimal(read_ila_text(src))
    if not cols and os.path.abspath(dst) == os.path.abspath(src):
        return cols
    mtime = os.stat(src).st_mtime
    _write_text(dst, new)
    os.utime(dst, (mtime, mtime))
    return cols


# ---------------------------------------------------------------- per-probe format of the CSV
# unsigned: the plain number, what Vivado writes by default here. signed: two's complement of the probe width,
# written by Vivado itself (DISPLAY_RADIX SIGNED, see ila_probe_radix in the Tcl script). hex: "0x" and every
# digit of the width, written by THIS tool from Vivado's decimal - Vivado's own hex has no prefix, and next to
# decimal columns a reader could then take "8123" for either (and a spreadsheet makes 1e05 a number).
PROBE_FORMATS = ("unsigned", "signed", "hex")


def probe_format_map(formats):
    """{net name without bus range: format} from what a profile or the GUI gives."""
    out = {}
    for name, fmt in (formats or {}).items():
        f = str(fmt).strip().lower()
        if f not in PROBE_FORMATS:
            raise ValueError(f"probe format of {name}: {fmt!r} is none of {', '.join(PROBE_FORMATS)}")
        out[BUS_RE.sub("", str(name).strip())] = f
    return out


def format_columns(hdr, formats):
    """{column index: format} of the multi-bit columns that `formats` (see probe_format_map) names: by the whole
    hierarchical name, or by the last element of it alone - unless a column is called just that, which then is
    the one meant (the Tcl side, ila_find_probes, takes the exact name first as well)."""
    buses = {i: BUS_RE.sub("", hdr[i].strip()) for i in bus_columns(hdr)}
    whole = set(buses.values())
    out = {}
    for i, full in buses.items():
        leaf = full.split("/")[-1]
        fmt = formats.get(full) or (None if leaf in whole else formats.get(leaf))
        if fmt:
            out[i] = fmt
    return out


def ila_text_formatted(text, formats):
    """(text, {column name: format}) with the multi-bit columns written the way `formats` asks; the dictionary
    names the columns that had to be rewritten for it. A column nobody asked about is left as it is, except that
    hex without "0x" becomes unsigned decimal (as ila_text_to_decimal does). Header, 1-bit columns, separators
    and line ends stay byte-identical, and so does the whole text when everything is already as asked."""
    nl = "\r\n" if "\r\n" in text[:100000] else "\n"
    lines = [l.split(",") for l in text.split(nl)]
    hdr = lines[0]
    data = [r for r in lines[1:] if is_data_row(r)]
    written = column_radixes(hdr, data)
    wanted = format_columns(hdr, formats)
    changed = {}
    for i, w in bus_columns(hdr).items():
        fmt = wanted.get(i) or ("unsigned" if written.get(i) == "hex" else None)
        if fmt is None:
            continue
        base = 16 if written.get(i) == "hex" else 10
        full, half, digits = 1 << w, 1 << (w - 1), (w + 3) // 4
        new = {}                                 # per distinct value: a capture repeats most of them many times
        for v in {r[i] for r in data if i < len(r)}:
            if not v.strip():
                continue
            u = int(v, base) % full              # the bits of the probe, however they were written
            out = f"0x{u:0{digits}X}" if fmt == "hex" else str(u - full if fmt == "signed" and u >= half else u)
            if out != v:
                new[v] = out
        if new:
            for r in data:
                if i < len(r) and r[i] in new:
                    r[i] = new[r[i]]
            changed[i] = fmt
    if not changed:
        return text, {}
    for r in lines[1:]:                          # a radix row (newer Vivado versions) keeps matching the data
        if r and r[0].strip().lower().startswith("radix"):
            for i, fmt in changed.items():
                if i < len(r):
                    r[i] = fmt.upper()
    return nl.join(",".join(r) for r in lines), {hdr[i].strip().split("/")[-1]: fmt for i, fmt in changed.items()}


def ila_csv_format(src, formats, dst=None):
    """ila_text_formatted for a file: src (.csv, .csv.gz, or the waveform.csv of a .ila) written to dst (default
    src, in place) in the formats asked for. Replaced atomically, keeps the modification time of src. Returns
    the rewritten columns; {} and nothing written when src already is as asked."""
    dst = dst or src
    if dst.lower().endswith(".ila"):
        raise ValueError(f"{dst}: the .ila archive is never rewritten, give a .csv destination")
    new, cols = ila_text_formatted(read_ila_text(src), formats)
    if not cols and os.path.abspath(dst) == os.path.abspath(src):
        return cols
    mtime = os.stat(src).st_mtime
    _write_text(dst, new)
    os.utime(dst, (mtime, mtime))
    return cols


def is_ila_csv(path):
    op = gzip.open if path.lower().endswith(".gz") else open
    try:
        with op(path, "rb") as f:
            return f.read(64).startswith(b"Sample in Buffer,")
    except OSError:
        return False


def gzip_file(path, level=6):
    """Replace a CSV with a .csv.gz. An ILA CSV is mostly zeros and repeated columns, so this reaches roughly
    the size of the .ila archive while costing far less wall time than letting Vivado write the .ila."""
    try:
        with open(path, "rb") as fi, gzip.open(path + ".gz.tmp", "wb", compresslevel=level) as fo:
            while True:
                chunk = fi.read(1 << 20)
                if not chunk:
                    break
                fo.write(chunk)
        os.replace(path + ".gz.tmp", path + ".gz")
    except BaseException:
        _unlink(path + ".gz.tmp")
        raise
    os.remove(path)
    return path + ".gz"


def folder_bytes(d):
    """Bytes actually on disk in a session folder - what --max-gb should mean, since the CSVs shrink when the
    worker gzips them."""
    total = 0
    with os.scandir(d) as it:
        for e in it:
            if e.is_file():
                total += e.stat().st_size
    return total


# ---------------------------------------------------------------- reading probes out of a capture
def probe_index(hdr, name):
    """Column of a probe, matched on the last path element first (probe names are fully hierarchical)."""
    short = [c.split("/")[-1] for c in hdr]
    if name in short:
        return short.index(name)
    for i, c in enumerate(short):
        if c.startswith(name + "["):
            return i
    # a part of the hierarchy: the end of the full name from a "/" on, with or without the bus range - never a
    # piece of a name ("valid" is not "rx_valid"), which would record the statistics of another probe
    for i, c in enumerate(hdr):
        c = c.strip()
        base = re.sub(r"\[\d+(:\d+)?\]$", "", c)
        if name in (c, base) or c.endswith("/" + name) or base.endswith("/" + name):
            return i
    raise KeyError(f"probe {name} not in the capture (have: {', '.join(sorted(set(short))[:12])} ...)")


def rising_edges(rows, i):
    return [k for k in range(1, len(rows)) if rows[k][i] == "1" and rows[k - 1][i] == "0"]


def falling_edges(rows, i):
    return [k for k in range(1, len(rows)) if rows[k][i] == "0" and rows[k - 1][i] == "1"]


def stats_of(path, st_cfg):
    """Statistics of one capture. With stats.mode 'magnitude' the value probe is treated as a magnitude
    (|x|, amplitude-like data) and the distribution plus the threshold crossings are reported. Set mode 'none'
    to record only the control probes and event counts."""
    hdr, data, rad = load_ila(path)
    out = {"rows": len(data)}
    if not data:
        return out
    base = lambda i: 16 if rad.get(i) == "hex" else 10
    ctrl = {}
    watched = list(dict.fromkeys(list(st_cfg.get("ctrl_probes", [])) + list(st_cfg.get("warn_if_high", []))))
    for name in watched:
        try:
            i = probe_index(hdr, name)
        except KeyError:
            continue
        ctrl[name] = "".join(sorted({r[i] for r in data}))
    out["ctrl"] = ";".join(f"{k}={v}" for k, v in ctrl.items())
    for name in st_cfg.get("event_probes", []):
        try:
            i = probe_index(hdr, name)
        except KeyError:
            continue
        out[f"n_{name}"] = len(rising_edges(data, i))
    if st_cfg.get("mode", "magnitude") == "none" or not st_cfg.get("value_probe"):
        return out
    ia = probe_index(hdr, st_cfg["value_probe"])
    iv = probe_index(hdr, st_cfg["valid_probe"]) if st_cfg.get("valid_probe") else None
    v = [int(r[ia], base(ia)) for r in data if iv is None or r[iv] == "1"]
    out.update(n=len(v), radix=rad.get(ia, "dec"))
    if st_cfg.get("reference_probe"):
        try:
            ir = probe_index(hdr, st_cfg["reference_probe"])
            out["ref_level"] = ";".join(str(x) for x in sorted({int(r[ir], base(ir)) for r in data}))[:40]
        except KeyError:
            pass
    if not v:
        return out
    s = sorted(v)
    pct = lambda q: s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]
    mean = statistics.fmean(v)
    rms = math.sqrt(statistics.fmean(x * x for x in v))
    out.update(mean=round(mean, 2), rms=round(rms, 2), median=statistics.median(v),
               p90=pct(.90), p99=pct(.99), max=s[-1], min=s[0],
               rms_db=round(20 * math.log10(rms), 2) if rms > 0 else "",
               # ~0.886 for Rayleigh-distributed pure noise; higher means a steady component (an offset, a tone)
               mean_over_rms=round(mean / rms, 3) if rms > 0 else "")
    thr = st_cfg.get("threshold") or 0
    if thr:
        over = sum(1 for x in v if x > thr)
        out.update(threshold=thr, over_thr=over, over_thr_pct=round(100.0 * over / len(v), 3),
                   margin_to_thr_db=round(20 * math.log10(thr / rms), 2) if rms > 0 else "")
    return out


STAT_COLS = ["rows", "n", "radix", "mean", "rms", "median", "p90", "p99", "max", "min", "rms_db",
             "mean_over_rms", "threshold", "over_thr", "over_thr_pct", "margin_to_thr_db", "ref_level", "ctrl"]


# ---------------------------------------------------------------- session
class Session:
    def __init__(self, args, prof, ephemeral=False):
        """ephemeral: connect and report without creating a session folder (used by 'info')."""
        self.args, self.prof = args, prof
        self.out = self.logf = self.index = None
        if not ephemeral:
            # what the capture commands would refuse (tcl_trigger, capture_words) is refused now, before a
            # session folder is made and Vivado started for it
            tcl_trigger(getattr(args, "trigger", None) or prof["capture"]["trigger"])
            capture_words(prof["capture"])
            stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            self.out = os.path.join(args.out or prof["capture"]["out"], f"{stamp}_{args.target}")
            os.makedirs(self.out, exist_ok=True)
            self.logf = open(os.path.join(self.out, "session.log"), "a", encoding="utf-8")
            self.index = os.path.join(self.out, "index.csv")
        self.index_fields = None            # fixed on the first row: a later row with fewer keys must not slide
        self.viv = self.xs = None
        self.extra = []                     # additional Vivado clients used by watch --writers
        # The Tcl side ends a trigger wait when this file appears. close() creates it, so that a session blocked
        # in a long wait (Ctrl-C while armed) still ends in order and can put the cable's TCK back. A caller that
        # has its own stop signal (the GUI bridge) sets the path before open_vivado.
        self.stop_file = os.path.join(tempfile.gettempdir(), f"ila_capture_stop_{os.getpid()}.flag")
        self.own_stop_file = True

    def log(self, msg, quiet=False):
        line = f"{datetime.datetime.now():%H:%M:%S} {msg}"
        if self.logf:
            self.logf.write(line + "\n"); self.logf.flush()
        if not quiet:
            print(line, flush=True)

    def open_vivado(self):
        hw, t = self.prof["hardware"], self.prof["tools"]
        self.log("starting the Vivado hardware manager (tens of seconds)")
        tcl_script = resolve_tcl(getattr(self.args, "tcl", None))
        self.viv = Repl(launch(resolve_vivado(t["vivado"]), "-mode", "tcl", "-nolog", "-nojournal", "-notrace",
                               "-source", tcl_script), "vivado", self.log)
        self.check_script(self.viv, tcl_script)
        if self.own_stop_file:
            _unlink(self.stop_file)             # a leftover from a killed run must not stop this one
        self.viv.cmd(f"set ::STOP_FILE {tcl_path(self.stop_file)}", timeout=60)
        info = self.viv.cmd(self._ila_open_cmd(), timeout=600)
        info = self.select_core(self.viv, info)
        self.log(f"ILA: {info}")
        try:
            # what this client will put back when it closes - kept so that another client of the session can do
            # it in its place should this one be gone by then (see hand_over_cable)
            found = self.viv.cmd("list $::JTAG_ORIG $::JTAG_PROP", timeout=60).split()
            self.viv.cable_found = tuple(found) if len(found) == 2 and found[0].isdigit() else None
        except RuntimeError:
            if self.viv.dead:
                raise
            self.viv.cable_found = None          # a REPL script of one's own: it looks after the cable itself
        self.sync_probe_radix()
        return info

    def check_script(self, viv, path):
        """What the REPL script this Vivado has sourced lacks of the things this driver asks for (viv.lacks). What
        is missing is worked around - but said, once, and kept for the answer of the job (self.script_note): a
        program updated without its scripts folder otherwise shows only as notes nobody can place."""
        try:
            answer = viv.cmd(SCRIPT_CHECK, timeout=60)
        except RuntimeError:
            if viv.dead:
                raise
            answer = ""
        got = dict(p.split("=", 1) for p in answer.split(";") if "=" in p)
        viv.lacks = set(filter(None, got.get("missing", "").split(",")))
        self.script_note = ""
        if viv.lacks:
            around = [text for item, text in (("ila_probe_radix", "signed formats are converted after each capture"),
                                              ("ila_capture_keep", "only one Vivado engine is used"))
                      if item in viv.lacks]
            self.script_note = (f"The Tcl script {path} is older than this program (it has no "
                                f"{', '.join(sorted(viv.lacks))}): " + ("; ".join(around) + ". " if around else "")
                                + "Update the scripts folder together with the program, or clear the Tcl script "
                                  "field if it names a copy from an earlier release.")
            self.log("WARNING " + self.script_note)

    def select_core(self, viv, info=None):
        """Make this Vivado drive the ILA core the job asks for; returns ila_info of that core. By the core's cell
        name when the job gives one (the GUI does) - the name the probe file knows it by; its position in the
        device's list need not be its position in the file - else by position. `info`: what ila_open has just
        answered, for a job that goes by position: the core is the one it opened with."""
        hw = self.prof["hardware"]
        cell, index = hw.get("ila_cell") or "", int(hw.get("ila_index") or 0)
        if info is None or cell:
            if "ila_select" not in getattr(viv, "lacks", ()):
                info = viv.cmd(f"ila_select {tcl_word(cell)} {index}", timeout=180)
            else:                                # a script from before cores were chosen by name
                if cell:
                    listed = [re.match(r"(\d+)=(.*?)\(depth", item.strip()) for item in
                              viv.cmd("ila_list", timeout=120).split(";")]
                    at = [int(m.group(1)) for m in listed if m and m.group(2).strip() == cell]
                    if not at:
                        raise RuntimeError(f"ILA core {cell} is not on the device - is the bitstream that belongs "
                                           f"to the probe file loaded?")
                    index = at[0]
                before = viv.cmd("set ::ILA_INDEX", timeout=60).strip()
                viv.cmd(f"set ::ILA_INDEX {index}", timeout=60)
                try:
                    info = viv.cmd("ila_info", timeout=120)
                except RuntimeError:
                    if not viv.dead and before.isdigit():      # a position the device does not have: as it was
                        viv.cmd(f"set ::ILA_INDEX {before}", timeout=60)
                    raise
        said = dict(p.split("=", 1) for p in info.split(";") if "=" in p)
        # Vivado's own name for the core (hw_ila_N) tells cores apart where the cell name does not - a probe file
        # that names no cells; the cell name is what the log and the messages show
        core = said.get("CELL_NAME", "")
        ident = (said.get("NAME", ""), core)
        if getattr(viv, "core_ident", ident) != ident:
            viv.probe_radix = None               # what it was told about probes was about the core before
        viv.core, viv.core_ident = core, ident
        return info

    def probe_formats(self):
        return probe_format_map(self.prof["capture"].get("probe_format"))

    def sync_probe_radix(self, viv=None):
        """Tell a Vivado which probes it is to write SIGNED - once, and again when the choice has changed (a
        Vivado kept open for the next job remembers the last one). Vivado takes the radix of a probe when a
        capture is uploaded, so this has to be in place before the capture, and costs nothing per capture."""
        viv = viv or self.viv
        signed = tuple(sorted(n for n, f in self.probe_formats().items() if f == "signed"))
        if getattr(viv, "probe_radix", ()) == signed:
            return
        viv.probe_radix = signed
        try:
            answer = viv.cmd("ila_probe_radix [list " + " ".join(f"{tcl_word(n)} SIGNED" for n in signed) + "]",
                             timeout=120)
        except RuntimeError as e:
            if viv.dead:
                raise
            # A REPL script that does not know the command: the CSV is put right after the capture. The reason is
            # what follows "failed:" - the text before it is the command itself, as long as the names in it.
            reason = str(e).split("failed: ", 1)[-1].strip()
            self.log(f"NOTE Vivado was not told which probes are signed ({reason[:160]}); "
                     f"their CSV columns are converted after each capture instead")
            return
        said = dict(p.split("=", 1) for p in answer.split(";") if "=" in p)
        core = getattr(viv, "core", "") or "the selected ILA core"
        if said.get("missing"):
            self.log(f"WARNING probe format: no such probe on {core}: {said['missing']}")
        if said.get("ambiguous"):
            self.log(f"WARNING probe format: several probes of {core} are called {said['ambiguous']} - "
                     f"give the full name")

    def _ila_open_cmd(self, tck_hz=None):
        """Every argument braced: an empty device or target filter must not shift the ones after it, and the
        server address must stay text ("[::1]:3121" unbraced is a command substitution).
        tck_hz: the TCK frequency to open with instead of the one the profile asks for."""
        hw = self.prof["hardware"]
        # a core that is named is chosen by name after the open (select_core): until then the first one, which
        # every device with an ILA has - a position kept from another design could lie beyond this one's cores
        index = 0 if hw.get("ila_cell") else int(hw.get("ila_index") or 0)
        return (f"ila_open {tcl_word(str(hw['url']))} {tcl_path(hw['ltx'])} {tcl_path(hw.get('device_filter') or '*')} "
                f"{index} {tcl_path(hw.get('target_filter') or '*')} "
                f"{int(tck_hz or hw.get('jtag_frequency_hz') or 0)}")

    def first_tck(self):
        """The TCK frequency the first client runs the cable at; 0 when it cannot say."""
        try:
            hz = self.viv.cmd("jtag_freq", timeout=60).strip()
        except RuntimeError:
            if self.viv.dead:
                raise
            return 0
        return int(hz) if hz.isdigit() else 0

    def open_extra_vivado(self, tag):
        """Another Vivado client on the same hw_server. Two clients can take turns on one ILA: while one is
        formatting its CSV (the slowest step), the other arms and uploads the next window. Measured:
        0.80 s per window against 1.95 s with a single client. The hw_server serialises the JTAG traffic, so the
        clients must never be driven concurrently over JTAG - only the writes overlap."""
        return self.attach_extra_vivado(self.start_extra_vivado(tag))

    def start_extra_vivado(self, tag):
        """The process of another Vivado client, started and waiting for commands but not connected to anything
        yet: starting takes about four seconds and touches nothing, so it can run while the first client is
        still connecting. attach_extra_vivado connects it."""
        t = self.prof["tools"]
        tcl_script = resolve_tcl(getattr(self.args, "tcl", None))
        return Repl(launch(resolve_vivado(t["vivado"]), "-mode", "tcl", "-nolog", "-nojournal", "-notrace", "-source",
                           tcl_script), f"vivado{tag}", self.log)

    def attach_extra_vivado(self, r):
        """Connect a started client to the ILA the first one has open; it joins self.extra. Only when the first
        client is connected and idle: connecting is JTAG traffic, and where the cable runs at a frequency Vivado
        cannot represent, it sets the cable's clock anew on the way (see ila_connect in the Tcl script).
        The client is told to leave the cable's clock alone when it goes - the first one puts back what was
        found. One that cannot connect is closed here and the error passed on."""
        try:
            r.cmd(f"set ::STOP_FILE {tcl_path(self.stop_file)}", timeout=60)
            r.cmd("set ::JTAG_LEAVE 1", timeout=60)
            # It opens with exactly the frequency the first client runs the cable at - not with what it would
            # work out by itself: it may find the cable at another frequency than the first one did (the 10 MHz
            # of the xsdb reset), and "automatic" starts from what is found. Its connect is the last thing that
            # sets the cable's clock, so one that ends up anywhere else is not taken.
            tck = self.first_tck()
            info = r.cmd(self._ila_open_cmd(tck), timeout=600)
            got = dict(p.split("=", 1) for p in info.split(";") if "=" in p).get("JTAG_FREQ_HZ", "")
            if tck and got.isdigit() and int(got) != tck:
                raise RuntimeError(f"{r.name} runs the cable at {got} Hz, the first Vivado at {tck} Hz")
            r.lacks = getattr(self.viv, "lacks", set())      # it sourced the same script
            self.select_core(r, info)
            self.sync_probe_radix(r)
        except BaseException:
            r.close()
            raise
        self.extra.append(r)
        return r

    def open_xsct(self):
        hw, t = self.prof["hardware"], self.prof["tools"]
        argv = launch(t["xsct"], os.path.join(HERE, "xsct_repl.tcl"), f"tcp:{hw['url']}")
        if hw.get("core_filter"):
            argv.append(hw["core_filter"])
        self.xs = Repl(argv, "xsct", self.log)

    def capture(self, name, meta, armed=False, finish=None):
        """One capture: collect an already armed ILA (armed=True) or run a complete capture, then compute
        statistics and append a row to index.csv.
        finish: given, it is called with the function that does everything after Vivado has written the file
        (format conversion, statistics, index row) instead of that being done here, and None is returned: a
        caller taking window after window hands it to another thread and arms the next window at once."""
        cap = self.prof["capture"]
        prefix = os.path.join(self.out, name)
        fmt = self.args.format or cap["format"]
        if armed:
            timing = self.viv.cmd(f"ila_collect {tcl_path(prefix)} {fmt} 0.05", timeout=600)
        else:
            radix, cmode = capture_words(cap)
            timing = self.viv.cmd(f"ila_capture {tcl_path(prefix)} {tcl_trigger(self.args.trigger or cap['trigger'])} "
                                  f"{cap['position']} {cap['timeout_min']} {fmt} {radix} {cmode}",
                                  timeout=cap["timeout_min"] * 60 + 600)
        src = prefix + ".csv" if os.path.exists(prefix + ".csv") else prefix + ".ila"
        if not has_data_rows(src):               # a header-only upload is not a capture, and must not look like one
            for ext in (".csv", ".ila"):
                _unlink(prefix + ext)
            raise RuntimeError(f"the upload contained no samples ({timing})")
        if finish:
            return finish(lambda: self.finish_capture(name, meta, src, timing))
        return self.finish_capture(name, meta, src, timing)

    def capture_split(self, viv, name, meta, pool):
        """One window taken by one of several Vivado clients: armed, waited for and uploaded here, by `viv`; its
        file is then written by that client on a thread of `pool`, so that the caller can go on to the next
        client at once. Raises as capture() does when there was nothing to upload.
        Returns two functions for whoever looks after the window: the first waits for the file and returns its
        path (RuntimeError when nothing usable was written), the second does with that path what finish_capture
        does and returns the statistics."""
        cap = self.prof["capture"]
        prefix = os.path.join(self.out, name)
        fmt = self.args.format or cap["format"]
        viv.settle()                             # the file of its last window comes first
        radix, cmode = capture_words(cap)
        timing = viv.cmd(f"ila_capture_keep {tcl_trigger(self.args.trigger or cap['trigger'])} "
                         f"{cap['position']} {cap['timeout_min']} {radix} {cmode}",
                         timeout=cap["timeout_min"] * 60 + 600)
        writing = viv.writing = pool.submit(viv.cmd, f"ila_write_last {tcl_path(prefix)} {fmt}", 600)
        wrote = []

        def written_file():
            try:
                wrote.append(writing.result(timeout=660))
            except concurrent.futures.TimeoutError:
                raise RuntimeError(f"{viv.name} did not finish writing {name}") from None
            src = next((prefix + ext for ext in (".csv", ".ila") if os.path.exists(prefix + ext)), None)
            if not src:
                raise RuntimeError("no capture file was written")
            if not has_data_rows(src):           # as in capture(): a header-only upload is not a capture
                for ext in (".csv", ".ila"):
                    _unlink(prefix + ext)
                raise RuntimeError(f"the upload contained no samples ({timing})")
            return src

        def finish(src):
            return self.finish_capture(name, meta, src, ";".join([timing] + wrote))

        return written_file, finish

    def finish_capture(self, name, meta, src, timing):
        """What is done to a capture once Vivado has written it: the CSV in the formats asked for, statistics,
        the row in index.csv. Returns the statistics."""
        st_cfg = self.prof["stats"]
        if src.endswith(".csv"):
            formats = self.probe_formats()
            if formats:
                rewritten = ila_csv_format(src, formats)
                # signed comes from Vivado as asked; a column that still had to be made signed here shows that
                # the Tcl side did not do it (see sync_probe_radix)
                late = sorted(n for n, f in rewritten.items() if f != "hex")
                if late and not getattr(self, "told_late", False):
                    self.told_late = True
                    self.log(f"NOTE {name}: converted after the capture: {', '.join(late)}")
            else:
                ila_csv_to_decimal(src)          # the Tcl side asks Vivado for decimal; this is the safety net
        try:
            st = stats_of(src, st_cfg)
        except KeyError as e:                    # a profile written for another design: the capture itself is fine
            self.log(f"WARNING {name}: statistics skipped: {e.args[0] if e.args else e}")
            st = stats_of(src, {"mode": "none"})
        row = dict(time=datetime.datetime.now().isoformat(timespec="seconds"), target=self.args.target, name=name,
                   **meta, **{k: st.get(k, "") for k in STAT_COLS if k in st},
                   **{k: v for k, v in st.items() if k.startswith("n_")}, timing=timing)
        new = not os.path.exists(self.index)
        if self.index_fields is None:
            self.index_fields = list(row.keys())
        with open(self.index, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=self.index_fields, extrasaction="ignore", restval="")
            if new:
                w.writeheader()
            w.writerow(row)
        missing = [k for k in row if k not in self.index_fields]
        if missing:
            self.log(f"WARNING {name}: {missing} not in the index header, dropped from the row")
        brief = " ".join(f"{k}={st[k]}" for k in ("n", "rms", "max", "over_thr_pct") if k in st)
        self.log(f"saved {name}: {brief or st.get('rows', '')} rows ({timing})")
        seen = dict(p.split("=", 1) for p in st.get("ctrl", "").split(";") if "=" in p)
        for probe in st_cfg.get("warn_if_high", []):
            if "1" in seen.get(probe, ""):
                self.log(f"WARNING {name}: {probe} was high during the capture")
        return st

    def close(self):
        """End every REPL in order. The stop file goes first: a Vivado that is still waiting for a trigger then
        returns within about a second instead of holding the "exit" back until its own timeout."""
        if self.viv and self.own_stop_file:
            try:
                open(self.stop_file, "w").close()
            except OSError:
                pass
        # the further Vivado clients first, the first one last: it is the one that puts the cable's clock back,
        # and that must be the last thing that happens to the cable
        hand_over_cable(self.viv, self.extra)
        for r in self.extra + [self.viv, self.xs]:
            if r:
                r.close()
        if self.own_stop_file:
            _unlink(self.stop_file)


def hand_over_cable(first, others):
    """Before the Vivado clients of a session are closed. Normally the first one puts the cable's clock back and
    the others leave it alone. When the first one is gone - crashed, killed, or no longer answering - nobody
    would: the cable then stays at a frequency that locks the next Vivado out (see ila_connect in the Tcl
    script), and what it was before the session is lost. The last of the others to close does it instead."""
    if not first or not (first.dead or first.p.poll() is not None):
        return
    found = getattr(first, "cable_found", None)
    alive = [r for r in others if r and not r.dead and r.p.poll() is None]
    if not found or not alive:
        return
    kill_tree(first.p)                           # it may be stuck in the middle of a JTAG command: it goes first
    try:
        alive[-1].cmd(f"set ::JTAG_ORIG {found[0]}; set ::JTAG_PROP {found[1]}; set ::JTAG_LEAVE 0", timeout=60)
    except RuntimeError:
        pass                                     # it is going either way


# ---------------------------------------------------------------- ELF helpers (hook mode)
def elf_symbol(prof, elf, name):
    """(address, size) of a symbol. The size matters: it tells the caller how many words the info struct has,
    so an older image with fewer fields still works."""
    out = subprocess.run([prof["tools"]["nm"], "-S", elf], capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 4 and parts[3] == name:
            return int(parts[0], 16), int(parts[1], 16)
    raise SystemExit(f"symbol {name} not found in {elf} - is the debug hook built into this image?")


def elf_callsites(prof, elf, name):
    """Addresses of every call to <name> in the disassembly. A breakpoint placed on the calling LINE in an IDE
    halts there, after the info struct has been written, so such a halt is as good as a halt inside the hook -
    and an IDE line breakpoint is what people actually set. The mnemonics come from the profile because the
    architecture decides them (bl on ARM, brlid on MicroBlaze, jal on RISC-V)."""
    out = subprocess.run([prof["tools"]["objdump"], "-d", elf], capture_output=True, text=True, check=True).stdout
    mnem = "|".join(re.escape(m) for m in prof["hook"].get("call_mnemonics") or ["bl"])
    pat = re.compile(r"^\s*([0-9a-f]+):.*?\b(?:" + mnem + r")\b[^<]*<" + re.escape(name) + r">\s*$", re.M)
    return {int(m.group(1), 16) for m in pat.finditer(out)}


def at_hook(pc, hook, size, calls):
    return hook <= pc < hook + size or pc in calls


def sx(x):
    return x - (1 << 32) if x >> 31 else x


# "Stopped: (Breakpoint) 0x00100000" - 8 hex digits on a 32-bit core, up to 16 on a 64-bit one
HALT_RE = re.compile(r"Stopped.* 0x([0-9a-f]{8,16})$")


# ---------------------------------------------------------------- commands
def cmd_check(args, prof):
    """Validate a profile offline: the mistakes it catches would otherwise surface minutes later, after
    Vivado has started, or halfway through an unattended session."""
    problems, notes = [], []
    hw, cap, h, st = prof["hardware"], prof["capture"], prof["hook"], prof["stats"]
    # Vivado is judged the way a run looks for it (resolve_vivado), so that nothing is reported here that a
    # capture would get past. xsct, nm and objdump have no such search: they must be where the profile says.
    vivado = prof["tools"].get("vivado", "")
    try:
        found = resolve_vivado(vivado)
        notes.append(f"tools.vivado: {found}" + ("" if found == vivado else
                                                 f" (found by searching; tools.vivado says {vivado or 'nothing'})"))
    except RuntimeError as e:
        problems.append(str(e))
    for exe in ("xsct", "nm", "objdump") if args.hook else ():
        p = prof["tools"].get(exe, "")
        (notes if os.path.exists(p) else problems).append(f"tools.{exe}: {p}" + ("" if os.path.exists(p) else " NOT FOUND"))
    if not hw.get("ltx"):
        problems.append("hardware.ltx is empty - the probe file of THIS bitstream is required")
    elif not os.path.exists(hw["ltx"]):
        problems.append(f"hardware.ltx not found: {hw['ltx']}")
    else:
        try:
            txt = open(hw["ltx"], encoding="utf-8", errors="replace").read()
            notes.append(f"hardware.ltx: {txt.count('<probe ')} probe entries, "
                         f"{re.search(r'HUB_CLK_INPUT_FREQ_HZ. value=.([0-9]+)', txt).group(1)} Hz hub clock"
                         if "HUB_CLK_INPUT_FREQ_HZ" in txt else f"hardware.ltx: {txt.count('<probe ')} probe entries")
        except Exception as e:
            notes.append(f"hardware.ltx could not be parsed ({e}) - it is still passed to Vivado as is")
    for key, val in (("hardware.ltx", hw.get("ltx")), ("capture.out", cap.get("out"))):
        if val and not os.path.isabs(val):
            problems.append(f"{key} is relative ({val}); paths are resolved against the current directory, "
                            f"so use an absolute path")
    if cap.get("trigger", "now") != "now" and len(str(cap["trigger"]).split()) != 2:
        problems.append(f"capture.trigger must be \"now\" or \"<probe> <compare-value>\", got {cap['trigger']!r}")
    for refused in (lambda: tcl_trigger(cap.get("trigger", "now")), lambda: capture_words(cap)):
        try:
            refused()                            # what a capture would be refused for
        except RuntimeError as e:
            problems.append(str(e))
    if not cap.get("sample_period_ns"):
        notes.append("capture.sample_period_ns is 0: times will be reported in samples, not us")
    f = int(hw.get("jtag_frequency_hz", 0) or 0)
    if f > 20_000_000:
        notes.append(f"hardware.jtag_frequency_hz is {f/1e6:.0f} MHz: above 20 MHz the readback was corrupt in "
                     f"testing. Watch for '[Labtools 27-3312] ... corrupted' and drop back.")
    elif f:
        notes.append(f"hardware.jtag_frequency_hz is {f/1e6:.0f} MHz (the cable default is usually 10 MHz)")
    if st.get("mode") == "magnitude" and not st.get("value_probe"):
        problems.append("stats.mode is 'magnitude' but stats.value_probe is empty")
    if args.hook or h.get("symbol") or h.get("info_symbol"):
        for key in ("symbol", "info_symbol", "name_template"):
            if not h.get(key):
                problems.append(f"hook.{key} is required for the hook command")
        if not h.get("magic"):
            problems.append("hook.magic is 0 - the target must write a non-zero magic word last")
        if h.get("mode") not in ("capture_now", "arm_and_collect_next"):
            problems.append(f"hook.mode must be capture_now or arm_and_collect_next, got {h.get('mode')!r}")
        if h.get("mode") == "arm_and_collect_next" and cap.get("trigger", "now") == "now":
            notes.append("hook.mode arm_and_collect_next with capture.trigger 'now': every window will be taken "
                         "immediately instead of on the event - usually a mistake")
        known = set(h.get("fields", [])) | {"run"}
        used = set(re.findall(r"\{([A-Za-z_][A-Za-z_0-9]*)", h.get("name_template", "")))
        if used - known:
            problems.append(f"hook.name_template uses {sorted(used - known)}, which are not in hook.fields")
        if h.get("sequence_field") and h["sequence_field"] not in h.get("fields", []):
            problems.append(f"hook.sequence_field {h['sequence_field']!r} is not in hook.fields")
        for f in h.get("signed_fields", []):
            if f not in h.get("fields", []):
                problems.append(f"hook.signed_fields has {f!r}, which is not in hook.fields")
        if args.elf:
            addr, size = elf_symbol(prof, args.elf, h["symbol"])
            info_addr, info_size = elf_symbol(prof, args.elf, h["info_symbol"])
            calls = elf_callsites(prof, args.elf, h["symbol"])
            notes.append(f"{h['symbol']} @0x{addr:08x}+{size}, call sites {[hex(c) for c in sorted(calls)]}")
            notes.append(f"{h['info_symbol']} @0x{info_addr:08x}, {info_size // 4} words for "
                         f"{1 + len(h.get('fields', []))} declared (magic + fields)")
            if info_size // 4 < 1 + len(h.get("fields", [])):
                problems.append("the info struct in this ELF is smaller than hook.fields declares - "
                                "stale ELF, or fields that the image does not have")
            if not calls:
                notes.append("no call site found: only a breakpoint inside the hook function will be recognised "
                             "(check hook.call_mnemonics for this architecture)")
    print(f"profile: {prof.get('name')}")
    for n in notes:
        print(f"  note:    {n}")
    for p in problems:
        print(f"  PROBLEM: {p}")
    print("OK" if not problems else f"{len(problems)} problem(s)")
    return 0 if not problems else 1


def cmd_info(args, prof):
    s = Session(args, prof, ephemeral=True)
    try:
        s.open_vivado()
        s.log("ILA cores: " + s.viv.cmd("ila_list", timeout=120))
        s.log("probes: " + s.viv.cmd("ila_probes", timeout=120))
    finally:
        s.close()


def cmd_capture(args, prof):
    """One capture, or --count of them in the same Vivado session (which is what makes repeated captures cheap:
    the process start-up dominates everything else)."""
    s = Session(args, prof)
    saved = 0
    try:
        s.open_vivado()
        for i in range(max(1, args.count)):
            name = args.name if args.count <= 1 else f"{args.name}_{i:03d}"
            try:
                s.capture(name, dict(note=args.note or ""))
                saved += 1
            except RuntimeError as e:
                s.log(f"{name}: NOT CAPTURED: {e}")     # a missed trigger must not end a long run
            if args.interval and i + 1 < args.count:
                time.sleep(args.interval)
    finally:
        s.close()
    return 0 if saved else 1                            # ... but a run that saved nothing did not succeed


def cmd_hook(args, prof):
    """Capture driven by a software hook.

    capture_now mode: at every halt take a capture of what the ILA holds (trigger_now), then resume. Good for
    steady-state measurements - a register sweep, anything where the interesting signal is present
    while the CPU sits at the breakpoint.

    arm_and_collect_next mode: at every halt collect the capture armed at the PREVIOUS halt, then arm the ILA on
    the trigger condition and resume. This is how you get one capture per software-initiated event (a self-test
    run, a DMA transfer, a message): the window is opened before the event and read after it."""
    h, cap = prof["hook"], prof["capture"]
    if not h.get("symbol") or not h.get("info_symbol"):
        raise SystemExit("profile.hook.symbol and profile.hook.info_symbol are required for the hook command")
    hook, hook_size = elf_symbol(prof, args.elf, h["symbol"])
    info, info_size = elf_symbol(prof, args.elf, h["info_symbol"])
    calls = elf_callsites(prof, args.elf, h["symbol"])
    n_words = min(1 + len(h["fields"]), max(1, info_size // 4))
    s = Session(args, prof)
    s.log(f"hook {h['symbol']} @0x{hook:08x}+{hook_size}, call sites {[hex(c) for c in sorted(calls)]}, "
          f"{h['info_symbol']} @0x{info:08x} ({n_words} words), mode {h.get('mode')}, output {s.out}")
    done, last_seq, run, pending = 0, None, 1, None
    t_end = time.time() + args.minutes * 60
    resume_at = {int(x, 0) for x in args.resume_at}
    try:
        s.open_vivado()
        s.open_xsct()
        if h.get("mode") == "arm_and_collect_next":
            s.viv.cmd("ila_arm " + tcl_trigger(args.trigger or cap["trigger"]) + " " + str(cap["position"]) +
                      " " + capture_words(cap)[0], timeout=120)
        s.log("waiting for the core to halt at the hook (Ctrl-C to stop)")
        while done < args.count and time.time() < t_end:
            st = s.xs.cmd("core_state", timeout=60)
            m = HALT_RE.search(st)
            if not m:
                time.sleep(0.2)
                continue
            pc = int(m.group(1), 16)
            if not at_hook(pc, hook, hook_size, calls):
                if args.plant:
                    s.xs.cmd(f"add_bp 0x{hook:08x}", timeout=60, check=False)
                    args.plant = False
                    s.log(f"planted a hardware breakpoint at 0x{hook:08x} while halted at 0x{pc:08x}")
                if pc in resume_at:
                    s.log(f"halted at 0x{pc:08x} (--resume-at): resuming")
                    s.xs.cmd("resume", timeout=60)
                    resume_at.discard(pc)
                time.sleep(0.3)
                continue
            w = [int(x, 16) for x in s.xs.cmd(f"read_words 0x{info:08x} {n_words}", timeout=60).split()]
            if w[0] != h["magic"]:
                s.log(f"halted at the hook but magic is 0x{w[0]:08x} - resuming without a capture")
                s.xs.cmd("resume", timeout=60)
                continue
            fields = {name: (sx(w[i + 1]) if name in h.get("signed_fields", []) else w[i + 1])
                      for i, name in enumerate(h["fields"]) if i + 1 < len(w)}
            seq = fields.get(h.get("sequence_field"), done)
            ended = h.get("end_value") is not None and seq == int(str(h["end_value"]), 0)
            if seq == last_seq and not ended:
                s.xs.cmd("resume", timeout=60)       # a second breakpoint inside the same hook call
                continue
            if last_seq is not None and not ended and seq < last_seq:
                run += 1
                s.log(f"sequence went back to {seq}: the target rebooted, run {run}")
                pending = None
                s.log("ILA: " + s.viv.cmd(f"ila_refresh {tcl_path(prof['hardware']['ltx'])}", timeout=600))
            last_seq = seq
            if h.get("mode") == "arm_and_collect_next":
                if pending is not None:
                    # the capture is named after the event that was armed; the fields read at THIS halt are
                    # kept too (prefixed now_), because that is where the target reports how the event ended
                    name = h["name_template"].format(run=run, **pending)
                    meta = dict(pending, **{f"now_{k}": v for k, v in fields.items()})
                    try:
                        s.capture(name, meta, armed=True)
                        done += 1
                    except RuntimeError as e:
                        s.log(f"{name}: NOT CAPTURED: {e}")
                if ended:
                    s.log("end marker reached")
                    pending = None
                    s.xs.cmd("resume", timeout=60)
                    break
                s.viv.cmd("ila_arm " + tcl_trigger(args.trigger or cap["trigger"]) + " " +
                          str(cap["position"]) + " " + capture_words(cap)[0], timeout=120)
                pending = fields
            else:
                if ended:
                    break
                s.capture(h["name_template"].format(run=run, **fields), fields)
                done += 1
            s.xs.cmd("resume", timeout=60)
        s.log(f"finished: {done} captures in {s.out}")
    except KeyboardInterrupt:
        s.log("stopped by user")
    except Exception as e:
        s.log(f"ERROR: {e}")
    finally:
        # never leave the target halted at the hook: it would stall the system under test
        try:
            if s.xs:
                st = s.xs.cmd("core_state", timeout=60, check=False)
                m = HALT_RE.search(st)
                if m and at_hook(int(m.group(1), 16), hook, hook_size, calls):
                    s.xs.cmd("resume", timeout=60, check=False)
                    s.log("the core was halted at the hook: resumed")
        except Exception as e:
            s.log(f"could not check/resume the core: {e}")
        s.close()


# Vivado writes the core status with spaces ("WAITING FOR TRIGGER"), so it is normalised before comparing.
STATUS_ARMED = ("WAITING_FOR_TRIGGER", "PRE_TRIGGER", "POST_TRIGGER", "TRIGGERED", "TRIGGER_IN_PIPELINE", "FULL")


def norm_status(st):
    return re.sub(r"[^A-Z0-9]+", "_", (st or "").strip().upper()).strip("_")


def has_data_rows(path):
    """True when the capture file holds at least one sample. An upload from a core that never triggered
    produces a header-only file, and counting that as a capture would quietly inflate every later number."""
    try:
        text = read_ila_text(path)
    except Exception:
        return False
    for line in text.splitlines()[1:]:
        if is_data_row(line.split(",")):
            return True
    return False


def watch_fields(st_cfg):
    """One fixed set of index columns for the whole session. Computing them per row instead lets a degenerate
    capture (no valid samples, so no mean/rms) write its values under the previous row's header."""
    return (["time", "name", "file", "target", "trigger", "position", "core_status"]
            + list(STAT_COLS)
            + [f"n_{p}" for p in st_cfg.get("event_probes", [])]
            + ["upload_ms", "rearm_ms", "write_ms", "bytes", "note"])


def _watch_stats_row(index, fields, row, src, st_cfg, compress, formats=None):
    """The formats asked for per probe, statistics, optional compression and the index row for one watched
    capture - all off the capture thread, so none of it slows the cadence. A row is written even when the
    statistics fail: a missing row would be indistinguishable from a window that was never captured."""
    try:
        if formats and src.lower().endswith(".csv"):
            ila_csv_format(src, formats)
    except Exception as e:
        row["note"] = f"format failed: {type(e).__name__}: {e}"[:200]
    try:
        row.update({k: v for k, v in stats_of(src, st_cfg).items() if k in fields})
    except Exception as e:
        row["note"] = f"stats failed: {type(e).__name__}: {e}"[:200]
    try:
        if compress and src.lower().endswith(".csv"):
            src = gzip_file(src)
        row["file"] = os.path.basename(src)
        row["bytes"] = os.path.getsize(src)
    except Exception as e:
        row["note"] = ((row.get("note") or "") + f" | compress failed: {e}")[:200]
    with open(index, "a", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", restval="").writerow(row)
    return row.get("note")


def cmd_watch(args, prof):
    """Record continuously until a limit is reached.

    One client: wait for the trigger -> upload -> RE-ARM -> write. Re-arming before the write matters because
    the write is the slowest step, so the ILA is collecting again while the file is being formatted.

    Several clients (--writers): each Vivado process takes every Nth window and formats its own file while the
    next client arms and uploads. The JTAG path is still serial - only the writes overlap - so the floor is the
    upload. Measured on a deep, wide core (32k samples, a few hundred probe bits) at 20 MHz TCK: upload 0.64 s,
    write 1.22 s, and therefore 1.94 s per window with one client, about 1.0 s with two and about 0.7 s (the
    upload floor) with three.

    What this cannot do is record everything: an ILA holds DATA_DEPTH samples and JTAG carries them away far
    more slowly than the fabric produces them, so coverage = JTAG throughput / (ILA clock x probe width),
    independent of the buffer depth. The summary reports both the fraction of the timeline captured and the
    fraction of time the ILA was armed; the second is what says how many events were missed."""
    cap, st_cfg = prof["capture"], prof["stats"]
    trig = args.trigger or cap["trigger"]
    pos = cap["position"]
    fmt = args.format or "csv"
    radix, cmode = capture_words(cap)
    arm_cmd = f"ila_arm {tcl_trigger(trig)} {pos} {radix} {cmode}"
    n_clients = max(1, args.writers)
    collect_cmd = f"ila_collect_rearm {tcl_trigger(trig)} {pos} {args.wait} {radix} {cmode} {1 if n_clients == 1 else 0}"
    s = Session(args, prof)
    fields = watch_fields(st_cfg)
    with open(s.index, "w", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=fields).writeheader()
    s.log(f"watch: trigger {{{trig}}}, position {pos}, format {fmt}{' + gzip' if args.compress else ''}, "
          f"writers {n_clients}, limits: count={args.count} minutes={args.minutes} max_gb={args.max_gb}")
    n, waited, on_disk, retries, recoveries, empties = 0, 0.0, 0, 0, 0, 0
    t_start = time.monotonic()                 # monotonic: a host that sleeps must not end the session early
    t_end = t_start + args.minutes * 60
    cycle, upload_ms, rearm_ms, write_ms = [], [], [], []
    last_beat, last_trigger, last_status, lost = t_start, t_start, "?", 0
    depth, core_id = 0, ""
    # separate pools: a write must never wait for a statistics thread, and vice versa
    wpool = concurrent.futures.ThreadPoolExecutor(max_workers=n_clients)
    spool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
    pending, writing = [], {}

    def drain(block=False):
        """Report worker failures while the session is still running, and keep `pending` bounded."""
        nonlocal pending
        done = [f for f in pending if f.done() or block]
        for f in done:
            try:
                note = f.result(timeout=300 if block else None)
                if note:
                    s.log(f"WARNING {note}")
            except Exception as e:
                s.log(f"WARNING statistics worker failed: {e}")
        pending = [f for f in pending if f not in done]

    def free(viv):
        """Wait until this client has finished the file it was writing. A Vivado client speaks one command at
        a time: driving it from two threads crosses the replies, which is silent corruption, not an error."""
        nonlocal retries
        fut = writing.pop(id(viv), None)
        if fut is None:
            return
        try:
            w = fut.result(timeout=600)
            if "write_ms" in w:
                write_ms.append(float(dict(p.split("=", 1) for p in w.split(";") if "=" in p)["write_ms"]))
        except Exception as e:
            retries += 1
            s.log(f"write failed on {viv.name}: {str(e)[:150]}")

    try:
        info = s.open_vivado()
        core_id = ";".join(p for p in info.split(";") if p.startswith(("CELL_NAME=", "CONTROL.DATA_DEPTH=", "PROBES=")))
        depth = int(dict(p.split("=", 1) for p in info.split(";") if "=" in p).get("CONTROL.DATA_DEPTH", 0))
        if not depth * cap.get("sample_period_ns", 0):
            s.log("capture.sample_period_ns is 0: the summary can only report windows, not seconds of signal")
        s.log(f"{shutil.disk_usage(s.out).free/1e9:.1f} GB free on the output drive")
        clients = [s.viv] + [s.open_extra_vivado(f"-{i+2}") for i in range(n_clients - 1)]
        if n_clients > 1:
            s.log(f"{n_clients} Vivado clients take turns: each writes its own file while the next one captures")
        s.log("waiting for triggers (Ctrl-C to stop)")
        while n < args.count and time.monotonic() < t_end and on_disk < args.max_gb * 1e9:
            t0 = time.monotonic()
            viv = clients[n % n_clients]
            free(viv)                                   # this client must be idle before we speak to it
            try:
                if n_clients > 1 or n == 0:
                    t_arm = time.monotonic()
                    viv.cmd(arm_cmd, timeout=120)       # with one client the collect re-arms, so only arm once
                    if n_clients > 1:
                        rearm_ms.append(1000 * (time.monotonic() - t_arm))
                r = viv.cmd(collect_cmd, timeout=600)
                lost = 0
            except RuntimeError as e:
                # a mid-session failure is usually the board being power-cycled: the PL is reconfigured and
                # every handle is stale. Recover rather than ending a run meant to last hours.
                lost += 1
                retries += 1
                s.log(f"{viv.name} failed ({str(e)[:120]}) - recovery attempt {lost}/{args.max_retries}")
                if lost > args.max_retries:
                    s.log(f"giving up after {lost} consecutive failures")
                    break
                time.sleep(min(30, 2 ** lost))
                recoveries += _watch_recover(s, prof, arm_cmd, core_id, fields, n, viv)
                continue
            d = dict(p.split("=", 1) for p in r.split(";") if "=" in p)
            if "armed=1" in r:
                last_status = d.get("status", "?")
                waited += time.monotonic() - t0
                if norm_status(last_status) not in STATUS_ARMED:
                    # e.g. IDLE: the arm was lost (a reconfigured PL answers happily but is not armed)
                    s.log(f"core status {last_status} while waiting: the arm was lost, recovering")
                    retries += 1
                    recoveries += _watch_recover(s, prof, arm_cmd, core_id, fields, n, viv)
                if time.monotonic() - last_beat > args.heartbeat:
                    last_beat = time.monotonic()
                    s.log(f"heartbeat: {n} captures, core {last_status}, "
                          f"{time.monotonic()-last_trigger:.0f} s since the last trigger, "
                          f"{on_disk/1e9:.2f} GB on disk")
                continue
            last_status, last_trigger = d.get("status", "FULL"), time.monotonic()
            name = f"w{n:06d}"
            prefix = os.path.join(s.out, name)
            row = dict(time=datetime.datetime.now().isoformat(timespec="seconds"), name=name, target=args.target,
                       trigger=trig, position=pos, core_status=d.get("status", ""),
                       upload_ms=d.get("upload_ms", ""), rearm_ms=d.get("rearm_ms", ""))
            fut = wpool.submit(viv.cmd, f"ila_write_last {tcl_path(prefix)} {fmt}", 600)
            writing[id(viv)] = fut
            if n_clients == 1:
                free(viv)                               # one client: nothing else can run meanwhile anyway
                row["write_ms"] = write_ms[-1] if write_ms else ""
            # the statistics wait for that client's write, so the capture loop never touches a half-written file
            pending.append(spool.submit(_watch_row_when_written, s.index, fields, row, prefix, st_cfg,
                                        args.compress, fut, s.probe_formats()))
            cycle.append(time.monotonic() - t0)
            for key, acc in (("upload_ms", upload_ms), ("rearm_ms", rearm_ms)):
                if key in d:
                    acc.append(float(d[key]))
            n += 1
            drain()
            if n % 20 == 0 or n == 1:
                on_disk = folder_bytes(s.out)
                free_gb = shutil.disk_usage(s.out).free
                if time.monotonic() - last_beat > args.heartbeat or n == 1 or n % 100 == 0:
                    last_beat = time.monotonic()
                    s.log(f"{n} captures, {on_disk/1e9:.2f} GB on disk, {free_gb/1e9:.1f} GB free, cycle median "
                          f"{statistics.median(cycle):.2f} s")
                if free_gb < args.min_free_gb * 1e9:
                    s.log(f"stopping: only {free_gb/1e9:.1f} GB free (--min-free-gb {args.min_free_gb})")
                    break
    except KeyboardInterrupt:
        s.log("stopped by user")
    except Exception as e:
        s.log(f"ERROR: {type(e).__name__}: {e}")
    finally:
        for viv in list(writing):
            try:
                writing[viv].result(timeout=600)
            except Exception:
                pass
        writing.clear()
        drain(block=True)
        wpool.shutdown(wait=False)
        spool.shutdown(wait=False)
        try:
            if s.viv:
                s.viv.cmd("reset_hw_ila [ila_obj]", timeout=60, check=False)   # leave the core idle, not armed
        except Exception:
            pass
        wall = time.monotonic() - t_start
        on_disk = folder_bytes(s.out) if os.path.isdir(s.out) else 0
        win_s = depth * cap.get("sample_period_ns", 0) / 1e9
        # printed even when nothing was captured: silence must not look like "no events happened"
        line = f"{n} windows in {wall:.0f} s"
        if win_s:
            line += (f" x {win_s*1e6:.0f} us = {n*win_s:.3f} s of signal "
                     f"({100*n*win_s/wall:.3f} % of the timeline)")
        s.log(line + f", {on_disk/1e9:.2f} GB on disk, {on_disk/1e9/max(wall/3600, 1e-9):.2f} GB/hour")
        if cycle:
            deaf = (statistics.median(upload_ms or [0]) + statistics.median(rearm_ms or [0])) / 1000.0
            # (a median of 0 s is a clock too coarse to time the windows, not a session without deaf time:
            # nothing may raise here, the orderly close of Vivado follows)
            armed = max(0.0, 100 * (1 - deaf / statistics.median(cycle))) if statistics.median(cycle) > 0 else 0.0
            s.log(f"cycle median {statistics.median(cycle):.2f} s (upload {statistics.median(upload_ms or [0]):.0f} ms, "
                  f"re-arm {statistics.median(rearm_ms or [0]):.0f} ms, write {statistics.median(write_ms or [0]):.0f} ms); "
                  f"the ILA was armed for about {armed:.0f} % of the session, so events in the other "
                  f"{100-armed:.0f} % were not seen - counts from this session are a lower bound")
        if not n:
            s.log(f"NOTHING WAS CAPTURED. Last core status {last_status}, waited {waited:.0f} s. Check that the "
                  f"trigger {{{trig}}} can actually occur, that the ILA clock is running, and that the core is "
                  f"the one you meant ({core_id or 'core identity unknown'}).")
        if retries or recoveries:
            s.log(f"{retries} failure(s), {recoveries} recovery/recoveries during the session")
        s.log(f"output: {s.out}")
        s.close()


def _watch_row_when_written(index, fields, row, prefix, st_cfg, compress, write_future, formats=None):
    """Wait for the client that owns this window to finish writing it, then compute the statistics, compress
    and append the index row. Always writes a row: a missing row would be indistinguishable from a window that
    was never captured."""
    def put(r):
        with open(index, "a", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", restval="").writerow(r)
        return r.get("note")

    try:
        w = write_future.result(timeout=600)
        row.update({k: v for k, v in (p.split("=", 1) for p in w.split(";") if "=" in p) if k in fields})
    except Exception as e:
        row["note"] = f"{row['name']}: write failed: {type(e).__name__}: {e}"[:200]
        return put(row)
    src = next((p for p in (prefix + e for e in (".csv", ".ila")) if os.path.exists(p)), None)
    if src is None:
        row["note"] = f"{row['name']}: the file never appeared"
        return put(row)
    if not has_data_rows(src):
        # the core said FULL but the upload carried no samples: do not let an empty file count as a capture
        row["note"] = f"{row['name']}: upload contained no samples - file discarded"
        _unlink(src)
        return put(row)
    return _watch_stats_row(index, fields, row, src, st_cfg, compress, formats)


def _watch_recover(s, prof, arm_cmd, core_id, fields, n, viv=None):
    """Re-read the ILA after a failure or a lost arm, check it is still the same core, re-arm, and leave a
    marker in index.csv so a gap in the recording is visible later. Returns 1 when a recovery was made."""
    viv = viv or s.viv
    try:
        info = viv.cmd(f"ila_refresh {tcl_path(prof['hardware']['ltx'])}", timeout=600)
        now_id = ";".join(p for p in info.split(";") if p.startswith(("CELL_NAME=", "CONTROL.DATA_DEPTH=", "PROBES=")))
        if core_id and now_id != core_id:
            s.log(f"WARNING the ILA core changed during the session: was [{core_id}], now [{now_id}] - "
                  f"captures before and after this point are not from the same design")
        viv.cmd(arm_cmd, timeout=120)
        s.log("re-armed after recovery")
        with open(s.index, "a", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", restval="").writerow(
                dict(time=datetime.datetime.now().isoformat(timespec="seconds"), name=f"(recovery before w{n:06d})",
                     note="ILA re-read and re-armed; the recording has a gap here" +
                          ("; CORE CHANGED" if core_id and now_id != core_id else "")))
        return 1
    except RuntimeError as e:
        s.log(f"recovery failed: {str(e)[:150]}")
        return 0


def _convert_one(job):
    src, dst = job
    return dst, ila_csv_to_decimal(src, dst)


def cmd_convert(args, prof):
    """Make ILA CSVs decimal. For a folder: extract a CSV from every .ila that has none, convert every ILA CSV
    in place. For a file: convert it in place. .ila archives are never modified - they stay the ground truth."""
    jobs = []
    for path in expand(args.paths):
        if os.path.isdir(path):
            names = set(os.listdir(path))
            for f in sorted(names):
                full = os.path.join(path, f)
                if f.endswith(".ila") and f[:-4] + ".csv" not in names:
                    jobs.append((full, full[:-4] + ".csv"))
                elif f.lower().endswith((".csv", ".csv.gz")) and is_ila_csv(full):
                    jobs.append((full, full))
        elif path.lower().endswith(".csv") and is_ila_csv(path):
            jobs.append((path, path))
        else:
            print(f"skipped (not an ILA CSV): {path}")
    print(f"{len(jobs)} ILA CSV(s) to check")
    converted = 0
    with concurrent.futures.ProcessPoolExecutor(max_workers=max(1, min(8, (os.cpu_count() or 2) - 1))) as ex:
        for i, (dst, cols) in enumerate(ex.map(_convert_one, jobs), 1):
            converted += bool(cols)
            if i % 50 == 0 or i == len(jobs):
                print(f"[{i}/{len(jobs)}]", flush=True)
    print(f"{converted} CSV(s) written in decimal, {len(jobs) - converted} already decimal")


def capture_summary(path, prof):
    """Per-capture timeline: the trigger sample is the time origin, rising/falling edges of the event probes are
    reported relative to it (in us when capture.sample_period_ns is set, in samples otherwise)."""
    st_cfg, per = prof["stats"], prof["capture"].get("sample_period_ns", 0)
    hdr, rows, rad = load_ila(path)
    if not rows:
        return {}
    it = probe_index(hdr, "TRIGGER") if any(c.strip() == "TRIGGER" for c in hdr) else None
    trig = next((k for k, r in enumerate(rows) if it is not None and r[it] == "1"), 0)
    unit = (lambda k: round((k - trig) * per / 1000.0, 2)) if per else (lambda k: k - trig)
    out = {"n_rows": len(rows), "time_unit": "us" if per else "samples"}
    for name in st_cfg.get("event_probes", []) + st_cfg.get("ctrl_probes", []):
        try:
            i = probe_index(hdr, name)
        except KeyError:
            continue
        ups, downs = rising_edges(rows, i), falling_edges(rows, i)
        out[f"{name}_n"] = len(ups)
        out[f"{name}_first"] = unit(ups[0]) if ups else ""
        out[f"{name}_last_off"] = unit(downs[-1]) if downs else ""
    out.update({k: v for k, v in stats_of(path, st_cfg).items() if k in ("rms", "max", "over_thr_pct", "ctrl")})
    return out


def cmd_summary(args, prof):
    files = sorted(f for f in os.listdir(args.dir) if f.endswith((".ila", ".csv", ".csv.gz")))
    seen, rows = set(), []
    for f in files:
        name = f[:-7] if f.endswith(".csv.gz") else f[:-4]
        if name in seen or f.startswith("index."):
            continue
        seen.add(name)
        src = next((os.path.join(args.dir, name + ext) for ext in (".csv", ".csv.gz", ".ila")
                    if os.path.exists(os.path.join(args.dir, name + ext))), None)
        if src is None or (not src.endswith(".ila") and not is_ila_csv(src)):
            continue
        rows.append(dict(name=name, **capture_summary(src, prof)))
        if len(rows) % 25 == 0:
            print(f"[{len(rows)}/{len(seen)}]", flush=True)
    if not rows:
        print("no captures found")
        return
    out = os.path.join(args.dir, "run_summary.csv")
    keys = list({k: None for r in rows for k in r})
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader(); w.writerows(rows)
    print(f"wrote {out} ({len(rows)} captures)")


def cmd_stats(args, prof):
    rows = [(os.path.basename(f), stats_of(f, prof["stats"])) for f in expand(args.files)]
    keys = list(dict.fromkeys(k for _, st in rows for k in st))       # union: a column present in only one
    header = [k for k in STAT_COLS if k in keys] + [k for k in keys if k.startswith("n_")]
    w = csv.writer(sys.stdout, lineterminator="\n")     # stdout is a text stream: "\r\n" would end up as "\r\r\n"
    w.writerow(["file"] + header)
    for name, st in rows:
        w.writerow([name] + [st.get(k, "") for k in header])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", help="JSON profile with the project's paths, probes and hook (see profiles/)")
    ap.add_argument("--out", help="output folder (default from the profile)")
    # hardware overrides: with these a profile is optional - any .ltx can be used straight from the command line
    ap.add_argument("--ltx", help="probe file (.ltx) of the bitstream on the board; overrides profile.hardware.ltx")
    ap.add_argument("--tcl", help="Tcl script to use instead of the default scripts/vivado_ila_repl.tcl")
    ap.add_argument("--server", help="hw_server <ip>[:port] (the PC the JTAG cable is attached to); default port 3121")
    ap.add_argument("--device", help="device glob when the chain has several parts, e.g. 'xc7z020*'")
    ap.add_argument("--ila-index", type=int, help="which ILA core of the device ('info' lists them)")
    ap.add_argument("--jtag-hz", type=int, help="JTAG TCK frequency in Hz, e.g. 20000000 (0 = cable default)")
    ap.add_argument("--target", default="unit", help="board name, used in the session folder name")
    # these three may be given before or after the subcommand; SUPPRESS keeps the subparser copy from
    # overwriting a value given globally
    over = argparse.ArgumentParser(add_help=False)
    for a in (ap, over):
        d = {} if a is ap else {"default": argparse.SUPPRESS}
        a.add_argument("--trigger", help='"now" or "<probe> <compare-value>", e.g. "frame_start eq1\'bR"', **d)
        a.add_argument("--position", type=int, help="trigger position in samples", **d)
        a.add_argument("--format", choices=["both", "ila", "csv"], help="what to write per capture", **d)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("info")
    ck = sp.add_parser("check"); ck.add_argument("--elf", help="also check the hook symbols in this ELF")
    ck.add_argument("--hook", action="store_true", help="require the hook fields even if no hook is configured")
    c = sp.add_parser("capture", parents=[over]); c.add_argument("--name", required=True); c.add_argument("--note")
    c.add_argument("--count", type=int, default=1, help="take this many captures in one session")
    c.add_argument("--interval", type=float, default=0, help="seconds to wait between captures")
    wt = sp.add_parser("watch", parents=[over])
    wt.add_argument("--count", type=int, default=1000000, help="stop after this many captures")
    wt.add_argument("--minutes", type=float, default=60)
    wt.add_argument("--max-gb", type=float, default=10.0, help="stop when the session folder reaches this size")
    wt.add_argument("--wait", type=float, default=0.02,
                    help="minutes wait_on_hw_ila blocks per poll (0.02 = 1.2 s); shorter reacts faster, longer polls less")
    wt.add_argument("--max-retries", type=int, default=5,
                    help="consecutive failures tolerated (a board power cycle costs one) before stopping")
    wt.add_argument("--heartbeat", type=float, default=60.0,
                    help="seconds between progress lines, so a session that captures nothing still says so")
    wt.add_argument("--min-free-gb", type=float, default=2.0, help="stop when the output drive falls below this")
    wt.add_argument("--writers", type=int, default=1,
                    help="Vivado clients taking turns (2 hides the file write behind the next upload: measured "
                         "0.80 s per window against 1.95 s, at the cost of a second Vivado process)")
    wt.add_argument("--compress", dest="compress", action="store_true", default=True,
                    help="gzip each CSV in the background (default): CSV write speed, .ila-like size")
    wt.add_argument("--no-compress", dest="compress", action="store_false")
    k = sp.add_parser("hook", parents=[over]); k.add_argument("--elf", required=True)
    k.add_argument("--count", type=int, default=1000, help="stop after this many captures")
    k.add_argument("--minutes", type=int, default=60)
    k.add_argument("--plant", action="store_true", help="plant the hook breakpoint from xsct at the first halt")
    k.add_argument("--resume-at", nargs="*", default=[], help="addresses where an unrelated halt is resumed once")
    v = sp.add_parser("convert"); v.add_argument("paths", nargs="+")
    u = sp.add_parser("summary"); u.add_argument("dir")
    t = sp.add_parser("stats"); t.add_argument("files", nargs="+")
    args = ap.parse_args()
    for a in ("trigger", "position", "format"):
        args.__dict__.setdefault(a, None)
    try:
        prof = apply_overrides(load_profile(args.profile), args)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{args.profile}: invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}")
    if args.position is not None:
        # into the profile, once, where every command reads it: taken as "args.position or the profile's" at each
        # use, --position 0 counted as not given
        prof["capture"]["position"] = args.position
    rc = {"info": cmd_info, "check": cmd_check, "capture": cmd_capture, "hook": cmd_hook, "watch": cmd_watch,
          "convert": cmd_convert, "summary": cmd_summary, "stats": cmd_stats}[args.cmd](args, prof)
    sys.exit(rc or 0)


if __name__ == "__main__":
    main()
