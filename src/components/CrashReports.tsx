// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useEffect, useRef, useState } from "react";
import { Bug } from "lucide-react";
import { sendTestReport, setCrashReports, useCrashReports } from "../crashReports";

type TestResult = { state: "sending" } | { state: "sent"; id: string } | { state: "failed"; why: string };

/**
 * The switch for crash reports, in the header: a button that opens a small panel with the checkbox, what a report
 * holds, and a test. Off until the user ticks the box; a build without a report address says so and cannot be
 * switched on.
 */
export const CrashReports: React.FC = () => {
  const { available, enabled, server, ownServer, unencrypted } = useCrashReports();
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  // closes on a click elsewhere and on Escape, as the Import menu does
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        e.stopPropagation();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const sendTest = async () => {
    setTest({ state: "sending" });
    try {
      setTest({ state: "sent", id: await sendTestReport() });
    } catch (e) {
      setTest({ state: "failed", why: String(e) });
    }
  };

  return (
    <span className="crash-reports" ref={rootRef}>
      <button
        className={`btn btn-outline crash-reports-btn ${open ? "on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Crash reports"
        aria-label="Crash reports"
        aria-expanded={open}
      >
        <Bug size={16} />
      </button>
      {open && (
        <div className="crash-reports-panel">
          <label className="crash-reports-switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!available}
              onChange={(e) => {
                setTest(null);
                setCrashReports(e.target.checked).catch(console.error);
              }}
            />
            <span>Send crash reports</span>
          </label>
          {!available && <p className="crash-reports-missing">This build has no address to send reports to.</p>}
          <p>
            A report is sent when the program runs into an error. It holds the error text and where in the program
            it happened, the version of the program and the version of Windows. It never holds captures, profiles,
            the log or the probe file.
          </p>
          <p>
            The names of user folders, the server of a network path and IPv4 addresses are taken out of the text
            where they stand in their usual notation. Other names are not recognised: an error text can hold the
            name of a probe, a file or a host. That is why this is off until you switch it on.
          </p>
          {server && (
            <p>
              {ownServer
                ? "Reports go to the server named in ILA_SENTRY_DSN: "
                : "Reports go to the Sentry project of the developers: "}
              <span className="crash-reports-server">{server}</span>. Your choice is remembered for this address
              only.
            </p>
          )}
          {/* not said of an address on this PC (127.0.0.1): what is sent there crosses no network */}
          {unencrypted && (
            <p className="crash-reports-missing">
              This address begins with http://: reports are sent to it without encryption.
            </p>
          )}
          <div className="crash-reports-test">
            <button
              className="btn btn-secondary btn-small"
              disabled={!enabled || test?.state === "sending"}
              onClick={() => void sendTest()}
              title="Sends one report that says only 'ILA Studio test report', to check that reports arrive"
            >
              Send a test report
            </button>
            {test?.state === "sending" && <span>Sending...</span>}
            {test?.state === "sent" && (
              <span>
                Arrived. Its id: <span className="crash-reports-id">{test.id}</span>
              </span>
            )}
            {test?.state === "failed" && <span className="crash-reports-failed">{test.why}</span>}
          </div>
        </div>
      )}
    </span>
  );
};
