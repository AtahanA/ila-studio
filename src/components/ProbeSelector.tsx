// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useState, useMemo } from "react";
import { IlaCore, IlaProbe, PROBE_FORMATS, ProbeFormat, TriggerRule } from "../types";
import { probeKey } from "../trigger";
import { Search, Sliders, Hash, ToggleLeft, ArrowUpRight, Check, Filter, X } from "lucide-react";

interface ProbeSelectorProps {
  /** the probes of the selected ILA core (all probes where the list does not tell cores apart) */
  probes: IlaProbe[];
  /** with several cores: the probes of every core, so that a search can say on which core a name is */
  allProbes?: IlaProbe[];
  cores?: IlaCore[];
  selectedCoreIndex?: number;
  onSelectCore?: (index: number) => void;
  /** a hardware job is running: the core is not changed under it */
  coresLocked?: boolean;
  activeRule: TriggerRule | null;
  onSelectTriggerProbe: (probe: IlaProbe) => void;
  /** the button of the probe that is the trigger takes the trigger away again */
  onClearTrigger: () => void;
  /** the probes ticked for the waveform viewer, by probeKey: two probes may share a leaf name */
  selectedWaveformSignals: string[];
  onToggleWaveformSignal: (key: string) => void;
  onSelectAllWaveformSignals: () => void;
  /** how each bus is written into the CSV of a capture, by probeKey; a probe that is not named is unsigned */
  formats: Record<string, ProbeFormat>;
  onSetFormat: (probeKeys: string[], format: ProbeFormat) => void;
  /** why no format can be chosen right now ("" when it can): the selects are off and say this */
  formatsLocked?: string;
}

/** A net name that may break after "/" and "_": it is one long word otherwise, and breaks wherever it must. */
const breakable = (name: string) =>
  name.split(/(?<=[/_])/).map((part, i) => (
    <React.Fragment key={i}>
      {part}
      <wbr />
    </React.Fragment>
  ));

const FORMAT_HINT =
  "How this bus is written into the CSV of the captures started from now on:\n" +
  "unsigned - the plain number (16354)\n" +
  "signed - two's complement of the probe width (-30 for a 14-bit bus)\n" +
  "hex - 0x and every digit of the width (0x3FE2)\n" +
  "The plots read all three alike; a bus written signed is plotted signed.";

export const ProbeSelector: React.FC<ProbeSelectorProps> = ({
  probes,
  allProbes,
  cores,
  selectedCoreIndex,
  onSelectCore,
  coresLocked,
  activeRule,
  onSelectTriggerProbe,
  onClearTrigger,
  selectedWaveformSignals,
  onToggleWaveformSignal,
  onSelectAllWaveformSignals,
  formats,
  onSetFormat,
  formatsLocked,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<"all" | "single" | "bus">("all");

  // one way of matching for the list and for the hint about other cores: the search text without blanks around
  // it, in the short or the hierarchical name; and the kind of probe the filter buttons ask for
  const term = searchTerm.trim().toLowerCase();
  const named = (p: IlaProbe) => p.name.toLowerCase().includes(term) || p.fullName.toLowerCase().includes(term);
  const ofKind = (p: IlaProbe) => (filterType === "single" ? !p.isBus : filterType === "bus" ? p.isBus : true);
  const filteredProbes = useMemo(() => probes.filter((p) => named(p) && ofKind(p)), [probes, term, filterType]);

  const singleCount = probes.filter((p) => !p.isBus).length;
  const busCount = probes.filter((p) => p.isBus).length;

  // A search that is also (or only) at home on another core: say where. The list shows one core, and a name one
  // is looking for may well be a probe of another - the hint is a click away from it.
  const several = !!allProbes && !!cores && cores.length > 1;
  const elsewhere = useMemo(() => {
    if (!several || !term) return [];
    return cores!
      .map((c, index) => ({
        index,
        name: c.name,
        count: index === selectedCoreIndex ? 0 : allProbes!.filter((p) => p.core === c.name && named(p) && ofKind(p)).length,
      }))
      .filter((c) => c.count > 0);
  }, [several, term, filterType, allProbes, cores, selectedCoreIndex]);
  // "not on this core" is said only when no probe of this core has the name at all - not when the filter
  // buttons merely hide the ones that have
  const hereAtAll = useMemo(() => !!term && probes.some(named), [probes, term]);
  const shortCore = (name: string) => {
    const leaf = name.split("/").pop() || name;
    return leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".") + 1) : leaf;
  };
  // the column that names the core is of use only where the list holds probes of more than one
  const coreColumn = new Set(probes.map((p) => p.core)).size > 1;

  return (
    <div className="card probes-card">
      <div className="card-header">
        <div className="card-title">
          <Sliders size={18} className="text-accent" />
          <h3>ILA Parameters & Probes ({probes.length})</h3>
        </div>

        <div className="probe-stats">
          {several && selectedCoreIndex !== undefined && cores![selectedCoreIndex] && (
            <span className="stat-pill probes-core-label" title={`The probes of the selected ILA core: ${cores![selectedCoreIndex].name}`}>
              core [{selectedCoreIndex}] of {cores!.length}
            </span>
          )}
          <span className="stat-pill">1-Bit: {singleCount}</span>
          <span className="stat-pill">Bus: {busCount}</span>
        </div>
      </div>

      <div className="probes-toolbar">
        {/* Search */}
        <div className="search-box">
          <Search size={14} className="search-icon" />
          <input
            type="text"
            className="search-input"
            placeholder="Search probes by name or hierarchy..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Filter Pills */}
        <div className="filter-group">
          <button
            className={`filter-btn ${filterType === "all" ? "active" : ""}`}
            onClick={() => setFilterType("all")}
          >
            All ({probes.length})
          </button>
          <button
            className={`filter-btn ${filterType === "single" ? "active" : ""}`}
            onClick={() => setFilterType("single")}
          >
            <ToggleLeft size={13} /> 1-Bit ({singleCount})
          </button>
          <button
            className={`filter-btn ${filterType === "bus" ? "active" : ""}`}
            onClick={() => setFilterType("bus")}
          >
            <Hash size={13} /> Buses ({busCount})
          </button>
        </div>

        <button
          className="btn btn-tiny"
          onClick={onSelectAllWaveformSignals}
          title="Select/deselect all signals for display"
        >
          Toggle All
        </button>
      </div>

      {elsewhere.length > 0 && (
        <div className="probes-other-cores">
          <span>{hereAtAll ? "Also on" : "Not on this core. On"}</span>
          {elsewhere.map((c) => (
            <button
              key={c.name}
              className="probes-other-core"
              data-core-index={c.index}
              disabled={coresLocked}
              onClick={() => onSelectCore?.(c.index)}
              title={`${c.name}\n${c.count} matching probe(s) on this core: click to select it (the search stays)`}
            >
              [{c.index}] {shortCore(c.name)} <b>{c.count}</b>
            </button>
          ))}
        </div>
      )}

      <div className="probes-table-container">
        {probes.length === 0 ? (
          <div className="empty-state">
            <Filter size={32} className="empty-icon" />
            <p>No ILA probes parsed yet.</p>
            <span>Name a .ltx file on the left (Parse File), load a profile, or Connect to read them from the device.</span>
          </div>
        ) : (
          <table className="probes-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>Plot</th>
                <th>Signal / Net Name</th>
                <th>Width</th>
                <th title={FORMAT_HINT}>
                  <span className="probe-format-head">
                    In the CSV
                    {/* one choice for every bus the search and the filter leave in the list */}
                    <select
                      className="probe-format-select"
                      value=""
                      disabled={!!formatsLocked || !filteredProbes.some((p) => p.isBus)}
                      title={formatsLocked || "Set the format of every bus shown in this list at once"}
                      onChange={(e) => {
                        if (e.target.value) {
                          onSetFormat(filteredProbes.filter((p) => p.isBus).map(probeKey), e.target.value as ProbeFormat);
                        }
                      }}
                    >
                      <option value="">all shown...</option>
                      {PROBE_FORMATS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </span>
                </th>
                {coreColumn && <th>Core</th>}
                <th style={{ textAlign: "right" }}>Trigger Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredProbes.map((probe) => {
                const isTriggerTarget = activeRule?.probeFullName
                  ? activeRule.probeFullName === probeKey(probe)
                  : activeRule?.probeName === probe.name;
                const isSelectedPlot = selectedWaveformSignals.includes(probeKey(probe));

                return (
                  <tr
                    key={probe.fullName}
                    className={`probe-row ${isTriggerTarget ? "row-trigger-active" : ""}`}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="checkbox-custom"
                        checked={isSelectedPlot}
                        onChange={() => onToggleWaveformSignal(probeKey(probe))}
                        title="Include in waveform plot"
                      />
                    </td>
                    <td>
                      <div className="probe-name-cell">
                        <span className="probe-short-name">{breakable(probe.name)}</span>
                        <span className="probe-full-name">{breakable(probe.fullName)}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`width-badge ${probe.isBus ? "bus-badge" : "bit-badge"}`}>
                        {probe.width > 1 ? `[${probe.width - 1}:0]` : "1-bit"}
                      </span>
                    </td>
                    <td>
                      {probe.isBus ? (
                        <select
                          className={`probe-format-select ${formats[probeKey(probe)] ? "chosen" : ""}`}
                          value={formats[probeKey(probe)] ?? "unsigned"}
                          disabled={!!formatsLocked}
                          title={formatsLocked || FORMAT_HINT}
                          onChange={(e) => onSetFormat([probeKey(probe)], e.target.value as ProbeFormat)}
                        >
                          {PROBE_FORMATS.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="probe-format-bit" title="A 1-bit probe is written as 0 or 1">
                          0 / 1
                        </span>
                      )}
                    </td>
                    {coreColumn && (
                      <td>
                        <span className="core-label" title={probe.core}>
                          {probe.core.split("/").pop()}
                        </span>
                      </td>
                    )}
                    <td style={{ textAlign: "right" }}>
                      <button
                        className={`btn-action-trigger ${isTriggerTarget ? "active" : ""}`}
                        onClick={() => (isTriggerTarget ? onClearTrigger() : onSelectTriggerProbe(probe))}
                        title={
                          isTriggerTarget
                            ? "This probe is the trigger. Click to remove the trigger."
                            : "Select this probe to build a trigger rule"
                        }
                      >
                        {isTriggerTarget ? (
                          <>
                            <Check size={13} />
                            <span>Active Trigger</span>
                            <X size={12} className="trigger-remove-x" />
                          </>
                        ) : (
                          <>
                            <ArrowUpRight size={13} />
                            <span>Set Trigger</span>
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
