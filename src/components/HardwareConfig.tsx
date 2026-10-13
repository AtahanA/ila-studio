// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React from "react";
import { IlaCore } from "../types";
import { Server, FileCode, Cpu, Radio, Sparkles, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

interface HardwareConfigProps {
  serverUrl: string;
  setServerUrl: (url: string) => void;
  ltxPath: string;
  setLtxPath: (path: string) => void;
  tclPath: string;
  setTclPath: (path: string) => void;
  deviceFilter: string;
  setDeviceFilter: (filter: string) => void;
  omitJtagFreq: boolean;
  setOmitJtagFreq: (omit: boolean) => void;
  jtagFreqHz: number;
  setJtagFreqHz: (hz: number) => void;
  /** debug hub clock from the probe file (0 = unknown); TCK must stay below a 2.5th of it */
  hubClockHz: number;
  cores: IlaCore[];
  selectedCoreIndex: number;
  setSelectedCoreIndex: (idx: number) => void;
  /** probes of each core, in the order of `cores` (0 where the list does not tell) */
  coreProbeCounts?: number[];
  /** a hardware job is running: the core it runs on is not changed under it */
  coresLocked?: boolean;
  onParseLtx: (path?: string) => void;
  isParsing: boolean;
  /** a file dialog could not be opened: the sentence for the status line (a release build has no console) */
  onError: (text: string) => void;
}

export const HardwareConfig: React.FC<HardwareConfigProps> = ({
  serverUrl,
  setServerUrl,
  ltxPath,
  setLtxPath,
  tclPath,
  setTclPath,
  deviceFilter,
  setDeviceFilter,
  omitJtagFreq,
  setOmitJtagFreq,
  jtagFreqHz,
  setJtagFreqHz,
  hubClockHz,
  cores,
  selectedCoreIndex,
  setSelectedCoreIndex,
  coreProbeCounts,
  coresLocked,
  onParseLtx,
  isParsing,
  onError,
}) => {
  // "Browse" must not be a button that does nothing: why no dialog opened is said where the user looks
  const dialogFailed = (e: unknown) => onError(`Could not open the file dialog: ${e}`);

  const handleBrowseLtx = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Vivado Probes", extensions: ["ltx"] }],
      });
      if (selected && typeof selected === "string") {
        setLtxPath(selected);
        onParseLtx(selected);
      }
    } catch (e) {
      dialogFailed(e);
    }
  };

  const handleBrowseTcl = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Vivado Tcl Script", extensions: ["tcl"] }],
      });
      if (selected && typeof selected === "string") {
        setTclPath(selected);
      }
    } catch (e) {
      dialogFailed(e);
    }
  };

  // TCK should stay below the debug hub clock / 2.5; well above it the ILA cannot be driven at all (it stays IDLE
  // and the upload is empty or corrupt). "Auto" applies the rule; an explicit frequency is used as given, so the
  // presets above the rule are only marked here.
  const maxSafeHz = hubClockHz > 0 ? Math.floor(hubClockHz / 2.5) : 0;
  const PRESET_HZ = [0, 1000000, 2000000, 3000000, 6000000, 10000000, 15000000, 20000000, 30000000];
  const fastestSafe = maxSafeHz > 0 ? Math.max(...PRESET_HZ.filter((hz) => hz > 0 && hz <= maxSafeHz), 0) : 0;
  const mhz = (hz: number) => (hz / 1000000).toFixed(2).replace(/\.?0+$/, "");
  const auto = omitJtagFreq || jtagFreqHz === 0;
  const chooseHz = (hz: number) => {
    if (omitJtagFreq) setOmitJtagFreq(false);
    setJtagFreqHz(hz);
  };
  const presetLabel = (hz: number) =>
    hz === 0
      ? "Auto"
      : `${hz / 1000000} MHz${hz === fastestSafe ? " ★" : maxSafeHz > 0 && hz > maxSafeHz ? " (too fast)" : ""}`;
  const hubRule = maxSafeHz > 0 ? `debug hub ${mhz(hubClockHz)} MHz → TCK ≤ ${mhz(maxSafeHz)} MHz` : "";
  const tckHint = [auto ? "Auto" : `${mhz(jtagFreqHz)} MHz asked`, hubRule].filter(Boolean).join(" · ");
  const tckHelp =
    (auto
      ? "Automatic: the cable's own frequency, lowered only when it is too fast for the debug hub."
      : `${mhz(jtagFreqHz)} MHz is asked for and snapped down to a value the cable offers.`) +
    (maxSafeHz > 0
      ? ` The debug hub clock of this design is ${mhz(hubClockHz)} MHz: TCK must stay at or below ${mhz(maxSafeHz)} MHz (hub clock / 2.5), or the ILA may not respond.` +
        (fastestSafe > 0 ? ` ★ marks the fastest preset inside that rule.` : "")
      : " Read the probe file to see the limit the debug hub of the design sets.");

  return (
    <div className="card hardware-card">
      <div className="card-header">
        <div className="card-title">
          <Server size={18} className="text-accent" />
          <h3>Hardware & ILA Core Input</h3>
        </div>
      </div>

      <div className="card-body">
        {/* LTX File Path Input */}
        <div className="form-group full-width">
          <label className="form-label">
            <FileCode size={14} />
            <span>Vivado Probe File (.ltx)</span>
            <span className="required-star">*</span>
          </label>
          <div className="input-with-actions">
            <input
              type="text"
              className="text-input"
              value={ltxPath}
              onChange={(e) => setLtxPath(e.target.value)}
              placeholder="e.g. top.ltx or C:\path\to\top.ltx"
            />
            <button
              className="btn btn-secondary"
              onClick={handleBrowseLtx}
              title="Browse for .ltx file on disk"
            >
              <FolderOpen size={15} />
              <span>Browse</span>
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => onParseLtx()}
              disabled={isParsing || !ltxPath}
              title="Offline parse of probe names and widths from LTX XML file"
            >
              <Sparkles size={15} />
              <span>{isParsing ? "Parsing..." : "Parse File"}</span>
            </button>
          </div>
        </div>

        {/* Tcl Script Path Input */}
        <div className="form-group full-width">
          <div className="form-label-with-toggle">
            <label className="form-label">
              <FileCode size={14} />
              <span>Vivado Tcl Script (.tcl)</span>
              <span className="badge-chip-inline">REPL / Automation Script</span>
            </label>
          </div>
          <div className="input-with-actions">
            <input
              type="text"
              className="text-input"
              value={tclPath}
              onChange={(e) => setTclPath(e.target.value)}
              placeholder="leave empty for the bundled scripts\vivado_ila_repl.tcl"
            />
            <button
              className="btn btn-secondary"
              onClick={handleBrowseTcl}
              title="Browse for custom .tcl script on disk"
            >
              <FolderOpen size={15} />
              <span>Browse</span>
            </button>
          </div>
        </div>

        {/* Server & JTAG */}
        <div className="form-grid-3">
          <div className="form-group">
            <label className="form-label">
              <Server size={14} />
              <span>hw_server URL</span>
            </label>
            <input
              type="text"
              className="text-input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="127.0.0.1:3121"
            />
          </div>

          <div className="form-group">
            <label className="form-label">
              <Cpu size={14} />
              <span>Device Filter</span>
            </label>
            <input
              type="text"
              className="text-input"
              value={deviceFilter}
              onChange={(e) => setDeviceFilter(e.target.value)}
              placeholder="* = find the FPGA with the ILA"
              title="Glob for the JTAG device, e.g. xc7z020*. With * the chain is searched for the device that carries the ILA (the ARM DAP of a Zynq is skipped)."
            />
          </div>

          <div className="form-group">
            <label className="form-label">
              <Radio size={14} />
              <span>JTAG Clock (TCK)</span>
            </label>
            <div className="input-with-actions tck-row">
              <select
                className="select-input"
                value={auto ? 0 : jtagFreqHz}
                onChange={(e) => chooseHz(Number(e.target.value))}
                title={tckHelp}
              >
                {PRESET_HZ.map((hz) => (
                  <option key={hz} value={hz}>
                    {presetLabel(hz)}
                  </option>
                ))}
                {!auto && !PRESET_HZ.includes(jtagFreqHz) && <option value={jtagFreqHz}>{mhz(jtagFreqHz)} MHz</option>}
              </select>
              <input
                type="number"
                step="0.5"
                min="0"
                max="100"
                className="text-input tck-custom"
                placeholder="MHz"
                value={auto ? "" : jtagFreqHz / 1000000}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  chooseHz(isNaN(val) || val <= 0 ? 0 : Math.round(val * 1000000));
                }}
                title="A frequency of your own in MHz (empty: automatic)"
              />
            </div>
            <span className={`form-hint one-line ${auto ? "success" : ""}`} title={tckHelp}>
              {tckHint}
            </span>
          </div>
        </div>

        {/* Detected Cores */}
        {cores.length > 0 && (
          <div className="cores-section">
            <div className="cores-header">
              <span>Detected ILA Cores ({cores.length})</span>
            </div>
            <div className="cores-chips">
              {cores.map((c, idx) => {
                // the last part of the cell path says which core it is; the whole path is the tooltip
                const leaf = c.name.split("/").pop() || c.name;
                const short = leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".") + 1) : leaf;
                const count = coreProbeCounts?.[idx] || 0;
                return (
                <button
                  key={c.name + idx}
                  className={`core-chip ${selectedCoreIndex === idx ? "active" : ""}`}
                  onClick={() => setSelectedCoreIndex(idx)}
                  disabled={coresLocked && selectedCoreIndex !== idx}
                  aria-pressed={selectedCoreIndex === idx}
                  title={
                    `${c.name}\nILA core ${idx} of this device${c.depth > 0 ? `, depth ${c.depth.toLocaleString()} samples` : " (Connect reads its depth)"}` +
                    (selectedCoreIndex === idx
                      ? ": the one that is captured, and whose probes are listed"
                      : coresLocked
                        ? ": cannot be selected while a hardware job is running"
                        : ": click to capture this core and list its probes")
                  }
                >
                  <Cpu size={14} />
                  {cores.length > 1 && <span className="core-index">[{idx}]</span>}
                  <span className="core-name">{short}</span>
                  {count > 0 && <span className="core-probes">{count} probes</span>}
                  {/* the probe file does not carry the depth: it is shown once Connect has read it from the core.
                      One core alone has room to say so; several keep their chips short */}
                  {(c.depth > 0 || cores.length === 1) && (
                    <span className="core-depth" title={c.depth > 0 ? "" : "The probe file does not carry the depth; Connect reads it from the core"}>
                      Depth: {c.depth > 0 ? c.depth.toLocaleString() : "connect to read"}
                    </span>
                  )}
                </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
