// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ComparedCapture, SignalData, WaveformResult } from "../types";
import {
  EdgeStats,
  MAX_FFT,
  RangeStats,
  SignMode,
  Spectrum,
  Tone,
  Transform,
  decimalsOf,
  edgeDelays,
  edgeStats,
  formatOnAxis,
  formatSI,
  formatSIStep,
  formatValue,
  fundamentalTone,
  looksSigned,
  phaseAgainst,
  prepareCurve,
  rangeStats,
  repeats,
  siTickLabels,
  spectrum,
  spectrumPeak,
  spectrumPoints,
  tickLabels,
  toDecimals,
  trimNumber,
} from "../analysis";
import { HoverStore } from "../hoverStore";
import { CURVE_SLOTS, curveColor, plotPalette, useTheme } from "../theme";
import { CursorName, PlotCurve, PlotPane, clampRange } from "./PlotPane";
import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  EyeOff,
  Layers,
  Link2,
  Maximize2,
  Plus,
  Search,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";

interface CurveConfig {
  id: string;
  /** full (hierarchical) name of the capture column */
  signal: string;
  /**
   * The file of the capture this curve is pinned to: one of those chosen with "Compare". It stays what it is while
   * one steps through the captures. Absent: the curve shows the capture on screen.
   */
  capture?: string;
  sign: SignMode;
  transform: Transform;
  /** samples of the moving average */
  window: number;
  color: string;
  /**
   * Switched off with a click on its name in the plot's header, like a channel of an oscilloscope: it keeps its
   * place and its settings there, but is not drawn, read out or measured, and the value axis is fitted without it.
   */
  hidden?: boolean;
}

interface PaneConfig {
  id: string;
  curves: CurveConfig[];
  /** "fft": the pane shows the spectrum of its curves instead of the curves themselves */
  mode: "time" | "fft";
}

/** what a pane currently shows; null = everything (x) / fitted to the data (y) */
interface PaneView {
  x: [number, number] | null;
  y: [number, number] | null;
}

/** the horizontal cursors of one plot: two values on its value axis */
interface PaneLevels {
  a: number | null;
  b: number | null;
}

interface AnalysisPanelProps {
  waveform: WaveformResult | null;
  samplePeriodNs: number;
  onSamplePeriodChange: (ns: number) => void;
  /** offered in the main window: move the view into a window of its own */
  onPopOut?: () => void;
  /** offered in that window: go back into the main one */
  onDock?: () => void;
  /** shown at the top right of the toolbar: the control that steps through the captures of the session */
  captureNav?: React.ReactNode;
  /** a button of the toolbar: brings captures from disk into that list */
  captureImport?: React.ReactNode;
  /** shown under the navigator: the control that chooses the captures laid over the one on screen */
  captureCompare?: React.ReactNode;
  /** those captures, in the order chosen: each is a group of the signal list, and curves can be pinned to it */
  compare?: ComparedCapture[];
  /** takes one of them out of the comparison (the button of its group) */
  onCompareRemove?: (path: string) => void;
  /**
   * Number and name of a capture of the session, by its file: a curve pinned to a capture that is not compared
   * any more still says which one it was. To be the same function from render to render.
   */
  captureOf?: (path: string) => { id: number; name: string } | undefined;
}

interface Resolved {
  y: Float64Array;
  signal: SignalData;
  signed: boolean;
  /** characters the widest value of this curve needs: the read-out keeps that width, so it does not jitter */
  digits: number;
}

interface SignalFact {
  signed: boolean;
  /** how often the signal changes in its capture: 0 = constant */
  changes: number;
}

/** What the analysis works out about a capture once, whatever it is used for afterwards. */
interface CaptureFacts {
  signals: Map<string, SignalData>;
  facts: Map<string, SignalFact>;
  /** signals that never change */
  constants: number;
}

// Kept for as long as the parsed capture itself lives: a capture that is compared, or that comes back on screen,
// is not looked through again because another one was added, removed or has finished loading.
const captureFacts = new WeakMap<WaveformResult, CaptureFacts>();

function factsOf(wave: WaveformResult): CaptureFacts {
  let known = captureFacts.get(wave);
  if (!known) {
    known = { signals: new Map(), facts: new Map(), constants: 0 };
    for (const s of wave.signals) {
      let changes = 0;
      for (let i = 1; i < s.values.length; i++) if (s.values[i] !== s.values[i - 1]) changes++;
      known.signals.set(s.fullName, s);
      // a bus the file itself wrote signed is signed; any other is judged by its values
      known.facts.set(s.fullName, { signed: s.isBus && (s.signed === true || looksSigned(s.values, s.width)), changes });
      if (changes === 0) known.constants++;
    }
    captureFacts.set(wave, known);
  }
  return known;
}

const NO_FACTS: CaptureFacts = { signals: new Map(), facts: new Map(), constants: 0 };

/** One capture as the curves see it: its data, and the samples prepared from it so far (see cacheKey). */
interface CaptureSource {
  wave: WaveformResult;
  facts: CaptureFacts;
  prepared: Map<string, Resolved>;
}

/** What a plot shows of the capture a curve is pinned to. */
interface PinnedInfo {
  /** its number in the session; 0 when it is not known (any more) */
  id: number;
  name: string;
  /**
   * gone: not in the comparison (any more) · loading / failed: its file · step: thinned differently from the
   * capture on screen, so its samples do not lie where those lie
   */
  state: "ok" | "loading" | "failed" | "step" | "gone";
}

const PINNED_NOTE: Record<PinnedInfo["state"], string> = {
  ok: "not in that capture",
  loading: "loading...",
  failed: "could not be read",
  step: "other sample spacing",
  gone: "not compared",
};
const NOT_COMPARED = "This capture is not in the comparison any more";
const OTHER_STEP = "This capture was thinned differently from the one on screen: it cannot be laid over it";
const NO_COMPARE: ComparedCapture[] = [];
/** characters of a capture's name that a group of the signal list always shows of its end ("_001_0003") */
const NAME_TAIL = 9;

/** "20250101_120000_unit/cap_run_001_0003": the folder tells apart captures that all have the same file name */
const captureName = (path: string) => {
  const parts = path.split(/[\\/]/);
  const file = (parts.pop() || path).replace(/\.(csv|ila)$/i, "");
  const folder = parts.pop();
  return folder ? `${folder}/${file}` : file;
};

interface Axis {
  xOrigin: number;
  xStep: number;
  xLabels: (ticks: number[]) => string[];
  /** a position on the axis as a cursor line says it: the sample, or its time to the last digit that matters */
  xText: (index: number) => string;
  /** seconds per captured sample; 0 when unknown */
  period: number;
  /** captured samples per plotted point (1 unless the capture was thinned for display) */
  stride: number;
  firstSample: number;
  triggerSample: number | null;
}

interface Actions {
  activate: (paneId: string) => void;
  setX: (paneId: string, range: [number, number]) => void;
  setY: (paneId: string, range: [number, number] | null) => void;
  setCursor: (which: CursorName, index: number | null) => void;
  setLevel: (paneId: string, which: CursorName, value: number | null) => void;
  updatePane: (paneId: string, change: (p: PaneConfig) => PaneConfig) => void;
  updateCurve: (paneId: string, curveId: string, change: Partial<CurveConfig>) => void;
  removePane: (paneId: string) => void;
}

const LAYOUT_KEY = "ila-studio-plots-v1";
/** the layout that was on screen before a capture of another design replaced it: it comes back with its design */
const OTHER_LAYOUT_KEY = "ila-studio-plots-v1-other";
/** zoom, cursors and click mode of the panel that was open last: taken over by the window the analysis moves to */
const HANDOVER_KEY = "ila-studio-plots-handover";
/** "1" while the signal list leaves out the signals that never change */
const HIDE_CONST_KEY = "ila-studio-hide-const";
/** what a curve's `color` holds: its slot in the list of curve colours; how it looks is the theme's (curveColor) */
const COLORS = CURVE_SLOTS;
const TRANSFORM_LABEL: Record<Transform, string> = {
  raw: "value",
  derivative: "Δ per sample",
  moving_average: "moving avg",
  abs: "|x|",
};
/** what the prepared samples of a curve depend on, besides the capture */
const cacheKey = (c: CurveConfig, signed: boolean) =>
  `${c.signal}|${signed}|${c.transform}|${c.transform === "moving_average" ? c.window : 0}`;
const NO_VIEW: PaneView = { x: null, y: null };
const NO_LEVELS: PaneLevels = { a: null, b: null };
/** shown in a plot whose signals are all switched off */
const SWITCHED_OFF = "Switched off: click a signal's name above to show it again";
/** measurements and spectra follow a zoom or a cursor once it has rested this long, not at every step on the way */
const SETTLE_MS = 120;
/** how old the view handed from one window to the other may be (pop out / dock) */
const HANDOVER_MAX_AGE_MS = 30_000;

/** what is not part of the layout but should survive the analysis moving to another window */
interface Handover {
  at: number;
  /** samples of the capture it belongs to: positions mean nothing in a capture of another length */
  count: number;
  sharedX: [number, number] | null;
  cursorA: number | null;
  cursorB: number | null;
  cursorMode: "x" | "y";
  active: number;
  /** per plot, in the order of the layout */
  views: PaneView[];
  levels: PaneLevels[];
}

function loadHandover(): Handover | null {
  try {
    const h = JSON.parse(localStorage.getItem(HANDOVER_KEY) || "null");
    if (!h || typeof h.at !== "number" || !Array.isArray(h.views) || !Array.isArray(h.levels)) return null;
    return Date.now() - h.at <= HANDOVER_MAX_AGE_MS ? (h as Handover) : null;
  } catch {
    return null;
  }
}

let nextId = 1;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${nextId++}`;
const emptyPane = (): PaneConfig => ({ id: newId("p"), curves: [], mode: "time" });

// A panel has read its layout in this window before: the next one to do so is the view coming back from its own
// window, not the start of the application. (Set in an effect, so that rendering twice does not count as two.)
let panelSeenBefore = false;

/**
 * `keepPinned` false leaves out the curves pinned to a compared capture: the comparison lasts for a session, so
 * what a layout of an earlier session was pinned to does not exist any more.
 */
function loadLayout(
  key: string = LAYOUT_KEY,
  keepPinned = false,
): { panes: PaneConfig[]; xUnit: "samples" | "time"; linkX: boolean } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved || !Array.isArray(saved.panes) || saved.panes.length === 0) return null;
    const panes: PaneConfig[] = saved.panes.map((p: PaneConfig) => ({
      id: newId("p"),
      curves: (Array.isArray(p.curves) ? p.curves : [])
        .filter((c) => c && typeof c.signal === "string" && (keepPinned || typeof c.capture !== "string"))
        .map((c, i) => ({
          id: newId("c"),
          signal: c.signal,
          ...(typeof c.capture === "string" ? { capture: c.capture } : {}),
          sign: c.sign === "signed" || c.sign === "unsigned" ? c.sign : "auto",
          transform: c.transform in TRANSFORM_LABEL ? c.transform : "raw",
          window: Math.max(1, Math.round(Number(c.window)) || 16),
          color: typeof c.color === "string" ? c.color : COLORS[i % COLORS.length],
          hidden: c.hidden === true,
        })),
      mode: p.mode === "fft" ? "fft" : "time",
    }));
    return { panes, xUnit: saved.xUnit === "time" ? "time" : "samples", linkX: saved.linkX === true };
  } catch {
    return null;
  }
}

/** The number under the pointer (or at cursor A): only this little component re-renders when the pointer moves. */
const HoverValue: React.FC<{
  store: HoverStore;
  fallback: number | null;
  y: Float64Array | undefined;
  format: (v: number) => string;
  /** fixed width in characters: a number changing its length must not push the header around */
  digits: number;
}> = ({ store, fallback, y, format, digits }) => {
  const index = useSyncExternalStore(store.subscribe, store.get) ?? fallback;
  const shown = y && index !== null && index >= 0;
  // beyond the end of a compared capture that is shorter than the one on screen there is nothing to read
  return <b style={{ width: `${digits}ch` }}>{shown ? (index < y.length ? format(y[index]) : "-") : ""}</b>;
};

const formatDb = (v: number) => `${v.toFixed(1)} dB`;

/** Follows `value` once it has stopped changing for `delayMs`: for work that need not keep up with a drag. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

interface ReadoutRow {
  id: string;
  color: string;
  name: string;
  a: number | null;
  b: number | null;
  /** the curve is switched off: the row keeps its place, without values */
  off?: boolean;
}

/** What an oscilloscope shows for its cursors: every curve at A and at B, the difference, and the two levels. */
const CursorReadout: React.FC<{
  positionA: string | null;
  positionB: string | null;
  delta: string | null;
  rows: ReadoutRow[];
  format: (v: number) => string;
  /** one more column worked out from B - A, e.g. the slope */
  extra?: { header: string; title: string; of: (difference: number) => string };
  levels: PaneLevels;
  /** how a level is printed; without it, both levels and their difference get the decimals the levels have */
  formatLevel?: (v: number) => string;
  onClear?: () => void;
}> = ({ positionA, positionB, delta, rows, format, extra, levels, formatLevel: givenFormat, onClear }) => {
  const decimals = Math.max(levels.a !== null ? decimalsOf(levels.a) : 0, levels.b !== null ? decimalsOf(levels.b) : 0);
  const formatLevel = givenFormat ?? ((v: number) => toDecimals(v, decimals));
  return (
  <div className="analysis-stats analysis-readout">
    <div className="analysis-stats-title">
      <span>Cursors</span>
      {positionA && (
        <span>
          <b className="cursor-a">A</b> {positionA}
        </span>
      )}
      {positionB && (
        <span>
          <b className="cursor-b">B</b> {positionB}
        </span>
      )}
      {delta && <span className="analysis-delta">{delta}</span>}
      {levels.a !== null && (
        <span>
          <b className="cursor-a">Y1</b> {formatLevel(levels.a)}
        </span>
      )}
      {levels.b !== null && (
        <span>
          <b className="cursor-b">Y2</b> {formatLevel(levels.b)}
        </span>
      )}
      {levels.a !== null && levels.b !== null && (
        <span className="analysis-delta">Y2 − Y1 = {formatLevel(levels.b - levels.a)}</span>
      )}
      {onClear && (
        <button className="btn-tiny" onClick={onClear}>
          Clear
        </button>
      )}
    </div>
    {(positionA || positionB) && rows.length > 0 && (
      <table className="analysis-stats-table">
        <thead>
          <tr>
            <th>Signal</th>
            <th>at A</th>
            <th>at B</th>
            <th>B − A</th>
            {extra && <th title={extra.title}>{extra.header}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const difference = r.a !== null && r.b !== null ? r.b - r.a : null;
            return (
              <tr key={r.id} className={r.off ? "off" : undefined} title={r.off ? "Switched off in this plot" : undefined}>
                <td>
                  <i className="stat-swatch" style={r.off ? { boxShadow: `inset 0 0 0 1.5px ${r.color}` } : { background: r.color }} />
                  {r.name}
                </td>
                <td>{r.a !== null ? format(r.a) : "-"}</td>
                <td>{r.b !== null ? format(r.b) : "-"}</td>
                <td>{difference !== null ? format(difference) : "-"}</td>
                {extra && <td>{difference !== null ? extra.of(difference) : "-"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    )}
  </div>
  );
};

/**
 * The spectrum of a pane's curves, with a frequency axis, a zoom and cursors of its own. Zoom and cursors are
 * kept as fractions of the band, so they stay where they are when the number of points changes with the stretch
 * the spectrum is taken over.
 */
const SpectrumPane: React.FC<{
  curves: PlotCurve[];
  /**
   * The rows of the cursor read-out: one per spectrum of the plot, switched off (y: null) or not. The read-out
   * sits in the plot's own card, so its height must not follow what is switched on: a row coming and going with
   * a click on a name would move everything below the plot - and, with the page scrolled to its end, the name
   * itself from under the pointer.
   */
  readout: { id: string; color: string; name: string; y: Float64Array | null }[];
  /** points of one spectrum (0: there is none): the frequency axis keeps its span when every curve is switched off */
  points: number;
  /** spacing of the points on the frequency axis, in `unit` */
  binStep: number;
  unit: "Hz" | "cycles/sample";
  height: number;
  hover: HoverStore;
  clickSets: "x" | "y";
  emptyText: string;
  /** the part of the band on screen (null: all of it), kept by the plot's card: its table is about that band */
  xPart: [number, number] | null;
  onXPart: (part: [number, number]) => void;
  /** count up when the toolbar's "Reset view" / "Clear cursors" is pressed */
  resetToken: number;
  clearToken: number;
}> = ({ curves, readout, points, binStep, unit, height, hover, clickSets, emptyText, xPart, onXPart, resetToken, clearToken }) => {
  const last = Math.max(1, (points > 0 ? points : 2) - 1);
  const [yRange, setYRange] = useState<[number, number] | null>(null);
  const [marks, setMarks] = useState<PaneLevels>(NO_LEVELS);
  const [levels, setLevels] = useState<PaneLevels>(NO_LEVELS);
  useEffect(() => {
    setYRange(null);
  }, [resetToken]);
  useEffect(() => {
    setMarks(NO_LEVELS);
    setLevels(NO_LEVELS);
  }, [clearToken]);
  const limit = useMemo<[number, number]>(() => [0, last], [last]);
  // (a band kept from a spectrum of more points can be narrower than a point of this one: clampRange widens it)
  const xRange = useMemo<[number, number]>(
    () => (xPart ? clampRange(xPart[0] * last, xPart[1] * last, limit) : limit),
    [xPart, last, limit],
  );
  const onXRange = useCallback((r: [number, number]) => onXPart([r[0] / last, r[1] / last]), [onXPart, last]);
  const onCursor = useCallback(
    (which: CursorName, index: number | null) => setMarks((m) => ({ ...m, [which]: index === null ? null : index / last })),
    [last],
  );
  const onLevel = useCallback((which: CursorName, value: number | null) => setLevels((l) => ({ ...l, [which]: value })), []);
  const xLabels = useCallback((ticks: number[]) => (unit === "Hz" ? siTickLabels(ticks, "Hz") : tickLabels(ticks)), [unit]);
  // a point of the spectrum as its cursor line says it, to the digits that tell it from the next point
  const xText = useCallback(
    (bin: number) => (unit === "Hz" ? formatSIStep(bin * binStep, binStep, "Hz") : formatOnAxis(bin * binStep, binStep * 100)),
    [unit, binStep],
  );
  const binOf = (part: number | null) => (part === null ? null : Math.min(last, Math.max(0, Math.round(part * last))));
  const a = binOf(marks.a);
  const b = binOf(marks.b);
  const frequency = (bins: number) =>
    unit === "Hz" ? formatSI(bins * binStep, "Hz", 6) : `${trimNumber(bins * binStep)} cycles/sample`;
  const anything = a !== null || b !== null || levels.a !== null || levels.b !== null;
  return (
    <>
      <PlotPane
        curves={curves}
        xRange={xRange}
        onXRange={onXRange}
        xLimit={limit}
        yRange={yRange}
        onYRange={setYRange}
        xOrigin={0}
        xStep={binStep}
        xLabels={xLabels}
        xText={xText}
        yText={formatDb}
        cursorA={a}
        cursorB={b}
        onCursor={onCursor}
        levelA={levels.a}
        levelB={levels.b}
        onLevel={onLevel}
        clickSets={clickSets}
        hover={hover}
        height={height}
        emptyText={emptyText}
      />
      {anything && (
        <CursorReadout
          positionA={a !== null ? frequency(a) : null}
          positionB={b !== null ? frequency(b) : null}
          delta={a !== null && b !== null ? `B − A = ${frequency(b - a)}` : null}
          rows={readout.map((r) => ({
            id: r.id,
            color: r.color,
            name: r.name,
            a: r.y !== null && a !== null && a < r.y.length ? r.y[a] : null,
            b: r.y !== null && b !== null && b < r.y.length ? r.y[b] : null,
            off: r.y === null,
          }))}
          format={formatDb}
          levels={levels}
          formatLevel={formatDb}
          onClear={() => {
            setMarks(NO_LEVELS);
            setLevels(NO_LEVELS);
          }}
        />
      )}
    </>
  );
};

interface PaneCardProps {
  pane: PaneConfig;
  index: number;
  active: boolean;
  /**
   * Where the cursor read-out and the measurements of the selected plot go: a card below all plots (null for the
   * plots that are not selected). Not under the plot itself - tables appearing between the plots pushed the lower
   * plots away from under the pointer, in the middle of a double-click or a drag.
   */
  tablesHost: HTMLElement | null;
  dropReady: boolean;
  height: number;
  resolve: (c: CurveConfig) => Resolved | null;
  /** the capture a curve is pinned to, and why it may have nothing to show */
  captureInfo: (path: string) => PinnedInfo;
  xRange: [number, number];
  xLimit: [number, number];
  yRange: [number, number] | null;
  /** the stretch between cursors A and B when both are set */
  measured: [number, number] | null;
  axis: Axis;
  cursorA: number | null;
  cursorB: number | null;
  levels: PaneLevels;
  /** what a click in a plot places: a vertical cursor or a horizontal one */
  clickSets: "x" | "y";
  marker: number | null;
  hover: HoverStore;
  actions: Actions;
  resetToken: number;
  clearToken: number;
}

/** One plot with its header. Memoised: a change in one plot (its zoom, say) does not redraw the others. */
const PaneCard = React.memo<PaneCardProps>(function PaneCard({
  pane,
  index,
  active,
  tablesHost,
  dropReady,
  height,
  resolve,
  captureInfo,
  xRange,
  xLimit,
  yRange,
  measured,
  axis,
  cursorA,
  cursorB,
  levels,
  clickSets,
  marker,
  hover,
  actions,
  resetToken,
  clearToken,
}) {
  const tables = tablesHost !== null;
  // The colours of the curves as the theme on screen shows them. A switch of the theme hands the plots new lists
  // of curves over the same samples: they are drawn again, nothing is prepared, transformed or measured again.
  const palette = plotPalette(useTheme());
  const shade = (color: string) => curveColor(color, palette);
  const spectrumHover = useMemo(() => new HoverStore(), []);
  // The curves with their samples. The list stays the same object while every curve has the samples it had: a
  // plot of pinned curves only is then neither measured nor drawn again when another capture comes on screen,
  // or when a capture joins or leaves the comparison.
  const lastResolved = useRef<{ config: CurveConfig; data: Resolved | null }[]>([]);
  const resolved = useMemo(() => {
    const next = pane.curves.map((c) => ({ config: c, data: resolve(c) }));
    const before = lastResolved.current;
    const same = next.length === before.length && next.every((r, i) => r.config === before[i].config && r.data === before[i].data);
    if (!same) lastResolved.current = next;
    return lastResolved.current;
  }, [pane.curves, resolve]);
  // a curve that is switched off (see CurveConfig.hidden) is left out of the picture, the tables and the axis fit
  const curves = useMemo<PlotCurve[]>(
    () =>
      resolved.flatMap(({ config, data }) =>
        data && !config.hidden
          ? [
              {
                id: config.id,
                color: curveColor(config.color, palette),
                y: data.y,
                step: !data.signal.isBus && config.transform === "raw",
              },
            ]
          : [],
      ),
    [resolved, palette],
  );

  // What the measurements and the spectrum are taken over: between the cursors, else what this plot shows.
  // They follow once the view or the cursor has come to rest, so that zooming and dragging stay smooth.
  const span = useSettled(measured ?? xRange, SETTLE_MS);
  const spanLo = span[0];
  const spanHi = span[1];

  // The spectrum of every curve of the plot, switched off or not: the frequency axis then keeps its span whatever
  // is switched off. Each is kept for the samples and the stretch it was taken from, so that switching a curve
  // off and on - or changing another curve of the plot - does not transform all of them again.
  const spectrumCache = useRef(
    new WeakMap<Float64Array, { lo: number; hi: number; points: number; sp: Spectrum | null; peak: number }>(),
  );
  const spectra = useMemo(() => {
    if (pane.mode !== "fft") return [];
    // A compared capture can be shorter than the one on screen, and its part of the stretch with it. All curves
    // are transformed with the points the longest part takes: they then lie on one frequency axis.
    let points = 0;
    for (const { data } of resolved) if (data) points = Math.max(points, spectrumPoints(data.y.length, spanLo, spanHi));
    return resolved.flatMap(({ config, data }) => {
      if (!data) return [];
      let entry = spectrumCache.current.get(data.y);
      if (!entry || entry.lo !== spanLo || entry.hi !== spanHi || entry.points !== points) {
        const sp = spectrum(data.y, spanLo, spanHi, points);
        entry = { lo: spanLo, hi: spanHi, points, sp, peak: sp ? spectrumPeak(sp) : 0 };
        spectrumCache.current.set(data.y, entry);
      }
      const sp = entry.sp;
      if (!sp) return [];
      return [{ config, sp, db: sp.db, binCycles: sp.binCyclesPerSample, n: sp.n, peak: entry.peak }];
    });
  }, [pane.mode, resolved, spanLo, spanHi]);
  const shownSpectra = useMemo(() => spectra.filter((s) => !s.config.hidden), [spectra]);
  // The part of the band the spectrum is zoomed to (null: all of it), as fractions - it then stays where it is
  // when the number of points changes. Kept here, not in the spectrum: the table below is about that band.
  const [band, setBand] = useState<[number, number] | null>(null);
  useEffect(() => {
    setBand(null);
  }, [resetToken]);
  const settledBand = useSettled(band, SETTLE_MS);
  const spectrumLast = (spectra[0]?.db.length ?? 1) - 1;
  // that band as points of the spectrum there is now - as the plot shows it (see SpectrumPane); null: all of it
  const bandPoints = useMemo<[number, number] | null>(() => {
    if (!settledBand || spectrumLast < 1) return null;
    const [from, to] = clampRange(settledBand[0] * spectrumLast, settledBand[1] * spectrumLast, [0, spectrumLast]);
    return from > 1e-9 || to < spectrumLast - 1e-9 ? [from, to] : null;
  }, [settledBand, spectrumLast]);
  // The strongest component of each spectrum - of the band on screen: zoomed in on a weak line, the table is
  // about that line, not about the strongest of the whole spectrum that lies outside the picture.
  const peaks = useMemo(() => {
    const found = new Map<string, number>();
    for (const s of shownSpectra) found.set(s.config.id, bandPoints ? spectrumPeak(s.sp, bandPoints[0], bandPoints[1]) : s.peak);
    return found;
  }, [shownSpectra, bandPoints]);
  // what the title of a spectrum counts: the samples of the stretch; a compared capture that ends earlier has
  // fewer, and its row of the table says so
  const spectrumSamples = spectra.reduce((most, s) => Math.max(most, s.n), 0);
  const spectrumCurves = useMemo<PlotCurve[]>(
    () => shownSpectra.map((s) => ({ id: s.config.id, color: curveColor(s.config.color, palette), y: s.db, step: false })),
    [shownSpectra, palette],
  );

  // Kept like the spectra, for the samples and the stretch they were taken from: the curves of a plot whose
  // samples stay (those pinned to a capture) are not measured again when one of the others gets new samples.
  const statsCache = useRef(
    new WeakMap<Float64Array, { lo: number; hi: number; stats: RangeStats | null; edges: EdgeStats | null }>(),
  );
  const stats = useMemo(() => {
    if (!tables || pane.mode !== "time") return [];
    return resolved.flatMap(({ config, data }) => {
      if (!data || config.hidden) return [];
      let entry = statsCache.current.get(data.y);
      if (!entry || entry.lo !== spanLo || entry.hi !== spanHi) {
        // a compared capture that is shorter is measured over the part of the stretch it has
        const s = rangeStats(data.y, spanLo, spanHi);
        entry = { lo: spanLo, hi: spanHi, stats: s, edges: s && s.peakToPeak > 0 ? edgeStats(data.y, spanLo, spanHi, undefined, s) : null };
        statsCache.current.set(data.y, entry);
      }
      return entry.stats ? [{ config, data, stats: entry.stats, edges: entry.edges }] : [];
    });
  }, [tables, pane.mode, resolved, spanLo, spanHi]);
  // what the title of the table counts: the samples of the stretch; a row that has fewer says so
  const statsSamples = stats.reduce((most, s) => Math.max(most, s.stats.n), 0);

  // Between two signals, as an oscilloscope measures it: every curve of the plot against one of them, the
  // reference. The phase at the tone the reference repeats with, and the delay from edge to edge.
  // It is worked out a moment after the rest (useDeferredValue): it costs a transform per curve, and the plots
  // and the tables above do not wait for that when a capture arrives or a view comes to rest.
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const toneCache = useRef(new WeakMap<Float64Array, { lo: number; hi: number; tone: Tone | null }>());
  const measuredNow = useMemo(() => ({ curves: stats, lo: spanLo, hi: spanHi }), [stats, spanLo, spanHi]);
  const forPairs = useDeferredValue(measuredNow);
  const pairs = useMemo(() => {
    const { lo, hi } = forPairs;
    if (forPairs.curves.length < 2) return null;
    const curves = forPairs.curves.map(({ config, data, stats: extent, edges }) => {
      let entry = toneCache.current.get(data.y);
      if (!entry || entry.lo !== lo || entry.hi !== hi) {
        entry = { lo, hi, tone: fundamentalTone(data.y, lo, hi) };
        toneCache.current.set(data.y, entry);
      }
      const rising = edges?.risingAt ?? [];
      // `tone`: the one it repeats with; null also for what moves without repeating (`found` is what there was)
      return { config, data, samples: extent.n, found: entry.tone, tone: repeats(entry.tone, edges) ? entry.tone : null, rising };
    });
    const reference = curves.find((c) => c.config.id === referenceId) ?? curves[0];
    const first = Math.max(0, Math.ceil(lo));
    const rows = curves.map((c) => {
      if (c === reference) return { ...c, phase: null, delay: null };
      // the samples both have: the ends an edge may have its partner beyond
      const last = Math.min(reference.data.y.length - 1, c.data.y.length - 1, Math.floor(hi));
      return {
        ...c,
        phase: reference.tone && c.tone ? phaseAgainst(reference.data.y, c.data.y, lo, hi, reference.tone, c.tone) : null,
        delay: edgeDelays(reference.rising, c.rising, first, last),
      };
    });
    return { reference, rows };
  }, [forPairs, referenceId]);

  const { period, stride } = axis;
  const binCycles = spectra[0]?.binCycles ?? 1;
  const leaf = (c: CurveConfig, data: Resolved | null) => data?.signal.name ?? c.signal.split("/").pop() ?? c.signal;
  /** how the tables name a curve: one pinned to a compared capture carries that capture's number */
  const nameOf = (c: CurveConfig, data: Resolved | null) => {
    if (c.capture === undefined) return leaf(c, data);
    const id = captureInfo(c.capture).id;
    return `${leaf(c, data)} #${id > 0 ? id : "?"}`;
  };
  /** ... and with what is plotted of it, where that is not the value itself */
  const titled = (c: CurveConfig, data: Resolved | null) =>
    nameOf(c, data) + (c.transform !== "raw" ? ` (${TRANSFORM_LABEL[c.transform]})` : "");
  const spectrumReadout = useMemo(
    () =>
      spectra.map((sp) => ({
        id: sp.config.id,
        color: curveColor(sp.config.color, palette),
        name: titled(sp.config, resolved.find((r) => r.config.id === sp.config.id)?.data ?? null),
        y: sp.config.hidden ? null : sp.db,
      })),
    [spectra, resolved, palette, captureInfo],
  );
  // what an empty picture says; with signals of this capture in the plot it can only be empty because they are off
  const anyData = resolved.some((r) => r.data);
  const timeEmpty = anyData ? SWITCHED_OFF : "Drag signals here, or double-click them in the list";
  const spectrumEmpty =
    pane.curves.length === 0
      ? "Add a signal to see its spectrum"
      : !anyData
        ? "None of these signals is in this capture"
        : spectra.length > 0
          ? SWITCHED_OFF
          : measured
            ? "Cursors A and B are fewer than 8 samples apart: move one or clear them"
            : "Too few samples for a spectrum";
  const onXRange = useCallback((r: [number, number]) => actions.setX(pane.id, r), [actions, pane.id]);
  const onYRange = useCallback((r: [number, number] | null) => actions.setY(pane.id, r), [actions, pane.id]);
  const onLevel = useCallback(
    (which: CursorName, value: number | null) => actions.setLevel(pane.id, which, value),
    [actions, pane.id],
  );

  // the cursor read-out of the selected plot: every curve at A and at B, like an oscilloscope's cursor table
  const anyCursor = cursorA !== null || cursorB !== null || levels.a !== null || levels.b !== null;
  const at = (y: Float64Array, index: number | null) => (index !== null && index >= 0 && index < y.length ? y[index] : null);
  const cursorDistance = cursorA !== null && cursorB !== null ? (cursorB - cursorA) * stride : 0; // captured samples
  const sampleOf = (index: number) => axis.firstSample + index * stride;
  const spanText = measured ? "between cursors A and B" : "over what this plot shows";
  /** a frequency of the spectrum, given in cycles per plotted sample */
  const frequencyText = (cycles: number, digits = 6) =>
    period > 0 ? formatSI(cycles / (stride * period), "Hz", digits) : `${trimNumber(cycles / stride)} cycles/sample`;
  /** a point of the spectrum as a frequency, to the digits that tell it from the next point */
  const pointText = (point: number) =>
    period > 0
      ? formatSIStep((point * binCycles) / (stride * period), binCycles / (stride * period), "Hz")
      : `${formatOnAxis((point * binCycles) / stride, (binCycles / stride) * 100)} cycles/sample`;
  /** a distance in plotted samples, as a time where the sample period is known */
  const distanceText = (samples: number) => {
    const size = Math.abs(samples) * stride;
    return period > 0 ? formatSI(size * period, "s", 5) : `${trimNumber(size)} samples`;
  };
  /** ... between a signal and the reference: by how much the signal comes later, or earlier */
  const laterText = (samples: number) => (samples === 0 ? distanceText(0) : `${distanceText(samples)} ${samples > 0 ? "later" : "earlier"}`);
  /** the same with a sign in place of the word, for the two ends of a range: positive is later */
  const signedShift = (samples: number) => {
    const text = period > 0 ? formatSI(samples * stride * period, "s", 5) : trimNumber(samples * stride);
    return samples > 0 ? `+${text}` : text;
  };
  /** half a period away is neither ahead nor behind: the angle is given without a direction ... */
  const opposite = (degrees: number) => Math.abs(Number(degrees.toFixed(2))) === 180;
  const phaseText = (degrees: number) => {
    const text = degrees.toFixed(2);
    const value = Number(text);
    if (value === 0) return "0.00°";
    if (opposite(degrees)) return "180.00°";
    return value > 0 ? `+${text}° leads` : `${text}° lags`;
  };
  /** ... and so is the phase as a time: that part of the reference's period (cycles per plotted sample) */
  const shiftText = (degrees: number, cycles: number) =>
    opposite(degrees) ? `±${distanceText(0.5 / cycles)}` : laterText(-degrees / 360 / cycles);
  /** why a curve of the table between signals has no frequency (and with it no phase) */
  const whyNoTone = (c: { samples: number; found: Tone | null }) =>
    c.samples < 8
      ? "Fewer than 8 samples in this stretch: too few for a frequency and a phase"
      : c.found
        ? "No tone it repeats with in this stretch (fewer than two and a half periods, a single edge, or no line in its spectrum - noise, data): no frequency and no phase - see edge to edge"
        : "It does not move over this stretch";

  return (
    <div
      data-pane-id={pane.id}
      className={`card analysis-pane ${active ? "active" : ""} ${dropReady ? "drop-ready" : ""}`}
      onPointerDown={() => actions.activate(pane.id)}
    >
      <div className="analysis-pane-header">
        <span
          className="analysis-pane-title"
          title={pane.mode === "fft" ? "Hann window, mean removed; a sine of amplitude A reads about 20·log10(A) dB" : undefined}
        >
          {pane.mode === "fft" ? "Spectrum" : "Plot"} {index + 1}
          {pane.mode === "fft" && spectra.length > 0 && (
            <em>
              {measured ? "A–B" : "visible"}, {spectrumSamples.toLocaleString()} samples
            </em>
          )}
        </span>
        <div className="analysis-chips">
          {resolved.map(({ config: c, data }) => {
            const sp = pane.mode === "fft" ? spectra.find((s) => s.config.id === c.id) : undefined;
            const off = c.hidden === true;
            // A curve pinned to a compared capture says which one. Without that capture it has nothing to show:
            // its chip stays, so that choosing the capture again brings the curve back.
            const pin = c.capture !== undefined ? captureInfo(c.capture) : null;
            const gone = pin?.state === "gone";
            const why = pin ? (gone ? NOT_COMPARED : pin.state === "step" ? OTHER_STEP : "") : "";
            // why a pinned curve has nothing to show ("absent": its capture has no such signal); a capture that
            // is still being read is on its way, which must not look like one that is missing
            const pinState = !pin ? undefined : data ? "ok" : pin.state === "ok" ? "absent" : pin.state;
            const pending = pinState === "loading";
            return (
              <span
                key={c.id}
                className={`curve-chip ${data || pending ? "" : "missing"} ${off ? "off" : ""} ${pin ? "pinned" : ""}`}
                style={{ borderColor: shade(c.color) }}
                data-capture={c.capture}
                data-state={pinState}
                title={gone ? NOT_COMPARED : undefined}
              >
                {/* the name is the switch: one click takes the curve out of the plot, the next puts it back. The
                    chip keeps its size either way, so nothing in the header moves under the pointer. */}
                <button
                  type="button"
                  className="curve-chip-toggle"
                  aria-pressed={!off}
                  title={
                    c.signal +
                    (pin ? `\nOf capture ${pin.id > 0 ? `#${pin.id} ` : ""}${pin.name}` : "") +
                    (why ? `\n${why}` : "") +
                    `\n${
                      off ? "Switched off - click to show it in the plot again" : "Click to switch it off in this plot (it stays here, to be switched on again)"
                    }`
                  }
                  onClick={() => actions.updateCurve(pane.id, c.id, { hidden: !off })}
                >
                  <i style={off ? { boxShadow: `inset 0 0 0 1.5px ${shade(c.color)}` } : { background: shade(c.color) }} />
                  <span className="curve-chip-name">{leaf(c, data)}</span>
                  {pin && (
                    <span className="curve-chip-capture" title={pin.name}>
                      #{pin.id > 0 ? pin.id : "?"}
                    </span>
                  )}
                  {!data && <em className={pending ? "pending" : undefined}>{pin ? PINNED_NOTE[pin.state] : "not in this capture"}</em>}
                  {pane.mode === "fft" ? (
                    <HoverValue store={spectrumHover} fallback={null} y={off ? undefined : sp?.db} format={formatDb} digits={9} />
                  ) : (
                    <HoverValue
                      store={hover}
                      fallback={cursorA}
                      y={off ? undefined : data?.y}
                      format={formatValue}
                      digits={data?.digits ?? 4}
                    />
                  )}
                </button>
                {data?.signal.isBus && (
                  <button
                    className="chip-btn"
                    title={
                      "How the bus is read: automatic (two's complement when the values look like it), signed, unsigned. " +
                      "The guess can be wrong for a strong tone with only a few samples per period: set it here. " +
                      "Buses wider than 53 bits arrive rounded to 53 significant bits."
                    }
                    onClick={() =>
                      actions.updateCurve(pane.id, c.id, {
                        sign: c.sign === "auto" ? "signed" : c.sign === "signed" ? "unsigned" : "auto",
                      })
                    }
                  >
                    {c.sign === "auto" ? `auto: ${data.signed ? "signed" : "unsigned"}` : c.sign}
                  </button>
                )}
                <select
                  className="chip-select"
                  value={c.transform}
                  title="What is plotted"
                  onChange={(e) => {
                    actions.updateCurve(pane.id, c.id, { transform: e.target.value as Transform });
                    if (!off) actions.setY(pane.id, null); // a curve that is off is not in the picture
                  }}
                >
                  {(Object.keys(TRANSFORM_LABEL) as Transform[]).map((t) => (
                    <option key={t} value={t}>
                      {TRANSFORM_LABEL[t]}
                    </option>
                  ))}
                </select>
                {c.transform === "moving_average" && (
                  <input
                    type="number"
                    className="chip-number"
                    min={1}
                    title="Samples averaged"
                    value={c.window}
                    onChange={(e) =>
                      actions.updateCurve(pane.id, c.id, { window: Math.max(1, Math.round(Number(e.target.value)) || 1) })
                    }
                  />
                )}
                <button
                  className="chip-btn"
                  title="Remove from this plot"
                  onClick={() => {
                    actions.updatePane(pane.id, (p) => ({ ...p, curves: p.curves.filter((x) => x.id !== c.id) }));
                    if (!off) actions.setY(pane.id, null);
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
          {pane.curves.length === 0 && (
            <span className="analysis-drop-hint">drag signals here, or double-click them in the list</span>
          )}
        </div>
        <div className="analysis-pane-actions">
          <button
            className={`btn-tiny ${pane.mode === "fft" ? "on" : ""}`}
            title="Spectrum of these signals over what this plot shows (or between cursors A and B)"
            onClick={() => {
              actions.updatePane(pane.id, (p) => ({ ...p, mode: p.mode === "fft" ? "time" : "fft" }));
              setBand(null); // a spectrum begins with its whole band, as it begins without cursors
            }}
          >
            <BarChart3 size={12} /> FFT
          </button>
          {yRange && pane.mode === "time" && (
            <button className="btn-tiny" title="Fit the value axis to the data again" onClick={() => actions.setY(pane.id, null)}>
              Fit Y
            </button>
          )}
          <button className="btn-tiny" title="Remove this plot" onClick={() => actions.removePane(pane.id)}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {pane.mode === "fft" ? (
        <SpectrumPane
          curves={spectrumCurves}
          readout={spectrumReadout}
          points={spectra[0]?.db.length ?? 0}
          binStep={period > 0 ? binCycles / (stride * period) : binCycles / stride}
          unit={period > 0 ? "Hz" : "cycles/sample"}
          height={height}
          hover={spectrumHover}
          clickSets={clickSets}
          emptyText={spectrumEmpty}
          xPart={band}
          onXPart={setBand}
          resetToken={resetToken}
          clearToken={clearToken}
        />
      ) : (
        <PlotPane
          curves={curves}
          xRange={xRange}
          onXRange={onXRange}
          xLimit={xLimit}
          yRange={yRange}
          onYRange={onYRange}
          xOrigin={axis.xOrigin}
          xStep={axis.xStep}
          xLabels={axis.xLabels}
          xText={axis.xText}
          yText={formatValue}
          cursorA={cursorA}
          cursorB={cursorB}
          onCursor={actions.setCursor}
          levelA={levels.a}
          levelB={levels.b}
          onLevel={onLevel}
          clickSets={clickSets}
          hover={hover}
          marker={marker}
          height={height}
          emptyText={timeEmpty}
        />
      )}

      {tablesHost &&
        ((pane.mode === "time" && (anyCursor || stats.length > 0)) || (pane.mode === "fft" && shownSpectra.length > 0)) &&
        createPortal(
          <>
            <div className="analysis-tables-title">
              {pane.mode === "fft" ? "Spectrum" : "Plot"} {index + 1} <em>- the selected plot</em>
            </div>
      {tables && pane.mode === "time" && anyCursor && (
        <CursorReadout
          positionA={cursorA !== null ? `sample ${sampleOf(cursorA)}` : null}
          positionB={cursorB !== null ? `sample ${sampleOf(cursorB)}` : null}
          delta={
            cursorA !== null && cursorB !== null
              ? `B − A = ${cursorDistance} samples${period > 0 ? ` = ${formatSI(cursorDistance * period, "s", 6)}` : ""}`
              : null
          }
          rows={resolved.flatMap(({ config, data }) =>
            data && !config.hidden
              ? [
                  {
                    id: config.id,
                    color: shade(config.color),
                    name: titled(config, data),
                    a: at(data.y, cursorA),
                    b: at(data.y, cursorB),
                  },
                ]
              : [],
          )}
          format={formatValue}
          extra={
            cursorDistance === 0
              ? undefined
              : period > 0
                ? {
                    header: "slope",
                    title: "(B − A) divided by the time between the cursors: change per second",
                    of: (d) => formatSI(d / (cursorDistance * period), "/s"),
                  }
                : {
                    header: "slope",
                    title: "(B − A) divided by the samples between the cursors",
                    of: (d) => `${trimNumber(d / cursorDistance)} /sample`,
                  }
          }
          levels={levels}
        />
      )}

      {/* the measurements of the selected plot */}
      {tables && pane.mode === "fft" && shownSpectra.length > 0 && (
        <div className="analysis-stats">
          <div className="analysis-stats-title">
            {bandPoints
              ? `Strongest component of each signal in the band shown · ${pointText(bandPoints[0])} – ${pointText(bandPoints[1])}`
              : `Strongest component of each signal · ${spanText}`}
          </div>
          <table className="analysis-stats-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>peak at</th>
                <th>period</th>
                <th>level</th>
                <th title="Spacing of the spectrum's points: two tones closer than a few of these cannot be told apart">resolution</th>
              </tr>
            </thead>
            <tbody>
              {shownSpectra.map((sp) => {
                const peak = peaks.get(sp.config.id) ?? sp.peak;
                const cycles = peak * sp.binCycles; // per plotted sample
                const hz = period > 0 ? cycles / (stride * period) : null;
                return (
                  <tr key={sp.config.id}>
                    <td>
                      <i className="stat-swatch" style={{ background: shade(sp.config.color) }} />
                      {titled(sp.config, resolve(sp.config))}
                      {sp.n < spectrumSamples && (
                        <em className="stat-short" title="This capture ends before the stretch does: its spectrum is of the part it has">
                          {sp.n.toLocaleString()} samples
                        </em>
                      )}
                    </td>
                    <td>{hz !== null ? formatSI(hz, "Hz", 6) : `${trimNumber(cycles / stride)} cycles/sample`}</td>
                    <td>
                      {cycles > 0 ? (hz !== null ? formatSI(1 / hz, "s", 6) : `${trimNumber(stride / cycles)} samples`) : "-"}
                    </td>
                    <td>{formatDb(sp.db[peak])}</td>
                    <td>
                      {period > 0
                        ? formatSI(sp.binCycles / (stride * period), "Hz")
                        : `${trimNumber(sp.binCycles / stride)} cycles/sample`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tables && stats.length > 0 && (
        <div className="analysis-stats">
          <div className="analysis-stats-title">
            Measurements · {spanText} · {statsSamples.toLocaleString()} samples
          </div>
          <table className="analysis-stats-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>min</th>
                <th>max</th>
                <th>mean</th>
                <th>RMS</th>
                <th>std dev</th>
                <th>peak-peak</th>
                <th title="Upward crossings of the level midway between min and max; the signal has to cross a band of a tenth of its swing around that level, so noise does not count">rising edges</th>
                <th title="From the mean distance between rising edges">period / frequency</th>
                <th title="Share of the samples above the midway level">high</th>
              </tr>
            </thead>
            <tbody>
              {stats.map(({ config, data, stats: s, edges }) => {
                const periodSamples = edges?.periodSamples ? edges.periodSamples * stride : null;
                return (
                  <tr key={config.id}>
                    <td>
                      <i className="stat-swatch" style={{ background: shade(config.color) }} />
                      {titled(config, data)}
                      {s.n < statsSamples && (
                        <em className="stat-short" title="This capture ends before the stretch does: measured over the part it has">
                          {s.n.toLocaleString()} samples
                        </em>
                      )}
                    </td>
                    <td>{formatValue(s.min)}</td>
                    <td>{formatValue(s.max)}</td>
                    <td>{formatValue(s.mean)}</td>
                    <td>{formatValue(s.rms)}</td>
                    <td>{formatValue(s.std)}</td>
                    <td>{formatValue(s.peakToPeak)}</td>
                    <td>{edges ? edges.rising : "-"}</td>
                    <td>
                      {periodSamples
                        ? period > 0
                          ? `${formatSI(periodSamples * period, "s", 6)} / ${formatSI(1 / (periodSamples * period), "Hz", 6)}`
                          : `${trimNumber(periodSamples)} samples`
                        : "-"}
                    </td>
                    <td>{edges ? `${(edges.duty * 100).toFixed(1)} %` : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tables && pane.mode === "time" && stats.length === 1 && (
        <div className="analysis-tables-hint">Phase and delay between two signals: put both into this plot</div>
      )}
      {tables && pane.mode === "time" && pairs && (
        <div className="analysis-stats analysis-pairs">
          <div className="analysis-stats-title">
            Phase and delay against{" "}
            <select
              className="chip-select pair-reference"
              value={pairs.reference.config.id}
              title="The reference: every other signal of the plot is measured against it"
              onChange={(e) => setReferenceId(e.target.value)}
            >
              {pairs.rows.map((r) => (
                <option key={r.config.id} value={r.config.id}>
                  {titled(r.config, r.data)}
                </option>
              ))}
            </select>{" "}
            · {spanText}
            {statsSamples > MAX_FFT && (
              <em className="stat-short" title="A spectrum is taken from at most this many samples">
                frequency and phase from the first {MAX_FFT.toLocaleString()} samples
              </em>
            )}
          </div>
          <table className="analysis-stats-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th title="The tone the signal repeats with over the stretch: the lowest of its strongest components (the repetition rate of a pulse train), read between the points of its spectrum">
                  frequency
                </th>
                <th title="Phase of the signal minus phase of the reference, at the frequency the reference repeats with. Negative (lags): the signal does what the reference does that part of a period later. For pulses this compares the middles of the pulses, not their rising edges - those are in the last column.">
                  phase
                </th>
                <th title="The phase as a time: that part of the reference's period (for pulses: from the middle of one to the middle of the other)">
                  time shift
                </th>
                <th title="From each rising edge of the reference to the nearest rising edge of the signal: the mean, the number of edges and - where it varies - the least and the greatest (+ is later). Edges as counted above: crossings of the level midway between min and max.">
                  edge to edge
                </th>
              </tr>
            </thead>
            <tbody>
              {pairs.rows.map((r) => {
                const reference = pairs.reference;
                const isReference = r.config === reference.config;
                const whyNoPhase = !reference.tone
                  ? `The reference: ${whyNoTone(reference)}`
                  : !r.tone
                    ? whyNoTone(r)
                    : `This signal does not hold the reference's frequency (${frequencyText(reference.tone.cycles)}): there is no fixed phase between the two`;
                const d = r.delay;
                const unit = period > 0 ? "" : " samples";
                return (
                  <tr key={r.config.id} data-kind={isReference ? "reference" : r.phase ? (r.phase.own ? "same" : "other") : "none"}>
                    <td>
                      <i className="stat-swatch" style={{ background: shade(r.config.color) }} />
                      {titled(r.config, r.data)}
                    </td>
                    <td title={r.tone ? undefined : whyNoTone(r)}>{r.tone ? frequencyText(r.tone.cycles) : "-"}</td>
                    {isReference ? (
                      <td colSpan={3} className="pair-is-reference">
                        reference
                      </td>
                    ) : (
                      <>
                        <td title={r.phase ? undefined : whyNoPhase}>
                          {r.phase ? phaseText(r.phase.degrees) : "-"}
                          {r.phase && !r.phase.own && (
                            <em className="stat-short" title="This signal repeats with another tone (see its frequency): this is the phase of the component it holds at the reference's frequency beside it">
                              not its own tone
                            </em>
                          )}
                        </td>
                        <td title={r.phase && opposite(r.phase.degrees) ? "Half a period away: as much later as earlier" : undefined}>
                          {r.phase && reference.tone ? shiftText(r.phase.degrees, reference.tone.cycles) : "-"}
                        </td>
                        {!d ? (
                          <td title="No rising edge of the reference has one of this signal to go with">-</td>
                        ) : d.kind === "scattered" ? (
                          <td title="The edges of this signal keep no one distance to those of the reference (another rate, or no relation): this is from where to where they lie">
                            {signedShift(d.min)} … {signedShift(d.max)}
                            {unit}
                            <em className="stat-short">{d.count.toLocaleString()} edges · no one delay</em>
                          </td>
                        ) : d.kind === "opposite" ? (
                          <td title="The edges of this signal lie midway between those of the reference: as near before one as after the next">
                            ±{distanceText(d.mean)}
                            <em className="stat-short">
                              {d.count.toLocaleString()} {d.count === 1 ? "edge" : "edges"} · midway
                            </em>
                          </td>
                        ) : (
                          <td>
                            {laterText(d.mean)}
                            <em className="stat-short">
                              {d.count.toLocaleString()} {d.count === 1 ? "edge" : "edges"}
                              {d.max > d.min ? ` · ${signedShift(d.min)} … ${signedShift(d.max)}${unit}` : ""}
                            </em>
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
          </>,
          tablesHost,
        )}
    </div>
  );
});

interface SignalListActions {
  /** into the selected plot: the signal of the capture on screen, or pinned to the compared capture named */
  add: (signal: string, capture?: string) => void;
  /** into the selected plot: the signal of every compared capture that has it */
  addAll: (signal: string) => void;
  /** a press on a row, which becomes a drag onto a plot once the pointer has travelled */
  drag: (signal: string, capture: string | undefined, x: number, y: number) => void;
  removeCompared: (path: string) => void;
}

interface SignalListProps {
  waveform: WaveformResult;
  compare: ComparedCapture[];
  /** for the mark of the signals that are plotted */
  panes: PaneConfig[];
  actions: SignalListActions;
}

function storedHideConst(): boolean {
  try {
    return localStorage.getItem(HIDE_CONST_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The card on the left: the signals of the capture on screen and, with captures compared, one group per capture.
 * Memoised, with the filter and what is folded as its own state: a zoom step or a drag over the plots does not
 * render several hundred rows again.
 */
const SignalList = React.memo<SignalListProps>(function SignalList({ waveform, compare, panes, actions }) {
  const [filter, setFilter] = useState("");
  // leaves out the signals that never change in their capture (unconnected probes come by the dozen)
  const [hideConst, setHideConst] = useState(storedHideConst);
  // the groups that are folded, by file ("" is the capture on screen); as the comparison, for this session
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const stride = waveform.step || 1;
  const needle = filter.trim().toLowerCase();
  const comparing = compare.length > 0;

  const plotted = useMemo(() => {
    const set = new Set<string>();
    for (const p of panes) for (const c of p.curves) set.add(`${c.capture ?? ""}\n${c.signal}`);
    return set;
  }, [panes]);

  // The signals "add from every compared capture" finds somewhere: those of the compared captures that are read
  // and can be laid over the one on screen. For any other signal that button has nothing to add.
  const inCompared = useMemo(() => {
    const names = new Set<string>();
    for (const c of compare) {
      if (!c.waveform || (c.waveform.step || 1) !== stride) continue;
      for (const name of factsOf(c.waveform).signals.keys()) names.add(name);
    }
    return names;
  }, [compare, stride]);

  const toggleHideConst = () => {
    const next = !hideConst;
    setHideConst(next);
    try {
      localStorage.setItem(HIDE_CONST_KEY, next ? "1" : "0");
    } catch {
      /* the choice simply does not persist */
    }
  };
  const toggleFolded = (key: string) =>
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /** The rows of one capture: `capture` absent for the one on screen; `usable` false when it cannot be laid over that. */
  const rowsOf = (wave: WaveformResult, capture: ComparedCapture | undefined, usable: boolean, render: boolean) => {
    const known = factsOf(wave);
    const rows: React.ReactNode[] = [];
    let hidden = 0;
    // what the button hides of this capture, or would hide
    let constants = 0;
    for (const s of wave.signals) {
      const fact = known.facts.get(s.fullName);
      const isPlotted = plotted.has(`${capture?.path ?? ""}\n${s.fullName}`);
      // a constant signal that is plotted stays: one must be able to see what is plotted
      if (fact?.changes === 0 && !isPlotted) {
        constants++;
        if (hideConst) {
          hidden++;
          continue;
        }
      }
      if (!render || (needle && !s.fullName.toLowerCase().includes(needle))) continue;
      const path = capture?.path;
      const everywhere = inCompared.has(s.fullName);
      rows.push(
        <div
          key={s.fullName}
          className={`analysis-signal ${isPlotted ? "plotted" : ""} ${fact?.changes === 0 ? "constant" : ""}${usable ? "" : " unusable"}`}
          title={
            !usable
              ? `${s.fullName}\n${OTHER_STEP}`
              : capture
                ? `${s.fullName}\nOf capture #${capture.id} ${capture.name}\nDrag onto a plot, or double-click to add to the selected plot: the curve stays that of this capture`
                : `${s.fullName}\nDrag onto a plot, or double-click to add to the selected plot`
          }
          onPointerDown={(e) => {
            if (e.button === 0 && usable) actions.drag(s.fullName, path, e.clientX, e.clientY);
          }}
          onDoubleClick={() => usable && actions.add(s.fullName, path)}
        >
          <span className="analysis-signal-name">{s.name}</span>
          <span className="analysis-signal-tag">
            {fact?.changes === 0 ? "const" : s.isBus ? `${s.width}b${fact?.signed ? " s" : ""}` : "1b"}
          </span>
          {comparing && (
            <button
              className="analysis-signal-add-all"
              title={everywhere ? "Add this signal from every compared capture" : "No compared capture has this signal"}
              disabled={!usable || !everywhere}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => actions.addAll(s.fullName)}
            >
              <Layers size={11} />
            </button>
          )}
          <button
            className="analysis-signal-add"
            title={capture ? `Add to the selected plot, from capture #${capture.id}` : "Add to the selected plot"}
            disabled={!usable}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={() => actions.add(s.fullName, path)}
          >
            <Plus size={12} />
          </button>
        </div>,
      );
    }
    return { rows, hidden, constants, all: wave.signals.length };
  };

  const screenRows = rowsOf(waveform, undefined, true, !comparing || !folded.has(""));
  const groups = compare.map((c) => {
    const usable = c.waveform !== null && (c.waveform.step || 1) === stride;
    const isFolded = folded.has(c.path);
    return { capture: c, usable, isFolded, list: c.waveform ? rowsOf(c.waveform, c, usable, !isFolded) : null };
  });
  // What the button hides, or would hide: the signals tagged "const" that are not plotted, each by its own
  // capture, in every group (folded or not). A capture that is on screen and compared is one capture.
  const constants = groups.reduce(
    (sum, g) => sum + (g.list && g.capture.waveform !== waveform ? g.list.constants : 0),
    screenRows.constants,
  );
  const counted = (list: { hidden: number; all: number }, both = list.hidden > 0) =>
    both ? `${list.all - list.hidden} / ${list.all}` : `${list.all}`;
  // hidden rows of the compared captures, which the count of the card's header does not cover
  const hiddenElsewhere = groups.reduce((sum, g) => sum + (g.list?.hidden ?? 0), 0);

  const header = (key: string, isFolded: boolean, tag: string, name: string, path: string, count: string, removable: boolean) => (
    <div
      className="analysis-signal-group-header"
      title={isFolded ? "Click to show the signals of this capture" : "Click to fold the signals of this capture away"}
      onClick={() => toggleFolded(key)}
    >
      {/* the fold as a button of its own, for the keyboard; its click is the header's */}
      <button type="button" className="analysis-signal-group-toggle" aria-expanded={!isFolded}>
        {isFolded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="analysis-signal-group-tag">{tag}</span>
        {/* cut in the middle: captures differ in the folder at the front of their names, or in the number at the end */}
        <span className="analysis-signal-group-name" title={path}>
          <span className="analysis-signal-group-name-head">{name.slice(0, -NAME_TAIL)}</span>
          <span className="analysis-signal-group-name-tail">{name.slice(-NAME_TAIL)}</span>
        </span>
        <span className="analysis-signal-group-count">{count}</span>
      </button>
      {removable && (
        <button
          className="analysis-signal-group-remove"
          title="Take this capture out of the comparison"
          onClick={(e) => {
            e.stopPropagation();
            actions.removeCompared(path);
          }}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );

  // the count is that of the capture on screen; it takes the form "shown / all" while anything is hidden, be it
  // in the compared captures only
  const title = `Signals (${counted(screenRows, screenRows.hidden + hiddenElsewhere > 0)})`;
  const hiddenNote = [
    screenRows.hidden > 0 ? `${screenRows.hidden} constant signals of the capture on screen are hidden` : "",
    hiddenElsewhere > 0 ? `${hiddenElsewhere} constant signals of the compared captures are hidden` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="card analysis-signals">
      <div className="card-header">
        <div className="card-title">
          <Activity size={16} className="text-accent" />
          <h3 title={hiddenNote || undefined}>{title}</h3>
        </div>
        <button
          type="button"
          className={`btn-tiny analysis-hide-const ${hideConst ? "on" : ""}`}
          aria-pressed={hideConst}
          // nothing to hide: only switching it off again is left to do
          disabled={constants === 0 && !hideConst}
          title={
            constants === 0
              ? hideConst
                ? "Constant signals are hidden: there is none among those listed now"
                : "Nothing to hide: every signal listed changes in its capture, or is plotted"
              : hideConst
                ? `Show the ${constants} constant signals again`
                : `Hide the ${constants} signals that do not change in the capture`
          }
          onClick={toggleHideConst}
        >
          <EyeOff size={12} />
          <span>const</span>
        </button>
      </div>
      <div className="analysis-signals-search">
        <div className="search-box">
          <Search size={13} className="search-icon" />
          <input className="search-input" placeholder="filter..." value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      {!comparing ? (
        <div className="analysis-signal-list">{screenRows.rows}</div>
      ) : (
        <div className="analysis-signal-list grouped">
          <div className={`analysis-signal-group ${folded.has("") ? "collapsed" : ""}`} data-kind="screen">
            {header("", folded.has(""), "On screen", captureName(waveform.filePath), waveform.filePath, counted(screenRows), false)}
            {screenRows.rows}
          </div>
          {groups.map(({ capture: c, usable, isFolded, list }) => (
            <div
              key={c.path}
              className={`analysis-signal-group ${isFolded ? "collapsed" : ""} ${usable ? "" : "unusable"}`}
              data-kind="compared"
              data-path={c.path}
            >
              {header(c.path, isFolded, `#${c.id}`, c.name, c.path, list ? counted(list) : "", true)}
              {!isFolded && c.error && <div className="analysis-signal-group-note error">{c.error}</div>}
              {!isFolded && !c.error && !c.waveform && <div className="analysis-signal-group-note">loading...</div>}
              {!isFolded && c.waveform && !usable && <div className="analysis-signal-group-note error">{OTHER_STEP}</div>}
              {list?.rows}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
  waveform,
  samplePeriodNs,
  onSamplePeriodChange,
  onPopOut,
  onDock,
  captureNav,
  captureImport,
  captureCompare,
  compare = NO_COMPARE,
  onCompareRemove,
  captureOf,
}) => {
  // Curves pinned to a compared capture are kept when the view has moved here from the other window (the
  // comparison goes on), and left out at the start of the application, when there is none.
  const initial = useMemo(() => loadLayout(LAYOUT_KEY, onDock !== undefined || panelSeenBefore), []);
  useEffect(() => {
    panelSeenBefore = true;
  }, []);
  const [panes, setPanes] = useState<PaneConfig[]>(() => initial?.panes ?? [emptyPane()]);
  const [activePaneId, setActivePaneId] = useState<string>("");
  const [xUnit, setXUnit] = useState<"samples" | "time">(initial?.xUnit ?? "samples");
  // one zoom for all plots, or each plot its own (the default: look closely at one without losing the others)
  const [linkX, setLinkX] = useState<boolean>(initial?.linkX ?? false);
  const [sharedX, setSharedX] = useState<[number, number] | null>(null);
  const [views, setViews] = useState<Record<string, PaneView>>({});
  const [cursorA, setCursorA] = useState<number | null>(null);
  const [cursorB, setCursorB] = useState<number | null>(null);
  // horizontal cursors belong to one plot each (every plot has its own value axis)
  const [levels, setLevels] = useState<Record<string, PaneLevels>>({});
  // what a click in a plot places: a vertical cursor (a time) or a horizontal one (a value)
  const [cursorMode, setCursorMode] = useState<"x" | "y">("x");
  const [dragging, setDragging] = useState<{
    signal: string;
    /** the compared capture the row belongs to; absent for a signal of the capture on screen */
    capture?: string;
    x: number;
    y: number;
    fromX: number;
    fromY: number;
  } | null>(null);
  const hover = useMemo(() => new HoverStore(), []);
  // a remembered layout without a single signal in it is no layout: the first capture then fills the plot
  const hadLayout = useRef(initial !== null && initial.panes.some((p) => p.curves.length > 0));
  const linkRef = useRef(linkX);
  linkRef.current = linkX;

  const activePane = panes.find((p) => p.id === activePaneId) ?? panes[0];
  // the card below the plots that takes the tables of the selected plot
  const [tablesHost, setTablesHost] = useState<HTMLDivElement | null>(null);
  // The card keeps the greatest height it has had: a page that gets shorter while it is scrolled to its end is
  // shifted by the browser - under the pointer, in the middle of the click that selected a plot with fewer rows.
  useEffect(() => {
    if (!tablesHost) return;
    let tallest = 0;
    const observer = new ResizeObserver(() => {
      const height = tablesHost.offsetHeight;
      if (height > tallest) {
        tallest = height;
        tablesHost.style.minHeight = `${height}px`;
        tablesHost.classList.add("used");
      }
    });
    observer.observe(tablesHost);
    return () => observer.disconnect();
  }, [tablesHost]);
  // "Reset view" and "Clear cursors" also reach what a spectrum keeps for itself
  const [resetToken, setResetToken] = useState(0);
  const [clearToken, setClearToken] = useState(0);
  // the view of the panel that was open a moment ago in the other window (pop out / dock), applied once
  const handover = useRef<Handover | null>(null);
  const handoverRead = useRef(false);
  if (!handoverRead.current) {
    handoverRead.current = true;
    handover.current = loadHandover();
  }
  const count = waveform ? waveform.sampleIndices.length : 0;
  const limit = useMemo<[number, number]>(() => [0, Math.max(1, count - 1)], [count]);
  const firstSample = waveform?.sampleIndices[0] ?? 0;
  const stride = waveform?.step || 1;
  const period = samplePeriodNs > 0 ? samplePeriodNs * 1e-9 : 0;
  const timeAxis = xUnit === "time" && period > 0;
  const triggerSample = waveform?.triggerSample ?? null;
  const triggerIndex = triggerSample !== null ? (triggerSample - firstSample) / stride : null;

  // ---- the data of the captures: the one on screen, and those it is compared with -----------------------------
  /** per signal of the capture on screen: does it look signed, and how often does it change (0 = constant) */
  const { signals, facts } = waveform ? factsOf(waveform) : NO_FACTS;

  /**
   * The plotted samples of a curve. Kept per capture and per (signal, sign, transform): zooming, selecting or
   * rearranging plots never recomputes them, and an unchanged curve keeps its array, so its plot is not redrawn.
   * A compared capture keeps what was prepared from it for as long as it is compared: another capture coming on
   * screen, joining or leaving does not touch it. (A capture that is both on screen and compared, parsed once,
   * is one source.)
   */
  const sources = useRef<{ screen: CaptureSource | null; pinned: Map<string, CaptureSource> }>({ screen: null, pinned: new Map() });
  if ((sources.current.screen?.wave ?? null) !== waveform) {
    sources.current.screen = waveform
      ? ([...sources.current.pinned.values()].find((s) => s.wave === waveform) ?? { wave: waveform, facts: factsOf(waveform), prepared: new Map() })
      : null;
  }
  const screen = sources.current.screen;
  // The compared captures that are read. Whether one can be laid over the capture on screen (see OTHER_STEP) is
  // asked where it is used, not here: what was prepared of it then outlasts a visit to a capture thinned otherwise.
  const pinned = useMemo(() => {
    const before = sources.current.pinned;
    const next = new Map<string, CaptureSource>();
    for (const c of compare) {
      if (!c.waveform) continue;
      const kept = before.get(c.path);
      next.set(
        c.path,
        kept && kept.wave === c.waveform
          ? kept
          : screen && screen.wave === c.waveform
            ? screen
            : { wave: c.waveform, facts: factsOf(c.waveform), prepared: new Map() },
      );
    }
    sources.current.pinned = next;
    return next;
  }, [compare]);

  // A curve whose capture has left the comparison still says which it was: by the session's list, and for a
  // capture that has left that too, by what it was called while it was compared here.
  const comparedBefore = useRef(new Map<string, { id: number; name: string }>());
  const captureInfo = useMemo(() => {
    for (const c of compare) if (c.id > 0) comparedBefore.current.set(c.path, { id: c.id, name: c.name });
    return (path: string): PinnedInfo => {
      const c = compare.find((x) => x.path === path);
      if (!c) {
        const was = captureOf?.(path) ?? comparedBefore.current.get(path);
        return { id: was?.id ?? 0, name: was?.name ?? captureName(path), state: "gone" };
      }
      const state = c.error ? "failed" : !c.waveform ? "loading" : (c.waveform.step || 1) !== stride ? "step" : "ok";
      return { id: c.id, name: c.name, state };
    };
  }, [compare, stride, captureOf]);

  const resolve = useCallback(
    (c: CurveConfig): Resolved | null => {
      const source = c.capture === undefined ? screen : pinned.get(c.capture);
      const signal = source?.facts.signals.get(c.signal);
      if (!source || !signal) return null;
      // thinned otherwise than the capture on screen: its samples do not lie where those lie
      if (c.capture !== undefined && (source.wave.step || 1) !== stride) return null;
      const signed = c.sign === "signed" || (c.sign === "auto" && (source.facts.facts.get(c.signal)?.signed ?? false));
      const key = cacheKey(c, signed);
      // the same object for as long as the curve has these samples: a plot tells by it that nothing has changed
      let entry = source.prepared.get(key);
      if (!entry) {
        const y = prepareCurve(signal.values, signal.width, signed, c.transform, c.window);
        const all = rangeStats(y, 0, y.length - 1);
        const widest = all ? Math.max(formatValue(Math.trunc(all.min)).length, formatValue(Math.trunc(all.max)).length) : 1;
        // a moving average has decimals; everything else is whole numbers
        entry = { y, signal, signed, digits: c.transform === "moving_average" ? widest + 5 : Math.max(widest, 3) };
        source.prepared.set(key, entry);
      }
      return entry;
    },
    [screen, pinned, stride],
  );

  // curves that are no longer plotted (every moving-average window that was tried, say) are let go
  useEffect(() => {
    const used = new Map<CaptureSource, Set<string>>();
    if (screen) used.set(screen, new Set());
    for (const source of pinned.values()) used.set(source, new Set());
    for (const pane of panes) {
      for (const c of pane.curves) {
        const source = c.capture === undefined ? screen : pinned.get(c.capture);
        if (!source) continue;
        const signed = c.sign === "signed" || (c.sign === "auto" && (source.facts.facts.get(c.signal)?.signed ?? false));
        used.get(source)?.add(cacheKey(c, signed));
      }
    }
    for (const [source, keys] of used) {
      for (const key of [...source.prepared.keys()]) if (!keys.has(key)) source.prepared.delete(key);
    }
  }, [panes, screen, pinned]);

  // a capture of another length: the old zooms and cursors point at nothing sensible
  useEffect(() => {
    setSharedX(null);
    setViews({});
    setCursorA(null);
    setCursorB(null);
    // ... unless this panel has just taken over from the one in the other window, showing the same capture
    const h = handover.current;
    if (count === 0 || !h) return;
    handover.current = null;
    if (h.count !== count || Date.now() - h.at > HANDOVER_MAX_AGE_MS) return;
    const inside = (r: [number, number] | null) => (r && r[0] >= 0 && r[1] <= count - 1 && r[1] > r[0] ? r : null);
    const index = (i: number | null) => (typeof i === "number" && i >= 0 && i < count ? i : null);
    setSharedX(inside(h.sharedX));
    setCursorA(index(h.cursorA));
    setCursorB(index(h.cursorB));
    setCursorMode(h.cursorMode === "y" ? "y" : "x");
    setViews(Object.fromEntries(panes.flatMap((p, i) => (h.views[i] ? [[p.id, { x: inside(h.views[i].x), y: h.views[i].y ?? null }]] : []))));
    setLevels(Object.fromEntries(panes.flatMap((p, i) => (h.levels[i] ? [[p.id, { a: h.levels[i].a ?? null, b: h.levels[i].b ?? null }]] : []))));
    if (panes[h.active]) setActivePaneId(panes[h.active].id);
  }, [count]);

  // Start with the liveliest buses - usually what one wants to see - when there is no remembered layout, or
  // when the remembered one belongs to another design (none of its signals is in this capture).
  useEffect(() => {
    if (!waveform) return;
    // only what follows the capture on screen counts: a curve pinned to a compared capture says nothing about
    // the design of this one
    const plotted = panes.flatMap((p) => p.curves).filter((c) => c.capture === undefined);
    const foreign = plotted.length > 0 && !plotted.some((c) => signals.has(c.signal));
    // the user has built something (be it of pinned curves alone): never replace it
    if (!foreign && panes.some((p) => p.curves.length > 0)) hadLayout.current = true;
    if (hadLayout.current && !foreign) return;
    let next: PaneConfig[] | null = null;
    if (foreign) {
      // the layout made for this design earlier, kept aside when a capture of another design came along
      const other = loadLayout(OTHER_LAYOUT_KEY);
      if (other && other.panes.some((p) => p.curves.some((c) => signals.has(c.signal)))) next = other.panes;
    }
    if (!next) {
      const lively = waveform.signals
        .filter((s) => s.isBus && (facts.get(s.fullName)?.changes ?? 0) > 0)
        .sort((a, b) => (facts.get(b.fullName)?.changes ?? 0) - (facts.get(a.fullName)?.changes ?? 0))
        .slice(0, 3);
      // nothing to offer in this capture: the layout stays as it is, and the next capture is looked at again
      if (lively.length === 0) return;
      const pane = emptyPane();
      pane.curves = lively.map((s, i) => ({
        id: newId("c"),
        signal: s.fullName,
        sign: "auto",
        transform: "raw",
        window: 16,
        color: COLORS[i % COLORS.length],
      }));
      next = [pane];
    }
    if (foreign) {
      try {
        localStorage.setItem(OTHER_LAYOUT_KEY, JSON.stringify({ panes, xUnit, linkX }));
      } catch {
        /* then the other design starts from the default again */
      }
    }
    hadLayout.current = true;
    setPanes(next);
    setActivePaneId(next[0].id);
    setViews({});
    setLevels({});
  }, [waveform, facts, signals]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ panes, xUnit, linkX }));
    } catch {
      /* the layout simply does not persist */
    }
  }, [panes, xUnit, linkX]);

  // what the other window needs to carry on where this one stopped (see HANDOVER_KEY)
  const writeHandover = useRef(() => {});
  writeHandover.current = () => {
    if (count === 0 || handover.current) return; // nothing to hand over yet / still waiting to take over itself
    const state: Handover = {
      at: Date.now(),
      count,
      sharedX,
      cursorA,
      cursorB,
      cursorMode,
      active: Math.max(0, panes.findIndex((p) => p.id === activePaneId)),
      views: panes.map((p) => views[p.id] ?? NO_VIEW),
      levels: panes.map((p) => levels[p.id] ?? NO_LEVELS),
    };
    try {
      localStorage.setItem(HANDOVER_KEY, JSON.stringify(state));
    } catch {
      /* the other window then starts with the whole capture in view */
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => writeHandover.current(), 150);
    return () => window.clearTimeout(timer);
  }, [count, panes, sharedX, views, cursorA, cursorB, cursorMode, levels, activePaneId]);
  // Its age has to tell how long ago the view moved, not how long ago it last changed: a zoom that has rested
  // for a minute is handed over as well. So it is stamped again when the view leaves (the buttons below, this
  // panel going, the window closing) and, for a window that is closed without a word, every few seconds.
  useEffect(() => {
    const write = () => writeHandover.current();
    const beat = window.setInterval(write, HANDOVER_MAX_AGE_MS / 3);
    window.addEventListener("pagehide", write);
    return () => {
      window.clearInterval(beat);
      window.removeEventListener("pagehide", write);
      write();
    };
  }, []);

  // ---- editing the layout and the views: stable callbacks, so the memoised plots only see real changes --------
  const actions = useMemo<Actions>(() => {
    const updatePane: Actions["updatePane"] = (paneId, change) =>
      setPanes((all) => all.map((p) => (p.id === paneId ? change(p) : p)));
    const setView = (paneId: string, change: Partial<PaneView>) =>
      setViews((all) => ({ ...all, [paneId]: { ...(all[paneId] ?? NO_VIEW), ...change } }));
    return {
      activate: setActivePaneId,
      setX: (paneId, range) => (linkRef.current ? setSharedX(range) : setView(paneId, { x: range })),
      setY: (paneId, range) => setView(paneId, { y: range }),
      setCursor: (which, index) => (which === "a" ? setCursorA(index) : setCursorB(index)),
      setLevel: (paneId, which, value) =>
        setLevels((all) => ({ ...all, [paneId]: { ...(all[paneId] ?? NO_LEVELS), [which]: value } })),
      updatePane,
      updateCurve: (paneId, curveId, change) =>
        updatePane(paneId, (p) => ({ ...p, curves: p.curves.map((c) => (c.id === curveId ? { ...c, ...change } : c)) })),
      removePane: (paneId) => {
        setPanes((all) => {
          const rest = all.filter((p) => p.id !== paneId);
          return rest.length > 0 ? rest : [emptyPane()];
        });
        const without = <T,>(all: Record<string, T>) => {
          if (!(paneId in all)) return all;
          const rest = { ...all };
          delete rest[paneId];
          return rest;
        };
        setLevels(without);
        setViews(without);
      },
    };
  }, []);

  /**
   * Puts a signal into a plot once per capture named: undefined is the capture on screen (the curve follows it),
   * a file one of the compared captures (the curve is pinned to it). Each new curve takes the next free colour
   * of the plot, so the same signal of several captures can be told apart.
   */
  const addCurves = useCallback(
    (paneId: string, signal: string, captures: (string | undefined)[], sign: SignMode = "auto") => {
      if (captures.length === 0) return;
      actions.updatePane(paneId, (p) => {
        let curves = p.curves;
        for (const capture of captures) {
          const there = curves.find((c) => c.signal === signal && c.capture === capture && c.transform === "raw");
          if (there) {
            // asked for again while it is switched off: that is what the asking was for
            if (there.hidden) curves = curves.map((c) => (c === there ? { ...c, hidden: false } : c));
            continue;
          }
          const used = new Set(curves.map((c) => c.color));
          const color = COLORS.find((c) => !used.has(c)) ?? COLORS[curves.length % COLORS.length];
          const curve: CurveConfig = { id: newId("c"), signal, sign, transform: "raw", window: 16, color };
          if (capture !== undefined) curve.capture = capture;
          curves = [...curves, curve];
        }
        return curves === p.curves ? p : { ...p, curves };
      });
      actions.setY(paneId, null);
    },
    [actions],
  );

  // What the signal list does. It is memoised and must not be rendered again for every zoom step: these stay the
  // same functions, and read what is selected or compared now when they are called.
  const listState = useRef({ activeId: activePane?.id, pinned, screen, stride, onCompareRemove });
  listState.current = { activeId: activePane?.id, pinned, screen, stride, onCompareRemove };
  const listActions = useMemo<SignalListActions>(
    () => ({
      add: (signal, capture) => {
        const paneId = listState.current.activeId;
        if (paneId) addCurves(paneId, signal, [capture]);
      },
      addAll: (signal) => {
        const paneId = listState.current.activeId;
        if (!paneId) return;
        const { pinned, screen, stride } = listState.current;
        const having = [...pinned].filter(([, source]) => (source.wave.step || 1) === stride && source.facts.signals.has(signal));
        // "auto" judges a bus by the values of its own capture, and one in which the bus happens to stay on one
        // side can be judged otherwise than the rest: the curves would lie 2^width apart. Where the captures
        // (the one on screen among them) do not agree, the curves laid over each other are all read as signed.
        const verdicts = new Set(having.map(([, source]) => source.facts.facts.get(signal)?.signed ?? false));
        const here = screen?.facts.facts.get(signal);
        if (here) verdicts.add(here.signed);
        addCurves(
          paneId,
          signal,
          having.map(([path]) => path),
          verdicts.size > 1 ? "signed" : "auto",
        );
      },
      drag: (signal, capture, x, y) => setDragging({ signal, capture, x, y, fromX: x, fromY: y }),
      removeCompared: (path) => listState.current.onCompareRemove?.(path),
    }),
    [addCurves],
  );

  const addPane = () => {
    const pane = emptyPane();
    setPanes((all) => [...all, pane]);
    setActivePaneId(pane.id);
  };

  const resetView = () => {
    setSharedX(null);
    setViews({});
    setResetToken((n) => n + 1);
  };

  const toggleLink = () => {
    if (linkX) {
      // every plot keeps showing what the common view showed
      setViews((all) => Object.fromEntries(panes.map((p) => [p.id, { ...(all[p.id] ?? NO_VIEW), x: sharedX }])));
    } else {
      // the selected plot's view becomes the common one
      setSharedX(views[activePane?.id ?? ""]?.x ?? null);
    }
    setLinkX(!linkX);
  };

  // dragging a signal from the list onto a plot (pointer based: HTML drag-and-drop is taken by the native window)
  const draggedSignal = dragging?.signal;
  const draggedCapture = dragging?.capture;
  useEffect(() => {
    if (!draggedSignal) return;
    const move = (e: PointerEvent) => setDragging((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    const up = (e: PointerEvent) => {
      const paneId = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-pane-id]")?.getAttribute("data-pane-id");
      if (paneId) {
        addCurves(paneId, draggedSignal, [draggedCapture]);
        setActivePaneId(paneId);
      }
      setDragging(null);
    };
    const cancel = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [draggedSignal, draggedCapture, addCurves]);

  // ---- axes and read-outs -----------------------------------------------------------------------------------
  /**
   * The time of a plotted point relative to the trigger, to the digit that tells it from its neighbours. The
   * points of a thinned capture lie `stride` samples apart, but not on that grid as counted from the trigger
   * unless the trigger happens to: then their times need the digits of single samples.
   */
  const timeText = useCallback(
    (index: number) => {
      const fromTrigger = firstSample - (triggerSample ?? 0);
      return formatSIStep((fromTrigger + index * stride) * period, (fromTrigger % stride === 0 ? stride : 1) * period, "s");
    },
    [firstSample, triggerSample, period, stride],
  );
  const axis = useMemo<Axis>(
    () => ({
      xOrigin: timeAxis ? (firstSample - (triggerSample ?? 0)) * period : firstSample,
      xStep: timeAxis ? stride * period : stride,
      xLabels: timeAxis ? (ticks: number[]) => siTickLabels(ticks, "s") : (ticks: number[]) => tickLabels(ticks),
      xText: timeAxis ? timeText : (index: number) => String(firstSample + index * stride),
      period,
      stride,
      firstSample,
      triggerSample,
    }),
    [timeAxis, timeText, firstSample, triggerSample, period, stride],
  );
  const positionText = (index: number) => {
    const sample = firstSample + index * stride;
    return period > 0 ? `sample ${sample} (${timeText(index)})` : `sample ${sample}`;
  };
  const measured = useMemo<[number, number] | null>(
    () => (cursorA !== null && cursorB !== null ? [Math.min(cursorA, cursorB), Math.max(cursorA, cursorB)] : null),
    [cursorA, cursorB],
  );

  const anyCursor =
    cursorA !== null ||
    cursorB !== null ||
    panes.some((p) => {
      const l = levels[p.id];
      return !!l && (l.a !== null || l.b !== null);
    });
  // a spectrum keeps its cursors to itself: with one on screen the button has to stay usable
  const mayHaveCursors = anyCursor || panes.some((p) => p.mode === "fft");

  // a press on a list row only becomes a drag once the pointer has travelled
  const isDragging = dragging !== null && Math.abs(dragging.x - dragging.fromX) + Math.abs(dragging.y - dragging.fromY) > 6;

  const windowButton = onPopOut ? (
    <button
      className="btn btn-secondary btn-sm"
      onClick={() => {
        writeHandover.current();
        onPopOut();
      }}
      title="Show the analysis in a window of its own, e.g. on another screen; it keeps following the captures"
    >
      <ExternalLink size={13} />
      <span>Pop out</span>
    </button>
  ) : onDock ? (
    <button
      className="btn btn-secondary btn-sm"
      onClick={() => {
        writeHandover.current();
        onDock();
      }}
      title="Close this window and show the analysis in the main window again">
      <ExternalLink size={13} />
      <span>Back into the main window</span>
    </button>
  ) : null;

  if (!waveform) {
    return (
      <div className="card" style={{ overflow: "visible" }}>
        <div className="empty-state" style={{ padding: 70 }}>
          <Activity size={36} className="empty-icon" />
          <p>No capture to analyse yet.</p>
          <span>Take a capture, import captures from disk, or load the demo data - it appears here at once.</span>
          {captureNav}
          <div className="analysis-empty-actions">
            {captureImport}
            {captureCompare}
            {windowButton}
          </div>
        </div>
      </div>
    );
  }

  const paneHeight = panes.length === 1 ? 380 : panes.length === 2 ? 260 : 200;

  return (
    <div className="analysis-layout" data-capture={waveform.filePath}>
      {/* ---------------- signal list ---------------- */}
      <SignalList waveform={waveform} compare={compare} panes={panes} actions={listActions} />

      {/* ---------------- plots ---------------- */}
      <div className="analysis-main">
        <div className="card analysis-toolbar">
          <div className="analysis-toolbar-main">
          <button className="btn btn-secondary btn-sm" onClick={addPane}>
            <Plus size={13} />
            <span>Add plot</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={resetView} title="Show the whole capture in every plot (double-click in a plot resets that plot)">
            <Maximize2 size={13} />
            <span>Reset view</span>
          </button>
          <button
            className={`btn btn-secondary btn-sm ${linkX ? "on" : ""}`}
            onClick={toggleLink}
            title={
              linkX
                ? "All plots zoom and pan together. Click to give every plot its own zoom."
                : "Every plot has its own zoom. Click to make all plots zoom and pan together."
            }
          >
            {linkX ? <Link2 size={13} /> : <Unlink2 size={13} />}
            <span>{linkX ? "Zoom: all plots" : "Zoom: each plot"}</span>
          </button>
          <div className="analysis-toolbar-group">
            <span className="analysis-toolbar-label">X axis</span>
            <div className="btn-group-segmented">
              <button className={`btn-seg ${!timeAxis ? "active" : ""}`} onClick={() => setXUnit("samples")}>
                samples
              </button>
              <button
                className={`btn-seg ${timeAxis ? "active" : ""}`}
                onClick={() => setXUnit("time")}
                title="Time relative to the trigger, from the sample period on the right"
              >
                time
              </button>
            </div>
          </div>
          <div className="analysis-toolbar-group" title="Period of the ILA clock: it turns samples into time and frequency">
            <span className="analysis-toolbar-label">sample period</span>
            <input
              type="number"
              className="number-input"
              min={0}
              step="any"
              value={samplePeriodNs}
              onChange={(e) => onSamplePeriodChange(Math.max(0, Number(e.target.value) || 0))}
            />
            <span className="analysis-toolbar-label">ns{period > 0 ? ` = ${formatSI(1 / period, "Hz")}` : ""}</span>
          </div>
          <div className="analysis-toolbar-group">
            <span className="analysis-toolbar-label">click places</span>
            <div className="btn-group-segmented">
              <button
                className={`btn-seg ${cursorMode === "x" ? "active" : ""}`}
                onClick={() => setCursorMode("x")}
                title="A click in a plot places a vertical cursor: a position in time, the same in every plot"
              >
                time (A, B)
              </button>
              <button
                className={`btn-seg ${cursorMode === "y" ? "active" : ""}`}
                onClick={() => setCursorMode("y")}
                title="A click in a plot places a horizontal cursor: a value on that plot's own axis"
              >
                value (Y1, Y2)
              </button>
            </div>
          </div>
          {windowButton}
          {captureImport}
          <span className="analysis-hint" title="drag = zoom into the marked stretch · wheel = zoom · Shift+drag / Shift+wheel = pan · Ctrl+wheel / Ctrl+drag = value axis · double-click = show everything">
            drag / wheel: zoom · Shift: pan · Ctrl: value axis · double-click: everything
          </span>
          </div>
          {/* "Compare" has its place under the navigator, where the toolbar has room that nothing uses: among
              the buttons on the left it would take a row more in a narrow window */}
          {(captureNav || captureCompare) && (
            <div className="analysis-toolbar-nav">
              {captureNav}
              {captureCompare}
            </div>
          )}
        </div>

        <div className="card analysis-cursors">
          {cursorA !== null && (
            <span>
              <b className="cursor-a">A</b> {positionText(cursorA)}
            </span>
          )}
          {cursorB !== null && (
            <span>
              <b className="cursor-b">B</b> {positionText(cursorB)}
            </span>
          )}
          {cursorA !== null && cursorB !== null && (
            <span className="analysis-delta">
              B − A = {(cursorB - cursorA) * stride} samples
              {period > 0 && cursorB !== cursorA
                ? ` = ${formatSI((cursorB - cursorA) * stride * period, "s", 6)} → ${formatSI(1 / (Math.abs(cursorB - cursorA) * stride * period), "Hz", 6)}`
                : ""}
            </span>
          )}
          {cursorA === null && cursorB === null && (
            <span className="analysis-hint">
              {cursorMode === "x"
                ? "Cursors: click in a plot = A · Shift+click = B · drag a cursor line to move it"
                : "Cursors: click in a plot = Y1 · Shift+click = Y2 (that plot's value axis) · drag a cursor line to move it"}
            </span>
          )}
          <button
            className="btn-tiny"
            disabled={!mayHaveCursors}
            onClick={() => {
              setCursorA(null);
              setCursorB(null);
              setLevels({});
              setClearToken((n) => n + 1);
            }}
          >
            Clear cursors
          </button>
        </div>

        {panes.map((pane, index) => (
          <PaneCard
            key={pane.id}
            pane={pane}
            index={index}
            active={pane.id === activePane?.id}
            tablesHost={pane.id === activePane?.id ? tablesHost : null}
            dropReady={isDragging}
            height={paneHeight}
            resolve={resolve}
            captureInfo={captureInfo}
            xRange={(linkX ? sharedX : views[pane.id]?.x) ?? limit}
            xLimit={limit}
            yRange={views[pane.id]?.y ?? null}
            measured={measured}
            axis={axis}
            cursorA={cursorA}
            cursorB={cursorB}
            levels={levels[pane.id] ?? NO_LEVELS}
            clickSets={cursorMode}
            marker={triggerIndex}
            hover={hover}
            actions={actions}
            resetToken={resetToken}
            clearToken={clearToken}
          />
        ))}
        {/* cursor read-out and measurements of the selected plot (filled by that plot, see PaneCard) */}
        <div ref={setTablesHost} className="card analysis-tables" />
      </div>

      {isDragging && dragging && (
        <div className="analysis-drag-ghost" style={{ left: dragging.x + 12, top: dragging.y + 8 }}>
          {dragging.capture === undefined
            ? (signals.get(dragging.signal)?.name ?? dragging.signal)
            : `${pinned.get(dragging.capture)?.facts.signals.get(dragging.signal)?.name ?? dragging.signal} #${captureInfo(dragging.capture).id}`}
        </div>
      )}
    </div>
  );
};
