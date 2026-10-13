// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React from "react";
import { CaptureConfig, HwSession } from "../types";
import { Square, Zap, Crosshair, Infinity as InfinityIcon, FolderOpen, Plug, Unplug, Rocket } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

interface CaptureControlBarProps {
  config: CaptureConfig;
  onChangeConfig: (cfg: Partial<CaptureConfig>) => void;
  onExecuteCapture: () => void;
  onStopCapture: () => void;
  isCapturing: boolean;
  isStopping?: boolean;
  /** what the stop button ends: a capture, or connecting */
  stopLabel?: string;
  onLoadExistingCsv: (path: string) => void;
  /** the file dialog could not be opened: the sentence for the status line (a release build has no console) */
  onError: (text: string) => void;
  /** the Vivado hardware session that is kept open between jobs */
  session: HwSession;
  /** a job is running, or the session is being closed: the connection button waits */
  sessionBusy: boolean;
  onToggleConnection: () => void;
  /** "Twin Turbo": the session is to run two Vivado engines instead of one */
  twinTurbo: boolean;
  onToggleTwinTurbo: (on: boolean) => void;
  /** the session is being closed: nothing can be started for that moment */
  captureDisabled?: boolean;
}

const TWIN_TURBO_HINT =
  "Twin Turbo: two Vivado engines instead of one.\n" +
  "In a constant capture one engine writes its file while the other is already capturing the next window: " +
  "about a third more windows per minute with CSV, almost twice as many with CSV + .ila.\n" +
  "Connecting takes a few seconds longer. Changed while connected, it takes effect with the next capture.";

export const CaptureControlBar: React.FC<CaptureControlBarProps> = ({
  config,
  onChangeConfig,
  onExecuteCapture,
  onStopCapture,
  isCapturing,
  isStopping,
  stopLabel,
  onLoadExistingCsv,
  onError,
  session,
  sessionBusy,
  onToggleConnection,
  twinTurbo,
  onToggleTwinTurbo,
  captureDisabled,
}) => {
  const handleBrowseExistingCsv = async () => {
    try {
      const selected = await open({
        multiple: false,
        // "gz" for .csv.gz, as "Import" offers it: a recording made from the command line is gzipped
        filters: [{ name: "ILA Capture", extensions: ["csv", "gz", "ila"] }],
      });
      if (selected && typeof selected === "string") {
        onLoadExistingCsv(selected);
      }
    } catch (e) {
      onError(`Could not open the file dialog: ${e}`);
    }
  };

  return (
    <div className="capture-control-bar">
      <div className="control-bar-left">
        <div className="capture-name-input-box">
          <label htmlFor="cap-name">Capture Name:</label>
          <input
            id="cap-name"
            type="text"
            className="text-input small"
            value={config.captureName}
            onChange={(e) => onChangeConfig({ captureName: e.target.value })}
            placeholder="cap_test"
          />
        </div>

        <button
          className="btn btn-secondary btn-small"
          onClick={handleBrowseExistingCsv}
          title="Open an existing .csv, .csv.gz or .ila file from disk"
        >
          <FolderOpen size={14} />
          <span>Open File</span>
        </button>
      </div>

      <div className="control-bar-center">
        {isCapturing ? (
          <button className="btn btn-danger btn-large" onClick={onStopCapture} disabled={isStopping}>
            <Square size={16} />
            <span>{isStopping ? "Stopping..." : stopLabel || "Stop Capture"}</span>
          </button>
        ) : (
          <button className="btn btn-primary btn-large" onClick={onExecuteCapture} disabled={captureDisabled}>
            {config.mode === "just_capture" && (
              <>
                <Zap size={18} />
                <span>Just Capture (Now)</span>
              </>
            )}
            {config.mode === "trigger_rule" && (
              <>
                <Crosshair size={18} />
                <span>Arm & Capture on Trigger</span>
              </>
            )}
            {config.mode === "constant_capture" && (
              <>
                <InfinityIcon size={18} />
                <span>Start Constant Capture</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* The hardware session. It opens with the first job (or this button) and then stays open, so that the
          next capture starts at once; it closes only here, or with the application. */}
      <div className="control-bar-right">
        {session.connected && (
          <span
            className="hw-session-info"
            title={`Vivado is connected to ${session.server || "the hw_server"} and stays connected until you disconnect`}
          >
            {[
              session.device,
              session.tckHz ? `TCK ${session.tckHz / 1e6} MHz` : "",
              (session.engines || 1) > 1 ? `${session.engines}× Vivado` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
        <label className={`twin-turbo ${twinTurbo ? "on" : ""} ${sessionBusy ? "busy" : ""}`} title={TWIN_TURBO_HINT}>
          <input
            type="checkbox"
            checked={twinTurbo}
            disabled={sessionBusy}
            onChange={(e) => onToggleTwinTurbo(e.target.checked)}
          />
          <Rocket size={13} />
          <span>Twin Turbo</span>
        </label>
        <button
          className={`btn btn-small hw-session-btn ${session.connected ? "connected" : "btn-secondary"}`}
          onClick={onToggleConnection}
          disabled={sessionBusy}
          title={
            session.connected
              ? "Close the hardware session: Vivado exits and the cable gets its JTAG clock back"
              : "Open the hardware session now and keep it open. Captures then start at once instead of after Vivado's start-up; it stays open until you click here again"
          }
        >
          <i className={`hw-session-dot ${session.connected ? "on" : ""}`} />
          {session.connected ? <Unplug size={14} /> : <Plug size={14} />}
          <span>{session.connected ? "Disconnect" : "Connect"}</span>
        </button>
      </div>
    </div>
  );
};
