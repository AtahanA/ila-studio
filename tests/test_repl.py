# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The Repl class against a stand-in for the Tcl process: a few lines of Python that speak the protocol of
scripts/vivado_ila_repl.tcl - "@@READY" once, then "@@RC", "@@RES" and "@@END" after every line they are sent."""
import json
import os
import sys
import time

import pytest

import ila_capture as ic

# Answers every line with the line itself; a line starting with "error" fails, "die" ends the process without
# an answer, and "exit" ends it the way Vivado does. "chatter" is never answered: the process prints a line
# every 50 ms for a quarter of a minute and then ends. "format <text>" is answered with the text, as Tcl does,
# and "argv" with the arguments the stand-in was started with.
STAND_IN = """\
import json, sys, time
print("@@READY", flush=True)
for line in sys.stdin:
    line = line.rstrip("\\n")
    if line == "die":
        break
    if line == "chatter":
        for _ in range(300):
            print("still busy", flush=True)
            time.sleep(0.05)
        break
    print("output of " + line)
    print("@@RC %d" % line.startswith("error"))
    answer = json.dumps(sys.argv[1:]) if line == "argv" else line[7:] if line.startswith("format ") else line
    print("@@RES " + answer)
    print("@@END", flush=True)
    if line == "exit":
        print("Exiting Vivado", flush=True)
        break
"""


@pytest.fixture
def start(tmp_path):
    """start() runs the stand-in the way the driver runs Vivado and returns its Repl; start.log is what the
    Repl logged. Every process started is closed and waited for when the test ends."""
    script = tmp_path / "tcl_stand_in.py"
    script.write_text(STAND_IN)
    started, log = [], []

    def start_one():
        repl = ic.Repl([sys.executable, "-B", str(script)], "vivado", lambda msg, quiet=False: log.append(msg))
        started.append(repl)
        return repl

    start_one.log = log
    yield start_one
    for repl in started:
        repl.close()
        repl.p.wait(timeout=30)


def test_command_is_answered_with_its_result(start):
    assert start().cmd("ila_info") == "ila_info"


def test_other_output_goes_to_the_log(start):
    start().cmd("ila_info")
    assert "[vivado] output of ila_info" in start.log


def test_failing_command_raises_with_the_reason(start):
    repl = start()
    with pytest.raises(RuntimeError, match="vivado: 'error here' failed: error here"):
        repl.cmd("error here")
    assert repl.cmd("error here", check=False) == "error here"    # ... unless the caller looks at it itself


def test_control_characters_do_not_start_a_second_command(start):
    repl = start()
    # one command is one line: a carriage return, like a line feed, would end it and start the next one
    assert repl.cmd("set a 1\rset b 2\nset c\t3\x00\x1b\x7f") == "set a 1 set b 2 set c 3   "
    assert repl.cmd("ila_info") == "ila_info"            # and the answers have not slipped by one


def test_process_that_ends_makes_the_repl_unusable(start):
    repl = start()
    with pytest.raises(RuntimeError, match="vivado exited"):
        repl.cmd("die")
    assert repl.dead
    with pytest.raises(RuntimeError, match="no longer usable"):
        repl.cmd("ila_info")


def test_close_asks_for_an_orderly_exit(start):
    start().close()
    # "exit" is what lets the Tcl side put the cable's JTAG clock back before it goes; a kill alone would not
    assert "[vivado] Exiting Vivado" in start.log


def test_process_that_never_gets_ready_is_reported_with_its_last_words():
    with pytest.raises(RuntimeError, match="vivado exited during start-up: no license"):
        ic.Repl([sys.executable, "-B", "-c", "print('no license')"], "vivado", lambda msg, quiet=False: None)


def test_command_runs_out_of_time_although_the_process_keeps_printing(start):
    repl = start()
    began = time.monotonic()
    # the time of a command counts from when it is sent, not from the last line the process printed
    with pytest.raises(RuntimeError, match="vivado: 'chatter' timed out after 1 s"):
        repl.cmd("chatter", timeout=1)
    assert time.monotonic() - began < 8                  # ... and not when the process ends by itself, after 15 s
    assert repl.dead                                     # an answer that came now would be taken for the next one's
    assert "[vivado] still busy" in start.log


# ---------------------------------------------------------------- a command that was cut short
@pytest.fixture
def cut_short(start):
    """A Repl whose command "core_state" was just ended by Ctrl-C between the lines of its answer: the
    KeyboardInterrupt comes while the line the process printed before its answer is logged."""
    def ctrl_c(msg, quiet=False):
        start.log.append(msg)
        if msg == "[vivado] output of core_state":
            raise KeyboardInterrupt

    repl = start()
    log, repl.log = repl.log, ctrl_c
    with pytest.raises(KeyboardInterrupt):
        repl.cmd("core_state")
    repl.log = log
    return repl


def test_answers_fit_again_once_they_were_lined_up(cut_short, start):
    # left alone, the next command would be handed the answer nobody read, and its own would go to the one after
    cut_short.resync()
    assert cut_short.cmd("del_bp") == "del_bp"
    assert cut_short.cmd("core_state") == "core_state"
    assert "[vivado] @@RES core_state" in start.log      # the answer nobody had read is in the log


def test_lining_up_does_nothing_to_a_repl_that_is_in_step(start):
    repl = start()
    repl.resync()
    repl.resync()
    assert repl.cmd("ila_info") == "ila_info"
    assert [line for line in start.log if "@@RES" in line] == []         # no answer was left over to read off


def test_lining_up_gives_up_on_a_process_that_does_not_answer(start):
    def ctrl_c(msg, quiet=False):
        raise KeyboardInterrupt

    repl = start()
    repl.log = ctrl_c
    with pytest.raises(KeyboardInterrupt):
        repl.cmd("chatter")                              # never answered, and nothing that is sent after it
    repl.log = lambda msg, quiet=False: None
    with pytest.raises(RuntimeError, match="vivado did not answer within 1 s"):
        repl.resync(timeout=1)
    assert repl.dead                                     # as after a command that ran out of time


# ---------------------------------------------------------------- through a .bat wrapper
@pytest.mark.skipif(os.name != "nt", reason="the tools are started through cmd.exe on Windows only")
@pytest.mark.parametrize("tools, prog", [("tools", "prog"), ("my tools", "my prog"), ("R&D", "R&D"),
                                         ("R&D tools (x64)", "R&D prog, 2nd")])
def test_tool_behind_a_bat_wrapper_is_started_spoken_to_and_closed(tmp_path, tools, prog):
    # as the Xilinx tools are started: cmd runs a .bat, which starts the program with the arguments it was given
    (tmp_path / tools).mkdir()
    (tmp_path / tools / "tcl_stand_in.py").write_text(STAND_IN)
    bat = tmp_path / tools / "vivado.bat"
    bat.write_text('@"%s" -B "%%~dp0tcl_stand_in.py" %%*\n' % sys.executable)
    script, log = str(tmp_path / prog / "repl.tcl"), []
    repl = ic.Repl(ic.launch(str(bat), "-mode", "tcl", "-source", script), "vivado",
                   lambda msg, quiet=False: log.append(msg))
    try:
        assert json.loads(repl.cmd("argv")) == ["-mode", "tcl", "-source", script]
    finally:
        repl.close()
        repl.p.wait(timeout=30)
    assert "[vivado] Exiting Vivado" in log              # it was reached through the pipe to the very end


def test_process_that_keeps_printing_and_never_gets_ready_is_given_up(monkeypatch):
    wait_ready = ic.Repl._wait_ready
    monkeypatch.setattr(ic.Repl, "_wait_ready", lambda self: wait_ready(self, timeout=1))     # 180 s as shipped
    loading = "import time\nfor _ in range(300):\n    print('loading', flush=True)\n    time.sleep(0.05)"
    began = time.monotonic()
    with pytest.raises(RuntimeError, match="vivado did not print @@READY within 1 s"):
        ic.Repl([sys.executable, "-B", "-c", loading], "vivado", lambda msg, quiet=False: None)
    assert time.monotonic() - began < 8
