// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { type PageState, beyondThePage, formatOf, guiOf, nameToOffer, profileOf, sameFile, sameFileName } from "./profile";
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
