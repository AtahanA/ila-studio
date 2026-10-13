# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""What the driver works out of a capture file: where a probe is, its edges, the statistics that go into
index.csv and the timeline that "summary" writes."""
import pytest

import ila_capture as ic

HEAD = "Sample in Buffer,Sample in Window,TRIGGER,"
# one-bit probes only: en goes high and stays, ev pulses twice, the trigger is at sample 1
BITS = HEAD + "top/en,top/ev\n0,0,0,0,0\n1,1,1,1,1\n2,2,0,1,0\n3,3,0,1,1\n"
MAGNITUDE = HEAD + "top/mag[7:0]\n0,0,1,3\n1,1,0,4\n"


# ---------------------------------------------------------------- finding a probe
HDR = ["Sample in Buffer", "TRIGGER", "top/u1/rx_valid", "top/u1/data[7:0]", "top/u2/data_ready"]


@pytest.mark.parametrize("name, column", [
    ("rx_valid", 2),                # the last element of the hierarchical name
    ("data", 3),                    # ... of a bus, without its range - not data_ready, which only starts like it
    ("u2/data_ready", 4),           # a part of the hierarchy
])
def test_probe_index(name, column):
    assert ic.probe_index(HDR, name) == column


def test_probe_that_is_not_in_the_capture():
    with pytest.raises(KeyError, match="frame_start"):
        ic.probe_index(HDR, "frame_start")


def test_probe_name_does_not_match_inside_another_name():
    with pytest.raises(KeyError):
        ic.probe_index(HDR, "valid")                     # there is no probe "valid", only rx_valid


def test_edges():
    rows = [[v] for v in "0110100"]
    assert ic.rising_edges(rows, 0) == [1, 4]
    assert ic.falling_edges(rows, 0) == [3, 5]


@pytest.mark.parametrize("status, normalised", [
    ("WAITING FOR TRIGGER", "WAITING_FOR_TRIGGER"),      # Vivado writes the core status with spaces
    (" full ", "FULL"),
    ("Pre-Trigger", "PRE_TRIGGER"),
    (None, ""),
])
def test_core_status_is_normalised(status, normalised):
    assert ic.norm_status(status) == normalised


# ---------------------------------------------------------------- statistics
def test_without_a_value_probe_only_control_probes_and_events_are_recorded(write):
    st = ic.stats_of(write("cap.csv", BITS), {"mode": "none", "ctrl_probes": ["en"], "event_probes": ["ev"]})
    assert st == {"rows": 4, "ctrl": "en=01", "n_ev": 2}      # en was seen as 0 and as 1; ev rose twice


def test_magnitude_statistics(write):
    st = ic.stats_of(write("cap.csv", MAGNITUDE), {"mode": "magnitude", "value_probe": "mag"})
    assert (st["n"], st["min"], st["max"], st["mean"], st["median"]) == (2, 3, 4, 3.5, 3.5)
    assert st["rms"] == 3.54                             # sqrt((3*3 + 4*4) / 2), rounded to two places
    assert st["radix"] == "dec"


def test_hex_capture_gives_the_same_numbers(write):
    text = HEAD + "top/mag[7:0]\n0,0,1,03\n1,1,0,0a\n"
    st = ic.stats_of(write("cap.csv", text), {"mode": "magnitude", "value_probe": "mag"})
    assert (st["radix"], st["min"], st["max"]) == ("hex", 3, 10)


def test_only_samples_marked_valid_are_counted(write):
    text = HEAD + "top/rx_valid,top/mag[7:0]\n0,0,1,1,3\n1,1,0,0,200\n2,2,0,1,4\n"
    st = ic.stats_of(write("cap.csv", text), {"mode": "magnitude", "value_probe": "mag", "valid_probe": "rx_valid"})
    assert (st["n"], st["max"]) == (2, 4)


def test_samples_above_the_threshold_are_counted(write):
    st = ic.stats_of(write("cap.csv", MAGNITUDE), {"mode": "magnitude", "value_probe": "mag", "threshold": 3})
    assert (st["over_thr"], st["over_thr_pct"]) == (1, 50.0)      # 4 is above 3, 3 itself is not


def test_control_probe_of_another_design_is_skipped(write):
    st = ic.stats_of(write("cap.csv", BITS), {"mode": "none", "ctrl_probes": ["frame_start"]})
    assert st == {"rows": 4, "ctrl": ""}


def test_value_probe_of_another_design_is_an_error(write):
    # the caller (finish_capture) catches it and records the capture without statistics
    with pytest.raises(KeyError):
        ic.stats_of(write("cap.csv", BITS), {"mode": "magnitude", "value_probe": "mag"})


def test_capture_without_samples_has_no_statistics(write):
    assert ic.stats_of(write("cap.csv", HEAD + "top/mag[7:0]\n"), {"mode": "magnitude", "value_probe": "mag"}) \
        == {"rows": 0}


# ---------------------------------------------------------------- timeline
def summary_of(path, sample_period_ns=0):
    prof = ic.load_profile(None)
    prof["stats"]["event_probes"] = ["ev"]
    prof["capture"]["sample_period_ns"] = sample_period_ns
    return ic.capture_summary(path, prof)


def test_events_are_timed_from_the_trigger_sample(write):
    s = summary_of(write("cap.csv", BITS))
    # ev rises at samples 1 and 3 and falls at sample 2; the trigger is at sample 1
    assert (s["n_rows"], s["ev_n"], s["ev_first"], s["ev_last_off"], s["time_unit"]) == (4, 2, 0, 1, "samples")


def test_times_are_in_microseconds_when_the_sample_period_is_known(write):
    s = summary_of(write("cap.csv", BITS), sample_period_ns=500)
    assert (s["ev_first"], s["ev_last_off"], s["time_unit"]) == (0.0, 0.5, "us")
