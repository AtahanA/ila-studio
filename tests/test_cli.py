# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The command lines. Hardware commands of ila_capture.py run in this process against the recorder that stands
in for Vivado; the commands that need no hardware are started as real processes, from a copy of the scripts."""
import csv
import gzip
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


@pytest.mark.parametrize("side", ["before", "after"])
def test_every_option_of_the_whole_tool_may_stand_on_either_side_of_the_command(vivado, cli, write, tmp_path, side):
    script, ltx = write("mine.tcl", ""), str(tmp_path / "top.ltx")
    options = ["--profile", write("p.json", json.dumps({"capture": {"timeout_min": 2}})),
               "--server", "192.0.2.10", "--ltx", ltx, "--out", str(tmp_path / "out"),
               "--tcl", script, "--device", "xc7z020*", "--ila-index", "1", "--jtag-hz", "6000000",
               "--target", "my-board", "--trigger", "frame_start eq1'bR", "--position", "0", "--format", "csv"]
    command = ["capture", "--name", "c"]
    # before: a command writes its defaults over what was read so far, and must not put one of these back
    assert cli(*(options + command if side == "before" else command + options)) == 0
    assert vivado.started["vivado"][-2:] == ["-source", script]
    assert "ila_open {192.0.2.10:3121} {%s} {xc7z020*} 1 {*} 6000000" % ltx.replace("\\", "/") in vivado
    assert capture_commands(vivado)[0].endswith("/c} {frame_start eq1'bR} 0 2 csv UNSIGNED ALWAYS")
    (session,) = (tmp_path / "out").iterdir()
    assert session.name.endswith("_my-board")


def test_option_after_the_command_wins_over_the_same_one_before_it(vivado, cli, hardware, tmp_path):
    cli(*hardware, "--target", "my-board", "--position", "5", "capture", "--name", "c", "--position", "7")
    assert capture_commands(vivado)[0].endswith("} {now} 7 1 both UNSIGNED ALWAYS")
    (session,) = (tmp_path / "out").iterdir()
    assert session.name.endswith("_my-board")            # not given again: as it stood before the command


def test_abbreviations_of_one_letter_keep_the_meaning_they_had(vivado, cli, hardware, tmp_path):
    # --t, --p and --i fitted one option of a command each before the commands took the options of the whole
    # tool as well: --trigger (not --tcl or --target), --position (not --profile), --interval (not --ila-index)
    assert cli(*hardware, "capture", "--name", "c", "--t", "frame_start eq1'bR", "--p", "0", "--i", "0") == 0
    assert capture_commands(vivado)[0].endswith("} {frame_start eq1'bR} 0 1 both UNSIGNED ALWAYS")
    assert cli(*hardware, "watch", "--count", "1", "--minutes", "0.1", "--t", "frame_start eq1'bF", "--p", "7") == 0
    assert "ila_arm {frame_start eq1'bF} 7 UNSIGNED ALWAYS" in vivado
    assert vivado.started["vivado"][-1] == ic.resolve_tcl(None)      # the Tcl script and the target as they were
    assert all(session.name.endswith("_unit") for session in (tmp_path / "out").iterdir())


def test_session_is_called_unit_when_no_target_is_given(vivado, cli, hardware, tmp_path):
    assert cli("info", *hardware) == 0                   # a command that makes no session folder takes them too
    cli("capture", "--name", "c", *hardware)
    (session,) = (tmp_path / "out").iterdir()
    assert session.name.endswith("_unit")


def test_profile_may_follow_the_commands_that_need_no_hardware(cli, write, tmp_path, capsys):
    profile = write("p.json", json.dumps({"stats": {"event_probes": ["rx_valid"]}}))
    capture = write("cap.csv", HEAD + "top/rx_valid\n0,0,0,0\n1,1,1,1\n")
    assert cli("stats", capture, "--profile", profile) == 0
    assert capsys.readouterr().out.splitlines() == ["file,rows,ctrl,n_rx_valid", "cap.csv,2,,1"]
    assert cli("summary", str(tmp_path), "--profile", profile) == 0
    with open(str(tmp_path / "run_summary.csv"), newline="") as f:
        assert next(csv.reader(f)) == ["name", "n_rows", "time_unit", "rx_valid_n", "rx_valid_first",
                                       "rx_valid_last_off", "ctrl"]


def test_watch_records_a_window(vivado, cli, hardware, tmp_path):
    # --minutes 0.1: should the window never come, the run ends by itself after six seconds
    assert cli(*hardware, "watch", "--count", "1", "--minutes", "0.1", "--position", "0") == 0
    assert "ila_arm {now} 0 UNSIGNED ALWAYS" in vivado
    assert "ila_collect_rearm {now} 0 0.02 UNSIGNED ALWAYS 1" in vivado      # 0.02: the default --wait
    (session,) = (tmp_path / "out").iterdir()
    (row,) = index_rows(session)
    assert (row["name"], row["file"]) == ("w000000", "w000000.csv.gz")       # gzipped once it is in the index
    # the recorder wrote the bus in hex: in the file that is kept it is decimal, as "capture" leaves it
    with gzip.open(str(session / "w000000.csv.gz"), "rt") as f:
        assert f.read().splitlines()[1:] == ["0,0,1,0,10", "1,1,0,1,255"]
    assert row["note"] == ""


def test_watched_window_that_cannot_be_made_decimal_still_gets_its_row(write, tmp_path):
    # one column in hex and in decimal: the file is kept as it is, and the index says what happened to it
    src = write("w000000.csv", HEAD + "top/x[7:0]\n0,0,0,0a\n1,1,1,100\n")
    index, fields = str(tmp_path / "index.csv"), ic.watch_fields({})
    note = ic._watch_stats_row(index, fields, {"name": "w000000"}, src, {"mode": "none"}, False)
    assert "ValueError: column top/x[7:0]: both hex and decimal values" in note
    with open(index, newline="") as f:
        (row,) = csv.DictReader(f, fieldnames=fields)
    assert (row["name"], row["file"], row["note"]) == ("w000000", "w000000.csv", note)


@pytest.mark.parametrize("capture, options, written", [
    ({"format": "ila"}, [], "ila"),                      # what the profile file itself states
    ({"format": "Both"}, [], "both"),
    ({"position": 300}, [], "csv"),                      # not stated: csv, not the "both" of the built-in defaults
    ({"format": "ila"}, ["--format", "csv"], "csv"),     # the command line wins
])
def test_watch_writes_the_format_the_profile_states(vivado, cli, hardware, write, capture, options, written):
    profile = write("p.json", json.dumps({"capture": capture}))
    assert cli("--profile", profile, *hardware, "watch", "--count", "1", "--minutes", "0.1", *options) == 0
    (command,) = [command for command in vivado if command.startswith("ila_write_last ")]
    assert command.endswith("/w000000} " + written)


def test_watch_without_a_profile_writes_csv(vivado, cli, hardware):
    assert cli(*hardware, "watch", "--count", "1", "--minutes", "0.1") == 0
    assert [command.split(" ")[-1] for command in vivado if command.startswith("ila_write_last ")] == ["csv"]


def test_watch_refuses_a_format_of_a_profile_that_is_none(vivado, cli, hardware, write, tmp_path):
    # it would go into a Tcl command as it is written
    profile = write("p.json", json.dumps({"capture": {"format": "csv; exec calc"}}))
    message = cli("--profile", profile, *hardware, "watch", "--count", "1", "--minutes", "0.1")
    assert message == "capture.format is 'csv; exec calc': it must be one of both, ila, csv"
    assert vivado == [] and not (tmp_path / "out").exists()


def test_profile_that_is_not_json_is_reported_with_the_place(cli, write):
    message = cli("--profile", write("p.json", '{"name": }'), "check")
    assert "p.json: invalid JSON at line 1, column 10" in message


def test_profile_that_is_not_there_is_reported_in_a_sentence(cli, tmp_path):
    message = cli("--profile", str(tmp_path / "gone.json"), "check")
    assert message == "%s: the profile cannot be read (No such file or directory)" % (tmp_path / "gone.json")


@pytest.mark.parametrize("text, said", [
    ("[1, 2]", "this is no profile: the file must hold one JSON object, { ... }"),
    ('{"capture": null}', '"capture" must be a JSON object, { ... }'),
    ('{"hardware": "x"}', '"hardware" must be a JSON object, { ... }'),
])
def test_profile_that_is_json_but_no_profile_is_reported_in_a_sentence(cli, write, text, said):
    # valid JSON of the wrong shape: the file and what is wrong with it, as a file that is no JSON gets
    profile = write("p.json", text)
    assert cli("--profile", profile, "check") == "%s: %s" % (profile, said)


# ---------------------------------------------------------------- position, timeout and format of a profile
def test_format_of_a_profile_in_capitals_is_the_format_meant(vivado, cli, hardware, write):
    # sent as it is written, "CSV" made the Tcl side write the .ila as well: it knows the small letters only
    profile = write("p.json", json.dumps({"capture": {"format": "CSV"}}))
    assert cli("--profile", profile, *hardware, "capture", "--name", "c") == 0
    assert capture_commands(vivado)[0].endswith("} {now} 1000 1 csv UNSIGNED ALWAYS")


@pytest.mark.parametrize("capture, said", [
    ({"timeout_min": "2"}, "capture.timeout_min is '2': it must be a number of minutes above 0"),
    ({"position": "12; puts hi"}, "capture.position is '12; puts hi': it must be a whole number of 0 or more"),
    ({"format": "tar"}, "capture.format is 'tar': it must be one of both, ila, csv"),
])
def test_capture_value_of_a_profile_that_cannot_be_meant_ends_the_run_before_anything_is_started(
        vivado, cli, hardware, write, tmp_path, capture, said):
    # text in these keys went into the Tcl command as it was written: "12; puts hi" as a command of its own
    profile = write("p.json", json.dumps({"capture": capture}))
    for command in (["capture", "--name", "c"], ["watch", "--count", "1", "--minutes", "0.1"]):
        assert cli("--profile", profile, *hardware, *command).startswith(said)
    assert vivado == [] and vivado.started == {} and not (tmp_path / "out").exists()


def test_format_and_position_of_the_command_line_are_the_ones_that_are_checked(vivado, cli, hardware, write):
    profile = write("p.json", json.dumps({"capture": {"format": "tar", "position": "12"}}))
    assert cli("--profile", profile, *hardware, "capture", "--name", "c", "--format", "csv", "--position", "7") == 0
    assert capture_commands(vivado)[0].endswith("} {now} 7 1 csv UNSIGNED ALWAYS")


# A run that fails ends with the sentence alone and the exit code 1: main leaves through SystemExit with the
# sentence, which Python prints as it is. A traceback would be any other exception coming out of main.
@pytest.fixture
def nowhere(no_vivado, write, tmp_path):
    """A profile whose Vivado is not there, on a PC where the search finds none either."""
    return write("nowhere.json", json.dumps({"tools": {"vivado": str(tmp_path / "vivado.bat")}}))


@pytest.mark.parametrize("command", [["info"], ["capture", "--name", "c"]])
def test_run_that_cannot_start_vivado_ends_with_the_sentence_alone(nowhere, cli, hardware, command):
    message = cli("--profile", nowhere, *hardware, *command)
    assert message.startswith("Vivado not found (tools.vivado is ")


def test_unusable_trigger_ends_with_the_sentence_alone(vivado, cli, hardware, tmp_path):
    message = cli(*hardware, "capture", "--name", "c", "--trigger", "a}b eq1")
    assert message.startswith("the trigger 'a}b eq1' cannot be used")
    assert vivado == [] and not (tmp_path / "out").exists()


def test_failed_connect_ends_with_the_sentence_alone(vivado, cli, hardware):
    vivado.failing["ila_open"] = "no hardware target on 192.0.2.10:3121"
    message = cli(*hardware, "info")
    assert message.startswith("vivado: 'ila_open ")
    assert message.endswith("failed: no hardware target on 192.0.2.10:3121")


def test_capture_or_folder_that_is_not_there_ends_with_the_sentence_alone(cli, write, tmp_path):
    # the commands that need no hardware, and a slip in a name: what follows is the reason the system gives
    capture, gone = write("cap.csv", HEX), str(tmp_path / "gone.csv")
    assert cli("stats", capture, gone).startswith(gone + ": the capture cannot be read (")
    for folder in (str(tmp_path / "gone"), capture):     # not there, and a file
        assert cli("summary", folder).startswith(folder + ": the folder cannot be read (")


def test_hook_whose_tools_are_not_installed_ends_with_the_sentence_alone(vivado, cli, hardware, write, tmp_path):
    # nm and objdump are run as the profile names them, before anything else is started
    nm = str(tmp_path / "bin" / "nm.exe")
    profile = write("hook.json", json.dumps({"tools": {"nm": nm},
                                             "hook": {"symbol": "capture_hook", "info_symbol": "capture_info"}}))
    message = cli("--profile", profile, *hardware, "hook", "--elf", "app.elf")
    assert message.startswith("tools.nm of the profile cannot be started (%s: " % nm)
    assert vivado.started == {} and not (tmp_path / "out").exists()


def test_watch_that_ends_in_an_error_exits_with_1(nowhere, cli, hardware, tmp_path):
    assert cli("--profile", nowhere, *hardware, "watch", "--count", "1", "--minutes", "0.1") == 1
    (session,) = (tmp_path / "out").iterdir()
    assert "ERROR: RuntimeError: Vivado not found" in (session / "session.log").read_text()


def test_watch_that_gives_up_exits_with_1(vivado, cli, hardware, tmp_path):
    vivado.failing["ila_collect_rearm"] = "the hardware target is gone"
    assert cli(*hardware, "watch", "--count", "1", "--minutes", "0.1", "--max-retries", "0") == 1
    (session,) = (tmp_path / "out").iterdir()
    assert "giving up after 1 consecutive failures" in (session / "session.log").read_text()


def test_file_patterns_are_expanded_by_the_tool_itself(write, tmp_path):
    # cmd.exe and PowerShell hand "*.csv" on as it is
    files = sorted([write("b.csv", ""), write("a.csv", "")])
    assert ic.expand([str(tmp_path / "*.csv")]) == files
    assert ic.expand([str(tmp_path / "*.ila")]) == [str(tmp_path / "*.ila")]      # no hit: left as it was given


# ---------------------------------------------------------------- the hw_server address
def test_server_is_brought_into_its_one_form(vivado, cli, tmp_path):
    cli("--server", "TCP:192.0.2.10", "--ltx", str(tmp_path / "top.ltx"), "--out", str(tmp_path / "out"), "info")
    assert [command.split(" ")[1] for command in vivado if command.startswith("ila_open ")] == ["{192.0.2.10:3121}"]


@pytest.mark.parametrize("server, said", [
    ("a&echo.SECOND&rem", "'a&echo.SECOND&rem' is not a hw_server address"),     # cmd would run what follows "&"
    ("http://192.0.2.10", "'http://192.0.2.10' is not a hw_server address"),
    ("", "no hw_server address given"),                  # not: the address of the profile, without a word
    ("   ", "no hw_server address given"),
])
def test_server_that_is_no_address_ends_the_run_before_anything_is_started(vivado, cli, tmp_path, server, said):
    for command in (["info"], ["capture", "--name", "c"], ["watch", "--count", "1"]):
        message = cli("--server", server, "--ltx", str(tmp_path / "top.ltx"), "--out", str(tmp_path / "out"), *command)
        assert message.startswith(said)
    assert vivado == [] and vivado.started == {} and not (tmp_path / "out").exists()


def test_address_of_a_profile_is_checked_as_well(vivado, cli, write, tmp_path):
    profile = write("p.json", json.dumps({"hardware": {"url": "a[exec calc.exe]::"}}))
    message = cli("--profile", profile, "--ltx", str(tmp_path / "top.ltx"), "--out", str(tmp_path / "out"), "info")
    assert message.startswith("'a[exec calc.exe]::' is not a hw_server address")
    assert vivado.started == {}


# ---------------------------------------------------------------- the Tcl script of a session
def session_log(tmp_path):
    (session,) = (tmp_path / "out").iterdir()
    return (session / "session.log").read_text()


def test_log_names_the_tcl_script_and_its_version(vivado, cli, hardware, tmp_path, capsys):
    cli(*hardware, "capture", "--name", "c")
    assert " Tcl script %s, version %d\n" % (ic.resolve_tcl(None), ic.SCRIPT_VERSION) in session_log(tmp_path)
    assert "Tcl script" not in capsys.readouterr().out   # for the log, not for the screen


def test_log_names_the_script_of_a_further_vivado_as_well(vivado, cli, hardware, tmp_path):
    cli(*hardware, "watch", "--count", "2", "--minutes", "0.1", "--writers", "2")
    log = session_log(tmp_path)
    assert " Tcl script %s, version %d\n" % (ic.resolve_tcl(None), ic.SCRIPT_VERSION) in log
    assert " [vivado-2] Tcl script %s\n" % ic.resolve_tcl(None) in log
    # the version is asked of the first Vivado only: the further one sourced the same file
    assert sum(command.startswith("set ::ILA_CHECK") for command in vivado) == 1


def test_script_of_ones_own_that_states_no_version_is_not_called_older(vivado, cli, hardware, tmp_path, capsys):
    vivado.script = "version=0;missing="
    cli(*hardware, "capture", "--name", "c")
    assert "version not stated" in session_log(tmp_path)
    assert "older than this program" not in capsys.readouterr().out


def test_script_with_a_lower_version_is_said_to_be_older(vivado, cli, hardware, capsys):
    vivado.script = "version=%d;missing=" % (ic.SCRIPT_VERSION - 1)
    cli(*hardware, "capture", "--name", "c")
    assert "WARNING The Tcl script %s is older than this program (it is version %d, this program expects %d): " % (
        ic.resolve_tcl(None), ic.SCRIPT_VERSION - 1, ic.SCRIPT_VERSION) in capsys.readouterr().out


def test_way_out_of_an_older_script_fits_who_named_it(vivado, cli, hardware, write, capsys):
    vivado.script = "version=%d;missing=" % (ic.SCRIPT_VERSION - 1)

    def warned(*options):
        cli(*hardware, *options, "info")
        (line,) = [line for line in capsys.readouterr().out.splitlines() if "WARNING The Tcl script" in line]
        return line.split("): ")[1]

    # nobody named the bundled script: there is no field to clear and no option to leave out
    assert warned() == "Update the scripts folder together with the program."
    assert warned("--tcl", write("mine.tcl", "")) == (
        "Update the scripts folder together with the program, or clear the Tcl script field (leave out --tcl on a "
        "command line) if it names a copy from an earlier release.")


def test_tcl_script_that_is_not_there_ends_the_run_before_anything_is_started(vivado, cli, hardware, tmp_path):
    # not: Vivado started with the bundled script, and not a word about it
    for command in (["info"], ["capture", "--name", "c"], ["watch", "--count", "1", "--minutes", "0.1"]):
        assert cli(*hardware, "--tcl", "my_repl.tcl", *command) == "Tcl script not found: my_repl.tcl"
    assert vivado == [] and vivado.started == {} and not (tmp_path / "out").exists()


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
    # options of the whole tool, such as --profile, stand before the command or after it
    for order in (["--profile", profile, "check"], ["check", "--profile", profile]):
        done = run(app, "ila_capture.py", *order, XILINX_VIVADO=str(tmp_path / "Vivado"))
        assert done.returncode == 0
        assert done.stdout.rstrip().endswith("OK")


def test_failed_run_prints_one_line_and_exits_with_1(app, tmp_path):
    # no traceback. None of them gets as far as looking for Vivado
    (tmp_path / "list.json").write_text("[1, 2]")        # JSON, but no profile
    for argv in (["--profile", str(tmp_path / "gone.json"), "check"],
                 ["--profile", str(tmp_path / "list.json"), "check"],
                 ["capture", "--name", "c", "--trigger", "a}b eq1", "--out", str(tmp_path / "out")],
                 ["capture", "--name", "c", "--tcl", "my_repl.tcl", "--out", str(tmp_path / "out")]):
        done = run(app, "ila_capture.py", *argv)
        assert done.returncode == 1 and done.stdout == ""
        assert len(done.stderr.splitlines()) == 1 and "Traceback" not in done.stderr


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


@pytest.mark.parametrize("given, written", [("w000000.csv.gz", "w000000.csv.gz"), ("w000000.ila", "w000000.csv")])
def test_convert_takes_a_single_file_as_it_does_in_a_folder(app, write, tmp_path, given, written):
    # .csv.gz is what "watch" leaves behind, so it is what a recording consists of
    path = write(given, HEX)
    before = (tmp_path / given).read_bytes()
    done = run(app, "ila_capture.py", "convert", path)
    assert done.returncode == 0
    assert "skipped" not in done.stdout and "1 CSV(s) written in decimal, 0 already decimal" in done.stdout
    assert ic.read_ila_text(str(tmp_path / written)) == DEC
    if given.endswith(".ila"):
        assert (tmp_path / given).read_bytes() == before                 # the archive itself is never rewritten


def test_convert_says_what_it_skipped_and_fails_when_nothing_was_there_to_convert(app, write, tmp_path):
    notes = write("notes.csv", "not,a,capture\n")
    done = run(app, "ila_capture.py", "convert", notes, str(tmp_path / "gone.csv.gz"))
    assert done.returncode == 1
    assert done.stdout.splitlines()[:3] == [
        "skipped (not an ILA CSV): " + notes,
        "skipped (not an ILA CSV): " + str(tmp_path / "gone.csv.gz"),
        "0 ILA CSV(s) to check"]


def test_convert_of_an_archive_does_not_fail_the_second_time(app, write, tmp_path):
    # a script that converts an archive by name on every run: from the second run on its CSV is there, which
    # leaves nothing to do and is nothing wrong
    archive = write("b.ila", HEX)
    for said in ("1 ILA CSV(s) to check", "skipped (it has its CSV already, %s): %s" % (tmp_path / "b.csv", archive)):
        done = run(app, "ila_capture.py", "convert", archive)
        assert (done.returncode, done.stdout.splitlines()[0]) == (0, said)
        assert (tmp_path / "b.csv").read_text() == DEC
    # ... also next to a path that holds no capture: one that was converted before is enough
    assert run(app, "ila_capture.py", "convert", archive, write("notes.csv", "not,a,capture\n")).returncode == 0


def test_convert_of_a_folder_without_captures_fails(app, tmp_path):
    (tmp_path / "empty").mkdir()
    assert run(app, "ila_capture.py", "convert", str(tmp_path / "empty")).returncode == 1


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
