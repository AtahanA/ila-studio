// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { captureLabel } from "./names";

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
