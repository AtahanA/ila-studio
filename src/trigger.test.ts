// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { compareValue, probeKey, ruleTrigger } from "./trigger";
import type { TriggerRule } from "./types";

const bit = (more: Partial<TriggerRule> = {}): TriggerRule => ({ probeName: "rx_valid", isBus: false, width: 1, ...more });
const bus = (more: Partial<TriggerRule> = {}): TriggerRule => ({ probeName: "adc_data", isBus: true, width: 14, ...more });

describe("probeKey", () => {
  it("drops the bus range at the end of the name", () => {
    expect(probeKey({ fullName: "u_top/adc_data[13:0]" })).toBe("u_top/adc_data");
  });

  it("leaves a name without a range as it is", () => {
    expect(probeKey({ fullName: "a/b" })).toBe("a/b");
  });

  it("keeps a single index: that is one bit of a bus, a probe of its own", () => {
    expect(probeKey({ fullName: "mem[3]" })).toBe("mem[3]");
  });

  it("only looks at the end of the name", () => {
    expect(probeKey({ fullName: "gen[3:0]/status" })).toBe("gen[3:0]/status");
  });
});

describe("compareValue", () => {
  it("compares a 1-bit probe with a rising edge unless the rule says otherwise", () => {
    expect(compareValue(bit())).toBe("eq1'bR");
    expect(compareValue(bit({ op1Bit: "F" }))).toBe("eq1'bF");
    expect(compareValue(bit({ op1Bit: "1" }))).toBe("eq1'b1");
  });

  it("ignores the value and the radix of a 1-bit rule", () => {
    expect(compareValue(bit({ opMultiBit: "dec", value: "junk" }))).toBe("eq1'bR");
  });

  it("pads a hex value to every digit of the probe width", () => {
    // 14 bits are four hex digits
    expect(compareValue(bus({ opMultiBit: "hex", value: "0" }))).toBe("eq14'h0000");
    expect(compareValue(bus({ opMultiBit: "hex", value: "0x3F" }))).toBe("eq14'h003F");
    expect(compareValue(bus({ opMultiBit: "hex", value: "0X3f" }))).toBe("eq14'h003f");
    expect(compareValue(bus({ width: 16, opMultiBit: "hex", value: "abcd" }))).toBe("eq16'habcd");
    expect(compareValue(bus({ width: 17, opMultiBit: "hex", value: "1" }))).toBe("eq17'h00001");
  });

  it("drops blanks and underscores and keeps the case of the digits", () => {
    expect(compareValue(bus({ opMultiBit: "hex", value: " 3_F f " }))).toBe("eq14'h03Ff");
  });

  it("takes hex when the rule names no radix", () => {
    expect(compareValue(bus({ value: "2a" }))).toBe("eq14'h002a");
    expect(compareValue(bus({ opMultiBit: "custom", value: "2a" }))).toBe("eq14'h002a");
  });

  it("reads an empty value as zero", () => {
    expect(compareValue(bus({ opMultiBit: "hex", value: "" }))).toBe("eq14'h0000");
    expect(compareValue(bus({ opMultiBit: "hex" }))).toBe("eq14'h0000");
    expect(compareValue(bus({ opMultiBit: "hex", value: "0x" }))).toBe("eq14'h0000");
    expect(compareValue(bus({ opMultiBit: "hex", value: "   " }))).toBe("eq14'h0000");
  });

  it("lets x stand for digits that do not matter", () => {
    expect(compareValue(bus({ opMultiBit: "hex", value: "1x" }))).toBe("eq14'h001x");
    expect(compareValue(bus({ width: 4, opMultiBit: "bin", value: "1x0" }))).toBe("eq4'b01x0");
  });

  it("refuses a hex value with more digits than the probe has", () => {
    expect(() => compareValue(bus({ opMultiBit: "hex", value: "12345" }))).toThrow(/4 hex digits at most/);
  });

  it("refuses what is no hex value", () => {
    expect(() => compareValue(bus({ opMultiBit: "hex", value: "12g" }))).toThrow('"12g" is not a hex value.');
  });

  it("pads a binary value to the probe width and refuses a longer one", () => {
    expect(compareValue(bus({ width: 4, opMultiBit: "bin", value: "101" }))).toBe("eq4'b0101");
    expect(() => compareValue(bus({ width: 4, opMultiBit: "bin", value: "10101" }))).toThrow(/4 binary digits at most/);
    expect(() => compareValue(bus({ width: 4, opMultiBit: "bin", value: "102" }))).toThrow(/not a binary value/);
  });

  it("sends a decimal value unsigned and unpadded", () => {
    expect(compareValue(bus({ opMultiBit: "dec", value: "100" }))).toBe("eq14'u100");
    expect(compareValue(bus({ opMultiBit: "dec", value: "007" }))).toBe("eq14'u007");
  });

  it("refuses what is no decimal value", () => {
    expect(() => compareValue(bus({ opMultiBit: "dec", value: "-1" }))).toThrow(/not a decimal value/);
    expect(() => compareValue(bus({ opMultiBit: "dec", value: "1x" }))).toThrow(/not a decimal value/);
    expect(() => compareValue(bus({ opMultiBit: "dec", value: "1.5" }))).toThrow(/not a decimal value/);
  });

  // The digits alone do not decide: 0xFFFF has the four digits of a 14-bit probe but needs 16 bits.
  it("refuses a hex value that does not fit into the probe width", () => {
    expect(() => compareValue(bus({ opMultiBit: "hex", value: "FFFF" }))).toThrow(/does not fit into the 14-bit probe/);
    expect(() => compareValue(bus({ opMultiBit: "hex", value: "4000" }))).toThrow(/does not fit/);
    expect(compareValue(bus({ opMultiBit: "hex", value: "3FFF" }))).toBe("eq14'h3FFF");
    // a first digit that does not matter cannot be too large, and a full-width probe takes every digit
    expect(compareValue(bus({ opMultiBit: "hex", value: "xFFF" }))).toBe("eq14'hxFFF");
    expect(compareValue(bus({ width: 16, opMultiBit: "hex", value: "FFFF" }))).toBe("eq16'hFFFF");
  });

  // A decimal value has no digit count to check: it is compared with the width itself (16383 at most here).
  it("refuses a decimal value that does not fit into the probe width", () => {
    expect(() => compareValue(bus({ opMultiBit: "dec", value: "99999" }))).toThrow(/does not fit into the 14-bit probe/);
    expect(() => compareValue(bus({ opMultiBit: "dec", value: "16384" }))).toThrow(/does not fit/);
    expect(compareValue(bus({ opMultiBit: "dec", value: "16383" }))).toBe("eq14'u16383");
    // wider than a JavaScript number is exact for
    expect(compareValue(bus({ width: 64, opMultiBit: "dec", value: "18446744073709551615" }))).toBe("eq64'u18446744073709551615");
    expect(() => compareValue(bus({ width: 64, opMultiBit: "dec", value: "18446744073709551616" }))).toThrow(/does not fit/);
  });
});

describe("ruleTrigger", () => {
  it("puts the name the probe is looked up by before the compare value", () => {
    expect(ruleTrigger(bit(), "u_top/valid")).toBe("u_top/valid eq1'bR");
    expect(ruleTrigger(bus({ opMultiBit: "hex", value: "3fe2" }), "u_top/adc_data")).toBe("u_top/adc_data eq14'h3fe2");
  });

  it("passes on the refusal of a value", () => {
    expect(() => ruleTrigger(bus({ opMultiBit: "dec", value: "abc" }), "u_top/adc_data")).toThrow(/not a decimal value/);
  });
});
