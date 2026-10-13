# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The "check" command: a profile is judged offline, and by the rules a real run goes by."""
import types

import pytest

import ila_capture as ic

LTX = ('<probeData><probe type="ila"><probeOptions><Option Id="HW_ILA" value="u_ila_0"/>'
       '<Option Id="HUB_CLK_INPUT_FREQ_HZ" value="100000000"/></probeOptions>'
       '<nets><net name="top/rx_valid"/></nets></probe></probeData>')


@pytest.fixture
def prof(no_vivado, monkeypatch, write, tmp_path):
    """A profile "check" has nothing to say against. Its tools.vivado names a file that is not there; the only
    Vivado of this PC is the one XILINX_VIVADO leads to."""
    (tmp_path / "Vivado" / "bin").mkdir(parents=True)
    (tmp_path / "Vivado" / "bin" / "vivado.bat").write_text("")
    monkeypatch.setenv("XILINX_VIVADO", str(tmp_path / "Vivado"))
    prof = ic.load_profile(None)
    prof["tools"]["vivado"] = str(tmp_path / "elsewhere" / "vivado.bat")
    prof["hardware"]["ltx"] = write("top.ltx", LTX)
    return prof


def check(prof, capsys, hook=False):
    """(exit code, what was printed) of "check" on this profile."""
    code = ic.cmd_check(types.SimpleNamespace(hook=hook, elf=None), prof)
    return code, capsys.readouterr().out


def test_usable_profile_passes(prof, capsys):
    code, out = check(prof, capsys)
    assert code == 0 and "PROBLEM" not in out and out.rstrip().endswith("OK")
    assert "hardware.ltx: 1 probe entries, 100000000 Hz hub clock" in out


def test_vivado_is_looked_for_the_way_a_run_does(prof, capsys, tmp_path):
    # a run would not stop at the missing tools.vivado but go on to search, so here it is a note, not a problem
    code, out = check(prof, capsys)
    found, named = str(tmp_path / "Vivado" / "bin" / "vivado.bat"), prof["tools"]["vivado"]
    assert "note:    tools.vivado: %s (found by searching; tools.vivado says %s)" % (found, named) in out


def test_vivado_that_no_run_would_find_is_a_problem(prof, capsys, monkeypatch):
    monkeypatch.delenv("XILINX_VIVADO")
    code, out = check(prof, capsys)
    assert code == 1 and "PROBLEM: Vivado not found" in out and out.rstrip().endswith("1 problem(s)")


def test_profile_without_a_probe_file_fails(prof, capsys):
    prof["hardware"]["ltx"] = ""
    code, out = check(prof, capsys)
    assert code == 1 and "PROBLEM: hardware.ltx is empty" in out


@pytest.mark.parametrize("capture, said", [
    ({"trigger": "frame_start is high"}, 'capture.trigger must be "now" or "<probe> <compare-value>"'),
    ({"trigger": "a}b eq1'b1"}, "its braces do not pair up"),
    ({"radix": "OCTAL"}, "capture.radix is 'OCTAL': it must be one of UNSIGNED, SIGNED, HEX"),
    ({"capture_mode": "x"}, "capture.capture_mode is 'x': it must be one of ALWAYS, BASIC"),
    ({"out": "captures"}, "capture.out is relative (captures)"),
])
def test_capture_settings_that_cannot_work_are_problems(prof, capsys, capture, said):
    prof["capture"].update(capture)
    code, out = check(prof, capsys)
    assert code == 1
    assert said in [line for line in out.splitlines() if "PROBLEM: " in line][0]


def test_jtag_clock_above_what_worked_is_noted(prof, capsys):
    prof["hardware"]["jtag_frequency_hz"] = 30000000
    code, out = check(prof, capsys)
    assert code == 0 and "hardware.jtag_frequency_hz is 30 MHz: above 20 MHz" in out


def test_magnitude_statistics_need_a_value_probe(prof, capsys):
    prof["stats"]["mode"] = "magnitude"
    code, out = check(prof, capsys)
    assert code == 1 and "stats.mode is 'magnitude' but stats.value_probe is empty" in out


def test_hook_mode_needs_its_tools_and_symbols(prof, capsys, tmp_path):
    prof["tools"]["xsct"] = str(tmp_path / "xsct.bat")   # these three have no search: where the profile says
    code, out = check(prof, capsys, hook=True)
    assert code == 1
    for said in ("tools.xsct: %s NOT FOUND" % prof["tools"]["xsct"], "hook.symbol is required", "hook.magic is 0"):
        assert said in out


def test_name_template_may_only_use_fields_the_hook_reports(prof, capsys):
    prof["hook"].update(symbol="capture_hook", info_symbol="capture_info", magic=0x1234, fields=["step"],
                        name_template="run{run}_{step:03d}_{offset}")
    code, out = check(prof, capsys)
    assert code == 1 and "hook.name_template uses ['offset'], which are not in hook.fields" in out
