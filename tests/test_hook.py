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

    def run(mode, *more):
        profile = write("hook.json", json.dumps({
            "capture": {"trigger": "frame_start eq1'bR", "position": 300},
            "hook": {"symbol": "capture_hook", "info_symbol": "capture_info", "magic": "0x1234",
                     "fields": ["step", "offset"], "signed_fields": ["offset"],
                     "name_template": "run{run}_step{step:03d}_{offset}", "mode": mode}}))
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
    assert "could not check/resume the core" in log


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
