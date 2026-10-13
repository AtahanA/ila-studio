// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React from "react";
import { ProfileInfo } from "../types";
import { setTheme, useTheme } from "../theme";
import { Layers, FileText, Moon, Save, Sun } from "lucide-react";
import appIcon from "../assets/app-icon.svg";

interface HeaderProps {
  profiles: ProfileInfo[];
  selectedProfile: string;
  onSelectProfile: (path: string) => void;
  /** opens "Save configuration": the page as it stands becomes a profile of this list */
  onSaveProfile: () => void;
  onLoadDemo: () => void;
  onOpenLog: () => void;
  isCapturing: boolean;
  statusText: string;
  hasError?: boolean;
  hasLog?: boolean;
  onShowLogDetails?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  profiles,
  selectedProfile,
  onSelectProfile,
  onSaveProfile,
  onLoadDemo,
  onOpenLog,
  isCapturing,
  statusText,
  hasError,
  hasLog,
  onShowLogDetails,
}) => {
  const theme = useTheme();
  const otherTheme = theme === "dark" ? "light" : "dark";
  return (
    <header className="app-header">
      <div className="header-brand">
        <img className="brand-icon" src={appIcon} alt="" width={38} height={38} draggable={false} />
        <div className="brand-text">
          <h1>ILA Studio</h1>
          <span className="brand-tag">Logic Analyzer Capture & Signal Analysis</span>
        </div>
      </div>

      <div className="header-middle">
        <div className="profile-selector">
          <label htmlFor="profile-select">Profile:</label>
          <select
            id="profile-select"
            value={selectedProfile}
            onChange={(e) => onSelectProfile(e.target.value)}
          >
            <option value="">-- Custom Configuration --</option>
            {profiles.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name} ({p.filename})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-outline profile-save"
            onClick={onSaveProfile}
            title="Save configuration: the settings of the capture tab (hardware, trigger, capture) become a profile under a name of your choice, to be selected here again"
          >
            <Save size={14} />
            <span>Save</span>
          </button>
        </div>

        <div className={`system-status ${hasError ? "has-error" : ""}`}>
          <span className={`status-indicator ${isCapturing ? "busy" : hasError ? "error" : "ready"}`} />
          <span className="status-label" title={statusText}>
            {statusText || (isCapturing ? "Working..." : "System Ready")}
          </span>
          {hasLog && onShowLogDetails && (
            <button className="btn-link-details" onClick={onShowLogDetails} title="View Vivado log / session output">
              {hasError ? "View Error Log" : "View Output"}
            </button>
          )}
        </div>
      </div>

      <div className="header-actions">
        {/* shows the theme it switches to; the pop-out analysis window follows (see theme.ts) */}
        <button
          className="btn btn-outline theme-toggle"
          onClick={() => setTheme(otherTheme)}
          title={`Switch to the ${otherTheme} theme`}
          aria-label={`Switch to the ${otherTheme} theme`}
        >
          {otherTheme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
        </button>

        <button
          className="btn btn-outline"
          onClick={onOpenLog}
          title="Open ila_log.txt in Notepad to inspect real-time Vivado execution & debug errors"
        >
          <FileText size={16} />
          <span>View Log (.txt)</span>
        </button>

        <button
          className="btn btn-outline"
          onClick={onLoadDemo}
          title="Load simulated ILA waveform for testing without hardware"
        >
          <Layers size={16} />
          <span>Demo Data</span>
        </button>
      </div>
    </header>
  );
};
