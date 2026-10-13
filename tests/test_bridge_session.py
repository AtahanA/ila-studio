# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""A hardware job of the GUI inside the bridge: what is checked before a session is made for it, and the two
jobs - connect and capture - run against the recorder that stands in for Vivado."""
import json
import types

import pytest

import ila_bridge as ib
import ila_capture as ic


def job(*argv):
    """The command line of a hardware job, parsed the way the bridge parses what the GUI sends."""
    return ib.build_parser().parse_args(list(argv))


@pytest.fixture
def reachable(monkeypatch):
    """Every hw_server counts as reachable: no test opens a connection."""
    monkeypatch.setattr(ib, "check_reachable", lambda url: None)


@pytest.fixture
def ltx(write):
    return write("top.ltx", "<probeData/>")


@pytest.fixture
def capture_profile(reachable, ltx, tmp_path):
    """capture_profile("--trigger", "now") is the profile a capture job with these further options runs with.
    Its session is made in tmp_path/out and ended again."""
    def make(*options):
        asked = job("capture", "--name", "c", "--ltx", ltx, "--out", str(tmp_path / "out"), *options)
        session, prof = ib.make_session(asked, ephemeral=False)
        ib.end_session(session)
        return prof
    return make


def result_of(capsys):
    """The @@RESULT line a job printed, as the GUI reads it."""
    (line,) = [line for line in capsys.readouterr().out.splitlines() if line.startswith("@@RESULT ")]
    return json.loads(line[len("@@RESULT "):])


# ---------------------------------------------------------------- before the session
def test_job_needs_a_probe_file(reachable):
    with pytest.raises(RuntimeError, match=r"no probe file \(\.ltx\) given"):
        ib.make_session(job("query-hardware"), ephemeral=True)


def test_probe_file_has_to_exist(reachable, tmp_path):
    with pytest.raises(RuntimeError, match="probe file not found"):
        ib.make_session(job("query-hardware", "--ltx", str(tmp_path / "gone.ltx")), ephemeral=True)


def test_server_address_is_normalised_for_the_session(reachable, ltx):
    _, prof = ib.make_session(job("query-hardware", "--server", "TCP:192.0.2.10", "--ltx", ltx), ephemeral=True)
    assert prof["hardware"]["url"] == "192.0.2.10:3121"


def test_text_that_is_no_address_gets_no_session(reachable, ltx):
    with pytest.raises(RuntimeError, match="is not a hw_server address"):
        ib.make_session(job("query-hardware", "--server", "a[exec calc.exe]::", "--ltx", ltx), ephemeral=True)


def test_blank_address_is_said_to_be_missing(reachable, ltx):
    with pytest.raises(RuntimeError, match="no hw_server address given"):
        ib.make_session(job("query-hardware", "--server", "   ", "--ltx", ltx), ephemeral=True)


def test_address_is_judged_by_the_check_of_the_driver(ltx, monkeypatch):
    # one check for the GUI and the command line: the bridge has none of its own that could come to differ.
    # What the check of the driver makes of the address is what the bridge then asks the network about.
    asked = []
    monkeypatch.setattr(ic, "normalise_url", lambda url: "as-the-driver-says:3121")
    monkeypatch.setattr(ib, "check_reachable", asked.append)
    ib.make_session(job("query-hardware", "--server", "192.0.2.10", "--ltx", ltx), ephemeral=True)
    assert asked == ["as-the-driver-says:3121"]


def test_profile_that_is_not_json_is_reported_with_the_place(reachable, ltx, write):
    asked = job("query-hardware", "--profile", write("p.json", '{"name": }'), "--ltx", ltx)
    with pytest.raises(RuntimeError, match="invalid JSON at line 1, column 10"):
        ib.make_session(asked, ephemeral=True)


def test_unusable_trigger_is_refused_before_a_session_folder_is_made(capture_profile, tmp_path):
    with pytest.raises(RuntimeError, match="braces do not pair up"):
        capture_profile("--trigger", "a}b eq1'b1")
    assert not (tmp_path / "out").exists()


def test_probe_formats_of_the_gui_replace_those_of_the_profile(capture_profile, write):
    profile = write("p.json", json.dumps({"capture": {"radix": "HEX", "probe_format": {"status": "hex"}}}))
    capture = capture_profile("--profile", profile, "--probe-formats", '{"top/u1/data[7:0]": "signed"}')["capture"]
    assert capture["probe_format"] == {"top/u1/data[7:0]": "signed"}
    assert capture["radix"] == "UNSIGNED"                # a radix for all buses would contradict the list


@pytest.mark.parametrize("formats, said", [
    ("[1, 2]", "the probe formats could not be read"),
    ('{"top/u1/data": "octal"}', "probe format of top/u1/data"),
])
def test_probe_formats_that_cannot_be_used_are_refused(capture_profile, formats, said):
    with pytest.raises(RuntimeError, match=said):
        capture_profile("--probe-formats", formats)


# ---------------------------------------------------------------- whole jobs, Vivado replaced
def test_connect_answers_with_cores_and_probes(vivado, reachable, ltx, capsys):
    assert ib.cmd_query_hardware(job("query-hardware", "--server", "TCP:192.0.2.10", "--ltx", ltx)) == 0
    result = result_of(capsys)
    # the address as Vivado gets it: without the prefix, with the port, and as one braced word
    assert [command for command in vivado if command.startswith("ila_open ")] == [
        "ila_open {192.0.2.10:3121} {%s} {*} 0 {*} 0" % ltx.replace("\\", "/")]
    assert result["success"] is True
    assert result["cores"] == [{"name": "u_ila_0", "cell": "u_ila_0", "depth": 1024}]
    assert [(p["fullName"], p["width"], p["core"]) for p in result["probes"]] == [
        ("top/u1/rx_valid", 1, "u_ila_0"), ("top/u1/data", 8, "u_ila_0")]


def test_capture_job_with_position_zero(vivado, reachable, ltx, tmp_path, capsys):
    asked = job("capture", "--name", "cap_run_001", "--ltx", ltx, "--position", "0", "--format", "csv",
                "--out", str(tmp_path / "out"))
    assert ib.cmd_capture(asked) == 0
    result = result_of(capsys)
    (command,) = [command for command in vivado if command.startswith("ila_capture ")]
    assert command.endswith("/cap_run_001} {now} 0 1 csv UNSIGNED ALWAYS")
    assert (result["success"], result["captures"]) == (True, 1)
    assert result["csvPath"].endswith("cap_run_001.csv") and result["message"] == "Capture saved: " + result["csvPath"]


def test_run_of_windows_with_two_vivado_engines(vivado, reachable, ltx, tmp_path, capsys, monkeypatch):
    # a run of several windows ends early when the capture drive is nearly full: not the subject here
    monkeypatch.setattr(ib.shutil, "disk_usage", lambda path: types.SimpleNamespace(free=1 << 40))
    asked = job("capture", "--name", "w", "--ltx", ltx, "--count", "2", "--engines", "2", "--position", "0",
                "--format", "csv", "--out", str(tmp_path / "out"))
    assert ib.cmd_capture(asked) == 0
    result = result_of(capsys)
    # each engine takes a window in turn: it uploads with one command and writes the file with another, which
    # is what lets the next engine capture meanwhile
    uploads = [command for command in vivado if command.startswith("ila_capture_keep ")]
    assert uploads == ["ila_capture_keep {now} 0 1 UNSIGNED ALWAYS"] * 2
    assert (result["captures"], result["lost"]) == (2, 0)
    (session,) = (tmp_path / "out").iterdir()
    assert sorted(p.name for p in session.glob("w_*.csv")) == ["w_0000.csv", "w_0001.csv"]


@pytest.fixture
def run_of_windows(vivado, reachable, ltx, tmp_path, capsys, monkeypatch):
    """run_of_windows("--count", "0") runs that capture job against the recorder and returns its answer and its
    session folder. The capture drive counts as empty, and a run until stopped ends after two windows."""
    monkeypatch.setattr(ib.shutil, "disk_usage", lambda path: types.SimpleNamespace(free=1 << 40))
    monkeypatch.setattr(ib, "MAX_WINDOWS", 2)

    def run(*options):
        ib.cmd_capture(job("capture", "--name", "w", "--ltx", ltx, "--format", "csv", "--out", str(tmp_path / "out"),
                           *options))
        (session,) = (tmp_path / "out").iterdir()
        return result_of(capsys), session
    return run


def test_run_until_stopped_says_that_it_ended_at_the_limit(run_of_windows):
    result, session = run_of_windows("--count", "0")
    # nobody pressed Stop and nothing failed: without a reason the answer would read like a run that was through
    assert (result["success"], result["captures"], result["stopped"]) == (True, 2, False)
    assert result["message"] == ("Captured 2 window(s) into %s - the run ended by itself: the limit of 2 windows "
                                 "of one run was reached; start it again to go on" % session)
    assert "stopping: the limit of 2 windows of one run was reached" in (session / "session.log").read_text()


def test_run_of_a_given_number_of_windows_ends_without_a_reason(run_of_windows):
    result, session = run_of_windows("--count", "2")
    assert result["message"] == "Captured 2 window(s) into %s" % session
    assert "stopping" not in (session / "session.log").read_text()


# ---------------------------------------------------------------- the Tcl script of the session
def test_older_tcl_script_is_named_in_the_answer(vivado, reachable, ltx, tmp_path, capsys):
    # every proc is there, so only the number shows that the script is from an earlier release
    vivado.script = "version=%d;missing=" % (ic.SCRIPT_VERSION - 1)
    ib.cmd_capture(job("capture", "--name", "c", "--ltx", ltx, "--out", str(tmp_path / "out")))
    said = "The Tcl script %s is older than this program (it is version %d, this program expects %d): Update" % (
        ic.resolve_tcl(None), ic.SCRIPT_VERSION - 1, ic.SCRIPT_VERSION)
    assert said in result_of(capsys)["message"]


@pytest.mark.parametrize("script", ["version=%d;missing=" % ic.SCRIPT_VERSION, "version=0;missing=", ""])
def test_tcl_script_of_this_release_or_of_ones_own_gets_no_note(vivado, reachable, ltx, tmp_path, capsys, script):
    # 0 is what a script answers that states no version, and nothing what one answers that cannot be asked
    vivado.script = script
    ib.cmd_capture(job("capture", "--name", "c", "--ltx", ltx, "--out", str(tmp_path / "out")))
    result = result_of(capsys)
    assert result["message"] == "Capture saved: " + result["csvPath"]
