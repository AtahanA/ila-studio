#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Writes THIRD-PARTY-NOTICES.md: the third-party software inside a release of ILA Studio.

A release is one executable. Inside it are the Rust crates it was linked from, the Rust standard library and the
npm packages the interface was bundled from. Their licences ask that their notices go wherever the program goes,
and ILA Studio can only be passed on under its own licence (GPL-3.0-or-later) if every one of theirs allows it.
So this tool
  - lists every such component with its version, its licence and where its source is,
  - prints the text of each licence file once, with the components it belongs to (for a package that brings
    none: the standard text of its licence, or the text that tools/licences/ keeps for that version of it),
  - and refuses a component whose licence is missing or not on the list below: the licence gate of a release.

  python tools/third_party_notices.py                  write THIRD-PARTY-NOTICES.md into the repository root
  python tools/third_party_notices.py --check          the gate and the summary only; nothing is written
  python tools/third_party_notices.py --output <file>  write somewhere else

Exit code: 0 all is well, 1 a licence was refused, 2 the list could not be made (no cargo, no "npm ci" yet, a
text of tools/licences/ that was read for another version of its component ...).

It needs what a build needs: cargo ("cargo metadata" fetches the crates Cargo.lock names) and the installed npm
packages. Standard library only, Python 3.8 or newer.
"""
import argparse
import collections
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# what a release is built for: a crate that is only used on another platform is not in the executable
TARGET = "x86_64-pc-windows-msvc"
# "tauri build" switches this feature of the tauri crate on (the page then comes out of the executable and not
# from a development server): whatever the feature brings along is in a release
BUILD_FEATURES = "tauri/custom-protocol"

# What may be inside a program that is passed on under GPL-3.0-or-later: the permissive licences, and the Mozilla
# Public License 2.0, which names the GPL as a licence its code may be combined with (its section 3.3).
# A licence that is not here is not thereby incompatible: nobody has looked at it yet. Read it before adding it.
ALLOWED = ("MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "Unicode-DFS-2016",
           "MPL-2.0", "CC0-1.0", "0BSD", "Unlicense", "BSL-1.0", "MIT-0", "CDLA-Permissive-2.0")
ALLOWED_EXCEPTIONS = ("LLVM-exception",)

# What a package holds besides its own code where its licence files do not say so. Found by reading the package;
# a new entry is a sentence that is true of every version the lock file may name.
REMARKS = {
    "webview2-com-sys": "The package holds Microsoft's WebView2 loader library (WebView2LoaderStatic.lib), which is "
                        "linked into the executable. The licence of that library comes with the WebView2 SDK: "
                        "<https://www.nuget.org/packages/Microsoft.Web.WebView2>.",
}

# Licence texts that are kept in tools/licences/, for what a package does not bring and no standard text can stand
# in for (a licence of the BSD kind has a copyright line and a name of its own). Each file is a copy of the file
# its entry names - copied, never written from memory - and it is true of the version it was read for. When the
# lock file names another version the tool stops (exit code 2), until somebody has looked at the new package -
# does it bring its licence now, is the file it was copied from still the same - and has changed the entry.
#   component: (version, file in tools/licences/, what the notices call the text, a sentence for the notes)
# What the notices call it must not begin like the name of a licence file (LICENCE_FILE): it is none of the
# package.
LICENCES = os.path.join(ROOT, "tools", "licences")
ADDED_TEXTS = {
    # LICENSE at the top of <https://github.com/dropbox/rust-alloc-no-stdlib>. The package is the folder
    # "alloc-stdlib" of that repository, which holds no licence file. Copied from the package alloc-no-stdlib
    # 3.0.0, which is the top of the same repository; the commit alloc-stdlib 0.3.0 was published from holds
    # the same file (git blob cd496ba7).
    "alloc-stdlib": ("0.3.0", "alloc-stdlib.txt", "the LICENSE file of its repository",
                     "The LICENSE file of that repository, of which the package is one folder, is printed in "
                     "its place."),
}

# the files of a package that are taken along, by the start of their name
LICENCE_FILE = re.compile(r"(licen[cs]e|copying|notice|unlicen[cs]e|copyright)", re.I)
# ... and those of them that are the licence in words. "LICENSE.spdx" is a list of fields that names the licence
# and the holder but not the terms; NOTICE and COPYRIGHT name holders.
LICENCE_TEXT = re.compile(r"(licen[cs]e|copying|unlicen[cs]e)(?!.*\.spdx$)", re.I)


class Problem(Exception):
    """The list cannot be made; the message says what to do about it."""


class Unreadable(ValueError):
    """A licence that is not written as an SPDX expression."""


# ---------------------------------------------------------------- the licence gate
def parse_licence(expression):
    """The tree of an SPDX expression: ("id", name, exception or None), ("AND", [parts]) or ("OR", [parts]).
    AND binds tighter than OR, as SPDX says."""
    # "MIT/Apache-2.0" is how older crates write "MIT OR Apache-2.0", and cargo still reads it that way
    words = re.findall(r"[()]|[^\s()]+", (expression or "").replace("/", " OR "))
    pos = 0

    def peek():
        return words[pos] if pos < len(words) else None

    def take():
        nonlocal pos
        pos += 1
        return words[pos - 1]

    def is_name(word):
        return word is not None and word not in ("(", ")") and word.upper() not in ("AND", "OR", "WITH")

    def atom():
        word = take() if peek() is not None else None
        if word == "(":
            inner = either()
            if peek() != ")":
                raise Unreadable(expression)
            take()
            return inner
        if not is_name(word):
            raise Unreadable(expression)
        exception = None
        if (peek() or "").upper() == "WITH":
            take()
            exception = take() if peek() is not None else None
            if not is_name(exception):
                raise Unreadable(expression)
        return ("id", word, exception)

    def chain(operator, part):
        parts = [part()]
        while (peek() or "").upper() == operator:
            take()
            parts.append(part())
        return parts[0] if len(parts) == 1 else (operator, parts)

    def both():
        return chain("AND", atom)

    def either():
        return chain("OR", both)

    tree = either()
    if peek() is not None:
        raise Unreadable(expression)
    return tree


def on_list(name, names):
    """SPDX identifiers are compared without regard to case."""
    return name.lower() in [n.lower() for n in names]


def refused_in(tree):
    if tree[0] == "id":
        name, exception = tree[1], tree[2]
        # "Apache-2.0+" (or any later version) is as welcome as the version itself
        fine = on_list(name.rstrip("+"), ALLOWED) and (exception is None or on_list(exception, ALLOWED_EXCEPTIONS))
        return [] if fine else [name if exception is None else "%s WITH %s" % (name, exception)]
    found = [refused_in(part) for part in tree[1]]
    # where the expression leaves a choice, one allowed alternative is enough: that is the one taken
    if tree[0] == "OR" and not all(found):
        return []
    return [name for names in found for name in names]


def refused(expression):
    """What stands in the way of a licence expression: [] when it is acceptable, otherwise the licences in it that
    are not on the allow-list (or a few words when there is no licence, or none that can be read)."""
    if not (expression or "").strip():
        return ["no licence is stated"]
    try:
        return refused_in(parse_licence(expression))
    except Unreadable:
        return ["not an SPDX licence expression"]


def licence_ids(expression):
    """The licences an expression names, in its order, each once and spelt as on the allow-list where it is on it;
    [] for an expression that cannot be read."""
    def walk(tree):
        return [tree[1].rstrip("+")] if tree[0] == "id" else [name for part in tree[1] for name in walk(part)]
    try:
        names = walk(parse_licence(expression))
    except Unreadable:
        return []
    spelt = {name.lower(): name for name in ALLOWED}
    names = [spelt.get(name.lower(), name) for name in names]
    return [name for n, name in enumerate(names) if name not in names[:n]]


# ---------------------------------------------------------------- licence texts
def tidy(text):
    """A licence file as it is printed here: its own words, with uniform line ends and no blanks at the ends of the
    lines (a form feed, as the GNU texts have between their pages, becomes a line break)."""
    text = text.replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n").expandtabs(8)
    return "\n".join(line.rstrip() for line in text.split("\n")).strip("\n")


def read_text(path):
    with open(path, "rb") as f:
        data = f.read()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:          # a few old licence files are Latin-1 (an author's name with an accent)
        return data.decode("latin-1")


def kept_text(file_name):
    """A licence text of tools/licences/ as it is printed here."""
    path = os.path.join(LICENCES, file_name)
    if not os.path.isfile(path):
        raise Problem("tools/licences/%s is not there, and ADDED_TEXTS in tools/third_party_notices.py names it"
                      % file_name)
    return tidy(read_text(path))


def licence_files(folder, named=None):
    """[(file name, text)] of the licence files in the top folder of a package, sorted by name. `named` is the
    file a Cargo.toml names with license-file, which need not have one of the usual names."""
    names = [n for n in os.listdir(folder) if LICENCE_FILE.match(n)]
    if named and os.path.basename(named) not in names:
        names.append(named)
    found = []
    for name in sorted(names, key=lambda n: (n.lower(), n)):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            text = tidy(read_text(path))
            if text:
                found.append((os.path.basename(name), text))
    return found


def group_texts(items):
    """items: (owner, file name, text) for every licence file. Returns [(text, [(owner, file name), ...]), ...]:
    each distinct text once, with everything it belongs to, the most widely shared texts first. Two texts are the
    same when they differ in nothing but line breaks and spacing: many packages hold the same Apache-2.0 text,
    each wrapped a little differently. (An MIT text stays apart from the next one: its copyright line differs.)"""
    groups = {}
    for owner, name, text in sorted(items):
        groups.setdefault(" ".join(text.split()), []).append((owner, name, text))
    ordered = sorted(groups.values(), key=lambda members: (-len(members), members[0]))
    return [(members[0][2], [(owner, name) for owner, name, _ in members]) for members in ordered]


# ---------------------------------------------------------------- components
class Component(object):
    """One third-party package: kind is "Rust crate", "Rust toolchain" or "npm package"; files is the list
    [(file name, text)] of its licence files; note is what the notices say about it in a sentence, if anything."""

    def __init__(self, kind, name, version, licence, source, repository, files):
        self.kind, self.name, self.version, self.licence = kind, name, version, licence or ""
        self.source, self.repository, self.files = source, repository, list(files)
        self.note = ""

    @property
    def label(self):
        # a crate and an npm package may share a name
        return "%s %s%s" % (self.name, self.version, " (npm)" if self.kind == "npm package" else "")

    @property
    def has_licence_text(self):
        return any(LICENCE_TEXT.match(name) for name, _ in self.files)


def complete(component):
    """A package that brings no licence file gets the standard text of its licence where one text is everybody's
    (STANDARD_TEXTS); for any other licence the notices can only point at the repository - unless its text was
    added by hand for exactly this version (ADDED_TEXTS). Sets component.note."""
    notes = []
    if not component.has_licence_text:
        ids = licence_ids(component.licence)
        given = [i for i in ids if i in STANDARD_TEXTS]
        rest = [i for i in ids if i not in STANDARD_TEXTS]
        where = "<%s>" % component.repository if component.repository else "the place it is published at"
        none = "No licence file in the package"
        if component.kind == "Rust toolchain":
            none = "It comes with the compiler and not as a package, so there is no licence file to read here"
        if given:
            component.files += [("standard text of %s" % i, STANDARD_TEXTS[i]) for i in given]
            notes.append("%s. The standard text of %s is printed in its place; for %s see %s."
                         % (none, " and ".join(given), " and ".join(rest + ["the copyright notice"]), where))
        else:
            notes.append("%s: see %s." % (none, where))
    if component.name in REMARKS:
        notes.append(REMARKS[component.name])
    if component.name in ADDED_TEXTS:
        version, file_name, called, sentence = ADDED_TEXTS[component.name]
        if component.version != version:
            raise Problem("tools/licences/%s was read for %s %s, and the lock file now names version %s. Look at "
                          "the new version - does the package bring its licence now, is the file it was copied "
                          "from still the same - and then change or remove its entry in ADDED_TEXTS "
                          "(tools/third_party_notices.py)" % (file_name, component.name, version, component.version))
        component.files.append((called, kept_text(file_name)))
        notes.append(sentence)
    component.note = " ".join(notes)
    return component


def repository_url(value):
    """An address a browser opens, from the "repository" of a Cargo.toml or a package.json."""
    if isinstance(value, dict):
        value = value.get("url")
    value = (value or "").strip() if isinstance(value, str) else ""
    short = re.match(r"^(?:github:)?([\w.-]+/[\w.-]+)$", value)         # npm's "user/repository"
    if short:
        value = "https://github.com/" + short.group(1)
    value = re.sub(r"^git\+", "", value)
    value = re.sub(r"^git://", "https://", value)
    value = re.sub(r"^(?:ssh://)?git@([^:/]+)[:/]", r"https://\1/", value)
    return re.sub(r"\.git$", "", value)


def run(command, cwd):
    """What a build tool prints; when it fails, its own words are passed on."""
    try:
        done = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        raise Problem("%s cannot be started (%s)" % (command[0], e))
    if done.returncode != 0:
        raise Problem("\"%s\" failed:\n%s" % (" ".join(command), done.stderr.decode("utf-8", "replace").strip()))
    return done.stdout.decode("utf-8", "replace")


def linked_packages(meta):
    """(the application, [the packages it is linked from]) out of the answer of "cargo metadata": everything the
    application reaches over normal dependencies. A build script and what it uses (kind "build") and what only
    the tests use (kind "dev") are not in the executable.
    That is a little more than is linked, on purpose. cargo metadata reports the optional dependencies of all
    uses of a crate together, also those only a build script asks for, so a few crates are named that this build
    leaves out and "cargo tree -e normal" does not show; and procedural macros are followed like any other crate
    although they only work while the program is built. Naming a crate too many does no harm, leaving one out
    would."""
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"].get("root")
    if root is None:
        raise Problem("cargo metadata names no root package")
    seen, todo = set(), [root]
    while todo:
        package = todo.pop()
        if package in seen:
            continue
        seen.add(package)
        for dep in nodes[package]["deps"]:
            if any(kind.get("kind") is None for kind in dep["dep_kinds"]):
                todo.append(dep["pkg"])
    linked = sorted((packages[i] for i in seen if i != root), key=lambda p: (p["name"].lower(), p["version"]))
    return packages[root], linked


def crate_source(package):
    source = package.get("source") or ""
    if source.startswith("registry+https://github.com/rust-lang/crates.io-index"):
        return "https://crates.io/crates/%s/%s" % (package["name"], package["version"])
    # a crate taken from a git repository names it; one in a folder of this repository has nothing to name
    return re.sub(r"^git\+", "", source)


def rust_components(folder):
    """(version of the application, the crates in the executable and the standard library they are built on)."""
    meta = json.loads(run(["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET,
                           "--features", BUILD_FEATURES], folder))
    app, linked = linked_packages(meta)
    components = [Component("Rust crate", p["name"], p["version"], p.get("license"), crate_source(p),
                            repository_url(p.get("repository")),
                            licence_files(os.path.dirname(p["manifest_path"]), p.get("license_file")))
                  for p in linked]
    # The standard library is in every Rust program, and it is no package of cargo: no licence file to read.
    words = run(["rustc", "--version"], folder).split()                 # "rustc 1.92.0 (ded5c06cf 2025-12-08)"
    if len(words) < 2:
        raise Problem("\"rustc --version\" does not name a version")
    release = re.match(r"\d+\.\d+\.\d+$", words[1])
    components.append(Component(
        "Rust toolchain", "Rust standard library", words[1], "MIT OR Apache-2.0",
        "https://github.com/rust-lang/rust" + ("/tree/" + words[1] if release else ""),
        "https://github.com/rust-lang/rust", []))
    return app["version"], components


def npm_licence(manifest):
    """The licence a package.json states: an SPDX expression, or one of the older forms
    {"type": "MIT"} and "licenses": [{"type": "MIT"}, ...]. "" when it states none."""
    value = manifest.get("license") or manifest.get("licenses") or ""
    if isinstance(value, dict):
        value = value.get("type") or ""
    if isinstance(value, list):
        value = " OR ".join((v.get("type") or "") if isinstance(v, dict) else str(v) for v in value)
    return value if isinstance(value, str) else ""


def npm_components(root):
    """The packages that are bundled into the interface: every entry of package-lock.json that is not marked as a
    development dependency, which is what "npm ls --omit=dev --all" lists."""
    with open(os.path.join(root, "package-lock.json"), encoding="utf-8") as f:
        lock = json.load(f)
    if "packages" not in lock:
        raise Problem("package-lock.json has no \"packages\": it must be written by npm 7 or newer")
    components = []
    for key in sorted(lock["packages"]):
        entry = lock["packages"][key]
        # "" is the application itself, and a link is a folder of this repository
        if "node_modules/" not in key or entry.get("dev") or entry.get("link"):
            continue
        name = key.rsplit("node_modules/", 1)[1]
        folder = os.path.join(root, *key.split("/"))
        if not os.path.isfile(os.path.join(folder, "package.json")):
            if entry.get("optional"):       # a package for another platform, which npm does not install here
                continue
            raise Problem("%s is not installed: run \"npm ci\" first" % key)
        with open(os.path.join(folder, "package.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        if manifest.get("version") != entry.get("version"):
            raise Problem("%s is version %s, package-lock.json says %s: run \"npm ci\" first"
                          % (key, manifest.get("version"), entry.get("version")))
        components.append(Component("npm package", name, entry["version"], npm_licence(manifest) or npm_licence(entry),
                                    "https://www.npmjs.com/package/%s/v/%s" % (name, entry["version"]),
                                    repository_url(manifest.get("repository")), licence_files(folder)))
    return components


def collect(root):
    """(version of the application, every third-party component of a release): crates, toolchain, npm packages."""
    version, components = rust_components(os.path.join(root, "src-tauri"))
    components += npm_components(root)
    return version, [complete(c) for c in components]


# ---------------------------------------------------------------- the document
def cell(text):
    return text.replace("|", "\\|")


def fenced(text):
    """The text as a code block whose fence is longer than any row of backticks inside it."""
    longest = max([len(ticks) for ticks in re.findall(r"`+", text)] or [0])
    fence = "`" * max(3, longest + 1)
    return "%stext\n%s\n%s" % (fence, text, fence)


def render(version, components):
    """THIRD-PARTY-NOTICES.md as one string. Nothing in it depends on the day or the PC it is written on."""
    texts = group_texts([(c.label, name, text) for c in components for name, text in c.files])
    number = {member: n for n, (_, members) in enumerate(texts, 1) for member in members}

    def refs(component, wanted=lambda name: True):
        numbers = sorted({number[(component.label, name)] for name, _ in component.files if wanted(name)})
        return ", ".join("[%d](#text-%d)" % (n, n) for n in numbers)

    def sources(component):
        where = ("crates.io" if component.source.startswith("https://crates.io/") else
                 "npm" if component.source.startswith("https://www.npmjs.com/") else "source")
        links = ["[%s](%s)" % (where, component.source)] if component.source else []
        if component.repository and component.repository != component.source:
            links.append("[repository](%s)" % component.repository)
        return ", ".join(links)

    kinds = collections.Counter(c.kind for c in components)
    out = [
        "# Third-party notices",
        "",
        "This file lists the third-party software that is part of ILA Studio %s as it is released - the Rust crates "
        "and the Rust standard library linked into `ila-studio.exe`, and the npm packages bundled into its interface "
        "- with the version, the licence and the source of each, and the text of every licence file they come with."
        % version,
        "",
        "ILA Studio itself is licensed under GPL-3.0-or-later (see `LICENSE`). This file is written by "
        "`tools/third_party_notices.py` from `src-tauri/Cargo.lock` and `package-lock.json`: do not edit it by hand. "
        "The list errs on the side of naming too much: it also holds crates that only work while the program is "
        "built (procedural macros and what they use), optional crates that this build leaves out, and npm packages "
        "that only hold type declarations.",
        "",
        "## Components",
        "",
        "%d components: %d Rust crates, the Rust standard library, %d npm packages. The numbers in the last column "
        "lead to the licence texts at the end of this file."
        % (len(components), kinds["Rust crate"], kinds["npm package"]),
        "",
        "| Component | Kind | Version | Licence | Source | Licence texts |",
        "|---|---|---|---|---|---|",
    ]
    for c in components:
        out.append("| %s | %s | %s | %s | %s | %s |" % (cell(c.name), c.kind, cell(c.version), cell(c.licence),
                                                      sources(c), refs(c)))

    mpl = [c for c in components if on_list("MPL-2.0", licence_ids(c.licence))]
    if mpl:
        out += [
            "",
            "## Components under the Mozilla Public License 2.0",
            "",
            "The Mozilla Public License 2.0 (<https://mozilla.org/MPL/2.0/>) asks whoever passes on a program that "
            "contains such code to say where the source code of that code is. It is here, for exactly the versions "
            "that are in the program:",
            "",
        ]
        for c in mpl:
            text = refs(c, lambda name: LICENCE_TEXT.match(name) or name == "standard text of MPL-2.0")
            out.append("- **%s** (`%s`): source code %s%s%s" % (
                c.label, c.licence, "<%s>" % c.source if c.source else "in its repository",
                ", repository <%s>" % c.repository if c.repository else "",
                "; licence text %s" % text if text else ""))

    noted = [c for c in components if c.note]
    if noted:
        out += ["", "## Notes on single components", ""]
        for c in noted:
            standard = refs(c, lambda name: name.startswith("standard text of "))
            added = refs(c, lambda name: not LICENCE_FILE.match(name) and not name.startswith("standard text of "))
            out.append("- **%s** (`%s`): %s%s%s" % (c.label, c.licence, c.note,
                                                  " The standard text: %s." % standard if standard else "",
                                                  " The added text: %s." % added if added else ""))

    out += ["", "## Licence texts"]
    for n, (text, members) in enumerate(texts, 1):
        owners = len({owner for owner, _ in members})
        out += ["", "### Text %d" % n, "",
                "Of %s: %s" % ("1 component" if owners == 1 else "%d components" % owners,
                               ", ".join("%s (%s)" % (owner, "`%s`" % name if LICENCE_FILE.match(name) else name)
                                         for owner, name in members)),
                "", fenced(text)]
    return "\n".join(out) + "\n"


def folders_named(text, folders):
    """Those of the folders (of this PC) that a text names, whichever way the slashes point."""
    flat = text.replace("\\", "/").lower()
    return [f for f in folders if f and len(f) > 3 and f.replace("\\", "/").rstrip("/").lower() in flat]


def say(text, stream=None):
    """Print, whatever the console can show: a component is named by its author, not by this tool."""
    stream = stream or sys.stdout
    encoding = getattr(stream, "encoding", None) or "ascii"
    stream.write(text.encode(encoding, "backslashreplace").decode(encoding) + "\n")


def summary(version, components):
    kinds = collections.Counter(c.kind for c in components)
    std = [c.version for c in components if c.kind == "Rust toolchain"]
    lines = ["ILA Studio %s: %d third-party components (%d Rust crates, the Rust standard library%s, %d npm packages)"
             % (version, len(components), kinds["Rust crate"], " " + std[0] if std else "", kinds["npm package"]),
             "Licences as the components state them:"]
    stated = collections.Counter(c.licence or "(none)" for c in components)
    lines += ["  %4d  %s" % (count, licence) for licence, count in sorted(stated.items(), key=lambda i: (-i[1], i[0]))]
    mpl = [c.label for c in components if on_list("MPL-2.0", licence_ids(c.licence))]
    lines.append("MPL-2.0 (%d): %s" % (len(mpl), ", ".join(mpl) or "none"))
    bare = [c.label for c in components if not c.has_licence_text]
    lines.append("No licence file in the package (%d): %s" % (len(bare), ", ".join(bare) or "none"))
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write THIRD-PARTY-NOTICES.md: the third-party software inside a "
                                                 "release, its licences and their texts.")
    parser.add_argument("--output", default=os.path.join(ROOT, "THIRD-PARTY-NOTICES.md"), metavar="FILE",
                        help="the file to write (default: THIRD-PARTY-NOTICES.md in the repository root)")
    parser.add_argument("--check", action="store_true",
                        help="check the licences and print the summary; write nothing")
    args = parser.parse_args(argv)
    try:
        version, components = collect(ROOT)
        for line in summary(version, components):
            say(line)
        stopped = [(c, refused(c.licence)) for c in components if refused(c.licence)]
        if stopped:
            say("Licence gate: REFUSED. Not on the list of licences that may go into a GPL-3.0-or-later program "
                "(ALLOWED in tools/third_party_notices.py):", sys.stderr)
            for c, why in stopped:
                say("  %s (%s): licence \"%s\" - %s" % (c.label, c.kind, c.licence, ", ".join(why)), sys.stderr)
            return 1
        document = render(version, components)
        # the registry of cargo and node_modules are in the user folder; none of that may get into a release
        home = os.path.expanduser("~")
        named = folders_named(document, [home, os.environ.get("CARGO_HOME") or os.path.join(home, ".cargo"), ROOT])
        if named:
            raise Problem("the notices would name a folder of this PC (%s)" % ", ".join(named))
    except Problem as e:
        say("third_party_notices: %s" % e, sys.stderr)
        return 2
    say("Licence gate: passed. %d distinct licence texts." % document.count("\n### Text "))
    if not args.check:
        with open(args.output, "w", encoding="utf-8", newline="\n") as f:
            f.write(document)
        say("Written: %s (%d bytes)" % (args.output, len(document.encode("utf-8"))))
    return 0


# The texts of the three licences that are the same words for everybody (the MIT text but for its copyright line,
# which is left as the form it is). They stand in for the licence file a package did not bring: see complete().
# The MPL-2.0 text is the LICENSE file of the crates cssparser 0.37.0 and dtoa-short 0.3.5, so that it is printed
# once for them and for a package without it.
STANDARD_TEXTS = {
    "MIT": """\
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.""",
    "Apache-2.0": """\
                              Apache License
                        Version 2.0, January 2004
                     http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

   "License" shall mean the terms and conditions for use, reproduction,
   and distribution as defined by Sections 1 through 9 of this document.

   "Licensor" shall mean the copyright owner or entity authorized by
   the copyright owner that is granting the License.

   "Legal Entity" shall mean the union of the acting entity and all
   other entities that control, are controlled by, or are under common
   control with that entity. For the purposes of this definition,
   "control" means (i) the power, direct or indirect, to cause the
   direction or management of such entity, whether by contract or
   otherwise, or (ii) ownership of fifty percent (50%) or more of the
   outstanding shares, or (iii) beneficial ownership of such entity.

   "You" (or "Your") shall mean an individual or Legal Entity
   exercising permissions granted by this License.

   "Source" form shall mean the preferred form for making modifications,
   including but not limited to software source code, documentation
   source, and configuration files.

   "Object" form shall mean any form resulting from mechanical
   transformation or translation of a Source form, including but
   not limited to compiled object code, generated documentation,
   and conversions to other media types.

   "Work" shall mean the work of authorship, whether in Source or
   Object form, made available under the License, as indicated by a
   copyright notice that is included in or attached to the work
   (an example is provided in the Appendix below).

   "Derivative Works" shall mean any work, whether in Source or Object
   form, that is based on (or derived from) the Work and for which the
   editorial revisions, annotations, elaborations, or other modifications
   represent, as a whole, an original work of authorship. For the purposes
   of this License, Derivative Works shall not include works that remain
   separable from, or merely link (or bind by name) to the interfaces of,
   the Work and Derivative Works thereof.

   "Contribution" shall mean any work of authorship, including
   the original version of the Work and any modifications or additions
   to that Work or Derivative Works thereof, that is intentionally
   submitted to Licensor for inclusion in the Work by the copyright owner
   or by an individual or Legal Entity authorized to submit on behalf of
   the copyright owner. For the purposes of this definition, "submitted"
   means any form of electronic, verbal, or written communication sent
   to the Licensor or its representatives, including but not limited to
   communication on electronic mailing lists, source code control systems,
   and issue tracking systems that are managed by, or on behalf of, the
   Licensor for the purpose of discussing and improving the Work, but
   excluding communication that is conspicuously marked or otherwise
   designated in writing by the copyright owner as "Not a Contribution."

   "Contributor" shall mean Licensor and any individual or Legal Entity
   on behalf of whom a Contribution has been received by Licensor and
   subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of
   this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   copyright license to reproduce, prepare Derivative Works of,
   publicly display, publicly perform, sublicense, and distribute the
   Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of
   this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   (except as stated in this section) patent license to make, have made,
   use, offer to sell, sell, import, and otherwise transfer the Work,
   where such license applies only to those patent claims licensable
   by such Contributor that are necessarily infringed by their
   Contribution(s) alone or by combination of their Contribution(s)
   with the Work to which such Contribution(s) was submitted. If You
   institute patent litigation against any entity (including a
   cross-claim or counterclaim in a lawsuit) alleging that the Work
   or a Contribution incorporated within the Work constitutes direct
   or contributory patent infringement, then any patent licenses
   granted to You under this License for that Work shall terminate
   as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the
   Work or Derivative Works thereof in any medium, with or without
   modifications, and in Source or Object form, provided that You
   meet the following conditions:

   (a) You must give any other recipients of the Work or
       Derivative Works a copy of this License; and

   (b) You must cause any modified files to carry prominent notices
       stating that You changed the files; and

   (c) You must retain, in the Source form of any Derivative Works
       that You distribute, all copyright, patent, trademark, and
       attribution notices from the Source form of the Work,
       excluding those notices that do not pertain to any part of
       the Derivative Works; and

   (d) If the Work includes a "NOTICE" text file as part of its
       distribution, then any Derivative Works that You distribute must
       include a readable copy of the attribution notices contained
       within such NOTICE file, excluding those notices that do not
       pertain to any part of the Derivative Works, in at least one
       of the following places: within a NOTICE text file distributed
       as part of the Derivative Works; within the Source form or
       documentation, if provided along with the Derivative Works; or,
       within a display generated by the Derivative Works, if and
       wherever such third-party notices normally appear. The contents
       of the NOTICE file are for informational purposes only and
       do not modify the License. You may add Your own attribution
       notices within Derivative Works that You distribute, alongside
       or as an addendum to the NOTICE text from the Work, provided
       that such additional attribution notices cannot be construed
       as modifying the License.

   You may add Your own copyright statement to Your modifications and
   may provide additional or different license terms and conditions
   for use, reproduction, or distribution of Your modifications, or
   for any such Derivative Works as a whole, provided Your use,
   reproduction, and distribution of the Work otherwise complies with
   the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise,
   any Contribution intentionally submitted for inclusion in the Work
   by You to the Licensor shall be under the terms and conditions of
   this License, without any additional terms or conditions.
   Notwithstanding the above, nothing herein shall supersede or modify
   the terms of any separate license agreement you may have executed
   with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade
   names, trademarks, service marks, or product names of the Licensor,
   except as required for reasonable and customary use in describing the
   origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or
   agreed to in writing, Licensor provides the Work (and each
   Contributor provides its Contributions) on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
   implied, including, without limitation, any warranties or conditions
   of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
   PARTICULAR PURPOSE. You are solely responsible for determining the
   appropriateness of using or redistributing the Work and assume any
   risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory,
   whether in tort (including negligence), contract, or otherwise,
   unless required by applicable law (such as deliberate and grossly
   negligent acts) or agreed to in writing, shall any Contributor be
   liable to You for damages, including any direct, indirect, special,
   incidental, or consequential damages of any character arising as a
   result of this License or out of the use or inability to use the
   Work (including but not limited to damages for loss of goodwill,
   work stoppage, computer failure or malfunction, or any and all
   other commercial damages or losses), even if such Contributor
   has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing
   the Work or Derivative Works thereof, You may choose to offer,
   and charge a fee for, acceptance of support, warranty, indemnity,
   or other liability obligations and/or rights consistent with this
   License. However, in accepting such obligations, You may act only
   on Your own behalf and on Your sole responsibility, not on behalf
   of any other Contributor, and only if You agree to indemnify,
   defend, and hold each Contributor harmless for any liability
   incurred by, or claims asserted against, such Contributor by reason
   of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

   To apply the Apache License to your work, attach the following
   boilerplate notice, with the fields enclosed by brackets "[]"
   replaced with your own identifying information. (Don't include
   the brackets!)  The text should be enclosed in the appropriate
   comment syntax for the file format. We also recommend that a
   file or class name and description of purpose be included on the
   same "printed page" as the copyright notice for easier
   identification within third-party archives.

Copyright [yyyy] [name of copyright owner]

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.""",
    "MPL-2.0": """\
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.""",
}


if __name__ == "__main__":
    sys.exit(main())
