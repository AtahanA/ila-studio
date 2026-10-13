# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""tools/third_party_notices.py, as far as it works without cargo and npm: the licence gate of a release (which
licence expressions may go into a GPL-3.0-or-later program), which crates count as linked, and how
THIRD-PARTY-NOTICES.md is laid out. The packages are made up here."""
import hashlib
import importlib.util
import itertools
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_tool():
    """tools/ holds scripts, it is not a package: the file is loaded by its path."""
    spec = importlib.util.spec_from_file_location("third_party_notices",
                                                  os.path.join(ROOT, "tools", "third_party_notices.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tpn = load_tool()


def component(name="alpha", licence="MIT", files=(), kind="Rust crate", repository="https://example.org/alpha"):
    return tpn.complete(tpn.Component(kind, name, "1.0.0", licence, "https://crates.io/crates/%s/1.0.0" % name,
                                      repository, files))


# ---------------------------------------------------------------- the licence gate
@pytest.mark.parametrize("expression", [
    "MIT",
    "MIT OR Apache-2.0",
    "(MIT OR Apache-2.0) AND Unicode-3.0",
    "Apache-2.0 WITH LLVM-exception",
    "0BSD OR MIT OR Apache-2.0",
    "CC0-1.0 OR MIT-0 OR Apache-2.0",
    "MIT OR LGPL-2.1-or-later",                     # a choice: the allowed alternative is the one taken
    "LGPL-2.1-or-later AND MIT OR Apache-2.0",      # AND binds tighter, so Apache-2.0 is an alternative of its own
    "MIT/Apache-2.0",                               # the old way of crates to write OR
    "Apache-2.0 / MIT",
    "((MIT))",
    "mit or apache-2.0",                            # SPDX compares without regard to case
    "Apache-2.0+",
])
def test_a_licence_that_may_go_into_the_program_is_accepted(expression):
    assert tpn.refused(expression) == []


@pytest.mark.parametrize("name", tpn.ALLOWED)
def test_every_licence_of_the_list_is_accepted_alone(name):
    assert tpn.refused(name) == []


@pytest.mark.parametrize("expression, why", [
    ("Fancy-1.0", ["Fancy-1.0"]),                                       # unknown: nobody has read it
    ("LGPL-2.1-or-later", ["LGPL-2.1-or-later"]),
    ("MIT AND LGPL-2.1-or-later", ["LGPL-2.1-or-later"]),
    ("LGPL-2.1-or-later AND (MIT OR Apache-2.0)", ["LGPL-2.1-or-later"]),
    ("Fancy-1.0 OR Other-2.0", ["Fancy-1.0", "Other-2.0"]),
    ("Apache-2.0 WITH Classpath-exception-2.0", ["Apache-2.0 WITH Classpath-exception-2.0"]),
    ("GPL-2.0-only WITH LLVM-exception", ["GPL-2.0-only WITH LLVM-exception"]),
    ("UNLICENSED", ["UNLICENSED"]),                                     # npm's word for "no licence": not Unlicense
])
def test_a_licence_that_is_not_on_the_list_is_refused_and_named(expression, why):
    assert tpn.refused(expression) == why


@pytest.mark.parametrize("expression", ["", "   ", None])
def test_no_licence_at_all_is_refused(expression):
    assert tpn.refused(expression) == ["no licence is stated"]


@pytest.mark.parametrize("expression", ["MIT OR", "(MIT", "MIT)", "MIT Apache-2.0", "AND", "MIT WITH", "()",
                                        "MIT WITH (LLVM-exception)", "SEE LICENSE IN LICENSE.txt"])
def test_what_is_not_an_spdx_expression_is_refused(expression):
    assert tpn.refused(expression) == ["not an SPDX licence expression"]


def test_the_licences_of_an_expression_are_listed_once_each():
    assert tpn.licence_ids("(MIT OR Apache-2.0) AND Unicode-3.0 AND mit") == ["MIT", "Apache-2.0", "Unicode-3.0"]
    assert tpn.licence_ids("Apache-2.0 WITH LLVM-exception OR MPL-2.0+") == ["Apache-2.0", "MPL-2.0"]
    assert tpn.licence_ids("MIT OR") == []


# ---------------------------------------------------------------- which crates are in the executable
def crate(name):
    return {"id": name, "name": name, "version": "1.0.0"}


def uses(name, *kinds):
    """A dependency edge as cargo metadata writes it: kind None is a normal one, "build" and "dev" are the others."""
    return {"pkg": name, "dep_kinds": [{"kind": kind, "target": None} for kind in (kinds or (None,))]}


def test_only_what_the_application_reaches_over_normal_dependencies_is_linked():
    names = ["app", "runtime", "deep", "macro", "builder", "build-helper", "tester", "both-ways"]
    meta = {"packages": [crate(n) for n in names], "resolve": {"root": "app", "nodes": [
        {"id": "app", "deps": [uses("runtime"), uses("builder", "build"), uses("tester", "dev"),
                               uses("both-ways", "build", None)]},
        {"id": "runtime", "deps": [uses("deep"), uses("macro")]},
        {"id": "deep", "deps": [uses("runtime")]},                      # a circle must not keep it busy for ever
        {"id": "macro", "deps": []},
        {"id": "builder", "deps": [uses("build-helper")]},              # normal, but only of the build script
        {"id": "build-helper", "deps": []},
        {"id": "tester", "deps": []},
        {"id": "both-ways", "deps": []},
    ]}}
    app, linked = tpn.linked_packages(meta)
    assert app["name"] == "app"
    assert [p["name"] for p in linked] == ["both-ways", "deep", "macro", "runtime"]


# ---------------------------------------------------------------- what the packages say about themselves
def test_the_licence_of_a_package_json_is_read_in_all_its_forms():
    assert tpn.npm_licence({"license": "ISC"}) == "ISC"
    assert tpn.npm_licence({"license": {"type": "MIT", "url": "https://example.org/licence"}}) == "MIT"
    assert tpn.npm_licence({"licenses": [{"type": "MIT"}, {"type": "Apache-2.0"}]}) == "MIT OR Apache-2.0"
    assert tpn.npm_licence({"name": "alpha"}) == ""


@pytest.mark.parametrize("stated, address", [
    ("https://github.com/someone/alpha", "https://github.com/someone/alpha"),
    ("https://github.com/someone/alpha.git", "https://github.com/someone/alpha"),
    ({"type": "git", "url": "git+https://github.com/someone/alpha.git", "directory": "packages/alpha"},
     "https://github.com/someone/alpha"),
    ("git://github.com/someone/alpha.git", "https://github.com/someone/alpha"),
    ("git@github.com:someone/alpha.git", "https://github.com/someone/alpha"),
    ("github:someone/alpha", "https://github.com/someone/alpha"),
    ("someone/alpha", "https://github.com/someone/alpha"),
    (None, ""),
    ({}, ""),
])
def test_the_repository_becomes_an_address_for_a_browser(stated, address):
    assert tpn.repository_url(stated) == address


def test_a_crate_of_the_registry_is_named_by_its_exact_version():
    registry = {"name": "alpha", "version": "1.2.3", "source": "registry+https://github.com/rust-lang/crates.io-index"}
    assert tpn.crate_source(registry) == "https://crates.io/crates/alpha/1.2.3"
    assert tpn.crate_source(dict(registry, source="git+https://example.org/alpha?rev=abc#abc")) \
        == "https://example.org/alpha?rev=abc#abc"
    assert tpn.crate_source(dict(registry, source=None)) == ""


# ---------------------------------------------------------------- licence texts
def test_a_licence_file_keeps_its_words_and_loses_its_stray_blanks():
    assert tpn.tidy("\ufeff\r\n  MIT License  \r\n\r\n\tCopyright\x0cnext page\n\n") \
        == "  MIT License\n\n        Copyright\nnext page"


def test_the_same_text_wrapped_differently_is_printed_once_with_all_its_owners():
    one = "Permission is hereby granted,\nfree of charge."
    again = "Permission is hereby   granted, free\n\nof charge."
    items = [("beta 1.0.0", "LICENSE", again), ("alpha 1.0.0", "LICENSE-MIT", one),
             ("gamma 1.0.0", "COPYING", "Another text altogether.")]
    wanted = [(one, [("alpha 1.0.0", "LICENSE-MIT"), ("beta 1.0.0", "LICENSE")]),
              ("Another text altogether.", [("gamma 1.0.0", "COPYING")])]
    # the most widely shared text first, its owners by name - in whatever order the packages were read
    for order in itertools.permutations(items):
        assert tpn.group_texts(order) == wanted


def test_texts_that_differ_in_a_word_stay_apart():
    groups = tpn.group_texts([("alpha 1.0.0", "LICENSE", "Copyright (c) the authors of alpha"),
                              ("beta 1.0.0", "LICENSE", "Copyright (c) the authors of beta")])
    assert [members for _, members in groups] == [[("alpha 1.0.0", "LICENSE")], [("beta 1.0.0", "LICENSE")]]


def test_the_licence_files_of_a_package_folder_are_found_by_their_names(tmp_path):
    for name, text in [("LICENSE-MIT", "the MIT text\r\n"), ("license-apache-2.0", "the Apache text"),
                       ("COPYING", "which one applies"), ("NOTICE", "who wrote it"), ("LICENCE.md", "British"),
                       ("UNLICENSE", "public domain"), ("README.md", "not a licence"), ("Cargo.toml", "[package]"),
                       ("LICENSE-EMPTY", "\n")]:
        (tmp_path / name).write_bytes(text.encode("utf-8"))
    (tmp_path / "LICENSES").mkdir()                 # a folder is not read: only the files next to the manifest
    assert tpn.licence_files(str(tmp_path)) == [
        ("COPYING", "which one applies"), ("LICENCE.md", "British"), ("license-apache-2.0", "the Apache text"),
        ("LICENSE-MIT", "the MIT text"), ("NOTICE", "who wrote it"), ("UNLICENSE", "public domain")]


def test_the_standard_texts_are_the_licences_they_stand_for():
    assert tpn.STANDARD_TEXTS["MIT"].startswith("MIT License\n\nCopyright (c) <year> <copyright holders>\n")
    assert "Permission is hereby granted, free of charge" in tpn.STANDARD_TEXTS["MIT"]
    apache = " ".join(tpn.STANDARD_TEXTS["Apache-2.0"].split())
    assert apache.startswith("Apache License Version 2.0, January 2004 http://www.apache.org/licenses/")
    assert "9. Accepting Warranty or Additional Liability." in apache and "END OF TERMS AND CONDITIONS" in apache
    mpl = tpn.STANDARD_TEXTS["MPL-2.0"]
    assert mpl.startswith("Mozilla Public License Version 2.0\n==================================\n\n1. Definitions\n")
    assert "\n10. Versions of the License\n" in mpl and "\nExhibit A - Source Code Form License Notice\n" in mpl
    assert mpl.endswith("Public License, v. 2.0.")
    # a long text that was copied, not typed: the LICENSE file of the crate dtoa-short 0.3.5 without its last
    # line break. A slip of the hand in it shows here.
    assert hashlib.sha256(mpl.encode("ascii")).hexdigest() \
        == "4b89d4518bd135ab4ee154a7bce722246b57a98c3d7efc1a09409898160c2bd1"
    assert set(tpn.STANDARD_TEXTS) <= set(tpn.ALLOWED)


# ---------------------------------------------------------------- packages without a licence file
def test_a_package_with_its_licence_file_needs_no_note():
    files = [("LICENSE-MIT", "Copyright (c) the authors of alpha")]
    c = component(files=files)
    assert c.files == files and c.note == ""


def test_a_package_without_a_licence_file_gets_the_standard_texts_of_its_licences():
    c = component(licence="MIT OR Apache-2.0")
    assert c.files == [("standard text of MIT", tpn.STANDARD_TEXTS["MIT"]),
                       ("standard text of Apache-2.0", tpn.STANDARD_TEXTS["Apache-2.0"])]
    assert c.note == ("No licence file in the package. The standard text of MIT and Apache-2.0 is printed in its "
                      "place; for the copyright notice see <https://example.org/alpha>.")


def test_no_text_is_made_up_for_a_licence_that_has_a_copyright_line_of_its_own():
    c = component(licence="BSD-3-Clause")
    assert c.files == [] and c.note == "No licence file in the package: see <https://example.org/alpha>."
    mixed = component(licence="MIT AND BSD-3-Clause")
    assert [name for name, _ in mixed.files] == ["standard text of MIT"]
    assert "for BSD-3-Clause and the copyright notice see <https://example.org/alpha>" in mixed.note


def test_a_list_of_fields_is_kept_but_is_not_the_licence_in_words():
    c = component(files=[("LICENSE.spdx", "PackageLicenseDeclared: MIT")])
    assert [name for name, _ in c.files] == ["LICENSE.spdx", "standard text of MIT"]
    assert c.note.startswith("No licence file in the package.")


def test_the_mpl_text_stands_in_and_is_printed_once_with_the_packages_that_bring_it():
    brought = component("gamma", "MPL-2.0", [("LICENSE", tpn.STANDARD_TEXTS["MPL-2.0"].replace("\n    ", "\n  "))],
                        repository="https://example.org/gamma")
    bare = component("delta", "MPL-2.0", repository="https://example.org/delta")
    assert bare.files == [("standard text of MPL-2.0", tpn.STANDARD_TEXTS["MPL-2.0"])]
    assert bare.note == ("No licence file in the package. The standard text of MPL-2.0 is printed in its place; "
                         "for the copyright notice see <https://example.org/delta>.")
    text = tpn.render("0.4.0", [brought, bare])
    assert "### Text 1\n\nOf 2 components: delta 1.0.0 (standard text of MPL-2.0), gamma 1.0.0 (`LICENSE`)\n" in text
    assert text.count("1.1. \"Contributor\"") == 1
    # ... and the section that says where the source of MPL code is leads to it as well
    assert "- **delta 1.0.0** (`MPL-2.0`): source code <https://crates.io/crates/delta/1.0.0>, repository " \
           "<https://example.org/delta>; licence text [1](#text-1)\n" in text


# ---------------------------------------------------------------- licence texts added by hand (tools/licences/)
@pytest.fixture
def added(monkeypatch, tmp_path):
    """tools/licences/ and its table, made up: one text, read for beta 1.0.0. Returns the text as it is printed."""
    (tmp_path / "beta.txt").write_bytes(b"Copyright (c) the authors of beta  \r\n\r\nRedistribution and use.\r\n")
    monkeypatch.setattr(tpn, "LICENCES", str(tmp_path))
    monkeypatch.setattr(tpn, "ADDED_TEXTS", {"beta": ("1.0.0", "beta.txt", "the LICENSE file of its repository",
                                                      "That file is printed in its place.")})
    return "Copyright (c) the authors of beta\n\nRedistribution and use."


def test_a_text_added_by_hand_is_printed_for_the_version_it_was_read_for(added):
    c = component("beta", "BSD-3-Clause", repository="https://example.org/beta")
    assert c.files == [("the LICENSE file of its repository", added)]
    assert c.note == ("No licence file in the package: see <https://example.org/beta>. That file is printed in its "
                      "place.")
    assert not c.has_licence_text                  # the package brings none, and the summary goes on saying so
    text = tpn.render("0.4.0", [c])
    assert "[repository](https://example.org/beta) | [1](#text-1) |\n" in text
    assert " That file is printed in its place. The added text: [1](#text-1).\n" in text
    assert "Of 1 component: beta 1.0.0 (the LICENSE file of its repository)\n\n```text\n" + added + "\n```\n" in text
    assert component("alpha", "BSD-3-Clause").files == []       # nobody else gets it


def test_an_added_text_stands_beside_the_standard_text_of_the_package(added):
    # what it is there for besides: the library of somebody else that a package holds
    c = component("beta", "MIT")
    assert [name for name, _ in c.files] == ["standard text of MIT", "the LICENSE file of its repository"]
    note = [line for line in tpn.render("0.4.0", [c]).split("\n") if line.startswith("- **beta 1.0.0**")]
    assert len(note) == 1 and note[0].endswith(" That file is printed in its place. The standard text: "
                                               "[1](#text-1). The added text: [2](#text-2).")


def test_an_added_text_is_not_carried_over_to_another_version(added):
    with pytest.raises(tpn.Problem) as stopped:
        tpn.complete(tpn.Component("Rust crate", "beta", "1.1.0", "BSD-3-Clause", "", "", []))
    assert "tools/licences/beta.txt was read for beta 1.0.0, and the lock file now names version 1.1.0" \
        in str(stopped.value)


def test_an_entry_whose_file_is_gone_stops_the_run(added, tmp_path):
    os.remove(str(tmp_path / "beta.txt"))
    with pytest.raises(tpn.Problem) as stopped:
        component("beta", "BSD-3-Clause")
    assert "tools/licences/beta.txt is not there" in str(stopped.value)


def test_the_texts_of_tools_licences_are_the_copies_that_were_made():
    # sha256 of each file as it was copied from its source (see ADDED_TEXTS), with line feeds as line ends
    copies = {"alloc-stdlib.txt": "c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae"}
    # no entry without its file, and no file that no entry names
    assert sorted(os.listdir(tpn.LICENCES)) == sorted(copies) == sorted(e[1] for e in tpn.ADDED_TEXTS.values())
    for name, sha256 in copies.items():
        with open(os.path.join(tpn.LICENCES, name), "rb") as f:
            assert hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest() == sha256, name
    for version, name, called, sentence in tpn.ADDED_TEXTS.values():
        assert re.match(r"\d+\.\d+\.\d+", version) and tpn.kept_text(name)
        # ... or the notices would show it as a file of the package
        assert not tpn.LICENCE_FILE.match(called)


# ---------------------------------------------------------------- the document
APACHE = "Apache License\nVersion 2.0, January 2004"


def some_components():
    return [
        component("alpha", "MIT OR Apache-2.0", [("LICENSE-APACHE", APACHE), ("LICENSE-MIT", "MIT, alpha's authors")]),
        component("beta", "Apache-2.0", [("LICENSE", "Apache License\n   Version 2.0,   January 2004\n")]),
        component("gamma", "MPL-2.0", [("LICENSE", "Mozilla Public License Version 2.0")],
                  repository="https://example.org/gamma"),
        component("delta", "MIT", kind="npm package", repository="https://example.org/delta"),
    ]


def test_the_document_lists_every_component_and_prints_a_shared_text_once():
    text = tpn.render("0.4.0", some_components())
    assert text.startswith("# Third-party notices\n\nThis file lists the third-party software that is part of "
                           "ILA Studio 0.4.0 ")
    assert "| alpha | Rust crate | 1.0.0 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/alpha/1.0.0), " \
           "[repository](https://example.org/alpha) | [1](#text-1), [2](#text-2) |" in text
    assert "| beta | Rust crate | 1.0.0 | Apache-2.0 |" in text and "| delta | npm package | 1.0.0 | MIT |" in text
    assert text.count("Apache License") == 1
    assert "### Text 1\n\nOf 2 components: alpha 1.0.0 (`LICENSE-APACHE`), beta 1.0.0 (`LICENSE`)\n\n```text\n" \
           + APACHE + "\n```\n" in text
    assert "Of 1 component: delta 1.0.0 (npm) (standard text of MIT)" in text
    assert text.endswith("```\n") and "\r" not in text


def test_the_document_says_where_the_source_of_mpl_code_is():
    text = tpn.render("0.4.0", some_components())
    section = text.split("## Components under the Mozilla Public License 2.0")[1].split("\n## ")[0]
    assert "- **gamma 1.0.0** (`MPL-2.0`): source code <https://crates.io/crates/gamma/1.0.0>, repository " \
           "<https://example.org/gamma>; licence text [" in section
    assert "alpha" not in section
    assert "Mozilla Public License 2.0\n" not in tpn.render("0.4.0", some_components()[:2])


def test_the_document_notes_the_packages_without_a_licence_file():
    section = tpn.render("0.4.0", some_components()).split("## Notes on single components")[1].split("\n## ")[0]
    assert "- **delta 1.0.0 (npm)** (`MIT`): No licence file in the package." in section
    assert "The standard text: [" in section and "alpha" not in section


def test_backticks_in_a_licence_text_do_not_end_its_block():
    block = tpn.fenced("see ```LICENSE``` and ````more````")
    assert block.startswith("`````text\n") and block.endswith("\n`````")
    assert tpn.fenced("plain").split("\n") == ["```text", "plain", "```"]


def test_a_folder_of_the_build_pc_is_found_whichever_way_it_is_written():
    folders = ["C:\\Users\\Somebody\\.cargo", "D:\\elsewhere\\project", "", "C:\\"]
    assert tpn.folders_named("built from c:/users/somebody/.cargo/registry/src", folders) == [folders[0]]
    assert tpn.folders_named("built from D:\\Elsewhere\\Project\\node_modules", folders) == [folders[1]]
    assert tpn.folders_named("https://crates.io/crates/alpha/1.0.0", folders) == []


# ---------------------------------------------------------------- the command
def test_a_refused_licence_stops_the_run_names_the_package_and_writes_nothing(monkeypatch, tmp_path, capsys):
    stopped = component("gamma", "LGPL-2.1-or-later", [("COPYING", "GNU Lesser General Public License")])
    monkeypatch.setattr(tpn, "collect", lambda root: ("0.4.0", some_components() + [stopped, component("eps", "")]))
    out = tmp_path / "notices.md"
    assert tpn.main(["--output", str(out)]) == 1
    assert not out.exists()
    err = capsys.readouterr().err
    assert "Licence gate: REFUSED" in err
    assert 'gamma 1.0.0 (Rust crate): licence "LGPL-2.1-or-later" - LGPL-2.1-or-later' in err
    assert 'eps 1.0.0 (Rust crate): licence "" - no licence is stated' in err


def test_check_runs_the_gate_and_writes_nothing(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(tpn, "collect", lambda root: ("0.4.0", some_components()))
    monkeypatch.chdir(tmp_path)
    assert tpn.main(["--check", "--output", str(tmp_path / "notices.md")]) == 0
    assert os.listdir(str(tmp_path)) == []
    out = capsys.readouterr().out
    assert "ILA Studio 0.4.0: 4 third-party components (3 Rust crates, " in out
    assert "MPL-2.0 (1): gamma 1.0.0" in out
    assert "No licence file in the package (1): delta 1.0.0 (npm)" in out
    assert "Licence gate: passed. 4 distinct licence texts." in out


def test_the_file_is_written_as_utf8_with_unix_line_ends(monkeypatch, tmp_path, capsys):
    named = component("alpha", "MIT", [("LICENSE", "Copyright (c) Zo\u00eb and the \u03b1 authors")])
    monkeypatch.setattr(tpn, "collect", lambda root: ("0.4.0", [named]))
    out = tmp_path / "notices.md"
    assert tpn.main(["--output", str(out)]) == 0
    data = out.read_bytes()
    assert b"\r" not in data and data.decode("utf-8") == tpn.render("0.4.0", [named])
    assert "Zo\u00eb and the \u03b1 authors" in data.decode("utf-8")
    assert "Written: " in capsys.readouterr().out


def test_what_cannot_be_listed_is_said_in_a_sentence(monkeypatch, tmp_path, capsys):
    def no_packages(root):
        raise tpn.Problem('node_modules/alpha is not installed: run "npm ci" first')
    monkeypatch.setattr(tpn, "collect", no_packages)
    assert tpn.main(["--output", str(tmp_path / "notices.md")]) == 2
    assert capsys.readouterr().err == 'third_party_notices: node_modules/alpha is not installed: run "npm ci" first\n'
    assert os.listdir(str(tmp_path)) == []


def test_a_moved_version_of_an_added_text_stops_the_run_with_exit_code_2(added, monkeypatch, tmp_path, capsys):
    moved = tpn.Component("Rust crate", "beta", "1.1.0", "BSD-3-Clause", "", "https://example.org/beta", [])
    monkeypatch.setattr(tpn, "rust_components", lambda folder: ("0.4.0", [moved]))
    monkeypatch.setattr(tpn, "npm_components", lambda root: [])
    out = tmp_path / "notices.md"
    for arguments in (["--check"], ["--output", str(out)]):
        assert tpn.main(arguments) == 2
        assert capsys.readouterr().err.startswith("third_party_notices: tools/licences/beta.txt was read for "
                                                  "beta 1.0.0, and the lock file now names version 1.1.0.")
    assert not out.exists()


def test_a_document_that_names_a_folder_of_this_pc_is_not_written(monkeypatch, tmp_path, capsys):
    leaking = component("alpha", "MIT", [("LICENSE", "generated in " + os.path.join(tpn.ROOT, "node_modules"))])
    monkeypatch.setattr(tpn, "collect", lambda root: ("0.4.0", [leaking]))
    assert tpn.main(["--output", str(tmp_path / "notices.md")]) == 2
    assert "the notices would name a folder of this PC" in capsys.readouterr().err
    assert os.listdir(str(tmp_path)) == []
