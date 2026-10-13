# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The two Tcl scripts themselves, read by a real Tcl interpreter where one is installed (Git for Windows brings
a tclsh; the tests are skipped where there is none). No Vivado command is run: the scripts are only sourced, and
asked what they define. One brace too many in a comment inside a proc body is enough to break a script for
Vivado, and nothing else in the tests reads these files."""
import glob
import os
import shutil

import pytest

import ila_capture as ic

TCLSH = shutil.which("tclsh") or next(iter(glob.glob(r"C:\Program Files\Git\mingw64\bin\tclsh.exe")), None)
pytestmark = pytest.mark.skipif(not TCLSH, reason="no tclsh on this PC")

# every proc of scripts/vivado_ila_repl.tcl that ila_capture.py or ila_bridge.py calls by name
CALLED = ("ila_open ila_select ila_list ila_info ila_probes ila_probe_radix ila_recheck ila_refresh ila_arm "
          "ila_capture ila_capture_keep ila_collect ila_collect_rearm ila_write_last ila_obj jtag_freq").split()


@pytest.fixture
def tcl():
    """tcl(script) starts tclsh on a Tcl file the way the driver starts Vivado on it and returns the Repl."""
    started = []

    def start(script):
        repl = ic.Repl([TCLSH, script], "vivado", lambda msg, quiet=False: None)
        started.append(repl)
        return repl

    yield start
    for repl in started:
        repl.close()
        repl.p.wait(timeout=30)


def test_repl_script_is_sourced_and_has_what_the_driver_asks_for(tcl):
    repl = tcl(ic.resolve_tcl(None))                     # "@@READY" came: the whole file was read without an error
    assert repl.cmd(ic.SCRIPT_CHECK) == "version=3;missing="
    defined = repl.cmd("info procs").split()
    assert [name for name in CALLED if name not in defined] == []
    # the body of every proc is whole: a brace in a comment has not moved the end of one
    assert repl.cmd("set bad {}; foreach p [info procs ila_*] { if {![info complete [info body $p]]} "
                    "{ lappend bad $p } }; set bad") == ""


def test_capture_commands_reach_their_procs_with_the_values_meant(tcl):
    repl = tcl(ic.resolve_tcl(None))
    # ila_open is replaced by a proc of the same arguments that answers what it was given
    repl.cmd("proc ila_open [list url ltx {device_filter *} {ila_index 0} {target_filter *} {freq_hz 0}] "
             "{ return \"$url|$ltx|$device_filter|$ila_index|$target_filter|$freq_hz\" }")
    prof = ic.load_profile(None)
    prof["hardware"].update(url="[::1]:3121", ltx=r"C:\my work\top.ltx", device_filter="", target_filter="")
    command = ic.Session(None, prof, ephemeral=True)._ila_open_cmd()
    assert repl.cmd(command) == "[::1]:3121|C:/my work/top.ltx|*|0|*|0"
    assert repl.cmd("lindex %s 0" % ic.tcl_trigger("top/bus[3] eq4'h0A")) == "top/bus[3]"
    assert repl.cmd("ila_compare_value [lindex %s 1]" % ic.tcl_trigger("top/data eq14'h0")) == "eq14'h0000"


def test_xsct_script_defines_the_commands_of_the_hook(tcl, tmp_path):
    # xsct's own "connect" is all the script runs when it is sourced; here it does nothing
    stub = tmp_path / "xsct_stub.tcl"
    stub.write_text("proc connect args {}\nproc disconnect args {}\nset argv {}\nsource {%s}\n"
                    % os.path.join(ic.HERE, "xsct_repl.tcl").replace("\\", "/"))
    defined = tcl(str(stub)).cmd("info procs").split()
    assert [name for name in ("core_state", "read_words", "resume", "add_bp") if name not in defined] == []
