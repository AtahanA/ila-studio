# ILA Studio user guide

This guide describes what ILA Studio does, control by control. For requirements, installation and a first
capture see the [project page](../README.md). The keys of a profile file are listed in the
[profile reference](profile-schema.md).

Words used here: a **probe file** is the `.ltx` file that Vivado writes for a bitstream; it names the ILA cores
and their probes. **hw_server** is the Vivado program that the JTAG cable is attached to. **TCK** is the JTAG
clock. A **capture** is one filled buffer of one ILA core. The **program folder** is the folder that holds
`ila_bridge.py`: the root of the repository in a development build, `distribute\` in a portable folder.

## Contents

- [The window](#the-window)
- [Probe file, hw_server and JTAG](#probe-file-hw_server-and-jtag)
- [The probe list](#the-probe-list)
- [Trigger and capture modes](#trigger-and-capture-modes)
- [The hardware session](#the-hardware-session)
- [Capture files](#capture-files)
- [Waveform viewer](#waveform-viewer)
- [Signal Analysis](#signal-analysis)
- [Profiles and Save](#profiles-and-save)
- [What is remembered](#what-is-remembered)
- [How it is put together](#how-it-is-put-together)
- [Command line](#command-line)

## The window

- **Header**: the Profile list with **Save**, the status line, the theme button (sun / moon), the crash
  reports button (a bug), **View Log (.txt)** and **Demo Data**.
- **Two tabs**: "ILA Capture & Trigger Rules" (hardware, trigger, probes and the waveform viewer) and "Signal
  Analysis".
- **Bar at the bottom**: **Capture Name**, **Open File**, the capture button (its label follows the capture
  mode), **Twin Turbo** and **Connect** / **Disconnect**.

The status line shows the progress of a running job. **View Output** (or **View Error Log** after a failure)
next to it opens the output of the last job; Escape closes that window. **View Log (.txt)** opens
`ila_log.txt`, the log of all hardware jobs, in Notepad. The status line, the log window, the footer of the
viewer and the probe names can be marked with the mouse and copied.

**Demo Data** loads a simulated capture: 2,048 samples of 8 signals (`u_top/clk_en`, `u_top/fsm_state[3:0]`,
`u_top/adc_data[15:0]` ...) with the trigger at sample 500. It needs Python but neither Vivado nor a board.
Every click writes a new file `captures\demo_ila_<date>_<time>.csv`.

If a window cannot be drawn because of an error in the program, it says "ILA Studio ran into an error and
cannot show this window.", shows the error as text that can be copied, and offers **Reload**.

**Crash reports** are off until you switch them on. The bug button in the header opens a panel:

- **Send crash reports**: while the box is ticked, an error of the program - in either window, or in the
  backend - is reported to the server the panel names. A report holds the error text and where in the program
  it happened, the version of the program and of Windows. It never holds captures, profiles, the log or the
  probe file. The names of user folders, the server of a network path and IPv4 addresses are taken out of the
  text where they stand in their usual notation; a probe name, a file name or a host name inside an error
  text is not recognised and is sent. The same message is reported once in a run, and a run reports twenty
  errors of the page at most.
- The box is ticked for the server the panel names, and for no other: started with another report address
  (see `ILA_SENTRY_DSN` on the project page), the program has it unticked again. Unticking holds from that
  moment, also for a report that was still waiting to be sent, and reaches a second copy of the program that
  is running.
- **Send a test report** (while the box is ticked) sends one report that says "ILA Studio test report" and
  shows its id, or why it did not arrive.
- "This build has no address to send reports to." with a greyed box: the program has no report address, as a
  build from source has none unless it was given one. Nothing can be sent.
- "This address begins with http://: reports are sent to it without encryption.": the report address is no
  `https://` address and is not on this PC, so what is sent to it can be read on its way.

While crash reports are off, the error screen described above has a button **Send this error report**, which
sends that one error (not in a program without a report address, and twice in a run at most). The
[project page](../README.md#crash-reports-optional-off-by-default) lists what a report contains, which
notations of a name or an address are recognised and which are not, and how to send reports to a Sentry of
your own.

## Probe file, hw_server and JTAG

The card "Hardware & ILA Core Input".

- **Vivado Probe File (.ltx)**: **Browse** picks the file and reads it at once; **Parse File** reads the path
  that was typed. The file is read directly, without Vivado: all ILA cores, the hierarchical signal names, bit
  widths and port numbers. VIO probes are left out. The capture depth of a core is not in the probe file; it
  is shown after **Connect**. Both forms of the file are read: the XML form that Vivado 2017.4 writes and the
  JSON form of newer versions (a file that begins with `{ "ltx_root"`). A file that is neither is refused with
  "Failed to parse LTX".
- **Vivado Tcl Script (.tcl)**: leave it empty to use the bundled `scripts\vivado_ila_repl.tcl`. A script
  named here is run by Vivado, so name only a script you trust. A path that does not exist ends the job with
  `Tcl script not found: <path>`; the bundled script is not run in its place.
- **hw_server URL**: `host:port`, e.g. `127.0.0.1:3121` for a hw_server on this PC or `192.0.2.10:3121` for a
  cable on another PC. Port 3121 is added when none is given. An IPv6 address is written in brackets:
  `[::1]:3121`. Text that is not an address is refused.
- **Device Filter**: `*` searches the JTAG chain for the device that carries the ILA (on a Zynq the first
  device is the ARM debug port, which never does). A glob such as `xc7z020*` pins it.
- **JTAG Clock (TCK)**: one list and one field. `Auto` keeps the cable's own frequency and lowers it only when
  the debug hub of the design cannot follow: TCK must stay at or below debug hub clock / 2.5 (for example, a
  hub clock of 25 MHz allows 10 MHz at most). The hub clock is read from the probe file, and the line below the
  list shows the limit. A probe file that does not name the hub clock leaves `Auto` nothing to go by: the
  cable's frequency is kept, and the message of **Connect** and of every capture says `the probe file does
  not name the debug hub clock`. A preset or a frequency typed in MHz is used as given, snapped down to a value
  the cable offers. The list marks the fastest preset inside the rule (★) and the presets above it ("too fast").
- **Detected ILA Cores**: one chip for each core, with its position, name, number of probes and depth.
- **Connect** (bottom right) connects to hw_server and reads the ILA cores, their depth and the probes from the
  FPGA itself. See [The hardware session](#the-hardware-session).

**Several ILA cores in one design.** A capture is the capture of ONE core, and a trigger can only use probes of
that core. The selected chip is the core that is captured; the probe list and the trigger card show ITS
probes. A search in the probe list that finds the name on another core says so ("Not on this core. On [0]
...") and a click selects that core. Selecting another core removes a trigger that belonged to the core
before. The core is sent to the hardware by its cell name, not by its position, and an open hardware session
changes core without starting Vivado again. A trigger on a probe of another core is refused with both cores
named.

## The probe list

The card "ILA Parameters & Probes".

- **Search and filter**: search by short name or hierarchy; the buttons **All**, **1-Bit** and **Buses** filter
  by kind.
- **Plot** (first column): ticks the signals that the waveform viewer shows. **Toggle All** ticks or unticks
  all listed signals.
- **Set Trigger**: makes this probe the trigger of a rule. On the trigger probe the button reads
  **Active Trigger**; a click there removes the trigger.
- **In the CSV**: the number format of each bus in the capture files.

**Number format of each bus in the CSV.** `unsigned` (the default: the plain number, 16354), `signed` (two's
complement of the probe width: -30 for a 14-bit bus) or `hex` (`0x3FE2`, with every digit of the width). "all
shown..." in the column header sets every bus that the search and the filter leave in the list at once. The
choice is kept for each probe file and applies to the captures taken from then on.

- `signed` is written by Vivado itself (`DISPLAY_RADIX SIGNED`, also into the `.ila`), so it costs no time.
  `hex` is written by this tool after the capture, with `0x` in front: Vivado's own hex has no prefix, and in
  a file with decimal columns next to it nobody - no reader and no spreadsheet - could tell whether `8123` is
  hex or decimal. Binary and octal are not offered for the same reason.
- The viewer and the Signal Analysis read all three alike. A bus that the file holds signed is plotted signed
  (the "auto" reading of the analysis, and the analog wave of the viewer).
- The list shows what a capture will be written with, and nothing else is. The formats can be chosen while the
  list is that of the probe file in the field above (after **Parse File** or **Connect**; not for the demo
  data), and not while a capture runs, which keeps the formats it was started with. A radix for all buses in a
  profile (`capture.radix`) does not apply to captures from the GUI.
- A profile can carry a choice for a design, as where the list starts from on a PC where none has been made:
  `"capture": { "probe_format": { "adc_data": "signed", "status": "hex" } }`, by the whole net name or its last
  element. Once something is chosen in the list (also "unsigned" again), the choice of the list stands -
  except that selecting a profile that was saved with **Save** puts the formats it was saved with in the place
  of the list's choice (a start does not). The formats of a profile are taken for its own probe file; those of
  a saved profile also for a file of the same name in another folder.

## Trigger and capture modes

The card "Trigger Rules & Capture Mode". The mode decides the label of the capture button in the bottom bar.

| Mode | Button | What happens |
|---|---|---|
| **Just Capture** | **Just Capture (Now)** | The ILA buffer is captured at once (`run_hw_ila -trigger_now`). |
| **Capture on Rule** | **Arm & Capture on Trigger** | The core is armed and waits for the trigger, for at most the timeout. |
| **Constant Capture** | **Start Constant Capture** | Window after window in one Vivado session until **Stop Capture**. The run also ends by itself after 100000 windows, or when less than 1 GB is free on the capture drive; the message then says which. With a trigger each window waits for it; without one the windows are taken one after the other at once. Every window is saved and listed, and the capture navigator of the Signal Analysis steps through them. |

**The rule.** Choose the probe under **Select Trigger Probe** or with **Set Trigger** in the probe list.

- 1-bit probes: **Rising Edge (R)** `eq1'bR`, **Falling Edge (F)** `eq1'bF`, **High (1)** `eq1'b1`, **Low (0)**
  `eq1'b0`, **Either (B)** `eq1'bB`.
- Buses: **Value Format** and **Match Value**. **Hex (h)** is sent as `eq<W>'h<value>` and **Bin (b)** as
  `eq<W>'b<value>`, padded with zeros to every digit of the probe width (`eq14'h003F`). **Dec (u)** is sent as
  `eq<W>'u<value>`, unsigned decimal, because Vivado 2017.4 does not know `'d`. Blanks, underscores and a
  leading `0x` are dropped; `x` is a don't-care digit in hex and binary. A value with more digits than the
  probe has, or one that does not fit into the probe width (`FFFF` or decimal 16384 for a 14-bit probe), is
  refused before anything is sent.
- **Custom trigger expression (optional, overrides the rule)**: `<probe> <compare-value>` written by hand, e.g.
  `rx_valid eq1'bR` or `state eq4'h3`. This is also where the trigger of a profile written by hand shows up.

**Naming a trigger probe by hand** (custom trigger expression, a profile, the command line): the full
hierarchical name, the leaf name, or the end of the full name from a "/" on. A name that is merely the end of
a probe's name ("valid" for "rx_valid") is not taken, and a name that fits several probes of the core is
refused - both with the candidates named.

**The other settings.**

- **Pre-Trigger Position (Samples)**: how many samples of the buffer are kept from before the trigger. Once the
  hardware has told the depth of the core, the position cannot lie beyond it.
- **Timeout (Minutes)**: how long to wait for the trigger.
- **Export Format**: **CSV (fastest)**, **Both (.csv + .ila)** or **ILA archive only (.ila)**.
- **Vivado ILA Trigger Expression Preview**: the trigger, position and timeout as they will be used, e.g.
  `trigger: "u_top/rx_valid eq1'bR" | position: 1000 | timeout: 1m`. For a rule the preview names the probe by
  its full hierarchical name, as the capture itself does.

## The hardware session

- **The hardware session stays open.** Starting Vivado and opening the JTAG target is most of the time a single
  capture takes (in the set-up this was developed with: about 9 of 11 s). The first hardware job, or
  **Connect**, opens the session, and it then stays open: the next capture starts at once (in the same set-up:
  about 2 s with CSV, about 4 s with CSV + .ila). It is closed by the same button (**Disconnect**), when the
  hardware settings change (it is then opened again with the new ones), and when the application closes.
  Vivado exits and the cable gets its JTAG clock back each time. Before every job the open session looks at the
  device again (about 0.1 s), so a board that was power-cycled or given another bitstream is noticed and the
  session is opened afresh.
- **While the session is open** the cable runs at the JTAG clock the session set, which may be lower than the
  cable's default. Another Vivado that connects to the same hw_server meanwhile may report "bad enum default":
  disconnect here first. SDK debug sessions are not affected.
- **Stop** asks the running job to end in order (a stop file that the capture loop and the Tcl side watch).
  Only a job that does not answer within 90 s is killed. Only one hardware job runs at a time.
- **Closing the window** ends a running job and the open session in order, so nothing is left holding the JTAG
  target.
- **Only the ILA is touched.** The device is never programmed. The JTAG clock is changed only when a frequency
  is asked for, or when the cable's default is too fast for the debug hub of the design, and it is put back
  when the session ends.

**Twin Turbo: two Vivado engines.** The box next to **Connect**. With it the session runs two Vivado processes
on the one ILA, and in a constant capture they take turns: while one writes its file - the slowest step - the
other is already arming the core and uploading the next window. Only the writing overlaps; the upload goes
over JTAG, which one engine uses at a time, so the upload stays the floor. As an example, measured with a
16k-sample core of a few dozen columns: 2.0 s per window became about 1.5 s with CSV, and 3.9 s became about
2.1 s with CSV + .ila.

It costs a few seconds more at Connect and the memory of a second Vivado (about 1 GB in the same set-up). A
single capture is not faster: it is taken by the first engine alone. Ticked or unticked while connected, it
takes effect with the next capture (the second engine is started, or closed, in the open session). The second
engine never touches the cable's JTAG clock when it goes: the first one puts back what was found, last (should
the first one have died, the second does it in its place). A second engine that cannot be started or
connected, or that fails during a run, is left out: the session and the run carry on with one engine, and the
answer says so. With a Tcl script of your own that cannot keep an upload apart from its write, one engine is
used.

## Capture files

- **Where.** Every job writes a session folder `captures\<date>_<time>_unit\` in the program folder, or in the
  folder that `capture.out` of the selected profile names. It holds the captures, `index.csv` (one row for
  each capture) and `session.log`.
- **Names.** A single capture is called after **Capture Name** (`cap_run_001.csv`, and `.ila` with it when
  the export format says so). The windows of a constant capture are numbered: `cap_run_001_0000.csv`,
  `cap_run_001_0001.csv` ... In the name, letters, digits, `_`, `-` and `.` of ASCII stay and anything else
  becomes `_`.
- **Format.** The CSV is what Vivado exports: the columns `Sample in Buffer`, `Sample in Window` and
  `TRIGGER`, then one column for each probe. Buses are written in unsigned decimal unless another format was
  chosen in the probe list.
- **Open File** (bottom bar) shows a `.csv`, `.csv.gz` or `.ila` file from disk. **Import** in the Signal
  Analysis brings many captures in at once.
- **Size.** A capture file is read a piece at a time and is not held in memory as a whole. A file that holds
  more than 2 GB of CSV text is refused with a sentence that says so (for a `.csv.gz` and a `.ila`: the text
  they unpack to); the deepest core with the widest probes fills a fraction of that. A probe file is read up
  to 64 MB.
- The viewer and the analysis get every sample of a capture of up to 131,072 samples. A longer capture is
  thinned, and the footer of the viewer says so.

## Waveform viewer

The card "Interactive Logic Analyzer Waveform" at the bottom of the capture tab.

- Canvas drawing that stays fast with many thousands of samples.
- 1-bit signals as logic traces with 0/1 steps.
- Buses as boxes with their hex value, or - with the small button next to the value - as an analog wave (e.g.
  for ADC or DSP data).
- A ruler in samples, or in time when the sample period is known.
- The trigger as a red dashed line marked "TRIG", when the file marks one in its `TRIGGER` column, and the
  values of all signals at the sample under the pointer.
- Zoom in, zoom out and reset buttons. Ctrl + wheel zooms around the pointer; dragging pans; the plain wheel
  scrolls the signal rows.
- **Signal Analysis** in its header opens the same capture in the analysis tab.
- The footer names the buffer depth, the trigger sample when the file marks one, and the file of the capture.

## Signal Analysis

The **Signal Analysis** tab plots the capture that is on screen and follows every new window of a constant
capture, with no export and no second program.

**Sample period.** An ILA capture has no time base of its own. The field "sample period" in the toolbar takes
the period of the ILA clock in ns (10 ns is 100 MHz); a profile can bring it as `capture.sample_period_ns`. It
starts at 0, which means "not known": the X axis is then in samples and frequencies read in cycles/sample.

**Stepping through the captures** (top right of the toolbar): `|<  <  [ 12 / 187 ]  >  >|` moves to the first,
previous, next and newest capture of this session - captures taken, files opened, the demo data. A click on
the number opens the list of all of them (name, time, samples) to pick one. Plots, zoom and cursors stay as
they are while the captures have the same length, so two captures can be compared at the same spot. While a
constant capture runs: with the newest capture on screen every new window is shown as it arrives (green dot);
after a step back to an older capture the view stays there - new windows are still saved and counted - until
`>|` (or stepping forward to the last one) follows again. Starting a capture always follows. The list holds
the newest 4000 captures of the session; the numbers go on counting, older files stay on disk and
**Open File** brings one back.

**Compare** (a button of the toolbar, next to the navigator): lay the same signal of several captures over
each other. Tick up to eight captures of the session in its list ("Newest 4" takes the last four). The signal
list on the left is then grouped - the capture on screen first, then one group for each compared capture,
with its number - and every row has a layers button (left of the "+") that adds the signal from EVERY compared
capture to the selected plot in one click; "+" in a group adds it from that capture alone. Such a curve is
pinned to its capture: its chip carries the capture's number, it keeps its data when the navigator steps on,
and the tables name it "signal #n". The curves are laid over each other by position in the window (sample 0
at the same place); a shorter capture ends earlier. A capture taken out of the comparison leaves its curves
as dimmed chips, which come back when it is chosen again. The comparison lasts for the session.

**Import** (a button of the toolbar, also in the popped-out window): brings captures that are on disk into
that list, to look at them again. "Capture files..." takes several `.csv` / `.csv.gz` / `.ila` at once, "A
folder..." everything in a folder - one session folder, or the folder that holds the sessions. The captures
join the list in the order of their names (the order they were taken in) with the time their file was
written, the first of them is shown, and the navigator steps through the rest; each is read when it is looked
at. A capture that lies there as `.csv` and as `.ila` counts once, and files that are no captures
(`index.csv`) are left out. One import brings up to 2000 captures; a file that turns out not to be readable
leaves the list when it is looked at.

**Plots.** Any number of stacked charts sharing one time axis (**Add plot**). Drag signals from the list onto a
chart, or double-click them. The first chart is filled with the liveliest buses of the capture.

**Switching a curve off and on.** A click on a signal's name in a chart's header takes that curve out of the
chart, the next click puts it back - like a channel of an oscilloscope. A curve that is off keeps its place
and its settings in the header (dashed, struck through); it is not drawn, read out or measured (it has no
read-out on the cursor lines and no row in "Phase and delay"), and the value axis is fitted to the curves that
are on (a value zoom made by hand stays). It works the same in a spectrum, and is remembered with the layout.
Double-clicking the signal in the list switches it on as well. Nothing moves when a curve is switched: the
boxes keep their size, and the cursor table under a spectrum keeps the row of a curve that is off (struck
through, without values) instead of getting shorter.

**Reading the values right.** An ILA exports every bus as an unsigned number. Each curve can be read `signed`,
`unsigned` or `auto` (two's complement when the values look like it - a 14-bit ADC around zero shows as -30,
not as 16354).

**Navigation.** Drag = zoom into the marked stretch · wheel = zoom · Shift+drag / Shift+wheel = pan ·
Ctrl+wheel / Ctrl+drag = value axis · double-click = everything. The X axis is in samples or in time relative
to the trigger. By default every plot has its own zoom ("Zoom: each plot"); the toolbar button switches to one
common zoom for all plots ("Zoom: all plots"). **Reset view** shows the whole capture in every plot.

**Pop out** moves the whole analysis into a window of its own, e.g. for a second screen. It keeps following
the captures taken in the main window and takes zoom, cursors and the click mode along; closing it (or "Back
into the main window") docks it again.

**Cursors, as on an oscilloscope.** The "click places" switch in the toolbar chooses what a click places.

- `time (A, B)`: vertical cursors. Click = A, Shift+click = B. The bar shows both positions, B − A in samples
  and time, and 1/(B − A) as a frequency; the card below the plots lists every curve of the selected plot
  **at A, at B, the difference B − A and the slope** (change per second).
- `value (Y1, Y2)`: horizontal cursors on the plot's own value axis. Click = Y1, Shift+click = Y2; the
  read-out shows both levels and Y2 − Y1.
- Any cursor line can be dragged; "Clear cursors" removes them. A double-click resets the view and leaves the
  cursors where they are.
- A spectrum has cursors of its own: frequency and level (dB) at A and B, and the differences.
- **Every line says what it reads, X and Y**: the line under the pointer carries its place on the X axis as a
  tag on the axis - the sample, or the time to the digit that tells one sample from the next - and, beside
  each curve, the value of that curve there. Cursors A and B do the same in every plot: their place next to
  their letter, the values where they cross the curves. In a spectrum the place is a frequency (to the spacing
  of its points) and the values are in dB. The bar above the plots gives a cursor's time with the same digits.

**Measurements.** Min, max, mean, RMS, standard deviation, peak-to-peak, rising edges, period / frequency and
the share of samples that are high, for every curve of the selected plot - over the visible stretch, or
between the cursors. Read-out and measurements sit in one card below the plots, so nothing between the plots
moves when a cursor is placed or another plot is selected. The period is taken from where the signal crosses
its middle level, between the samples: for a tone it is right to a small part of a sample.

**Phase and delay between two signals, as on an oscilloscope.** When the selected plot shows two or more
signals, the table "Phase and delay against ..." measures each of them against a reference (chosen in the
table's title; the first signal of the plot to begin with), over the visible stretch or between the cursors.
**Both signals have to be in the same plot.**

- `frequency`: the tone the signal repeats with - the lowest of its strongest components, so the repetition
  rate of a pulse train or a strobe, not one of its harmonics - read between the points of its spectrum.
- `phase` against the reference, at the reference's frequency: `-90.00° lags` means the signal does what the
  reference does a quarter of a period later, `+90.00° leads` earlier; `180.00°` has no direction. For pulses
  the phase compares the middles of the pulses, not their edges.
- `time shift`: that phase as a time (`143.02 ns later`; `±125 ns` for half a period).
- `edge to edge`: from each rising edge of the reference to the nearest rising edge of the signal - the mean,
  the number of edges and, where it varies, the least and the greatest (+ is later). For two strobes this is
  the latency of an answer to its request. Edges half-way between the reference's read `±` ("midway"); edges
  that keep no one distance (another rate, no relation) show from where to where they lie ("no one delay").

A frequency and a phase are given for what repeats: two and a half periods and two rising edges in the stretch
at least - a step or a single pulse has only its edge-to-edge delay. A signal that repeats with another tone
but holds the reference's frequency beside it shows that component's phase ("not its own tone"); a signal that
does not hold it - another tone, noise, a data line - has no phase ("-"; the cell says why when pointed at).
Frequency and phase are taken from at most the first 131,072 samples of the stretch.

**Per curve**: change per sample, moving average, absolute value.

**FFT** turns a chart into the spectrum of its curves (Hann window, dB), with the strongest component of each:
where its peak is, its period and its level. That table is about the band on screen: zoom into a part of the
spectrum and it names the strongest peak there (the title says which band), not the strongest of the whole
spectrum outside the picture - and not the skirt or the side lobes of a strong line just outside the band,
unless the band holds nothing else. Double-click or **Reset view** brings the whole spectrum back. A spectrum
needs at least 8 samples.

**Hide the constant signals** (button "const" in the header of the signal list): hides every signal that never
changes in its capture - unconnected probes show up as dozens of `<const0>` rows. A constant signal that is
plotted stays listed. Remembered.

**Light and dark theme.** The sun / moon button in the header switches between them; the choice is remembered,
and the analysis in its own window follows.

**Layout.** The layout is remembered between sessions. When a capture of another design (or the demo data)
comes along, the layout is put aside and returns with the next capture of its own design.

**Drawing.** Every curve is drawn for each pixel column from a min/max table of the capture
(`src/plotDraw.ts`), as plain rectangles. That keeps zooming and panning at the screen's frame rate whatever
the capture depth and the graphics card: stroked anti-aliased paths, the obvious way to draw a curve, cost
about 10 ms for each curve and frame on the development PC and made the view stutter.

## Profiles and Save

**Profile list.** The Profile list in the header applies a profile (`profiles\*.json` in the program folder) to
the page. "-- Custom Configuration --" is the page without a profile. The selected profile is passed along
with every hardware job, so what it names beyond the page (the Vivado to start, the folder of the captures)
is used as well; see the [profile reference](profile-schema.md). If its file is no longer there - renamed or
deleted after the list was read - a job ends with `profile not found: <path>`: select another profile or
"-- Custom Configuration --".

**Save** (the button next to the Profile list) opens "Save configuration": it saves the capture tab as it
stands as a profile under a name you type - a file in `profiles\` in the program folder - and from then on it
stands in the Profile list. Selecting it brings the tab back: hw_server, probe file, device filter, JTAG
clock, Tcl script, the selected ILA core, the capture mode with its trigger rule (or custom expression),
position, timeout, export format, sample period, capture name, the number formats of the buses and Twin Turbo.

- **The file** is named after the name: letters, digits, `_`, `-` and `.` of ASCII stay, anything else becomes
  `_` (the name itself is kept inside the file). A new name never takes the file of another profile: where two
  names come out as one file name, the second gets a number (`a_b-2.json`).
- **Saving again**: with a profile saved here selected, its name stands in the field and Save writes its file
  again. The name of any other profile of the list replaces THAT profile - the dialog names it first and the
  button reads "Replace". The name of a profile written by hand is never offered: it has to be typed.
- **What was there is kept** beside the file: a profile written by hand once and for good as
  `<file>.json.orig`, any later state as `<file>.json.bak` (the state before the last save). The status line
  says which. Neither is listed as a profile; to go back, rename the file.
- **Built on the selected profile**: what that holds beyond the page goes along - the paths of the tools, its
  folder for the captures (`capture.out`), the sections of the capture script (`hook`, `stats`) - and the
  dialog says so. Select "-- Custom Configuration --" first for a profile of the page alone. The profile is
  read from its file at the moment of the save, so what was edited in it meanwhile is not lost.
- **Still a profile of the capture script**: `capture.trigger` is the trigger as the expression the script
  takes ("now" while a rule has no valid value yet), `capture.probe_format` with `radix` UNSIGNED says how
  every bus is written, and what only the page knows (mode, the rule, capture name, Twin Turbo, the core by
  its name, the day of the save) lies in a section of its own, `gui`, which the script does not read. The
  export format is the page's; where a selected profile written by hand names another one - or none, which is
  `both` to the capture script - the dialog says so.
- **On another PC** a saved profile names the probe file and the Tcl script by the paths of the PC it was
  saved on: browse to the probe file there - if it has the same file name, the number formats of the buses
  come along with it.
- **Not part of a profile**: the plots of the Signal Analysis and the theme, which are remembered on the PC by
  themselves, and the signals ticked for the viewer, which are not remembered (every reading of the probe file
  - Parse File, Connect, selecting a profile, a start - ticks all of them again).
- **Removing and renaming**: there is no button for either. Delete the file in `profiles\` to remove a
  profile; to rename it, save it under the new name and delete the old file (the name is kept inside the file,
  not taken from the file name). The list is read at start, when Save is opened and after a save.

A saved profile holds the path of the probe file, the hw_server address and probe names. Look at it before
you pass it on. Only the two shipped example profiles are tracked by git.

## What is remembered

The page stores the following on this PC (in the storage of the application's WebView, not in the program
folder): the hardware fields of the last session (hw_server, probe file, Tcl script, device filter, JTAG
clock), the selected profile, the selected ILA core, Twin Turbo, the number formats chosen for each probe
file, the layout of the analysis plots, the "const" switch, the theme and whether crash reports are switched
on (with the address of the report server they were switched on for).

- **The first start** (nothing stored yet) opens on "-- Custom Configuration --" with hw_server
  `127.0.0.1:3121`. A profile is applied by itself only if the probe file of a profile in `profiles\` exists on
  this PC: then the most recently edited of those. The shipped examples name probe files that do not exist, so
  they are never applied by themselves.
- **At the next start** the selected profile comes back with its mode, trigger, position, timeout, export
  format, sample period and capture name as they were SAVED; the hardware fields, the selected core and Twin
  Turbo are those that were last used. (A trigger rule of the profile does not come back onto another core
  than the one it was saved with.)
- **Not remembered**: the list of captures (it lasts for the session; the files stay on disk), the signals
  ticked for the viewer, and the sample period unless the selected profile names it.

## How it is put together

```
GUI (React)  --invoke-->  Rust (async commands, never on the UI thread)
                              |  spawns, reads line by line
                              v
                         ila_bridge.py  --drives-->  ila_capture.py Session
                                                          |  stdin/stdout REPL
                                                          v
                                               vivado -mode tcl  scripts/vivado_ila_repl.tcl
```

- The executable finds `ila_bridge.py` next to itself (a portable folder), in the folder that the environment
  variable `ILA_HOME` names (how `run_gui.ps1` starts a local release build) or, a development build only, a
  few folders above, and starts it with the Python it found; `ila_log.txt` names that Python. Reading a probe
  file, listing the profiles, reading a capture file and the demo data are each one short Python process with
  a time limit: one that hangs is ended with a message (after 2 to 5 minutes; a capture file gets a minute
  more for every 10 MB).
- Progress lines reach the status line live (`ila-log` events); each finished capture joins the list the
  moment its file is on disk (`ila-capture` event) and is shown while the newest capture is followed.
  Everything is also appended to `ila_log.txt`.
- **A run of windows does not wait for its files.** Once Vivado has written a window, everything that is still
  to be done with the file - the formats chosen for each probe, statistics, the row in `index.csv`, telling
  the GUI - is done by a second thread while the next window is already being armed and uploaded. A window
  appears in the list when its file is final.
- The backend for all hardware work is one `ila_bridge.py serve` process. If the application is killed, it
  sees its input end, stops a job that is still running, closes Vivado in order and exits. It lives as long as
  the application: changes to `ila_bridge.py` / `ila_capture.py` take effect for hardware jobs after a restart
  of the application (an edited Tcl script is picked up by the next job, which opens a new session for it).
- Vivado runs as `vivado -mode tcl` with the script `scripts\vivado_ila_repl.tcl`, which reads one command for
  each line and answers it. One long-lived Vivado is used because starting it costs far more than a capture.

## Command line

The capture script works without the GUI. Its global options may stand before or after the command.

```powershell
python ila_capture.py --help
python ila_capture.py --profile profiles\example-basic.json check
python ila_capture.py --ltx C:\work\top.ltx --server 192.0.2.10 info
python ila_capture.py --profile profiles\my-board.json capture --name first --trigger "frame_start eq1'bR"
```

A profile is optional: `--ltx` and `--server` are enough for `info`, `capture` and `watch`. The other global
options are `--device`, `--ila-index`, `--jtag-hz`, `--out`, `--tcl`, `--target` (a board name, used in the
name of the session folder), `--trigger`, `--position` and `--format`. Without a profile and without `--out`,
captures go to `captures\` in the current directory. `--server` takes what the hw_server field of the GUI
takes, and text that is no address is refused before anything is started.

A run that cannot do its work - no Vivado, no connection, a profile that cannot be read or is no profile, a
script named with `--tcl` that does not exist, an address, a trigger or a capture setting of the profile that
cannot be used - prints one line that says why and ends with exit code 1. `watch` and `hook` log
an error that ends them and then exit with 1 as well, and so does a `watch` that gave up after too many
failures in a row (`--max-retries`).

| Command | What it does |
|---|---|
| `check` | Validates a profile without touching hardware. `--hook` also requires the hook keys and the hook tools; `--elf FILE` checks the hook symbols in an ELF file. |
| `info` | Connects and prints the ILA cores, the properties of the selected core and its probes. |
| `capture --name N` | One capture now, or on `--trigger`. `--count N` takes N captures in the same Vivado session, `--interval S` waits S seconds between them, `--note TEXT` goes into `index.csv`. |
| `watch` | Records continuously: arm, collect, re-arm, write, until `--count`, `--minutes` (default 60), `--max-gb` (default 10) or `--min-free-gb` (default 2) ends it, or Ctrl-C. The CPU is never touched. It writes CSVs unless `--format` or `capture.format` of the profile asks for something else, and gzips them in the background unless `--no-compress`. `--writers 2` lets two Vivado processes take turns. At the end it reports how much of the timeline was covered. |
| `hook --elf FILE` | Capture driven by the firmware: waits for the CPU to halt at the hook function, reads the variable the firmware filled, captures, resumes. Repeats until `--count` or `--minutes`. `--plant` plants the breakpoint itself, the first time it finds the CPU halted somewhere else, and removes it again before the run ends; `--resume-at ADDR` resumes once from a halt at that address. Needs xsct, `nm` and `objdump`, and the `hook` section of a profile. |
| `convert PATH...` | Makes ILA CSVs (`.csv`, `.csv.gz`) decimal and extracts a CSV from every `.ila` that has none. A path is one such file or a folder of them. `.ila` archives are never changed. Exit code 1 when no path held anything to convert. |
| `stats FILE...` | Prints the statistics of existing `.csv` / `.csv.gz` / `.ila` files as a table (no hardware). |
| `summary DIR` | Writes `run_summary.csv` into a folder of captures: one row for each capture with its edges, event counts and timing (no hardware). |

`convert` skips a `.ila` whose CSV is there already and prints a line that says so. Such an archive counts as
converted: the same command, run a second time, does not end with exit code 1.

`stats` and `summary` follow the `stats` section of the profile. Without one, `stats` prints only the number of
samples of each file. They can be tried on the demo data, which `python ila_bridge.py demo-capture` writes as
well. Run these in the program folder:

```powershell
python ila_bridge.py demo-capture
python ila_capture.py stats captures\demo_ila_*.csv
python ila_capture.py summary captures
python ila_capture.py convert captures
```

**Hook mode in short.** It is for captures that the software of the board has to time: a self-test run, a
register sweep, one message. The firmware fills a small variable and calls an empty function; a breakpoint
there halts the CPU; the script reads the variable through xsct, takes the capture and resumes the CPU. The
[profile reference](profile-schema.md#hook) describes the section, and
[`profiles/example-hook-uart.json`](../profiles/example-hook-uart.json) is a worked example. Hook mode halts and
resumes a CPU on live hardware: use it on a system where that is safe.

**`ila_bridge.py`** is the program the GUI talks to. Four of its commands print one JSON document and are handy
in scripts: `list-profiles`, `parse-ltx --ltx FILE`, `parse-csv --file FILE` and `demo-capture`. The command
`run-tcl --tcl SCRIPT` exists for the command line only: it runs a Tcl script of your own in a Vivado batch
session.

For messages and their remedies see the Troubleshooting table of the [project page](../README.md#troubleshooting).
