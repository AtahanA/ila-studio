// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { IlaProbe, TriggerRule } from "./types";

/** A probe's hierarchical name without a bus range: what the hardware calls it, and what both the probe file
 *  ("path/name[13:0]") and the hardware query ("path/name") agree on. */
export function probeKey(probe: Pick<IlaProbe, "fullName">): string {
  return probe.fullName.replace(/\[\d+:\d+\]$/, "");
}

/**
 * The compare value of a rule the way Vivado takes it. Hex and binary values must spell out every digit of the
 * probe width - "eq14'h0" is refused, "eq14'h0000" is fine - so short values are left-padded with zeros.
 * Decimal is sent as 'u (unsigned): Vivado 2017.4 does not know 'd. Throws with a sentence for the status bar
 * when the value cannot be right.
 */
export function compareValue(rule: TriggerRule): string {
  if (!rule.isBus) return `eq1'b${rule.op1Bit || "R"}`;
  const radix = rule.opMultiBit === "dec" ? "u" : rule.opMultiBit === "bin" ? "b" : "h";
  const kind = radix === "h" ? "hex" : radix === "b" ? "binary" : "decimal";
  const value = (rule.value || "0").trim().replace(/^0x/i, "").replace(/[\s_]+/g, "") || "0";
  const allowed = radix === "h" ? /^[0-9a-fx]+$/i : radix === "b" ? /^[01x]+$/i : /^[0-9]+$/;
  if (!allowed.test(value)) throw new Error(`"${rule.value}" is not a ${kind} value.`);
  const digits = radix === "h" ? Math.ceil(rule.width / 4) : radix === "b" ? rule.width : 0;
  if (digits > 0 && value.length > digits) {
    throw new Error(`The value has more digits than the ${rule.width}-bit probe holds (${digits} ${kind} digits at most).`);
  }
  // The right number of digits is not yet the right number of bits: the first hex digit of a 14-bit probe holds
  // two bits (0xFFFF has four digits and needs sixteen), and a decimal value has no digits to count at all.
  const topBits = rule.width % 4 || 4;
  const top = value.length === digits ? value[0] : "0";
  const tooWide =
    radix === "h"
      ? !/x/i.test(top) && parseInt(top, 16) >= 2 ** topBits
      : radix === "u" && BigInt(value) >= BigInt(2) ** BigInt(rule.width);
  if (tooWide) throw new Error(`The value does not fit into the ${rule.width}-bit probe.`);
  return `eq${rule.width}'${radix}${digits > 0 ? value.padStart(digits, "0") : value}`;
}

/** "<probe> <compare-value>" for the Tcl side; `target` is the name the probe is looked up by. */
export function ruleTrigger(rule: TriggerRule, target: string): string {
  return `${target} ${compareValue(rule)}`;
}
