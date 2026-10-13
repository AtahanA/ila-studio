// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

// Signal maths for the analysis view. Pure functions: no DOM, no React - so they can be tested on their own.

export type SignMode = "auto" | "unsigned" | "signed";
export type Transform = "raw" | "derivative" | "moving_average" | "abs";

/**
 * Does a column of unsigned capture values look like two's complement? An ILA exports every bus as an unsigned
 * number, so a signed signal around zero shows up as values hugging BOTH ends of the range (17, 16381, 3, 16335
 * for a 14-bit bus), and a small negative constant as a value just below the top. Narrow buses are left alone:
 * they are states and flags, not numbers.
 *
 * Three rules, in this order:
 *  1. One clear empty stretch of the code range. A signal leaves the part of the range it never reaches empty:
 *     empty around mid-scale means the values sit at both ends (signed), empty around the wrap-over point means
 *     they sit in the middle (unsigned).
 *  2. Continuity: read the wrong way, a signal jumps by the full range every time it crosses zero (signed read
 *     as unsigned) or mid-scale (unsigned read as signed), so the reading that travels less is the right one -
 *     as long as the signal moves less than half the range from one sample to the next.
 *  3. Where neither reading wraps (constants, one-sided signals, random words), the position of the values.
 *
 * What no rule can decide: a tone above about two thirds of full scale with fewer than about six samples per
 * period that is sampled coherently (exactly fs/4, say) - both readings are then equally good tones. The chip
 * in the plot shows what was chosen and switches it.
 */
export function looksSigned(values: ArrayLike<number>, width: number): boolean {
  if (width < 8 || width > 52) return false;
  const half = 2 ** (width - 1);
  const full = 2 ** width;
  const quarter = 2 ** (width - 2);
  const BINS = 256;
  const used = new Uint8Array(BINS);
  let middle = 0;
  let top = 0;
  let travelUnsigned = 0;
  let travelSigned = 0;
  let prevU = 0;
  let prevS = 0;
  for (let i = 0; i < values.length; i++) {
    const u = values[i];
    const s = u >= half ? u - full : u;
    const bin = Math.floor((u / full) * BINS);
    used[bin < 0 ? 0 : bin >= BINS ? BINS - 1 : bin] = 1;
    if (u >= 3 * quarter) top++;
    else if (u >= quarter) middle++;
    if (i > 0) {
      travelUnsigned += Math.abs(u - prevU);
      travelSigned += Math.abs(s - prevS);
    }
    prevU = u;
    prevS = s;
  }

  // rule 1: the longest run of unused bins around the circle, if it clearly stands out from the next longest
  let firstUsed = -1;
  for (let k = 0; k < BINS; k++) {
    if (used[k]) {
      firstUsed = k;
      break;
    }
  }
  if (firstUsed >= 0) {
    let longestStart = -1;
    let longest = 0;
    let second = 0;
    let runStart = -1;
    let runLength = 0;
    for (let c = 1; c <= BINS; c++) {
      const k = (firstUsed + c) % BINS;
      if (!used[k]) {
        if (runLength === 0) runStart = k;
        runLength++;
      } else if (runLength > 0) {
        if (runLength > longest) {
          second = longest;
          longest = runLength;
          longestStart = runStart;
        } else if (runLength > second) {
          second = runLength;
        }
        runLength = 0;
      }
    }
    if (longest >= 13 && longest >= 4 * second + 2) {
      const inRun = (bin: number) => (bin - longestStart + BINS) % BINS < longest;
      const aroundMiddle = inRun(BINS / 2 - 1) || inRun(BINS / 2);
      const aroundWrap = inRun(BINS - 1) || inRun(0);
      if (aroundMiddle !== aroundWrap) return aroundMiddle;
    }
  }

  if (travelSigned < 0.8 * travelUnsigned) return true;
  if (travelUnsigned < 0.8 * travelSigned) return false;
  return top > 0 && middle <= values.length * 0.02;
}

/**
 * A value read as two's complement of `width` bits. Exact up to 53 bits; a wider bus arrives rounded to 53
 * significant bits already, and the result is as good as that.
 */
export function toSigned(v: number, width: number): number {
  return width >= 1 && v >= 2 ** (width - 1) ? v - 2 ** width : v;
}

/** The samples of one curve as they are plotted and measured: sign interpretation first, then the transform. */
export function prepareCurve(
  values: ArrayLike<number>,
  width: number,
  signed: boolean,
  transform: Transform,
  window: number,
): Float64Array {
  const n = values.length;
  const x = new Float64Array(n);
  // a negative value is that of a wide bus the file wrote signed (see SignalData.values): read unsigned, it is
  // its bits
  for (let i = 0; i < n; i++) x[i] = signed ? toSigned(values[i], width) : values[i] < 0 ? values[i] + 2 ** width : values[i];
  if (transform === "raw") return x;
  const y = new Float64Array(n);
  if (transform === "abs") {
    for (let i = 0; i < n; i++) y[i] = Math.abs(x[i]);
  } else if (transform === "derivative") {
    for (let i = 1; i < n; i++) y[i] = x[i] - x[i - 1]; // change per sample; y[0] stays 0
  } else {
    // Moving average over `window` samples around each one (an even window reaches one sample further back
    // than ahead), over fewer samples at the two ends. The running sums are kept in two 26-bit halves: the
    // samples are integers below 2^53, and this way neither sum can round, however wide the bus.
    const w = Math.max(1, Math.round(window));
    const before = Math.floor(w / 2);
    const after = w - 1 - before;
    const SPLIT = 2 ** 26;
    const high = new Float64Array(n + 1);
    const low = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const h = Math.floor(x[i] / SPLIT);
      high[i + 1] = high[i] + h;
      low[i + 1] = low[i] + (x[i] - h * SPLIT);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - before);
      const b = Math.min(n - 1, i + after);
      y[i] = ((high[b + 1] - high[a]) * SPLIT + (low[b + 1] - low[a])) / (b - a + 1);
    }
  }
  return y;
}

// ---- extremes of any stretch, without touching every sample -------------------------------------------------

/**
 * Minimum and maximum of blocks of samples, in levels: level k holds one entry per 8^(k+1) samples. A plot asks
 * for the extremes of every pixel column on every redraw; with this the cost follows the width of the plot
 * instead of the length of the capture.
 */
export interface Envelope {
  min: Float64Array[];
  max: Float64Array[];
}

const FACTOR = 8;

export function buildEnvelope(y: ArrayLike<number>): Envelope {
  const min: Float64Array[] = [];
  const max: Float64Array[] = [];
  let srcMin: ArrayLike<number> = y;
  let srcMax: ArrayLike<number> = y;
  // only full blocks get an entry: the samples after the last full block are read directly
  for (let n = Math.floor(y.length / FACTOR); n >= 2; n = Math.floor(n / FACTOR)) {
    const lo = new Float64Array(n);
    const hi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let j = k * FACTOR; j < (k + 1) * FACTOR; j++) {
        if (srcMin[j] < mn) mn = srcMin[j];
        if (srcMax[j] > mx) mx = srcMax[j];
      }
      lo[k] = mn;
      hi[k] = mx;
    }
    min.push(lo);
    max.push(hi);
    srcMin = lo;
    srcMax = hi;
  }
  return { min, max };
}

const envelopes = new WeakMap<object, Envelope>();

/** The envelope of an array of samples, built once and kept for as long as the array itself lives. */
export function envelopeOf(y: ArrayLike<number>): Envelope {
  let env = envelopes.get(y as object);
  if (!env) {
    env = buildEnvelope(y);
    envelopes.set(y as object, env);
  }
  return env;
}

export interface Extremes {
  min: number;
  max: number;
}

/** Widens `acc` by the samples a..b (inclusive indices inside the data). */
export function extremes(y: ArrayLike<number>, env: Envelope | null, a: number, b: number, acc: Extremes): void {
  let lo = acc.min;
  let hi = acc.max;
  const end = b + 1;
  if (!env || env.min.length === 0 || end - a < 2 * FACTOR) {
    for (let i = a; i < end; i++) {
      const v = y[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    acc.min = lo;
    acc.max = hi;
    return;
  }
  // the samples before the first and after the last full block, then whole blocks, level by level
  let from = Math.ceil(a / FACTOR);
  let to = Math.floor(end / FACTOR);
  for (let i = a; i < from * FACTOR; i++) {
    const v = y[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (let i = to * FACTOR; i < end; i++) {
    const v = y[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (let level = 0; from < to; level++) {
    const mn = env.min[level];
    const mx = env.max[level];
    if (to - from < 2 * FACTOR || level + 1 >= env.min.length) {
      for (let k = from; k < to; k++) {
        if (mn[k] < lo) lo = mn[k];
        if (mx[k] > hi) hi = mx[k];
      }
      break;
    }
    const headEnd = Math.ceil(from / FACTOR) * FACTOR;
    const tailStart = Math.floor(to / FACTOR) * FACTOR;
    for (let k = from; k < headEnd; k++) {
      if (mn[k] < lo) lo = mn[k];
      if (mx[k] > hi) hi = mx[k];
    }
    for (let k = tailStart; k < to; k++) {
      if (mn[k] < lo) lo = mn[k];
      if (mx[k] > hi) hi = mx[k];
    }
    from = headEnd / FACTOR;
    to = tailStart / FACTOR;
  }
  acc.min = lo;
  acc.max = hi;
}

// ---- measurements -------------------------------------------------------------------------------------------

export interface RangeStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  rms: number;
  std: number;
  peakToPeak: number;
}

/** Statistics over the samples lo..hi (inclusive indices, clamped to the data). */
export function rangeStats(y: ArrayLike<number>, lo: number, hi: number): RangeStats | null {
  const a = Math.max(0, Math.ceil(lo));
  const b = Math.min(y.length - 1, Math.floor(hi));
  if (b < a) return null;
  // Mean and spread are summed as distances from the first sample: a large value that barely moves (a 32-bit
  // counter, a threshold) would otherwise lose its whole spread in the rounding of sum(v²) - mean².
  const ref = y[a];
  let min = Infinity;
  let max = -Infinity;
  let sumD = 0;
  let sumD2 = 0;
  let sumSq = 0;
  for (let i = a; i <= b; i++) {
    const v = y[i];
    if (v < min) min = v;
    if (v > max) max = v;
    const d = v - ref;
    sumD += d;
    sumD2 += d * d;
    sumSq += v * v;
  }
  const n = b - a + 1;
  const meanD = sumD / n;
  return {
    n,
    min,
    max,
    mean: ref + meanD,
    rms: Math.sqrt(sumSq / n),
    std: Math.sqrt(Math.max(0, sumD2 / n - meanD * meanD)),
    peakToPeak: max - min,
  };
}

export interface EdgeStats {
  rising: number;
  falling: number;
  /** fraction of the samples above the threshold */
  duty: number;
  /** mean distance between rising edges in samples; null with fewer than two of them */
  periodSamples: number | null;
  /**
   * where the signal rises through the level: positions on the sample axis, read between the samples - an edge is
   * put where the signal last passed the level itself on its way up through the band
   */
  risingAt: number[];
}

/**
 * Edges of a signal against a level: what a logic probe needs. Without a given threshold the level is midway
 * between the extremes, with a band of a tenth of the swing on either side that the signal has to cross
 * completely - so the noise on a slow signal passing the level does not count as a burst of edges.
 * `extent` saves measuring the extremes again when the caller has them.
 */
export function edgeStats(
  y: ArrayLike<number>,
  lo: number,
  hi: number,
  threshold?: number,
  extent?: { min: number; max: number },
): EdgeStats | null {
  const a = Math.max(0, Math.ceil(lo));
  const b = Math.min(y.length - 1, Math.floor(hi));
  if (b < a) return null;
  let level: number;
  let band = 0;
  if (threshold !== undefined) {
    level = threshold;
  } else {
    const s = extent ?? rangeStats(y, a, b);
    if (!s) return null;
    level = (s.min + s.max) / 2;
    band = (s.max - s.min) * 0.1;
  }
  const up = level + band;
  const down = level - band;
  const risingAt: number[] = [];
  let falling = 0;
  let high = 0;
  let state = y[a] > level;
  let below = a; // the last sample at or below the level, while the signal is low
  if (state) high++;
  for (let i = a + 1; i <= b; i++) {
    const v = y[i];
    if (v > level) high++;
    if (state) {
      if (band > 0 ? v < down : v <= level) {
        state = false;
        falling++;
        below = i;
      }
    } else if (v > up) {
      state = true;
      risingAt.push(below + (level - y[below]) / (y[below + 1] - y[below]));
    } else if (v <= level) {
      below = i;
    }
  }
  const rising = risingAt.length;
  return {
    rising,
    falling,
    duty: high / (b - a + 1),
    // from where the level is crossed, not from the samples after it: a tone's period to a small part of a sample
    periodSamples: rising >= 2 ? (risingAt[rising - 1] - risingAt[0]) / (rising - 1) : null,
    risingAt,
  };
}

export interface Spectrum {
  /** amplitude per bin in dB (20 log10), relative to an amplitude of 1 in the signal's own units */
  db: Float64Array;
  /** bin spacing in cycles per sample: multiply by the sample rate for Hz */
  binCyclesPerSample: number;
  /** samples that went into it */
  n: number;
}

/** the most samples a spectrum is taken from: of a longer stretch, the first so many */
export const MAX_FFT = 1 << 17;

/** A stretch of samples with its mean removed (so the DC bin does not bury everything) under a Hann window. */
interface Windowed {
  x: Float64Array;
  /** the sum of the window: what an amplitude taken from `x` is divided by */
  sum: number;
}

function hannWindowed(y: ArrayLike<number>, a: number, n: number): Windowed {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += y[a + i];
  mean /= n;
  const x = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    sum += w;
    x[i] = (y[a + i] - mean) * w;
  }
  return { x, sum };
}

const windowedStretches = new WeakMap<object, { a: number; n: number; windowed: Windowed }>();

/**
 * The same, kept for the stretch an array was last asked for: the tone of a signal and its phase against several
 * others are all taken from one stretch, which is then windowed once.
 */
function windowedOf(y: ArrayLike<number>, a: number, n: number): Windowed {
  let entry = windowedStretches.get(y as object);
  if (!entry || entry.a !== a || entry.n !== n) {
    entry = { a, n, windowed: hannWindowed(y, a, n) };
    windowedStretches.set(y as object, entry);
  }
  return entry.windowed;
}

/**
 * What a point of a spectrum stands for, `distance` resolution cells below fs/2. Every point but the first and
 * the last stands for two: itself and its mirror image in the upper half. Within one cell of fs/2 the two run
 * into each other (a tone at fs/2 IS its own mirror image), so the doubling is faded out there along the
 * window's main lobe instead of counting that tone twice.
 */
function mirrorWeight(distance: number): number {
  if (!(distance > 0)) return 1;
  if (distance >= 1) return 2;
  return Math.min(2, (Math.PI * distance * (1 - distance * distance)) / Math.sin(Math.PI * distance));
}

/**
 * Amplitude spectrum of the samples lo..hi: mean removed, Hann window, zero-padded to a power of two. A sine of
 * amplitude A shows up at about 20 log10(A) dB.
 */
export function spectrum(y: ArrayLike<number>, lo: number, hi: number, points = 0): Spectrum | null {
  const a = Math.max(0, Math.ceil(lo));
  const b = Math.min(y.length - 1, Math.floor(hi));
  const n = Math.min(b - a + 1, MAX_FFT);
  if (n < 8) return null;
  return spectrumOf(hannWindowed(y, a, n), points);
}

function spectrumOf({ x, sum }: Windowed, points: number): Spectrum {
  const n = x.length;
  // `points` (see spectrumPoints) pads further: spectra of stretches of different lengths then share one
  // frequency axis
  let size = 1;
  while (size < n || size < points) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(x);
  fftInPlace(re, im);
  const half = size / 2;
  const db = new Float64Array(half + 1);
  const cell = size / (n - 1); // points per resolution cell of this window
  for (let k = 0; k <= half; k++) {
    const both = k === 0 ? 1 : mirrorWeight((half - k) / cell);
    const amplitude = (Math.hypot(re[k], im[k]) * both) / sum;
    db[k] = 20 * Math.log10(Math.max(amplitude, 1e-12));
  }
  return { db, binCyclesPerSample: 1 / size, n };
}

/**
 * The points spectrum() transforms for the samples lo..hi of an array of `length` samples; 0 when they are too
 * few for a spectrum. Curves of different lengths in one plot are all transformed with the largest of these.
 */
export function spectrumPoints(length: number, lo: number, hi: number): number {
  const n = Math.min(Math.min(length - 1, Math.floor(hi)) - Math.max(0, Math.ceil(lo)) + 1, MAX_FFT);
  if (n < 8) return 0;
  let size = 1;
  while (size < n) size <<= 1;
  return size;
}

/**
 * What the Hann window shows of a line `cells` resolution cells away from it, as a part of its height: the main
 * lobe as it is, beyond it the height its side lobes reach at most.
 */
function hannSpill(cells: number): number {
  const d = Math.abs(cells);
  if (d < 1e-6) return 1;
  if (Math.abs(d - 1) < 1e-6) return 0.5;
  return Math.min(1, (d < 1.5 ? Math.abs(Math.sin(Math.PI * d)) : 1) / (Math.PI * d * Math.abs(1 - d * d)));
}

/**
 * The test a point of the band a..b (1 <= a) has to pass to count as a summit of the band's own: higher than its
 * neighbours - and not just what a stronger line outside the band shows there. The skirt of such a line is a
 * slope only while the points lie one resolution cell apart; a stretch that is no power of two long is padded,
 * and then the side lobes of the line show as a row of small summits beside it. A summit counts when it stands
 * 6 dB above what any higher point outside the band can show at its place. A level stretch (the floor of a
 * spectrum that holds nothing there) has no summit.
 */
function ownSummits(sp: Spectrum, a: number, b: number): (k: number) => boolean {
  const db = sp.db;
  const last = db.length - 1;
  const cell = (2 * last) / (sp.n - 1); // points per resolution cell
  // the points outside that can show most inside: walking away from the band, each one higher than all before it
  const outside: number[] = [];
  let top = -Infinity;
  for (let q = a - 1; q >= 0; q--) {
    if (db[q] > top) {
      top = db[q];
      outside.push(q);
    }
  }
  top = -Infinity;
  for (let q = b + 1; q <= last; q++) {
    if (db[q] > top) {
      top = db[q];
      outside.push(q);
    }
  }
  return (k) => {
    const before = db[k - 1];
    const after = k < last ? db[k + 1] : -Infinity;
    if (db[k] < before || db[k] < after || (db[k] === before && (k === last || db[k] === after))) return false;
    for (const q of outside) {
      if (db[q] > db[k] && db[k] < db[q] + 20 * Math.log10(hannSpill((k - q) / cell)) + 6) return false;
    }
    return true;
  };
}

/**
 * The strongest point of a spectrum (the removed mean in point 0 aside). A tone at fs/2 shows as a plateau of the
 * last points; the last one is its true place.
 *
 * With `from` and `to`, the strongest of the points from..to only: what a spectrum zoomed in on that band shows.
 * There a summit of the band's own (see ownSummits) counts before anything else - the band of a weak line often
 * begins on the skirt of a strong one outside it, which is higher than the line without being a component of the
 * band. Only a band without any such summit (nothing but that skirt) gives its highest point.
 */
export function spectrumPeak(sp: Spectrum, from = 0, to = Infinity): number {
  const db = sp.db;
  const last = db.length - 1;
  const a = Math.max(Math.min(1, last), Math.ceil(from - 1e-6));
  const b = Math.min(last, Math.floor(to + 1e-6));
  if (b < a) return Math.min(a, last);
  let peak = a;
  if (a <= 1 && b >= last) {
    for (let k = a + 1; k <= last; k++) if (db[k] > db[peak]) peak = k;
  } else {
    const own = ownSummits(sp, a, b);
    let summit = -1;
    for (let k = a; k <= b; k++) {
      if (db[k] > db[peak]) peak = k;
      if ((summit < 0 || db[k] > db[summit]) && own(k)) summit = k;
    }
    if (summit >= 0) peak = summit;
  }
  return b === last ? endIfThere(sp, peak) : peak;
}

/** A tone at fs/2 shows as a plateau of the last points of a spectrum: a peak found on it is put at its end. */
function endIfThere(sp: Spectrum, peak: number): number {
  const last = sp.db.length - 1;
  return (last - peak) * (sp.n - 1) <= 2 * last && sp.db[last] > sp.db[peak] - 0.1 ? last : peak;
}

/** Σ x[i]·e^(-j·2π·cycles·i): what a (windowed) stretch holds at one frequency, in cycles per sample. */
function contentAt(x: Float64Array, cycles: number): { re: number; im: number } {
  // the phasor is turned on from sample to sample instead of taking a sine and a cosine for each
  const turn = 2 * Math.PI * cycles;
  const turnRe = Math.cos(turn);
  const turnIm = Math.sin(turn);
  let c = 1;
  let s = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * c;
    im -= x[i] * s;
    const next = c * turnRe - s * turnIm;
    s = c * turnIm + s * turnRe;
    c = next;
  }
  return { re, im };
}

/** The samples of lo..hi a tone or a phase is taken from: of a stretch longer than MAX_FFT the first so many. */
function stretchOf(length: number, lo: number, hi: number): { a: number; n: number } {
  const a = Math.max(0, Math.ceil(lo));
  return { a, n: Math.min(Math.min(length - 1, Math.floor(hi)) - a + 1, MAX_FFT) };
}

export interface Tone {
  /** frequency in cycles per sample */
  cycles: number;
  /** amplitude, in the signal's own units */
  amplitude: number;
  /** samples it was taken from */
  n: number;
  /** by what factor it stands out of what lies around it in the spectrum (see prominenceAt) */
  prominence: number;
}

/**
 * The tone a signal repeats with over the samples lo..hi: the lowest of its strongest components, its frequency
 * read between the points of the spectrum, where the summit of the window's main lobe really lies.
 *
 * Not simply the highest point: a strobe one clock wide has all its harmonics at the same height, and which of
 * them comes out highest is decided by where they fall between the points. So of the summits within 3 dB of the
 * strongest, the lowest is taken - for a sine, a square wave or a pulse that is the fundamental. The search
 * begins two resolution cells up: below that not two periods fit into the stretch, and the skirt of what the
 * removed mean leaves lies there.
 *
 * Null for a stretch that does not move, or is too short for a spectrum. What it returns is the best there is,
 * also for a signal that does not repeat at all: see repeats().
 */
export function fundamentalTone(y: ArrayLike<number>, lo: number, hi: number): Tone | null {
  const { a, n } = stretchOf(y.length, lo, hi);
  if (n < 8) return null;
  let moves = false;
  for (let i = 1; i < n && !moves; i++) moves = y[a + i] !== y[a];
  if (!moves) return null; // a large constant leaves the rounding of its mean in the spectrum: that is no tone
  const windowed = windowedOf(y, a, n);
  const sp = spectrumOf(windowed, 0);
  const db = sp.db;
  const last = db.length - 1;
  const point = sp.binCyclesPerSample;
  const from = Math.min(last, Math.ceil((4 * last) / (n - 1))); // two cells, in points
  const own = ownSummits(sp, from, last);
  let peak = spectrumPeak(sp, from, last);
  // (a line of its own: two cells or more below the strongest, not a point on the way up to it)
  for (let k = from; k <= peak - from; k++) {
    if (db[k] >= db[peak] - 3 && own(k)) {
      peak = k;
      break;
    }
  }
  let cycles = peak * point;
  if (peak < last) {
    // Three readings around that point, half a point apart and then a tenth: that close to its summit the
    // logarithm of the main lobe is all but a parabola, whose summit is where the tone is.
    const level = (f: number) => {
      const c = contentAt(windowed.x, f);
      return Math.log(Math.max(Math.hypot(c.re, c.im), 1e-300));
    };
    for (const reach of [0.5, 0.1]) {
      const h = reach * point;
      const left = level(cycles - h);
      const middle = level(cycles);
      const right = level(cycles + h);
      const bend = left - 2 * middle + right;
      if (!(bend < 0)) break; // no summit between the three
      cycles += Math.max(-2, Math.min(2, (0.5 * (left - right)) / bend)) * h;
    }
    cycles = Math.min(Math.max(cycles, 0.25 * point), 0.5);
  }
  const c = contentAt(windowed.x, cycles);
  return {
    cycles,
    amplitude: (Math.hypot(c.re, c.im) * mirrorWeight((0.5 - cycles) * (n - 1))) / windowed.sum,
    n,
    prominence: prominenceAt(windowed.x, cycles),
  };
}

/**
 * By what factor a windowed stretch holds one frequency more than what lies around it: its content over the
 * median of the content 3, 4, 5 and 6 resolution cells to either side. A line at that frequency leaves nothing of
 * its own there (the Hann window has its zeros at whole cells), so a line stands out many times - fifty and
 * more for anything that repeats seven times in the stretch - while noise, a data bus or the skirt of another
 * line stand out hardly at all: the highest point of a spectrum without lines some two or three times, rarely
 * six.
 */
function prominenceAt(x: Float64Array, cycles: number): number {
  const size = (f: number) => {
    const c = contentAt(x, f);
    return Math.hypot(c.re, c.im);
  };
  const cell = 1 / (x.length - 1);
  const around: number[] = [];
  for (let k = 3; k <= 6; k++) around.push(size(cycles - k * cell), size(cycles + k * cell));
  around.sort((p, q) => p - q);
  const median = (around[3] + around[4]) / 2;
  const here = size(cycles);
  return median > 0 ? here / median : here > 0 ? Infinity : 0;
}

/**
 * Does a signal repeat over its stretch, so that a frequency and a phase mean something? Its tone (see
 * fundamentalTone) has to go round two and a half times at least - with fewer periods the window cannot tell it
 * from the mean and from its own mirror image (at two periods the frequency is still right to a percent, at one
 * and a half it is a tenth off), and a step comes out as "about one period per stretch". And so have its rising
 * edges (see edgeStats): a single pulse has a spectrum too, and of a signal with fewer periods than the search
 * for the tone begins at, that search finds a harmonic or the rounding of the samples. Just below fs/2 a tone
 * runs into its mirror image; exactly there it is its own.
 *
 * And it has to be a line: the highest point of the spectrum of noise or of a data bus is no tone. From seven
 * periods on, where what lies around a line is clear of its harmonics, it has to stand out eight times (see
 * prominenceAt: whatever repeats does so fifty times and more, noise hardly ever). With fewer periods the
 * harmonics of a pulse train lie in that neighbourhood and it says nothing; there noise and data give themselves
 * away by having many more edges than there would be periods.
 */
export function repeats(tone: Tone | null, edges: Pick<EdgeStats, "rising" | "periodSamples"> | null): tone is Tone {
  if (!tone || !edges || edges.periodSamples === null || !(edges.periodSamples > 0)) return false;
  const cells = tone.n - 1;
  const periods = tone.cycles * cells;
  if (periods < 2.5 || cells / edges.periodSamples < 2.5) return false;
  if (tone.cycles < 0.5 && (0.5 - tone.cycles) * cells < 1.5) return false;
  return periods >= 7 ? tone.prominence >= 8 : edges.rising <= 4 * periods;
}

export interface PhaseBetween {
  /**
   * phase of the signal minus phase of the reference in degrees, above -180 up to 180. Negative: the signal lags,
   * it does what the reference does that part of a period later.
   */
  degrees: number;
  /** amplitude of the component in the reference and in the signal */
  referenceAmplitude: number;
  amplitude: number;
  /** samples it was taken from: those both have */
  n: number;
}

/**
 * Phase of a signal against a reference at one frequency (cycles per sample), over the samples lo..hi that both
 * have: mean removed, Hann window - the component is taken out of each the way spectrum() would show it. It only
 * means something where both hold that frequency: see phaseAgainst().
 */
export function phaseBetween(
  reference: ArrayLike<number>,
  y: ArrayLike<number>,
  lo: number,
  hi: number,
  cycles: number,
): PhaseBetween | null {
  const { a, n } = stretchOf(Math.min(reference.length, y.length), lo, hi);
  if (n < 8) return null;
  const r = windowedOf(reference, a, n);
  const s = windowedOf(y, a, n);
  const cr = contentAt(r.x, cycles);
  const cs = contentAt(s.x, cycles);
  const sizeR = Math.hypot(cr.re, cr.im);
  const sizeS = Math.hypot(cs.re, cs.im);
  if (!(sizeR > 0) || !(sizeS > 0)) return null;
  // the angle of signal × conj(reference)
  const degrees = (Math.atan2(cs.im * cr.re - cs.re * cr.im, cs.re * cr.re + cs.im * cr.im) * 180) / Math.PI;
  const both = mirrorWeight((0.5 - cycles) * (n - 1));
  return {
    degrees: degrees <= -180 ? 180 : degrees,
    referenceAmplitude: (sizeR * both) / r.sum,
    amplitude: (sizeS * both) / s.sum,
    n,
  };
}

/** By what factor the samples lo..hi hold one frequency more than what lies around it: see prominenceAt. */
export function standsOut(y: ArrayLike<number>, lo: number, hi: number, cycles: number): number {
  const { a, n } = stretchOf(y.length, lo, hi);
  return n < 8 ? 0 : prominenceAt(windowedOf(y, a, n).x, cycles);
}

export interface PhaseAgainst extends PhaseBetween {
  /**
   * true: the phase of the signal's own tone, which is the reference's. false: the signal repeats with another
   * tone, and this is the phase of the component it holds at the reference's frequency beside it.
   */
  own: boolean;
}

/**
 * The phase of a signal against a reference at the reference's tone - where there is one. Both tones as
 * fundamentalTone() gives them for the same stretch, both repeating (see repeats).
 *
 * Two readings of one frequency agree to a small part of a resolution cell: then it is the signal's own tone.
 * Further apart, the signal still has a phase against the reference when it holds the reference's frequency as a
 * line of its own beside its tone: clearly more than its tone spills that far through the window, and standing
 * out of what lies around it - a signal without lines (noise, a data bus) holds something of every frequency.
 * Null where it does not: there is no fixed phase between the two.
 */
export function phaseAgainst(
  reference: ArrayLike<number>,
  y: ArrayLike<number>,
  lo: number,
  hi: number,
  referenceTone: Tone,
  tone: Tone,
): PhaseAgainst | null {
  const found = phaseBetween(reference, y, lo, hi, referenceTone.cycles);
  if (!found) return null;
  const cells = Math.abs(tone.cycles - referenceTone.cycles) * (found.n - 1);
  if (cells <= 0.5) return { ...found, own: true };
  // three times what the window shows of its tone that far away, and 3 % of it at least
  if (found.amplitude < Math.max(0.03, 3 * hannSpill(cells)) * tone.amplitude) return null;
  if (standsOut(y, lo, hi, referenceTone.cycles) < 4) return null;
  return { ...found, own: false };
}

export interface EdgeDelay {
  /** edges of the reference that have an edge of the signal to go with */
  count: number;
  mean: number;
  min: number;
  max: number;
  /**
   * steady: the delays lie together, there is one delay · opposite: the signal's edges lie midway between the
   * reference's, as near before one as after the next - mean, min and max are then all counted as "after" ·
   * scattered: they lie all over the distance between two edges, there is no one delay
   */
  kind: "steady" | "opposite" | "scattered";
}

/**
 * From each edge of `reference` to the edge of `signal` nearest to it, in samples: positive when the signal's
 * edge is the later one. An edge of the signal goes with the edge of the reference it lies closest to, so a
 * request that is answered late, or never, does not borrow the answer to the next one. Both lists ascending
 * (see EdgeStats.risingAt), from the samples lo..hi: a pair further apart than either of its edges is from an
 * end of that stretch is left out - the edge that really belongs there may lie just outside. Unless that leaves
 * nothing: one request and its late answer are the pair they look like. Null when no edge of the reference has
 * one of the signal.
 */
export function edgeDelays(
  reference: ArrayLike<number>,
  signal: ArrayLike<number>,
  lo = -Infinity,
  hi = Infinity,
): EdgeDelay | null {
  const found: number[] = [];
  const sure: number[] = []; // those of them that no edge outside lo..hi could belong to instead
  let j = 0;
  for (let k = 0; k < reference.length; k++) {
    const at = reference[k];
    // what lies closer to this edge than to its neighbours
    const from = k > 0 ? (reference[k - 1] + at) / 2 : -Infinity;
    const to = k + 1 < reference.length ? (at + reference[k + 1]) / 2 : Infinity;
    while (j < signal.length && signal[j] <= from) j++;
    let nearest = NaN;
    for (; j < signal.length && signal[j] <= to; j++) {
      const d = signal[j] - at;
      // of two at the same distance the later one, as an edge midway between two of the reference goes with the earlier
      if (nearest !== nearest || Math.abs(d) <= Math.abs(nearest)) nearest = d;
    }
    if (nearest !== nearest) continue;
    found.push(nearest);
    if (Math.abs(nearest) <= Math.min(at - lo, hi - at, at + nearest - lo, hi - at - nearest)) sure.push(nearest);
  }
  if (found.length === 0) return null;
  const delays = sure.length > 0 ? sure : found;
  const measure = (list: number[]): EdgeDelay => {
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const d of list) {
      sum += d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { count: list.length, mean: sum / list.length, min, max, kind: "steady" };
  };
  const plain = measure(delays);
  const spacingOf = (edges: ArrayLike<number>) =>
    edges.length >= 2 ? (edges[edges.length - 1] - edges[0]) / (edges.length - 1) : Infinity;
  const spacing = spacingOf(reference);
  // Delays further apart than half the distance between the edges - of the reference, or of a signal that has
  // more of them: some edge of it is always near - are no one delay.
  const together = Math.min(spacing, spacingOf(signal)) / 2;
  if (!(spacing < Infinity)) return plain.max - plain.min <= together ? plain : { ...plain, kind: "scattered" };
  // Half a period away an edge lies as near before one edge of the reference as after the next: "later" and
  // "earlier" say the same there, and with the least unrest it falls now to this side, now to that.
  const midway = (d: EdgeDelay) => Math.abs(Math.abs(d.mean) - spacing / 2) <= 0.005 * spacing;
  if (plain.max - plain.min <= together) return midway(plain) ? { ...plain, kind: "opposite" } : plain;
  // counted all as "after": do they lie together then?
  const after = measure(delays.map((d) => (d < 0 ? d + spacing : d)));
  return after.max - after.min <= together ? { ...after, kind: "opposite" } : { ...plain, kind: "scattered" };
}

/** Iterative radix-2 FFT; the length must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const i = start + k;
        const j = i + len / 2;
        const tRe = re[j] * curRe - im[j] * curIm;
        const tIm = re[j] * curIm + im[j] * curRe;
        re[j] = re[i] - tRe;
        im[j] = im[i] - tIm;
        re[i] += tRe;
        im[i] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ---- axes and numbers ---------------------------------------------------------------------------------------

/**
 * Round tick positions (1, 2 or 5 times a power of ten apart) covering lo..hi with at most about `count` ticks.
 * None when the range is narrower than doubles can tell apart.
 */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const raw = (hi - lo) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  if (!(step > 0) || lo + step === lo || hi + step === hi) return [];
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > 200) return [];
  const ticks: number[] = [];
  for (let k = first; k <= last; k++) ticks.push(k === 0 ? 0 : k * step);
  return ticks;
}

/**
 * Labels for the ticks of one axis: all with the decimals the distance between two ticks needs, so no two read
 * the same however far the view is zoomed in. Numbers too long for `maxChars` switch to exponent notation where
 * that is shorter.
 */
export function tickLabels(ticks: number[], maxChars = 12): string[] {
  if (ticks.length === 0) return [];
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 0;
  if (!(step > 0)) return ticks.map((t) => (Number.isSafeInteger(t) ? String(t) : String(Number(t.toPrecision(12)))));
  const stepExp = Math.floor(Math.log10(step) + 1e-9);
  const decimals = Math.max(0, Math.min(15, -stepExp));
  const fixed = ticks.map((t) => {
    const text = t.toFixed(decimals);
    return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
  });
  if (fixed.every((s) => s.length <= maxChars)) return fixed;
  const exponent = ticks.map((t) => {
    if (t === 0) return "0";
    const digits = Math.floor(Math.log10(Math.abs(t)) + 1e-9) - stepExp;
    return t.toExponential(Math.max(0, Math.min(15, digits)));
  });
  const longest = (list: string[]) => list.reduce((m, s) => Math.max(m, s.length), 0);
  return longest(exponent) < longest(fixed) ? exponent : fixed;
}

const SI_PREFIXES: Array<[number, string]> = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
];

/** Tick labels with one unit prefix for the whole axis, taken from its largest value: "2.4755 ms", "2.4760 ms". */
export function siTickLabels(ticks: number[], unit: string, maxChars = 12): string[] {
  const top = ticks.reduce((m, t) => Math.max(m, Math.abs(t)), 0);
  if (top === 0) return ticks.map(() => `0 ${unit}`);
  const [factor, prefix] = SI_PREFIXES.find(([f]) => top >= f) ?? SI_PREFIXES[SI_PREFIXES.length - 1];
  return tickLabels(
    ticks.map((t) => t / factor),
    maxChars,
  ).map((s) => `${s} ${prefix}${unit}`);
}

/** 0.0000125 s -> "12.5 µs", with at most `digits` significant digits. */
export function formatSI(value: number, unit: string, digits = 4): string {
  if (!Number.isFinite(value)) return "-";
  if (value === 0) return `0 ${unit}`;
  let index = SI_PREFIXES.findIndex(([f]) => Math.abs(value) >= f);
  if (index < 0) index = SI_PREFIXES.length - 1;
  let scaled = Number((value / SI_PREFIXES[index][0]).toPrecision(digits));
  if (Math.abs(scaled) >= 1000 && index > 0) {
    // rounding carried it over: 999.99 k is 1 M
    index--;
    scaled = Number((value / SI_PREFIXES[index][0]).toPrecision(digits));
  }
  return `${scaled} ${SI_PREFIXES[index][1]}${unit}`;
}

/**
 * A position on an axis whose points lie `step` apart, with a unit prefix and the decimals that tell two
 * neighbouring points apart: "2.475525 ms" for a sample every 25 ns, where four digits would read "2.476 ms" for
 * forty samples in a row. At most three digits of the step are shown.
 */
export function formatSIStep(value: number, step: number, unit: string): string {
  if (!Number.isFinite(value)) return "-";
  if (value === 0) return `0 ${unit}`;
  if (!(Math.abs(step) > 0) || !Number.isFinite(step)) return formatSI(value, unit, 6);
  let index = SI_PREFIXES.findIndex(([f]) => Math.abs(value) >= f);
  if (index < 0) index = SI_PREFIXES.length - 1;
  for (;;) {
    const [factor, prefix] = SI_PREFIXES[index];
    const s = Math.abs(step) / factor;
    const text = toDecimals(value / factor, Math.min(decimalsOf(s), Math.max(0, 2 - Math.floor(Math.log10(s) + 1e-9))));
    // rounding carried it over: 999.9996 µs is 1 ms
    if (Math.abs(Number(text)) >= 1000 && index > 0) index--;
    else return `${text} ${prefix}${unit}`;
  }
}

/** A number in few characters: whole numbers exactly, everything else to about four significant digits. */
export function trimNumber(v: number): string {
  if (!Number.isFinite(v)) return "-";
  if (v === 0) return "0";
  if (Number.isSafeInteger(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1e15 || abs < 1e-4) return v.toExponential(3).replace(/\.?0+e/, "e");
  if (abs >= 1000) return v.toFixed(0);
  const text = abs >= 1 ? v.toFixed(abs >= 100 ? 1 : abs >= 10 ? 2 : 3) : v.toPrecision(4);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** A sample value or a measurement for a read-out: captured values exactly, means of large values to 0.001. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "-";
  if (Number.isInteger(v)) return trimNumber(v);
  return Math.abs(v) >= 1000 && Math.abs(v) < 1e12 ? String(Math.round(v * 1000) / 1000) : trimNumber(v);
}

/** A position on an axis that shows `span`: as many decimals as a thousandth of the axis needs. */
export function formatOnAxis(v: number, span: number): string {
  if (!Number.isFinite(v)) return "-";
  if (!(span > 0) || !Number.isFinite(span)) return formatValue(v);
  const decimals = Math.max(0, Math.min(12, 3 - Math.floor(Math.log10(span) + 1e-9)));
  const text = v.toFixed(decimals);
  const trimmed = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  return trimmed === "-0" ? "0" : trimmed;
}

/** The decimals a number needs to be printed without loss, up to 12 (0.1 + 0.2 counts as one decimal). */
export function decimalsOf(v: number): number {
  if (!Number.isFinite(v)) return 0;
  for (let d = 0; d < 12; d++) {
    if (Math.abs(Number(v.toFixed(d)) - v) <= Math.abs(v) * 4 * Number.EPSILON) return d;
  }
  return 12;
}

/** `v` with exactly `decimals` decimals, without a "-0". */
export function toDecimals(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return "-";
  const text = v.toFixed(Math.max(0, Math.min(12, decimals)));
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}
