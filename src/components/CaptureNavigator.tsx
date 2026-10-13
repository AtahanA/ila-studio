// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";

/** One capture of this session as the navigator lists it. */
export interface CaptureItem {
  /** its number in the session: counts up with every capture, and stays with it when old entries leave the list */
  id: number;
  /** session folder and file name without the extension, e.g. 20250101_120000_unit/cap_run_001_0012 */
  name: string;
  /** the file itself, shown as a tooltip */
  path?: string;
  /** when it was captured, or when an imported file was written (ms since the epoch); 0 when not known */
  at: number;
  /** samples in it; 0 while not known */
  rows: number;
}

interface CaptureNavigatorProps {
  items: CaptureItem[];
  /** the capture on screen (position in `items`); -1 when it is none of them */
  index: number;
  onSelect: (index: number) => void;
  /** captures keep arriving (a constant capture is running) */
  live?: boolean;
  /** new captures will be shown as they arrive; when not given: while the newest one is on screen */
  following?: boolean;
  /** the capture named by `index` is still being read: the plots show the one before */
  pending?: boolean;
}

// built once: a formatter per call made a list of 2000 captures take a third of a second to open
const clockFormat = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
// a capture of another day (an imported file): the day says more than the second
const dayFormat = new Intl.DateTimeFormat([], { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY_MS = 24 * 3600 * 1000;
const countFormat = new Intl.NumberFormat();

/** When a capture was taken, as the lists of captures print it; `today` is the local midnight before now. */
export const captureTime = (at: number, today: number) =>
  at >= today && at < today + DAY_MS ? clockFormat.format(at) : dayFormat.format(at);

/**
 * Steps through the captures of this session:  |<  <  [ 12 / 187 v ]  >  >|
 * The number opens the list of all of them. While the newest capture is on screen, a running constant capture
 * keeps showing each new one; someone looking at an older capture is left there, and the count goes on growing.
 */
export const CaptureNavigator: React.FC<CaptureNavigatorProps> = ({ items, index, onSelect, live, following, pending }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const total = items.length;
  const last = total - 1;
  const atEnd = total > 0 && index === last;
  const follows = following ?? atEnd;
  const newer = index >= 0 ? last - index : 0;
  // the list keeps only the newest captures of a very long run: the numbers go on from where they were
  const trimmed = total > 0 && items[0].id > 1;
  // the capture on screen; none also for a number that names no entry (the list was cut or an entry taken out
  // since it was set)
  const shown = index >= 0 ? items[index] : undefined;

  // The list closes on a click elsewhere and on Escape. That click only closes it: it must not also place a
  // cursor in the plot it happens to land on, or start a drag there.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        e.stopPropagation();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  // It opens with the capture on screen in the middle of the list. Only the list is scrolled: scrollIntoView
  // would also move the page and every clipped box around it.
  useEffect(() => {
    const menu = listRef.current;
    const row = menu?.querySelector<HTMLElement>(".capture-nav-row.current");
    if (!open || !menu || !row) return;
    menu.scrollTop = row.offsetTop - (menu.clientHeight - row.offsetHeight) / 2;
  }, [open]);

  useEffect(() => {
    if (total === 0) setOpen(false);
  }, [total]);

  const go = (target: number) => {
    if (total === 0) return;
    onSelect(Math.max(0, Math.min(last, target)));
  };

  const today = new Date().setHours(0, 0, 0, 0);
  const when = (at: number) => captureTime(at, today);

  return (
    <div className="capture-nav" ref={rootRef}>
      <button
        className="btn-tiny"
        disabled={total === 0 || index <= 0}
        onClick={() => go(0)}
        title={trimmed ? `Oldest capture in the list (it holds the newest ${total} of this session)` : "First capture of this session"}
      >
        <ChevronFirst size={14} />
      </button>
      <button className="btn-tiny" disabled={total === 0 || index <= 0} onClick={() => go(index - 1)} title="Previous capture">
        <ChevronLeft size={14} />
      </button>
      <button
        className={`btn-tiny capture-nav-index ${open ? "on" : ""} ${pending ? "pending" : ""}`}
        disabled={total === 0}
        onClick={() => setOpen((o) => !o)}
        title={
          total === 0
            ? "No capture yet"
            : `${shown ? shown.path || shown.name : "A capture that is no longer in the list"}` +
              (pending ? "\nLoading this capture: the plots still show the one before" : "") +
              `\nClick to choose from the ${trimmed ? `newest ${total}` : `${total}`} captures of this session` +
              (live ? (follows ? "\nShowing each new capture as it arrives" : "\nStaying on this capture; new ones are saved and counted") : "")
        }
      >
        {live && <i className={`capture-nav-dot ${follows ? "following" : ""}`} />}
        <span>{total === 0 ? "no capture" : `${shown ? shown.id : "–"} / ${items[last].id}`}</span>
        <ChevronDown size={12} />
      </button>
      <button className="btn-tiny" disabled={total === 0 || index >= last} onClick={() => go(index + 1)} title="Next capture">
        <ChevronRight size={14} />
      </button>
      <button
        className={`btn-tiny ${live && !follows && total > 0 ? "on" : ""}`}
        disabled={total === 0 || atEnd}
        onClick={() => go(last)}
        title={(newer > 0 ? `Newest capture (${newer} newer than this one)` : "Newest capture") + (live && !follows ? " - and follow the capture again" : "")}
      >
        <ChevronLast size={14} />
      </button>

      {open && total > 0 && (
        <div className="capture-nav-menu" ref={listRef}>
          {items.map((item, i) => (
            <button
              key={item.id}
              className={`capture-nav-row ${i === index ? "current" : ""}`}
              title={item.path}
              onClick={() => {
                setOpen(false);
                go(i);
              }}
            >
              <span className="capture-nav-number">{item.id}</span>
              <span className="capture-nav-name">{item.name}</span>
              <span className="capture-nav-time">{item.at > 0 ? when(item.at) : "opened"}</span>
              <span className="capture-nav-rows">{item.rows > 0 ? `${countFormat.format(item.rows)} samples` : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
