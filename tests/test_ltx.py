# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""The probe file (.ltx) as the GUI reads it without hardware: cores, probes and the debug hub clock - in
the XML form and in the JSON form."""
import codecs
import json

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


# ---------------------------------------------------------------- the JSON form
# The same design as TWO_CORES in the form newer Vivado versions write, laid out as the probe files of AMD's
# public chipscopy examples are: the debug hub is a core of its own and carries the clock as text, a core has a
# pin for each probe port, and a net that is a bus lists its bits. Every name is made up.
TWO_CORES_JSON = """\
{
  "ltx_root": {
    "version": 4,
    "minor": 0,
    "ltx_data": [
      {
        "name": "EDA_PROBESET",
        "active": true,
        "debug_cores": [
          {"type": "XSDB_V3", "name": "dbg_hub", "spec": "labtools_xsdbm_v3", "clk_input_freq_hz": "100000000"},
          {"type": "XSDB_V3", "name": "dbg_hub_2", "spec": "labtools_xsdbm_v3", "clk_input_freq_hz": "12000000"},
          {
            "type": "ILA_V3", "name": "u_ila_0", "spec": "labtools_ila_v6", "ipName": "ila",
            "core_location": {"user_chain": 1, "slave_index": 0, "bscan_switch_index": 0},
            "uuid": "00000000000000000000000000000001",
            "pins": [
              {
                "name": "probe0", "id": 0, "type": "DATA_TRIGGER", "direction": "IN", "isVector": true,
                "leftIndex": 0, "rightIndex": 3, "portIndex": 0,
                "nets": [
                  {"name": "top/u1/data", "isBus": true, "subnets": [
                    {"name": "top/u1/data[3]"}, {"name": "top/u1/data[2]"},
                    {"name": "top/u1/data[1]"}, {"name": "top/u1/data[0]"}]}
                ]
              }
            ]
          },
          {
            "type": "VIO_V2", "name": "u_vio_0", "spec": "labtools_vio_v3", "ipName": "vio",
            "uuid": "00000000000000000000000000000002",
            "pins": [
              {
                "name": "probe_out0", "id": 0, "type": "DATA", "direction": "OUT", "isVector": false,
                "leftIndex": 0, "rightIndex": 0, "portIndex": 0,
                "nets": [{"name": "top/u1/enable", "isBus": false}]
              }
            ]
          },
          {
            "type": "ILA_V3", "name": "u_ila_1", "spec": "labtools_ila_v6", "ipName": "ila",
            "uuid": "00000000000000000000000000000003",
            "pins": [
              {
                "name": "probe2", "id": 2, "type": "DATA_TRIGGER", "direction": "IN", "isVector": false,
                "leftIndex": 0, "rightIndex": 0, "portIndex": 2,
                "nets": [{"name": "top/u2/rx_valid", "isBus": false}]
              }
            ]
          }
        ]
      }
    ]
  }
}
"""


def json_ltx(*cores, **root):
    """A probe file in the JSON form with these debug cores; root: further keys of "ltx_root"."""
    return json.dumps({"ltx_root": dict({"version": 4, "ltx_data": [{"debug_cores": list(cores)}]}, **root)})


def ila(name, *pins, **more):
    return dict({"type": "ILA_V3", "name": name, "pins": list(pins)}, **more)


def pin(port, *nets, **more):
    """One probe port: every net is a name, or (name, [the names of its bits])."""
    return dict({"portIndex": port, "nets": [
        {"name": net} if isinstance(net, str) else {"name": net[0], "subnets": [{"name": bit} for bit in net[1]]}
        for net in nets]}, **more)


RX_VALID = {"name": "rx_valid", "fullName": "top/rx_valid", "width": 1, "isBus": False, "core": "u_ila_0", "port": 0}


def test_json_form_is_read_as_the_xml_form_is(write):
    parsed = ib.parse_ltx_file(write("top.ltx", TWO_CORES_JSON))
    assert parsed == ib.parse_ltx_file(write("top_xml.ltx", TWO_CORES))
    assert parsed == {
        "cores": [{"name": "u_ila_0", "cell": "u_ila_0", "depth": 0},
                  {"name": "u_ila_1", "cell": "u_ila_1", "depth": 0}],
        "probes": [
            {"name": "data", "fullName": "top/u1/data[3:0]", "width": 4, "isBus": True, "core": "u_ila_0", "port": 0},
            {"name": "rx_valid", "fullName": "top/u2/rx_valid", "width": 1, "isBus": False, "core": "u_ila_1",
             "port": 2}],
        "hubClockHz": 12000000,                          # the slower of the two hubs
        "maxSafeTckHz": 4800000}


def test_json_form_may_start_with_a_byte_order_mark_and_blank_lines(write):
    text = codecs.BOM_UTF8.decode("utf-8") + "\r\n  " + json_ltx(ila("u_ila_0", pin(0, "top/rx_valid")))
    assert ib.parse_ltx_file(write("top.ltx", text))["probes"] == [RX_VALID]


@pytest.mark.parametrize("hub, hz", [
    ({"clk_input_freq_hz": "25000000"}, 25000000),       # as text, the way the file has it
    ({"clk_input_freq_hz": 25000000}, 25000000),         # ... and as a number
    ({}, 0),                                             # not named: unknown
    ({"clk_input_freq_hz": "fast"}, 0),
    ({"clk_input_freq_hz": "0"}, 0),
    ({"clk_input_freq_hz": -25000000}, 0),
    ({"clk_input_freq_hz": 2.5e7}, 0),                   # only a whole number is a frequency in Hz
    ({"clk_input_freq_hz": None}, 0),
    ({"clk_input_freq_hz": ["25000000"]}, 0),
    ({"clk_input_freq_hz": "9" * 5000}, 0),
])
def test_hub_clock_that_the_json_form_does_not_name_is_unknown(write, hub, hz):
    hub = dict({"type": "XSDB_V3", "name": "dbg_hub"}, **hub)
    parsed = ib.parse_ltx_file(write("top.ltx", json_ltx(hub, ila("u_ila_0", pin(0, "top/rx_valid")))))
    assert (parsed["hubClockHz"], parsed["maxSafeTckHz"]) == (hz, int(hz / 2.5))
    assert parsed["probes"] == [RX_VALID]                # the probes are read either way


def test_keys_the_reader_does_not_know_are_passed_over(write):
    text = json_ltx(
        {"type": "XSDB_V4", "name": "dbg_hub", "clk_input_freq_hz": "50000000", "bscan": {"chain": 1}},
        ila("u_ila_0", pin(0, "top/rx_valid", name="probe0", strobe="RISING"), window={"depth": 1024}),
        format="next", checksum=[1, 2, 3])
    assert ib.parse_ltx_file(write("top.ltx", text)) == {
        "cores": [{"name": "u_ila_0", "cell": "u_ila_0", "depth": 0}], "probes": [RX_VALID],
        "hubClockHz": 50000000, "maxSafeTckHz": 20000000}


def test_what_the_json_form_leaves_out_or_writes_otherwise_is_left_out_not_an_error(write):
    # in every place something that is not what the reader looks for: none of it ends in an exception
    doc = {"ltx_root": {"ltx_data": [7, None, "x", {"debug_cores": "none"}, {}, {"debug_cores": [
        3, None, {"type": 5, "name": None, "pins": "probe0"}, {"type": "ILA_V3", "name": "u_ila_0", "pins": [
            None, 8, {"portIndex": "0", "leftIndex": "7", "nets": None},
            {"nets": [5, {"name": 9}, {"subnets": [{}, 2]}]},
            {"portIndex": None, "leftIndex": None, "rightIndex": True,
             "nets": [{"name": "top/rx_valid", "subnets": 4}]},
        ]}]}]}}
    assert ib.parse_ltx_file(write("top.ltx", json.dumps(doc))) == {
        "cores": [{"name": "u_ila_0", "cell": "u_ila_0", "depth": 0}], "probes": [RX_VALID],
        "hubClockHz": 0, "maxSafeTckHz": 0}


def test_cores_that_stand_in_the_root_itself_are_read_as_well(write):
    doc = {"ltx_root": {"debug_cores": [{"type": "XSDB_V3", "clk_input_freq_hz": "40000000"},
                                        ila("u_ila_0", pin(0, "top/rx_valid"))]}}
    parsed = ib.parse_ltx_file(write("top.ltx", json.dumps(doc)))
    assert (parsed["probes"], parsed["hubClockHz"]) == ([RX_VALID], 40000000)


@pytest.mark.parametrize("core, listed", [
    ({"type": "ILA_V3"}, True),
    ({"type": "AXIS_ILA_V1", "spec": "axis_ila_v1_3"}, True),        # the ILA of the devices with an AXI debug hub
    ({"spec": "labtools_ila_v6"}, True),                 # no type: the specification says what it is
    ({}, True),                                          # says nothing at all, and has probes: as in the XML form
    ({"type": "VIO_V2"}, False),
    ({"type": "AXIS_VIO_V1", "ipName": "axis_vio"}, False),
    ({"type": "AXI_DEBUG_HUB_V1", "spec": "axi_dbg_hub_v2_0"}, False),
    ({"type": "PROBE_UTILAS_V1"}, False),                # "ila" inside another word is no ILA
])
def test_only_ila_cores_are_listed(write, core, listed):
    core = dict({"name": "u_ila_0", "pins": [pin(0, "top/rx_valid")]}, **core)
    parsed = ib.parse_ltx_file(write("top.ltx", json_ltx(core)))
    assert parsed["probes"] == ([RX_VALID] if listed else [])
    assert parsed["cores"] == ([{"name": "u_ila_0", "cell": "u_ila_0", "depth": 0}] if listed else [])


def test_bus_of_the_json_form(write):
    bits = ["top/u1/data[%d]" % bit for bit in (7, 6, 5, 4, 3, 2, 1, 0)]
    for port in (pin(1, ("top/u1/data", bits), leftIndex=0, rightIndex=7),
                 pin(1, ("top/u1/data", bits)),          # no width stated: one net for each bit
                 pin(1, "top/u1/data", leftIndex=7, rightIndex=0)):      # no bits listed: the width of the pin
        assert ib.parse_ltx_file(write("top.ltx", json_ltx(ila("u_ila_0", port))))["probes"] == [
            {"name": "data", "fullName": "top/u1/data[7:0]", "width": 8, "isBus": True, "core": "u_ila_0", "port": 1}]


def test_bus_that_does_not_start_at_bit_zero_keeps_its_range(write):
    port = pin(0, ("top/u1/addr", ["top/u1/addr[9]", "top/u1/addr[8]"]), leftIndex=0, rightIndex=1)
    assert ib.parse_ltx_file(write("top.ltx", json_ltx(ila("u_ila_0", port))))["probes"][0]["fullName"] \
        == "top/u1/addr[9:8]"


def test_bus_of_one_bit_is_named_as_the_xml_form_names_it(write):
    # a port of one bit whose net is a bus of one: the file lists the bit, and that is the name, as for XML
    port = pin(0, ("top/u1/ce", ["top/u1/ce[0]"]), isVector=False, leftIndex=0, rightIndex=0)
    (probe_,) = ib.parse_ltx_file(write("top.ltx", json_ltx(ila("u_ila_0", port))))["probes"]
    assert probe_ == {"name": "ce[0]", "fullName": "top/u1/ce[0]", "width": 1, "isBus": False, "core": "u_ila_0",
                      "port": 0}
    xml = ltx(probe(["top/u1/ce[0]"], HW_ILA="u_ila_0", PROBE_PORT=0, PROBE_PORT_BIT_COUNT=1))
    assert ib.parse_ltx_file(write("top_xml.ltx", xml))["probes"] == [probe_]


def test_every_net_of_a_probe_port_is_a_probe(write):
    port = pin(3, "top/rx_valid", ("top/u1/data", ["top/u1/data[1]", "top/u1/data[0]"]), leftIndex=0, rightIndex=2)
    assert ib.parse_ltx_file(write("top.ltx", json_ltx(ila("u_ila_0", port))))["probes"] == [
        dict(RX_VALID, port=3),
        {"name": "data", "fullName": "top/u1/data[1:0]", "width": 2, "isBus": True, "core": "u_ila_0", "port": 3}]


def test_json_core_without_a_name(write):
    parsed = ib.parse_ltx_file(write("top.ltx", json_ltx({"type": "ILA_V3", "pins": [pin(0, "top/rx_valid")]})))
    assert parsed["cores"] == [{"name": "hw_ila_1", "cell": "", "depth": 0}]      # as for the XML form
    assert parsed["probes"] == [dict(RX_VALID, core="hw_ila_1")]


@pytest.mark.parametrize("text, said", [
    ('{"probes": []}', 'it has no "ltx_root"'),
    ('{"ltx_root": [1, 2]}', 'it has no "ltx_root"'),
    ('{"ltx_root": {', "Expecting"),                     # cut off: what the JSON reader says about it
    ("{", "Expecting"),
])
def test_json_that_is_no_probe_file_is_an_answer_not_an_exception(write, text, said):
    parsed = ib.parse_ltx_file(write("top.ltx", text))
    assert parsed["error"].startswith("Failed to parse LTX: ") and said in parsed["error"]
    assert parsed["cores"] == [] and parsed["probes"] == []


def test_json_form_nested_beyond_reason_is_an_answer_not_an_exception(write):
    parsed = ib.parse_ltx_file(write("top.ltx", '{"ltx_root": ' + "[" * 100000))
    assert parsed["error"].startswith("Failed to parse LTX") and parsed["probes"] == []


# ---------------------------------------------------------------- a file too large to be a probe file
@pytest.mark.parametrize("text", [TWO_CORES, TWO_CORES_JSON])
def test_probe_file_above_the_size_that_is_read_is_refused(write, monkeypatch, text):
    path = write("top.ltx", text)
    monkeypatch.setattr(ib, "MAX_LTX_BYTES", len(text))  # as large as the file: that is read
    assert len(ib.parse_ltx_file(path)["probes"]) == 2
    monkeypatch.setattr(ib, "MAX_LTX_BYTES", len(text) - 1)
    assert ib.parse_ltx_file(path) == {
        "error": "Failed to parse LTX: the file has %d bytes: a probe file is read up to %d bytes (0 MB)" % (
            len(text), len(text) - 1), "cores": [], "probes": []}


def test_probe_files_are_read_up_to_64_mb_by_the_gui_and_by_check():
    assert ib.MAX_LTX_BYTES == ib.driver().MAX_LTX_BYTES == 64 << 20
