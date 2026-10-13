// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

// Crash reports, the side of the page. The page sends nothing itself (it cannot: see the content security policy
// in src-tauri/tauri.conf.json): it hands an error to the backend, which decides, scrubs and sends
// (src-tauri/src/crash_reports.rs). Reports are off until the user switches them on in the header.

/** "on" while the user wants crash reports; absent otherwise. Both windows of the app share the storage. */
const STORAGE_KEY = "ila-studio-crash-reports";
/** The most errors a window hands over by itself: one that comes back with every frame must not flood the backend
 *  (which keeps the same limit for the whole run). */
const MAX_HANDED = 20;
/** Longer texts are cut before they cross to the backend, which cuts again to what a report carries. */
const MAX_MESSAGE = 4000;
const MAX_STACK = 20000;

export interface CrashReportsState {
  /** this build has an address to send reports to */
  available: boolean;
  /** the user has switched crash reports on */
  enabled: boolean;
  /** the host reports go to, to be shown */
  server: string | null;
  /** that host was named with ILA_SENTRY_DSN when the program was started: it is not the developers' */
  ownServer: boolean;
}

export type ErrorSource = "error" | "unhandledrejection" | "render";
export type WindowName = "main" | "analysis";
/** What became of an error: the answer of the backend, or "failed" when the backend could not be asked. */
export type ReportOutcome = "sent" | "off" | "unavailable" | "duplicate" | "limit" | "failed";

const NOT_AVAILABLE: CrashReportsState = { available: false, enabled: false, server: null, ownServer: false };

let state = NOT_AVAILABLE;
let started = false;
let windowName: WindowName = "main";
const handed = new Set<string>();
const listeners = new Set<() => void>();
/** The errors of the first moments of a window, kept until the backend has said whether reports are on (null from
 *  then on): an error at start is the one a report is wanted of most. */
let early: [unknown, ErrorSource][] | null = [];

function set(next: CrashReportsState) {
  const same = (Object.keys(next) as (keyof CrashReportsState)[]).every((key) => next[key] === state[key]);
  if (same) return;
  state = next;
  listeners.forEach((cb) => cb());
}

/** Does the storage say "on"? null when it cannot be read (a locked-down webview). */
function stored(): boolean | null {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return null;
  }
}

/**
 * Takes over what the backend says. Its switch is the one that counts during a run; the storage only remembers
 * the choice for the next one. So at the start of a window (`push`) a stored "on" is handed to the backend, which
 * starts every run switched off - and never an "off": the backend is only on because a window of this run said so.
 */
async function refresh(push: boolean) {
  try {
    let answer = await invoke<CrashReportsState>("crash_reports_state");
    if (push && answer.available && !answer.enabled && stored() === true) {
      await invoke("set_crash_reports", { enabled: true });
      answer = { ...answer, enabled: true };
    }
    set({
      available: answer.available === true,
      enabled: answer.available === true && answer.enabled === true,
      server: typeof answer.server === "string" ? answer.server : null,
      ownServer: answer.ownServer === true,
    });
  } catch {
    // no backend to ask (the page opened in a browser): crash reports stay unavailable
  }
}

/** The text of whatever was thrown, and its stack if it has one. Anything can be thrown, not only an Error. */
export function describeError(value: unknown): { message: string; stack?: string } {
  if (typeof value === "string") return { message: value };
  if (value !== null && typeof value === "object") {
    const { message, name, stack } = value as { message?: unknown; name?: unknown; stack?: unknown };
    if (typeof message === "string") {
      const text = message || (typeof name === "string" ? name : "");
      return { message: text || "an error without a message", stack: typeof stack === "string" ? stack : undefined };
    }
  }
  try {
    return { message: String(value) };
  } catch {
    return { message: "an error that cannot be shown as text" }; // an object without toString
  }
}

/** Notices of the browser that arrive as errors and are none: a layout that needed one more pass. */
export function isBenign(message: string): boolean {
  return message.includes("ResizeObserver loop");
}

/**
 * Hands an error to the backend. Without `once` only while crash reports are switched on; `once` is the button
 * "Send this error report" of the error screen, which sends that one report although they are off.
 */
export async function reportError(
  error: unknown,
  source: ErrorSource,
  more: { componentStack?: string; once?: boolean } = {},
): Promise<ReportOutcome> {
  if (!state.available) return "unavailable";
  if (!more.once && !state.enabled) return "off";
  const { message, stack } = describeError(error);
  try {
    return await invoke<ReportOutcome>("report_frontend_error", {
      report: {
        message: message.slice(0, MAX_MESSAGE),
        stack: stack?.slice(0, MAX_STACK),
        componentStack: more.componentStack?.slice(0, MAX_STACK),
        source,
        window: windowName,
        once: more.once === true ? true : undefined,
      },
    });
  } catch {
    return "failed";
  }
}

/** An error nobody caught: reported if crash reports are on, each message once and MAX_HANDED of them at most. */
function uncaught(error: unknown, source: ErrorSource) {
  if (early) {
    if (early.length < 5) early.push([error, source]);
    return;
  }
  if (!state.enabled) return;
  const { message } = describeError(error);
  if (isBenign(message) || handed.has(message) || handed.size >= MAX_HANDED) return;
  handed.add(message);
  void reportError(error, source);
}

/**
 * Call once when a window starts, before the first render: from then on its uncaught errors and unhandled
 * rejections are reported - while crash reports are switched on, which they are not until the user does that.
 */
export function startCrashReports(name: WindowName): void {
  if (started) return;
  started = true;
  windowName = name;
  window.addEventListener("error", (event) => {
    const { error, message, filename, lineno, colno } = event as ErrorEvent;
    // an image that failed to load is an "error" event as well, without an error and without a message
    if (error == null && !message) return;
    // a script error without its object still says where it happened: one frame, in the form of a stack
    uncaught(error ?? { message, stack: filename ? `    at ${filename}:${lineno}:${colno}` : undefined }, "error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    uncaught((event as PromiseRejectionEvent).reason, "unhandledrejection");
  });
  // The other window of the app (main / pop-out analysis) shares the switch: when it is turned there, the
  // storage changes and that arrives here. Asked again when this window gets the focus, should that be missed.
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) void refresh(false);
  });
  window.addEventListener("focus", () => void refresh(false));
  void refresh(true).then(() => {
    const kept = early ?? [];
    early = null;
    kept.forEach(([error, source]) => uncaught(error, source));
  });
}

/** The switch in the header. The backend is told first: if it cannot be, nothing is stored and nothing changes. */
export async function setCrashReports(on: boolean): Promise<void> {
  if (!state.available) return;
  await invoke("set_crash_reports", { enabled: on });
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "on");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // the choice then lasts for this run only
  }
  set({ ...state, enabled: on });
}

/** Sends one test report; resolves to the id it has on the report server, rejects with a sentence to show. */
export function sendTestReport(): Promise<string> {
  return invoke<string>("send_test_crash_report");
}

export function getCrashReports(): CrashReportsState {
  return state;
}

export function subscribeCrashReports(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useCrashReports(): CrashReportsState {
  return useSyncExternalStore(subscribeCrashReports, getCrashReports);
}
