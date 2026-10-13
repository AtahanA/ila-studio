# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""How the numbers of a capture file are read and rewritten. A Vivado ILA CSV does not say whether a column is
hex or decimal, so the driver infers it per column; it then writes hex as decimal, or each probe in the format
asked for."""
import os

import pytest

import ila_capture as ic

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
