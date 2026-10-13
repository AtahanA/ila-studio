// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

// Crash reports, the side of the page. The page sends nothing itself (it cannot: see the content security policy
// in src-tauri/tauri.conf.json): it hands an error to the backend, which decides, scrubs and sends
// (src-tauri/src/crash_reports.rs). Reports are off until the user switches them on in the header.

/** "on <address>" while the user wants crash reports sent to that address (see consentFor); absent otherwise.
 *  Both windows of the app share the storage, and so does every running copy of the program. */
const STORAGE_KEY = "ila-studio-crash-reports";
/** The most errors a window hands over by itself: one that comes back with every frame must not flood the backend
 *  (which keeps the same limit for the whole run). */
const MAX_HANDED = 20;
/** Longer texts are cut before they cross to the backend. Generously: the backend cuts to what a report carries
 *  (2,000 characters) after it has taken names and addresses out, and a path that is cut here is no longer
 *  recognised there. */
const MAX_MESSAGE = 8000;
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
  /** the address reports go to, without its key (scheme://host:port/project): what the choice is stored with */
  destination: string | null;
  /** reports to it are not encrypted on their way: it begins with http:// and is not on this PC */
  unencrypted: boolean;
}

export type ErrorSource = "error" | "unhandledrejection" | "render";
export type WindowName = "main" | "analysis";
/** What became of an error: the answer of the backend, or "failed" when the backend could not be asked. */
export type ReportOutcome = "sent" | "off" | "unavailable" | "duplicate" | "limit" | "failed";

const NOT_AVAILABLE: CrashReportsState = {
  available: false,
  enabled: false,
  server: null,
  ownServer: false,
  destination: null,
  unencrypted: false,
};

let state = NOT_AVAILABLE;
let started = false;
let windowName: WindowName = "main";
const handed = new Set<string>();
const listeners = new Set<() => void>();
/** The errors of the first moments of a window, kept until the backend has said whether reports are on (null from
 *  then on): an error at start is the one a report is wanted of most. */
let early: [unknown, ErrorSource][] | null = [];
/** The storage said "on" for the address of this run when this window last looked: see follow(). */
let storedOn = false;

function set(next: CrashReportsState) {
  const same = (Object.keys(next) as (keyof CrashReportsState)[]).every((key) => next[key] === state[key]);
  if (same) return;
  state = next;
  listeners.forEach((cb) => cb());
}

/**
 * Is what the storage holds the user's "on" for the address reports go to now? The choice is stored together
 * with the address it was made for, and holds for no other: a program that is later started with another
 * ILA_SENTRY_DSN - or with none, and so with the address of its build - would otherwise report to a server nobody
 * was asked about. A bare "on", as an earlier version stored it, names no address and is no consent either.
 */
export function consentFor(storedValue: string | null, destination: string | null): boolean {
  return destination !== null && destination !== "" && storedValue === `on ${destination}`;
}

/** What the storage holds; undefined when it cannot be read (a locked-down webview). */
function stored(): string | null | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
}

function forget() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing can be stored here, so nothing is
  }
}

/**
 * Takes over what the backend says. Its switch is the one that counts during a run; the storage only remembers
 * the choice for the next one. So at the start of a window (`push`) a stored "on" is handed to the backend, which
 * starts every run switched off - if it was stored for the address this run reports to (see consentFor). Whatever
 * else is stored is removed, and the backend stays off until the box is ticked again.
 */
async function refresh(push: boolean) {
  try {
    let answer = await invoke<CrashReportsState>("crash_reports_state");
    const destination = typeof answer.destination === "string" ? answer.destination : null;
    const kept = push ? stored() : undefined;
    if (typeof kept === "string" && !consentFor(kept, destination)) {
      forget();
    } else if (typeof kept === "string") {
      storedOn = true;
      if (answer.available && !answer.enabled) {
        await invoke("set_crash_reports", { enabled: true });
        answer = { ...answer, enabled: true };
      }
    }
    set({
      available: answer.available === true,
      enabled: answer.available === true && answer.enabled === true,
      server: typeof answer.server === "string" ? answer.server : null,
      ownServer: answer.ownServer === true,
      destination,
      unencrypted: answer.unencrypted === true,
    });
  } catch {
    // no backend to ask (the page opened in a browser): crash reports stay unavailable
  }
}

/**
 * The stored choice may have changed - in the other window of the app, or in another running copy of the program,
 * which has a backend of its own - or this window got the focus and looks again. If it said "on" for the address
 * of this run and no longer does, the box was unticked somewhere: this backend is told "off". Never "on": that a
 * choice is stored switches a backend on at the start of a window only (see refresh). Then the backend is asked.
 */
async function follow() {
  const kept = stored();
  if (kept !== undefined) {
    const on = consentFor(kept, state.destination);
    if (storedOn && !on) {
      try {
        await invoke("set_crash_reports", { enabled: false });
      } catch {
        return; // it could not be told: the next look tells it again
      }
    }
    storedOn = on;
  }
  await refresh(false);
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
  // The other window of the app (main / pop-out analysis) shares the switch, and so does another running copy
  // of the program: when it is turned there, the storage changes and that arrives here. Looked at again when
  // this window gets the focus, should that be missed.
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) void follow();
  });
  window.addEventListener("focus", () => void follow());
  void refresh(true).then(() => {
    const kept = early ?? [];
    early = null;
    kept.forEach(([error, source]) => uncaught(error, source));
  });
}

/**
 * The switch in the header. On: the backend is told first - if it cannot be, nothing is stored and nothing changes -
 * and the choice is then stored with the address it is for. Off: the stored choice goes first, so that a window
 * which starts in this very moment does not find it and switch the backend on again, and so that it is gone for
 * the next start even if the backend cannot be told (this window then tells it when it next looks: see follow).
 */
export async function setCrashReports(on: boolean): Promise<void> {
  if (!state.available) return;
  if (!on) forget();
  await invoke("set_crash_reports", { enabled: on });
  storedOn = false;
  if (on && state.destination) {
    try {
      localStorage.setItem(STORAGE_KEY, `on ${state.destination}`);
      storedOn = true;
    } catch {
      // the choice then lasts for this run only
    }
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
