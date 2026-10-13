// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import {
  type Extremes,
  MAX_FFT,
  type Tone,
  buildEnvelope,
  decimalsOf,
  edgeDelays,
  edgeStats,
  envelopeOf,
  extremes,
  fftInPlace,
  formatOnAxis,
  formatSI,
  formatSIStep,
  formatValue,
  fundamentalTone,
  looksSigned,
  niceTicks,
  phaseAgainst,
  phaseBetween,
  prepareCurve,
  rangeStats,
  repeats,
  siTickLabels,
  spectrum,
  spectrumPeak,
  spectrumPoints,
  standsOut,
  tickLabels,
  toDecimals,
  toSigned,
  trimNumber,
} from "./analysis";

/** A small generator with a seed (mulberry32): the "random" cases are the same numbers on every run. */
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

/** `cycles` periods of a sine in `n` samples */
const sine = (n: number, cycles: number, amplitude = 1, phase = 0, offset = 0) =>
  Float64Array.from({ length: n }, (_, i) => offset + amplitude * Math.sin((2 * Math.PI * cycles * i) / n + phase));

/** values 0..16383 spread evenly: what a data bus or noise looks like */
const words = (n: number, seed: number) => {
  const random = seeded(seed);
  return Float64Array.from({ length: n }, () => Math.floor(random() * 16384));
};

/** a negative value as an ILA exports it for a 14-bit bus */
const stored14 = (v: number) => (v < 0 ? v + 16384 : v);

describe("toSigned", () => {
  it("reads the upper half of the range as negative", () => {
    expect(toSigned(16354, 14)).toBe(-30);
    expect(toSigned(8192, 14)).toBe(-8192);
    expect(toSigned(8191, 14)).toBe(8191);
    expect(toSigned(0, 14)).toBe(0);
  });

  it("is exact for a bus of 53 bits", () => {
    expect(toSigned(2 ** 53 - 30, 53)).toBe(-30);
  });

  it("leaves the value alone without a width", () => {
    expect(toSigned(5, 0)).toBe(5);
  });
});

describe("looksSigned", () => {
  it("sees values at both ends of the range as signed", () => {
    expect(looksSigned([17, 16381, 3, 16335], 14)).toBe(true);
  });

  it("leaves a signal around mid-scale unsigned", () => {
    expect(looksSigned(sine(1000, 20, 1000, 0, 8192).map(Math.round), 14)).toBe(false);
  });

  it("sees the same signal around zero as signed", () => {
    expect(looksSigned(sine(1000, 20, 1000).map((v) => stored14(Math.round(v))), 14)).toBe(true);
  });

  it("decides a full-scale signal by the reading that does not jump", () => {
    expect(looksSigned(sine(1000, 20.3, 8000).map((v) => stored14(Math.round(v))), 14)).toBe(true);
    expect(looksSigned(sine(1000, 20.3, 8000, 0, 8192).map(Math.round), 14)).toBe(false);
  });

  it("sees a constant just below the top as a small negative number", () => {
    expect(looksSigned(new Array(100).fill(16354), 14)).toBe(true);
    expect(looksSigned(new Array(100).fill(100), 14)).toBe(false);
  });

  it("leaves random words unsigned", () => {
    expect(looksSigned(words(1000, 1), 14)).toBe(false);
  });

  it("judges buses of 8 to 52 bits only", () => {
    expect(looksSigned([3, 125, 1, 120], 7)).toBe(false);
    expect(looksSigned([3, 253, 1, 250], 8)).toBe(true);
    expect(looksSigned([3, 2 ** 52 - 3, 1, 2 ** 52 - 6], 52)).toBe(true);
    expect(looksSigned([3, 2 ** 53 - 4, 1, 2 ** 53 - 6], 53)).toBe(false);
  });

  it("is false without samples", () => {
    expect(looksSigned([], 14)).toBe(false);
  });
});

describe("prepareCurve", () => {
  it("returns a copy of the values for an unsigned raw curve", () => {
    const values = [1, 16354, 3];
    const curve = prepareCurve(values, 14, false, "raw", 1);
    expect(Array.from(curve)).toEqual(values);
    curve[0] = 99;
    expect(values[0]).toBe(1);
  });

  it("reads a signed curve as two's complement of the width", () => {
    expect(Array.from(prepareCurve([1, 16354, 8191, 8192], 14, true, "raw", 1))).toEqual([1, -30, 8191, -8192]);
  });

  it("gives a negative input its bits back when it is read unsigned", () => {
    // -30 on a 14-bit bus is 2^14 - 30
    expect(Array.from(prepareCurve([-30, 5], 14, false, "raw", 1))).toEqual([16354, 5]);
  });

  it("takes the change per sample, with 0 for the first", () => {
    expect(Array.from(prepareCurve([1, 4, 9], 8, false, "derivative", 1))).toEqual([0, 3, 5]);
  });

  it("takes the magnitude after the sign", () => {
    expect(Array.from(prepareCurve([16354, 30], 14, true, "abs", 1))).toEqual([30, 30]);
    expect(Array.from(prepareCurve([16354, 30], 14, false, "abs", 1))).toEqual([16354, 30]);
  });

  it("averages over the window around each sample, over fewer samples at the ends", () => {
    expect(Array.from(prepareCurve([0, 3, 6, 9], 8, false, "moving_average", 3))).toEqual([1.5, 3, 6, 7.5]);
  });

  it("lets an even window reach one sample further back than ahead", () => {
    // window 4 at sample 2: samples 0..3
    expect(Array.from(prepareCurve([0, 3, 6, 9], 8, false, "moving_average", 4))).toEqual([1.5, 3, 4.5, 6]);
  });

  it("changes nothing with a window of one sample or less", () => {
    expect(Array.from(prepareCurve([0, 3, 6, 9], 8, false, "moving_average", 1))).toEqual([0, 3, 6, 9]);
    expect(Array.from(prepareCurve([0, 3, 6, 9], 8, false, "moving_average", 0))).toEqual([0, 3, 6, 9]);
  });

  it("averages values near 2^52 exactly", () => {
    // 2^52 + i: the mean of three neighbours is the middle one, and a plain running sum would have lost it long ago
    const top = 2 ** 52;
    const curve = prepareCurve(Float64Array.from({ length: 100 }, (_, i) => top + i), 53, false, "moving_average", 3);
    for (let i = 1; i < 99; i++) expect(curve[i] - top).toBe(i);
  });
});

describe("buildEnvelope", () => {
  it("has no levels for fewer than 16 samples", () => {
    expect(buildEnvelope(new Float64Array(15))).toEqual({ min: [], max: [] });
  });

  it("holds the extremes of every full block of 8 samples", () => {
    const env = buildEnvelope(Float64Array.from({ length: 20 }, (_, i) => i));
    expect(env.min.map((level) => Array.from(level))).toEqual([[0, 8]]);
    expect(env.max.map((level) => Array.from(level))).toEqual([[7, 15]]);
  });

  it("adds a level for every factor of 8, down to two entries", () => {
    expect(buildEnvelope(new Float64Array(16)).min.map((level) => level.length)).toEqual([2]);
    expect(buildEnvelope(new Float64Array(1000)).min.map((level) => level.length)).toEqual([125, 15]);
    expect(buildEnvelope(new Float64Array(4097)).max.map((level) => level.length)).toEqual([512, 64, 8]);
  });
});

describe("envelopeOf", () => {
  it("builds the envelope of an array once", () => {
    const y = sine(100, 3);
    expect(envelopeOf(y)).toBe(envelopeOf(y));
    expect(envelopeOf(y)).toEqual(buildEnvelope(y));
  });
});

describe("extremes", () => {
  const empty = (): Extremes => ({ min: Infinity, max: -Infinity });

  it.each([15, 16, 1000, 4097])("finds the minimum and maximum of any stretch of %i samples, with and without an envelope", (length) => {
    const random = seeded(length);
    const y = Float64Array.from({ length }, () => Math.round(random() * 2000 - 1000));
    const env = envelopeOf(y);
    const stretches: [number, number][] = [
      [0, length - 1],
      [0, 0],
      [length - 1, length - 1],
    ];
    for (let k = 0; k < 300; k++) {
      const a = Math.floor(random() * length);
      stretches.push([a, a + Math.floor(random() * (length - a))]);
    }
    for (const [a, b] of stretches) {
      const expected = empty();
      for (let i = a; i <= b; i++) {
        expected.min = Math.min(expected.min, y[i]);
        expected.max = Math.max(expected.max, y[i]);
      }
      const fast = empty();
      extremes(y, env, a, b, fast);
      const plain = empty();
      extremes(y, null, a, b, plain);
      expect(fast, `samples ${a}..${b} with the envelope`).toEqual(expected);
      expect(plain, `samples ${a}..${b} without`).toEqual(expected);
    }
  });

  it("only ever widens what it is given", () => {
    const y = sine(1000, 5, 100);
    const wide: Extremes = { min: -5000, max: 5000 };
    extremes(y, envelopeOf(y), 0, 999, wide);
    expect(wide).toEqual({ min: -5000, max: 5000 });
    const narrow: Extremes = { min: -1, max: 1 };
    extremes(y, envelopeOf(y), 0, 999, narrow);
    expect(narrow.min).toBeCloseTo(-100, 9);
    expect(narrow.max).toBeCloseTo(100, 9);
  });
});

describe("rangeStats", () => {
  it("measures the samples of an inclusive range", () => {
    // 1, 2, 3, 4: mean of the squares 30 / 4, variance (2.25 + 0.25 + 0.25 + 2.25) / 4
    expect(rangeStats([1, 2, 3, 4], 0, 3)).toEqual({ n: 4, min: 1, max: 4, mean: 2.5, rms: Math.sqrt(7.5), std: Math.sqrt(1.25), peakToPeak: 3 });
  });

  it("clamps the range to the data", () => {
    expect(rangeStats([1, 2, 3, 4], -5, 100)).toEqual(rangeStats([1, 2, 3, 4], 0, 3));
  });

  it("takes the samples that lie inside fractional bounds", () => {
    expect(rangeStats([1, 2, 3, 4], 0.2, 2.9)).toMatchObject({ n: 2, min: 2, max: 3, mean: 2.5 });
  });

  it("is null for an empty range", () => {
    expect(rangeStats([1, 2, 3, 4], 3, 2)).toBeNull();
    expect(rangeStats([1, 2, 3, 4], 4, 9)).toBeNull();
    expect(rangeStats([], 0, 3)).toBeNull();
  });

  it("keeps the spread of a large value that barely moves", () => {
    const top = 2 ** 40;
    expect(rangeStats([top, top + 1], 0, 1)).toMatchObject({ mean: top + 0.5, std: 0.5, peakToPeak: 1 });
  });
});

describe("edgeStats", () => {
  const square = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0];

  it("counts the edges of a logic signal and puts them between the samples", () => {
    expect(edgeStats(square, 0, 9)).toEqual({ rising: 2, falling: 2, duty: 0.4, periodSamples: 4, risingAt: [1.5, 5.5] });
  });

  it("looks at the given range only", () => {
    expect(edgeStats(square, 4, 9)).toMatchObject({ rising: 1, falling: 1, duty: 2 / 6, periodSamples: null, risingAt: [5.5] });
  });

  it("wants the signal to cross the whole band around the level", () => {
    // Level 5, band 4..6: the first 6 does not leave the band, only the 10 does. The edge is put where the signal
    // last passed 5 on its way up: between sample 3 (a 4) and sample 4 (a 6).
    expect(edgeStats([0, 4, 6, 4, 6, 10], 0, 5)).toMatchObject({ rising: 1, falling: 0, risingAt: [3.5], periodSamples: null });
  });

  it("has no band around a given threshold", () => {
    expect(edgeStats([0, 4, 6, 4, 6, 10], 0, 5, 5)).toMatchObject({ rising: 2, falling: 1, risingAt: [1.5, 3.5], periodSamples: 2 });
  });

  it("counts a sample at the threshold itself as low", () => {
    expect(edgeStats([0, 10, 5, 10], 0, 3, 5)).toMatchObject({ rising: 2, falling: 1, risingAt: [0.5, 2] });
  });

  it("takes the extremes it is given instead of measuring them", () => {
    // told that the signal reaches 0..40, the level is 20 and nothing here crosses it
    expect(edgeStats(square, 0, 9, undefined, { min: 0, max: 40 })).toMatchObject({ rising: 0, falling: 0, duty: 0 });
  });

  it("finds no edge in a constant", () => {
    expect(edgeStats([3, 3, 3, 3], 0, 3)).toEqual({ rising: 0, falling: 0, duty: 0, periodSamples: null, risingAt: [] });
  });

  it("is null for an empty range", () => {
    expect(edgeStats(square, 20, 30)).toBeNull();
  });
});

describe("fftInPlace", () => {
  const transform = (values: ArrayLike<number>) => {
    const re = Float64Array.from(values);
    const im = new Float64Array(re.length);
    fftInPlace(re, im);
    return { re, im };
  };

  it("turns an impulse into all ones", () => {
    const { re, im } = transform([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(re)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(Array.from(im)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("puts a constant into point 0", () => {
    const { re, im } = transform([1, 1, 1, 1]);
    expect(Array.from(re)).toEqual([4, 0, 0, 0]);
    expect(Array.from(im)).toEqual([0, 0, 0, 0]);
  });

  it("puts a cosine of k periods into the points k and N - k, half its length high", () => {
    const N = 16;
    const k = 3;
    const { re, im } = transform(Array.from({ length: N }, (_, n) => Math.cos((2 * Math.PI * k * n) / N)));
    for (let p = 0; p < N; p++) {
      expect(re[p]).toBeCloseTo(p === k || p === N - k ? N / 2 : 0, 12);
      expect(im[p]).toBeCloseTo(0, 12);
    }
  });

  it("keeps the energy (Parseval)", () => {
    const random = seeded(1);
    const x = Float64Array.from({ length: 64 }, () => random() * 2 - 1);
    const { re, im } = transform(x);
    const energy = x.reduce((sum, v) => sum + v * v, 0);
    const transformed = re.reduce((sum, v, p) => sum + v * v + im[p] * im[p], 0) / x.length;
    expect(transformed).toBeCloseTo(energy, 10);
  });
});

describe("spectrum", () => {
  it("shows a sine of amplitude A at about 20 log10(A) dB", () => {
    const sp = spectrum(sine(1024, 64, 100), 0, 1023);
    expect(sp).toMatchObject({ n: 1024, binCyclesPerSample: 1 / 1024 });
    expect(sp?.db).toHaveLength(513);
    expect(spectrumPeak(sp!)).toBe(64);
    expect(sp!.db[64]).toBeCloseTo(40, 1);
  });

  it("does not count a tone at fs/2 twice", () => {
    // +A, -A, +A ... is its own mirror image: 20 log10(50) = 33.98 dB, not 6 dB more
    const sp = spectrum(Float64Array.from({ length: 1024 }, (_, i) => (i % 2 ? -50 : 50)), 0, 1023);
    expect(sp!.db[512]).toBeCloseTo(20 * Math.log10(50), 6);
  });

  it("is null for fewer than 8 samples", () => {
    expect(spectrum(new Float64Array(7), 0, 6)).toBeNull();
    expect(spectrum(sine(100, 5), 10, 16)).toBeNull();
    expect(spectrum(sine(100, 5), 10, 17)).not.toBeNull();
  });

  it("pads to the next power of two, or to the points asked for", () => {
    expect(spectrum(sine(100, 5), 0, 99)).toMatchObject({ n: 100, binCyclesPerSample: 1 / 128 });
    const padded = spectrum(sine(100, 5), 0, 99, 256);
    expect(padded).toMatchObject({ n: 100, binCyclesPerSample: 1 / 256 });
    expect(padded?.db).toHaveLength(129);
  });

  it("takes the first MAX_FFT samples of a longer stretch", () => {
    const sp = spectrum(sine(MAX_FFT + 5000, 1000), 0, MAX_FFT + 4999);
    expect(sp?.n).toBe(MAX_FFT);
    expect(sp?.db).toHaveLength(MAX_FFT / 2 + 1);
  });
});

describe("spectrumPoints", () => {
  it("says how many points spectrum() transforms", () => {
    expect(spectrumPoints(1000, 0, 999)).toBe(1024);
    expect(spectrumPoints(1000, -5, 5000)).toBe(1024);
    expect(spectrumPoints(1000, 0, 7)).toBe(8);
    expect(spectrumPoints(300000, 0, 299999)).toBe(131072);
  });

  it("is 0 for too few samples", () => {
    expect(spectrumPoints(1000, 0, 5)).toBe(0);
  });
});

describe("spectrumPeak", () => {
  // a strong line at point 64 and one a hundred times weaker at point 200
  const twoLines = spectrum(
    Float64Array.from({ length: 1024 }, (_, i) => 100 * Math.sin((2 * Math.PI * 64 * i) / 1024) + Math.sin((2 * Math.PI * 200 * i) / 1024)),
    0,
    1023,
  )!;

  it("finds the strongest point of the whole spectrum", () => {
    expect(spectrumPeak(twoLines)).toBe(64);
  });

  it("finds the strongest point of a band", () => {
    expect(spectrumPeak(twoLines, 150, 250)).toBe(200);
    expect(spectrumPeak(twoLines, 100)).toBe(200);
  });

  it("finds the line of a band that begins on the higher skirt of the strong line", () => {
    // point 65 still belongs to the strong line, 34 dB above the weak one
    expect(twoLines.db[65]).toBeGreaterThan(twoLines.db[200] + 30);
    expect(spectrumPeak(twoLines, 65, 250)).toBe(200);
  });

  it("gives the highest point of a band that holds nothing but the skirt of a line outside it", () => {
    expect(spectrumPeak(twoLines, 70, 80)).toBe(70);
    expect(spectrumPeak(twoLines, 0, 10)).toBe(10);
  });

  it("stays inside the spectrum for a band that is not", () => {
    expect(spectrumPeak(twoLines, 600, 700)).toBe(512);
    expect(spectrumPeak(twoLines, 300, 200)).toBe(300);
  });

  it("puts a tone at fs/2 at the last point of its plateau", () => {
    // 1000 samples are padded to 1024 points: the tone then covers the last points at one height
    const sp = spectrum(Float64Array.from({ length: 1000 }, (_, i) => (i % 2 ? -50 : 50)), 0, 999)!;
    expect(sp.db[511]).toBeCloseTo(sp.db[512], 6);
    expect(spectrumPeak(sp)).toBe(512);
  });
});

describe("fundamentalTone", () => {
  it("reads the frequency between the points of the spectrum", () => {
    // 10.3 periods in 1000 samples
    const tone = fundamentalTone(sine(1000, 10.3, 100), 0, 999);
    expect(tone?.n).toBe(1000);
    expect(tone!.cycles).toBeCloseTo(0.0103, 4);
    expect(Math.abs(tone!.amplitude - 100)).toBeLessThan(1);
  });

  it("is not thrown off by an offset", () => {
    const tone = fundamentalTone(sine(1000, 10.3, 100, 0.7, 5000), 0, 999);
    expect(tone!.cycles).toBeCloseTo(0.0103, 4);
    expect(Math.abs(tone!.amplitude - 100)).toBeLessThan(1);
  });

  it("takes the fundamental of a pulse train, not one of its equally high harmonics", () => {
    const strobe = Float64Array.from({ length: 1000 }, (_, i) => (i % 50 === 0 ? 1 : 0));
    expect(fundamentalTone(strobe, 0, 999)!.cycles).toBeCloseTo(1 / 50, 4);
  });

  it("puts a tone at fs/2 exactly there", () => {
    const tone = fundamentalTone(Float64Array.from({ length: 1024 }, (_, i) => (i % 2 ? -1 : 1)), 0, 1023);
    expect(tone!.cycles).toBe(0.5);
    expect(tone!.amplitude).toBeCloseTo(1, 9);
  });

  it("is null for a stretch that does not move", () => {
    expect(fundamentalTone(new Float64Array(100).fill(7), 0, 99)).toBeNull();
    expect(fundamentalTone(new Float64Array(100).fill(2 ** 40 + 1), 0, 99)).toBeNull();
  });

  it("is null for fewer than 8 samples", () => {
    expect(fundamentalTone(sine(7, 2), 0, 6)).toBeNull();
    expect(fundamentalTone(sine(1000, 10), 100, 106)).toBeNull();
  });
});

describe("repeats", () => {
  const measured = (y: Float64Array) => [fundamentalTone(y, 0, y.length - 1), edgeStats(y, 0, y.length - 1)] as const;
  const tone = (cycles: number, prominence: number): Tone => ({ cycles, amplitude: 1, n: 1001, prominence });

  it("is false without a tone or without a period between edges", () => {
    expect(repeats(null, { rising: 3, periodSamples: 10 })).toBe(false);
    expect(repeats(tone(0.01, 100), null)).toBe(false);
    expect(repeats(tone(0.01, 100), { rising: 1, periodSamples: null })).toBe(false);
  });

  it("is true for a clean sine", () => {
    expect(repeats(...measured(sine(1000, 10, 100)))).toBe(true);
    expect(repeats(...measured(sine(1000, 4, 100)))).toBe(true);
  });

  it("is true for a pulse train and a square wave", () => {
    expect(repeats(...measured(Float64Array.from({ length: 1000 }, (_, i) => (i % 50 === 0 ? 1 : 0))))).toBe(true);
    expect(repeats(...measured(Float64Array.from({ length: 1000 }, (_, i) => Math.floor(i / 25) % 2)))).toBe(true);
  });

  it("is false for a signal that goes round fewer than two and a half times", () => {
    expect(repeats(...measured(sine(1000, 2, 100)))).toBe(false);
  });

  it.each([1, 2, 3, 4, 5])("is false for random words (seed %i)", (seed) => {
    expect(repeats(...measured(words(1000, seed)))).toBe(false);
  });

  // The rules one by one, on tones of 1001 samples: 1000 resolution cells, so `cycles` x 1000 periods.
  it("wants the tone to go round two and a half times, whatever the edges say", () => {
    expect(repeats(tone(0.002, 100), { rising: 5, periodSamples: 200 })).toBe(false);
  });

  it("wants the edges to have two and a half periods in the stretch as well", () => {
    expect(repeats(tone(0.01, 100), { rising: 2, periodSamples: 600 })).toBe(false);
  });

  it("wants a tone of seven periods or more to stand out eight times", () => {
    expect(repeats(tone(0.01, 8.5), { rising: 10, periodSamples: 100 })).toBe(true);
    expect(repeats(tone(0.01, 7.5), { rising: 10, periodSamples: 100 })).toBe(false);
  });

  it("judges a tone of fewer periods by its edges: no more than four per period", () => {
    // 4 periods
    expect(repeats(tone(0.004, 1), { rising: 15, periodSamples: 250 })).toBe(true);
    expect(repeats(tone(0.004, 1), { rising: 17, periodSamples: 250 })).toBe(false);
  });

  it("does not trust a tone that runs into its mirror image just below fs/2", () => {
    expect(repeats(tone(0.499, 100), { rising: 499, periodSamples: 2.004 })).toBe(false);
    expect(repeats(tone(0.5, 100), { rising: 499, periodSamples: 2 })).toBe(true);
  });
});

describe("phaseBetween", () => {
  const n = 1000;
  const reference = sine(n, 10, 100);
  const cycles = 10 / n;

  it("is 0 for the reference itself", () => {
    expect(phaseBetween(reference, reference.slice(), 0, n - 1, cycles)).toMatchObject({ degrees: 0, n });
  });

  it("is negative for a signal that lags", () => {
    // a quarter period later, at half the amplitude
    const found = phaseBetween(reference, sine(n, 10, 50, -Math.PI / 2), 0, n - 1, cycles)!;
    expect(found.degrees).toBeCloseTo(-90, 1);
    expect(found.referenceAmplitude).toBeCloseTo(100, 1);
    expect(found.amplitude).toBeCloseTo(50, 1);
  });

  it("is positive for a signal that leads", () => {
    expect(phaseBetween(reference, sine(n, 10, 100, Math.PI / 4), 0, n - 1, cycles)!.degrees).toBeCloseTo(45, 1);
  });

  it("is 180, never -180, for an inverted signal", () => {
    expect(phaseBetween(reference, reference.map((v) => -v), 0, n - 1, cycles)!.degrees).toBe(180);
    // half a period apart, the rounding decides to which side of 180 degrees the two fall: both ways round
    const inverted = sine(n, 10, 100, 3 * Math.PI);
    for (const degrees of [phaseBetween(reference, inverted, 0, n - 1, cycles)!.degrees, phaseBetween(inverted, reference, 0, n - 1, cycles)!.degrees]) {
      expect(Math.abs(degrees)).toBeCloseTo(180, 3);
      expect(degrees).toBeGreaterThan(-180);
    }
  });

  it("reads two opposed signals as 180 whichever of them is the reference", () => {
    // At frequency 0 nothing is rounded: a bump and a dip in the middle of the stretch are opposed exactly, and
    // one of the two ways round the angle comes out as -180 before it is put into the range.
    const bump = Float64Array.from({ length: 100 }, (_, i) => (i >= 40 && i < 60 ? 1 : 0));
    const dip = bump.map((v) => 1 - v);
    expect(phaseBetween(bump, dip, 0, 99, 0)!.degrees).toBe(180);
    expect(phaseBetween(dip, bump, 0, 99, 0)!.degrees).toBe(180);
  });

  it("uses the samples both have", () => {
    expect(phaseBetween(reference, reference.slice(0, 500), 0, n - 1, cycles)).toMatchObject({ degrees: 0, n: 500 });
  });

  it("is null for too few samples and for a signal without that frequency", () => {
    expect(phaseBetween(reference.slice(0, 7), reference, 0, n - 1, cycles)).toBeNull();
    expect(phaseBetween(reference, new Float64Array(n).fill(3), 0, n - 1, cycles)).toBeNull();
  });
});

describe("phaseAgainst", () => {
  const n = 1000;
  const reference = sine(n, 10, 100);
  const referenceTone = fundamentalTone(reference, 0, n - 1)!;
  const against = (y: Float64Array) => phaseAgainst(reference, y, 0, n - 1, referenceTone, fundamentalTone(y, 0, n - 1)!);

  it("gives the phase of the signal's own tone when that is the reference's", () => {
    const found = against(sine(n, 10, 50, -Math.PI / 2))!;
    expect(found.own).toBe(true);
    expect(found.degrees).toBeCloseTo(-90, 1);
  });

  it("gives the phase of a line the signal holds beside its own tone", () => {
    // its tone has 23 periods; beside it, a fifth as strong, the reference's 10, a quarter period late
    const both = Float64Array.from({ length: n }, (_, i) => 100 * Math.sin((2 * Math.PI * 23 * i) / n) + 20 * Math.sin((2 * Math.PI * 10 * i) / n - Math.PI / 2));
    const found = against(both)!;
    expect(found.own).toBe(false);
    expect(found.degrees).toBeCloseTo(-90, 1);
    expect(found.amplitude).toBeCloseTo(20, 1);
  });

  it("is null for a line of less than 3 % of the signal's own tone", () => {
    const both = Float64Array.from({ length: n }, (_, i) => 100 * Math.sin((2 * Math.PI * 23 * i) / n) + Math.sin((2 * Math.PI * 10 * i) / n));
    expect(standsOut(both, 0, n - 1, referenceTone.cycles)).toBeGreaterThan(4); // it is a line, only a weak one
    expect(against(both)).toBeNull();
  });

  it("is null for a signal that does not hold the reference's frequency", () => {
    expect(against(sine(n, 23, 100))).toBeNull();
    const random = seeded(7);
    expect(against(Float64Array.from({ length: n }, () => random() * 200 - 100))).toBeNull();
  });
});

describe("standsOut", () => {
  const y = sine(1000, 10, 100);

  it("is large at the frequency of a line and about 1 beside it", () => {
    expect(standsOut(y, 0, 999, 0.01)).toBeGreaterThan(50);
    expect(standsOut(y, 0, 999, 0.023)).toBeLessThan(2);
  });

  it("is 0 for fewer than 8 samples", () => {
    expect(standsOut(y, 0, 4, 0.01)).toBe(0);
  });
});

describe("edgeDelays", () => {
  it("measures a steady delay", () => {
    expect(edgeDelays([10, 20, 30], [12, 22, 32])).toEqual({ count: 3, mean: 2, min: 2, max: 2, kind: "steady" });
  });

  it("is negative when the signal's edges come first", () => {
    expect(edgeDelays([10, 20, 30], [8, 18, 28])).toEqual({ count: 3, mean: -2, min: -2, max: -2, kind: "steady" });
  });

  it("calls edges midway between those of the reference opposite", () => {
    expect(edgeDelays([10, 20, 30], [15, 25, 35])).toEqual({ count: 3, mean: 5, min: 5, max: 5, kind: "opposite" });
  });

  it("counts edges that fall now before, now after the middle all as after", () => {
    // 4.75 before the edge at 10 and 4.75 after the one at 20: counted as 5.25 and 4.75 after
    expect(edgeDelays([10, 20, 30], [5.25, 24.75])).toEqual({ count: 2, mean: 5, min: 4.75, max: 5.25, kind: "opposite" });
  });

  it("calls delays that lie all over the distance between two edges scattered", () => {
    // the edge at 20 has none of the signal near it; the others are 1, 3 and 9 samples late
    expect(edgeDelays([10, 20, 30, 40], [11, 27, 33, 49])).toMatchObject({ count: 3, min: 1, max: 9, kind: "scattered" });
  });

  it("is null when no edge of the reference has one of the signal", () => {
    expect(edgeDelays([10, 20, 30], [])).toBeNull();
    expect(edgeDelays([], [12, 22])).toBeNull();
  });

  it("leaves out a pair whose partner may lie outside the stretch", () => {
    // the stretch ends at 31: the edge at 32 is nearer to that end than to the edge at 30 it would go with
    expect(edgeDelays([10, 20, 30], [12, 22, 32], 0, 31)).toMatchObject({ count: 2, mean: 2 });
  });

  it("keeps such a pair when it is the only one", () => {
    expect(edgeDelays([10], [25], 0, 30)).toEqual({ count: 1, mean: 15, min: 15, max: 15, kind: "steady" });
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
    expect(niceTicks(0.13, 0.87, 4).map((t) => t.toFixed(1))).toEqual(["0.2", "0.4", "0.6", "0.8"]);
  });

  it("writes zero as a positive zero", () => {
    expect(Object.is(niceTicks(0, 10, 5)[0], 0)).toBe(true);
    expect(Object.is(niceTicks(-4, 4, 4)[2], 0)).toBe(true);
  });

  it("has none for a range that is empty, reversed or not finite", () => {
    expect(niceTicks(5, 5, 5)).toEqual([]);
    expect(niceTicks(10, 0, 5)).toEqual([]);
    expect(niceTicks(0, Infinity, 5)).toEqual([]);
    expect(niceTicks(NaN, 1, 5)).toEqual([]);
  });

  it("has none for a range narrower than doubles can tell apart", () => {
    // at 2^51 doubles lie 0.5 apart: steps of 0.2 cannot be told from one another
    expect(niceTicks(2 ** 51, 2 ** 51 + 1, 5)).toEqual([]);
  });
});

describe("tickLabels", () => {
  it("gives all labels the decimals the step needs", () => {
    expect(tickLabels([0, 0.2, 0.4])).toEqual(["0.0", "0.2", "0.4"]);
    expect(tickLabels([0, 50, 100])).toEqual(["0", "50", "100"]);
  });

  it("writes no -0", () => {
    expect(tickLabels([-1e-9, 0.5, 1])).toEqual(["0.0", "0.5", "1.0"]);
  });

  it("switches to exponents where they are shorter than the room allows", () => {
    expect(tickLabels([1000000, 2000000, 3000000], 5)).toEqual(["1e+6", "2e+6", "3e+6"]);
    expect(tickLabels([1000000, 2000000, 3000000])).toEqual(["1000000", "2000000", "3000000"]);
  });

  it("labels a single tick without a step", () => {
    expect(tickLabels([5])).toEqual(["5"]);
    expect(tickLabels([0.1 + 0.2])).toEqual(["0.3"]);
    expect(tickLabels([])).toEqual([]);
  });
});

describe("siTickLabels", () => {
  it("takes one unit prefix for the axis from its largest value", () => {
    expect(siTickLabels([0, 0.001, 0.002], "s")).toEqual(["0 ms", "1 ms", "2 ms"]);
    expect(siTickLabels([0, 5e6, 1e7], "Hz")).toEqual(["0 MHz", "5 MHz", "10 MHz"]);
  });

  it("keeps the decimals that tell two ticks apart", () => {
    expect(siTickLabels([0.0024755, 0.002476], "s")).toEqual(["2.4755 ms", "2.4760 ms"]);
  });

  it("writes plain zeros for an axis of zeros", () => {
    expect(siTickLabels([0, 0], "s")).toEqual(["0 s", "0 s"]);
  });
});

describe("formatSI", () => {
  it.each([
    [0.0000125, "s", "12.5 µs"], // the micro sign
    [-0.002, "s", "-2 ms"],
    [4e7, "Hz", "40 MHz"],
    [1234.5678, "Hz", "1.235 kHz"],
    [0, "Hz", "0 Hz"],
    [NaN, "s", "-"],
    [Infinity, "s", "-"],
  ])("%s %s -> %s", (value, unit, text) => {
    expect(formatSI(value, unit)).toBe(text);
  });

  it("moves on to the next prefix when rounding carries over", () => {
    // 999.99 k to four digits is 1000 k
    expect(formatSI(999990, "Hz", 4)).toBe("1 MHz");
  });

  it("shows as many significant digits as asked for", () => {
    expect(formatSI(1234.5678, "Hz", 6)).toBe("1.23457 kHz");
  });

  it("stays with the smallest and the largest prefix beyond them", () => {
    expect(formatSI(1e-15, "s")).toBe("0.001 ps");
    expect(formatSI(2.5e12, "Hz")).toBe("2500 GHz");
  });
});

describe("formatSIStep", () => {
  it("shows the decimals that tell two neighbouring points apart", () => {
    // a sample every 25 ns: 0.000025 ms, six decimals
    expect(formatSIStep(2.475525e-3, 25e-9, "s")).toBe("2.475525 ms");
    expect(formatSIStep(5e-8, 25e-9, "s")).toBe("50 ns");
    expect(formatSIStep(1.5, 0.5, "s")).toBe("1.5 s");
  });

  it("moves on to the next prefix when rounding carries over", () => {
    expect(formatSIStep(999.9996e-6, 1e-9, "s")).toBe("1.000000 ms");
  });

  it("falls back to six digits without a step", () => {
    expect(formatSIStep(2.475525e-3, 0, "s")).toBe("2.47553 ms");
  });

  it("writes zero and what is no number plainly", () => {
    expect(formatSIStep(0, 25e-9, "s")).toBe("0 s");
    expect(formatSIStep(NaN, 25e-9, "s")).toBe("-");
  });
});

describe("trimNumber", () => {
  it.each([
    [0, "0"],
    [42, "42"],
    [1234567890123456, "1234567890123456"],
    [1234.5678, "1235"],
    [123.456, "123.5"],
    [12.3456, "12.35"],
    [-3.14159, "-3.142"],
    [0.5, "0.5"],
    [100.04, "100"],
    [1e-5, "1e-5"],
    [1.5e16, "1.5e+16"],
    [NaN, "-"],
  ])("%s -> %s", (value, text) => {
    expect(trimNumber(value)).toBe(text);
  });
});

describe("formatValue", () => {
  it("shows captured values exactly and means of large values to a thousandth", () => {
    expect(formatValue(16354)).toBe("16354");
    expect(formatValue(1234.5678)).toBe("1234.568");
    expect(formatValue(-2048.25)).toBe("-2048.25");
  });

  it("trims small values to about four digits", () => {
    expect(formatValue(12.3456)).toBe("12.35");
    expect(formatValue(0.5)).toBe("0.5");
  });

  it("writes a dash for what is no number", () => {
    expect(formatValue(NaN)).toBe("-");
  });
});

describe("formatOnAxis", () => {
  it("shows the decimals a thousandth of the axis needs", () => {
    expect(formatOnAxis(12.3456, 1)).toBe("12.346");
    expect(formatOnAxis(12.3456, 1000)).toBe("12");
    expect(formatOnAxis(0.5, 0.001)).toBe("0.5");
  });

  it("writes no -0", () => {
    expect(formatOnAxis(-0.0001, 1)).toBe("0");
  });

  it("falls back to formatValue without a span", () => {
    expect(formatOnAxis(12.3456, 0)).toBe("12.35");
    expect(formatOnAxis(NaN, 1)).toBe("-");
  });
});

describe("decimalsOf", () => {
  it("counts the decimals a number needs, not those of its rounding error", () => {
    expect(decimalsOf(0.1 + 0.2)).toBe(1);
    expect(decimalsOf(25)).toBe(0);
    expect(decimalsOf(0.025)).toBe(3);
  });

  it("stops at 12", () => {
    expect(decimalsOf(1 / 3)).toBe(12);
  });
});

describe("toDecimals", () => {
  it("writes exactly so many decimals", () => {
    expect(toDecimals(1.005, 1)).toBe("1.0");
    expect(toDecimals(2.5, -1)).toBe("3");
    expect(toDecimals(3.14159, 20)).toBe("3.141590000000");
  });

  it("writes no -0", () => {
    expect(toDecimals(-0.0001, 2)).toBe("0.00");
  });

  it("writes a dash for what is no number", () => {
    expect(toDecimals(NaN, 2)).toBe("-");
  });
});
