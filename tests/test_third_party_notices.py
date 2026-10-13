# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""tools/third_party_notices.py, as far as it works without cargo and npm: the licence gate of a release (which
licence expressions may go into a GPL-3.0-or-later program), which crates count as linked, and how
THIRD-PARTY-NOTICES.md is laid out. The packages are made up here."""
import importlib.util
import itertools
import os

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


def test_a_document_that_names_a_folder_of_this_pc_is_not_written(monkeypatch, tmp_path, capsys):
    leaking = component("alpha", "MIT", [("LICENSE", "generated in " + os.path.join(tpn.ROOT, "node_modules"))])
    monkeypatch.setattr(tpn, "collect", lambda root: ("0.4.0", [leaking]))
    assert tpn.main(["--output", str(tmp_path / "notices.md")]) == 2
    assert "the notices would name a folder of this PC" in capsys.readouterr().err
    assert os.listdir(str(tmp_path)) == []
