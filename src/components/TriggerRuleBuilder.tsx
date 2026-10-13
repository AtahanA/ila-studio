// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React from "react";
import {
  CaptureConfig,
  CaptureMode,
  IlaProbe,
  TriggerOperator1Bit,
  TriggerOperatorMultiBit,
} from "../types";
import { probeKey, ruleTrigger } from "../trigger";
import {
  Zap,
  Clock,
  Sliders,
  Terminal,
  Infinity as InfinityIcon,
  Crosshair,
  Settings,
  Trash2,
} from "lucide-react";

interface TriggerRuleBuilderProps {
  config: CaptureConfig;
  onChangeConfig: (cfg: Partial<CaptureConfig>) => void;
  availableProbes: IlaProbe[];
  /** last valid trigger position: buffer depth - 1 once the hardware has reported it */
  maxPosition: number;
}

/** the value the probe list shows for a rule whose probe is not among its entries */
const STALE_RULE = "<rule not in the list>";

export const TriggerRuleBuilder: React.FC<TriggerRuleBuilderProps> = ({
  config,
  onChangeConfig,
  availableProbes,
  maxPosition,
}) => {
  const setPosition = (raw: number) =>
    onChangeConfig({ position: Math.max(0, Math.min(maxPosition, Math.round(raw) || 0)) });

  // Compute Vivado Trigger Expression string
  const computeVivadoTriggerStr = (): string => {
    if (config.mode === "just_capture") {
      return "now";
    }

    if (config.customTriggerStr && config.customTriggerStr.trim()) {
      return config.customTriggerStr.trim();
    }

    if (!config.activeRule || !config.activeRule.probeName) {
      // a constant capture without a rule takes window after window at once; "on rule" has nothing to wait for yet
      return config.mode === "constant_capture" ? "now" : "";
    }

    // the same function that builds what is sent, so the preview cannot differ from it
    try {
      return ruleTrigger(config.activeRule, config.activeRule.probeName);
    } catch (e) {
      return `invalid: ${e instanceof Error ? e.message : e}`;
    }
  };

  const vivadoTriggerPreview = computeVivadoTriggerStr();

  const handleModeChange = (mode: CaptureMode) => {
    onChangeConfig({ mode });
  };

  // probes are told apart by their hierarchical name: two of them may share a leaf name
  const selectedKey =
    config.activeRule?.probeFullName ||
    (config.activeRule ? availableProbes.filter((p) => p.name === config.activeRule?.probeName).map(probeKey)[0] : "") ||
    "";

  const ruleInList = availableProbes.some((p) => probeKey(p) === selectedKey);

  const handleProbeSelect = (key: string) => {
    const probe = availableProbes.find((p) => probeKey(p) === key);
    if (!probe) {
      // the empty entry of the list: no trigger probe, which takes the rule away
      if (key === "" && config.activeRule) onChangeConfig({ activeRule: null });
      return;
    }

    onChangeConfig({
      activeRule: {
        probeName: probe.name,
        probeFullName: probeKey(probe),
        isBus: probe.isBus,
        width: probe.width,
        op1Bit: probe.isBus ? undefined : "R",
        opMultiBit: probe.isBus ? "hex" : undefined,
        value: probe.isBus ? "0" : undefined,
      },
    });
  };

  const handle1BitOpChange = (op: TriggerOperator1Bit) => {
    if (!config.activeRule) return;
    onChangeConfig({
      activeRule: {
        ...config.activeRule,
        op1Bit: op,
      },
    });
  };

  const handleMultiBitOpChange = (op: TriggerOperatorMultiBit) => {
    if (!config.activeRule) return;
    onChangeConfig({
      activeRule: {
        ...config.activeRule,
        opMultiBit: op,
      },
    });
  };

  const handleValueChange = (value: string) => {
    if (!config.activeRule) return;
    onChangeConfig({
      activeRule: {
        ...config.activeRule,
        value,
      },
    });
  };

  return (
    <div className="card trigger-card">
      <div className="card-header">
        <div className="card-title">
          <Crosshair size={18} className="text-accent" />
          <h3>Trigger Rules & Capture Mode</h3>
        </div>
        <span className="badge-chip">FPGA Trigger Engine</span>
      </div>

      <div className="card-body">
        {/* Mode Selector Tabs */}
        <div className="mode-selector">
          <button
            className={`mode-btn ${config.mode === "just_capture" ? "active" : ""}`}
            onClick={() => handleModeChange("just_capture")}
          >
            <Zap size={16} />
            <div className="mode-btn-content">
              <span className="mode-title">Just Capture</span>
              <span className="mode-desc">Immediate buffer dump (now)</span>
            </div>
          </button>

          <button
            className={`mode-btn ${config.mode === "trigger_rule" ? "active" : ""}`}
            onClick={() => handleModeChange("trigger_rule")}
          >
            <Crosshair size={16} />
            <div className="mode-btn-content">
              <span className="mode-title">Capture on Rule</span>
              <span className="mode-desc">Arm and wait for event condition</span>
            </div>
          </button>

          <button
            className={`mode-btn ${config.mode === "constant_capture" ? "active" : ""}`}
            onClick={() => handleModeChange("constant_capture")}
          >
            <InfinityIcon size={16} />
            <div className="mode-btn-content">
              <span className="mode-title">Constant Capture</span>
              <span className="mode-desc">Window after window until stopped</span>
            </div>
          </button>
        </div>

        {/* Condition Builder (Visible for trigger_rule and constant_capture) */}
        {config.mode !== "just_capture" && (
          <div className="rule-config-panel">
            <div className="rule-config-grid">
              {/* Select Target Probe */}
              <div className="form-group">
                <label className="form-label">
                  <Sliders size={14} />
                  <span>Select Trigger Probe</span>
                </label>
                <div className="input-with-actions">
                  <select
                    className="select-input trigger-probe-select"
                    value={ruleInList ? selectedKey : config.activeRule ? STALE_RULE : ""}
                    onChange={(e) => handleProbeSelect(e.target.value)}
                  >
                    <option value="">-- No trigger probe --</option>
                    {/* A rule whose probe is not in the list (another probe file was read since) is still the
                        trigger: it is shown as that, under a value of its own, so that the empty entry above is a
                        change - which takes the rule away - and not what the list already shows. */}
                    {config.activeRule && !ruleInList && (
                      <option value={STALE_RULE} disabled>
                        {config.activeRule.probeName} (not in the probe list)
                      </option>
                    )}
                    {availableProbes.map((p) => (
                      <option key={p.fullName} value={probeKey(p)} title={p.fullName}>
                        {p.name} {p.width > 1 ? `[${p.width - 1}:0]` : "(1-bit)"}
                      </option>
                    ))}
                  </select>
                  {config.activeRule && (
                    <button
                      className="btn btn-secondary trigger-remove-btn"
                      onClick={() => onChangeConfig({ activeRule: null })}
                      title={`Remove the trigger on ${config.activeRule.probeName}`}
                    >
                      <Trash2 size={14} />
                      <span>Remove</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Operator & Condition */}
              {config.activeRule && (
                <>
                  {!config.activeRule.isBus ? (
                    /* 1-Bit Probes */
                    <div className="form-group">
                      <label className="form-label">
                        <span>Trigger Transition / State</span>
                      </label>
                      <div className="btn-group-segmented">
                        <button
                          className={`btn-seg ${config.activeRule.op1Bit === "R" ? "active" : ""}`}
                          onClick={() => handle1BitOpChange("R")}
                          title="Rising Edge: 0 -> 1 transition"
                        >
                          Rising Edge (R)
                        </button>
                        <button
                          className={`btn-seg ${config.activeRule.op1Bit === "F" ? "active" : ""}`}
                          onClick={() => handle1BitOpChange("F")}
                          title="Falling Edge: 1 -> 0 transition"
                        >
                          Falling Edge (F)
                        </button>
                        <button
                          className={`btn-seg ${config.activeRule.op1Bit === "1" ? "active" : ""}`}
                          onClick={() => handle1BitOpChange("1")}
                          title="High Level: == 1"
                        >
                          High (1)
                        </button>
                        <button
                          className={`btn-seg ${config.activeRule.op1Bit === "0" ? "active" : ""}`}
                          onClick={() => handle1BitOpChange("0")}
                          title="Low Level: == 0"
                        >
                          Low (0)
                        </button>
                        <button
                          className={`btn-seg ${config.activeRule.op1Bit === "B" ? "active" : ""}`}
                          onClick={() => handle1BitOpChange("B")}
                          title="Either Edge: any transition"
                        >
                          Either (B)
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Multi-Bit Probes */
                    <>
                      <div className="form-group">
                        <label className="form-label">
                          <span>Value Format</span>
                        </label>
                        <div className="btn-group-segmented">
                          <button
                            className={`btn-seg ${config.activeRule.opMultiBit === "hex" ? "active" : ""}`}
                            onClick={() => handleMultiBitOpChange("hex")}
                          >
                            Hex (h)
                          </button>
                          <button
                            className={`btn-seg ${config.activeRule.opMultiBit === "dec" ? "active" : ""}`}
                            onClick={() => handleMultiBitOpChange("dec")}
                          >
                            Dec (d)
                          </button>
                          <button
                            className={`btn-seg ${config.activeRule.opMultiBit === "bin" ? "active" : ""}`}
                            onClick={() => handleMultiBitOpChange("bin")}
                          >
                            Bin (b)
                          </button>
                        </div>
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          <span>Match Value</span>
                        </label>
                        <input
                          type="text"
                          className="text-input"
                          placeholder={
                            config.activeRule.opMultiBit === "hex"
                              ? "e.g. 3F or DEAD"
                              : config.activeRule.opMultiBit === "dec"
                              ? "e.g. 100"
                              : "e.g. 1010"
                          }
                          value={config.activeRule.value || ""}
                          onChange={(e) => handleValueChange(e.target.value)}
                        />
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* A hand-written condition (also where a profile's trigger shows up); it wins over the rule above */}
            <div className="form-group full-width">
              <label className="form-label">
                <Terminal size={14} />
                <span>Custom trigger expression (optional, overrides the rule)</span>
              </label>
              <input
                type="text"
                className="text-input"
                placeholder={`<probe> <compare-value>, e.g. my_valid eq1'bR or state eq4'h3`}
                value={config.customTriggerStr}
                onChange={(e) => onChangeConfig({ customTriggerStr: e.target.value })}
              />
            </div>
          </div>
        )}

        {/* Capture Buffer Parameters: Position, Timeout, Format */}
        <div className="capture-params-grid">
          <div className="form-group">
            <label className="form-label">
              <Clock size={14} />
              <span>Pre-Trigger Position (Samples)</span>
            </label>
            <div className="slider-with-number">
              <input
                type="range"
                min="0"
                max={maxPosition}
                step="1"
                value={Math.min(config.position, maxPosition)}
                onChange={(e) => setPosition(Number(e.target.value))}
                className="range-slider"
              />
              <input
                type="number"
                className="number-input"
                min={0}
                max={maxPosition}
                value={config.position}
                onChange={(e) => setPosition(Number(e.target.value))}
              />
            </div>
            <span className="form-hint">Number of buffer samples preserved prior to the trigger</span>
          </div>

          <div className="form-group">
            <label className="form-label">
              <Clock size={14} />
              <span>Timeout (Minutes)</span>
            </label>
            <input
              type="number"
              min="0.1"
              max="720"
              step="any"
              className="text-input"
              value={config.timeoutMin}
              onChange={(e) => onChangeConfig({ timeoutMin: Number(e.target.value) })}
            />
            <span className="form-hint">Wait time before timing out if trigger doesn't fire</span>
          </div>

          <div className="form-group">
            <label className="form-label">
              <Settings size={14} />
              <span>Export Format</span>
            </label>
            <select
              className="select-input"
              value={config.format}
              onChange={(e) => onChangeConfig({ format: e.target.value as CaptureConfig["format"] })}
            >
              <option value="csv">CSV (fastest)</option>
              <option value="both">Both (.csv + .ila)</option>
              <option value="ila">ILA archive only (.ila)</option>
            </select>
            <span className="form-hint">The viewer and the Signal Analysis read the CSV</span>
          </div>
        </div>

        {/* Vivado Trigger Preview Terminal */}
        <div className="syntax-preview">
          <div className="syntax-header">
            <Terminal size={14} />
            <span>Vivado ILA Trigger Expression Preview</span>
          </div>
          <div className="syntax-code">
            <code>
              {config.mode === "just_capture"
                ? "trigger: \"now\" (run_hw_ila -trigger_now)"
                : vivadoTriggerPreview === ""
                ? "no trigger yet: choose a trigger probe, or switch to Just Capture"
                : `trigger: "${vivadoTriggerPreview}" | position: ${config.position} | timeout: ${config.timeoutMin}m`}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
};
