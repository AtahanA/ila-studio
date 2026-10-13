// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

// Names the page shows for what lies on disk, and the small readings of text that several parts of it share.
// Pure functions: no DOM, no React.
import { PROBE_FORMATS, ProbeFormat } from "./types";

/**
 * "20250101_120000_unit/cap_run_001_0003": every single capture is called cap_run_001, the folder tells them
 * apart. The ending of a capture file is left out, whichever of the three it is - a recording made from the
 * command line is gzipped.
 */
export function captureLabel(path: string): string {
  const parts = path.split(/[\\/]/);
  const file = (parts.pop() || path).replace(/\.(csv\.gz|csv|ila)$/i, "");
  const folder = parts.pop();
  return folder ? `${folder}/${file}` : file;
}

/**
 * The short name of an ILA core: the last part of its cell path, and of that what follows the last dot
 * ("u_top/dbg.u_ila_0" is "u_ila_0"). It says which core it is; the whole path belongs into a tooltip.
 */
export function shortCore(name: string): string {
  const leaf = name.split("/").pop() || name;
  return leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".") + 1) : leaf;
}

/**
 * One file, however its path is spelled: Windows takes either slash and any case. Paths are compared by this key,
 * and the formats chosen for a probe file are stored under it - its form must stay as it is, or what was stored
 * is no longer found.
 */
export function pathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

/** What a progress line of the driver should put into the status bar, or null for Vivado's own chatter. */
export function statusFromLogLine(line: string): string | null {
  const text = line.replace(/^\d\d:\d\d:\d\d\s+/, "");
  const vivado = text.match(/^\[vivado[^\]]*\]\s*(.*)$/);
  if (!vivado) return text.trim() || null;
  const body = vivado[1];
  if (body.startsWith("[ILA_REPL]")) return body.replace("[ILA_REPL]", "").trim() || null;
  return /^(ERROR|WARNING)/.test(body) ? body : null;
}

/**
 * The formats that are not the default, of the entries that name a format this tool writes: what a profile or
 * the storage holds of them is text anyone can edit. A bus is named without its range.
 */
export function cleanFormats(given: unknown): Record<string, ProbeFormat> {
  const out: Record<string, ProbeFormat> = {};
  if (given && typeof given === "object") {
    for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
      const format = String(value).toLowerCase() as ProbeFormat;
      if (PROBE_FORMATS.includes(format) && format !== "unsigned") out[name.replace(/\[\d+:\d+\]$/, "")] = format;
    }
  }
  return out;
}
