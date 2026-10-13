# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""A capture file as the GUI gets it for display: one list of numbers per signal, thinned when the capture is
long, with the trigger sample - and the demo capture, which goes the same way."""
import os

import pytest

import ila_bridge as ib

HEAD = "Sample in Buffer,Sample in Window,TRIGGER,"
THREE = HEAD + "top/en,top/x[7:0]\n0,0,0,1,5\n1,1,1,0,200\n2,2,0,1,7\n"


def bus(write, column, values, max_samples=4096):
    """The signal parsed from a capture that has just this one column, with the trigger at sample 0."""
    rows = "".join("%d,%d,%d,%s\n" % (i, i, i == 0, v) for i, v in enumerate(values))
    return ib.parse_csv_capture(write("cap.csv", HEAD + column + "\n" + rows), max_samples)["signals"][0]


def test_capture_as_the_gui_gets_it(write):
    path = write("cap.csv", THREE)
    parsed = ib.parse_csv_capture(path)
    assert (parsed["filePath"], parsed["totalSamples"], parsed["displayedSamples"], parsed["step"]) == (path, 3, 3, 1)
    assert parsed["sampleIndices"] == [0, 1, 2]
    assert parsed["triggerSample"] == 1                  # where the TRIGGER column is 1
    # the two sample counters and TRIGGER are not signals
    assert parsed["signals"] == [
        {"name": "en", "fullName": "top/en", "width": 1, "isBus": False, "values": [1, 0, 1], "signed": False},
        {"name": "x", "fullName": "top/x[7:0]", "width": 8, "isBus": True, "values": [5, 200, 7], "signed": False},
    ]


@pytest.mark.parametrize("name", ["cap.csv.gz", "cap.ila"])
def test_compressed_capture_and_archive_are_read_as_well(write, name):
    assert ib.parse_csv_capture(write(name, THREE))["totalSamples"] == 3


def test_capture_without_a_trigger_column(write):
    parsed = ib.parse_csv_capture(write("cap.csv", "Sample in Buffer,top/en\n0,1\n1,0\n"))
    assert parsed["triggerSample"] is None


def test_hex_bus_is_read_as_numbers(write):
    assert bus(write, "top/x[7:0]", ["0a", "ff"])["values"] == [10, 255]


def test_signed_bus_is_handed_on_as_its_bits(write):
    x = bus(write, "top/x[3:0]", ["-1", "3"])
    assert x["values"] == [15, 3]                        # -1 in 4 bits; "signed" says how the file wrote it
    assert x["signed"] is True


def test_bus_too_wide_for_a_javascript_number_becomes_floats(write):
    x = bus(write, "top/x[63:0]", ["18446744073709551615", "5"])
    assert x["values"] == [float(2 ** 64 - 1), 5.0]
    assert all(isinstance(v, float) for v in x["values"])


def test_wide_signed_bus_keeps_its_sign(write):
    # -30 is exact as a float; its bits, 2^64 - 30, would not be
    x = bus(write, "top/x[63:0]", ["-30", "5"])
    assert (x["values"], x["signed"]) == ([-30.0, 5.0], True)


def test_long_capture_is_thinned_for_display(write):
    rows = "".join("%d,%d,%d,%d\n" % (i, i, i == 4, 10 * i) for i in range(5))
    parsed = ib.parse_csv_capture(write("cap.csv", HEAD + "top/x[7:0]\n" + rows), max_samples=2)
    assert (parsed["totalSamples"], parsed["step"], parsed["sampleIndices"]) == (5, 3, [0, 3])
    assert parsed["signals"][0]["values"] == [0, 30]
    assert parsed["triggerSample"] == 4                  # found although that sample is not displayed


def test_thinning_does_not_hide_that_a_bus_is_signed(write):
    # the only negative value is in a sample that is not displayed
    assert bus(write, "top/x[7:0]", ["1", "-2", "3", "4", "5"], max_samples=2) == {
        "name": "x", "fullName": "top/x[7:0]", "width": 8, "isBus": True, "values": [1, 4], "signed": True}


def test_file_without_samples_is_an_answer_not_an_exception(write):
    assert "holds no samples" in ib.parse_csv_capture(write("cap.csv", HEAD + "top/x[7:0]\n"))["error"]


def test_missing_file_is_an_answer_not_an_exception(tmp_path):
    assert ib.parse_csv_capture(str(tmp_path / "missing.csv"))["error"].startswith("File not found")


def test_empty_file_is_an_answer_not_an_exception(write):
    assert ib.parse_csv_capture(write("cap.csv", ""))["error"].startswith("Not a readable ILA capture")


def test_demo_capture_can_be_displayed(tmp_path):
    path = ib.create_demo_capture(out_dir=str(tmp_path / "demo"), samples=2048)
    parsed = ib.parse_csv_capture(path)
    assert os.path.dirname(path) == str(tmp_path / "demo")
    assert (parsed["totalSamples"], parsed["triggerSample"]) == (2048, 500)
    assert [(s["name"], s["width"]) for s in parsed["signals"]] == [
        ("clk_en", 1), ("reset_n", 1), ("trigger_event", 1), ("fsm_state", 4), ("tx_data_bus", 16),
        ("adc_data", 16), ("rx_valid", 1), ("error_flag", 1)]
