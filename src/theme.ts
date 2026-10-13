// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { useSyncExternalStore } from "react";

export type ThemeName = "light" | "dark";

/** the same key and default as the inline script of index.html, which sets the theme before the bundle loads */
const STORAGE_KEY = "ila-studio-theme";
const DEFAULT_THEME: ThemeName = "light";

/**
 * Everything the canvases draw, by name. The rest of the app is coloured by the CSS variables of App.css; a
 * canvas cannot use those, so its colours live here, one object per theme.
 */
export interface PlotPalette {
  /** analysis plots (PlotPane) */
  background: string;
  /** the card a plot lies on, around its frame (--bg-card of App.css): what takes a label of the axis away */
  margin: string;
  grid: string;
  zeroLine: string;
  axisText: string;
  frame: string;
  emptyText: string;
  hoverLine: string;
  selectionFill: string;
  selectionStroke: string;
  cursorA: string;
  cursorB: string;
  trigger: string;
  /** one per curve of a plot, by slot: see curveColor */
  curves: readonly string[];
  /** waveform viewer */
  waveGrid: string;
  waveRulerText: string;
  waveRulerLine: string;
  waveRowLine: string;
  waveBit: string;
  waveAnalog: string;
  waveBus: string;
  waveBusFill: string;
  waveBusDense: string;
  waveBusText: string;
  waveTrigger: string;
}

const DARK: PlotPalette = {
  background: "#080b11",
  margin: "#151a26",
  grid: "rgba(255, 255, 255, 0.06)",
  zeroLine: "rgba(255, 255, 255, 0.16)",
  axisText: "rgba(160, 174, 192, 0.85)",
  frame: "rgba(255, 255, 255, 0.14)",
  emptyText: "rgba(139, 148, 158, 0.8)",
  hoverLine: "rgba(255, 255, 255, 0.55)",
  selectionFill: "rgba(0, 240, 255, 0.12)",
  selectionStroke: "rgba(0, 240, 255, 0.7)",
  cursorA: "#ffcc00",
  cursorB: "#a855f7",
  trigger: "#ff0055",
  curves: ["#00f0ff", "#ffcc00", "#00ff66", "#ff5c8a", "#a855f7", "#38bdf8", "#ff8800", "#e2e8f0"],
  waveGrid: "rgba(255, 255, 255, 0.04)",
  waveRulerText: "rgba(160, 174, 192, 0.6)",
  waveRulerLine: "rgba(255, 255, 255, 0.12)",
  waveRowLine: "rgba(255, 255, 255, 0.06)",
  waveBit: "#00f0ff",
  waveAnalog: "#ffcc00",
  waveBus: "#00ff66",
  waveBusFill: "rgba(0, 255, 102, 0.08)",
  waveBusDense: "rgba(0, 255, 102, 0.45)",
  waveBusText: "#ffffff",
  waveTrigger: "#ff0055",
};

// On white a trace is a thin dark line: saturated, dark hues instead of the neon ones, each still the hue of its
// slot in the dark list where that can be read (the yellow becomes an olive, the near-white a slate).
const LIGHT: PlotPalette = {
  background: "#ffffff",
  margin: "#ffffff",
  grid: "rgba(15, 23, 42, 0.08)",
  zeroLine: "rgba(15, 23, 42, 0.3)",
  axisText: "rgba(51, 65, 85, 0.95)",
  frame: "rgba(15, 23, 42, 0.25)",
  emptyText: "rgba(91, 102, 117, 0.95)",
  hoverLine: "rgba(15, 23, 42, 0.5)",
  selectionFill: "rgba(7, 96, 140, 0.14)",
  selectionStroke: "rgba(7, 96, 140, 0.8)",
  cursorA: "#a04a08",
  cursorB: "#7c3aed",
  trigger: "#c40037",
  // the second and the seventh are kept apart in hue, from each other and from the brown of cursor A
  curves: ["#0b7fb3", "#807500", "#15803d", "#db2777", "#7c3aed", "#1e40af", "#c2410c", "#475569"],
  waveGrid: "rgba(15, 23, 42, 0.06)",
  waveRulerText: "rgba(51, 65, 85, 0.85)",
  waveRulerLine: "rgba(15, 23, 42, 0.2)",
  waveRowLine: "rgba(15, 23, 42, 0.08)",
  waveBit: "#07608c",
  waveAnalog: "#a04a08",
  waveBus: "#15803d",
  waveBusFill: "rgba(21, 128, 61, 0.1)",
  waveBusDense: "rgba(21, 128, 61, 0.5)",
  waveBusText: "#1b2330",
  waveTrigger: "#c40037",
};

/** The canvas colours of a theme. Always the same object for a theme: look it up once per draw, compare by identity. */
export function plotPalette(theme: ThemeName): PlotPalette {
  return theme === "dark" ? DARK : LIGHT;
}

/** The colours a new curve is given, and stored with: those of the dark theme, whichever theme is on screen. */
export const CURVE_SLOTS = DARK.curves;

/**
 * A curve keeps the colour it was given in its settings and in the stored layouts, as the entry of the dark list
 * (so a layout means the same in both themes and in both windows). This is how that colour looks in a theme; a
 * colour that is not from the list is shown as it is.
 */
export function curveColor(stored: string, palette: PlotPalette): string {
  const slot = CURVE_SLOTS.indexOf(stored);
  return slot < 0 ? stored : palette.curves[slot];
}

function stored(): ThemeName {
  try {
    const name = localStorage.getItem(STORAGE_KEY);
    return name === "light" || name === "dark" ? name : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // no storage (a locked-down webview): the default, for this run
  }
}

let current: ThemeName = DEFAULT_THEME;
let started = false;
/** false once a switch could not be stored: the storage then no longer says what this window shows */
let persisted = true;
const listeners = new Set<() => void>();

function apply(name: ThemeName) {
  current = name;
  document.documentElement.dataset.theme = name;
  listeners.forEach((cb) => cb());
}

/** Call before the first render: sets data-theme on <html>, which chooses the palette of App.css. */
export function initTheme(): void {
  if (started) return;
  started = true;
  apply(stored());
  // The other window of the app (main / pop-out analysis) shares the storage: a switch made there arrives here
  // as a "storage" event. Checked again when this window gets the focus, should an event have been missed.
  const follow = () => {
    if (!persisted) return; // nothing was stored for the theme on screen: the storage has no say over it
    const name = stored();
    if (name !== current) apply(name);
  };
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    persisted = true; // the other window did store: what it stored counts again
    follow();
  });
  window.addEventListener("focus", follow);
}

export function getTheme(): ThemeName {
  return current;
}

export function setTheme(name: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
    persisted = true;
  } catch {
    persisted = false; // the theme then lasts for this run only
  }
  if (name !== current) apply(name);
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribe, getTheme);
}
