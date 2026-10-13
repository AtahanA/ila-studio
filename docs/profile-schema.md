# Profile reference

A profile is a JSON file that holds everything that belongs to one board or one debug set-up: where the tools
are, which hw_server and probe file to use, how to capture and, for the command line, the software hook and
the statistics. The capture script `ila_capture.py` reads one with `--profile <file>`. The GUI lists the
profiles of the folder `profiles\` next to the program and writes its own there with **Save**.

Two examples are shipped:

- [`profiles/example-basic.json`](../profiles/example-basic.json): the smallest useful profile.
- [`profiles/example-hook-uart.json`](../profiles/example-hook-uart.json): a worked example of the `hook`
  command and the statistics section, for an invented design.

Contents:

- [A profile is trusted like a script](#a-profile-is-trusted-like-a-script)
- [How a profile is read](#how-a-profile-is-read)
- [Top level](#top-level)
- [`tools`](#tools)
- [`hardware`](#hardware)
- [`capture`](#capture)
- [`hook`](#hook)
- [`stats`](#stats)
- [`gui`](#gui)
- [What the GUI takes from a profile](#what-the-gui-takes-from-a-profile)
- [Relative paths](#relative-paths)
- [Checking a profile](#checking-a-profile)

## A profile is trusted like a script

A profile names programs that are started (`tools.vivado`, `tools.xsct`, `tools.nm`, `tools.objdump`) and a Tcl
script that Vivado runs (`tools.tcl_script`). Whoever uses a profile runs what it names. **Only use profiles
that you would also run as a script**, and read a profile that somebody else wrote before you select it.

The other values of a profile are data. The address, the paths, the filters and the trigger are passed to
Vivado as text; text that is no hw_server address, an unknown `radix`, `capture_mode` or `format`, and a
`position` or `timeout_min` that is not a number a capture can use, are refused before Vivado is started. See
[SECURITY.md](../SECURITY.md).

## How a profile is read

- The file is UTF-8 and holds one JSON object. A file that holds anything else (a list, a text), or that gives
  one of the sections `tools`, `hardware`, `capture`, `hook` or `stats` anything but an object, is refused:
  the command line and a job of the GUI answer with one sentence that names the file and what is wrong, for
  example `"capture" must be a JSON object, { ... }`.
- Every key is optional. A profile is laid over the built-in defaults (`DEFAULT_PROFILE` in `ila_capture.py`)
  section by section, so it only states what differs. Inside a section single keys are replaced; a list
  (`hook.fields`, `stats.ctrl_probes` ...) is replaced as a whole.
- Keys that the tool does not know are ignored. That is what the `_comment` keys of the examples rely on. A
  section that the GUI does not know is kept when the GUI saves on top of the profile.
- JSON has no hexadecimal numbers: `hook.magic` and `hook.end_value` may be written as text, e.g. `"0xFFFF"`.
- A backslash in a Windows path is written twice: `"C:\\work\\top.ltx"`. Forward slashes work as well.
- Options on the command line win over the profile (`--ltx`, `--server`, `--device`, `--ila-index`,
  `--jtag-hz`, `--out`, `--trigger`, `--position`, `--format`). The GUI works the same way: it sends its own
  fields with every job, see [What the GUI takes from a profile](#what-the-gui-takes-from-a-profile).

"Script" in the tables below means `ila_capture.py`, on the command line and inside the GUI, whose backend
uses the same code to connect and to capture. "Page" means the capture tab of the GUI.

## Top level

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | text | `"default"` | The name of the profile. The GUI shows it in the Profile list as `name (file name)`; a profile without a name is called after its file. `check` prints it. |
| `_comment` | text | none | A note for the reader of the file. A profile saved from the page gets `Saved from ILA Studio on <date>.` or `Saved from ILA Studio on <date>, starting from the profile "<name>".` The page rewrites only a note of exactly that form when the profile is saved again under its name; a note written by hand is kept. |

## `tools`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `vivado` | path | `C:\Xilinx\Vivado\2017.4\bin\vivado.bat` | The Vivado (or Vivado Lab Edition) that is started for every hardware command. If this file does not exist, Vivado is searched for: `vivado` or `vivado_lab` on `PATH`; then `%XILINX_VIVADO%\bin`, and `Xilinx\Vivado\<version>\bin` and `Xilinx\Vivado_Lab\<version>\bin` on `C:`, `D:` and `E:` (also `Xilinx\<version>\Vivado\bin` and `AMDDesignTools\<version>\Vivado\bin`, the order of newer installers), of which the highest version is taken. Read by the script. |
| `xsct` | path | `C:\Xilinx\SDK\2019.1\bin\xsct.bat` | The xsct that watches the CPU. Used by the `hook` command only, and exactly as written: there is no search. |
| `nm` | path | `C:\Xilinx\SDK\2019.1\gnu\aarch32\nt\gcc-arm-none-eabi\bin\arm-none-eabi-nm.exe` | Reads the address and size of the hook symbols from the ELF file. `hook`, and `check --elf`. No search. |
| `objdump` | path | `C:\Xilinx\SDK\2019.1\gnu\aarch32\nt\gcc-arm-none-eabi\bin\arm-none-eabi-objdump.exe` | Finds the places where the hook function is called. `hook`, and `check --elf`. No search. |
| `tcl_script` | path | none | A Tcl script of your own in place of `scripts\vivado_ila_repl.tcl`. Read by the GUI only: the page shows it in the field "Vivado Tcl Script (.tcl)", and a job that names no script (the field is empty) uses the one of the selected profile. If that file does not exist, the bundled script is used and the job says so, in its answer and in the log. A script that the field itself names and that does not exist ends the job: `Tcl script not found: <path>`. On the command line of `ila_capture.py` the option `--tcl` names the script, with the same error for a file that does not exist; the key is not read there. |

The defaults are the folders that Vivado 2017.4 and the SDK 2019.1 install into. They are only defaults: a
profile for the `hook` command states `xsct`, `nm` and `objdump` of its own installation (SDK or Vitis).

## `hardware`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `url` | text | `"127.0.0.1:3121"` | The hw_server, as `host:port`. Vivado and xsct both connect to it. |
| `ltx` | path | `""` | The probe file (`.ltx`) that the implementation run wrote for the bitstream on the board. Required: without it the probes have no names. |
| `device_filter` | glob | `"*"` | The device on the JTAG chain. With `*` the chain is searched for the device that carries the ILA (the ARM debug port of a Zynq is skipped). A glob such as `xc7z020*` pins it. |
| `target_filter` | glob | `"*"` | The JTAG target, for a hw_server with several cables, e.g. `*<cable serial>*`. The first target that matches is used. There is no field for it in the GUI and no command-line option. |
| `jtag_frequency_hz` | integer | `0` | The JTAG clock (TCK) in Hz. `0` is automatic: the cable's own frequency, lowered only when it is above debug hub clock / 2.5 (the hub clock is read from the probe file; where the file does not name it, nothing is lowered and the session says so). Any other value is used as given, snapped down to a frequency the cable offers. |
| `ila_index` | integer | `0` | Which ILA core of the device is captured, by its position in the device's list (the `info` command prints the list). |
| `ila_cell` | text | none | The ILA core by its cell name, as the probe file names it. It wins over `ila_index`. The GUI sends the cell name of the selected core with its jobs and does not store this key in a saved profile (the name of the core is kept in `gui.core`). |
| `core_filter` | text | `""` | The xsct target that runs the firmware, for the `hook` command. Empty means core 0 of a Zynq-7000: `name =~ "*Cortex-A9*#0*"`. |

Forms of `url` that are accepted, by the GUI and by the command line alike (also for `--server`): a host name
or an IPv4 address, with or without `:port`; an IPv6 address in brackets, with or without `:port`; a bare IPv6
address; each may begin with `TCP:`. Port 3121 is added when none is given. Anything else is refused before
Vivado or xsct is started, and `check` reports it.

## `capture`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `trigger` | text | `"now"` | `"now"` (capture at once) or `"<probe> <compare-value>"`, e.g. `"frame_start eq1'bR"`. See below. |
| `position` | integer | `1000` | Samples kept before the trigger: a whole number, 0 or more. Anything else is refused. |
| `timeout_min` | number | `1` | Minutes to wait for the trigger: a number above 0, with or without a fraction (`0.5`). Anything else is refused. The longest wait is 71572 minutes (about 49 days) on Windows. |
| `format` | text | `"both"` | What is written for each capture: `both`, `ila` or `csv` (any letter case). Anything else is refused. The `watch` command uses the key only when the profile states it, and writes `csv` when it does not: writing the `.ila` as well would slow every recording down. `--format` wins in every command. |
| `sample_period_ns` | number | `0` | The period of the ILA clock in ns. `0` means unknown: times are then given in samples. |
| `radix` | text | `"UNSIGNED"` | How Vivado is asked to write every multi-bit probe: `UNSIGNED`, `SIGNED` or `HEX` (any letter case; sent to Vivado in capitals). Anything else is refused. Not used by captures from the GUI. |
| `probe_format` | object | `{}` | How single probes are written into the CSV where that differs from `radix`: `{"adc_data": "signed", "top/u1/status": "hex"}`. The key is a net name with or without its hierarchy; the value is `unsigned`, `signed` or `hex`. |
| `capture_mode` | text | `"ALWAYS"` | `ALWAYS`, or `BASIC` for a core that was built with capture control. Anything else is refused. |
| `out` | path | `captures` in the current directory | The folder that the session folders are written into. Each run makes one session folder, `<out>\<date>_<time>_<target>\`, which holds the captures, `index.csv` and `session.log`. |

`position` and `timeout_min` are JSON numbers. Text is refused, also text that holds a number (`"2"`): write
`2`. A key that is left out, or `null`, takes its default.

**Trigger.** The probe is named by its full hierarchical name, by its leaf name, or by the end of the full name
from a `/` on (`b/valid` for `a/b/valid`). The name must fit exactly one probe of the selected ILA core. The
compare value is Vivado's: `eq1'bR` (rising edge), `eq1'bF`, `eq1'b1`, `eq1'b0`, `eq1'bB` (either edge),
`eq4'h3`, `eq14'u100` (unsigned decimal), `eq4'b0101`. A hex or binary value that is shorter than the probe is
padded with zeros on the left. Braces in a trigger must pair up.

**Formats.** `unsigned` is the plain number (16354). `signed` is the two's complement of the probe width (-30
for a 14-bit bus), written by Vivado itself. `hex` is written by this tool after the capture, with `0x` and
every digit of the width (`0x3FE2`). The `.ila` archive is never rewritten. `radix` `HEX` is of little use:
`capture`, `hook` and `watch` rewrite the hex columns that Vivado wrote to unsigned decimal in the CSV. Use
`probe_format` for hex columns.

## `hook`

Only the `hook` command of `ila_capture.py` reads this section (and `check`, which verifies it). The idea: the
firmware on the CPU of the board says when a capture is due. It fills a small variable with what it is doing,
then calls an empty function. A breakpoint on that function halts the CPU; the script reads the variable over
JTAG, takes or collects a capture, names the file after what it read, and lets the CPU run again.

One way to write the firmware side, with invented names:

```c
volatile struct {
    uint32_t magic;             /* hook.magic, written last */
    uint32_t step;              /* then one 32-bit word for each entry of hook.fields, in that order */
    int32_t  baud_offset_ppm;   /* a field listed in hook.signed_fields */
} uart_test_info;               /* hook.info_symbol */

__attribute__((noinline)) void uart_test_hook(void) { }   /* hook.symbol: only a place for a breakpoint */

void announce_step(uint32_t n, int32_t ppm)
{
    uart_test_info.step = n;
    uart_test_info.baud_offset_ppm = ppm;
    uart_test_info.magic = 0x5EED0001;
    uart_test_hook();           /* the CPU halts here; the script reads uart_test_info and resumes */
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `symbol` | text | `""` | The empty function that the target calls. A halt counts when the program counter is inside this function, or at an instruction that calls it (which is where a line breakpoint that an IDE sets on the call halts). |
| `info_symbol` | text | `""` | The variable that the target fills before the call: 32-bit words, the magic first. |
| `magic` | integer or text | `0` | The first word of the variable, which the target writes last. A halt with another first word is resumed without a capture. Must not be 0. |
| `fields` | list of text | `[]` | The names of the words after the magic, in order. If the variable in the ELF file is shorter, only the words it has are read. |
| `signed_fields` | list of text | `[]` | The fields that are read as signed 32-bit numbers. |
| `sequence_field` | text | `""` | The field that counts the steps. A second halt with the same value is resumed without a capture. A value that goes backwards means that the target has rebooted: a new run begins and the ILA is read again. |
| `end_value` | integer or text | none | The value of the sequence field that means "the last capture is ready": the script then stops. |
| `name_template` | text | `""` | The file name of a capture, as a Python format string of `{run}` and the fields, e.g. `"run{run}_step{step:03d}"`. |
| `mode` | text | `"capture_now"` | `capture_now`: at every halt, capture what the ILA holds, then resume. `arm_and_collect_next`: at every halt, collect the window that was armed at the halt before, then arm the ILA on `capture.trigger` and resume. This gives one capture for each event that the software starts. |
| `call_mnemonics` | list of text | `["bl", "brlid", "bralid", "jal", "jalr", "call"]` | The call instructions that are looked for in the disassembly to find the lines that call the hook function (ARM `bl`, MicroBlaze `brlid` / `bralid`, RISC-V `jal` / `jalr`, x86 `call`). |

The breakpoint is yours to set: in your debugger, or with `--plant`, which plants a hardware breakpoint at the
hook function the first time the script finds the CPU halted somewhere else. Apart from that the script only
reads the state and the memory of the CPU and resumes it; nothing is downloaded or reset. When the script ends
it resumes a CPU that is still halted at the hook.

In the mode `arm_and_collect_next` a capture is named after the fields that were read when its window was
armed. The fields read at the halt that collects it are stored in `index.csv` as well, with `now_` in front
of their names: that is where the target reports how the event ended.

## `stats`

What is recorded for each capture in the `index.csv` of its session folder, and what the commands `stats` and
`summary` print. Captures from the GUI get these rows too.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | text | `"none"` | `none`: only the control and event probes below. `magnitude`: also statistics of the values of `value_probe`. |
| `value_probe` | text | `""` | The multi-bit probe that the statistics are computed on. Required for `magnitude`. |
| `valid_probe` | text | `""` | A 1-bit probe: only the samples where it is 1 are used. |
| `threshold` | number | `0` | A threshold in the unit of `value_probe`. When it is set, the samples above it are counted. |
| `reference_probe` | text | `""` | A probe whose distinct values are recorded for each capture (column `ref_level`). |
| `ctrl_probes` | list of text | `[]` | 1-bit probes whose values during the capture are recorded: `0`, `1` or `01` (column `ctrl`). |
| `event_probes` | list of text | `[]` | 1-bit probes whose rising edges are counted (columns `n_<probe>`). |
| `warn_if_high` | list of text | `[]` | 1-bit probes that must stay 0. A 1 writes a `WARNING` line into the log of the session. |

Columns of the `magnitude` mode: `n` (values used), `mean`, `rms`, `median`, `p90`, `p99`, `max`, `min`, `rms_db`
(20·log10 of the rms), `mean_over_rms` and, with a threshold, `over_thr`, `over_thr_pct` and
`margin_to_thr_db`.

Name the probes as the header of the capture file has them: by the leaf name, by the full name, or by the end
of the full name from a `/` on (`u1/status` for `top/u1/status`), with or without the bus range. A part of a
name does not count: `valid` is not `rx_valid`. A control or event probe that is not in the capture is left
out of the row. If `value_probe` or `valid_probe` is not there, the statistics of that capture are skipped
with a `WARNING` in `session.log`, and the commands `stats` and `summary` stop with
`probe <name> not in the capture`.

## `gui`

Written by the page when a profile is saved with **Save**; the script does not read it. It holds what only the
page knows. A profile that has this section counts as "saved from the page", one without it as "written by
hand".

| Key | Type | Meaning |
|---|---|---|
| `mode` | text | The capture mode: `just_capture`, `trigger_rule` or `constant_capture`. |
| `rule` | object or `null` | The trigger rule as it was built in the page: `probeName`, `probeFullName`, `isBus`, `width`, and `op1Bit` (`R`, `F`, `1`, `0`, `B`) or `opMultiBit` (`hex`, `dec`, `bin`) with `value`. |
| `custom_trigger` | text | The custom trigger expression, if one was typed. |
| `capture_name` | text | The capture name. |
| `twin_turbo` | `true` / `false` | Whether Twin Turbo was ticked. |
| `core` | text | The cell name of the selected ILA core; empty when it was not known. |
| `saved` | text | The day of the save, `YYYY-MM-DD`. |

When the page saves, it writes `name`, `_comment`, then `tools`, `hardware` and `capture` (the values of the page
laid over those of the profile it started from), then every other section of that profile unchanged (`hook`,
`stats` ...), then `gui`. `capture.trigger` is the trigger as an expression the script takes (`"now"` while a
rule has no valid value yet). When the page knows the formats of the probe file, `capture.probe_format` lists
those chosen in the probe list, together with `"radix": "UNSIGNED"`.

## What the GUI takes from a profile

When a profile is selected, the page takes from it: `hardware.url`, `hardware.ltx` (which it reads at once),
`hardware.device_filter`, `hardware.jtag_frequency_hz`, `hardware.ila_index`, `tools.tcl_script`,
`capture.position`, `capture.timeout_min`, `capture.sample_period_ns` and `capture.probe_format` (as the
formats the probe list starts from, where none have been chosen for that probe file on this PC). A
`capture.trigger` other than `"now"` of a profile written by hand becomes the custom trigger expression, and
the mode becomes "Capture on Rule". From a profile saved from the page, the `gui` section and `capture.format`
come back as well, and its probe formats take the place of what was chosen in the list.

With every hardware job the page then sends its own fields, and these win: hw_server, probe file, Tcl script
and device filter (each only when its field is not empty; an empty field leaves the value of the profile in
force), the ILA core, the JTAG clock, the trigger, position, timeout, export format, capture name and the
probe formats.

What a job from the GUI still uses of the selected profile: `tools.vivado`, `tools.tcl_script` while the Tcl
script field is empty, `hardware.target_filter`, `capture.capture_mode`, `capture.out` and the `stats`
section. `capture.radix` and the `hook` section are not used.

The profile is read from its file for every job. If the file is no longer there - renamed or deleted after
the page read its list - the job ends with `profile not found: <path>`: it is not run with the built-in
defaults in place of the profile.

## Relative paths

"Program folder" is the folder that holds `ila_bridge.py` and `ila_capture.py`: the root of the repository in a
development build, `distribute\` in a portable folder.

| Path | In the GUI | On the command line of `ila_capture.py` |
|---|---|---|
| `--profile` | (the GUI passes the full path) | against the current directory |
| `hardware.ltx` | against the program folder | `--ltx` is taken against the current directory. A relative path in a profile is unsafe: `check` looks in the current directory, Vivado in the program folder. Write a full path. |
| `capture.out` | against the program folder; when it is not set, `captures\` in the program folder | against the current directory; when it is not set, `captures\` in the current directory |
| `tools.tcl_script`, `--tcl` | as written, else in the program folder, else in its `scripts` folder | `--tcl`: as written, else in the program folder, else in its `scripts` folder |
| `tools.vivado`, `xsct`, `nm`, `objdump` | as written (Vivado is searched for if it is not there) | the same |

`check` reports a relative `hardware.ltx` as a problem, for the reason in the table. A relative `capture.out`
is none: `check` notes the folder it stands for when the command is started in the current directory. A
profile that is only used from the GUI may name its probe file by a relative path; one that is also used on
the command line should not.

## Checking a profile

```powershell
python ila_capture.py --profile profiles\example-basic.json check
python ila_capture.py --profile profiles\example-hook-uart.json check --hook
```

`--profile` may stand before or after the command. `check` needs no hardware. It looks for Vivado the way a
capture does, for the probe file, for a hw_server address that can be used, for a trigger that can be written,
for a known `radix`, `capture_mode` and `format`, for a `position` and a `timeout_min` that a capture can use,
and for a hook section that fits together (required keys, a template that only uses known fields).
`--hook` also requires the hook keys and looks for `xsct`, `nm` and `objdump`.
`--elf <file>` reads the hook symbols from an ELF file and compares the size of the variable with
`hook.fields`. `check` prints `note:` and `PROBLEM:` lines and ends with `OK` (exit code 0) or the number of
problems (exit code 1).

On a PC without Vivado and without the probe file, the shipped `example-basic.json` gives two problems: Vivado
not found, and `hardware.ltx not found`.
