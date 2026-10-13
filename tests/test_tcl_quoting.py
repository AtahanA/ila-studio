# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""What is written into a Tcl command. A value that comes from a profile, the command line or the GUI has to
reach Vivado as one word of text whatever it contains - or be refused before Vivado is started."""
import os
import threading
import types

import pytest

import ila_capture as ic


# ---------------------------------------------------------------- one word
@pytest.mark.parametrize("text, word", [
    ("top/u1/data", "{top/u1/data}"),
    ("a[3]", "{a[3]}"),                                  # brackets and $ are plain text between braces
    ("", "{}"),
    ("a b", '"a b"'),
    ("a{b", '"a\\{b"'),                                  # a brace of its own would end the braces early
    ("a\\b", '"a\\\\b"'),
    ('a "b" $c [d]', '"a \\"b\\" \\$c \\[d\\]"'),
])
def test_any_text_as_one_tcl_word(text, word):
    assert ic.tcl_word(text) == word


@pytest.mark.parametrize("path, word", [
    (r"C:\work\top.ltx", "{C:/work/top.ltx}"),
    (r"C:\my work\build 1\top.ltx", "{C:/my work/build 1/top.ltx}"),      # spaces need the braces only
    ("/home/user/top.ltx", "{/home/user/top.ltx}"),
    (r"C:\a{b}\top.ltx", '"C:/a\\{b\\}/top.ltx"'),
    (r"C:\my work\a}b\top.ltx", '"C:/my work/a\\}b/top.ltx"'),
])
def test_path_as_one_tcl_word(path, word):
    assert ic.tcl_path(path) == word


# ---------------------------------------------------------------- the trigger
@pytest.mark.parametrize("trigger", [
    "now",
    "frame_start eq1'bR",
    "top/bus[3] eq4'h0A",
    "{a} b",                                             # braces that pair up stay inside the word
    "a\\}b eq1'b1",                                      # Tcl does not count a brace behind a backslash
])
def test_trigger_is_passed_on_in_braces(trigger):
    assert ic.tcl_trigger(trigger) == "{" + trigger + "}"


@pytest.mark.parametrize("trigger", [
    "a}b eq1'b1",
    "a{b eq1'b1",
    "now} ; exec calc ; {",                              # as many opening as closing braces, in the wrong order
    "now\\",                                             # the backslash would take the closing brace of the word
])
def test_trigger_whose_braces_do_not_pair_up_is_refused(trigger):
    with pytest.raises(RuntimeError, match="braces do not pair up"):
        ic.tcl_trigger(trigger)


# ---------------------------------------------------------------- radix and capture mode
def test_radix_and_capture_mode_default():
    assert ic.capture_words({}) == ["UNSIGNED", "ALWAYS"]
    assert ic.capture_words({"radix": "", "capture_mode": None}) == ["UNSIGNED", "ALWAYS"]


def test_radix_and_capture_mode_are_sent_in_capitals():
    # any letter case is taken, but Vivado gets its own spelling: the Tcl side drops a refused one without a word
    assert ic.capture_words({"radix": "signed", "capture_mode": " Basic "}) == ["SIGNED", "BASIC"]
    assert ic.capture_words({"radix": "HEX", "capture_mode": "ALWAYS"}) == ["HEX", "ALWAYS"]


@pytest.mark.parametrize("capture, said", [
    ({"radix": "BINARY"}, "capture.radix is 'BINARY': it must be one of UNSIGNED, SIGNED, HEX"),
    ({"capture_mode": "x"}, "capture.capture_mode is 'x': it must be one of ALWAYS, BASIC"),
    ({"radix": "UNSIGNED; exec calc"}, "capture.radix is"),
    ({"capture_mode": "[exec calc]"}, "capture.capture_mode is"),
])
def test_unknown_radix_or_capture_mode_is_refused(capture, said):
    with pytest.raises(RuntimeError) as refused:
        ic.capture_words(capture)
    assert said in str(refused.value)


@pytest.mark.parametrize("trigger, radix, said", [
    ("a}b eq1'b1", "UNSIGNED", "braces do not pair up"),
    ("now", "OCTAL", "capture.radix is 'OCTAL'"),
])
def test_capture_session_refuses_before_it_makes_its_folder(tmp_path, trigger, radix, said):
    prof = ic.load_profile(None)
    prof["capture"]["radix"] = radix
    args = types.SimpleNamespace(trigger=trigger, out=str(tmp_path / "out"), target="unit")
    with pytest.raises(RuntimeError, match=said):
        ic.Session(args, prof)
    assert not (tmp_path / "out").exists()


# ---------------------------------------------------------------- position, timeout and format
def test_position_timeout_and_format_default():
    assert ic.capture_values({}) == (1000, 1, "both")
    assert ic.capture_values({"position": None, "timeout_min": None, "format": ""}) == (1000, 1, "both")


def test_position_and_timeout_reach_the_command_as_they_are_written():
    # a whole number stays one and a fraction a fraction: the commands of ordinary input are what they were
    assert "%s %s %s" % ic.capture_values({"position": 0, "timeout_min": 2, "format": "csv"}) == "0 2 csv"
    assert "%s %s %s" % ic.capture_values({"position": 300, "timeout_min": 0.5, "format": "ila"}) == "300 0.5 ila"
    # the bridge writes --timeout-min into the key, and that is a float also where it is a whole number
    assert "%s" % ic.capture_values({"timeout_min": 1.0})[1] == "1.0"


def test_format_is_sent_in_small_letters():
    # any letter case is taken, but the Tcl side knows "csv" and "ila" in small letters only: "CSV" as it is
    # written would get the .ila as well
    assert ic.capture_values({"format": "CSV"})[2] == "csv"
    assert ic.capture_values({"format": " Ila "})[2] == "ila"


@pytest.mark.parametrize("capture, said", [
    ({"position": "12; puts hi"}, "capture.position is '12; puts hi': it must be a whole number of 0 or more "
                                  "(it is text: write the number without quotes)"),
    ({"position": "12"}, "capture.position is '12': it must be a whole number of 0 or more (it is text"),
    ({"position": -1}, "capture.position is -1: it must be a whole number of 0 or more"),
    ({"position": 12.5}, "capture.position is 12.5: it must be a whole number"),
    ({"position": True}, "capture.position is True: it must be a whole number"),
    ({"timeout_min": "2"}, "capture.timeout_min is '2': it must be a number of minutes above 0, at most %d "
                           "(it is text: write the number without quotes)" % ic.MAX_TIMEOUT_MIN),
    ({"timeout_min": 0}, "capture.timeout_min is 0: it must be a number of minutes above 0"),
    ({"timeout_min": -1.5}, "capture.timeout_min is -1.5: it must be a number of minutes above 0"),
    ({"timeout_min": float("inf")}, "capture.timeout_min is inf: it must be a number"),
    ({"timeout_min": float("nan")}, "capture.timeout_min is nan: it must be a number"),
    ({"timeout_min": [1]}, "capture.timeout_min is [1]: it must be a number"),
    ({"timeout_min": False}, "capture.timeout_min is False: it must be a number"),
    ({"format": "tar"}, "capture.format is 'tar': it must be one of both, ila, csv"),
    ({"format": "csv; exec calc"}, "capture.format is 'csv; exec calc': it must be one of both, ila, csv"),
    ({"format": 5}, "capture.format is 5: it must be one of both, ila, csv"),
])
def test_position_timeout_or_format_that_cannot_be_meant_is_refused(capture, said):
    with pytest.raises(RuntimeError) as refused:
        ic.capture_values(capture)
    assert said in str(refused.value)


def test_every_value_that_is_wrong_is_named():
    with pytest.raises(RuntimeError) as refused:
        ic.capture_values({"position": -1, "timeout_min": 2, "format": "tar"})
    assert str(refused.value) == ("capture.position is -1: it must be a whole number of 0 or more; "
                                  "capture.format is 'tar': it must be one of both, ila, csv")


def test_longest_wait_for_a_trigger_is_one_this_python_can_wait():
    # a capture command is waited for ten minutes longer than its trigger; a wait beyond what a lock of this
    # Python takes would end in an OverflowError inside the driver
    assert ic.MAX_TIMEOUT_MIN * 60 + 600 <= threading.TIMEOUT_MAX
    assert ic.capture_values({"timeout_min": ic.MAX_TIMEOUT_MIN})[1] == ic.MAX_TIMEOUT_MIN
    with pytest.raises(RuntimeError, match="capture.timeout_min is"):
        ic.capture_values({"timeout_min": ic.MAX_TIMEOUT_MIN + 1})


@pytest.mark.parametrize("capture, said", [
    ({"position": "12; puts hi"}, "capture.position is '12; puts hi'"),
    ({"timeout_min": "2"}, "capture.timeout_min is '2'"),
    ({"format": "tar"}, "capture.format is 'tar'"),
])
def test_capture_session_refuses_these_before_it_makes_its_folder_too(tmp_path, capture, said):
    prof = ic.load_profile(None)
    prof["capture"].update(capture)
    args = types.SimpleNamespace(trigger="now", out=str(tmp_path / "out"), target="unit")
    with pytest.raises(RuntimeError) as refused:
        ic.Session(args, prof)
    assert said in str(refused.value)
    assert not (tmp_path / "out").exists()


# ---------------------------------------------------------------- ila_open
def open_command(**hardware):
    """The ila_open command of a session with these hardware settings."""
    prof = ic.load_profile(None)
    prof["hardware"].update(ltx=r"C:\work\top.ltx", **hardware)
    return ic.Session(None, prof, ephemeral=True)._ila_open_cmd()


def test_ila_open_takes_every_argument_as_one_word():
    assert open_command(url="192.0.2.10:3121") == "ila_open {192.0.2.10:3121} {C:/work/top.ltx} {*} 0 {*} 0"


def test_ipv6_address_is_text_not_a_command():
    # without the braces Tcl would run "::1" as a command and put its result in place of the brackets
    assert open_command(url="[::1]:3121").startswith("ila_open {[::1]:3121} ")


def test_address_cannot_end_its_own_word():
    # no session is made with such an address (see below): the word is safe by itself all the same
    prof = ic.load_profile(None)
    session = ic.Session(None, prof, ephemeral=True)
    prof["hardware"]["url"] = "a}; exec calc; #"
    assert session._ila_open_cmd().startswith('ila_open "a\\}; exec calc; #" ')


def test_session_is_not_made_with_text_that_is_no_address():
    with pytest.raises(RuntimeError, match="is not a hw_server address"):
        open_command(url="a}; exec calc; #")


def test_session_brings_the_address_into_its_one_form():
    assert open_command(url="TCP:192.0.2.10").startswith("ila_open {192.0.2.10:3121} ")


def test_filters_core_position_and_jtag_clock():
    command = open_command(url="localhost:3121", device_filter="xc7z020*", target_filter="", ila_index=2,
                           jtag_frequency_hz=6000000)
    # an empty filter means any device or target: it is sent as "*", so every argument stays in its place
    assert command == "ila_open {localhost:3121} {C:/work/top.ltx} {xc7z020*} 2 {*} 6000000"


def test_core_chosen_by_name_is_opened_at_the_first_position():
    # it is selected by name after the open; a position kept from another design may not exist in this one
    assert open_command(ila_cell="u_ila_1", ila_index=5).endswith(" {*} 0 {*} 0")


# ---------------------------------------------------------------- the process
def test_xilinx_tools_are_started_through_cmd_on_windows_only():
    assert ic.launch("vivado.bat", "-mode", "tcl") == (["cmd", "/c"] if os.name == "nt" else []) + [
        "vivado.bat", "-mode", "tcl"]


def test_where_there_is_no_cmd_the_tool_is_started_with_the_list_as_it_is(monkeypatch):
    monkeypatch.setattr(ic.os, "name", "posix")
    argv = ic.launch("/opt/Xilinx/R&D 100%/bin/vivado", "-mode", "tcl", "-source", '/home/user/my "own"/repl.tcl')
    assert argv == ["/opt/Xilinx/R&D 100%/bin/vivado", "-mode", "tcl", "-source", '/home/user/my "own"/repl.tcl']
    assert ic.cmd_line(argv) is argv                     # nothing is rewritten and nothing refused


def test_list_that_does_not_go_through_cmd_is_handed_on_as_it_is():
    # a program that is started directly (the tclsh and the Python of these tests) is no business of cmd_line
    argv = [r"C:\Program Files\Git\mingw64\bin\tclsh.exe", r"C:\R&D 100%\repl.tcl"]
    assert ic.cmd_line(argv) is argv


windows = pytest.mark.skipif(os.name != "nt", reason="the tools are started through cmd.exe on Windows only")
ARGUMENTS = ("-mode", "tcl", "-nolog", "-nojournal", "-notrace", "-source")


@windows
def test_line_for_cmd_of_an_ordinary_start():
    line = ic.cmd_line(ic.launch(r"C:\Xilinx\Vivado\2017.4\bin\vivado.bat", *ARGUMENTS,
                                 r"C:\ila-studio\scripts\vivado_ila_repl.tcl"))
    # one string, or subprocess would quote it once more. Between the outer quotes, which cmd takes off (/s), it
    # is the line that was sent before: no word of it needs quotes, and none has got any
    assert line == ('"%s" /d /s /c "' % os.environ["ComSpec"] + r"C:\Xilinx\Vivado\2017.4\bin\vivado.bat -mode tcl "
                    r'-nolog -nojournal -notrace -source C:\ila-studio\scripts\vivado_ila_repl.tcl"')


@windows
@pytest.mark.parametrize("word, written", [
    (r"C:\my tools\vivado.bat", r'"C:\my tools\vivado.bat"'),
    (r"D:\R&D\vivado.bat", r'"D:\R&D\vivado.bat"'),
    (r"C:\a^b\x|y<z>\vivado.bat", r'"C:\a^b\x|y<z>\vivado.bat"'),
    ("C:\\my tools\\", '"C:\\my tools\\\\"'),            # a backslash at the end must not take the quote
    ("", '""'),
])
def test_word_that_cmd_would_not_read_as_text_is_put_in_quotes(word, written):
    assert ic.cmd_line(ic.launch("vivado.bat", word)).endswith('/c "vivado.bat %s"' % written)
    assert ic.cmd_line(ic.launch(word, "-mode")).endswith('/c "%s -mode"' % written)


@windows
def test_characters_that_only_end_the_name_of_the_command_are_quoted_there_only():
    # an argument keeps them without quotes, as before; as the command, cmd would cut the word at them
    line = ic.cmd_line(ic.launch(r"C:\tools(1),a;b=c\vivado.bat", "-source", r"C:\prog(1),a;b=c\repl.tcl"))
    assert line.endswith(r'/c ""C:\tools(1),a;b=c\vivado.bat" -source C:\prog(1),a;b=c\repl.tcl"')


@windows
@pytest.mark.parametrize("tools, prog", [
    ("tools", "prog"),
    ("my tools", "prog"),                                # a blank in the path of the tool only ...
    ("tools", "my prog"),                                # ... or of the script only
    ("tools (x86) 1", "prog"),
    ("tools", "prog (x86) 1"),
    ("to@ls", "pr@g"),
    ("tools", "prog(1),a;b=c"),
    ("tools", "R&D prog"),                               # "&" in a word that has a blank as well
])
def test_start_that_worked_before_gives_the_tool_the_same_arguments(tool, tmp_path, tools, prog):
    bat, script = tool(tools), str(tmp_path / prog / "repl.tcl")
    before = tool.started(["cmd", "/c", bat, *ARGUMENTS, script])        # the list, quoted by subprocess
    assert before is not None and before[1] == [*ARGUMENTS, script]      # it did work before
    # the same text reaches the wrapper (%*), and so the same arguments the tool
    assert tool.started(ic.cmd_line(ic.launch(bat, *ARGUMENTS, script))) == before


@windows
@pytest.mark.parametrize("tools, prog", [
    ("my tools", "my prog"),                             # a blank in both: cmd looked for a program "C:\...\my"
    ("tools", "R&D"),                                    # "&": the line was cut there, the rest run as a command
    ("R&D", "prog"),
    ("R&D tools", "R&D prog"),
    ("R&D", "my prog"),
])
def test_start_that_failed_before_works(tool, tmp_path, tools, prog):
    bat, script = tool(tools), str(tmp_path / prog / "repl.tcl")
    before = tool.started(["cmd", "/c", bat, *ARGUMENTS, script])
    assert before is None or before[1] != [*ARGUMENTS, script]           # what the issue is about
    raw, arguments = tool.started(ic.cmd_line(ic.launch(bat, *ARGUMENTS, script)))
    assert arguments == [*ARGUMENTS, script]
    assert raw.startswith("-mode tcl -nolog -nojournal -notrace -source ")      # the wrapper reads these as text


@windows
@pytest.mark.parametrize("tools, prog", [("a^b", "prog"), ("tools", "a^b"), ("tools(1)", "prog"), ("a,b", "prog"),
                                         ("a;b", "prog"), ("a=b", "prog"), ("it's", "it's a prog")])
def test_other_characters_in_a_path_reach_the_tool_as_they_are(tool, tmp_path, tools, prog):
    bat, script = tool(tools), str(tmp_path / prog / "repl.tcl")
    assert tool.started(ic.cmd_line(ic.launch(bat, *ARGUMENTS, script)))[1] == [*ARGUMENTS, script]


@windows
def test_no_argument_can_start_a_second_command(tool, tmp_path):
    marker = tmp_path / "second.txt"
    argument = "tcp:a&echo x>%s&rem" % marker.name
    assert tool.started(ic.cmd_line(ic.launch(tool("tools"), "repl.tcl", argument)))[1] == ["repl.tcl", argument]
    assert not marker.exists()


@windows
@pytest.mark.parametrize("tools, prog, name", [
    ("tools", "100%", "a percent sign"),                 # one alone: cmd leaves it, a wrapper with "call" drops it
    ("%TEMP%", "prog", "a percent sign"),                # cmd writes the folder of the variable in its place
    ("tools", "%ComSpec% prog", "a percent sign"),
    ("tools", 'my "own" prog', "a double quote"),
])
def test_percent_sign_or_double_quote_is_refused_with_a_sentence(tmp_path, tools, prog, name):
    bat, script = str(tmp_path / tools / "vivado.bat"), str(tmp_path / prog / "repl.tcl")
    with pytest.raises(RuntimeError) as refused:
        ic.cmd_line(ic.launch(bat, *ARGUMENTS, script))
    wrong = bat if "%" in tools else script
    assert str(refused.value) == ("vivado.bat cannot be started: %s holds %s, which cmd.exe does not pass on as it "
                                  "is written. The program folder, the path of a tool or of a Tcl script, or the "
                                  "address has to do without it" % (wrong, name))


@windows
def test_tool_is_not_started_at_all_with_a_word_that_is_refused(monkeypatch, tmp_path):
    started = []
    monkeypatch.setattr(ic.subprocess, "Popen", lambda *args, **more: started.append(args))
    with pytest.raises(RuntimeError, match="holds a percent sign"):
        ic.Repl(ic.launch(str(tmp_path / "vivado.bat"), "-source", r"C:\100%\repl.tcl"), "vivado", None)
    assert started == []
