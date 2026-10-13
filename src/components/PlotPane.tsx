// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Extremes, envelopeOf, extremes, formatOnAxis, niceTicks, tickLabels } from "../analysis";
import { HoverStore } from "../hoverStore";
import { drawCurve } from "../plotDraw";
import { plotPalette, useTheme } from "../theme";

export interface PlotCurve {
  id: string;
  color: string;
  y: Float64Array;
  /** draw as logic steps (hold the level, then jump) instead of joining the samples */
  step: boolean;
}

export type CursorName = "a" | "b";

interface PlotPaneProps {
  curves: PlotCurve[];
  /** the visible part of the data, in (fractional) sample-index units */
  xRange: [number, number];
  onXRange: (range: [number, number]) => void;
  /** the index range the view may not leave: [0, samples - 1] */
  xLimit: [number, number];
  /** null: fit the visible data */
  yRange: [number, number] | null;
  onYRange: (range: [number, number] | null) => void;
  /** axis value of an index is xOrigin + index * xStep; xLabels prints the ticks of that axis */
  xOrigin: number;
  xStep: number;
  xLabels: (ticks: number[]) => string[];
  /**
   * How a position on the sample axis and a value read on a cursor line and at the pointer: with them, every such
   * line carries its place on the x axis and the value of each curve where it crosses it.
   */
  xText?: (index: number) => string;
  yText?: (value: number) => string;
  /** vertical cursors: positions on the sample axis */
  cursorA?: number | null;
  cursorB?: number | null;
  onCursor?: (which: CursorName, index: number | null) => void;
  /** horizontal cursors: values on this plot's value axis */
  levelA?: number | null;
  levelB?: number | null;
  onLevel?: (which: CursorName, value: number | null) => void;
  /** what a click places: a vertical cursor ("x", the default) or a horizontal one ("y") */
  clickSets?: "x" | "y";
  /** the sample under the pointer; shared by the charts that should show the same crosshair */
  hover: HoverStore;
  /** index of the trigger sample, drawn as a dashed line */
  marker?: number | null;
  height: number;
  emptyText?: string;
}

const MARGIN = { left: 66, right: 14, top: 8, bottom: 22 };
const MIN_SPAN = 8; // samples: closer than this there is nothing more to see
const CLICK_SLOP = 4; // px: a press that moves less is a click, not a drag
const GRAB = 5; // px: this close to a cursor line a press takes hold of it
const TAG_HEIGHT = 15; // px: one read-out on a cursor line
const TAG_FONT = "bold 11px monospace";
const TAG_GAP = 5; // px: between a line and its read-outs

/** One read-out on a cursor line: where it would like to stand (its top edge), what it says, in which colour. */
interface Tag {
  at: number;
  text: string;
  ink: string;
}

type DragMode = "zoom" | "box" | "pan" | "cursor";

interface Grab {
  kind: "x" | "y";
  which: CursorName;
}

interface Drag {
  mode: DragMode;
  grab: Grab | null;
  button: number;
  /** where the press began and where the pointer is now, on screen (client coordinates) */
  clientX0: number;
  clientY0: number;
  clientX: number;
  clientY: number;
  range: [number, number];
  shift: boolean;
}

/**
 * Has the pointer really travelled since the press? Judged on screen, not inside the chart: the page can move
 * under a resting pointer (a table further down changing its height), and that must not turn a click into a drag.
 */
function travelled(d: Drag): boolean {
  return Math.abs(d.clientX - d.clientX0) >= CLICK_SLOP || Math.abs(d.clientY - d.clientY0) >= CLICK_SLOP;
}

/** A view of the sample axis that the axis can show: inside `limit`, and not closer than there is anything to see. */
export function clampRange(lo: number, hi: number, limit: [number, number]): [number, number] {
  const full = limit[1] - limit[0];
  let span = Math.min(Math.max(hi - lo, Math.min(MIN_SPAN, full)), full);
  if (!(span > 0)) span = Math.max(full, 1);
  let start = lo + (hi - lo - span) / 2;
  start = Math.min(Math.max(start, limit[0]), limit[1] - span);
  return [start, start + span];
}

/** A value range the axis can still show: both ends finite and further apart than a few steps of a double. */
function usableRange(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && b - a > Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 64;
}

function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): CanvasRenderingContext2D | null {
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

/**
 * One chart: several curves over a sample axis. Two canvases: the picture itself, redrawn only when the data or
 * the view changes, and a transparent overlay for everything that moves on its own (crosshair, cursors, the
 * stretch being marked), so moving the mouse or a cursor costs a few lines and dots. Curves are drawn per pixel
 * column (see drawCurve): the cost does not grow with the capture, and a single-sample spike is still a visible
 * line when a hundred thousand samples share the screen. The line under the pointer and the cursors A and B say
 * where they are on the x axis and what every curve is there (xText, yText).
 *
 *   drag                zoom into the marked stretch          wheel            zoom around the pointer
 *   Ctrl + drag         zoom into the marked box (x and y)    Ctrl + wheel     zoom the value axis
 *   Shift / middle drag pan                                   Shift + wheel    pan
 *   click               cursor A                              Shift + click    cursor B
 *   drag a cursor line  move it                               double-click     show everything
 */
export const PlotPane: React.FC<PlotPaneProps> = ({
  curves,
  xRange,
  onXRange,
  xLimit,
  yRange,
  onYRange,
  xOrigin,
  xStep,
  xLabels,
  xText,
  yText,
  cursorA,
  cursorB,
  onCursor,
  levelA,
  levelB,
  onLevel,
  clickSets,
  hover,
  marker,
  height,
  emptyText,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  // what the last drawing showed: the pointer handlers and the overlay convert pixels with it
  // (ticks: where the labels of the x axis stand, left and right edge of each)
  const shown = useRef({ y0: 0, y1: 1, lo: 0, hi: 1, pw: 1, ph: 1, width: 0, ticks: [] as [number, number][] });
  // Views asked for by the wheel but not drawn yet, oldest first: the next wheel step continues from the newest
  // one, whether or not the redraw has caught up (on a slow PC several steps arrive per redraw).
  const asked = useRef<{ x: [number, number][]; y: [number, number][] }>({ x: [], y: [] });
  const drag = useRef<Drag | null>(null);
  // what follows the pointer (a pan, a cursor being moved) is applied at most once per frame
  const pending = useRef<{ frame: number; run: (() => void) | null }>({ frame: 0, run: null });
  const pointerStyle = useRef("crosshair");
  const pendingClick = useRef<{ which: CursorName; index: number; value: number } | null>(null);
  const beforeClick = useRef<{ kind: "x" | "y"; which: CursorName; prev: number | null } | null>(null);
  // the browser also reports "double-click" when one of the two presses was a drag: was the last press a click,
  // and did the pair it may belong to begin with one?
  const pressWasClick = useRef(false);
  const pairBeganAsClick = useRef(false);
  // the colours of the theme on screen: one object per theme, so a switch redraws and nothing else does
  const palette = plotPalette(useTheme());
  // handlers and the overlay are set up once; they read the current props through this
  const live = useRef({ curves, xLimit, onXRange, onYRange, onCursor, onLevel, height, cursorA, cursorB, levelA, levelB, clickSets, dpr, palette, xText, yText });
  live.current = { curves, xLimit, onXRange, onYRange, onCursor, onLevel, height, cursorA, cursorB, levelA, levelB, clickSets, dpr, palette, xText, yText };
  // what the lines of the overlay say at the moment (see data-readout below)
  const said = useRef("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // the window was moved to a screen with another scaling: draw for its pixels
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [dpr]);

  // ---- what moves on its own: cursors, the crosshair, the stretch being marked --------------------------------
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const g = shown.current;
    const s = live.current;
    if (!canvas || g.width <= 0) return;
    const ctx = fitCanvas(canvas, g.width, s.height, s.dpr);
    if (!ctx) return;
    const px = MARGIN.left;
    const py = MARGIN.top;
    const X = (i: number) => px + ((i - g.lo) / (g.hi - g.lo)) * g.pw;
    const Y = (v: number) => py + g.ph - ((v - g.y0) / (g.y1 - g.y0)) * g.ph;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, g.pw, g.ph);
    ctx.clip();
    ctx.font = TAG_FONT;

    const level = (value: number | null | undefined, color: string, label: string) => {
      if (value === null || value === undefined) return;
      const y = Math.round(Y(value));
      if (!(y >= py - 1 && y <= py + g.ph + 1)) return;
      ctx.fillStyle = color;
      for (let x = px; x < px + g.pw; x += 10) ctx.fillRect(x, y, 6, 1);
      ctx.textAlign = "right";
      const above = y > py + 14;
      ctx.textBaseline = above ? "bottom" : "top";
      ctx.fillText(`${label} ${formatOnAxis(value, g.y1 - g.y0)}`, px + g.pw - 5, above ? y - 2 : y + 3);
    };
    level(s.levelA, s.palette.cursorA, "Y1");
    level(s.levelB, s.palette.cursorB, "Y2");

    // ---- what a vertical line says: its place on the x axis, and the value of every curve it crosses ----------
    const readout: string[] = [];
    const widthOf = (text: string) => Math.ceil(ctx.measureText(text).width) + 8;
    /** one read-out: a small plate, so that it can be read on top of the curves */
    const plate = (text: string, left: number, top: number, w: number, edge: string, paper: string, ink: string) => {
      ctx.fillStyle = edge;
      ctx.fillRect(left, top, w, TAG_HEIGHT);
      ctx.fillStyle = paper;
      ctx.fillRect(left + 1, top + 1, w - 2, TAG_HEIGHT - 2);
      ctx.fillStyle = ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, left + 4, top + TAG_HEIGHT / 2 + 0.5);
    };
    /** the value of every curve at a sample, each to stand at the height of its point */
    const valuesAt = (index: number): Tag[] => {
      const yText = s.yText;
      if (!yText || !Number.isInteger(index) || index < 0) return [];
      return s.curves.flatMap((c) =>
        index < c.y.length ? [{ at: Y(c.y[index]) - TAG_HEIGHT / 2, text: yText(c.y[index]), ink: c.color }] : [],
      );
    };
    // the room beside the lines that read-outs stand in already: left and right edge of each column of them
    const taken: [number, number][] = [];
    /**
     * The read-outs of one line, beside it. On the side asked for where there is room - inside the plot, and not
     * on the read-outs of another line -, else on the other side, else moved on past what stands in the way. One
     * below the other where they would cover each other: the first of them (a cursor's name and place) keeps the
     * top of the line, and what the plot is too low for leaves at the bottom.
     */
    const tagsBeside = (x: number, tags: Tag[], edge: string, side: 1 | -1) => {
      if (tags.length === 0) return;
      const widths = tags.map((t) => widthOf(t.text));
      const widest = Math.max(...widths);
      const end = px + g.pw;
      const inTheWay = (left: number) => taken.find(([l, r]) => left < r + 2 && left + widest > l - 2);
      const beside = (d: number) => (d > 0 ? x + TAG_GAP : x - TAG_GAP - widest);
      const inside = (left: number) => left >= px && left + widest <= end;
      /** where the column can begin on one side: right beside the line, or (moved) past what stands there */
      const room = (d: number, moved: boolean): number | null => {
        let left = beside(d);
        let wasMoved = false;
        for (let other = inTheWay(left); other; other = inTheWay(left)) {
          if (!moved) return null;
          left = d > 0 ? other[1] + 2 : other[0] - 2 - widest;
          wasMoved = true;
        }
        // moved, it must not come to stand on a cursor's line, or right beside it where that line's own
        // read-outs belong: its values would be read as that cursor's
        if (wasMoved && cursors.some((c) => c.x !== x && c.x > left - TAG_GAP - 2 && c.x < left + widest + TAG_GAP + 2)) return null;
        return inside(left) ? left : null;
      };
      let dir: number = side;
      let left = room(side, false);
      for (const [d, moved] of [[-side, false], [side, true], [-side, true]] as const) {
        if (left !== null) break;
        left = room(d, moved);
        if (left !== null) dir = d;
      }
      // a plot too narrow for all of it: as far inside as it goes
      if (left === null) left = Math.max(px, Math.min(beside(side), end - widest));
      taken.push([left, left + widest]);
      const order = tags.map((_, k) => k).sort((i, j) => tags[i].at - tags[j].at);
      const tops: number[] = [];
      let to = py + g.ph - 2;
      for (let o = order.length - 1; o >= 0; o--) {
        const k = order[o];
        tops[k] = Math.min(tags[k].at, to - TAG_HEIGHT);
        to = tops[k];
      }
      let from = py + 2;
      for (const k of order) {
        tops[k] = Math.max(tops[k], from);
        from = tops[k] + TAG_HEIGHT;
      }
      for (const k of order) {
        // each read-out against the edge of the column that is nearer to the line
        plate(tags[k].text, dir > 0 ? left : left + widest - widths[k], Math.round(tops[k]), widths[k], edge, s.palette.background, tags[k].ink);
      }
    };

    const cursorLine = (index: number | null | undefined, color: string, label: string) => {
      if (index === null || index === undefined) return null;
      const x = Math.round(X(index));
      if (!(x >= px - 1 && x <= px + g.pw + 1)) return null;
      ctx.fillStyle = color;
      ctx.fillRect(x, py, 1, g.ph);
      // where the cursor reads each curve
      for (const c of s.curves) {
        if (index < 0 || index >= c.y.length || !Number.isInteger(index)) continue;
        ctx.fillRect(x - 2, Math.round(Y(c.y[index])) - 2, 5, 5);
      }
      // its name and its place at the top of the line, the values below
      const place = s.xText ? `${label} ${s.xText(index)}` : label;
      const values = valuesAt(index);
      readout.push(`${place}: ${values.map((t) => t.text).join(", ")}`);
      const tags: Tag[] = [{ at: -Infinity, text: place, ink: color }, ...values];
      return { x, color, tags, reach: x + TAG_GAP + Math.max(...tags.map((t) => widthOf(t.text))) };
    };
    // both lines first, then what they say - from left to right: the left one of two reads to its left when its
    // read-outs would reach those of the other
    const cursors = [cursorLine(s.cursorA, s.palette.cursorA, "A"), cursorLine(s.cursorB, s.palette.cursorB, "B")]
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((p, q) => p.x - q.x);
    cursors.forEach((c, i) => {
      const next = cursors[i + 1];
      // where the read-outs of the next line begin: at the line when they stand on its right, a column before it
      // when the plot ends on its right
      const until = next === undefined ? Infinity : next.reach > px + g.pw ? 2 * next.x - next.reach : next.x;
      tagsBeside(c.x, c.tags, c.color, c.reach + 2 > until ? -1 : 1);
    });

    const d = drag.current;
    const index = hover.get();
    let hoverX: number | null = null;
    if (index !== null) {
      const x = Math.round(X(index));
      if (x >= px - 1 && x <= px + g.pw + 1) {
        hoverX = x;
        ctx.fillStyle = s.palette.hoverLine;
        ctx.fillRect(x, py, 1, g.ph);
        for (const c of s.curves) {
          if (index < 0 || index >= c.y.length) continue;
          ctx.fillStyle = c.color;
          ctx.beginPath();
          ctx.arc(X(index), Y(c.y[index]), 3.2, 0, 2 * Math.PI);
          ctx.fill();
        }
        const values = valuesAt(index);
        // On a cursor's line, or as good as on it, the cursor's own read-outs stand there: those of the sample
        // beside it would cover them, under the cursor's name.
        if (!cursors.some((c) => Math.abs(c.x - x) <= GRAB)) tagsBeside(x, values, s.palette.hoverLine, 1);
        readout.push(`hover ${s.xText ? s.xText(index) : index}: ${values.map((t) => t.text).join(", ")}`);
      }
    }

    if (d && (d.mode === "zoom" || d.mode === "box") && travelled(d) && hostRef.current) {
      const rect = hostRef.current.getBoundingClientRect();
      const x0 = Math.min(d.clientX0, d.clientX) - rect.left;
      const x1 = Math.max(d.clientX0, d.clientX) - rect.left;
      ctx.fillStyle = s.palette.selectionFill;
      ctx.strokeStyle = s.palette.selectionStroke;
      ctx.lineWidth = 1;
      if (d.mode === "box") {
        const top = Math.min(d.clientY0, d.clientY) - rect.top;
        const tall = Math.abs(d.clientY - d.clientY0);
        ctx.fillRect(x0, top, x1 - x0, tall);
        ctx.strokeRect(x0 + 0.5, top + 0.5, x1 - x0, tall);
      } else {
        ctx.fillRect(x0, py, x1 - x0, g.ph);
        ctx.strokeRect(x0 + 0.5, py + 0.5, x1 - x0, g.ph - 1);
      }
    }
    ctx.restore();

    // where the pointer is on the x axis: a tag on the axis itself, over the labels of its ticks
    if (hoverX !== null && index !== null && s.xText) {
      ctx.font = TAG_FONT;
      const text = s.xText(index);
      const w = widthOf(text);
      const left = Math.round(Math.min(Math.max(hoverX - w / 2, 1), g.width - w - 1));
      const top = py + g.ph + 3;
      // the labels of the axis it reaches are taken away whole: what is left of one beside the tag reads as part of it
      ctx.fillStyle = s.palette.margin;
      for (const [l, r] of g.ticks) {
        if (l < left + w + 3 && r > left - 3) ctx.fillRect(Math.floor(l) - 1, top - 1, Math.ceil(r - l) + 2, TAG_HEIGHT + 2);
      }
      ctx.fillStyle = s.palette.background;
      ctx.fillRect(left, top, w, TAG_HEIGHT);
      plate(text, left, top, w, s.palette.axisText, s.palette.axisText, s.palette.background);
    }

    // the same as text on the element, for what cannot read a canvas (the tests of the app); written only when
    // what the lines say has changed
    const now = readout.join(" | ");
    if (now !== said.current) {
      said.current = now;
      hostRef.current?.setAttribute("data-readout", now);
    }
  }, [hover]);

  useEffect(() => hover.subscribe(drawOverlay), [hover, drawOverlay]);
  useEffect(() => {
    drawOverlay();
  }, [cursorA, cursorB, levelA, levelB, xText, yText, drawOverlay]);

  // ---- the picture --------------------------------------------------------------------------------------------
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas || width <= 0) return;
    const ctx = fitCanvas(canvas, width, height, dpr);
    if (!ctx) return;

    const px = MARGIN.left;
    const py = MARGIN.top;
    const pw = Math.max(10, width - MARGIN.left - MARGIN.right);
    const ph = Math.max(10, height - MARGIN.top - MARGIN.bottom);
    const [lo, hi] = xRange[1] > xRange[0] ? xRange : [xRange[0], xRange[0] + 1];

    // value axis: the given range, or the extremes of what is visible plus a little air
    let y0 = Infinity;
    let y1 = -Infinity;
    if (yRange && usableRange(yRange[0], yRange[1])) {
      [y0, y1] = yRange;
    } else {
      const acc: Extremes = { min: Infinity, max: -Infinity };
      for (const c of curves) {
        const a = Math.max(0, Math.floor(lo));
        const b = Math.min(c.y.length - 1, Math.ceil(hi));
        if (b >= a) extremes(c.y, envelopeOf(c.y), a, b, acc);
      }
      y0 = acc.min;
      y1 = acc.max;
      if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
        y0 = 0;
        y1 = 1;
      }
      const pad = y1 > y0 ? (y1 - y0) * 0.06 : Math.max(1, Math.abs(y0) * 0.05);
      y0 -= pad;
      y1 += pad;
    }
    const ticks: [number, number][] = [];
    shown.current = { y0, y1, lo, hi, pw, ph, width, ticks };
    // requests up to the one drawn now are done, later ones are still on their way; a view this plot never
    // asked for (a reset, another plot's zoom) makes all of them void
    const after = (list: [number, number][], drawn: [number, number] | null) => {
      if (drawn) {
        const tolerance = 1e-9 * Math.max(1, Math.abs(drawn[0]), Math.abs(drawn[1]));
        for (let k = list.length - 1; k >= 0; k--) {
          if (Math.abs(list[k][0] - drawn[0]) <= tolerance && Math.abs(list[k][1] - drawn[1]) <= tolerance) {
            return list.slice(k + 1);
          }
        }
      }
      return [];
    };
    asked.current = { x: after(asked.current.x, xRange), y: after(asked.current.y, yRange) };

    const X = (i: number) => px + ((i - lo) / (hi - lo)) * pw;
    const Y = (v: number) => py + ph - ((v - y0) / (y1 - y0)) * ph;

    // frame, grid and axis labels
    ctx.fillStyle = palette.background;
    ctx.fillRect(px, py, pw, ph);
    ctx.font = "10px monospace";
    const vLo = xOrigin + lo * xStep;
    const vHi = xOrigin + hi * xStep;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    const xTicks = niceTicks(Math.min(vLo, vHi), Math.max(vLo, vHi), Math.max(2, Math.floor(pw / 110)));
    const xTickText = xLabels(xTicks);
    xTicks.forEach((t, k) => {
      const x = Math.round(X((t - xOrigin) / xStep));
      ctx.fillStyle = palette.grid;
      ctx.fillRect(x, py, 1, ph);
      ctx.fillStyle = palette.axisText;
      // keep the outermost labels inside the picture instead of letting the edge cut them
      const label = xTickText[k] ?? "";
      const half = ctx.measureText(label).width / 2;
      const middle = Math.min(Math.max(x, px + half), width - half - 2);
      ctx.fillText(label, middle, py + ph + 5);
      ticks.push([middle - half, middle + half]);
    });
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    const yTicks = niceTicks(y0, y1, Math.max(2, Math.floor(ph / 30)));
    const yText = tickLabels(yTicks, 10);
    yTicks.forEach((t, k) => {
      const y = Math.round(Y(t));
      ctx.fillStyle = t === 0 ? palette.zeroLine : palette.grid;
      ctx.fillRect(px, y, pw, 1);
      ctx.fillStyle = palette.axisText;
      // a label longer than the gutter is condensed rather than losing its leading digits
      ctx.fillText(yText[k] ?? "", px - 6, y + 0.5, px - 8);
    });
    ctx.strokeStyle = palette.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    if (curves.length === 0) {
      ctx.fillStyle = palette.emptyText;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emptyText || "No signal in this plot", px + pw / 2, py + ph / 2);
    }

    // the curves, in the canvas' own pixels so that every bar is exactly one column wide
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const frame = {
      left: Math.round(px * dpr),
      top: Math.round(py * dpr),
      width: Math.round(pw * dpr),
      height: Math.round(ph * dpr),
      lo,
      hi,
      v0: y0,
      v1: y1,
    };
    ctx.beginPath();
    ctx.rect(frame.left, frame.top, frame.width, frame.height);
    ctx.clip();
    for (const c of curves) {
      ctx.fillStyle = c.color;
      drawCurve(ctx, c.y, envelopeOf(c.y), c.step, frame, 1.4 * dpr, Math.max(1, Math.round(dpr)));
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, pw, ph);
    ctx.clip();
    // the individual samples, once they are far enough apart to be told from each other
    if (pw / (hi - lo) >= 9) {
      for (const c of curves) {
        const a = Math.max(0, Math.floor(lo));
        const b = Math.min(c.y.length - 1, Math.ceil(hi));
        ctx.fillStyle = c.color;
        for (let i = a; i <= b; i++) {
          ctx.beginPath();
          ctx.arc(X(i), Y(c.y[i]), 2.2, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }
    if (marker !== null && marker !== undefined) {
      const x = Math.round(X(marker));
      if (x >= px - 1 && x <= px + pw + 1) {
        ctx.fillStyle = palette.trigger;
        for (let y = py; y < py + ph; y += 8) ctx.fillRect(x, y, 1, 4);
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText("TRIG", x + 4, py + ph - 3);
      }
    }
    ctx.restore();

    drawOverlay(); // the geometry under the cursors and the crosshair has changed
  }, [curves, xRange, yRange, width, height, dpr, marker, xOrigin, xStep, xLabels, emptyText, palette, drawOverlay]);

  // ---- pointer --------------------------------------------------------------------------------------------
  const local = (e: { clientX: number; clientY: number }) => {
    const rect = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const indexAt = (x: number) => {
    const { lo, hi, pw } = shown.current;
    return lo + ((x - MARGIN.left) / pw) * (hi - lo);
  };
  const valueAt = (y: number) => {
    const { y0, y1, ph } = shown.current;
    return y0 + ((MARGIN.top + ph - y) / ph) * (y1 - y0);
  };
  const snapped = (x: number) => Math.round(Math.min(Math.max(indexAt(x), xLimit[0]), xLimit[1]));
  /** the value a horizontal cursor gets at a pointer position: inside the axis, rounded to about a pixel's worth */
  const levelAt = (y: number) => {
    const { y0, y1, ph } = shown.current;
    const value = Math.min(Math.max(valueAt(y), y0), y1);
    const quantum = 10 ** Math.floor(Math.log10((y1 - y0) / ph));
    return quantum > 0 && Number.isFinite(quantum) ? Math.round(value / quantum) * quantum : value;
  };
  const inPlot = (p: { x: number; y: number }, slack = 0) => {
    const { pw, ph } = shown.current;
    return (
      p.x >= MARGIN.left - slack && p.x <= MARGIN.left + pw + slack && p.y >= MARGIN.top - slack && p.y <= MARGIN.top + ph + slack
    );
  };

  /** the cursor line under the pointer, if any; of two that cross there, the kind a click would place */
  const grabAt = (p: { x: number; y: number }): Grab | null => {
    if (!inPlot(p, GRAB)) return null;
    const g = shown.current;
    const dx = (index: number | null | undefined) =>
      index === null || index === undefined || !onCursor
        ? Infinity
        : Math.abs(MARGIN.left + ((index - g.lo) / (g.hi - g.lo)) * g.pw - p.x);
    const dy = (value: number | null | undefined) =>
      value === null || value === undefined || !onLevel
        ? Infinity
        : Math.abs(MARGIN.top + g.ph - ((value - g.y0) / (g.y1 - g.y0)) * g.ph - p.y);
    const candidates: Array<[number, Grab]> = [
      [dx(cursorA), { kind: "x", which: "a" }],
      [dx(cursorB), { kind: "x", which: "b" }],
      [dy(levelA), { kind: "y", which: "a" }],
      [dy(levelB), { kind: "y", which: "b" }],
    ];
    if (clickSets === "y") candidates.reverse();
    let best: Grab | null = null;
    let bestDistance = GRAB;
    for (const [distance, grab] of candidates) {
      if (distance < bestDistance || (distance === bestDistance && !best)) {
        best = grab;
        bestDistance = distance;
      }
    }
    return best;
  };

  const schedule = (run: () => void) => {
    pending.current.run = run;
    if (pending.current.frame) return;
    pending.current.frame = requestAnimationFrame(() => {
      const next = pending.current.run;
      pending.current = { frame: 0, run: null };
      next?.();
    });
  };

  const setPointerStyle = (grab: Grab | null, panning = false) => {
    const style = panning ? "grabbing" : grab ? (grab.kind === "x" ? "ew-resize" : "ns-resize") : "crosshair";
    if (hostRef.current && pointerStyle.current !== style) {
      pointerStyle.current = style;
      hostRef.current.style.cursor = style;
    }
  };

  const endDrag = () => {
    drag.current = null;
    setPointerStyle(null);
    drawOverlay();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const p = local(e);
    const grab = e.button === 0 && !e.shiftKey && !e.ctrlKey ? grabAt(p) : null;
    const mode: DragMode = grab ? "cursor" : e.button === 1 || e.shiftKey ? "pan" : e.ctrlKey ? "box" : "zoom";
    try {
      e.currentTarget.setPointerCapture(e.pointerId); // keeps the drag alive outside the chart
    } catch {
      /* not every pointer can be captured; the drag then simply ends at the edge */
    }
    pendingClick.current = null;
    pressWasClick.current = false;
    drag.current = {
      mode,
      grab,
      button: e.button,
      clientX0: e.clientX,
      clientY0: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      range: xRange,
      shift: e.shiftKey,
    };
    setPointerStyle(grab, mode === "pan");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (drag.current && e.buttons === 0) endDrag(); // the release went somewhere else (another window took over)
    const d = drag.current;
    if (d) {
      d.clientX = e.clientX;
      d.clientY = e.clientY;
    }
    const inside = p.x >= MARGIN.left && p.x <= MARGIN.left + shown.current.pw;
    // A cursor line that is being moved is the line under the pointer - in every plot that shares the pointer. It
    // arrives a frame after the pointer (it goes through the state of the app): the pointer's own line would run
    // ahead of it with a second set of values.
    const movingCursor = d !== null && d.mode === "cursor" && d.grab?.kind === "x" && travelled(d);
    hover.set(movingCursor ? null : inside || d ? snapped(p.x) : null);
    if (!d) {
      setPointerStyle(grabAt(p));
      return;
    }
    if (d.mode === "cursor" && d.grab) {
      // only once the pointer has really travelled: a press on a cursor line is still a click
      if (!travelled(d)) return;
      const { which, kind } = d.grab;
      const g = shown.current;
      if (kind === "x") {
        // stays inside what is visible, so it can be taken hold of again
        const index = Math.min(Math.max(snapped(p.x), Math.ceil(g.lo)), Math.floor(g.hi));
        schedule(() => live.current.onCursor?.(which, index));
      } else {
        const value = levelAt(p.y);
        schedule(() => live.current.onLevel?.(which, value));
      }
    } else if (d.mode === "pan") {
      const span = d.range[1] - d.range[0];
      const shift = ((d.clientX - d.clientX0) / shown.current.pw) * span;
      const next = clampRange(d.range[0] - shift, d.range[1] - shift, xLimit);
      schedule(() => live.current.onXRange(next));
    } else {
      drawOverlay();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    d.clientX = e.clientX;
    d.clientY = e.clientY;
    endDrag();
    if (!travelled(d)) {
      // A click. The browser's own click event follows and knows whether this is the second half of a
      // double-click; the cursor is placed there. Presses in the axis margins place nothing.
      pressWasClick.current = d.button === 0;
      if (d.button === 0 && inPlot(p)) {
        pendingClick.current = { which: d.shift ? "b" : "a", index: snapped(p.x), value: levelAt(p.y) };
      }
      return;
    }
    if (d.mode === "pan" || d.mode === "cursor") return;
    // what was marked ends at the frame, also when the pointer went on beyond it
    const inX = (x: number) => Math.min(Math.max(x, MARGIN.left), MARGIN.left + shown.current.pw);
    const inY = (y: number) => Math.min(Math.max(y, MARGIN.top), MARGIN.top + shown.current.ph);
    // where the press began, in the chart as it lies now
    const start = { x: p.x - (d.clientX - d.clientX0), y: p.y - (d.clientY - d.clientY0) };
    const xa = inX(Math.min(start.x, p.x));
    const xb = inX(Math.max(start.x, p.x));
    if (Math.abs(p.x - start.x) >= CLICK_SLOP && xb > xa) {
      onXRange(clampRange(indexAt(xa), indexAt(xb), xLimit));
    }
    if (d.mode === "box" && Math.abs(p.y - start.y) >= CLICK_SLOP) {
      const a = valueAt(inY(Math.max(start.y, p.y)));
      const b = valueAt(inY(Math.min(start.y, p.y)));
      if (usableRange(a, b)) onYRange([a, b]);
    }
  };

  const onClick = (e: React.MouseEvent) => {
    const c = pendingClick.current;
    pendingClick.current = null;
    if (e.detail <= 1) {
      // a new sequence of clicks: nothing of an older one is to be put back by a double-click
      beforeClick.current = null;
      pairBeganAsClick.current = pressWasClick.current;
    }
    if (!c || e.detail > 1) return;
    if (clickSets === "y" && onLevel) {
      beforeClick.current = { kind: "y", which: c.which, prev: (c.which === "a" ? levelA : levelB) ?? null };
      onLevel(c.which, c.value);
    } else if (onCursor) {
      beforeClick.current = { kind: "x", which: c.which, prev: (c.which === "a" ? cursorA : cursorB) ?? null };
      onCursor(c.which, c.index);
    }
  };

  const onDoubleClick = () => {
    const b = beforeClick.current;
    beforeClick.current = null;
    const both = pairBeganAsClick.current && pressWasClick.current;
    pairBeganAsClick.current = false;
    if (!both) return; // one half of the pair was a drag and has done its own work
    // the first click of the pair placed a cursor: put it back, a double-click only resets the view
    if (b) {
      if (b.kind === "x") onCursor?.(b.which, b.prev);
      else onLevel?.(b.which, b.prev);
    }
    onXRange([xLimit[0], Math.max(xLimit[1], xLimit[0] + 1)]);
    onYRange(null);
  };

  // the wheel listener must be able to stop the page from scrolling, which React's own (passive) one cannot
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1; // lines and pages, in pixels
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && dx === 0) {
        // Shift + wheel is a sideways wheel; not every system turns it into one by itself
        dx = dy;
        dy = 0;
      }
      const g = shown.current;
      const [lo, hi] = asked.current.x[asked.current.x.length - 1] ?? [g.lo, g.hi];
      if (Math.abs(dx) > Math.abs(dy)) {
        const shift = (dx / g.pw) * (hi - lo);
        const next = clampRange(lo + shift, hi + shift, live.current.xLimit);
        asked.current.x.push(next);
        live.current.onXRange(next);
        return;
      }
      if (dy === 0) return;
      // one notch of a wheel is about 100: a touchpad sends many small steps and gets a smooth zoom
      const factor = Math.pow(1.25, Math.max(-3, Math.min(3, dy / 100)));
      if (e.ctrlKey) {
        const [y0, y1] = asked.current.y[asked.current.y.length - 1] ?? [g.y0, g.y1];
        const anchor = y0 + ((MARGIN.top + g.ph - (e.clientY - rect.top)) / g.ph) * (y1 - y0);
        const a = anchor - (anchor - y0) * factor;
        const b = anchor + (y1 - anchor) * factor;
        if (!usableRange(a, b)) return;
        asked.current.y.push([a, b]);
        live.current.onYRange([a, b]);
        return;
      }
      const limit = live.current.xLimit;
      const least = Math.min(MIN_SPAN, limit[1] - limit[0]);
      if (factor < 1 && hi - lo <= least * (1 + 1e-9)) return; // nothing closer to zoom into: stay put
      const by = factor < 1 ? Math.max(factor, least / (hi - lo)) : factor;
      const anchor = lo + ((e.clientX - rect.left - MARGIN.left) / g.pw) * (hi - lo);
      const next = clampRange(anchor - (anchor - lo) * by, anchor + (hi - anchor) * by, limit);
      asked.current.x.push(next);
      live.current.onXRange(next);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheel);
      if (pending.current.frame) cancelAnimationFrame(pending.current.frame);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="plot-pane-host"
      data-x-range={`${Math.round(xRange[0])},${Math.round(xRange[1])}`}
      style={{ height, cursor: "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => {
        // normally the release itself has ended the drag just before; this is for a capture taken away mid-drag
        if (drag.current) endDrag();
      }}
      onPointerLeave={() => {
        if (drag.current) return;
        hover.set(null);
        setPointerStyle(null);
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={baseRef} className="plot-pane-canvas" style={{ width: "100%", height }} />
      <canvas ref={overlayRef} className="plot-pane-canvas plot-pane-overlay" style={{ width: "100%", height }} />
    </div>
  );
};
