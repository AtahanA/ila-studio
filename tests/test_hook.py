# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Hook mode without a CPU: the helpers that find the hook in an ELF file and recognise a halt at it, and whole
runs of the "hook" command against the recorder that stands in for Vivado and xsct."""
import json
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
