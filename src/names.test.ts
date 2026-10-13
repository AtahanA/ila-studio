// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { captureLabel, cleanFormats, pathKey, shortCore, statusFromLogLine } from "./names";

describe("captureLabel", () => {
  it("names a capture by its folder and its file", () => {
    expect(captureLabel("C:\\work\\captures\\20250101_120000_unit\\cap_run_001_0003.csv")).toBe("20250101_120000_unit/cap_run_001_0003");
    expect(captureLabel("captures/20250101_120000_unit/cap_run_001.csv")).toBe("20250101_120000_unit/cap_run_001");
  });

  it("leaves out the ending of every kind of capture file", () => {
    expect(captureLabel("s/cap_run_001.ila")).toBe("s/cap_run_001");
    expect(captureLabel("s/cap_run_001_0003.csv.gz")).toBe("s/cap_run_001_0003");
    expect(captureLabel("s/CAP_RUN_001.CSV.GZ")).toBe("s/CAP_RUN_001");
    expect(captureLabel("s/CAP_RUN_001.Csv")).toBe("s/CAP_RUN_001");
  });

  it("keeps what merely looks like an ending inside the name", () => {
    expect(captureLabel("s/run.csv.v2.csv")).toBe("s/run.csv.v2");
    expect(captureLabel("s/notes.gz")).toBe("s/notes.gz");
    expect(captureLabel("s/cap_run_001.txt")).toBe("s/cap_run_001.txt");
  });

  it("is the file alone where the path names no folder", () => {
    expect(captureLabel("cap_run_001.csv.gz")).toBe("cap_run_001");
    expect(captureLabel("cap_run_001")).toBe("cap_run_001");
  });
});

describe("shortCore", () => {
  it("is the last part of the cell path", () => {
    expect(shortCore("u_ila_0")).toBe("u_ila_0");
    expect(shortCore("u_top/u_dbg/u_ila_1")).toBe("u_ila_1");
  });

  it("is what follows the last dot of that part", () => {
    expect(shortCore("u_top/dbg.u_ila_0")).toBe("u_ila_0");
    expect(shortCore("top.dbg.u_ila_0")).toBe("u_ila_0");
    // a dot further up the path is none of its business
    expect(shortCore("u_top.wrap/u_ila_0")).toBe("u_ila_0");
  });

  it("gives back a name it cannot shorten", () => {
    expect(shortCore("")).toBe("");
    expect(shortCore("u_top/")).toBe("u_top/");
  });
});

describe("pathKey", () => {
  it("is the same for one file however its path is spelled", () => {
    const key = pathKey("C:\\Work\\Captures\\Cap_Run_001.csv");
    expect(key).toBe("c:/work/captures/cap_run_001.csv");
    expect(pathKey("c:/work/captures/cap_run_001.csv")).toBe(key);
    expect(pathKey("C:/Work\\captures/CAP_RUN_001.CSV")).toBe(key);
    expect(pathKey("  C:\\Work\\Captures\\Cap_Run_001.csv ")).toBe(key);
  });

  it("tells two files apart", () => {
    expect(pathKey("C:\\work\\a\\top.ltx")).not.toBe(pathKey("C:\\work\\b\\top.ltx"));
    expect(pathKey("my board/top.ltx")).not.toBe(pathKey("myboard/top.ltx"));
  });

  // The formats chosen for a probe file are stored under this key. Another form of it (the other slash, say)
  // would leave what an earlier version stored out of reach.
  it("has the form the stored formats are filed under", () => {
    expect(pathKey("C:\\Designs\\My-Board\\top.ltx")).toBe("c:/designs/my-board/top.ltx");
    expect(pathKey("top.ltx")).toBe("top.ltx");
  });
});

describe("statusFromLogLine", () => {
  it("shows a line of the driver without its time", () => {
    expect(statusFromLogLine("12:00:01 Connecting to hw_server at 127.0.0.1:3121...")).toBe("Connecting to hw_server at 127.0.0.1:3121...");
    expect(statusFromLogLine("Capture 3 written")).toBe("Capture 3 written");
  });

  it("shows what the Tcl side reports of its own work", () => {
    expect(statusFromLogLine("12:00:02 [vivado] [ILA_REPL] armed, waiting for the trigger")).toBe("armed, waiting for the trigger");
    // the second engine of a session (Twin Turbo) signs its lines with its number
    expect(statusFromLogLine("12:00:02 [vivado-2] [ILA_REPL] uploading")).toBe("uploading");
  });

  it("shows the errors and warnings of Vivado, and none of its chatter", () => {
    expect(statusFromLogLine("12:00:03 [vivado] ERROR: [Labtools 27-3165] End of startup status: LOW")).toBe("ERROR: [Labtools 27-3165] End of startup status: LOW");
    expect(statusFromLogLine("12:00:03 [vivado] WARNING: [Labtools 27-3361] The debug hub core was not detected.")).toBe(
      "WARNING: [Labtools 27-3361] The debug hub core was not detected.",
    );
    expect(statusFromLogLine("12:00:03 [vivado] INFO: [Labtools 27-1434] Device xc7z020 (JTAG device index = 1) is programmed")).toBeNull();
    expect(statusFromLogLine("12:00:03 [vivado] open_hw_target")).toBeNull();
  });

  it("has nothing to show for an empty line", () => {
    expect(statusFromLogLine("")).toBeNull();
    expect(statusFromLogLine("12:00:04   ")).toBeNull();
    expect(statusFromLogLine("12:00:04 [vivado] [ILA_REPL]")).toBeNull();
  });
});

describe("cleanFormats", () => {
  it("keeps the formats that are not the default, each bus named without its range", () => {
    expect(cleanFormats({ "u_top/adc_data[13:0]": "signed", "u_top/state": "hex", "u_top/counter[7:0]": "unsigned" })).toEqual({
      "u_top/adc_data": "signed",
      "u_top/state": "hex",
    });
  });

  it("takes a format however it is written, and none that this tool does not write", () => {
    expect(cleanFormats({ a: "SIGNED", b: "Hex", c: "octal", d: 5, e: null, f: "" })).toEqual({ a: "signed", b: "hex" });
  });

  it("is empty for what is no set of formats", () => {
    expect(cleanFormats(undefined)).toEqual({});
    expect(cleanFormats(null)).toEqual({});
    expect(cleanFormats("signed")).toEqual({});
    expect(cleanFormats(5)).toEqual({});
    expect(cleanFormats({})).toEqual({});
  });
});
