// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { useEffect, useState } from "react";
import { type Envelope, type Extremes, extremes } from "./analysis";

/**
 * The device pixel ratio of the screen the window is on: how many pixels of the screen one CSS pixel covers (1.25
 * on a display scaled to 125 %). It follows the window to a screen with another scaling.
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [dpr]);
  return dpr;
}

/**
 * Gives a canvas of `width` x `height` CSS pixels the pixels of the screen and clears it. A canvas with as many
 * pixels as CSS pixels is stretched on a scaled display, and what is drawn comes out soft. The context is scaled
 * to match, so drawing goes on in CSS pixels. The CSS size of the element has to be set by its owner: the bitmap
 * no longer says it.
 */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): CanvasRenderingContext2D | null {
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  // assigning the size reallocates and clears the canvas: only when it really changed
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/** Where a curve is drawn, in the canvas' own pixels, and which part of the data and of the value axis it shows. */
export interface CurveFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** the (fractional) sample indices at the left and the right edge */
  lo: number;
  hi: number;
  /** the values at the bottom and the top edge */
  v0: number;
  v1: number;
}

/**
 * A frame laid out in CSS pixels, in the pixels of a canvas sized by fitCanvas: whole ones, so that drawCurve
 * draws exactly one bar per column of the screen. The data and the value axis it shows stay as they are.
 */
export function deviceFrame(frame: CurveFrame, dpr: number): CurveFrame {
  return {
    ...frame,
    left: Math.round(frame.left * dpr),
    top: Math.round(frame.top * dpr),
    width: Math.round(frame.width * dpr),
    height: Math.round(frame.height * dpr),
  };
}

/**
 * Draws one curve as a row of thin bars, one per pixel column: each reaches from the lowest to the highest point
 * the curve takes inside its column (the samples in it, and where the lines to its neighbours cross its edges).
 *
 * Why not a stroked path: a long anti-aliased path of this width is what graphics cards are slow at (measured on
 * the development PC: about 10 ms per curve and frame, 60 times slower than the same picture made of rectangles),
 * and its cost grows with the number of samples. This costs one rectangle per column however long the capture is,
 * and a single-sample spike still shows when a hundred thousand samples share the screen.
 *
 * The caller sets the fill colour, an identity transform and the clip. `step` holds each level until the next
 * sample (a logic signal) instead of joining the samples with straight lines.
 */
export function drawCurve(
  ctx: CanvasRenderingContext2D,
  y: ArrayLike<number>,
  env: Envelope | null,
  step: boolean,
  frame: CurveFrame,
  thickness: number,
  column: number,
): void {
  const { left, top, width, height, lo, hi, v0, v1 } = frame;
  const n = y.length;
  if (n === 0 || !(hi > lo) || !(v1 > v0) || width <= 0 || height <= 0) return;
  const lastIndex = step ? n : n - 1; // a level is held for one more sample period
  const perPixel = (hi - lo) / width;
  const scale = height / (v1 - v0);
  const bottom = top + height;
  const half = thickness / 2;
  const acc: Extremes = { min: 0, max: 0 };
  // neighbouring columns of the same extent (a level that does not move) go out as one rectangle
  let runX = 0;
  let runW = 0;
  let runTop = 0;
  let runBottom = 0;

  for (let x = 0; x < width; x += column) {
    const w = Math.min(column, width - x);
    let iL = lo + x * perPixel;
    // the last column ends at hi exactly: computed, it can come out a hair short and lose the final sample
    let iR = x + w >= width ? hi : lo + (x + w) * perPixel;
    let yTop = NaN;
    let yBottom = NaN;
    if (iR >= 0 && iL <= lastIndex) {
      if (iL < 0) iL = 0;
      if (iR > lastIndex) iR = lastIndex;
      acc.min = Infinity;
      acc.max = -Infinity;
      if (step) {
        // the level at a position is the sample at or before it; a riser belongs to the column its sample is in
        extremes(y, env, Math.min(n - 1, Math.floor(iL)), Math.min(n - 1, Math.floor(iR)), acc);
      } else {
        const a = Math.ceil(iL);
        const b = Math.floor(iR);
        if (b >= a) extremes(y, env, a, b, acc);
        if (a !== iL) {
          const v = y[a - 1] + (y[a] - y[a - 1]) * (iL - (a - 1));
          if (v < acc.min) acc.min = v;
          if (v > acc.max) acc.max = v;
        }
        if (b !== iR) {
          const v = y[b] + (y[b + 1] - y[b]) * (iR - b);
          if (v < acc.min) acc.min = v;
          if (v > acc.max) acc.max = v;
        }
      }
      if (acc.max >= acc.min) {
        yTop = bottom - (acc.max - v0) * scale - half;
        yBottom = bottom - (acc.min - v0) * scale + half;
        if (yBottom < top || yTop > bottom) {
          yTop = NaN; // entirely above or below what the value axis shows
        } else {
          if (yTop < top - thickness) yTop = top - thickness;
          if (yBottom > bottom + thickness) yBottom = bottom + thickness;
        }
      }
    }
    if (runW > 0 && yTop === runTop && yBottom === runBottom) {
      runW += w;
      continue;
    }
    if (runW > 0) ctx.fillRect(left + runX, runTop, runW, runBottom - runTop);
    if (yTop === yTop) {
      runX = x;
      runW = w;
      runTop = yTop;
      runBottom = yBottom;
    } else {
      runW = 0;
    }
  }
  if (runW > 0) ctx.fillRect(left + runX, runTop, runW, runBottom - runTop);
}
