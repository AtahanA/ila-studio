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
commands on Windows (`.github/workflows/ci.yml`, which also names the Rust version it uses).

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

## Release checklist

1. Set the version. It lives in `package.json` and `package-lock.json`, which
   `npm version <new> --no-git-tag-version` changes together, and in `src-tauri/Cargo.toml` (the next cargo
   command carries it into `src-tauri/Cargo.lock`). `src-tauri/tauri.conf.json` has none: the application
   takes it from `Cargo.toml`.
2. Write the entry in `CHANGELOG.md` and put the date of the release into its heading (the entry of 0.4.0 reads
   "Unreleased" until then).
3. Run all the checks above.
4. Build from a clean clone of the tagged commit, so that nothing private can be in the folder: `npm ci`, then
   `.\make_distribute.ps1`.
5. Never publish a `distribute\` folder that has been used: it holds `ila_log.txt`, captures and saved
   profiles. The script names such leftovers; it does not delete them.
6. Start the built `distribute\ila-studio.exe` once: the page is styled, **Demo Data** works, **Browse** opens
   a file dialog. Check that the executable does not carry the user folder of the build PC (the script renames
   the cargo folder in the paths the crates leave in it); this must print 0:
   `python -c "import sys; print(open(sys.argv[1], 'rb').read().count(b'Users'))" distribute\ila-studio.exe`
7. The GPL requires that every binary comes with its complete corresponding source. Publish binaries only
   together with the tagged source of exactly that build, and keep `LICENSE` in the folder (the script copies
   it).
8. Before publishing binaries, write the notices of the third-party software into `THIRD-PARTY-NOTICES.md` in
   the root of the repository (the script copies that file when it exists). The Rust crates can be listed
   with a tool such as `cargo about`; `npm ls --omit=dev --all` lists the npm packages that are shipped.
9. Pack the folder and publish its SHA-256 sum with it. In PowerShell:
   `Compress-Archive -Path distribute\* -DestinationPath ila-studio-<version>-windows.zip`, then
   `Get-FileHash ila-studio-<version>-windows.zip -Algorithm SHA256`.
   Say in the release notes that the executable is not signed.
