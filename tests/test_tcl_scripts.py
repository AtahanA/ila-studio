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


# ---------------------------------------------------------------- the commands of the hook
# xsct's own commands as far as xsct_repl.tcl calls them: one core, halted at 0x00100a00 until it is resumed, and
# breakpoints that xsct numbers from 3 on. ::CALLS is every command the script ran, in order; ::BPS is the
# breakpoints that are set.
STAND_IN_XSCT = """\
set ::CALLS {}
set ::STATE {Stopped: (Breakpoint)}
set ::BPS {}
set ::NEXT_BP 3
proc connect args { lappend ::CALLS "connect $args" }
proc disconnect args { lappend ::CALLS disconnect }
proc targets args { lappend ::CALLS "targets $args" }
proc state args { return $::STATE }
proc rrd args { return {pc 00100a00} }
proc con args { lappend ::CALLS con; set ::STATE Running }
proc bpadd args {
    lappend ::CALLS "bpadd $args"
    lappend ::BPS $::NEXT_BP
    incr ::NEXT_BP
    return [lindex $::BPS end]
}
proc bpremove {id} {
    lappend ::CALLS "bpremove $id"
    set at [lsearch -exact $::BPS $id]
    if {$at < 0} { error "Breakpoint $id not found" }
    set ::BPS [lreplace $::BPS $at $at]
}
set argv [list %s]
source {%s}
"""


def xsct_stand_in(tmp_path, *arguments):
    """The stand-in above as a file that sources xsct_repl.tcl with these arguments; its path."""
    stub = tmp_path / "xsct_stand_in.tcl"
    stub.write_text(STAND_IN_XSCT % (" ".join(ic.tcl_word(a) for a in arguments),
                                     os.path.join(ic.HERE, "xsct_repl.tcl").replace("\\", "/")))
    return str(stub)


@pytest.fixture
def xsct(tcl, tmp_path):
    """xsct(*arguments) starts xsct_repl.tcl with these arguments in tclsh, on the stand-in for xsct's own
    commands, and returns the Repl."""
    return lambda *arguments: tcl(xsct_stand_in(tmp_path, *arguments))


def test_xsct_script_defines_the_commands_of_the_hook(xsct):
    repl = xsct("tcp:127.0.0.1:3121")
    defined = repl.cmd("info procs").split()
    assert [name for name in ("core_state", "read_words", "resume", "add_bp", "del_bp") if name not in defined] == []
    # xsct's own "connect" is all the script runs when it is sourced
    assert repl.cmd("set ::CALLS") == "{connect -url tcp:127.0.0.1:3121}"


def test_breakpoint_is_planted_at_the_hook_and_its_id_handed_back(xsct):
    repl = xsct("tcp:127.0.0.1:3121")
    assert repl.cmd("add_bp 0x00100f00") == "3"          # the id xsct gave it
    assert repl.cmd("lindex $::CALLS end") == "bpadd -addr 0x00100f00 -type hw"
    assert repl.cmd("set ::BPS") == "3"


def test_planted_breakpoint_is_removed_and_no_other(xsct):
    repl = xsct("tcp:127.0.0.1:3121")
    repl.cmd("bpadd -addr 0x00100000")                   # a breakpoint somebody else set in this xsct: number 3
    assert repl.cmd("add_bp 0x00100f00") == "4"
    assert repl.cmd("del_bp") == "4"
    assert repl.cmd("set ::BPS") == "3"
    assert repl.cmd("lindex $::CALLS end") == "bpremove 4"
    assert repl.cmd("del_bp") == ""                      # nothing is left to remove: no error ...
    assert repl.cmd("lindex $::CALLS end") == "bpremove 4"           # ... and nothing was asked of xsct


def test_nothing_is_removed_where_nothing_was_planted(xsct):
    repl = xsct("tcp:127.0.0.1:3121")
    assert repl.cmd("del_bp") == ""
    assert "bpremove" not in repl.cmd("set ::CALLS")


def test_breakpoint_goes_before_the_core_is_resumed(xsct):
    # the three commands the driver ends a hook run with, in its order
    repl = xsct("tcp:127.0.0.1:3121")
    repl.cmd("add_bp 0x00100f00")
    assert repl.cmd("del_bp") == "3"
    assert repl.cmd("core_state") == "Stopped: (Breakpoint) 0x00100a00"
    assert repl.cmd("resume") == "Running"
    removed, resumed = repl.cmd("list [lsearch -exact $::CALLS {bpremove 3}] [lsearch -exact $::CALLS con]").split()
    assert 0 <= int(removed) < int(resumed)
    assert repl.cmd("set ::BPS") == ""                   # the core runs, and nothing is left that could halt it


def test_breakpoint_that_xsct_does_not_remove_is_reported_and_kept_for_another_try(xsct):
    repl = xsct("tcp:127.0.0.1:3121")
    repl.cmd("add_bp 0x00100f00")
    repl.cmd("set ::BPS {}")                             # xsct no longer knows a breakpoint 3
    with pytest.raises(RuntimeError, match="'del_bp' failed: Breakpoint 3 not found"):
        repl.cmd("del_bp")
    assert repl.cmd("set ::PLANTED") == "3"


@pytest.mark.parametrize("core_filter", [
    'name =~ "*Cortex-A9*#0*"',
    'name =~ "*Cortex-A9 MPCore #0*" && jtag_cable_name =~ "Digilent JTAG-HS3 210299A00001"',
    'name =~ "a&b|c>d" || name =~ "%TEMP%^!"',
    'name =~ "$x [exit] {y" ; puts \\z',
])
def test_core_filter_of_a_profile_is_the_filter_the_core_is_selected_with(monkeypatch, tmp_path, core_filter):
    # the driver itself opens xsct here: tclsh with the stand-in, started with what the driver puts behind the
    # script on the command line of xsct
    monkeypatch.setattr(ic, "launch", lambda exe, script, *more: [TCLSH, xsct_stand_in(tmp_path, *more)])
    prof = ic.load_profile(None)
    prof["hardware"]["core_filter"] = core_filter
    session = ic.Session(None, prof, ephemeral=True)
    session.open_xsct()
    try:
        session.xs.cmd("core")
        assert session.xs.cmd("lindex [lindex $::CALLS end] end") == core_filter
        # the command line held the address and nothing else: the filter did not pass through cmd
        assert session.xs.cmd("lindex $::CALLS 0") == "connect -url tcp:127.0.0.1:3121"
        assert session.xs.cmd("set argv") == "tcp:127.0.0.1:3121"
    finally:
        session.xs.close()
        session.xs.p.wait(timeout=30)


def test_core_filter_of_the_script_stays_where_the_driver_sets_none(xsct):
    repl = xsct("tcp:127.0.0.1:3121")
    repl.cmd("core")
    assert repl.cmd("lindex [lindex $::CALLS end] end") == 'name =~ "*Cortex-A9*#0*"'


def test_script_started_by_hand_still_takes_a_core_filter_as_its_second_argument(xsct):
    repl = xsct("tcp:127.0.0.1:3121", 'name =~ "*Cortex-A53*#1*"')
    repl.cmd("core")
    assert repl.cmd("lindex $::CALLS end") == 'targets -set -nocase -filter {name =~ "*Cortex-A53*#1*"}'


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


# ---------------------------------------------------------------- the repair of a cable ("bad enum default")
@pytest.fixture
def unlisted_clock(tcl, write, tmp_path):
    """unlisted_clock(answer) is the REPL script on the stand-in for Vivado, with a hw_server whose first connect
    raises "bad enum default" and registers no target - a cable runs at a frequency Vivado cannot represent -
    and a repair that only answers `answer`. cured: whether the connect after the repair works. Returns the
    Repl and the ila_open command of a session whose target filter is *99887766*."""
    def start(answer, cured=True):
        stub = tmp_path / "vivado_stand_in.tcl"
        stub.write_text(STAND_IN_VIVADO % ic.resolve_tcl(None).replace("\\", "/"))
        repl = tcl(str(stub))
        repl.cmd("set ::CONNECTS 0; set ::CURED %d" % cured)
        repl.cmd('proc get_hw_servers args { return [expr {$::CONNECTS ? "localhost:3121" : ""}] }')
        repl.cmd("proc connect_hw_server args { if {[incr ::CONNECTS] == 1 || !$::CURED} "
                 "{ error {ERROR: [Common 17-70] Application Exception: bad enum default} } }")
        repl.cmd('proc get_hw_targets args { return [expr {$::CONNECTS > 1 && $::CURED ? "cable" : ""}] }')
        repl.cmd("proc after args {}")                   # the script waits for a target to appear: not here
        repl.cmd("proc jtag_reset_cable_freq args { set ::ASKED $args; return %s }" % ic.tcl_word(answer))
        prof = ic.load_profile(None)
        prof["hardware"].update(ltx=write("top.ltx", "<probeData/>"), target_filter="*99887766*")
        return repl, ic.Session(None, prof, ephemeral=True)._ila_open_cmd()
    return start


BY_HAND = "Reset it by hand in xsdb/xsct: connect -url tcp:127.0.0.1:3121; jtag targets %d; jtag frequency 10000000"


def test_repair_of_a_cable_is_given_the_target_filter_of_the_session(unlisted_clock):
    repl, ila_open = unlisted_clock("TCK_RESET 6034482 -> 10000000")
    repl.cmd(ila_open)
    assert repl.cmd("set ::ASKED") == "127.0.0.1:3121 *99887766*"
    assert repl.cmd("set ::CONNECTS") == "2"             # and the connect was tried again after it


def test_cable_that_could_not_be_reset_is_said_with_the_way_to_do_it_by_hand(unlisted_clock):
    repl, ila_open = unlisted_clock("TCK_STUCK 6034482")
    with pytest.raises(RuntimeError) as failed:
        repl.cmd(ila_open)
    assert str(failed.value).endswith("and it could not be reset: TCK_STUCK 6034482. " + BY_HAND % 1)


def test_cable_that_was_left_alone_for_the_filter_is_the_one_to_reset_by_hand(unlisted_clock):
    # the cable of the session runs at a listed frequency: the one in Vivado's way is the other, which the
    # repair did not touch. Its number is the one the message gives.
    answer = "TCK_OK 15000000 | " + NOT_TOUCHED % "4 (SmartLynq)"
    repl, ila_open = unlisted_clock(answer)
    with pytest.raises(RuntimeError) as failed:
        repl.cmd(ila_open)
    assert str(failed.value).endswith("and it could not be reset: %s. " % answer + BY_HAND % 4)


def test_cable_that_was_left_alone_is_named_when_vivado_lists_no_target_after_the_repair(unlisted_clock):
    answer = "TCK_RESET 6034482 -> 10000000 | " + NOT_TOUCHED % "1 (Digilent JTAG-HS3 210299A00001)"
    repl, ila_open = unlisted_clock(answer, cured=False)
    with pytest.raises(RuntimeError) as failed:
        repl.cmd(ila_open)
    assert "offers no JTAG target matching '*99887766*'" in str(failed.value)
    assert str(failed.value).endswith("bad enum default - after the repair: %s)" % answer)


def test_repair_that_left_no_cable_alone_adds_nothing_to_what_vivado_said(unlisted_clock):
    repl, ila_open = unlisted_clock("TCK_RESET 6034482 -> 10000000", cured=False)
    with pytest.raises(RuntimeError) as failed:
        repl.cmd(ila_open)
    assert str(failed.value).endswith("(Vivado said: ERROR: [Common 17-70] Application Exception: bad enum default)")


# xsdb's own commands as far as the script of the repair calls them. Each is printed as it is run, so that what
# jtag_reset_cable_freq returns shows what was done to which cable. %s: what "jtag targets -target-properties"
# answers, and the TCK frequency of each cable by its node id.
STAND_IN_XSDB = """\
set ::NODES {%s}
array set ::HZ {%s}
set ::CUR {}
proc connect args { puts "XSDB connect [join $args]" }
proc disconnect args {}
proc jtag {what args} {
    puts [concat XSDB jtag $what $args]
    if {$what eq "targets" && $args eq "-target-properties"} { return $::NODES }
    if {$what eq "targets"} { set ::CUR [lindex $args 0]; return }
    if {$what eq "frequency" && [llength $args] == 0} { return $::HZ($::CUR) }
    if {$what eq "frequency" && $args eq "-list"} { return {3000000 6000000 7500000 10000000 15000000 30000000} }
    if {$what eq "frequency"} { set ::HZ($::CUR) [lindex $args 0]; return }
    error "the stand-in has no jtag $what $args"
}
source [lindex $argv 0]
"""
# Two cables as xsdb lists them, each (level 0) followed by the devices on its chain. The second one reports its
# maker and its serial in properties of their own, and has a name that holds neither.
HS3 = ("{node_id 1 level 0 name {Digilent JTAG-HS3 210299A00001} is_open 1} {node_id 2 level 1 name arm_dap} "
       "{node_id 3 level 1 name xc7z020}")
SMARTLYNQ = ("{node_id 4 level 0 name SmartLynq jtag_cable_manufacturer Xilinx jtag_cable_serial 99887766 "
             "is_open 1} {node_id 5 level 1 name xc7z020}")
# what the repair does to a cable that runs at 6034482 Hz, a frequency it does not list: back to 10 MHz
RESET = ["XSDB jtag frequency", "XSDB jtag frequency -list", "XSDB jtag frequency 10000000", "XSDB jtag frequency",
         "TCK_RESET 6034482 -> 10000000"]
LISTED = ["XSDB connect -url tcp:127.0.0.1:3121", "XSDB jtag targets -target-properties"]
NOT_TOUCHED = "TCK_LEFT cable %s: not the one the target filter names, not looked at"
NO_FIT = "TCK_FILTER the target filter %s fits no cable as xsdb names them: every cable is looked at"
windows = pytest.mark.skipif(os.name != "nt", reason="the stand-in for xsdb is a .bat file, started by cmd.exe")


@pytest.fixture
def repair(tcl, tmp_path):
    """repair(nodes, hz, target_filter) runs jtag_reset_cable_freq of the REPL script in tclsh for the hw_server
    at 127.0.0.1:3121, with an xsdb.bat next to "Vivado" that runs the stand-in above, and returns the lines
    xsdb printed. The first one is what xsdb.bat was started with. vivado, temp: the names of the folders that
    Vivado is installed in and that temporary files go to."""
    def run(nodes, hz, target_filter=None, url="127.0.0.1:3121", vivado="vivado", temp="temp"):
        stub = tmp_path / "xsdb_stand_in.tcl"
        stub.write_text(STAND_IN_XSDB % (nodes, " ".join("%s %s" % item for item in sorted(hz.items()))))
        (tmp_path / vivado / "bin").mkdir(parents=True, exist_ok=True)
        (tmp_path / temp).mkdir(exist_ok=True)
        (tmp_path / vivado / "bin" / "xsdb.bat").write_text(
            '@echo off\necho XSDB started with %%*\n"%s" "%s" %%1\n' % (TCLSH, stub))
        repl = tcl(ic.resolve_tcl(None))
        repl.cmd("set ::env(XILINX_VIVADO) %s; set ::env(TEMP) %s" % (ic.tcl_path(str(tmp_path / vivado)),
                                                                      ic.tcl_path(str(tmp_path / temp))))
        here = repl.cmd("pwd")
        lines = repl.cmd("jtag_reset_cable_freq " + ic.tcl_word(url) + (
            "" if target_filter is None else " " + ic.tcl_word(target_filter))).split(" | ")
        assert repl.cmd("pwd") == here                   # the script is in the folder it was in before ...
        assert os.listdir(str(tmp_path / temp)) == []    # ... and what it wrote for xsdb is gone
        return lines
    return run


@windows
@pytest.mark.parametrize("target_filter", [None, "*", ""])
def test_without_a_target_filter_every_cable_of_the_server_is_repaired(repair, target_filter):
    # as before the repair knew of a filter: these xsdb commands, in this order
    lines = repair(HS3 + " " + SMARTLYNQ, {1: 6034482, 4: 6034482}, target_filter)
    assert lines[1:] == LISTED + ["XSDB jtag targets 1"] + RESET + ["XSDB jtag targets 4"] + RESET


@windows
@pytest.mark.parametrize("target_filter", ["*99887766*", "*/xilinx_tcf/Xilinx/99887766",
                                           "127.0.0.1:3121/xilinx_tcf/Xilinx/*", "*smartlynq*"])
def test_only_the_cable_that_the_target_filter_names_is_touched(repair, target_filter):
    # both cables run at a frequency Vivado cannot represent; the other one is somebody else's
    lines = repair(HS3 + " " + SMARTLYNQ, {1: 6034482, 4: 6034482}, target_filter)
    assert lines[1:] == LISTED + [NOT_TOUCHED % "1 (Digilent JTAG-HS3 210299A00001)", "XSDB jtag targets 4"] + RESET


@windows
@pytest.mark.parametrize("target_filter", ["*210299A00001", "127.0.0.1:3121/xilinx_tcf/Digilent/210299A00001",
                                           "*JTAG-HS3*"])
def test_cable_is_found_by_the_maker_and_serial_in_its_name(repair, target_filter):
    lines = repair(HS3 + " " + SMARTLYNQ, {1: 6034482, 4: 6034482}, target_filter)
    assert lines[1:] == LISTED + ["XSDB jtag targets 1"] + RESET + [NOT_TOUCHED % "4 (SmartLynq)"]


@windows
def test_cable_of_the_session_that_needs_nothing_leaves_the_other_one_alone_all_the_same(repair):
    # the answer has no TCK_RESET then, and ila_connect says that the cable could not be reset, with this text
    lines = repair(HS3 + " " + SMARTLYNQ, {1: 15000000, 4: 6034482}, "*210299A00001*")
    assert lines[3:] == ["XSDB jtag targets 1", "XSDB jtag frequency", "XSDB jtag frequency -list", "TCK_OK 15000000",
                         NOT_TOUCHED % "4 (SmartLynq)"]


@windows
@pytest.mark.parametrize("target_filter", ["*no-such-cable*", "1"])         # "1": a node id is no name
def test_filter_that_fits_no_cable_as_xsdb_names_them_leaves_the_repair_as_it_was(repair, target_filter):
    lines = repair(HS3 + " " + SMARTLYNQ, {1: 6034482, 4: 6034482}, target_filter)
    assert lines[1:] == (LISTED + [NO_FIT % target_filter, "XSDB jtag targets 1"] + RESET
                         + ["XSDB jtag targets 4"] + RESET)


@windows
@pytest.mark.parametrize("target_filter", ["*", "*210299A00001*", "*the-name-vivado-gives-it*"])
def test_single_cable_is_repaired_whatever_the_filter_is(repair, target_filter):
    # with one cable there is nothing to choose from: the repair must not come to depend on the filter
    lines = repair(HS3, {1: 6034482}, target_filter)
    assert [line for line in lines if not line.startswith(("TCK_FILTER", "XSDB started"))] == (
        LISTED + ["XSDB jtag targets 1"] + RESET)


@windows
def test_address_and_filter_are_text_in_the_script_for_xsdb(repair):
    lines = repair(HS3, {1: 6034482}, "*[exit]; puts INJECTED; #*", url="[::1]:3121")
    assert lines[1:4] == ["XSDB connect -url tcp:[::1]:3121", "XSDB jtag targets -target-properties",
                          NO_FIT % "*[exit]; puts INJECTED; #*"]
    assert "INJECTED" not in lines and lines[-1] == "TCK_RESET 6034482 -> 10000000"


@windows
@pytest.mark.parametrize("vivado, temp, script_named", [
    ("vivado", "temp", "in full"),
    ("my vivado", "temp", "in full"),                    # one word with a blank: cmd takes such a line as it is
    ("vivado", "my temp", "in full"),
    ("my vivado", "my temp", "without its folder"),      # two of them: cmd cut the line apart
    ("vivado", "R&D", "without its folder"),             # "&" ended the command
    ("my vivado", "R&D", "without its folder"),
])
def test_xsdb_is_started_with_a_blank_in_either_folder_and_an_ampersand_in_the_temporary_one(
        repair, tmp_path, vivado, temp, script_named):
    lines = repair(HS3, {1: 6034482}, vivado=vivado, temp=temp)
    assert lines[1:] == LISTED + ["XSDB jtag targets 1"] + RESET
    script = lines[0][len("XSDB started with "):].strip('"')
    assert re.fullmatch(r"ila_tck_reset_\d+\.tcl", os.path.basename(script))
    # a line that worked before is the line it was; only one that could not work names the script differently
    assert os.path.dirname(script) == (str(tmp_path / temp) if script_named == "in full" else "")


@windows
@pytest.mark.parametrize("vivado", ["R&D", "my R&D", "a,b"])
def test_xsdb_is_not_started_from_a_vivado_folder_whose_name_cmd_cuts_apart(repair, vivado):
    # The limit the README states, not a wish: the path of xsdb.bat is the command of the line, and naming the
    # script differently does not keep cmd from ending it at the "&" (in a path without a blank: at a comma
    # as well). No cable is reset then, which is what makes ila_connect give the xsdb commands to do it by hand.
    lines = repair(HS3, {1: 6034482}, vivado=vivado)
    assert [line for line in lines if line.startswith(("XSDB", "TCK_"))] == []
