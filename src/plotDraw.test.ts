// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { envelopeOf } from "./analysis";
import { type CurveFrame, drawCurve } from "./plotDraw";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A canvas context that only notes the rectangles it is asked to fill: all that drawCurve does with one. */
function recorder() {
  const rects: Rect[] = [];
  const ctx = { fillRect: (x: number, y: number, w: number, h: number) => void rects.push({ x, y, w, h }) };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

/** A small generator with a seed (mulberry32): the "random" curve is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 100 px high from the top of the canvas, the values 0..10 on it: 10 px per unit, 0 at y = 100 */
const frame = (more: Partial<CurveFrame>): CurveFrame => ({ left: 0, top: 0, width: 4, height: 100, lo: 0, hi: 3, v0: 0, v1: 10, ...more });

function drawn(y: ArrayLike<number>, f: CurveFrame, { step = false, thickness = 2, column = 1, envelope = false } = {}): Rect[] {
  const { ctx, rects } = recorder();
  drawCurve(ctx, y, envelope ? envelopeOf(y) : null, step, f, thickness, column);
  return rects;
}

describe("drawCurve", () => {
  it("draws nothing without samples, without a range or without room", () => {
    expect(drawn([], frame({}))).toEqual([]);
    expect(drawn([5, 5, 5, 5], frame({ lo: 3, hi: 3 }))).toEqual([]);
    expect(drawn([5, 5, 5, 5], frame({ lo: 3, hi: 0 }))).toEqual([]);
    expect(drawn([5, 5, 5, 5], frame({ v0: 10, v1: 10 }))).toEqual([]);
    expect(drawn([5, 5, 5, 5], frame({ width: 0 }))).toEqual([]);
    expect(drawn([5, 5, 5, 5], frame({ height: 0 }))).toEqual([]);
  });

  it("draws a level that does not move as one rectangle", () => {
    // the value 5 lies halfway up the frame, at y = 20 + 50; the bar is 2 px thick around it and starts at the
    // left edge of the frame
    expect(drawn([5, 5, 5, 5], frame({ left: 10, top: 20 }))).toEqual([{ x: 10, y: 69, w: 4, h: 2 }]);
    expect(drawn([5, 5, 5, 5], frame({ width: 10 }), { column: 4 })).toEqual([{ x: 0, y: 49, w: 10, h: 2 }]);
  });

  it("lets every column reach from where the line enters it to where it leaves", () => {
    // 0 -> 10 across four columns: 0..2.5, 2.5..5, 5..7.5, 7.5..10, each a pixel more at either end
    expect(drawn([0, 10], frame({ left: 10, hi: 1 }))).toEqual([
      { x: 10, y: 74, w: 1, h: 27 },
      { x: 11, y: 49, w: 1, h: 27 },
      { x: 12, y: 24, w: 1, h: 27 },
      { x: 13, y: -1, w: 1, h: 27 },
    ]);
  });

  it("holds a logic level until the next sample", () => {
    // as above, drawn in steps: 0 for three columns, and the riser in the column of the second sample
    expect(drawn([0, 10], frame({ hi: 1 }), { step: true })).toEqual([
      { x: 0, y: 99, w: 3, h: 2 },
      { x: 3, y: -1, w: 1, h: 102 },
    ]);
  });

  it("holds the last level for one more sample period", () => {
    // a view that reaches a sample period past the two samples: a line ends at the last one, a level does not
    expect(drawn([5, 5], frame({ width: 3, hi: 3 }))).toEqual([{ x: 0, y: 49, w: 2, h: 2 }]);
    expect(drawn([5, 5], frame({ width: 3, hi: 3 }), { step: true })).toEqual([{ x: 0, y: 49, w: 3, h: 2 }]);
  });

  it("draws wider columns when asked to", () => {
    expect(drawn([0, 10], frame({ hi: 1 }), { column: 2 })).toEqual([
      { x: 0, y: 49, w: 2, h: 52 },
      { x: 2, y: -1, w: 2, h: 52 },
    ]);
  });

  it("draws only where there are samples", () => {
    // 11 columns for the positions -4..7, the four samples at 0..3: columns 3 to 7, and one more for a held level
    expect(drawn([5, 5, 5, 5], frame({ width: 11, lo: -4, hi: 7 }))).toEqual([{ x: 3, y: 49, w: 5, h: 2 }]);
    expect(drawn([5, 5, 5, 5], frame({ width: 11, lo: -4, hi: 7 }), { step: true })).toEqual([{ x: 3, y: 49, w: 6, h: 2 }]);
  });

  it("draws nothing of a curve that lies entirely above or below the value axis", () => {
    expect(drawn([50, 50, 50, 50], frame({}))).toEqual([]);
    expect(drawn([-50, -50, -50, -50], frame({}))).toEqual([]);
  });

  it("cuts a bar off just outside the frame", () => {
    expect(drawn([-1000, 1000, -1000, 1000], frame({ width: 1 }))).toEqual([{ x: 0, y: -2, w: 1, h: 104 }]);
  });

  it("shows a single-sample spike however many samples share a column", () => {
    const y = new Float64Array(100000);
    y[54321] = 1;
    const view = frame({ width: 100, hi: 99999, v1: 1 });
    // a thousand samples per column: the spike is in column 54, the level 0 to both sides of it
    const expected = [
      { x: 0, y: 99.5, w: 54, h: 1 },
      { x: 54, y: -0.5, w: 1, h: 101 },
      { x: 55, y: 99.5, w: 45, h: 1 },
    ];
    expect(drawn(y, view, { thickness: 1 })).toEqual(expected);
    expect(drawn(y, view, { thickness: 1, envelope: true })).toEqual(expected);
  });

  it("includes the final sample in the last column", () => {
    // 49 columns of 1/49 each: added up they end a hair before 1, and the second sample would be lost
    const rects = drawn([0, 10], frame({ width: 49, hi: 1 }), { step: true });
    expect(rects).toEqual([
      { x: 0, y: 99, w: 48, h: 2 },
      { x: 48, y: -1, w: 1, h: 102 },
    ]);
  });

  it("draws the same with and without an envelope", () => {
    const random = seeded(1);
    const y = Float64Array.from({ length: 5000 }, () => Math.round(random() * 200 - 100));
    for (const [lo, hi] of [
      [0, 4999],
      [100.5, 4321.25],
      [1000, 1040],
    ]) {
      for (const step of [false, true]) {
        const view = frame({ width: 300, lo, hi, v0: -100, v1: 100 });
        const plain = drawn(y, view, { step });
        expect(plain.length).toBeGreaterThan(0);
        expect(drawn(y, view, { step, envelope: true })).toEqual(plain);
      }
    }
  });
});
