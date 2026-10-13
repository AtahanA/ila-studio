# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The small parsers of the bridge: the hw_server address a person types, and what the Tcl side answers."""
import types

import pytest

import ila_bridge as ib


# ---------------------------------------------------------------- the hw_server address
@pytest.mark.parametrize("typed, address", [
    ("localhost", "localhost:3121"),                     # the default port is added
    ("192.0.2.10:3121", "192.0.2.10:3121"),
    ("TCP:10.0.0.5", "10.0.0.5:3121"),                   # the way Vivado prints a server
    ("  tcp: lab-pc_2.example.org:3122 ", "lab-pc_2.example.org:3122"),
    ("[::1]", "[::1]:3121"),
    ("[fe80::1%eth0]:3122", "[fe80::1%eth0]:3122"),
    ("::1", "::1"),                                      # without brackets an IPv6 address cannot carry a port
    ("2001:db8::10", "2001:db8::10"),
])
def test_address_as_host_and_port(typed, address):
    assert ib.normalise_url(typed) == address


@pytest.mark.parametrize("typed", ["", "   ", "tcp:"])
def test_no_address_at_all(typed):
    with pytest.raises(RuntimeError, match="no hw_server address given"):
        ib.normalise_url(typed)


@pytest.mark.parametrize("typed", [
    "a[exec calc.exe]::",                                # Tcl would run what is between the brackets
    "host;exec calc",
    "localhost:3121 ; exit",
    "$env(PATH)",
    "{host}",
    '"host"',
    "host name",
    "host\\name",
    "host:port",
    "host:123456",
    "[myhost]:3121",                                     # brackets are for IPv6 addresses only
])
def test_text_that_is_no_address_is_refused(typed):
    with pytest.raises(RuntimeError, match="is not a hw_server address"):
        ib.normalise_url(typed)


def test_reachability_is_asked_of_the_right_host_and_port(monkeypatch):
    asked = []

    def connect(address, timeout):
        asked.append(address)
        return types.SimpleNamespace(close=lambda: None)

    monkeypatch.setattr(ib.socket, "create_connection", connect)
    for address in ("labpc:3122", "[::1]:3121", "fe80::1"):
        ib.check_reachable(address)
    assert asked == [("labpc", 3122), ("::1", 3121)]     # an IPv6 address without brackets is left to Vivado


def test_server_that_cannot_be_reached_is_said_in_a_sentence(monkeypatch):
    def refuse(address, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(ib.socket, "create_connection", refuse)
    with pytest.raises(RuntimeError, match="hw_server at labpc:3121 is not reachable from this PC"):
        ib.check_reachable("labpc:3121")


# ---------------------------------------------------------------- answers of the Tcl side
def test_core_properties_as_a_dictionary():
    assert ib.info_dict("CELL_NAME=u_ila_0;CONTROL.DATA_DEPTH=1024;JTAG_NOTE=a=b;junk") == {
        "CELL_NAME": "u_ila_0", "CONTROL.DATA_DEPTH": "1024", "JTAG_NOTE": "a=b"}
    assert ib.info_dict(None) == {}


def test_cores_of_a_listing():
    # ila_list answers "<position>=<cell name>(depth <samples>)" per core
    assert ib.cores_from("0=u_ila_0(depth 1024);1=top/u_ila_1(depth 32768)") == [
        {"name": "u_ila_0", "cell": "u_ila_0", "depth": 1024},
        {"name": "top/u_ila_1", "cell": "top/u_ila_1", "depth": 32768}]
    assert ib.cores_from("") == []


def test_probes_of_a_listing():
    # ila_probes answers "<name>[<width>]" per probe: the width is the last bracket, a name may hold others
    assert ib.probes_from("top/bus[3][8];top/rx_valid[1]", "u_ila_0") == [
        {"name": "bus[3]", "fullName": "top/bus[3]", "width": 8, "isBus": True, "core": "u_ila_0", "port": 0},
        {"name": "rx_valid", "fullName": "top/rx_valid", "width": 1, "isBus": False, "core": "u_ila_0", "port": 1}]


@pytest.mark.parametrize("error, said", [
    # the driver's error echoes the whole command; a person needs the reason Vivado gave
    ("vivado: 'ila_capture {C:/c/cap_run_001} {now} 0 1 csv UNSIGNED ALWAYS' failed: ERROR: [Labtools 27-3312] "
     "the data is corrupted | ", "[Labtools 27-3312] the data is corrupted"),
    ("probe file not found: top.ltx", "probe file not found: top.ltx"),
    ("", "RuntimeError"),
])
def test_error_is_cut_down_to_what_a_person_can_act_on(error, said):
    assert ib.concise_error(RuntimeError(error)) == said


@pytest.mark.parametrize("asked, used", [(1, 1), (2, 2), (9, 3), (0, 1), (-4, 1), (None, 1), ("two", 1)])
def test_a_session_has_one_to_three_vivado_engines(asked, used):
    session = types.SimpleNamespace(args=types.SimpleNamespace(engines=asked))
    assert ib.wanted_engines(session) == used
