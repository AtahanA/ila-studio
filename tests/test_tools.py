# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Finding what a session starts: Vivado, which need not be where the profile says, and the Tcl script."""
import os
import re
import types

import pytest

import ila_capture as ic


def install(folder):
    """A Vivado installation as far as the search looks at it: <folder>/bin/vivado.bat. Returns that file."""
    (folder / "bin").mkdir(parents=True)
    (folder / "bin" / "vivado.bat").write_text("")
    return str(folder / "bin" / "vivado.bat")


# ---------------------------------------------------------------- Vivado
def test_vivado_named_by_the_profile_is_used_when_it_exists(no_vivado, tmp_path):
    exe = install(tmp_path / "2017.4")
    assert ic.resolve_vivado(exe) == exe


def test_vivado_on_the_path_is_found(no_vivado, monkeypatch, tmp_path):
    monkeypatch.setattr(ic.shutil, "which", lambda name: "/tools/bin/vivado" if name == "vivado" else None)
    assert ic.resolve_vivado(str(tmp_path / "vivado.bat")) == "/tools/bin/vivado"


def test_vivado_is_found_through_xilinx_vivado(no_vivado, monkeypatch, tmp_path):
    exe = install(tmp_path / "Vivado" / "2020.2")
    monkeypatch.setenv("XILINX_VIVADO", str(tmp_path / "Vivado" / "2020.2"))
    assert ic.resolve_vivado("") == exe


def test_newest_installation_wins(no_vivado, monkeypatch, tmp_path):
    both = [install(tmp_path / "2017.4"), install(tmp_path / "2020.2")]
    monkeypatch.setattr(ic.glob, "glob", lambda pattern: both if pattern.endswith("vivado.bat") else [])
    assert ic.resolve_vivado("") == both[1]


def test_installation_with_the_version_folder_first_is_found_and_compared_by_its_version(no_vivado, monkeypatch, tmp_path):
    # newer installers: <root>\<version>\Vivado\bin, where the older ones have <root>\Vivado\<version>\bin
    old, new = install(tmp_path / "Xilinx" / "Vivado" / "2019.1"), install(tmp_path / "Xilinx" / "2025.2" / "Vivado")
    asked = []
    monkeypatch.setattr(ic.glob, "glob", lambda pattern: asked.append(pattern) or
                        ([old, new] if pattern.endswith("vivado.bat") and "Vivado_Lab" not in pattern else []))
    assert ic.resolve_vivado("") == new
    assert any(os.path.join("Xilinx", "*", "Vivado", "bin") in pattern for pattern in asked)
    assert any(os.path.join("AMDDesignTools", "*", "Vivado", "bin") in pattern for pattern in asked)
    # and the older of two such installations loses, whichever layout it has
    older = install(tmp_path / "Xilinx" / "2024.1" / "Vivado")
    monkeypatch.setattr(ic.glob, "glob", lambda pattern: [new, older, old] if pattern.endswith("vivado.bat") else [])
    assert ic.resolve_vivado("") == new


def test_vivado_that_cannot_be_found_names_every_way_out(no_vivado, tmp_path):
    with pytest.raises(RuntimeError) as not_found:
        ic.resolve_vivado(str(tmp_path / "vivado.bat"))
    for remedy in (str(tmp_path / "vivado.bat"), "PATH", "XILINX_VIVADO", "tools.vivado"):
        assert remedy in str(not_found.value)


# ---------------------------------------------------------------- the Tcl script
def test_script_shipped_with_the_driver_is_in_scripts():
    path = ic.resolve_tcl(None)
    assert path == os.path.join(ic.HERE, "scripts", "vivado_ila_repl.tcl")
    assert os.path.isfile(path)


def test_script_shipped_with_the_driver_has_the_version_the_driver_expects():
    # the two numbers are counted up together. Read from the text of the script, which needs no Tcl interpreter
    with open(ic.resolve_tcl(None), encoding="utf-8") as f:
        numbers = re.findall(r"^set ::ILA_REPL_VERSION (\d+)$", f.read(), re.M)
    assert numbers == [str(ic.SCRIPT_VERSION)]


def test_missing_script_is_reported_with_where_it_should_be(monkeypatch, tmp_path):
    monkeypatch.setattr(ic, "HERE", str(tmp_path))       # a folder the script was not copied to
    with pytest.raises(RuntimeError) as not_found:
        ic.resolve_tcl(None)
    assert str(not_found.value) == "Tcl script not found: " + os.path.join(str(tmp_path), "scripts",
                                                                           "vivado_ila_repl.tcl")


def test_script_of_ones_own_is_used(write):
    mine = write("mine.tcl", "")
    assert ic.resolve_tcl(mine) == mine


def test_script_that_is_named_and_not_there_is_an_error(monkeypatch, tmp_path):
    # not the shipped script in its place, without a word: whoever named it would be editing a file never run
    monkeypatch.chdir(tmp_path)
    for named in ("my_repl.tcl", os.path.join("scripts", "my_repl.tcl"), str(tmp_path / "my_repl.tcl")):
        with pytest.raises(RuntimeError) as not_found:
            ic.resolve_tcl(named)
        assert str(not_found.value) == "Tcl script not found: " + named


def test_no_name_or_an_empty_one_is_the_shipped_script():
    assert ic.resolve_tcl("") == ic.resolve_tcl(None)


def test_relative_script_name_is_also_looked_up_next_to_the_driver(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)                          # the way the GUI names it, from any working directory
    assert ic.resolve_tcl(os.path.join("scripts", "vivado_ila_repl.tcl")) == ic.resolve_tcl(None)


def test_shipped_script_may_be_named_by_its_bare_file_name(monkeypatch, tmp_path):
    # how set-ups from before the scripts folder name it: found in that folder, where it is now
    monkeypatch.chdir(tmp_path)
    assert ic.resolve_tcl("vivado_ila_repl.tcl") == ic.resolve_tcl(None)


def test_script_in_the_working_directory_comes_before_one_next_to_the_driver(monkeypatch, write, tmp_path):
    mine = write("vivado_ila_repl.tcl", "")              # a script of one's own under the name of the shipped one
    monkeypatch.chdir(tmp_path)
    assert ic.resolve_tcl("vivado_ila_repl.tcl") == mine


def test_session_is_not_made_with_a_script_that_is_not_there(tmp_path):
    args = types.SimpleNamespace(tcl="my_repl.tcl", trigger="now", out=str(tmp_path / "out"), target="unit")
    with pytest.raises(RuntimeError, match="Tcl script not found: my_repl.tcl"):
        ic.Session(args, ic.load_profile(None))
    assert not (tmp_path / "out").exists()               # said before a session folder is made for it
