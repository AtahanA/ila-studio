# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The probe file (.ltx) as the GUI reads it without hardware: cores, probes and the debug hub clock."""
import pytest

import ila_bridge as ib


def probe(nets, kind="ila", **options):
    """One <probe> element with the options and nets the reader looks at."""
    return '<probe type="%s"><probeOptions Id="DebugProbeParams">%s</probeOptions><nets>%s</nets></probe>' % (
        kind,
        "".join('<Option Id="%s" value="%s"/>' % option for option in options.items()),
        "".join('<net name="%s"/>' % net for net in nets))


def ltx(*probes):
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<probeData version="1" minor="2">'
            '<probeset name="EDA_PROBESET" active="true">%s</probeset></probeData>\n' % "".join(probes))


# A 4-bit bus on one core, a VIO probe, and a single net on a second core whose debug hub runs slower.
TWO_CORES = ltx(
    probe(["top/u1/data[3]", "top/u1/data[2]", "top/u1/data[1]", "top/u1/data[0]"], HW_ILA="u_ila_0",
          HUB_CLK_INPUT_FREQ_HZ=100000000, PROBE_PORT=0, PROBE_PORT_BIT_COUNT=4),
    probe(["top/u1/enable"], kind="vio", HW_VIO="u_vio_0", PROBE_PORT=0, PROBE_PORT_BIT_COUNT=1),
    probe(["top/u2/rx_valid"], HW_ILA="u_ila_1", HUB_CLK_INPUT_FREQ_HZ=12000000, PROBE_PORT=2,
          PROBE_PORT_BIT_COUNT=1))


def test_cores_of_a_probe_file(write):
    cores = ib.parse_ltx_file(write("top.ltx", TWO_CORES))["cores"]
    # the capture depth is a property of the bitstream: the file does not carry it
    assert cores == [{"name": "u_ila_0", "cell": "u_ila_0", "depth": 0},
                     {"name": "u_ila_1", "cell": "u_ila_1", "depth": 0}]


def test_probes_of_a_probe_file(write):
    probes = ib.parse_ltx_file(write("top.ltx", TWO_CORES))["probes"]
    assert probes == [
        {"name": "data", "fullName": "top/u1/data[3:0]", "width": 4, "isBus": True, "core": "u_ila_0", "port": 0},
        # the VIO probe is not listed: it can neither be captured nor triggered on
        {"name": "rx_valid", "fullName": "top/u2/rx_valid", "width": 1, "isBus": False, "core": "u_ila_1", "port": 2},
    ]


def test_slowest_debug_hub_bounds_the_jtag_clock(write):
    parsed = ib.parse_ltx_file(write("top.ltx", TWO_CORES))
    assert parsed["hubClockHz"] == 12000000
    assert parsed["maxSafeTckHz"] == 4800000             # hub clock / 2.5


def test_probe_file_that_names_no_core(write):
    parsed = ib.parse_ltx_file(write("top.ltx", ltx(probe(["top/rx_valid"]))))
    assert parsed["cores"] == [{"name": "hw_ila_1", "cell": "", "depth": 0}]
    assert (parsed["hubClockHz"], parsed["maxSafeTckHz"]) == (0, 0)


def test_missing_probe_file_is_an_answer_not_an_exception(tmp_path):
    parsed = ib.parse_ltx_file(str(tmp_path / "missing.ltx"))
    assert parsed["error"].startswith("LTX file not found") and parsed["cores"] == [] and parsed["probes"] == []


@pytest.mark.parametrize("text", ["<probeData><probe", '{"probes": []}'])
def test_file_that_is_not_xml_is_an_answer_not_an_exception(write, text):
    parsed = ib.parse_ltx_file(write("top.ltx", text))
    assert parsed["error"].startswith("Failed to parse LTX") and parsed["cores"] == [] and parsed["probes"] == []
