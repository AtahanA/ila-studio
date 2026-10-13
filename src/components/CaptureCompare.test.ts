// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { MAX_COMPARED, applyComparisonChange, cleanComparison, comparisonChange } from "./CaptureCompare";
import type { CaptureItem } from "./CaptureNavigator";

/** the file of capture `n` of a session */
const file = (n: number) => `C:/caps/cap_run_001_${String(n).padStart(4, "0")}.csv`;
const listed = (count: number): CaptureItem[] =>
  Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `cap_run_001_${i + 1}`, path: file(i + 1), at: 0, rows: 0 }));

const [a, b, c] = [file(1), file(2), file(3)];

describe("cleanComparison", () => {
  it("keeps the captures of the list in the order they were chosen", () => {
    expect(cleanComparison([c, a, b], listed(3))).toEqual([c, a, b]);
  });

  it("drops what is not in the list, what is no path and what is there twice", () => {
    expect(cleanComparison([c, "D:/gone.csv", a, c, 7, null, b], listed(3))).toEqual([c, a, b]);
  });

  it("stops at the most captures a plot can tell apart", () => {
    const all = listed(MAX_COMPARED + 2).map((item) => item.path);
    expect(cleanComparison(all, listed(MAX_COMPARED + 2))).toEqual(all.slice(0, MAX_COMPARED));
    expect(MAX_COMPARED).toBe(8);
  });

  it("is empty for anything but a list", () => {
    expect(cleanComparison("junk", listed(3))).toEqual([]);
    expect(cleanComparison(undefined, listed(3))).toEqual([]);
    expect(cleanComparison({ 0: a }, listed(3))).toEqual([]);
  });
});

describe("comparisonChange", () => {
  it("names the one capture that was added or removed", () => {
    expect(comparisonChange([a], [a, b])).toEqual({ add: b });
    expect(comparisonChange([a, b], [a])).toEqual({ remove: b });
  });

  it("sends the whole list for any other step", () => {
    expect(comparisonChange([a], [b])).toEqual({ set: [b] });
    expect(comparisonChange([a, b, c], [a])).toEqual({ set: [a] });
    expect(comparisonChange([a, b], [b, a])).toEqual({ set: [b, a] });
    expect(comparisonChange([a], [a])).toEqual({ set: [a] });
  });
});

describe("applyComparisonChange", () => {
  it("adds a capture at the end, once", () => {
    expect(applyComparisonChange([a], { add: b })).toEqual([a, b]);
    const now = [a, b];
    expect(applyComparisonChange(now, { add: b })).toBe(now);
  });

  it("removes a capture", () => {
    expect(applyComparisonChange([a, b, c], { remove: b })).toEqual([a, c]);
    expect(applyComparisonChange([a], { remove: b })).toEqual([a]);
  });

  it("takes a whole list as it comes: cleaning it is the owner's business", () => {
    expect(applyComparisonChange([a], { set: [c, b] })).toEqual([c, b]);
    expect(applyComparisonChange([a], { set: "junk" })).toBe("junk");
  });

  it("leaves the choice as it is for what is no step", () => {
    const now = [a, b];
    expect(applyComparisonChange(now, "junk")).toBe(now);
    expect(applyComparisonChange(now, null)).toBe(now);
    expect(applyComparisonChange(now, {})).toBe(now);
    expect(applyComparisonChange(now, { add: 5 })).toBe(now);
  });

});

describe("comparisonChange and applyComparisonChange together", () => {
  const reached = (before: string[], after: string[]) => applyComparisonChange(before, comparisonChange(before, after)) as string[];

  it("lead from one choice to the captures of the next", () => {
    const choices = [[], [a], [a, b], [b, a], [c], [c, b], [a, b, c], [c, a, b]];
    for (const before of choices) {
      for (const after of choices) {
        expect([...reached(before, after)].sort(), `from [${before}] to [${after}]`).toEqual([...after].sort());
      }
    }
  });

  it("keep the order of a choice when a capture is ticked or unticked, or the whole choice replaced", () => {
    expect(reached([c, a], [c, a, b])).toEqual([c, a, b]);
    expect(reached([c, a, b], [c, b])).toEqual([c, b]);
    expect(reached([c], [a, b])).toEqual([a, b]);
    expect(reached([a, b], [b, a])).toEqual([b, a]);
    expect(reached([a, b, c], [])).toEqual([]);
  });

  // "Newest 4", pressed while all but one of those captures are chosen in another order, asks for [a, b, c] here:
  // one capture more, but not the old choice with it put last - so the whole list is sent, not a step.
  it("keep the order of a choice that differs by one capture and is sorted anew", () => {
    expect(comparisonChange([c, b], [a, b, c])).toEqual({ set: [a, b, c] });
    expect(reached([c, b], [a, b, c])).toEqual([a, b, c]);
    expect(comparisonChange([a, b, c], [c, b])).toEqual({ set: [c, b] });
    expect(reached([a, b, c], [c, b])).toEqual([c, b]);
  });

  it("lead from one choice to the next in its own order, whatever the two are", () => {
    const choices = [[], [a], [a, b], [b, a], [c], [c, b], [a, b, c], [c, a, b]];
    for (const before of choices) {
      for (const after of choices) expect(reached(before, after), `from [${before}] to [${after}]`).toEqual(after);
    }
  });
});
