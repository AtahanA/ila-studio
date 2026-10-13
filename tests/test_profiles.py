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


def test_what_the_file_itself_says_can_be_told_from_the_defaults(write):
    prof = ic.load_profile(write("p.json", json.dumps({"capture": {"position": 300}})))
    assert prof["capture"]["format"] == "both"               # the default ...
    assert ic.stated(prof, "capture", "format") is None      # ... which this file never asked for
    assert ic.stated(prof, "capture", "position") == 300
    assert ic.stated(prof, "stats", "mode") is None          # a section the file does not have states no keys
    assert ic.stated(ic.load_profile(None), "capture", "position") is None


def test_loaded_profile_shares_nothing_with_the_defaults():
    # not the lists and objects inside a section either: a change to one profile must not reach the next job
    prof = ic.load_profile(None)
    prof["hook"]["call_mnemonics"].append("blx")
    prof["stats"]["ctrl_probes"].append("rx_valid")
    prof["capture"]["probe_format"]["adc_data"] = "signed"
    again = ic.load_profile(None)
    assert "blx" not in again["hook"]["call_mnemonics"]
    assert (again["stats"]["ctrl_probes"], again["capture"]["probe_format"]) == ([], {})


# ---------------------------------------------------------------- a file that is JSON, but no profile
# Each ends in one sentence that names the file and what is wrong with it - not in an AttributeError
@pytest.mark.parametrize("document", ["[1, 2]", '"my-board"', "5", "null"])
def test_file_that_holds_no_json_object_is_no_profile(write, document):
    path = write("p.json", document)
    with pytest.raises(ValueError) as refused:
        ic.load_profile(path)
    assert str(refused.value) == path + ": this is no profile: the file must hold one JSON object, { ... }"


@pytest.mark.parametrize("section, given", [("capture", None), ("hardware", "x"), ("tools", [1, 2]), ("hook", 5),
                                            ("stats", True)])
def test_section_that_is_no_json_object_is_refused(write, section, given):
    path = write("p.json", json.dumps({"name": "my-board", section: given}))
    with pytest.raises(ValueError) as refused:
        ic.load_profile(path)
    assert str(refused.value) == '%s: "%s" must be a JSON object, { ... }' % (path, section)


def test_key_that_is_no_section_may_hold_anything(write):
    # only the keys whose default is a section are sections: the rest is the file's own business
    prof = ic.load_profile(write("p.json", json.dumps({"_comment": None, "gui": {"mode": "just_capture"},
                                                       "notes": ["a", "list"]})))
    assert (prof["_comment"], prof["gui"], prof["notes"]) == (None, {"mode": "just_capture"}, ["a", "list"])


def test_hook_magic_that_is_no_number_is_said_with_the_file(write):
    path = write("p.json", json.dumps({"hook": {"magic": "5EED"}}))      # hex without the 0x
    with pytest.raises(ValueError) as refused:
        ic.load_profile(path)
    assert str(refused.value).startswith(path + ": hook.magic is '5EED': it must be a number")


def test_file_that_is_not_utf8_is_said_with_the_file(tmp_path):
    (tmp_path / "p.json").write_bytes(b'{"name": "my-board \xff"}')
    with pytest.raises(ValueError) as refused:
        ic.load_profile(str(tmp_path / "p.json"))
    assert str(refused.value).startswith("%s: the file is not UTF-8 text (" % (tmp_path / "p.json"))
    assert not isinstance(refused.value, UnicodeDecodeError)             # whose own text does not name the file


# ---------------------------------------------------------------- the command line over the profile
def overrides(**given):
    """What the command line hands to apply_overrides when only these hardware options were given."""
    args = dict(ltx=None, server=None, device=None, ila_index=None, jtag_hz=None)
    args.update(given)
    return types.SimpleNamespace(**args)


@pytest.mark.parametrize("server, url", [("192.0.2.10", "192.0.2.10:3121"), ("labpc:3122", "labpc:3122"),
                                         ("TCP:192.0.2.10", "192.0.2.10:3121"), ("[::1]", "[::1]:3121")])
def test_server_gets_the_default_port(server, url):
    # the option is taken as it was typed; the session it is used for brings the address into its one form
    prof = ic.apply_overrides(ic.load_profile(None), overrides(server=server))
    assert prof["hardware"]["url"] == server
    assert ic.Session(None, prof, ephemeral=True).prof["hardware"]["url"] == url


@pytest.mark.parametrize("server, said", [("", "no hw_server address given"), ("   ", "no hw_server address given"),
                                          ("a&echo.SECOND&rem", "'a&echo.SECOND&rem' is not a hw_server address")])
def test_server_that_is_no_address_gets_no_session(server, said):
    # a blank one does not fall back to the address of the profile without a word
    prof = ic.apply_overrides(ic.load_profile(None), overrides(server=server))
    with pytest.raises(RuntimeError, match=said):
        ic.Session(None, prof, ephemeral=True)


def test_address_of_a_profile_is_checked_like_one_that_was_typed(write):
    prof = ic.load_profile(write("p.json", json.dumps({"hardware": {"url": "http://192.0.2.10"}})))
    with pytest.raises(RuntimeError, match="'http://192.0.2.10' is not a hw_server address"):
        ic.Session(None, ic.apply_overrides(prof, overrides()), ephemeral=True)


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


@pytest.mark.parametrize("text", ["[1, 2]", '{"hardware": "x"}', '{"capture": null}', '{"name": "n", "stats": []}'])
def test_file_that_is_json_but_no_profile_is_listed_with_what_is_wrong(profiles, text):
    (profiles / "odd.json").write_text(text)
    (entry,) = ib.list_profiles()
    assert (entry["name"], entry["data"], entry["ltxExists"]) == ("odd", {}, False)
    # the sentence a job with this file is refused with, less the name of the file - which the entry has
    with pytest.raises(ValueError) as refused:
        ic.load_profile(entry["path"])
    assert str(refused.value) == entry["path"] + ": " + entry["error"]


def test_sections_the_list_knows_are_those_of_the_driver():
    # the list is made without the driver, so it names them itself
    assert set(ib.PROFILE_SECTIONS) == {key for key, value in ic.DEFAULT_PROFILE.items() if isinstance(value, dict)}


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
    mode, position, timeout, format, probe formats."""
    prof = ic.load_profile(path)
    ic.normalise_url(prof["hardware"]["url"])
    ic.tcl_trigger(prof["capture"]["trigger"])
    ic.capture_words(prof["capture"])
    ic.capture_values(prof["capture"])
    ic.probe_format_map(prof["capture"]["probe_format"])
    assert isinstance(prof["hook"]["magic"], int)
