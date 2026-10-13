# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Fixtures shared by the tests. No test needs Vivado, a board or a network: the files a test reads are written
into pytest's tmp_path first, and where the driver would start Vivado a recorder takes its place."""
import glob
import gzip
import os
import re
import shutil
import sys
import time
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
    """The Tcl commands the driver sent, in order. answers: what is answered, by the first word of a command.
    failing: the commands that fail instead, by their first word, with the reason the Tcl side gives. script:
    what the Tcl script says about itself when the driver asks (its version and what it lacks). started: the
    command line of every process the driver would have started, by the name it gave it."""
    def __init__(self):
        list.__init__(self)
        self.answers = dict(ANSWERS)
        self.failing = {}
        self.script = "version=%d;missing=" % ila_capture.SCRIPT_VERSION
        self.started = {}


@pytest.fixture
def vivado(monkeypatch, tmp_path):
    """Vivado and xsct replaced by a recorder; the fixture is the list of what the driver sent them (see Sent).
    Nothing is started. A command that makes Vivado write a capture writes UPLOAD as its CSV."""
    sent = Sent()

    class Recorder:
        def __init__(self, argv, name, log):
            self.name, self.dead, self.writing = name, False, None
            sent.started[name] = list(argv)
            self.p = types.SimpleNamespace(pid=0, poll=lambda: None)

        def cmd(self, tcl, timeout=600, check=True):
            if len(sent) >= 1000:                          # a loop of the driver that does not end: fail, not hang
                raise RuntimeError("the recorder was sent more than 1000 commands")
            sent.append(tcl)
            word = tcl.split(" ")[0]
            if word in sent.failing:
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
            return "0" if tcl == "set ::ILA_INDEX" else sent.answers.get(word, "")

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
