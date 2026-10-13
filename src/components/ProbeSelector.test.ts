// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IlaProbe } from "../types";
import { ProbeSelector } from "./ProbeSelector";

const probe = (fullName: string, core: string, port: number): IlaProbe => ({
  name: fullName.split("/").pop() ?? fullName,
  fullName,
  width: 1,
  isBus: false,
  core,
  port,
});

/** The cells of the Core column of the list these probes give, each as "what it shows (its tooltip)". Rendered to
 *  markup, without a DOM: enough to read what a cell says. */
function coreCells(probes: IlaProbe[]): string[] {
  const html = renderToStaticMarkup(
    createElement(ProbeSelector, {
      probes,
      activeRule: null,
      onSelectTriggerProbe: () => {},
      onClearTrigger: () => {},
      selectedWaveformSignals: [],
      onToggleWaveformSignal: () => {},
      onSelectAllWaveformSignals: () => {},
      formats: {},
      onSetFormat: () => {},
    }),
  );
  return [...html.matchAll(/<td><span title="([^"]*)">([^<]*)<\/span><\/td>/g)].map((m) => `${m[2]} (${m[1]})`);
}

describe("the Core column of the probe list", () => {
  // a list that does not tell its cores apart shows the probes of all of them, each with its core
  it("names a core as its chip does: the last part of the cell path, after its last dot", () => {
    expect(coreCells([probe("u_a/valid", "u_top/dbg.u_ila_0", 0), probe("u_b/valid", "u_top/u_dbg/u_ila_1", 0)])).toEqual([
      "u_ila_0 (u_top/dbg.u_ila_0)",
      "u_ila_1 (u_top/u_dbg/u_ila_1)",
    ]);
  });

  it("is left out where every probe is of one core", () => {
    expect(coreCells([probe("u_a/valid", "u_ila_0", 0), probe("u_b/valid", "u_ila_0", 1)])).toEqual([]);
  });
});
