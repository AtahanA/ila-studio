# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Profiles: how a profile file is merged over the defaults, what the command line changes in it, and what the
bridge tells the GUI about the files in the profiles folder."""
import glob
import json
import os
import types

import pytest

import ila_bridge as ib
import ila_capture as ic


# ---------------------------------------------------------------- loading
def test_profile_only_states_what_differs(write):
    prof = ic.load_profile(write("p.json", json.dumps({"name": "my-board", "hardware": {"ltx": "top.ltx"}})))
    assert prof["name"] == "my-board"
    assert prof["hardware"]["ltx"] == "top.ltx"
    assert prof["hardware"]["url"] == "127.0.0.1:3121"       # not stated: the default of that section
    assert prof["capture"]["position"] == 1000               # nor is the whole capture section


def test_no_profile_is_the_defaults():
    assert ic.load_profile(None)["capture"]["trigger"] == "now"


def test_loading_a_profile_leaves_the_defaults_alone(write):
    ic.load_profile(write("p.json", json.dumps({"hardware": {"url": "192.0.2.10:3121"}})))
    assert ic.DEFAULT_PROFILE["hardware"]["url"] == "127.0.0.1:3121"


def test_hook_magic_may_be_written_in_hex(write):
    # JSON has no hex numbers, so a profile gives the magic word as text
    prof = ic.load_profile(write("p.json", json.dumps({"hook": {"magic": "0x1234"}})))
    assert prof["hook"]["magic"] == 4660


# ---------------------------------------------------------------- the command line over the profile
def overrides(**given):
    """What the command line hands to apply_overrides when only these hardware options were given."""
    args = dict(ltx=None, server=None, device=None, ila_index=None, jtag_hz=None)
    args.update(given)
    return types.SimpleNamespace(**args)


@pytest.mark.parametrize("server, url", [("192.0.2.10", "192.0.2.10:3121"), ("labpc:3122", "labpc:3122")])
def test_server_gets_the_default_port(server, url):
    assert ic.apply_overrides(ic.load_profile(None), overrides(server=server))["hardware"]["url"] == url


def test_hardware_options_win_over_the_profile():
    given = overrides(ltx="top.ltx", device="xc7z020*", ila_index=0, jtag_hz=0, ila_cell="u_ila_1")
    hw = ic.apply_overrides(ic.load_profile(None), given)["hardware"]
    assert hw["ltx"] == os.path.abspath("top.ltx")
    assert (hw["device_filter"], hw["ila_cell"]) == ("xc7z020*", "u_ila_1")
    assert (hw["ila_index"], hw["jtag_frequency_hz"]) == (0, 0)      # a 0 that was given is a value too


def test_options_that_were_not_given_change_nothing():
    assert ic.apply_overrides(ic.load_profile(None), overrides()) == ic.load_profile(None)


# ---------------------------------------------------------------- the list for the GUI
@pytest.fixture
def profiles(monkeypatch, tmp_path):
    """The folder list_profiles reads: empty, and inside tmp_path."""
    folder = tmp_path / "profiles"
    folder.mkdir()
    monkeypatch.setattr(ib, "PROFILES_DIR", str(folder))
    return folder


def test_profile_as_the_gui_gets_it(profiles, write):
    ltx = write("top.ltx", "<probeData/>")
    data = {"name": " my-board ", "_comment": "adc capture", "hardware": {"ltx": ltx}}
    (profiles / "board.json").write_text(json.dumps(data))
    (entry,) = ib.list_profiles()
    assert (entry["filename"], entry["name"], entry["comment"]) == ("board.json", "my-board", "adc capture")
    assert entry["path"] == str(profiles / "board.json")
    assert entry["data"] == data
    assert entry["ltxExists"] is True
    assert "error" not in entry


def test_probe_file_that_is_gone_is_said(profiles, tmp_path):
    (profiles / "board.json").write_text(json.dumps({"hardware": {"ltx": str(tmp_path / "gone.ltx")}}))
    assert ib.list_profiles()[0]["ltxExists"] is False


def test_file_that_is_not_json_is_listed_with_its_error(profiles):
    (profiles / "broken.json").write_text("{ not json")
    (entry,) = ib.list_profiles()
    assert entry["name"] == "broken" and entry["data"] == {} and entry["error"]


def test_name_that_is_no_text_falls_back_to_the_file_name(profiles):
    (profiles / "board.json").write_text(json.dumps({"name": 42, "_comment": ["a", "list"]}))
    (entry,) = ib.list_profiles()
    assert (entry["name"], entry["comment"]) == ("board", "")


def test_only_json_files_are_profiles_and_they_come_by_name(profiles):
    for name in ("b.json", "a.json", "a.json.bak", "notes.txt"):
        (profiles / name).write_text("{}")
    assert [entry["filename"] for entry in ib.list_profiles()] == ["a.json", "b.json"]


def test_no_profiles_folder_is_an_empty_list(monkeypatch, tmp_path):
    monkeypatch.setattr(ib, "PROFILES_DIR", str(tmp_path / "missing"))
    assert ib.list_profiles() == []


# ---------------------------------------------------------------- the examples in the repository
# profiles/example-*.json are what a new user starts from, and what "ila_capture.py --help" points at
EXAMPLES = sorted(glob.glob(os.path.join(ic.HERE, "profiles", "example-*.json")))


def test_example_profiles_are_shipped():
    assert EXAMPLES


@pytest.mark.parametrize("path", EXAMPLES, ids=os.path.basename)
def test_shipped_example_profile_can_be_used(path):
    """It loads, and holds nothing that a capture refuses before it starts: address, trigger, radix, capture
    mode, probe formats."""
    prof = ic.load_profile(path)
    ib.normalise_url(prof["hardware"]["url"])
    ic.tcl_trigger(prof["capture"]["trigger"])
    ic.capture_words(prof["capture"])
    ic.probe_format_map(prof["capture"]["probe_format"])
    assert isinstance(prof["hook"]["magic"], int)
