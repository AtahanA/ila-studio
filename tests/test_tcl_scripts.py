# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The two Tcl scripts themselves, read by a real Tcl interpreter where one is installed (Git for Windows brings
a tclsh; the tests are skipped where there is none). No Vivado command is run: the scripts are only sourced, and
asked what they define. One brace too many in a comment inside a proc body is enough to break a script for
Vivado, and nothing else in the tests reads these files."""
import glob
import json
import os
import re
import shutil

import pytest

import ila_bridge as ib
import ila_capture as ic

TCLSH = shutil.which("tclsh") or next(iter(glob.glob(r"C:\Program Files\Git\mingw64\bin\tclsh.exe")), None)
pytestmark = pytest.mark.skipif(not TCLSH, reason="no tclsh on this PC")

# every proc of scripts/vivado_ila_repl.tcl that ila_capture.py or ila_bridge.py calls by name
CALLED = ("ila_open ila_select ila_list ila_info ila_probes ila_probe_radix ila_recheck ila_refresh ila_arm "
          "ila_capture ila_capture_keep ila_collect ila_collect_rearm ila_write_last ila_obj jtag_freq").split()


@pytest.fixture
def tcl():
    """tcl(script) starts tclsh on a Tcl file the way the driver starts Vivado on it and returns the Repl;
    tcl.log is what the scripts printed besides their answers."""
    started, log = [], []

    def start(script):
        repl = ic.Repl([TCLSH, script], "vivado", lambda msg, quiet=False: log.append(msg))
        started.append(repl)
        return repl

    start.log = log
    yield start
    for repl in started:
        repl.close()
        repl.p.wait(timeout=30)


def test_repl_script_is_sourced_and_has_what_the_driver_asks_for(tcl):
    repl = tcl(ic.resolve_tcl(None))                     # "@@READY" came: the whole file was read without an error
    # its version is the one the driver expects, and it lacks nothing: no note about an older script
    assert repl.cmd(ic.SCRIPT_CHECK) == "version=%d;missing=" % ic.SCRIPT_VERSION
    defined = repl.cmd("info procs").split()
    assert [name for name in CALLED if name not in defined] == []
    # the body of every proc is whole: a brace in a comment has not moved the end of one
    assert repl.cmd("set bad {}; foreach p [info procs ila_*] { if {![info complete [info body $p]]} "
                    "{ lappend bad $p } }; set bad") == ""


def test_script_that_states_no_version_answers_zero(tcl):
    repl = tcl(ic.resolve_tcl(None))
    repl.cmd("unset ::ILA_REPL_VERSION")                 # as in a script of one's own
    assert repl.cmd(ic.SCRIPT_CHECK) == "version=0;missing="         # which the driver takes for "not stated"


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


# ---------------------------------------------------------------- the debug hub clock and the JTAG clock
def test_repl_script_keeps_to_the_tcl_of_vivado_2017_4():
    # Vivado 2017.4 embeds Tcl 8.5. The tclsh of these tests is newer and takes what 8.5 does not have, so
    # such a command would pass every test here and fail in Vivado: the text of the script is looked at.
    with open(ic.resolve_tcl(None), encoding="utf-8") as f:
        code = "".join(re.sub(r";#.*", "", line) for line in f if not line.lstrip().startswith("#"))
    newer = re.findall(r"(?:^|[\[{;])[ \t]*(?:lmap|try|throw|tailcall|coroutine|yield)\b"
                       r"|\b(?:string cat|dict map|binary (?:en|de)code|file tempfile|package require)\b", code, re.M)
    assert newer == []


def xml_hubs(*clocks):
    """A probe file in the XML form with a probe for each of these debug hub clocks."""
    return "<probeData>%s</probeData>" % "".join(
        '<probe type="ila"><probeOptions Id="DebugProbeParams"><Option Id="HUB_CLK_INPUT_FREQ_HZ" value="%s"/>'
        '</probeOptions><nets><net name="top/rx_valid"/></nets></probe>' % clock for clock in clocks)


def json_hubs(*clocks, **layout):
    """A probe file in the JSON form whose debug hubs name these clocks, each written as it is given."""
    hubs = [{"type": "XSDB_V3", "name": "dbg_hub", "spec": "labtools_xsdbm_v3", "clk_input_freq_hz": clock}
            for clock in clocks]
    return json.dumps({"ltx_root": {"version": 4, "ltx_data": [{"name": "EDA_PROBESET", "debug_cores": hubs + [
        {"type": "ILA_V3", "name": "u_ila_0", "pins": []}]}]}}, **layout)


@pytest.mark.parametrize("text, hz", [
    (xml_hubs(15600000), 15600000),
    (json_hubs("15600000"), 15600000),                   # the JSON form: the clock as text ...
    (json_hubs(15600000), 15600000),                     # ... or as a number
    (json_hubs("15600000", indent=4), 15600000),         # whatever the layout
    (json_hubs("15600000", separators=(",", ":")), 15600000),
    (json_hubs("015600000"), 15600000),                  # a leading zero does not make it an octal number
    (xml_hubs(100000000, 12000000), 12000000),           # of several hubs the slowest decides
    (json_hubs("100000000", "12000000", "40000000"), 12000000),
    (json_hubs(), 0),                                    # not named: 0, which is "unknown"
    (json_hubs("fast"), 0),
    (json_hubs("0"), 0),
    (json_hubs(2.5e7), 0),                               # only a whole number is a frequency in Hz
    ("<probeData/>", 0),
])
def test_hub_clock_is_read_from_both_forms_of_the_probe_file(tcl, write, text, hz):
    path = write("top.ltx", text)
    assert tcl(ic.resolve_tcl(None)).cmd("ltx_hub_clock_hz " + ic.tcl_path(path)) == str(hz)
    assert ib.parse_ltx_file(path)["hubClockHz"] == hz   # the GUI shows the limit the script goes by


def test_hub_clock_of_a_probe_file_that_is_not_there_is_unknown(tcl, tmp_path):
    assert tcl(ic.resolve_tcl(None)).cmd("ltx_hub_clock_hz " + ic.tcl_path(str(tmp_path / "missing.ltx"))) == "0"


# The Vivado commands the script calls on its way through ila_open and a capture, as far as they are needed
# here: one cable that runs at 10 MHz and offers four frequencies, one device, one ILA core that stays IDLE
# when it is armed. ::SET_TCK is every frequency the script set the cable to.
STAND_IN_VIVADO = """\
set ::TCK 10000000
set ::SET_TCK {}
proc open_hw args {}
proc get_hw_servers args { return localhost:3121 }
proc get_hw_targets args { return cable }
proc current_hw_target args { return cable }
proc open_hw_target args {}
proc close_hw_target args {}
proc disconnect_hw_server args {}
proc get_hw_devices args { return xc7z020_1 }
proc current_hw_device args { return xc7z020_1 }
proc refresh_hw_device args {}
proc get_hw_ilas args { return hw_ila_1 }
proc get_hw_probes args { return {} }
proc run_hw_ila args {}
proc wait_on_hw_ila args {}
proc reset_hw_ila args {}
proc list_property_value args { return {3000000 6000000 7500000 10000000} }
proc get_property {name args} {
    switch -- $name {
        PARAM.FREQUENCY { return $::TCK }
        IS_OPENED { return 1 }
        PART { return xc7z020 }
        CELL_NAME { return u_ila_0 }
        CONTROL.DATA_DEPTH { return 1024 }
        STATUS.CORE_STATUS { return IDLE }
    }
    error "no property $name"
}
proc set_property {name value args} {
    if {$name eq "PARAM.FREQUENCY"} { set ::TCK $value; lappend ::SET_TCK $value }
}
source {%s}
"""
IDLE = "the ILA core does not run: it is still IDLE after being armed. "


@pytest.fixture
def opened(tcl, write, tmp_path):
    """opened(text, tck_hz) sends ila_open as the driver does, for a probe file with this text, to the script
    with the stand-in for Vivado; returns the Repl and what ila_open answered, as a dictionary."""
    stub = tmp_path / "vivado_stand_in.tcl"
    stub.write_text(STAND_IN_VIVADO % ic.resolve_tcl(None).replace("\\", "/"))

    def open_with(text, tck_hz=0):
        prof = ic.load_profile(None)
        prof["hardware"].update(ltx=write("top.ltx", text), jtag_frequency_hz=tck_hz)
        repl = tcl(str(stub))
        answer = repl.cmd(ic.Session(None, prof, ephemeral=True)._ila_open_cmd())
        return repl, dict(part.split("=", 1) for part in answer.split(";"))

    return open_with


@pytest.mark.parametrize("text", [xml_hubs(15600000), json_hubs("15600000")])
def test_automatic_jtag_clock_is_lowered_for_a_slow_debug_hub_in_either_form(opened, tcl, text):
    repl, info = opened(text)
    # 15.6 MHz / 2.5 = 6.24 MHz: the 10 MHz of the cable are too fast, the next frequency below the limit is taken
    assert (info["HUB_CLK_HZ"], info["JTAG_FREQ_HZ"]) == ("15600000", "6000000")
    assert info["JTAG_NOTE"] == ("TCK set to 6000000 Hz instead of the cable default of 10000000 Hz: the debug hub "
                                 "clock is 15600000 Hz and TCK must stay below hub clock / 2.5")
    assert repl.cmd("set ::SET_TCK") == "6000000"
    assert any(line.endswith("top.ltx (debug hub clock 15600000 Hz)") for line in tcl.log)
    with pytest.raises(RuntimeError) as failed:          # the core of the stand-in never runs
        repl.cmd("ila_capture_keep now 0 1 UNSIGNED ALWAYS")
    assert str(failed.value).endswith(IDLE + "TCK (6000000 Hz) is too fast for the debug hub clock (15600000 Hz), "
                                             "or the ILA/hub clock is stopped")


@pytest.mark.parametrize("text", ["<probeData/>", json_hubs(), json_hubs("fast")])
def test_automatic_jtag_clock_says_when_the_probe_file_does_not_name_the_hub_clock(opened, tcl, text):
    repl, info = opened(text)
    assert (info["HUB_CLK_HZ"], info["JTAG_FREQ_HZ"]) == ("0", "10000000")
    assert info["JTAG_NOTE"] == ("the probe file does not name the debug hub clock, so TCK (10000000 Hz) was not "
                                 "limited to hub clock / 2.5")
    assert repl.cmd("set ::SET_TCK") == ""               # nothing was set: the cable is as it was found
    assert any(line.endswith("top.ltx (it does not name the debug hub clock)") for line in tcl.log)
    with pytest.raises(RuntimeError) as failed:
        repl.cmd("ila_capture_keep now 0 1 UNSIGNED ALWAYS")
    assert str(failed.value).endswith(
        IDLE + "TCK (10000000 Hz) is too fast for the debug hub clock - which the probe file does not name: choose "
               "a JTAG clock at or below hub clock / 2.5 - or the ILA/hub clock is stopped")
    assert "(0 Hz)" not in str(failed.value)             # as in "the debug hub clock (0 Hz)"


def test_jtag_clock_that_was_asked_for_gets_no_note_about_an_unknown_hub_clock(opened):
    repl, info = opened(json_hubs(), tck_hz=6000000)
    assert info["JTAG_FREQ_HZ"] == "6000000" and "JTAG_NOTE" not in info
    assert repl.cmd("set ::SET_TCK") == "6000000"
