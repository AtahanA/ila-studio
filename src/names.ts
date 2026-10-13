// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

// Names the page shows for what lies on disk. Pure functions: no DOM, no React.

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
