// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

// What the controls tell assistive technology: the state of a choice and the name of a field, which a class or a
// placeholder does not say. The components are rendered to markup, without a DOM: enough to read attributes.
import { type ComponentProps, type FunctionComponent, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CaptureConfig, IlaProbe, TriggerRule } from "../types";
import { CaptureImport } from "./CaptureImport";
import { CaptureNavigator } from "./CaptureNavigator";
import { HardwareConfig } from "./HardwareConfig";
import { ProbeSelector } from "./ProbeSelector";
import { SaveProfileDialog } from "./SaveProfileDialog";
import { TriggerRuleBuilder } from "./TriggerRuleBuilder";

const markup = <P extends object>(component: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(component, props));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
/** every opening tag of the markup that carries the attribute, with the value of it */
const tagsWith = (html: string, attribute: string) =>
  [...html.matchAll(new RegExp(`<([a-z0-9]+)\\b[^>]*\\s${attribute}="([^"]*)"[^>]*>`, "g"))].map((m) => ({ tag: m[1], value: m[2], markup: m[0] }));
const idsOf = (html: string) => tagsWith(html, "id").map((t) => t.value);
/** the buttons that say whether they are pressed, as [what they read, the state] */
const pressed = (html: string) =>
  [...html.matchAll(/<button\b[^>]*\saria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => [text(m[2]), m[1]] as const);
/** the name a field gets from the label bound to it */
const labelOf = (html: string, id: string) => {
  const label = new RegExp(`<label\\b[^>]*\\sfor="${id}"[^>]*>(.*?)</label>`).exec(html);
  return label ? text(label[1]) : null;
};

/** every label and every aria-labelledby of the markup names an element that is there, and no id is given twice */
function expectBound(html: string) {
  const ids = idsOf(html);
  expect(new Set(ids).size).toBe(ids.length);
  const named = [...tagsWith(html, "for"), ...tagsWith(html, "aria-labelledby")].flatMap((t) => t.value.split(" "));
  expect(named.length).toBeGreaterThan(0);
  for (const id of named) expect(ids).toContain(id);
}

const probe = (fullName: string, width: number, port: number): IlaProbe => {
  const name = fullName.replace(/\[\d+:\d+\]$/, "").split("/").pop() ?? fullName;
  return { name, fullName, width, isBus: width > 1, core: "u_ila_0", port };
};
// two instances of one module: their probes share the leaf names
const PROBES = [probe("u_a/valid", 1, 0), probe("u_b/valid", 1, 1), probe("u_a/data[7:0]", 8, 2), probe("u_b/data[7:0]", 8, 3)];

const config = (more: Partial<CaptureConfig>): CaptureConfig => ({
  mode: "just_capture",
  captureName: "cap_run_001",
  position: 1000,
  timeoutMin: 1,
  format: "csv",
  samplePeriodNs: 0,
  activeRule: null,
  customTriggerStr: "",
  ...more,
});
const rule = (p: IlaProbe, more: Partial<TriggerRule>): TriggerRule => ({ probeName: p.name, probeFullName: p.fullName.replace(/\[\d+:\d+\]$/, ""), isBus: p.isBus, width: p.width, ...more });
const builder = (cfg: CaptureConfig) =>
  markup(TriggerRuleBuilder, { config: cfg, onChangeConfig: () => {}, availableProbes: PROBES, allProbes: PROBES, maxPosition: 1023 });

describe("TriggerRuleBuilder", () => {
  it("says which capture mode is chosen", () => {
    for (const mode of ["just_capture", "trigger_rule", "constant_capture"] as const) {
      const modes = pressed(builder(config({ mode }))).slice(0, 3);
      expect(modes.map(([, state]) => state)).toEqual(["just_capture", "trigger_rule", "constant_capture"].map((m) => String(m === mode)));
    }
    expect(pressed(builder(config({})))[0][0]).toContain("Just Capture");
  });

  it("says which edge or level of a 1-bit probe is the trigger", () => {
    const html = builder(config({ mode: "trigger_rule", activeRule: rule(PROBES[0], { op1Bit: "F" }) }));
    expect(pressed(html).slice(3)).toEqual([
      ["Rising Edge (R)", "false"],
      ["Falling Edge (F)", "true"],
      ["High (1)", "false"],
      ["Low (0)", "false"],
      ["Either (B)", "false"],
    ]);
  });

  it("says in which radix the value of a bus is given", () => {
    const html = builder(config({ mode: "trigger_rule", activeRule: rule(PROBES[2], { opMultiBit: "dec", value: "100" }) }));
    expect(pressed(html).slice(3)).toEqual([
      ["Hex (h)", "false"],
      ["Dec (u)", "true"],
      ["Bin (b)", "false"],
    ]);
  });

  it("binds every label to its field, and a label of several buttons to their group", () => {
    const bit = builder(config({ mode: "trigger_rule", activeRule: rule(PROBES[0], { op1Bit: "R" }) }));
    const bus = builder(config({ mode: "trigger_rule", activeRule: rule(PROBES[2], { opMultiBit: "hex", value: "3F" }) }));
    for (const html of [builder(config({})), bit, bus]) expectBound(html);
    expect(labelOf(bit, "trigger-probe")).toBe("Select Trigger Probe");
    expect(labelOf(bus, "trigger-value")).toBe("Match Value");
    expect(labelOf(bus, "trigger-custom")).toContain("Custom trigger expression");
    expect(labelOf(bus, "capture-position")).toBe("Pre-Trigger Position (Samples)");
    expect(labelOf(bus, "capture-timeout")).toBe("Timeout (Minutes)");
    expect(labelOf(bus, "capture-format")).toBe("Export Format");
    // the slider beside the number has the same name
    expect(tagsWith(bus, "aria-labelledby").map((t) => `${t.tag} ${t.value}`)).toEqual(["div trigger-radix-label", "input capture-position-label"]);
    expect(tagsWith(bit, "aria-labelledby").map((t) => `${t.tag} ${t.value}`)).toEqual(["div trigger-edge-label", "input capture-position-label"]);
    // a group needs the role to carry a name
    for (const group of [...tagsWith(bit, "aria-labelledby"), ...tagsWith(bus, "aria-labelledby")].filter((t) => t.tag === "div")) {
      expect(group.markup).toContain('role="group"');
    }
  });
});

describe("HardwareConfig", () => {
  const html = markup(HardwareConfig, {
    serverUrl: "127.0.0.1:3121",
    setServerUrl: () => {},
    ltxPath: "top.ltx",
    setLtxPath: () => {},
    tclPath: "",
    setTclPath: () => {},
    deviceFilter: "*",
    setDeviceFilter: () => {},
    omitJtagFreq: false,
    setOmitJtagFreq: () => {},
    jtagFreqHz: 0,
    setJtagFreqHz: () => {},
    hubClockHz: 25000000,
    cores: [],
    selectedCoreIndex: 0,
    setSelectedCoreIndex: () => {},
    onParseLtx: () => {},
    isParsing: false,
    onError: () => {},
  });

  it("binds every label to its field", () => {
    expectBound(html);
    expect(labelOf(html, "hw-ltx-path")).toContain("Vivado Probe File (.ltx)");
    expect(labelOf(html, "hw-tcl-path")).toContain("Vivado Tcl Script (.tcl)");
    expect(labelOf(html, "hw-server-url")).toBe("hw_server URL");
    expect(labelOf(html, "hw-device-filter")).toBe("Device Filter");
    expect(labelOf(html, "hw-tck")).toBe("JTAG Clock (TCK)");
    // no label of the card is left without a field
    expect(html.match(/<label\b/g)).toHaveLength(tagsWith(html, "for").length);
  });

  it("names the second field of the JTAG clock, which has no label of its own", () => {
    const custom = tagsWith(html, "aria-label").filter((t) => t.tag === "input");
    expect(custom.map((t) => t.value)).toEqual(["JTAG clock of your own, in MHz"]);
  });
});

describe("ProbeSelector", () => {
  const props: ComponentProps<typeof ProbeSelector> = {
    probes: PROBES,
    activeRule: null,
    onSelectTriggerProbe: () => {},
    onClearTrigger: () => {},
    selectedWaveformSignals: [],
    onToggleWaveformSignal: () => {},
    onSelectAllWaveformSignals: () => {},
    formats: {},
    onSetFormat: () => {},
  };
  const html = markup(ProbeSelector, props);

  it("names the Plot box of every probe after the probe, also where two share a leaf name", () => {
    const boxes = tagsWith(html, "aria-label").filter((t) => t.markup.includes('type="checkbox"'));
    expect(boxes.map((t) => t.value)).toEqual(["Plot u_a/valid", "Plot u_b/valid", "Plot u_a/data[7:0]", "Plot u_b/data[7:0]"]);
  });

  it("says which kind of probe is listed, and names the search box", () => {
    expect(pressed(html)).toEqual([
      ["All (4)", "true"],
      ["1-Bit (2)", "false"],
      ["Buses (2)", "false"],
    ]);
    expect(tagsWith(html, "aria-label").filter((t) => t.markup.includes("search-input")).map((t) => t.value)).toEqual(["Search probes by name or hierarchy"]);
  });
});

describe("SaveProfileDialog", () => {
  it("is a dialog that carries its heading as its name", () => {
    const html = markup(SaveProfileDialog, {
      suggested: "my-board",
      profiles: [],
      selectedPath: "",
      inherits: null,
      formatChange: null,
      onSave: () => Promise.reject(new Error("not asked")),
      onClose: () => {},
    });
    const dialogs = tagsWith(html, "role").filter((t) => t.value === "dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].markup).toContain('aria-modal="true"');
    const heading = /aria-labelledby="([^"]+)"/.exec(dialogs[0].markup)?.[1] ?? "";
    expect(new RegExp(`<h3 id="${heading}">(.*?)</h3>`).exec(html)?.[1]).toBe("Save configuration");
    // the dialog is not the form itself: a form may not take that role
    expect(dialogs[0].tag).toBe("div");
    expectBound(html);
  });
});

describe("the buttons that open a list", () => {
  const opens = (html: string) => tagsWith(html, "aria-haspopup").map((t) => /aria-expanded="([^"]*)"/.exec(t.markup)?.[1]);

  it("say that they open something, and that it is closed", () => {
    const items = [{ id: 1, name: "s/cap_run_001", path: "captures/s/cap_run_001.csv", at: 0, rows: 1024 }];
    expect(opens(markup(CaptureNavigator, { items, index: 0, onSelect: () => {} }))).toEqual(["false"]);
    expect(opens(markup(CaptureImport, { onImport: () => {}, onError: () => {} }))).toEqual(["false"]);
  });
});
