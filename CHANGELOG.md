# Changelog

All notable changes to ILA Studio are written down in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-10

First public release.

### Added

- Desktop application for Windows 10 and 11 that captures and analyses the data of Vivado ILA (Integrated
  Logic Analyzer) cores.
- Reading of Vivado probe files (`.ltx`) without Vivado: ILA cores, probe names and widths.
- Three capture modes: at once, on a trigger rule, and window after window until stopped.
- A hardware session that stays open between captures, with one or two Vivado processes ("Twin Turbo").
- Automatic JTAG clock by the debug hub clock of the design, and repair of a cable that Vivado can no longer
  connect to.
- Support for designs with several ILA cores, and a number format (unsigned, signed, hex) for each bus in the
  CSV.
- Waveform viewer, and a Signal Analysis view with stacked plots, cursors, measurements, phase and delay,
  FFT, comparison of up to eight captures and a pop-out window.
- Profiles that hold a whole set-up, saved from the GUI or written by hand.
- Command line `ila_capture.py`: `check`, `info`, `capture`, `watch`, `hook`, `convert`, `stats`, `summary`.
- Demo data for trying the interface without hardware.
- Optional crash reports through Sentry, off until switched on in the header: an error of the program is
  sent with user folders, the servers of network paths, the names of this PC and of its Windows user (from
  four characters on, where they stand as words of their own), and IPv4 and IPv6 addresses taken out of its
  text; other names in it, such as those of probes and files, are sent as they stand. The choice holds for
  one report server; a build from source has no report address.
- Release archives built by a GitHub workflow from the tag, with `THIRD-PARTY-NOTICES.md` and a SHA-256 sum.
