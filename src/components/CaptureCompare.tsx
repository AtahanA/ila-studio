// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layers, Search } from "lucide-react";
import { ComparedCapture, WaveformResult } from "../types";
import { CaptureItem, captureTime } from "./CaptureNavigator";

/** So many captures can be laid over the one on screen: a plot has eight curve colours, and each is a file in memory. */
export const MAX_COMPARED = 8;
// The list shows this many captures at once; a session can hold thousands, and the filter finds the others.
const ROWS_SHOWN = 200;
/** from this many captures on the list has a filter box */
const FILTER_FROM = 13;

/** The choice as it may stand: captures of the list, each once, in the order chosen, no more than the limit. */
export function cleanComparison(paths: unknown, items: CaptureItem[]): string[] {
  if (!Array.isArray(paths)) return [];
  const listed = new Set(items.map((c) => c.path));
  const out: string[] = [];
  for (const path of paths) {
    if (typeof path === "string" && listed.has(path) && !out.includes(path) && out.length < MAX_COMPARED) out.push(path);
  }
  return out;
}

/**
 * What the analysis window reports of a choice made there ("analysis-compare"): the step taken, not the list it
 * led to. That window learns the list from the main window, a moment later - two clicks in quick succession
 * would each send a list built from the old one, and the second would undo the first.
 */
export type ComparisonChange = { add: string } | { remove: string } | { set: string[] };

/** The step that leads from one choice to the next. */
export function comparisonChange(before: string[], after: string[]): ComparisonChange {
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  // a single step only where applying it gives `after` in its own order ("Newest 4" may differ from the old choice
  // by one capture and still sort the rest anew: that is a new list, not a step)
  const same = (list: string[]) => list.length === after.length && list.every((p, i) => p === after[i]);
  if (added.length === 1 && removed.length === 0 && same([...before, added[0]])) return { add: added[0] };
  if (added.length === 0 && removed.length === 1 && same(before.filter((p) => p !== removed[0]))) return { remove: removed[0] };
  return { set: after };
}

/** The choice after such a step, to be cleaned (cleanComparison) by whoever owns it. */
export function applyComparisonChange(now: string[], change: unknown): unknown {
  if (!change || typeof change !== "object") return now;
  const step = change as { add?: unknown; remove?: unknown; set?: unknown };
  if (typeof step.add === "string") return now.includes(step.add) ? now : [...now, step.add];
  if (typeof step.remove === "string") return now.filter((p) => p !== step.remove);
  return "set" in step ? step.set : now;
}

interface CaptureCompareProps {
  /** the captures of the session, oldest first (as the navigator has them) */
  items: CaptureItem[];
  /** the files chosen, in the order they were chosen */
  chosen: string[];
  onChange: (paths: string[]) => void;
  /** the file of the capture on screen: marked in the list */
  current?: string | null;
}

/**
 * "Compare": chooses captures of the session whose signals the analysis lays over those of the capture on screen
 * - signal X of captures 1, 2, 3 and 4 in one plot. The chosen ones appear as groups in the signal list.
 */
export const CaptureCompare: React.FC<CaptureCompareProps> = ({ items, chosen, onChange, current }) => {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // closes on a click elsewhere and on Escape; that click must not also place a cursor in a plot
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        e.stopPropagation();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // the menu goes, and with it whatever had the focus in it: the button takes it, not the top of the page
      if (rootRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
      setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  const full = chosen.length >= MAX_COMPARED;
  const withFilter = items.length >= FILTER_FROM;

  // Newest first, and no more rows than ROWS_SHOWN however long the session is. A chosen capture that lies
  // beyond them is listed after them: what is chosen can always be seen, and taken out, here.
  const { rows, further, more } = useMemo(() => {
    const rows: CaptureItem[] = [];
    const further: CaptureItem[] = [];
    let more = 0;
    if (!open) return { rows, further, more };
    const needle = withFilter ? filter.trim().toLowerCase().replace(/^#/, "") : "";
    const picked = new Set(chosen);
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (needle && !item.name.toLowerCase().includes(needle) && String(item.id) !== needle) continue;
      if (rows.length < ROWS_SHOWN) rows.push(item);
      else if (item.path && picked.has(item.path)) further.push(item);
      else more++;
    }
    return { rows, further, more };
  }, [open, items, filter, withFilter, chosen]);

  const toggle = (path: string) => {
    if (chosen.includes(path)) onChange(chosen.filter((p) => p !== path));
    else if (!full) onChange([...chosen, path]);
  };

  const today = new Date().setHours(0, 0, 0, 0);
  const row = (item: CaptureItem) => {
    const path = item.path ?? "";
    const checked = chosen.includes(path);
    const blocked = !checked && full;
    return (
      <label
        key={item.id}
        className={`capture-compare-row ${checked ? "chosen" : ""} ${path === current ? "current" : ""} ${blocked ? "blocked" : ""}`}
        data-path={path}
        title={
          blocked
            ? `At most ${MAX_COMPARED} captures can be compared: take one out first`
            : path + (path === current ? "\nThis capture is on screen" : "")
        }
      >
        <input type="checkbox" checked={checked} disabled={blocked || !path} onChange={() => toggle(path)} />
        <span className="capture-compare-number">#{item.id}</span>
        <span className="capture-compare-name">{item.name}</span>
        <span className="capture-compare-time">{item.at > 0 ? captureTime(item.at, today) : "opened"}</span>
      </label>
    );
  };

  return (
    <span className="capture-compare" ref={rootRef}>
      <button
        ref={buttonRef}
        className={`btn btn-secondary btn-sm capture-compare-btn ${open || chosen.length > 0 ? "on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        // the count is a bare digit next to the word: read out, the two would run into one
        aria-label={chosen.length > 0 ? `Compare, ${chosen.length} chosen` : "Compare"}
        disabled={items.length === 0}
        onClick={() => setOpen((o) => !o)}
        title={
          items.length === 0
            ? "No capture yet"
            : "Lay captures of this session over the one on screen: their signals join the list on the left, to be plotted together" +
              (chosen.length > 0 ? `\n${chosen.length} chosen` : "")
        }
      >
        <Layers size={13} />
        <span>Compare</span>
        {/* always there, and one digit wide: choosing a capture must not change the width of the button */}
        <b className="capture-compare-count">{chosen.length > 0 ? chosen.length : ""}</b>
      </button>
      {open && items.length > 0 && (
        <div className="capture-compare-menu">
          <div className="capture-compare-head">
            <span className="capture-compare-summary">
              {chosen.length} of {MAX_COMPARED} chosen
            </span>
            <button
              className="btn-tiny capture-compare-newest"
              title="Choose the four newest captures of this session, instead of what is chosen now"
              onClick={() =>
                onChange(
                  items
                    .slice(-4)
                    .map((c) => c.path ?? "")
                    .filter(Boolean),
                )
              }
            >
              Newest 4
            </button>
            <button
              className="btn-tiny capture-compare-clear"
              disabled={chosen.length === 0}
              title="Compare nothing: the plots show the capture on screen alone"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>
          {withFilter && (
            <div className="search-box capture-compare-filter">
              <Search size={13} className="search-icon" />
              <input
                className="search-input"
                aria-label="Filter the captures by name or number"
                placeholder="filter by name or number..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}
          <div className="capture-compare-list">
            {rows.map(row)}
            {rows.length === 0 && <div className="capture-compare-note">No capture of this session matches.</div>}
            {further.length > 0 && <div className="capture-compare-note">Also chosen:</div>}
            {further.map(row)}
            {more > 0 && (
              <div className="capture-compare-note">
                {more.toLocaleString()} more not listed: the filter finds them
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  );
};

interface Loaded {
  waveform: WaveformResult | null;
  error?: string;
}

/** What useComparedCaptures gives its window. */
export interface ComparedData {
  /** the chosen captures in the order chosen; the same object until one of them really changes */
  list: ComparedCapture[];
  /** the parsed data of a chosen capture, once it is read */
  loaded: (path: string) => WaveformResult | undefined;
  /** the file was written or imported anew: what is held of it is let go, and it is read again */
  forget: (path: string) => void;
}

const sameList = (a: ComparedCapture[], b: ComparedCapture[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return x.path === y.path && x.id === y.id && x.name === y.name && x.waveform === y.waveform && x.error === y.error;
  });

/**
 * The parsed data of the captures chosen for comparison, for the window that shows them. Kept in a map of its
 * own: a capture stays in memory for as long as it is chosen, however many others are looked at meanwhile, and
 * is let go when it is taken out. Files are read one after the other; one that cannot be read keeps its place
 * with the reason. The list that comes back is the same object until something in it really changes.
 *
 * `cached`: a capture this window has parsed already (the one on screen, say) is taken from there. The other
 * way round, `loaded` hands out what is held here, so that a compared capture coming on screen is not read a
 * second time - and is then one object for the analysis, prepared once.
 */
export function useComparedCaptures(
  paths: string[],
  items: CaptureItem[],
  maxSamples: number,
  cached?: (path: string) => WaveformResult | undefined,
): ComparedData {
  const data = useRef(new Map<string, Loaded>());
  const [version, setVersion] = useState(0);
  const live = useRef({ paths, maxSamples, cached });
  live.current = { paths, maxSamples, cached };
  const running = useRef(false);
  // the file being read now, and whether it was written anew meanwhile (see forget)
  const reading = useRef<{ path: string; stale: boolean } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    for (const key of [...data.current.keys()]) if (!paths.includes(key)) data.current.delete(key);
    const run = async () => {
      if (running.current) return;
      running.current = true;
      try {
        for (;;) {
          const path = live.current.paths.find((p) => !data.current.has(p));
          if (path === undefined || !mounted.current) break;
          let entry: Loaded;
          const ready = live.current.cached?.(path);
          if (ready) {
            entry = { waveform: ready };
          } else {
            const job = { path, stale: false };
            reading.current = job;
            try {
              entry = {
                waveform: await invoke<WaveformResult>("load_csv_data", { filePath: path, maxSamples: live.current.maxSamples }),
              };
            } catch (e) {
              entry = { waveform: null, error: `Could not load the capture: ${e}` };
            }
            reading.current = null;
            if (job.stale) continue; // read again: what has arrived is the file as it was
          }
          // taken out of the comparison while it was read: nothing of it is kept
          if (!mounted.current) break;
          if (live.current.paths.includes(path)) {
            data.current.set(path, entry);
            setVersion((n) => n + 1);
          }
        }
      } finally {
        running.current = false;
      }
    };
    void run();
    // `version`: a capture that was forgotten is read again
  }, [paths, version]);

  const list = useMemo<ComparedCapture[]>(
    () =>
      paths.flatMap((path) => {
        // A capture that has just left the session's list is on its way out of the comparison too: it is not
        // handed on without its number.
        const item = items.find((c) => c.path === path);
        if (!item) return [];
        const loaded = data.current.get(path);
        return [{ path, id: item.id, name: item.name, waveform: loaded?.waveform ?? null, error: loaded?.error }];
      }),
    [paths, items, version],
  );
  const stable = useRef(list);
  if (!sameList(stable.current, list)) stable.current = list;

  const access = useMemo(
    () => ({
      loaded: (path: string) => data.current.get(path)?.waveform ?? undefined,
      forget: (path: string) => {
        if (reading.current?.path === path) reading.current.stale = true;
        if (data.current.delete(path)) setVersion((n) => n + 1);
      },
    }),
    [],
  );
  return useMemo(() => ({ list: stable.current, ...access }), [stable.current, access]);
}
