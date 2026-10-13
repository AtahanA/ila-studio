# Contributing to ILA Studio

Bug reports, test reports from other Vivado versions and hardware, and pull requests are all welcome.

## Reporting a problem

Open an issue with the bug form. It asks for the versions (ILA Studio, Windows, Vivado), the cable and the
device family, the steps, and a piece of the log: the text of **View Error Log** / **View Output**, or the end
of `ila_log.txt` in the program folder.

**Take user names, paths, IP addresses and signal names out of everything you attach.** The log names all of
them. Never attach a probe file (`.ltx`), a capture, a whole `ila_log.txt` or a profile from a design that is
not yours to publish. For a vulnerability see [SECURITY.md](SECURITY.md).

## Setting up

You need Node.js (`^20.19.0 || ^22.13.0 || >=24` covers every tool), Rust 1.90 or newer with the MSVC build
tools, and Python 3.8 or newer with pytest 7 or newer. Vivado is only needed for hardware work.

```powershell
git clone https://github.com/AtahanA/ila-studio.git
cd ila-studio
npm ci
python -m pip install "pytest>=7"
npm run tauri dev
```

## Checks before a pull request

Run all of them from the root of the repository. None needs Vivado, a board or the network. CI runs the same
commands on Windows (`.github/workflows/ci.yml`, which also names the Rust version it uses): for every pull
request and for every push to `main`. A branch without a pull request is not checked by itself; start the
workflow for it by hand (**Actions**, **CI**, **Run workflow**) or open the pull request.

```powershell
npm run typecheck
npm run lint
npm test
npm run build
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test
cd ..
python -m pytest
```

What a clean run looks like today:

- `npm run lint`: 0 errors and 15 warnings, all `react-hooks/exhaustive-deps`. These dependency lists are short
  on purpose. Do not add errors or new warnings, and do not rewrite code to silence the existing ones.
- `npm test`, `cargo test` and `python -m pytest`: every test passes, and none is marked as an expected
  failure. If you find a defect you cannot fix in the same change, pin it with a test that states the wanted
  behaviour and mark it (`it.fails` in Vitest, `xfail(strict=True)` in pytest), so that whoever fixes it is
  told to remove the mark.
- Add `-B` (`python -B -m pytest`) to keep `__pycache__` folders out of the tree.

There is no formatter pass: `cargo fmt`, Prettier and the like are not part of the checks.

Tests live next to what they test: `src/**/*.test.ts` (Vitest), `tests/` (pytest), and the module `tests` at
the end of `src-tauri/src/lib.rs`.

## What cannot be tested without hardware

Everything that talks to Vivado, hw_server or xsct. The automated tests replace Vivado with a recorder, so
they prove what is sent, not what Vivado does with it. The code has only run with Vivado 2017.4, a Zynq-7000
and a SmartLynq cable.

Say in the pull request what you tested: the Vivado version, the cable and the device, or "no hardware". If
you change a command that is sent to Vivado or xsct, show the command before and after for ordinary input.

## Code style

- Comments say WHY, not what. Match the code around your change: its naming, its comment style.
- Small diffs. No drive-by reformatting, reordering or renaming. `.editorconfig` describes the formatting (LF
  line ends, UTF-8, 2 spaces; 4 spaces in `.py`, `.rs`, `.tcl`, `.ps1`, `.toml`).
- `ila_bridge.py` and `ila_capture.py` use the standard library only and must run on Python 3.8.
- New source files start with the two header lines the others have: the line
  `SPDX-License-Identifier: GPL-3.0-or-later` and the copyright line.
- React StrictMode is on in development, so effects run twice under `npm run tauri dev`.
- The page deliberately writes "latest value" refs during render and resets state in effects. The lint rules
  of the React Compiler are switched off for that reason (`eslint.config.js`).
- The content security policy is active only in a built application, not under `npm run tauri dev`. Try a
  change of the interface in a built application before you send it. Allowed: React `style={...}` props.
  Blocked: `style="..."` written as markup, `<style>` elements made at run time, inline event handlers,
  `eval`, any remote URL, and `fetch()` / `XMLHttpRequest` even to the page's own files (only the calls to
  the backend may connect), as well as `blob:` URLs.
- The page may call the application's own commands, the event API and the file-open dialog, nothing else
  (`src-tauri/capabilities/default.json`). A new Tauri plugin or another kind of dialog needs an entry there.
  `window.alert()` and `window.confirm()` do not work.
- The application icon is `src/assets/app-icon.svg`. The icons in `src-tauri/icons` are made from it with
  `npx tauri icon src/assets/app-icon.svg`; delete the folders `android` and `ios` it also writes.

## Keep private data out

Never commit a probe file, a capture, `ila_log.txt` or a profile from a proprietary design. `.gitignore`
keeps the usual ones out (`*.ltx`, `*.ila`, `captures/`, `ila_log.txt`, every profile except
the two shipped example profiles), but look at `git status` before you commit. Use invented names in examples, tests
and fixtures: `adc_data`, `rx_valid`, `frame_start`, `my-board`.

## Licence of contributions

ILA Studio is licensed under the GNU General Public License v3.0 or later (`GPL-3.0-or-later`). By sending a
contribution you agree that it is published under the same licence.

## Updating dependencies

Dependabot proposes updates once a month (`.github/dependabot.yml`). Three things do not move by themselves:

- An npm package of Tauri and its crate must be on the same major and minor version: `@tauri-apps/api` with
  `tauri`, `@tauri-apps/plugin-dialog` with `tauri-plugin-dialog`. Otherwise `tauri build` refuses to build,
  and none of the checks runs it: a release would stop after its tag was pushed. `python -m pytest` therefore
  compares the two lock files (`tests/test_dependency_pairs.py`) and fails when a pair is out of step.
  Dependabot raises the crates of Tauri in one pull request and does not propose a new minor version of the
  npm side: raise it yourself in that pull request, for example with `npm install @tauri-apps/api@~2.13.0`
  for a crate 2.13. A patch release of either side needs no partner.
- `sentry` and `ureq` come in one pull request: `src-tauri/src/crash_reports.rs` sets up the ureq client that
  sentry sends with, so the two must use the same major version of ureq.
- A licence text in `tools/licences/` was read for one version of its component. When an update moves that
  version, `python tools/third_party_notices.py --check` stops with exit code 2, in CI as well. Look at the
  new package: if it brings its licence file now, remove the entry from `ADDED_TEXTS` in
  `tools/third_party_notices.py` and the file; if not, compare the file with the place the entry names and
  put the new version into the entry.

## Release checklist

A release is the portable folder, packed as `ila-studio-<version>-windows-x64.zip`, and its SHA-256 sum, both
attached to the GitHub release of the tag `v<version>`. The archive is built by GitHub from the tag
(`.github/workflows/release.yml`), not on somebody's PC.

What you do:

1. Set the version. It lives in `package.json` and `package-lock.json`, which
   `npm version <new> --no-git-tag-version` changes together, and in `src-tauri/Cargo.toml`. The next cargo
   command (`cargo check` in `src-tauri`) carries it into `src-tauri/Cargo.lock`: commit that file too.
   `src-tauri/tauri.conf.json` has none: the application takes it from `Cargo.toml`.
2. Write the entry in `CHANGELOG.md` and put the date of the release into its heading, as in
   `## [0.4.0] - 2026-10-20` (the entry of 0.4.0 reads "Unreleased" until then). The entry becomes the text of
   the release.
3. Commit, push, and wait until CI has passed on that commit.
4. Tag the commit and push the tag: `git tag v<version>`, then `git push origin v<version>`.
5. The workflow **Release** starts by itself and ends with a **draft** release, which only people who may
   write to the repository can see. Look at it: read the text, download the archive, compare its SHA-256 sum
   (`Get-FileHash <file> -Algorithm SHA256`), unpack it and start `ila-studio.exe` once: the page is styled,
   **Demo Data** works, **Browse** opens a file dialog.
6. Press **Publish release**. Nothing is public before that. If the draft is wrong, delete it, fix the cause,
   and tag again; do not move a tag whose release has been published.

What the pipeline does for you. `release.yml` runs every check of CI again on the tagged commit and then
`make_release.ps1`, which stops at the first thing that is not as it should be:

- The tag fits the version, the version is the same in `Cargo.toml`, `Cargo.lock`, `package.json` and
  `package-lock.json`, and `CHANGELOG.md` has an entry for it whose heading no longer says "Unreleased".
- The work tree is the commit and nothing else.
- `tools/third_party_notices.py` writes `THIRD-PARTY-NOTICES.md`: every Rust crate and npm package inside the
  program with its version, its licence, where its source is, and the text of its licence files. For a
  package that brings none it prints the standard text of the licence (MIT, Apache-2.0, MPL-2.0) or the text
  that `tools/licences/` keeps for that version of the package. One text is still missing, that of
  Microsoft's WebView2 loader inside the crate `webview2-com-sys`: the notices only point to it. The same
  tool is the licence gate: a component without a licence, or with one that is not on its list of licences
  that may go into a GPL-3.0-or-later program, stops the release. `python tools/third_party_notices.py --check`
  asks the same question at any time, for instance after a dependency was updated; it needs cargo and
  `npm ci`, and nothing but the standard library of Python 3.8 or newer.
- `make_distribute.ps1 -OutDir` builds the executable and assembles the folder in a new place under
  `release\`. It never touches `distribute\`.
- The folder is looked at before it is packed: the program, the scripts, the licence, the notices and the two
  example profiles are there; `profiles\` holds nothing else; there is no `ila_log.txt`, no `captures\`, no
  `__pycache__`; the executable does not name a user folder of the machine it was built on (the build renames
  the cargo folder in the paths the crates leave in it) and carries the version of the release.
- The folder is packed, the SHA-256 sum is written next to the archive, and the text of the release is put
  together: the changelog entry, the sum, where the source is, and that the executable is not signed.
- A second job, the only one that may write to the repository, creates the draft release with the two files.

To rehearse a release without making one:

- On GitHub: **Actions**, **Release**, **Run workflow**. A manual run builds the same package from the branch
  you choose and keeps it as an artifact of the run. It creates no release.
- On your PC: `npm ci`, then `.\make_release.ps1` in a clean checkout, or `.\make_release.ps1 -AllowDirty`
  with changes that are not committed. Add `-Tag v<version>` to apply the checks of a tag as well. The result
  is in `release\`, which git ignores. The script publishes nothing.

The pipeline knows one secret, and it is optional: `ILA_SENTRY_DSN` (**Settings**, **Secrets and variables**,
**Actions**), the address that crash reports of a release build are sent to. It is compiled into the
executable by the build step, which is the only step that sees it. Without the secret the release is built
all the same and has no crash reporting, like a build from source. Never write the address into a tracked
file. `release.yml` has no `pull_request` trigger and must not get one: a pull request from a fork must not
reach the secret.

Two settings of the repository are worth switching on after the first push:

- A branch protection rule (or ruleset) for `main` that requires the checks of CI to pass before a merge:
  `Frontend (typecheck, lint, test, build)`, `Rust (clippy, test)`, `Python 3.8` and `Python 3.13`.
- **Private vulnerability reporting**, in the security settings of the repository. `SECURITY.md` sends people
  to **Report a vulnerability**, which only exists once this is on.

What no pipeline takes off your hands:

- Never publish a `distribute\` folder that has been used: it holds `ila_log.txt`, captures and saved
  profiles. `make_distribute.ps1` names such leftovers; it does not delete them. A release is the archive of
  the pipeline, or of `make_release.ps1` in a clean clone of the tag.
- The GPL requires that every binary comes with its complete corresponding source. Publish a binary only
  together with the tagged source of exactly that build, and keep `LICENSE` and `THIRD-PARTY-NOTICES.md` in
  the folder (the scripts put them there).
