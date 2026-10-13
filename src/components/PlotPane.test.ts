// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { clampRange } from "./PlotPane";

describe("clampRange", () => {
  it("leaves a view inside the limit as it is", () => {
    expect(clampRange(20, 60, [0, 100])).toEqual([20, 60]);
    expect(clampRange(0, 3, [0, 3])).toEqual([0, 3]);
  });

  it("moves a view that hangs over an end back inside, at its width", () => {
    expect(clampRange(-5, 5, [0, 100])).toEqual([0, 10]);
    expect(clampRange(95, 105, [0, 100])).toEqual([90, 100]);
  });

  it("widens a view of fewer than 8 samples around its middle", () => {
    expect(clampRange(10, 12, [0, 100])).toEqual([7, 15]);
    expect(clampRange(99, 100, [0, 100])).toEqual([92, 100]);
  });

  it("shows the whole axis for a view wider than the limit", () => {
    expect(clampRange(0, 500, [0, 100])).toEqual([0, 100]);
    expect(clampRange(-40, 300, [0, 100])).toEqual([0, 100]);
  });

  it("shows all of an axis of fewer than 8 samples", () => {
    expect(clampRange(1, 2, [0, 3])).toEqual([0, 3]);
  });

  it("still has a width for a single sample", () => {
    const [lo, hi] = clampRange(0, 0, [0, 0]);
    expect(hi - lo).toBe(1);
  });
});
