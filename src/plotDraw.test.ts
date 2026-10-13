// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { envelopeOf } from "./analysis";
import { type CurveFrame, deviceFrame, drawCurve, fitCanvas } from "./plotDraw";

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

/** A canvas that only notes what fitCanvas does with one: how often its bitmap is sized, and what its context is told. */
function canvasOf(width: number, height: number, withContext = true) {
  const told: string[] = [];
  const size = { width, height, set: 0 };
  const ctx = {
    setTransform: (...m: number[]) => void told.push(`transform ${m.join(" ")}`),
    clearRect: (...r: number[]) => void told.push(`clear ${r.join(" ")}`),
  };
  const canvas = {
    get width() {
      return size.width;
    },
    set width(w: number) {
      size.width = w;
      size.set++;
    },
    get height() {
      return size.height;
    },
    set height(h: number) {
      size.height = h;
      size.set++;
    },
    getContext: () => (withContext ? ctx : null),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx: ctx as unknown as CanvasRenderingContext2D, size, told };
}

describe("fitCanvas", () => {
  it("gives the canvas the pixels of a scaled display and a context that draws in CSS pixels", () => {
    // a new canvas is 300 x 150; the viewer of a window 1280 px wide is 984 x 376 CSS pixels
    const { canvas, ctx, size, told } = canvasOf(300, 150);
    expect(fitCanvas(canvas, 984, 376, 1.25)).toBe(ctx);
    expect([size.width, size.height]).toEqual([1230, 470]);
    expect(told).toEqual(["transform 1.25 0 0 1.25 0 0", "clear 0 0 984 376"]);
  });

  it("is as many pixels as CSS pixels where the display is not scaled", () => {
    const { canvas, size, told } = canvasOf(300, 150);
    fitCanvas(canvas, 984, 376, 1);
    expect([size.width, size.height]).toEqual([984, 376]);
    expect(told).toEqual(["transform 1 0 0 1 0 0", "clear 0 0 984 376"]);
  });

  it("rounds to whole pixels", () => {
    const { canvas, size } = canvasOf(300, 150);
    fitCanvas(canvas, 333, 101, 1.5);
    expect([size.width, size.height]).toEqual([500, 152]);
    fitCanvas(canvas, 333, 101, 1.25);
    expect([size.width, size.height]).toEqual([416, 126]);
  });

  it("does not size a bitmap anew that has the size already: that would erase and reallocate it", () => {
    const { canvas, size, told } = canvasOf(300, 150);
    fitCanvas(canvas, 984, 376, 1.5);
    expect(size.set).toBe(2);
    fitCanvas(canvas, 984, 376, 1.5);
    expect(size.set).toBe(2);
    // ... but it is cleared for the next picture, and the scale is set again
    expect(told).toEqual(["transform 1.5 0 0 1.5 0 0", "clear 0 0 984 376", "transform 1.5 0 0 1.5 0 0", "clear 0 0 984 376"]);
    // the window moves to a screen with another scaling
    fitCanvas(canvas, 984, 376, 1);
    expect(size.set).toBe(4);
    expect([size.width, size.height]).toEqual([984, 376]);
  });

  it("answers null where the canvas has no context", () => {
    const { canvas, size } = canvasOf(300, 150, false);
    expect(fitCanvas(canvas, 984, 376, 2)).toBeNull();
    expect([size.width, size.height]).toEqual([1968, 752]);
  });
});

describe("deviceFrame", () => {
  // a row of the viewer: 26 px high, 32 px below the top of a canvas 984 CSS pixels wide
  const row: CurveFrame = { left: 0, top: 32, width: 984, height: 26, lo: -0.5, hi: 2047.5, v0: 0, v1: 4095 };

  it("is the frame itself where the display is not scaled", () => {
    expect(deviceFrame(row, 1)).toEqual(row);
  });

  it("gives place and size in whole pixels of the canvas, and leaves the data and the value axis alone", () => {
    expect(deviceFrame(row, 1.25)).toEqual({ ...row, top: 40, width: 1230, height: 33 });
    expect(deviceFrame(row, 1.5)).toEqual({ ...row, top: 48, width: 1476, height: 39 });
    expect(deviceFrame(row, 2)).toEqual({ ...row, top: 64, width: 1968, height: 52 });
    // the frame of a plot of the analysis, which does not begin at the edge of its canvas
    expect(deviceFrame({ ...row, left: 66, top: 8, width: 901, height: 271 }, 1.25)).toEqual({ ...row, left: 83, top: 10, width: 1126, height: 339 });
  });

  it("covers a canvas sized by fitCanvas from edge to edge", () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 3]) {
      const { canvas, size } = canvasOf(300, 150);
      fitCanvas(canvas, 983, 376, dpr);
      expect(deviceFrame({ ...row, width: 983 }, dpr).width).toBe(size.width);
    }
  });

  it("lets drawCurve draw one bar per column of the screen", () => {
    // 4 CSS pixels at 150 % are 6 columns: a level is one rectangle over all of them, a ramp one bar for each
    const view = deviceFrame(frame({}), 1.5);
    expect(drawn([5, 5, 5, 5], view, { thickness: 3 })).toEqual([{ x: 0, y: 73.5, w: 6, h: 3 }]);
    const ramp = drawn([0, 10], deviceFrame(frame({ hi: 1 }), 1.5), { thickness: 3 });
    expect(ramp.map((r) => [r.x, r.w])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
    ]);
  });
});

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
