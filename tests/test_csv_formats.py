# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""How the numbers of a capture file are read and rewritten. A Vivado ILA CSV does not say whether a column is
hex or decimal, so the driver infers it per column; it then writes hex as decimal, or each probe in the format
asked for."""
import os
import zipfile

import pytest

import ila_capture as ic

# every test here twice: with the capture files read as shipped, and in pieces of a few characters and one row
pytestmark = pytest.mark.usefixtures("pieces")

HEAD = "Sample in Buffer,Sample in Window,TRIGGER,"
HEX = HEAD + "top/x[7:0]\n0,0,0,0a\n1,1,1,ff\n"         # the bus as Vivado exports it by default
DEC = HEAD + "top/x[7:0]\n0,0,0,10\n1,1,1,255\n"        # the same capture in unsigned decimal


def radix_of(values, *neighbours):
    """The radix inferred for a column x[7:0] with these values; neighbours are the values of further 8-bit
    columns of the same file."""
    hdr = ["Sample in Buffer", "top/x[7:0]"] + ["top/n%d[7:0]" % k for k in range(len(neighbours))]
    rows = [[str(i)] + list(row) for i, row in enumerate(zip(values, *neighbours))]
    return ic.column_radixes(hdr, rows)[1]


# ---------------------------------------------------------------- which columns, which rows
def test_bus_columns_are_the_multi_bit_ones():
    hdr = ["Sample in Buffer", "top/en", "top/d[0:0]", "top/x[7:0]", "top/y[0:3]"]
    assert ic.bus_columns(hdr) == {3: 8, 4: 4}           # d[0:0] is one bit wide: not a bus


@pytest.mark.parametrize("row, is_data", [
    (["0", "1"], True),
    ([" 12", "0"], True),
    (["Radix - UNSIGNED", "HEX"], False),
    (["Sample in Buffer", "top/x[7:0]"], False),
    ([""], False),                                       # what is left of the newline that ends the file
    ([], False),
])
def test_data_rows_start_with_a_sample_number(row, is_data):
    assert ic.is_data_row(row) is is_data


# ---------------------------------------------------------------- the radix of a column
@pytest.mark.parametrize("values, radix", [
    (["0a", "ff"], "hex"),          # letters
    (["05", "10"], "hex"),          # padded with a zero to the two digits of an 8-bit hex value
    (["0x0A", "0xFF"], "hex"),      # the way this tool writes a probe asked for in hex
    (["5", "200"], "dec"),          # one digit and three: neither is the hex width
    (["-1", "12"], "dec"),          # a sign
    (["10", "99"], "dec"),          # fits both: decimal, as long as nothing else in the file says hex
])
def test_radix_of_a_column(values, radix):
    assert radix_of(values) == radix


def test_ambiguous_column_follows_a_hex_neighbour():
    assert radix_of(["10", "99"], ["0a", "0a"]) == "hex"


def test_ambiguous_column_does_not_follow_a_0x_neighbour():
    # "0x" marks one probe written in hex next to decimal ones: it says nothing about the other columns
    assert radix_of(["10", "99"], ["0x0A", "0x0A"]) == "dec"


@pytest.mark.parametrize("values", [["0a", "100"], ["0x0A", "10"]])
def test_hex_and_decimal_in_one_column_is_refused(values):
    with pytest.raises(ValueError, match="both hex and decimal"):
        radix_of(values)


def test_only_buses_have_a_radix():
    assert ic.column_radixes(["Sample in Buffer", "top/en", "top/x[7:0]"], [["0", "1", "0a"]]) == {2: "hex"}


# ---------------------------------------------------------------- hex to decimal
def test_hex_columns_become_decimal():
    assert ic.ila_text_to_decimal(HEX) == (DEC, ["x[7:0]"])


def test_decimal_text_is_left_alone():
    assert ic.ila_text_to_decimal(DEC) == (DEC, [])


def test_line_ends_are_kept():
    text, _ = ic.ila_text_to_decimal(HEX.replace("\n", "\r\n"))
    assert text == DEC.replace("\n", "\r\n")


def test_radix_row_follows_the_conversion():
    # the second header row of newer Vivado versions, which names the radix of every column
    text, _ = ic.ila_text_to_decimal(HEAD + "top/x[7:0]\nRadix - UNSIGNED,UNSIGNED,UNSIGNED,HEX\n0,0,0,0a\n")
    assert text.splitlines()[1] == "Radix - UNSIGNED,UNSIGNED,UNSIGNED,UNSIGNED"


# ---------------------------------------------------------------- a format per probe
def test_probe_format_map_normalises_names_and_formats():
    assert ic.probe_format_map({"a/b[7:0]": "Signed "}) == {"a/b": "signed"}
    assert ic.probe_format_map(None) == {}


def test_unknown_probe_format_is_refused():
    with pytest.raises(ValueError, match="octal"):
        ic.probe_format_map({"a/b": "octal"})


def test_probe_is_named_by_its_last_element_or_in_full():
    hdr = ["Sample in Buffer", "top/u1/data[7:0]", "top/u2/status[3:0]"]
    assert ic.format_columns(hdr, {"data": "hex"}) == {1: "hex"}
    assert ic.format_columns(hdr, {"top/u2/status": "signed"}) == {2: "signed"}


def test_column_called_exactly_that_is_the_one_meant():
    # "data" is the column called data, not top/u1/data, although that one ends in it
    hdr = ["Sample in Buffer", "top/u1/data[7:0]", "data[7:0]"]
    assert ic.format_columns(hdr, {"data": "hex"}) == {2: "hex"}


def test_probe_written_signed():
    text, changed = ic.ila_text_formatted(DEC, {"x": "signed"})
    assert text == HEAD + "top/x[7:0]\n0,0,0,10\n1,1,1,-1\n"        # 255 is -1 in 8 bits
    assert changed == {"x[7:0]": "signed"}


def test_probe_written_hex():
    text, changed = ic.ila_text_formatted(DEC, {"x": "hex"})
    assert text == HEAD + "top/x[7:0]\n0,0,0,0x0A\n1,1,1,0xFF\n"    # the prefix and every digit of the width
    assert changed == {"x[7:0]": "hex"}


def test_hex_nobody_asked_about_becomes_unsigned_decimal():
    assert ic.ila_text_formatted(HEX, {}) == (DEC, {"x[7:0]": "unsigned"})


def test_0x_column_nobody_asked_about_is_left_as_it_is():
    # a file that was formatted before, formatted again with other formats: the hex somebody chose then stays
    text = HEAD + "top/a[7:0],top/b[7:0]\n0,0,0,0x0A,5\n1,1,1,0xFF,200\n"
    assert ic.ila_text_formatted(text, {"b": "signed"}) == (
        HEAD + "top/a[7:0],top/b[7:0]\n0,0,0,0x0A,5\n1,1,1,0xFF,-56\n", {"b[7:0]": "signed"})
    assert ic.ila_text_formatted(text, {}) == (text, {})


def test_0x_column_is_rewritten_when_it_is_asked_about():
    text = HEAD + "top/a[7:0]\n0,0,0,0x0A\n1,1,1,0xFF\n"
    assert ic.ila_text_formatted(text, {"a": "unsigned"}) == (HEAD + "top/a[7:0]\n0,0,0,10\n1,1,1,255\n",
                                                             {"a[7:0]": "unsigned"})


def test_convert_still_makes_a_0x_column_decimal():
    # "convert" promises decimal for the whole file, whatever was chosen when it was written
    assert ic.ila_text_to_decimal(HEAD + "top/a[7:0]\n0,0,0,0x0A\n1,1,1,0xFF\n") == (
        HEAD + "top/a[7:0]\n0,0,0,10\n1,1,1,255\n", ["a[7:0]"])


def test_signed_column_is_written_unsigned_again():
    text, _ = ic.ila_text_formatted(HEAD + "top/x[7:0]\n0,0,0,10\n1,1,1,-1\n", {"x": "unsigned"})
    assert text == DEC


def test_text_that_is_already_as_asked_comes_back_untouched():
    assert ic.ila_text_formatted(DEC, {"x": "unsigned"}) == (DEC, {})


# ---------------------------------------------------------------- capture files
@pytest.mark.parametrize("name", ["cap.csv", "cap.csv.gz", "cap.ila"])
def test_capture_text_of_every_file_kind(write, name):
    assert ic.read_ila_text(write(name, HEX)) == HEX


def test_load_ila_gives_header_rows_and_radix(write):
    hdr, rows, radix = ic.load_ila(write("cap.csv", HEX))
    assert hdr == ["Sample in Buffer", "Sample in Window", "TRIGGER", "top/x[7:0]"]
    assert rows == [["0", "0", "0", "0a"], ["1", "1", "1", "ff"]]
    assert radix == {3: "hex"}


def test_ila_csv_is_known_by_its_first_column(write, tmp_path):
    assert ic.is_ila_csv(write("cap.csv", HEX))
    assert ic.is_ila_csv(write("cap.csv.gz", HEX))
    assert not ic.is_ila_csv(write("index.csv", "time,name\n"))
    assert not ic.is_ila_csv(str(tmp_path / "missing.csv"))


def test_file_without_samples_is_no_capture(write, tmp_path):
    assert ic.has_data_rows(write("cap.csv", HEX))
    # what the upload from a core that never triggered looks like: the header and nothing else
    assert not ic.has_data_rows(write("empty.csv", HEAD + "top/x[7:0]\n"))
    assert not ic.has_data_rows(str(tmp_path / "missing.csv"))


def test_gzip_file_replaces_the_csv(write, tmp_path):
    path = write("cap.csv", HEX)
    assert ic.gzip_file(path) == path + ".gz"
    assert os.listdir(str(tmp_path)) == ["cap.csv.gz"]
    assert ic.read_ila_text(path + ".gz") == HEX


def test_csv_is_made_decimal_in_place_and_keeps_its_time(write, tmp_path):
    path = write("cap.csv", HEX)
    os.utime(path, (1000000000, 1000000000))
    assert ic.ila_csv_to_decimal(path) == ["x[7:0]"]
    assert ic.read_ila_text(path) == DEC
    assert os.stat(path).st_mtime == 1000000000
    assert os.listdir(str(tmp_path)) == ["cap.csv"]      # written through a .tmp file, which is gone again


def test_csv_is_extracted_from_an_archive(write, tmp_path):
    archive = tmp_path / "cap.ila"
    write("cap.ila", HEX)
    before = archive.read_bytes()
    assert ic.ila_csv_to_decimal(str(archive), str(tmp_path / "cap.csv")) == ["x[7:0]"]
    assert ic.read_ila_text(str(tmp_path / "cap.csv")) == DEC
    assert archive.read_bytes() == before                # the archive stays what Vivado wrote


def test_archive_is_never_rewritten(write):
    with pytest.raises(ValueError, match="never rewritten"):
        ic.ila_csv_to_decimal(write("cap.ila", HEX))


def test_gzipped_capture_is_rewritten_in_the_formats_asked_for(write):
    path = write("cap.csv.gz", DEC)
    assert ic.ila_csv_format(path, {"x": "hex"}) == {"x[7:0]": "hex"}
    assert ic.read_ila_text(path) == HEAD + "top/x[7:0]\n0,0,0,0x0A\n1,1,1,0xFF\n"


# ---------------------------------------------------------------- a capture is read as a stream
RADIX_ROW = HEAD + "top/x[7:0]\nRadix - UNSIGNED,UNSIGNED,UNSIGNED,HEX\n"       # newer Vivado versions write one


@pytest.mark.parametrize("name", ["cap.csv", "cap.csv.gz", "cap.ila"])
def test_first_sample_is_found_in_every_file_kind_and_behind_a_radix_row(write, name):
    assert ic.has_data_rows(write(name, RADIX_ROW + "0,0,0,0a\n1,1,1,ff\n"))
    assert not ic.has_data_rows(write("empty_" + name, RADIX_ROW))


def test_file_is_read_no_further_than_its_first_sample_to_know_that_it_has_one(tmp_path, monkeypatch):
    monkeypatch.setattr(ic, "CHUNK_BYTES", 64)
    path = tmp_path / "cap.csv"
    # a hundred samples, and behind them bytes that no reader of a capture takes
    path.write_bytes((HEX + "2,2,0,00\n" * 100).encode("ascii") + b"\xff\xfe")
    assert ic.has_data_rows(str(path))
    with pytest.raises(ValueError):
        ic.load_ila(str(path))


def test_capture_of_any_size_has_samples(write, monkeypatch):
    # the limit on what is read is for reading a capture; to know that it has samples takes its first lines
    monkeypatch.setattr(ic, "MAX_CAPTURE_BYTES", 10)
    for name in ("cap.csv", "cap.csv.gz", "cap.ila"):
        assert ic.has_data_rows(write(name, HEX))


def test_statistics_do_not_hold_the_capture(write, held, long_capture):
    path = write("cap.csv", long_capture)
    st, most = held(ic.stats_of, path, {"mode": "magnitude", "value_probe": "bus_1", "valid_probe": "en",
                                        "ctrl_probes": ["en"], "event_probes": ["en"]})
    assert (st["rows"], st["n"], st["radix"], st["ctrl"], st["n_en"]) == (4000, 2000, "hex", "en=01", 2000)
    # read whole - one text, then a list of rows of cells - it is twelve times its own size in memory
    assert most < 3 * len(long_capture)


@pytest.mark.parametrize("name", ["cap.csv", "cap.csv.gz"])
def test_rewriting_does_not_hold_the_capture(write, held, long_capture, name):
    path = write(name, long_capture)
    columns, most = held(ic.ila_csv_to_decimal, path)
    assert len(columns) == 30 and most < 3 * len(long_capture)
    lines = ic.read_ila_text(path).split("\n")
    assert len(lines) == 4002 and lines[0] == long_capture.split("\n")[0]
    assert lines[4000] == "3999,3999,0,1," + ",".join(str(3999 * (i + 3) & 0xFFFF) for i in range(30))
    rewritten, most = held(ic.ila_csv_format, path, {"bus_1": "hex", "bus_20": "signed"})
    assert rewritten == {"bus_1[15:0]": "hex", "bus_20[15:0]": "signed"} and most < 3 * len(long_capture)
    sample = ic.read_ila_text(path).split("\n")[1501].split(",")
    # sample 1500: bus_0 is 3 * 1500, bus_1 is 4 * 1500 = 0x1770, bus_20 is 23 * 1500 = 34500, as 16 bits signed
    assert (sample[0], sample[4], sample[5], sample[24]) == ("1500", "4500", "0x1770", "-31036")


def test_timeline_does_not_hold_the_capture(write, held, long_capture):
    prof = ic.load_profile(None)
    prof["stats"]["event_probes"] = ["en"]
    summary, most = held(ic.capture_summary, write("cap.csv", long_capture), prof)
    # en rises at every odd sample: first at sample 1, six samples before the trigger at sample 7
    assert (summary["n_rows"], summary["en_n"], summary["en_first"]) == (4000, 2000, -6)
    assert most < 3 * len(long_capture)


# ---------------------------------------------------------------- a capture that is too large to be one
@pytest.mark.parametrize("name", ["cap.csv", "cap.csv.gz", "cap.ila"])
def test_capture_that_holds_more_text_than_is_read_is_refused(write, monkeypatch, name):
    path = write(name, HEX)
    monkeypatch.setattr(ic, "MAX_CAPTURE_BYTES", len(HEX))      # as much as it holds: that is read
    assert ic.read_ila_text(path) == HEX
    monkeypatch.setattr(ic, "MAX_CAPTURE_BYTES", len(HEX) - 1)
    said = "%s: the capture holds more than %d bytes of text" % (name, len(HEX) - 1)
    for read in (ic.read_ila_text, ic.load_ila, lambda p: ic.stats_of(p, {"mode": "none"}),
                 lambda p: ic.ila_csv_to_decimal(p, p + ".csv"),
                 lambda p: ic.ila_csv_format(p, {"x": "hex"}, p + ".csv")):
        with pytest.raises(ValueError, match=said):
            read(path)
    assert not os.path.exists(path + ".csv") and not os.path.exists(path + ".csv.tmp")


def test_archive_is_refused_for_the_size_it_states_before_any_of_it_is_unpacked(tmp_path, monkeypatch):
    path = str(tmp_path / "cap.ila")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("waveform.csv", HEX + "2,2,0,00\n" * 100000)         # 0.9 MB of text in an archive of a few KB
    assert os.path.getsize(path) < 10000
    monkeypatch.setattr(ic, "MAX_CAPTURE_BYTES", 500000)
    monkeypatch.setattr(ic.zipfile.ZipFile, "open", lambda *args, **kw: pytest.fail("the archive was unpacked"))
    with pytest.raises(ValueError, match="holds more than 500000 bytes of text"):
        ic.read_ila_text(path)


@pytest.mark.parametrize("name", ["cap.csv", "cap.csv.gz", "cap.ila"])
def test_text_without_line_ends_is_no_capture(write, monkeypatch, name):
    monkeypatch.setattr(ic, "CHUNK_BYTES", 16)
    monkeypatch.setattr(ic, "MAX_LINE_CHARS", 100)
    path = write(name, HEAD + "top/x[7:0]\n" + "0,0,0,0a," * 50)
    for read in (ic.load_ila, lambda p: ic.ila_csv_to_decimal(p, p + ".csv")):
        with pytest.raises(ValueError, match="a line of more than 100 characters: this is no ILA CSV"):
            read(path)
    assert not ic.has_data_rows(path)
