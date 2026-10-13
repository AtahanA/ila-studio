// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { AnalysisWindow } from "./components/AnalysisWindow";
import { initTheme } from "./theme";
import {
  getCrashReports,
  reportError,
  ReportOutcome,
  startCrashReports,
  subscribeCrashReports,
} from "./crashReports";
import "./App.css";

initTheme(); // before the first paint

// The same bundle serves both windows; the window's label says which one this is.
const standaloneAnalysis = (() => {
  try {
    return getCurrentWindow().label === "analysis";
  } catch {
    return false;
  }
})();

// From here on an error of this window that nobody catches is reported - if the user has switched crash reports
// on (the bug button in the header of the main window). Until then nothing is.
startCrashReports(standaloneAnalysis ? "analysis" : "main");

/** What the button "Send this error report" says once it was pressed. */
function reportNote(report: ReportOutcome | "sending"): string {
  if (report === "sending") return "Sending...";
  if (report === "sent") return "Report sent";
  if (report === "duplicate") return "Already reported in this run";
  if (report === "limit") return "Not sent: too many reports in this run";
  return "The report could not be sent";
}

interface ErrorBoundaryState {
  error: Error | null;
  components: string;
  /** what became of the crash report of this error; null while none was asked for */
  report: ReportOutcome | "sending" | null;
}

/**
 * An error while rendering takes the whole page down, and a release build has no console to look into: the window
 * would simply be empty. Instead it says what happened, as text that can be copied into a report, and offers to
 * load the page again. With crash reports switched on the error is reported as well; switched off (in a build that
 * has an address to report to), a button offers to send this one error.
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, components: "", report: null };
  /**
   * The error this boundary is showing, for the crash report. Not read from the state: React also writes an error
   * into the state for a render it then throws away and repeats without one, and what is asked outside of a
   * render (when the switch is turned, below) would find that error still there.
   */
  private caught: { error: unknown; components: string } | null = null;
  private asked = false;
  private unsubscribe = () => {};

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidMount() {
    // whether crash reports are on is known a moment after the start: an error of the first render waits for it
    this.unsubscribe = subscribeCrashReports(() => {
      this.reportIfOn();
      this.forceUpdate();
    });
  }

  componentWillUnmount() {
    this.unsubscribe();
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    const components = info.componentStack ?? "";
    this.caught = { error, components };
    this.setState({ components });
    this.reportIfOn();
  }

  private reportIfOn() {
    if (getCrashReports().enabled) this.report(false);
  }

  /** `once`: the button was pressed - this one error is sent although crash reports are switched off. */
  private report(once: boolean) {
    if (!this.caught || this.asked) return;
    this.asked = true;
    const { error, components } = this.caught;
    this.setState({ report: "sending" });
    void reportError(error, "render", { componentStack: components, once }).then((report) => this.setState({ report }));
  }

  render() {
    const { error, components, report } = this.state;
    if (!error) return this.props.children;
    const { available, enabled } = getCrashReports();
    return (
      <div className="error-boundary" role="alert">
        <h2>ILA Studio ran into an error and cannot show this window.</h2>
        <p>
          "Reload" loads the page again. If the error comes back, please report it with the text below - and with
          ila_log.txt from the folder of the program, if a capture or the hardware was involved (the log names local
          paths, the hw_server address and probe names: read it through before you pass it on).
        </p>
        <pre className="error-boundary-details">
          {String(error.stack || error)}
          {components ? `\n\nComponents:${components}` : ""}
        </pre>
        <div className="error-boundary-actions">
          <button className="btn btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
          {available && !enabled && (
            <button
              className="btn btn-secondary"
              disabled={report !== null}
              onClick={() => this.report(true)}
              title="Sends this one error to the report server, although crash reports are switched off: the text above with user folders and addresses taken out, the version of the program and of Windows"
            >
              {report === null ? "Send this error report" : reportNote(report)}
            </button>
          )}
          {available && enabled && report === "sent" && <span>A crash report of this error is being sent.</span>}
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>{standaloneAnalysis ? <AnalysisWindow /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
