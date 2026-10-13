# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The bridge in "serve" mode, as the GUI runs it: one process that takes a job per line of JSON on stdin and
answers each with a "@@RESULT" line. It is started from a copy of the scripts, so its log stays in the copy.
The jobs here are answered without Vivado: none of them gets as far as starting it."""
import json
import subprocess
import sys
import threading

import pytest


def start(app):
    return subprocess.Popen([sys.executable, "-B", str(app / "ila_bridge.py"), "serve"], cwd=str(app),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            universal_newlines=True, encoding="utf-8", errors="replace")


@pytest.fixture(scope="module")
def ask(app):
    """ask(line) sends one line to a bridge that serves all tests of this file and returns the answer to it."""
    bridge = start(app)
    # a bridge that does not answer must fail the tests, not hold them up for ever: its output then ends
    watchdog = threading.Timer(60, bridge.kill)
    watchdog.start()

    def ask_one(line):
        bridge.stdin.write(line + "\n")
        bridge.stdin.flush()
        while True:
            said = bridge.stdout.readline()
            assert said, "the bridge ended without an answer"
            if said.startswith("@@RESULT "):
                return json.loads(said[len("@@RESULT "):])

    yield ask_one
    bridge.stdin.close()
    bridge.wait(timeout=30)
    watchdog.cancel()
    bridge.stdout.close()


def job(*argv):
    """A job the way the GUI writes it."""
    return json.dumps({"argv": list(argv), "stop_file": ""})


@pytest.mark.parametrize("line, success, said", [
    (job("disconnect"), True, "No hardware session was open."),
    ("this is not JSON", False, "The bridge was sent a request it cannot read."),
    ('["disconnect"]', False, "The bridge was sent a request it cannot read."),      # JSON, but not a job
    (job("bogus"), False, "Not a hardware command: bogus"),
    (job("capture"), False, "The bridge does not understand: capture"),              # a capture needs --name
    (job("query-hardware"), False, "no probe file (.ltx) given"),
    (job("query-hardware", "--server", "a[exec calc.exe]::", "--ltx", "top.ltx"), False,
     "'a[exec calc.exe]::' is not a hw_server address"),
    (job("run-tcl", "--tcl", "nowhere.tcl"), False, "Tcl script not found: nowhere.tcl"),
], ids=["disconnect", "not-json", "not-a-job", "unknown-command", "incomplete-command", "no-probe-file",
        "no-address", "no-script"])
def test_job_is_answered(ask, line, success, said):
    answer = ask(line)
    assert answer["success"] is success
    assert said in answer["message"]


def test_bridge_ends_in_order_when_its_input_ends(app):
    bridge = start(app)
    bridge.communicate("", timeout=60)                   # the GUI has gone: nothing more will come
    assert bridge.returncode == 0
    assert "---- serve: ended" in (app / "ila_log.txt").read_text(encoding="utf-8")
