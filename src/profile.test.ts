// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import {
  type PageState,
  beyondThePage,
  formatOf,
  guiOf,
  nameToOffer,
  numberOf,
  profileNote,
  profileOf,
  profileValues,
  sameFile,
  sameFileName,
  settingsOf,
} from "./profile";
import type { CaptureConfig, TriggerRule } from "./types";

const capture = (more: Partial<CaptureConfig> = {}): CaptureConfig => ({
  mode: "just_capture",
  captureName: "",
  position: 1000,
  timeoutMin: 5,
  format: "both",
  samplePeriodNs: 0,
  activeRule: null,
  customTriggerStr: "",
  ...more,
});

const page = (more: Partial<PageState> = {}): PageState => ({
  serverUrl: "localhost:3121",
  ltxPath: "C:/d/top.ltx",
  tclPath: "",
  deviceFilter: "*",
  jtagHz: 0,
  coreIndex: 0,
  coreName: "u_ila_demo",
  capture: capture(),
  trigger: "now",
  twinTurbo: false,
  probeFormats: null,
  ...more,
});

const TODAY = "2026-01-02";
const NOTE = `Saved from ILA Studio on ${TODAY}`;
// what the builds before the first public one wrote: they had one more word in front of the program's name
const EARLIER_NOTE = "Saved from " + "Vivado " + "ILA Studio on 2025-12-24";

describe("sameFile", () => {
  it("takes one file for the same, however its path is written", () => {
    expect(sameFile("C:\\A\\top.ltx", "c:/a/TOP.ltx")).toBe(true);
    expect(sameFile("  C:/a/top.ltx ", "C:/a/top.ltx")).toBe(true);
  });

  it("tells two folders apart", () => {
    expect(sameFile("C:/a/top.ltx", "C:/b/top.ltx")).toBe(false);
  });

  it("is false for anything but a string", () => {
    expect(sameFile(undefined, "x")).toBe(false);
    expect(sameFile(5, "5")).toBe(false);
  });
});

describe("sameFileName", () => {
  it("compares the file names only", () => {
    expect(sameFileName("D:/x/top.ltx", "C:\\y\\TOP.LTX")).toBe(true);
    expect(sameFileName("D:/x/top.ltx", "D:/x/other.ltx")).toBe(false);
  });

  it("is false for an empty path and for anything but a string", () => {
    expect(sameFileName("", "")).toBe(false);
    expect(sameFileName("   ", "")).toBe(false);
    expect(sameFileName(null, "top.ltx")).toBe(false);
  });
});

describe("profileOf", () => {
  it("writes a new profile with every section the capture tools read, and the page's own last", () => {
    expect(profileOf("  my-board  ", undefined, page(), TODAY)).toEqual({
      name: "my-board",
      _comment: `${NOTE}.`,
      tools: {},
      hardware: { url: "localhost:3121", ltx: "C:/d/top.ltx", device_filter: "*", ila_index: 0, jtag_frequency_hz: 0 },
      capture: { trigger: "now", position: 1000, timeout_min: 5, format: "both", sample_period_ns: 0 },
      gui: { mode: "just_capture", rule: null, custom_trigger: "", capture_name: "", twin_turbo: false, core: "u_ila_demo", saved: TODAY },
    });
  });

  it("trims the fields and fills in what must not be empty", () => {
    const saved = profileOf("n", undefined, page({ serverUrl: " localhost:3121 ", ltxPath: " C:/d/top.ltx ", deviceFilter: "  ", trigger: "  " }), TODAY);
    expect(saved.hardware).toMatchObject({ url: "localhost:3121", ltx: "C:/d/top.ltx", device_filter: "*" });
    expect(saved.capture).toMatchObject({ trigger: "now" });
  });

  it("writes whole numbers that are not negative for the core, the clock and the position", () => {
    const saved = profileOf("n", undefined, page({ coreIndex: 1.6, jtagHz: -5, capture: capture({ position: NaN }) }), TODAY);
    expect(saved.hardware).toMatchObject({ ila_index: 2, jtag_frequency_hz: 0 });
    expect(saved.capture).toMatchObject({ position: 0 });
  });

  it("writes a timeout of one minute where the page has none, and 0 for an unknown sample period", () => {
    const none = profileOf("n", undefined, page({ capture: capture({ timeoutMin: 0, samplePeriodNs: -1 }) }), TODAY);
    expect(none.capture).toMatchObject({ timeout_min: 1, sample_period_ns: 0 });
    const some = profileOf("n", undefined, page({ capture: capture({ timeoutMin: 0.5, samplePeriodNs: 25 }) }), TODAY);
    expect(some.capture).toMatchObject({ timeout_min: 0.5, sample_period_ns: 25 });
  });

  it("names the Tcl script of the page among the tools, and none when the field is empty", () => {
    const base = { tools: { vivado: "C:/v/vivado.bat", tcl_script: "old.tcl" } };
    expect(profileOf("n", base, page({ tclPath: " scripts/my.tcl " }), TODAY).tools).toEqual({ vivado: "C:/v/vivado.bat", tcl_script: "scripts/my.tcl" });
    expect(profileOf("n", base, page(), TODAY).tools).toEqual({ vivado: "C:/v/vivado.bat" });
  });

  it("writes the probe formats of the page as the whole statement", () => {
    const base = { hardware: { ltx: "C:/d/top.ltx" }, capture: { probe_format: { "u_top/status": "hex" }, radix: "HEX" } };
    const saved = profileOf("n", base, page({ probeFormats: { "u_top/adc_data": "signed" } }), TODAY);
    expect(saved.capture).toMatchObject({ probe_format: { "u_top/adc_data": "signed" }, radix: "UNSIGNED" });
  });

  it("names no probe formats when the page knows none", () => {
    const saved = profileOf("n", undefined, page(), TODAY);
    expect(saved.capture).not.toHaveProperty("probe_format");
    expect(saved.capture).not.toHaveProperty("radix");
  });

  it("keeps the probe formats of the base while the page knows none for the same probe file", () => {
    const base = { hardware: { ltx: "c:\\d\\TOP.ltx" }, capture: { probe_format: { "u_top/status": "hex" }, radix: "HEX" } };
    expect(profileOf("n", base, page(), TODAY).capture).toMatchObject({ probe_format: { "u_top/status": "hex" }, radix: "HEX" });
  });

  it("drops the probe formats of the base when they belong to another probe file", () => {
    const base = { hardware: { ltx: "C:/other/top.ltx" }, capture: { probe_format: { "u_top/status": "hex" } } };
    expect(profileOf("n", base, page(), TODAY).capture).not.toHaveProperty("probe_format");
  });

  it("drops the cell name of the base and keeps what else its sections hold", () => {
    const base = { hardware: { ila_cell: "u_ila_demo", url: "192.0.2.10:3121", note: "kept" }, capture: { out: "D:/caps", trigger: "old" } };
    const saved = profileOf("n", base, page(), TODAY);
    expect(saved.hardware).toEqual({ url: "localhost:3121", ltx: "C:/d/top.ltx", device_filter: "*", ila_index: 0, jtag_frequency_hz: 0, note: "kept" });
    expect(saved.capture).toMatchObject({ out: "D:/caps", trigger: "now" });
  });

  it("keeps the sections of the base it does not know, with the page's own section last", () => {
    const base = { name: "n", gui: { mode: "constant_capture", stale: true }, watch: { every_s: 5 }, scan: {}, tools: {} };
    const saved = profileOf("n", base, page(), TODAY);
    expect(Object.keys(saved)).toEqual(["name", "_comment", "tools", "hardware", "capture", "watch", "scan", "gui"]);
    expect(saved.watch).toEqual({ every_s: 5 });
    expect(saved.gui).toEqual({ mode: "just_capture", rule: null, custom_trigger: "", capture_name: "", twin_turbo: false, core: "u_ila_demo", saved: TODAY });
  });

  it("does not change the base", () => {
    const base = { name: "n", tools: { tcl_script: "old.tcl" }, hardware: { ila_cell: "u_ila_demo" }, capture: { probe_format: {} } };
    const before = JSON.stringify(base);
    profileOf("n", base, page({ ltxPath: "C:/other.ltx" }), TODAY);
    expect(JSON.stringify(base)).toBe(before);
  });

  describe("the note", () => {
    const noteOf = (name: string, base: Record<string, unknown> | undefined) => profileOf(name, base, page(), TODAY)._comment;

    it("says where a profile saved under a new name came from", () => {
      expect(noteOf("new", { name: "old" })).toBe(`${NOTE}, starting from the profile "old".`);
    });

    it("replaces a hand-written note under a new name", () => {
      expect(noteOf("new", { name: "old", _comment: "Lab setup, do not touch." })).toBe(`${NOTE}, starting from the profile "old".`);
    });

    it("names no origin for a base without a name", () => {
      expect(noteOf("new", { _comment: "no name" })).toBe(`${NOTE}.`);
      expect(noteOf("new", { name: 5 })).toBe(`${NOTE}.`);
    });

    it("gives its own note the new date when the profile is saved again under its name", () => {
      expect(noteOf("mine", { name: "mine", _comment: "Saved from ILA Studio on 2025-12-24." })).toBe(`${NOTE}.`);
      expect(noteOf(" MINE ", { name: "mine", _comment: "Saved from ILA Studio on 2025-12-24." })).toBe(`${NOTE}.`);
    });

    it("keeps the origin of its own note", () => {
      const written = 'Saved from ILA Studio on 2025-12-24, starting from the profile "old".';
      expect(noteOf("mine", { name: "mine", _comment: written })).toBe(`${NOTE}, starting from the profile "old".`);
    });

    it("takes the note of an earlier build for its own and writes it in today's form", () => {
      expect(noteOf("mine", { name: "mine", _comment: `${EARLIER_NOTE}.` })).toBe(`${NOTE}.`);
      const withOrigin = `${EARLIER_NOTE}, starting from the profile "old".`;
      expect(noteOf("mine", { name: "mine", _comment: withOrigin })).toBe(`${NOTE}, starting from the profile "old".`);
    });

    it("keeps a hand-written note under the same name", () => {
      expect(noteOf("mine", { name: "mine", _comment: "Lab setup, do not touch." })).toBe("Lab setup, do not touch.");
    });

    it("keeps its own note once a person has written on it", () => {
      const written = "Saved from ILA Studio on 2025-12-24. Works with the second board too.";
      expect(noteOf("mine", { name: "mine", _comment: written })).toBe(written);
      expect(noteOf("mine", { name: "mine", _comment: `${EARLIER_NOTE}. And more.` })).toBe(`${EARLIER_NOTE}. And more.`);
    });

    it("writes a note where the profile had none", () => {
      expect(noteOf("mine", { name: "mine" })).toBe(`${NOTE}.`);
      expect(noteOf("mine", { name: "mine", _comment: "" })).toBe(`${NOTE}.`);
    });
  });
});

describe("guiOf", () => {
  it("is null for a profile without a section of the page", () => {
    expect(guiOf({})).toBeNull();
    expect(guiOf({ gui: [] })).toBeNull();
    expect(guiOf({ gui: "yes" })).toBeNull();
    expect(guiOf(null)).toBeNull();
    expect(guiOf("profile")).toBeNull();
  });

  it("takes a trigger the section does not explain as the expression it is", () => {
    expect(guiOf({ gui: {}, capture: { trigger: "a eq1'bR" } })).toEqual({
      mode: "trigger_rule",
      rule: null,
      customTrigger: "a eq1'bR",
      captureName: null,
      twinTurbo: false,
      core: "",
    });
  });

  it("falls back to the mode the trigger implies when the section names none it knows", () => {
    expect(guiOf({ gui: { mode: "bogus" }, capture: { trigger: "now" } })?.mode).toBe("just_capture");
    expect(guiOf({ gui: { mode: "bogus" }, capture: { trigger: "  " } })?.mode).toBe("just_capture");
    expect(guiOf({ gui: { mode: "bogus" } })?.mode).toBe("just_capture");
    expect(guiOf({ gui: { mode: "bogus" }, capture: { trigger: "a eq1'b1" } })?.mode).toBe("trigger_rule");
  });

  it("keeps a mode it knows, whatever the trigger says", () => {
    expect(guiOf({ gui: { mode: "constant_capture" }, capture: { trigger: "a eq1'b1" } })?.mode).toBe("constant_capture");
    expect(guiOf({ gui: { mode: "just_capture" }, capture: { trigger: "a eq1'b1" } })?.mode).toBe("just_capture");
  });

  it("reads a bus rule and fills in what it leaves out", () => {
    expect(guiOf({ gui: { rule: { probeName: "a", width: "14", isBus: true } } })?.rule).toEqual({
      probeName: "a",
      isBus: true,
      width: 14,
      opMultiBit: "hex",
      value: "0",
    });
  });

  it("keeps the radix, the value and the names of a bus rule", () => {
    const rule = { probeName: "adc_data", probeFullName: "u_top/adc_data", isBus: true, width: 14, opMultiBit: "dec", value: "100", rawExpression: "x" };
    expect(guiOf({ gui: { rule } })?.rule).toEqual(rule);
    expect(guiOf({ gui: { rule: { ...rule, opMultiBit: "oct", value: 7 } } })?.rule).toMatchObject({ opMultiBit: "hex", value: "0" });
  });

  it("reads a 1-bit rule: a rising edge unless it names another compare it knows", () => {
    expect(guiOf({ gui: { rule: { probeName: "a", width: 1, op1Bit: "Z" } } })?.rule).toEqual({ probeName: "a", isBus: false, width: 1, op1Bit: "R" });
    expect(guiOf({ gui: { rule: { probeName: "a", width: 1, op1Bit: "F", value: "1" } } })?.rule).toEqual({ probeName: "a", isBus: false, width: 1, op1Bit: "F" });
  });

  it("has no rule without a probe name or a width", () => {
    expect(guiOf({ gui: { rule: { probeName: "a", width: 0, isBus: true } } })?.rule).toBeNull();
    expect(guiOf({ gui: { rule: { probeName: "", width: 14, isBus: true } } })?.rule).toBeNull();
    expect(guiOf({ gui: { rule: { probeName: "a", width: "wide" } } })?.rule).toBeNull();
    expect(guiOf({ gui: { rule: "a eq1'bR" } })?.rule).toBeNull();
  });

  it("leaves the expression empty when a rule explains the trigger", () => {
    const gui = { rule: { probeName: "a", width: 1 } };
    expect(guiOf({ gui, capture: { trigger: "a eq1'bR" } })?.customTrigger).toBe("");
  });

  it("prefers the expression of the section to the trigger of the capture", () => {
    expect(guiOf({ gui: { custom_trigger: "  b eq1'b0 " }, capture: { trigger: "a eq1'bR" } })?.customTrigger).toBe("b eq1'b0");
  });

  it("tells an empty capture name from none", () => {
    expect(guiOf({ gui: { capture_name: "" } })?.captureName).toBe("");
    expect(guiOf({ gui: { capture_name: " run " } })?.captureName).toBe("run");
    expect(guiOf({ gui: {} })?.captureName).toBeNull();
    expect(guiOf({ gui: { capture_name: 5 } })?.captureName).toBeNull();
  });

  it("only takes a real true for Twin Turbo and a string for the core", () => {
    expect(guiOf({ gui: { twin_turbo: "yes", core: 3 } })).toMatchObject({ twinTurbo: false, core: "" });
    expect(guiOf({ gui: { twin_turbo: true, core: "u_ila_demo" } })).toMatchObject({ twinTurbo: true, core: "u_ila_demo" });
  });

  it("returns the page a profile was saved from", () => {
    const rule: TriggerRule = { probeName: "adc_data", probeFullName: "u_top/adc_data", isBus: true, width: 14, opMultiBit: "hex", value: "3fe2" };
    const from = page({
      capture: capture({ mode: "trigger_rule", activeRule: rule, customTriggerStr: " c eq1'b1 ", captureName: " run " }),
      trigger: "u_top/adc_data eq14'h3fe2",
      twinTurbo: true,
      coreName: "u_ila_demo",
    });
    expect(guiOf(profileOf("n", undefined, from, TODAY))).toEqual({
      mode: "trigger_rule",
      rule,
      customTrigger: "c eq1'b1",
      captureName: "run",
      twinTurbo: true,
      core: "u_ila_demo",
    });
  });

  it("returns a 1-bit rule and the plain modes as they were saved", () => {
    const rule: TriggerRule = { probeName: "rx_valid", isBus: false, width: 1, op1Bit: "F" };
    const from = page({ capture: capture({ mode: "constant_capture", activeRule: rule }), trigger: "now" });
    expect(guiOf(profileOf("n", undefined, from, TODAY))).toEqual({
      mode: "constant_capture",
      rule,
      customTrigger: "",
      captureName: "",
      twinTurbo: false,
      core: "u_ila_demo",
    });
  });
});

describe("formatOf", () => {
  it("returns a format the page offers", () => {
    expect(formatOf({ capture: { format: "ila" } })).toBe("ila");
    expect(formatOf({ capture: { format: "csv" } })).toBe("csv");
    expect(formatOf({ capture: { format: "both" } })).toBe("both");
  });

  it("is null for any other, and for a profile that names none", () => {
    expect(formatOf({ capture: { format: "CSV" } })).toBeNull();
    expect(formatOf({ capture: {} })).toBeNull();
    expect(formatOf({})).toBeNull();
    expect(formatOf(null)).toBeNull();
  });
});

describe("beyondThePage", () => {
  it("is null for a profile that holds nothing the page does not", () => {
    expect(beyondThePage(null)).toBeNull();
    expect(beyondThePage({})).toBeNull();
    expect(beyondThePage({ tools: { tcl_script: "x" } })).toBeNull();
    expect(beyondThePage({ name: "n", _comment: "x", _private: {}, hardware: {}, capture: {}, gui: {} })).toBeNull();
  });

  it("names the paths of the tools", () => {
    expect(beyondThePage({ tools: { vivado: "C:/v" } })).toBe("the paths of the tools");
  });

  it("names a folder of the captures that is not the usual one", () => {
    expect(beyondThePage({ capture: { out: "D:/caps" } })).toBe("the folder of the captures (D:/caps)");
    expect(beyondThePage({ capture: { out: "captures" } })).toBeNull();
    expect(beyondThePage({ capture: { out: " Captures " } })).toBeNull();
    expect(beyondThePage({ capture: { out: "" } })).toBeNull();
  });

  it("names the sections of the other commands", () => {
    expect(beyondThePage({ watch: {}, scan: {}, _comment: "x", name: "n" })).toBe("the sections watch, scan of the capture script");
    expect(beyondThePage({ watch: {} })).toBe("the section watch of the capture script");
  });

  it("lists all of them", () => {
    expect(beyondThePage({ tools: { vivado: "C:/v" }, capture: { out: "D:/caps" }, watch: {} })).toBe(
      "the paths of the tools, the folder of the captures (D:/caps), the section watch of the capture script",
    );
  });
});

describe("numberOf", () => {
  it("takes a number as it is", () => {
    expect(numberOf(6000000)).toBe(6000000);
    expect(numberOf(0)).toBe(0);
    expect(numberOf(-2.5)).toBe(-2.5);
  });

  it("takes text that spells a number in decimal", () => {
    expect(numberOf("6000000")).toBe(6000000);
    expect(numberOf(" 5 ")).toBe(5);
    expect(numberOf("0.5")).toBe(0.5);
    expect(numberOf(".5")).toBe(0.5);
    expect(numberOf("-3")).toBe(-3);
    expect(numberOf("6e6")).toBe(6000000);
  });

  it("is undefined for any other text", () => {
    for (const text of ["", "   ", "abc", "5 MHz", "0x10", "1,5", "Infinity", "NaN", "1e", "--1"]) {
      expect(numberOf(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it("is undefined for what is neither a number nor text, and for a number that is none", () => {
    for (const value of [null, undefined, true, false, [], [5], {}, { value: 5 }, NaN, Infinity, -Infinity]) {
      expect(numberOf(value), String(value)).toBeUndefined();
    }
  });
});

describe("profileValues", () => {
  const NOTHING = {
    url: null,
    ltx: "",
    deviceFilter: "",
    tclScript: "",
    trigger: "",
    jtagHz: 0,
    ilaIndex: 0,
    position: null,
    timeoutMin: null,
    samplePeriodNs: null,
    ignored: [],
  };

  it("reads a profile as it is written by the rules", () => {
    const data = {
      tools: { tcl_script: "scripts/my.tcl" },
      hardware: { url: "192.0.2.10:3121", ltx: "C:/d/top.ltx", device_filter: "xc7z020*", ila_index: 1, jtag_frequency_hz: 6000000 },
      capture: { trigger: "rx_valid eq1'bR", position: 512, timeout_min: 0.5, sample_period_ns: 2.5 },
    };
    expect(profileValues(data)).toEqual({
      url: "192.0.2.10:3121",
      ltx: "C:/d/top.ltx",
      deviceFilter: "xc7z020*",
      tclScript: "scripts/my.tcl",
      trigger: "rx_valid eq1'bR",
      jtagHz: 6000000,
      ilaIndex: 1,
      position: 512,
      timeoutMin: 0.5,
      samplePeriodNs: 2.5,
      ignored: [],
    });
  });

  it("names nothing for a profile that names nothing", () => {
    expect(profileValues({})).toEqual(NOTHING);
    expect(profileValues({ hardware: {}, capture: {}, tools: {} })).toEqual(NOTHING);
    expect(profileValues(null)).toEqual(NOTHING);
    expect(profileValues("profile")).toEqual(NOTHING);
  });

  // what the capture script takes with int(): the profile works on the command line, so it works here
  it("takes a number written as text for the number", () => {
    const data = {
      hardware: { ila_index: "1", jtag_frequency_hz: "6000000" },
      capture: { position: "512", timeout_min: "5", sample_period_ns: " 2.5 " },
    };
    expect(profileValues(data)).toMatchObject({ ilaIndex: 1, jtagHz: 6000000, position: 512, timeoutMin: 5, samplePeriodNs: 2.5, ignored: [] });
    // numbers, not text that looks like them: text would travel on into the request of a capture
    expect(typeof profileValues(data).ilaIndex).toBe("number");
    expect(typeof profileValues(data).timeoutMin).toBe("number");
  });

  it("rounds what counts something and leaves a time as it is", () => {
    const data = { hardware: { ila_index: 1.6, jtag_frequency_hz: "5999999.6" }, capture: { position: 99.5, timeout_min: 0.25, sample_period_ns: 3.3 } };
    expect(profileValues(data)).toMatchObject({ ilaIndex: 2, jtagHz: 6000000, position: 100, timeoutMin: 0.25, samplePeriodNs: 3.3, ignored: [] });
  });

  it("keeps a position and a sample period of 0, which are settings too", () => {
    expect(profileValues({ capture: { position: 0, sample_period_ns: 0, timeout_min: 0 } })).toMatchObject({ position: 0, samplePeriodNs: 0, timeoutMin: 0, ignored: [] });
  });

  it("leaves out a negative number and says so", () => {
    const data = { hardware: { ila_index: -1, jtag_frequency_hz: "-6000000" }, capture: { position: -5, timeout_min: -1, sample_period_ns: -0.5 } };
    expect(profileValues(data)).toEqual({
      ...NOTHING,
      ignored: [
        "hardware.ila_index is negative",
        "hardware.jtag_frequency_hz is negative",
        "capture.position is negative",
        "capture.timeout_min is negative",
        "capture.sample_period_ns is negative",
      ],
    });
  });

  it("leaves out what is no number where one belongs and says so", () => {
    for (const value of ["fast", "", [1], { hz: 1 }, true, false]) {
      const data = { hardware: { ila_index: value, jtag_frequency_hz: value }, capture: { position: value, timeout_min: value, sample_period_ns: value } };
      expect(profileValues(data), JSON.stringify(value)).toEqual({
        ...NOTHING,
        ignored: [
          "hardware.ila_index is not a number",
          "hardware.jtag_frequency_hz is not a number",
          "capture.position is not a number",
          "capture.timeout_min is not a number",
          "capture.sample_period_ns is not a number",
        ],
      });
    }
  });

  it("leaves out a count the request of a capture cannot carry", () => {
    const data = { hardware: { ila_index: 4294967296, jtag_frequency_hz: 1e300 }, capture: { position: "1e12", timeout_min: 1e9 } };
    expect(profileValues(data)).toMatchObject({
      ilaIndex: 0,
      jtagHz: 0,
      position: null,
      timeoutMin: 1e9,
      ignored: ["hardware.ila_index is too large", "hardware.jtag_frequency_hz is too large", "capture.position is too large"],
    });
    expect(profileValues({ hardware: { ila_index: 4294967295 } })).toMatchObject({ ilaIndex: 4294967295, ignored: [] });
  });

  it("leaves out what is no text where text belongs and says so", () => {
    for (const value of [5, 0, true, false, ["C:/d/top.ltx"], { path: "C:/d/top.ltx" }]) {
      const data = { tools: { tcl_script: value }, hardware: { url: value, ltx: value, device_filter: value }, capture: { trigger: value } };
      expect(profileValues(data), JSON.stringify(value)).toEqual({
        ...NOTHING,
        ignored: [
          "hardware.url is not a text",
          "hardware.ltx is not a text",
          "hardware.device_filter is not a text",
          "capture.trigger is not a text",
          "tools.tcl_script is not a text",
        ],
      });
    }
  });

  it("takes null for a key that is not named, without a word", () => {
    const data = {
      tools: { tcl_script: null },
      hardware: { url: null, ltx: null, device_filter: null, ila_index: null, jtag_frequency_hz: null },
      capture: { trigger: null, position: null, timeout_min: null, sample_period_ns: null },
    };
    expect(profileValues(data)).toEqual(NOTHING);
    expect(profileValues({ hardware: null, capture: null, tools: null })).toEqual(NOTHING);
  });

  it("tells an empty hw_server from none", () => {
    expect(profileValues({ hardware: { url: "" } }).url).toBe("");
    expect(profileValues({ hardware: {} }).url).toBeNull();
  });

  it("leaves text as it is written", () => {
    expect(profileValues({ hardware: { ltx: " C:\\d\\top.ltx " }, capture: { trigger: " now " } })).toMatchObject({ ltx: " C:\\d\\top.ltx ", trigger: " now " });
  });

  it("says so when a section is no section, and reads the others", () => {
    expect(profileValues({ hardware: ["url"], capture: "now", tools: 5 })).toEqual({
      ...NOTHING,
      ignored: ["hardware is not a section", "capture is not a section", "tools is not a section"],
    });
    expect(profileValues({ hardware: [], capture: { position: "7" } })).toMatchObject({ position: 7, ignored: ["hardware is not a section"] });
  });
});

describe("profileNote", () => {
  const profile = { name: "my-board", filename: "my-board.json" };

  it("has nothing to say of a profile that was taken as it is", () => {
    expect(profileNote(profile, [])).toBe("");
  });

  it("names the profile, its file and what was left out", () => {
    expect(profileNote(profile, ["hardware.ila_index is not a number", "capture.timeout_min is negative"])).toBe(
      'Profile "my-board": hardware.ila_index is not a number, capture.timeout_min is negative - left out (profiles\\my-board.json).',
    );
    expect(profileNote(profile, ["hardware.ltx is not a text"])).toBe('Profile "my-board": hardware.ltx is not a text - left out (profiles\\my-board.json).');
  });

  it("says that the file could not be read, whatever else there is", () => {
    const broken = { ...profile, error: "Expecting ',' delimiter: line 5 column 3 (char 80)" };
    expect(profileNote(broken, [])).toBe('Could not read the profile "my-board" (profiles\\my-board.json): Expecting \',\' delimiter: line 5 column 3 (char 80)');
    expect(profileNote(broken, ["capture.position is negative"])).toMatch(/^Could not read the profile/);
  });

  it("calls a profile without a name after its file", () => {
    expect(profileNote({ name: 5, filename: "lab.json" }, ["capture.position is negative"])).toBe('Profile "lab": capture.position is negative - left out (profiles\\lab.json).');
    expect(profileNote({ name: "  ", filename: "lab.JSON" }, ["capture.position is negative"])).toMatch(/^Profile "lab": .* \(profiles\\lab\.JSON\)\.$/);
  });
});

describe("settingsOf", () => {
  const stored = {
    selectedProfilePath: "C:\\tools\\profiles\\my-board.json",
    serverUrl: "192.0.2.10:3121",
    ltxPath: "C:/d/top.ltx",
    tclPath: "",
    deviceFilter: "xc7z020*",
    omitJtagFreq: false,
    jtagFreqHz: 6000000,
    selectedCoreIndex: 1,
    selectedCoreName: "u_ila_demo",
    twinTurbo: true,
  };

  it("returns what the page stored", () => {
    expect(settingsOf(stored)).toEqual(stored);
    expect(settingsOf(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("is null for what is no set of settings", () => {
    for (const value of [null, undefined, "settings", 5, true, [stored]]) expect(settingsOf(value), String(value)).toBeNull();
  });

  it("leaves out what was never stored", () => {
    expect(settingsOf({ serverUrl: "localhost:3121" })).toEqual({ serverUrl: "localhost:3121" });
    expect(settingsOf({})).toEqual({});
    // (not merely equal to nothing: the page asks whether an entry is there)
    expect(settingsOf({})?.jtagFreqHz).toBeUndefined();
    expect(settingsOf({})?.tclPath).toBeUndefined();
    expect(settingsOf({})?.twinTurbo).toBeUndefined();
  });

  it("takes a count written as text for the number, rounded", () => {
    expect(settingsOf({ jtagFreqHz: "6000000", selectedCoreIndex: "1" })).toEqual({ jtagFreqHz: 6000000, selectedCoreIndex: 1 });
    expect(settingsOf({ jtagFreqHz: 5999999.6, selectedCoreIndex: 1.2 })).toEqual({ jtagFreqHz: 6000000, selectedCoreIndex: 1 });
  });

  it("leaves out an entry of the wrong kind", () => {
    const odd = {
      selectedProfilePath: 5,
      serverUrl: ["localhost:3121"],
      ltxPath: { path: "C:/d/top.ltx" },
      tclPath: null,
      deviceFilter: true,
      omitJtagFreq: "yes",
      jtagFreqHz: "fast",
      selectedCoreIndex: -1,
      selectedCoreName: 3,
      twinTurbo: 1,
    };
    expect(settingsOf(odd)).toEqual({});
    expect(settingsOf({ ...stored, jtagFreqHz: -6000000, selectedCoreIndex: 4294967296 })).toEqual({ ...stored, jtagFreqHz: undefined, selectedCoreIndex: undefined });
  });
});

describe("nameToOffer", () => {
  const fromPage = { name: " mine ", data: { gui: {} } };
  const byHand = (name: string) => ({ name, data: {} });

  it("offers the name of the selected profile when the page saved it", () => {
    expect(nameToOffer(fromPage, [fromPage, byHand("lab")], "C:/d/top.ltx")).toBe("mine");
  });

  it("offers the name of the probe file when the selected profile was written by hand", () => {
    const lab = byHand("lab");
    expect(nameToOffer(lab, [lab], "C:/d/top.ltx")).toBe("top");
    expect(nameToOffer(lab, [lab], "C:\\d\\Top.LTX")).toBe("Top");
    expect(nameToOffer(undefined, [], "C:/d/top.ltx")).toBe("top");
  });

  it("never offers the name of a profile that was written by hand", () => {
    const lab = byHand("lab");
    expect(nameToOffer(lab, [lab, byHand("TOP")], "C:/d/top.ltx")).toBe("my configuration");
    expect(nameToOffer(lab, [lab, byHand("top")], "C:/d/Top.ltx")).toBe("my configuration");
    expect(nameToOffer(lab, [lab, byHand("top"), byHand("My Configuration")], "C:/d/top.ltx")).toBe("");
    // also not that of the selected one, should the list not hold it
    expect(nameToOffer(lab, [], "C:/d/top.ltx")).toBe("top");
  });

  it("offers a plain name without a probe file", () => {
    expect(nameToOffer(undefined, [], "")).toBe("my configuration");
  });

  it("may offer the name of the probe file again when the page saved the profile of that name", () => {
    expect(nameToOffer(undefined, [{ name: "top", data: { gui: {} } }], "C:/d/top.ltx")).toBe("top");
  });
});
