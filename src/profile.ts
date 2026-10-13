// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

// A configuration of the capture page as a profile file, and back. Pure functions: no DOM, no React.
import { CaptureConfig, CaptureMode, ProbeFormat, TriggerRule } from "./types";

/**
 * What a profile saved from the page holds beyond what the capture tools read (its section "gui"): the page as
 * it was. The tools take `capture.trigger`, a plain expression; the page wants the rule it was built from back,
 * the mode, and what a profile written by hand never said.
 */
export interface ProfileGui {
  mode: CaptureMode;
  rule: TriggerRule | null;
  customTrigger: string;
  /** null: the section does not name one (an empty name is a name: captures are then called after their time) */
  captureName: string | null;
  twinTurbo: boolean;
  /** the selected ILA core, by the name the probe file gives it ("" when it was not known) */
  core: string;
}

/** The page, as far as a profile holds it. */
export interface PageState {
  serverUrl: string;
  ltxPath: string;
  tclPath: string;
  deviceFilter: string;
  /** TCK in Hz; 0 = automatic */
  jtagHz: number;
  coreIndex: number;
  coreName: string;
  capture: CaptureConfig;
  /** what a capture would be started with now: "now" or "<probe> <compare-value>" */
  trigger: string;
  twinTurbo: boolean;
  /** the formats of the buses of the probe file; null while nothing is known of them for the file in the field */
  probeFormats: Record<string, ProbeFormat> | null;
}

const MODES: CaptureMode[] = ["just_capture", "trigger_rule", "constant_capture"];
const FORMATS = ["both", "csv", "ila"] as const;
/** how the note of a profile that was never described by hand begins: "Saved from <the program> on " */
const SAVED_FROM = "Saved from ";
const SAVED_NOTE = `${SAVED_FROM}ILA Studio on `;
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The note of the page itself, in its whole form: SAVED_NOTE, the date and - in (1) - where the profile came from.
 * The builds before the first public one had "Vivado " in front of the program's name: a note that begins so is
 * the page's own as well, or a profile saved by them would never get the date of a new save.
 */
const OWN_NOTE = new RegExp(
  `^${literal(SAVED_FROM)}(?:Vivado )?${literal(SAVED_NOTE.slice(SAVED_FROM.length))}\\S+?(, starting from the profile ".*")?\\.$`,
);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const section = (base: Json | undefined, key: string): Json => (base && isObject(base[key]) ? { ...(base[key] as Json) } : {});
const path = (p: string) => p.trim().replace(/\\/g, "/").toLowerCase();
/** one probe file, however its path was written */
export const sameFile = (a: unknown, b: string) => typeof a === "string" && path(a) === path(b);
/** ... and a file of the same name in whatever folder: the probe file of a design that was moved, or built again */
export const sameFileName = (a: unknown, b: string) => typeof a === "string" && a.trim() !== "" && path(a).split("/").pop() === path(b).split("/").pop();

/**
 * The profile a page is saved as. `base` is the profile the page was started from, if any: what it holds beyond
 * the page (the paths of the tools, the folder of the captures, the sections of the other commands of the
 * capture script) goes along, so that the page behaves after the save as it did before, and the profile still
 * serves those commands. `today` is the date of the save.
 */
export function profileOf(name: string, base: Json | undefined, page: PageState, today: string): Json {
  const tools = section(base, "tools");
  if (page.tclPath.trim()) tools.tcl_script = page.tclPath.trim();
  else delete tools.tcl_script;

  const hardware: Json = {
    ...section(base, "hardware"),
    url: page.serverUrl.trim(),
    ltx: page.ltxPath.trim(),
    device_filter: page.deviceFilter.trim() || "*",
    ila_index: Math.max(0, Math.round(page.coreIndex) || 0),
    jtag_frequency_hz: Math.max(0, Math.round(page.jtagHz) || 0),
  };
  // the core is named in the section of the page: a cell name here would outlive the probe file it belongs to
  delete hardware.ila_cell;

  const before = section(base, "capture");
  const capture: Json = {
    ...before,
    trigger: page.trigger.trim() || "now",
    position: Math.max(0, Math.round(page.capture.position) || 0),
    timeout_min: page.capture.timeoutMin > 0 ? page.capture.timeoutMin : 1,
    format: page.capture.format,
    sample_period_ns: page.capture.samplePeriodNs > 0 ? page.capture.samplePeriodNs : 0,
  };
  if (page.probeFormats) {
    // The list of the page is the whole statement, as it is for a capture started from the page: a bus it does
    // not name is unsigned, whatever radix a profile written for the script gave all of them.
    capture.probe_format = page.probeFormats;
    capture.radix = "UNSIGNED";
  } else if (!sameFile(section(base, "hardware").ltx, page.ltxPath)) {
    // nothing known for this probe file, and those of the base are another file's: none are named (an empty
    // list would say "all unsigned", which nobody chose)
    delete capture.probe_format;
  }

  const gui = {
    mode: page.capture.mode,
    rule: page.capture.activeRule,
    custom_trigger: page.capture.customTriggerStr.trim(),
    capture_name: page.capture.captureName.trim(),
    twin_turbo: page.twinTurbo,
    core: page.coreName,
    saved: today,
  };

  const was = typeof base?.name === "string" ? base.name : "";
  const sameName = was !== "" && was.trim().toLowerCase() === name.trim().toLowerCase();
  const written = typeof base?._comment === "string" ? base._comment : "";
  // The note of the page itself, in its whole form: only that is written anew, with the date of this save and
  // where the profile came from. A note a person wrote - or wrote on - stays as it is.
  const own = OWN_NOTE.exec(written);
  const note = !sameName
    ? `${SAVED_NOTE}${today}${was !== "" ? `, starting from the profile "${was}"` : ""}.`
    : own
      ? `${SAVED_NOTE}${today}${own[1] ?? ""}.`
      : written !== ""
        ? written // what a person wrote about the profile stays; the date of the save is in the page's section
        : `${SAVED_NOTE}${today}.`;

  const rest = Object.fromEntries(
    Object.entries(base ?? {}).filter(([key]) => !["name", "_comment", "tools", "hardware", "capture", "gui"].includes(key)),
  );
  return { name: name.trim(), _comment: note, tools, hardware, capture, ...rest, gui };
}

/**
 * What a profile holds beyond the page, in words for the one who saves on top of it: null when there is nothing.
 */
export function beyondThePage(base: unknown): string | null {
  if (!isObject(base)) return null;
  const parts: string[] = [];
  if (Object.keys(section(base, "tools")).some((key) => key !== "tcl_script")) parts.push("the paths of the tools");
  // (the folder "captures" next to the program is where captures go anyway)
  const out = section(base, "capture").out;
  if (typeof out === "string" && out.trim() !== "" && out.trim().toLowerCase() !== "captures") parts.push(`the folder of the captures (${out.trim()})`);
  const others = Object.keys(base).filter((key) => !key.startsWith("_") && !["name", "tools", "hardware", "capture", "gui"].includes(key));
  if (others.length > 0) parts.push(`the section${others.length > 1 ? "s" : ""} ${others.join(", ")} of the capture script`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function ruleOf(v: unknown): TriggerRule | null {
  if (!isObject(v) || typeof v.probeName !== "string" || v.probeName === "") return null;
  const width = Math.round(Number(v.width));
  if (!(width >= 1)) return null;
  const isBus = v.isBus === true;
  const rule: TriggerRule = { probeName: v.probeName, isBus, width };
  if (typeof v.probeFullName === "string" && v.probeFullName !== "") rule.probeFullName = v.probeFullName;
  if (isBus) {
    rule.opMultiBit = v.opMultiBit === "dec" || v.opMultiBit === "bin" || v.opMultiBit === "custom" ? v.opMultiBit : "hex";
    rule.value = typeof v.value === "string" ? v.value : "0";
    if (typeof v.rawExpression === "string") rule.rawExpression = v.rawExpression;
  } else {
    rule.op1Bit = v.op1Bit === "1" || v.op1Bit === "0" || v.op1Bit === "F" || v.op1Bit === "B" || v.op1Bit === "X" ? v.op1Bit : "R";
  }
  return rule;
}

/**
 * The section of the page of a profile, read with care (a profile is a file anyone can edit); null for a
 * profile that has none - one written by hand, which is applied as it always was.
 */
export function guiOf(data: unknown): ProfileGui | null {
  const g = isObject(data) ? data.gui : undefined;
  if (!isObject(g)) return null;
  const capture = isObject(data) && isObject(data.capture) ? data.capture : {};
  const custom = typeof g.custom_trigger === "string" ? g.custom_trigger.trim() : "";
  const rule = ruleOf(g.rule);
  const triggered = typeof capture.trigger === "string" && capture.trigger.trim() !== "" && capture.trigger.trim() !== "now";
  return {
    mode: MODES.includes(g.mode as CaptureMode) ? (g.mode as CaptureMode) : triggered ? "trigger_rule" : "just_capture",
    rule,
    // a trigger the section does not explain (it was changed in the file) is taken as the expression it is
    customTrigger: custom !== "" || rule ? custom : triggered ? String(capture.trigger).trim() : "",
    captureName: typeof g.capture_name === "string" ? g.capture_name.trim() : null,
    twinTurbo: g.twin_turbo === true,
    core: typeof g.core === "string" ? g.core : "",
  };
}

/**
 * The name the Save dialog starts with: that of the selected profile if it was saved from the page (it is saved
 * again), else that of the probe file, else a plain one. Never the name of a listed profile that was written by
 * hand - also not where the probe file happens to be called like one: to replace such a profile, its name has
 * to be typed. "" when nothing is left to offer.
 */
export function nameToOffer(selected: { name?: unknown; data?: unknown } | undefined, listed: { name?: unknown; data?: unknown }[], ltxPath: string): string {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const byHand = new Set(listed.filter((p) => guiOf(p.data) === null).map((p) => text(p.name).toLowerCase()));
  const names = [
    selected && guiOf(selected.data) !== null ? text(selected.name) : "",
    (ltxPath.split(/[\\/]/).pop() || "").replace(/\.ltx$/i, "").trim(),
    "my configuration",
  ];
  return names.find((n) => n !== "" && !byHand.has(n.toLowerCase())) ?? "";
}

/** The export format a profile names, if it is one the page offers. */
export function formatOf(data: unknown): CaptureConfig["format"] | null {
  const format = isObject(data) && isObject(data.capture) ? data.capture.format : undefined;
  return FORMATS.includes(format as CaptureConfig["format"]) ? (format as CaptureConfig["format"]) : null;
}
