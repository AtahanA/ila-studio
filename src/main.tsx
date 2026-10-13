// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { AnalysisWindow } from "./components/AnalysisWindow";
import { initTheme } from "./theme";
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

/**
 * An error while rendering takes the whole page down, and a release build has no console to look into: the window
 * would simply be empty. Instead it says what happened, as text that can be copied into a report, and offers to
 * load the page again.
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null; components: string }> {
  state = { error: null as Error | null, components: "" };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(_error: unknown, info: React.ErrorInfo) {
    this.setState({ components: info.componentStack ?? "" });
  }

  render() {
    const { error, components } = this.state;
    if (!error) return this.props.children;
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
        <button className="btn btn-primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>{standaloneAnalysis ? <AnalysisWindow /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
