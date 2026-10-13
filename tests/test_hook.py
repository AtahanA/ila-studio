# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Hook mode without a CPU: the helpers that find the hook in an ELF file and recognise a halt at it, and whole
runs of the "hook" command against the recorder that stands in for Vivado and xsct."""
import json
import os
import sys
import types

import pytest

import ila_capture as ic

# what "nm -S" and "objdump -d" print for an image with a hook function and its info struct
NM = ("00100f00 00000010 T capture_hook\n"
      "00200000 0000000c B capture_info\n"
      "00100000 T _start\n")
OBJDUMP = ("  100a48:\te3a00001 \tmov\tr0, #1\n"
           "  100a4c:\teb00012b \tbl\t100f00 <capture_hook>\n"
           "  100a50:\teb000140 \tbl\t100f58 <capture_hook_done>\n"
           "  100a54:\tea000129 \tb\t100f00 <capture_hook>\n")


def tools_print(monkeypatch, text):
    """nm and objdump are not started: whatever the driver runs has printed this."""
    monkeypatch.setattr(ic.subprocess, "run", lambda *args, **kwargs: types.SimpleNamespace(stdout=text))


# ---------------------------------------------------------------- helpers
def test_address_and_size_of_a_symbol(monkeypatch):
    tools_print(monkeypatch, NM)
    assert ic.elf_symbol(ic.load_profile(None), "app.elf", "capture_info") == (0x00200000, 12)


def test_symbol_that_is_not_in_the_image_ends_the_run(monkeypatch):
    tools_print(monkeypatch, NM)
    with pytest.raises(SystemExit, match="symbol frame_hook not found in app.elf"):
        ic.elf_symbol(ic.load_profile(None), "app.elf", "frame_hook")


def test_call_sites_are_the_lines_that_call_the_hook(monkeypatch):
    tools_print(monkeypatch, OBJDUMP)
    # not the call of a function that only starts with the name, and not the plain branch
    assert ic.elf_callsites(ic.load_profile(None), "app.elf", "capture_hook") == {0x100a4c}


def test_tool_that_fails_ends_the_run_with_what_it_said(tmp_path):
    # as nm does for a file that is no image. Python stands in for both tools: it takes "-S" and "-d" as options
    # of its own and runs the "image", which ends as such a tool does - a line for stderr, exit code 1
    image = tmp_path / "app.elf"
    image.write_text("import sys\nsys.exit('app.elf: file format not recognized')\n")
    prof = ic.load_profile(None)
    prof["tools"].update(nm=sys.executable, objdump=sys.executable)
    with pytest.raises(RuntimeError) as failed:
        ic.elf_symbol(prof, str(image), "capture_hook")
    assert str(failed.value) == "tools.nm of the profile ended with exit code 1: app.elf: file format not recognized"
    with pytest.raises(RuntimeError, match=r"^tools\.objdump of the profile ended with exit code 1: app\.elf: "):
        ic.elf_callsites(prof, str(image), "capture_hook")


def test_halt_inside_the_hook_or_on_a_line_that_calls_it():
    hook, size, calls = 0x100f00, 16, {0x100a4c}
    assert ic.at_hook(0x100f00, hook, size, calls) and ic.at_hook(0x100f0c, hook, size, calls)
    assert ic.at_hook(0x100a4c, hook, size, calls)
    assert not ic.at_hook(0x100f10, hook, size, calls)   # the first address behind the function


@pytest.mark.parametrize("state, pc", [
    ("Stopped: (Breakpoint) 0x00100f00", 0x00100f00),
    ("Stopped: (Breakpoint) 0x0000000080100f00", 0x80100f00),      # a 64-bit core
    ("Running", None),
    ("Unreachable", None),
])
def test_program_counter_of_a_halted_core(state, pc):
    halted = ic.HALT_RE.search(state)
    assert (int(halted.group(1), 16) if halted else None) == pc


@pytest.mark.parametrize("word, value", [(5, 5), (0x7FFFFFFF, 2147483647), (0xFFFFFFFE, -2), (0x80000000, -2147483648)])
def test_word_read_as_signed(word, value):
    assert ic.sx(word) == value


# ---------------------------------------------------------------- whole runs
@pytest.fixture
def hook(vivado, cli, monkeypatch, write, tmp_path):
    """hook(mode, ...) runs the "hook" command with a profile of that hook.mode and the further arguments, on
    an image whose symbols are those of NM; neither nm nor objdump is started."""
    symbols = {"capture_hook": (0x00100f00, 16), "capture_info": (0x00200000, 12)}
    monkeypatch.setattr(ic, "elf_symbol", lambda prof, elf, name: symbols[name])
    monkeypatch.setattr(ic, "elf_callsites", lambda prof, elf, name: set())

    def run(mode, *more, hardware=None, **hook_keys):
        profile = write("hook.json", json.dumps({
            "hardware": hardware or {},
            "capture": {"trigger": "frame_start eq1'bR", "position": 300},
            "hook": dict({"symbol": "capture_hook", "info_symbol": "capture_info", "magic": "0x1234",
                          "fields": ["step", "offset"], "signed_fields": ["offset"],
                          "name_template": "run{run}_step{step:03d}_{offset}", "mode": mode}, **hook_keys)}))
        # --minutes 1: a run that never sees its halt ends by itself, and the test fails instead of waiting an hour
        return cli("--profile", profile, "--ltx", str(tmp_path / "top.ltx"), "--out", str(tmp_path / "out"),
                   "hook", "--elf", "app.elf", "--minutes", "1", *more)
    return run


def test_halt_at_the_hook_is_captured_and_the_core_resumed(vivado, hook, tmp_path):
    vivado.answers.update({"core_state": "Stopped: (Breakpoint) 0x00100f00",
                           "read_words": "0x00001234 0x00000007 0xfffffffe"})     # magic, step = 7, offset = -2
    assert hook("capture_now", "--count", "1") == 0
    assert "read_words 0x00200000 3" in vivado           # the magic word and the two fields
    (session,) = (tmp_path / "out").iterdir()
    assert (session / "run1_step007_-2.csv").exists()       # named by the template from what the target reported
    assert vivado[-1] == "resume"                        # the core is not left halted at the hook


def test_position_zero_reaches_the_arm_before_the_first_halt(vivado, hook):
    hook("arm_and_collect_next", "--count", "0", "--position", "0")
    assert "ila_arm {frame_start eq1'bR} 0 UNSIGNED" in vivado


def test_run_that_ends_in_an_error_exits_with_1(vivado, hook, tmp_path):
    # the error is logged by the command itself, which still looks after the core and closes in order
    vivado.failing["core_state"] = "no targets found"
    assert hook("capture_now", "--count", "1") == 1
    (session,) = (tmp_path / "out").iterdir()
    log = (session / "session.log").read_text()
    assert "ERROR: xsct: 'core_state' failed: no targets found" in log
    assert vivado.to["xsct"] == ["core_state", "(resync)", "core_state"]         # asked once more at the end


def test_xsct_that_no_longer_answers_at_the_end_is_said(vivado, hook, tmp_path):
    vivado.failing["(resync)"] = "xsct is no longer usable (it timed out or exited)"
    assert hook("capture_now", "--count", "0") == 0
    # no breakpoint was planted: there is nothing to say about one
    assert session_log(tmp_path).rstrip().endswith(
        "could not check/resume the core: xsct is no longer usable (it timed out or exited)")


def test_run_that_comes_to_its_end_exits_with_0(vivado, hook):
    assert hook("capture_now", "--count", "0") == 0


@pytest.mark.parametrize("server, address", [
    ([], "tcp:127.0.0.1:3121"),                          # the address of the built-in defaults
    (["--server", "192.0.2.10"], "tcp:192.0.2.10:3121"),
    (["--server", "labpc:3122"], "tcp:labpc:3122"),
    (["--server", "TCP:192.0.2.10"], "tcp:192.0.2.10:3121"),         # not "tcp:TCP:192.0.2.10"
])
def test_xsct_is_given_the_address_in_its_one_form(vivado, hook, server, address):
    hook("capture_now", "--count", "0", *server)
    assert vivado.started["xsct"][-2:] == [os.path.join(ic.HERE, "xsct_repl.tcl"), address]


def test_xsct_is_not_started_with_text_that_is_no_address(vivado, hook):
    # the address stands on a cmd /c line there: cmd would run what follows the "&" as a command of its own
    message = hook("capture_now", "--count", "1", "--server", "a&echo.SECOND&rem")
    assert message.startswith("'a&echo.SECOND&rem' is not a hw_server address")
    assert vivado.started == {}


@pytest.mark.skipif(os.name != "nt", reason="the tools are started through cmd.exe on Windows only")
def test_xsct_is_not_started_with_an_address_that_cmd_would_not_pass_on(vivado, hook, tmp_path):
    # the zone of an IPv6 address is an address all right, but its "%" does not get through cmd and the wrapper
    assert hook("capture_now", "--count", "1", "--server", "[fe80::1%12]") == 1
    assert "xsct" not in vivado.started
    (session,) = (tmp_path / "out").iterdir()
    assert ("ERROR: xsct.bat cannot be started: tcp:[fe80::1%12]:3121 holds a percent sign, which cmd.exe does not "
            "pass on as it is written.") in (session / "session.log").read_text()


def test_core_filter_reaches_xsct_as_its_first_command_not_on_its_command_line(vivado, hook):
    # a filter of xsct has quotes of its own and may hold "&&": neither can be written on a line for cmd
    core_filter = 'name =~ "*Cortex-A9*#0*" && jtag_cable_name =~ "*210299A00001"'
    hook("capture_now", "--count", "0", hardware={"core_filter": core_filter})
    assert vivado.started["xsct"][-2:] == [os.path.join(ic.HERE, "xsct_repl.tcl"), "tcp:127.0.0.1:3121"]
    assert vivado.to["xsct"][0] == ('set ::CORE_FILTER "name =~ \\"*Cortex-A9*#0*\\" && jtag_cable_name =~ '
                                    '\\"*210299A00001\\""')


def test_without_a_core_filter_the_one_of_the_script_stays(vivado, hook):
    hook("capture_now", "--count", "0")
    assert not [command for command in vivado.to["xsct"] if "CORE_FILTER" in command]


# ---------------------------------------------------------------- the breakpoint of --plant
ELSEWHERE, AT_HOOK = "Stopped: (Breakpoint) 0x00100a00", "Stopped: (Breakpoint) 0x00100f00"
STEP_7 = "0x00001234 0x00000007 0xfffffffe"              # magic, step = 7, offset = -2


def session_log(tmp_path):
    (session,) = (tmp_path / "out").iterdir()
    return (session / "session.log").read_text()


@pytest.fixture
def cpu(vivado):
    """A CPU that is found halted somewhere else first and at the hook from then on, with step 7 in its info
    struct. xsct calls a breakpoint it is asked to plant number 3. The fixture is the recorder."""
    vivado.answers.update({"core_state": [ELSEWHERE, AT_HOOK], "read_words": STEP_7, "add_bp": "3", "del_bp": "3"})
    return vivado


@pytest.fixture
def minutes_pass(monkeypatch):
    """Every pause of the driver takes a minute of the clock the driver reads, and no time: a run of one minute
    is over after its first pause."""
    real = ic.time

    class Clock:
        now = real.time()

        def time(self):
            return Clock.now

        def sleep(self, seconds):
            Clock.now += 60

        def __getattr__(self, name):
            return getattr(real, name)

    monkeypatch.setattr(ic, "time", Clock())


def test_planted_breakpoint_is_removed_before_the_core_is_resumed_for_the_last_time(cpu, hook, tmp_path):
    assert hook("capture_now", "--count", "2", "--plant") == 0
    assert cpu.to["xsct"] == [
        "core_state", "add_bp 0x00100f00",                           # halted somewhere else: planted
        "core_state", "read_words 0x00200000 3", "resume",           # halted at the hook: captured, resumed
        "core_state", "read_words 0x00200000 3",                     # the last capture: not resumed yet ...
        "(resync)", "del_bp", "core_state", "resume"]                # ... the breakpoint goes first, then the core
    log = session_log(tmp_path)
    assert "planted a hardware breakpoint at 0x00100f00 while halted at 0x00100a00 (breakpoint 3 of xsct)" in log
    assert "removed the hardware breakpoint at 0x00100f00 (breakpoint 3 of xsct)" in log


@pytest.mark.parametrize("ended_by, code", [("no memory at this address", 1), (KeyboardInterrupt(), 0)],
                         ids=["an error", "Ctrl-C"])
def test_breakpoint_is_removed_when_the_run_is_cut_short(cpu, hook, ended_by, code):
    cpu.failing["read_words"] = ended_by
    assert hook("capture_now", "--count", "5", "--plant") == code
    assert cpu.to["xsct"] == ["core_state", "add_bp 0x00100f00", "core_state", "read_words 0x00200000 3",
                              "(resync)", "del_bp", "core_state", "resume"]


def test_breakpoint_is_removed_when_ctrl_c_came_before_xsct_had_answered_the_planting(cpu, hook, tmp_path):
    # the driver never read which breakpoint it is. The Tcl side kept its id, and is asked all the same
    cpu.failing["add_bp"] = KeyboardInterrupt()
    assert hook("capture_now", "--count", "5", "--plant") == 0
    assert cpu.to["xsct"] == ["core_state", "add_bp 0x00100f00", "(resync)", "del_bp", "core_state", "resume"]
    assert "removed the hardware breakpoint at 0x00100f00 (breakpoint 3 of xsct)" in session_log(tmp_path)


def test_breakpoint_is_removed_when_the_minutes_are_over(cpu, hook, minutes_pass):
    cpu.answers["core_state"] = [ELSEWHERE, "Running"]
    assert hook("capture_now", "--count", "5", "--plant") == 0
    assert cpu.to["xsct"] == ["core_state", "add_bp 0x00100f00", "(resync)", "del_bp", "core_state"]


@pytest.mark.parametrize("mode", ["capture_now", "arm_and_collect_next"])
def test_breakpoint_is_removed_when_the_target_reports_the_end(cpu, hook, mode):
    assert hook(mode, "--count", "5", "--plant", sequence_field="step", end_value=7) == 0
    assert cpu.to["xsct"] == ["core_state", "add_bp 0x00100f00", "core_state", "read_words 0x00200000 3",
                              "(resync)", "del_bp", "core_state", "resume"]


def test_breakpoint_that_xsct_did_not_plant_is_not_logged_as_planted(cpu, hook, tmp_path):
    cpu.failing["add_bp"] = "no hardware breakpoint is free"
    cpu.answers["del_bp"] = ""                           # what the Tcl side answers when it planted nothing
    assert hook("capture_now", "--count", "1", "--plant") == 0           # the run goes on: a debugger may halt it
    log = session_log(tmp_path)
    assert ("NO breakpoint was planted at 0x00100f00: no hardware breakpoint is free - the core only halts at "
            "the hook where a debugger has a breakpoint") in log
    assert "planted a hardware breakpoint" not in log and "removed the hardware breakpoint" not in log
    assert cpu.to["xsct"].count("add_bp 0x00100f00") == 1                # asked once, at the first halt


def test_breakpoint_that_cannot_be_removed_is_said_and_the_core_resumed_all_the_same(cpu, hook, tmp_path):
    cpu.failing["del_bp"] = "Breakpoint 3 not found"
    assert hook("capture_now", "--count", "1", "--plant") == 0
    assert cpu.to["xsct"][-4:] == ["(resync)", "del_bp", "core_state", "resume"]
    assert ("WARNING the hardware breakpoint at 0x00100f00 could NOT be removed (Breakpoint 3 not found): the core "
            "may halt at the hook once more and stay halted") in session_log(tmp_path)


def test_xsct_that_no_longer_answers_at_the_end_leaves_a_word_about_the_breakpoint(cpu, hook, tmp_path):
    cpu.failing["(resync)"] = "xsct is no longer usable (it timed out or exited)"
    assert hook("capture_now", "--count", "1", "--plant") == 0
    assert ("could not check/resume the core: xsct is no longer usable (it timed out or exited) - and the hardware "
            "breakpoint planted at 0x00100f00 may still be set") in session_log(tmp_path)


def test_run_without_plant_plants_nothing_and_removes_nothing(cpu, hook):
    # the breakpoint is somebody else's (a debugger's): the core is resumed after every capture, as before
    assert hook("capture_now", "--count", "1") == 0
    assert cpu.to["xsct"] == ["core_state", "core_state", "read_words 0x00200000 3", "resume",
                              "(resync)", "core_state", "resume"]


def test_run_without_plant_resumes_the_core_when_the_target_reports_the_end(cpu, hook):
    assert hook("arm_and_collect_next", "--count", "5", sequence_field="step", end_value=7) == 0
    assert cpu.to["xsct"] == ["core_state", "core_state", "read_words 0x00200000 3", "resume",
                              "(resync)", "core_state", "resume"]
