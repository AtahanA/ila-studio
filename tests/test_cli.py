# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The command lines. Hardware commands of ila_capture.py run in this process against the recorder that stands
in for Vivado; the commands that need no hardware are started as real processes, from a copy of the scripts."""
import csv
import json
import os
import subprocess
import sys

import pytest

import ila_capture as ic

HEAD = "Sample in Buffer,Sample in Window,TRIGGER,"
HEX = HEAD + "top/x[7:0]\n0,0,0,0a\n1,1,1,ff\n"
DEC = HEAD + "top/x[7:0]\n0,0,0,10\n1,1,1,255\n"


# ---------------------------------------------------------------- hardware commands, Vivado replaced
@pytest.fixture
def hardware(tmp_path):
    """The options every hardware command below is given: a server, a probe file and an output folder."""
    return ["--server", "192.0.2.10", "--ltx", str(tmp_path / "top.ltx"), "--out", str(tmp_path / "out")]


def capture_commands(vivado):
    """The ila_capture commands sent. Their arguments after the file name: trigger, position, minutes to wait
    for the trigger, format, radix, capture mode."""
    return [command for command in vivado if command.startswith("ila_capture ")]


def index_rows(session):
    with open(str(session / "index.csv"), newline="") as f:
        return list(csv.DictReader(f))


def test_capture_from_connect_to_index(vivado, cli, hardware, tmp_path):
    assert cli(*hardware, "capture", "--name", "cap_run_001") == 0
    # the server got its default port, and every argument of ila_open is one braced word
    assert "ila_open {192.0.2.10:3121} {%s} {*} 0 {*} 0" % str(tmp_path / "top.ltx").replace("\\", "/") in vivado
    (session,) = (tmp_path / "out").iterdir()
    # the recorder wrote the bus in hex, as Vivado would by default: the driver has made it decimal
    assert (session / "cap_run_001.csv").read_text().splitlines()[1:] == ["0,0,1,0,10", "1,1,0,1,255"]
    (row,) = index_rows(session)
    assert (row["name"], row["target"], row["rows"]) == ("cap_run_001", "unit", "2")


def test_position_zero_reaches_a_capture(vivado, cli, hardware):
    cli(*hardware, "capture", "--name", "c", "--position", "0")
    (command,) = capture_commands(vivado)
    assert command.endswith("} {now} 0 1 both UNSIGNED ALWAYS")


def test_position_of_the_profile_is_used_when_none_is_given(vivado, cli, hardware, write):
    profile = write("p.json", json.dumps({"capture": {"position": 300}}))
    cli("--profile", profile, *hardware, "capture", "--name", "c")
    assert capture_commands(vivado)[0].endswith("} {now} 300 1 both UNSIGNED ALWAYS")


def test_trigger_position_and_format_may_stand_before_the_command(vivado, cli, hardware):
    cli("--trigger", "frame_start eq1'bR", "--position", "0", "--format", "csv", *hardware, "capture", "--name", "c")
    assert capture_commands(vivado)[0].endswith("} {frame_start eq1'bR} 0 1 csv UNSIGNED ALWAYS")


def test_watch_records_a_window(vivado, cli, hardware, tmp_path):
    # --minutes 0.1: should the window never come, the run ends by itself after six seconds
    assert cli(*hardware, "watch", "--count", "1", "--minutes", "0.1", "--position", "0") == 0
    assert "ila_arm {now} 0 UNSIGNED ALWAYS" in vivado
    assert "ila_collect_rearm {now} 0 0.02 UNSIGNED ALWAYS 1" in vivado      # 0.02: the default --wait
    (session,) = (tmp_path / "out").iterdir()
    (row,) = index_rows(session)
    assert (row["name"], row["file"]) == ("w000000", "w000000.csv.gz")       # gzipped once it is in the index
    assert (session / "w000000.csv.gz").exists()


def test_profile_that_is_not_json_is_reported_with_the_place(cli, write):
    message = cli("--profile", write("p.json", '{"name": }'), "check")
    assert "p.json: invalid JSON at line 1, column 10" in message


def test_file_patterns_are_expanded_by_the_tool_itself(write, tmp_path):
    # cmd.exe and PowerShell hand "*.csv" on as it is
    files = sorted([write("b.csv", ""), write("a.csv", "")])
    assert ic.expand([str(tmp_path / "*.csv")]) == files
    assert ic.expand([str(tmp_path / "*.ila")]) == [str(tmp_path / "*.ila")]      # no hit: left as it was given


# ---------------------------------------------------------------- real processes, no hardware
def run(app, script, *args, **env):
    """One of the two scripts of the copy, started the way a person or the GUI starts it."""
    return subprocess.run([sys.executable, "-B", str(app / script)] + list(args), cwd=str(app),
                          env=dict(os.environ, **env), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=120)


def test_check_without_a_profile_fails(app):
    done = run(app, "ila_capture.py", "check")
    assert done.returncode == 1
    assert "PROBLEM: hardware.ltx is empty" in done.stdout


def test_check_passes_a_profile_whose_vivado_is_found_by_searching(app, write, tmp_path):
    (tmp_path / "Vivado" / "bin").mkdir(parents=True)
    (tmp_path / "Vivado" / "bin" / "vivado.bat").write_text("")
    profile = write("p.json", json.dumps({
        "tools": {"vivado": str(tmp_path / "elsewhere" / "vivado.bat")},      # not there: a run would search
        "hardware": {"ltx": write("top.ltx", "<probeData/>")},
        "capture": {"out": str(tmp_path / "out")}}))
    # options of the whole tool, such as --profile, stand before the command
    done = run(app, "ila_capture.py", "--profile", profile, "check", XILINX_VIVADO=str(tmp_path / "Vivado"))
    assert done.returncode == 0
    assert done.stdout.rstrip().endswith("OK")


def test_stats_prints_one_row_per_file(app, write):
    done = run(app, "ila_capture.py", "stats", write("cap.csv", HEX))
    rows = list(csv.reader(line for line in done.stdout.splitlines() if line))
    assert rows == [["file", "rows", "ctrl"], ["cap.csv", "2", ""]]


def test_stats_table_has_one_line_end_per_row(app, write):
    # stdout is a text stream: a csv.writer left at its default "\r\n" would end every line in "\r\r\n" on Windows
    done = subprocess.run([sys.executable, "-B", str(app / "ila_capture.py"), "stats", write("cap.csv", HEX)],
                          cwd=str(app), stdout=subprocess.PIPE, timeout=120)
    assert b"\r\r\n" not in done.stdout


def test_summary_writes_one_row_per_capture(app, write, tmp_path):
    for name in ("a.csv", "a.ila", "b.csv.gz"):          # a.ila is the same capture as a.csv
        write(name, HEX)
    write("index.csv", "time,name\n")                    # the session's own files are no captures
    write("notes.csv", "not,a,capture\n")
    done = run(app, "ila_capture.py", "summary", str(tmp_path))
    assert "(2 captures)" in done.stdout
    with open(str(tmp_path / "run_summary.csv"), newline="") as f:
        assert list(csv.reader(f)) == [["name", "n_rows", "time_unit", "ctrl"], ["a", "2", "samples", ""],
                                       ["b", "2", "samples", ""]]


def test_convert_makes_a_folder_decimal(app, write, tmp_path):
    write("a.csv", HEX)
    write("b.ila", HEX)                                  # an archive without a CSV next to it
    write("c.csv", DEC)
    write("notes.csv", "not,a,capture\n")
    archive = (tmp_path / "b.ila").read_bytes()
    done = run(app, "ila_capture.py", "convert", str(tmp_path))
    assert done.returncode == 0
    assert "2 CSV(s) written in decimal, 1 already decimal" in done.stdout
    assert (tmp_path / "a.csv").read_text() == DEC
    assert (tmp_path / "b.csv").read_text() == DEC       # extracted from the archive ...
    assert (tmp_path / "b.ila").read_bytes() == archive  # ... which itself is never touched
    assert (tmp_path / "notes.csv").read_text() == "not,a,capture\n"


def test_bridge_answers_with_one_json_document(app, write):
    done = run(app, "ila_bridge.py", "parse-ltx", "--ltx", write("top.ltx", "<probeData/>"))
    assert json.loads(done.stdout) == {"cores": [], "probes": [], "hubClockHz": 0, "maxSafeTckHz": 0}


def test_demo_capture_is_written_next_to_the_scripts_and_can_be_parsed(app):
    made = json.loads(run(app, "ila_bridge.py", "demo-capture", "--samples", "64").stdout)
    assert made["status"] == "ok"
    assert os.path.dirname(made["filePath"]) == str(app / "captures")
    shown = json.loads(run(app, "ila_bridge.py", "parse-csv", "--file", made["filePath"], "--max-samples", "16").stdout)
    assert (shown["totalSamples"], shown["step"], shown["displayedSamples"]) == (64, 4, 16)


def test_bridge_lists_the_profiles_next_to_the_scripts(app):
    (app / "profiles").mkdir()
    (app / "profiles" / "board.json").write_text(json.dumps({"name": "my-board"}))
    (listed,) = json.loads(run(app, "ila_bridge.py", "list-profiles").stdout)
    assert (listed["filename"], listed["name"]) == ("board.json", "my-board")


def test_second_vivado_leaves_the_cable_clock_alone_and_signed_probes_are_announced(vivado, cli, hardware, write):
    profile = write("p.json", json.dumps({"capture": {"probe_format": {"top/u1/data": "signed"}}}))
    assert cli("--profile", profile, *hardware, "watch", "--count", "2", "--minutes", "0.1", "--writers", "2") == 0
    opens = [i for i, command in enumerate(vivado) if command.startswith("ila_open ")]
    assert len(opens) == 2
    # before it connects: what it would otherwise put back when it closes is what the first one had set
    assert opens[0] < vivado.index("set ::JTAG_LEAVE 1") < opens[1]
    assert vivado.count("ila_probe_radix [list {top/u1/data} SIGNED]") == 2      # each Vivado is told
    assert sum(command.startswith("set ::STOP_FILE {") for command in vivado) == 2
