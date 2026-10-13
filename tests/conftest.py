# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Fixtures shared by the tests. No test needs Vivado, a board or a network: the files a test reads are written
into pytest's tmp_path first, and where the driver would start Vivado a recorder takes its place."""
import gc
import glob
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tracemalloc
import types
import zipfile

import pytest

import ila_bridge
import ila_capture

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def nothing_is_written_into_the_project(monkeypatch, tmp_path):
    """The bridge keeps its log, its captures and its profiles next to itself, and the driver's default capture
    folder is fixed at import, in the working directory. For every test all of them are inside tmp_path."""
    monkeypatch.setattr(ila_bridge, "PROFILES_DIR", str(tmp_path / "profiles"))
    monkeypatch.setattr(ila_bridge, "CAPTURES_DIR", str(tmp_path / "captures"))
    monkeypatch.setattr(ila_bridge, "LOG_FILE", str(tmp_path / "ila_log.txt"))
    monkeypatch.setitem(ila_capture.DEFAULT_PROFILE["capture"], "out", str(tmp_path / "captures"))


@pytest.fixture
def write(tmp_path):
    """write("cap.csv", text) puts a file into tmp_path, byte for byte, and returns its path. A name ending in
    ".gz" is gzipped, and one ending in ".ila" becomes the archive Vivado writes: a zip whose waveform.csv is
    the text."""
    def write_file(name, text):
        path = str(tmp_path / name)
        if name.endswith(".ila"):
            with zipfile.ZipFile(path, "w") as z:
                z.writestr("waveform.csv", text)
        else:
            with (gzip.open if name.endswith(".gz") else open)(path, "wb") as f:
                f.write(text.encode("utf-8"))
        return path
    return write_file


@pytest.fixture(params=["as shipped", "in small pieces"])
def pieces(request, monkeypatch):
    """A test that uses this runs twice: with the sizes the driver ships with - a capture file is read a MB at a
    time and worked on 2048 rows at a time, which is more than any file of the tests holds - and with sizes so
    small that every file is many pieces and every sample a block of its own. A result must not depend on where
    a piece ends."""
    if request.param == "in small pieces":
        monkeypatch.setattr(ila_capture, "CHUNK_BYTES", 7)
        monkeypatch.setattr(ila_capture, "KNOWN_VALUES", 1)
        monkeypatch.setattr(ila_capture.blocks, "__defaults__", (1,))
    return request.param


@pytest.fixture(scope="session")
def long_capture():
    """The text of a capture of 4000 samples: the sample numbers, TRIGGER at sample 7, a 1-bit probe and 30
    buses of 16 bits in hex, as Vivado exports them by default. 0.6 MB, which a reader that is given small
    pieces to work with (see held) must not hold whole."""
    buses = ",".join("top/u1/bus_%d[15:0]" % i for i in range(30))
    return "Sample in Buffer,Sample in Window,TRIGGER,top/en," + buses + "\n" + "".join(
        "%d,%d,%d,%d,%s\n" % (k, k, k == 7, k & 1, ",".join("%04x" % (k * (i + 3) & 0xFFFF) for i in range(30)))
        for k in range(4000))


@pytest.fixture
def held(monkeypatch):
    """held(f, *args) runs f(*args) with the driver reading 16 KB, working on 64 rows and remembering 64 values
    of a column at a time, and returns (what f returned, the most bytes Python held at any one moment while it
    ran)."""
    def measure(f, *args):
        monkeypatch.setattr(ila_capture, "CHUNK_BYTES", 1 << 14)
        monkeypatch.setattr(ila_capture, "KNOWN_VALUES", 64)
        monkeypatch.setattr(ila_capture.blocks, "__defaults__", (64,))
        gc.collect()
        tracemalloc.start()
        try:
            return f(*args), tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
    return measure


# What the Tcl side answers to the commands whose answer the driver reads (see scripts/vivado_ila_repl.tcl).
CORE = "NAME=hw_ila_1;CELL_NAME=u_ila_0;CONTROL.DATA_DEPTH=1024;PROBES=2;DEVICE=xc7z020_1;JTAG_FREQ_HZ=10000000"
ANSWERS = {
    "ila_open": CORE, "ila_info": CORE, "ila_select": CORE, "ila_recheck": CORE,
    "ila_list": "0=u_ila_0(depth 1024)",
    "ila_probes": "top/u1/rx_valid[1];top/u1/data[8]",
    "list": "10000000 PARAM.FREQUENCY",                    # "list $::JTAG_ORIG $::JTAG_PROP"
    "ila_capture": "wait_ms=1;upload_ms=1;write_ms=1",
    "ila_collect_rearm": "status=FULL;upload_ms=1;rearm_ms=1",
    "ila_write_last": "write_ms=1",
}
# The file Vivado would write for a capture: two samples, the bus in hex without a prefix (its default export).
UPLOAD = "Sample in Buffer,Sample in Window,TRIGGER,top/u1/rx_valid,top/u1/data[7:0]\n0,0,1,0,0a\n1,1,0,1,ff\n"


class Sent(list):
    """The Tcl commands the driver sent, in order. answers: what is answered, by the first word of a command; a
    list is answered item by item, its last item from then on. failing: the commands that fail instead, by their
    first word, with the reason the Tcl side gives (the answer, for a caller that looks at it itself) - or with
    the exception that is raised while the answer is awaited (KeyboardInterrupt: Ctrl-C). script: what the Tcl
    script says about itself when the driver asks (its version and what it lacks). started: the command line of
    every process the driver would have started, by the name it gave it. to: the commands by the process they
    went to ("vivado", "xsct"); where the driver lines the answers of a process up again (Repl.resync),
    "(resync)" stands among them."""
    def __init__(self):
        list.__init__(self)
        self.answers = dict(ANSWERS)
        self.failing = {}
        self.script = "version=%d;missing=" % ila_capture.SCRIPT_VERSION
        self.started = {}
        self.to = {}


@pytest.fixture
def vivado(monkeypatch, tmp_path):
    """Vivado and xsct replaced by a recorder; the fixture is the list of what the driver sent them (see Sent).
    Nothing is started. A command that makes Vivado write a capture writes UPLOAD as its CSV."""
    sent = Sent()

    class Recorder:
        def __init__(self, argv, name, log):
            self.name, self.dead, self.writing = name, False, None
            ila_capture.cmd_line(argv)                     # what the Repl would refuse to start is refused here
            sent.started[name] = list(argv)
            self.p = types.SimpleNamespace(pid=0, poll=lambda: None)

        def cmd(self, tcl, timeout=600, check=True):
            if len(sent) >= 1000:                          # a loop of the driver that does not end: fail, not hang
                raise RuntimeError("the recorder was sent more than 1000 commands")
            sent.append(tcl)
            sent.to.setdefault(self.name, []).append(tcl)
            word = tcl.split(" ")[0]
            if isinstance(sent.failing.get(word), BaseException):
                raise sent.failing[word]
            if word in sent.failing:
                if not check:                              # as the Repl does: the reason is the answer then
                    return sent.failing[word]
                raise RuntimeError("%s: '%s' failed: %s" % (self.name, tcl, sent.failing[word]))
            if word == "ila_collect_rearm":
                # An upload takes time. "watch" divides by the time a window took, and the clock it reads is
                # coarse on Windows before Python 3.13 (about 16 ms): answered at once, a window would take none.
                time.sleep(0.05)
            if word in ("ila_capture", "ila_write_last"):
                prefix = re.match(r"\w+ \{(.*?)\}", tcl).group(1)
                with open(prefix + ".csv", "wb") as f:
                    f.write(UPLOAD.encode("ascii"))
            if tcl.startswith("set ::ILA_CHECK"):          # the question about the script's version
                return sent.script
            answer = sent.answers.get(word, "")
            if isinstance(answer, list):
                answer = answer.pop(0) if len(answer) > 1 else answer[0]
            return "0" if tcl == "set ::ILA_INDEX" else answer

        def resync(self, timeout=60):
            sent.to.setdefault(self.name, []).append("(resync)")
            if "(resync)" in sent.failing:                 # the process no longer answers
                raise RuntimeError(sent.failing["(resync)"])

        def settle(self, timeout=660):
            pass

        def close(self):
            pass

    monkeypatch.setattr(ila_capture, "Repl", Recorder)
    monkeypatch.setattr(ila_capture, "resolve_vivado", lambda path: "vivado")
    # a session keeps its stop file in the folder for temporary files: that one is in tmp_path as well
    monkeypatch.setattr(ila_capture.tempfile, "gettempdir", lambda: str(tmp_path))
    return sent


@pytest.fixture
def cli(monkeypatch):
    """cli("--ltx", "top.ltx", "capture", "--name", "c") runs that command line of ila_capture.py in this
    process and returns its exit code."""
    def run(*argv):
        monkeypatch.setattr(sys, "argv", ["ila_capture.py"] + list(argv))
        with pytest.raises(SystemExit) as exit_:
            ila_capture.main()
        return exit_.value.code
    return run


@pytest.fixture
def no_vivado(monkeypatch, tmp_path):
    """A PC on which the search for Vivado finds nothing, whatever is installed on the one that runs the tests:
    nothing on PATH, no XILINX_VIVADO, and of the folders it looks into only those inside tmp_path exist."""
    real_glob = glob.glob
    monkeypatch.delenv("XILINX_VIVADO", raising=False)
    monkeypatch.setattr(ila_capture.shutil, "which", lambda name: None)
    monkeypatch.setattr(ila_capture.glob, "glob",
                        lambda pattern: real_glob(pattern) if pattern.startswith(str(tmp_path)) else [])


# A stand-in for a tool that is started through a .bat wrapper. It prints what it was started with: "RAW:" and
# the arguments as cmd hands them to a batch file (%*), then "ARGV:" and the arguments as a program gets them
# that the batch file starts with %* - which is what the wrappers of the tools do with theirs.
STAND_IN_BAT = ('@echo off\r\necho RAW:%*\r\n'
                '"{python}" -c "import sys, json; print(\'ARGV:\' + json.dumps(sys.argv[1:]))" %*\r\n')


@pytest.fixture
def tool(tmp_path):
    """tool("my tools") writes the stand-in for a tool into that folder of tmp_path and returns its path, a
    .bat file. tool.started(command) hands a command to subprocess the way the driver does and returns what
    the stand-in printed: (the arguments raw, the arguments as a list) - or None when it never ran."""
    def write_tool(folder, name="vivado.bat"):
        (tmp_path / folder).mkdir(exist_ok=True)
        path = tmp_path / folder / name
        with open(str(path), "w", newline="") as f:
            f.write(STAND_IN_BAT.format(python=sys.executable))
        return str(path)

    def started(command):
        done = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              universal_newlines=True, cwd=str(tmp_path), timeout=60)
        raw = [line[len("RAW:"):] for line in done.stdout.splitlines() if line.startswith("RAW:")]
        argv = [json.loads(line[len("ARGV:"):]) for line in done.stdout.splitlines() if line.startswith("ARGV:")]
        return (raw[0], argv[0]) if raw and argv else None

    write_tool.started = started
    return write_tool


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    """A copy of the two scripts and of scripts/ in a folder of its own, for the tests that start them as a
    process: both find everything next to their own file, so the log and the captures of such a process stay
    in the copy."""
    folder = tmp_path_factory.mktemp("app")
    for name in ("ila_bridge.py", "ila_capture.py"):
        shutil.copy(os.path.join(ROOT, name), str(folder))
    shutil.copytree(os.path.join(ROOT, "scripts"), str(folder / "scripts"))
    return folder
