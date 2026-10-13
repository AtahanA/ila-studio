// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, isBenign } from "./crashReports";

describe("describeError", () => {
  it("takes message and stack of an Error", () => {
    const error = new TypeError("x is undefined");
    expect(describeError(error)).toEqual({ message: "x is undefined", stack: error.stack });
  });

  it("names an Error that has no message by its kind", () => {
    expect(describeError(new RangeError("")).message).toBe("RangeError");
  });

  it("takes a text as it is: what a command of the backend rejects with", () => {
    expect(describeError("ila_bridge.py was not found")).toEqual({ message: "ila_bridge.py was not found" });
  });

  it("reads an object that only looks like an error", () => {
    expect(describeError({ message: "from a library", stack: "at a (b:1:2)" })).toEqual({
      message: "from a library",
      stack: "at a (b:1:2)",
    });
    expect(describeError({ message: "no stack", stack: 7 })).toEqual({ message: "no stack", stack: undefined });
    expect(describeError({ message: "" }).message).toBe("an error without a message");
  });

  it("makes a text of anything else that was thrown", () => {
    expect(describeError(42).message).toBe("42");
    expect(describeError(undefined).message).toBe("undefined");
    expect(describeError(null).message).toBe("null");
    expect(describeError({ code: 3 }).message).toBe("[object Object]");
    expect(describeError(Object.create(null)).message).toBe("an error that cannot be shown as text");
  });
});

describe("isBenign", () => {
  it("knows the notices of ResizeObserver, in both wordings", () => {
    expect(isBenign("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isBenign("ResizeObserver loop limit exceeded")).toBe(true);
    expect(isBenign("Uncaught TypeError: x is undefined")).toBe(false);
  });
});

// What the module keeps lives in the module, so every case loads crashReports.ts anew - into a page that is no
// more than what the module touches (the storage, the events of the window) and with a stand-in for the backend.
const KEY = "ila-studio-crash-reports";

interface Page {
  stored: Map<string, string>;
  /** what the storage refuses from now on */
  refuses: "nothing" | "writing" | "everything";
  /** the commands the page has called, in order */
  calls: [string, unknown][];
  /** the backend: what it would answer to crash_reports_state, and to an error handed over */
  backend: { available: boolean; enabled: boolean; server: string | null; ownServer: boolean };
  outcome: string;
  /** commands that fail from now on */
  failing: Set<string>;
  dispatch: (type: string, fields?: object) => void;
  reports: () => Record<string, unknown>[];
}

function openPage(): Page {
  const events = new EventTarget();
  const page: Page = {
    stored: new Map(),
    refuses: "nothing",
    calls: [],
    backend: { available: true, enabled: false, server: "reports.example.org", ownServer: false },
    outcome: "sent",
    failing: new Set(),
    dispatch: (type, fields = {}) => void events.dispatchEvent(Object.assign(new Event(type), fields)),
    reports: () =>
      page.calls
        .filter(([command]) => command === "report_frontend_error")
        .map(([, args]) => (args as { report: Record<string, unknown> }).report),
  };
  vi.stubGlobal("window", events);
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      if (page.refuses === "everything") throw new Error("no storage");
      return page.stored.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (page.refuses !== "nothing") throw new Error("the storage cannot be written");
      page.stored.set(key, value);
    },
    removeItem(key: string) {
      if (page.refuses !== "nothing") throw new Error("the storage cannot be written");
      page.stored.delete(key);
    },
  });
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: async (command: string, args?: { enabled?: boolean }) => {
      page.calls.push([command, args]);
      if (page.failing.has(command)) throw `${command} failed`;
      if (command === "crash_reports_state") return { ...page.backend };
      if (command === "set_crash_reports") {
        // as the backend: the switch does nothing in a build without a report address
        if (page.backend.available) page.backend.enabled = args?.enabled === true;
        return null;
      }
      if (command === "report_frontend_error") return page.outcome;
      if (command === "send_test_crash_report") return "0123456789abcdef0123456789abcdef";
      throw `unknown command ${command}`;
    },
  }));
  return page;
}

/** lets what was started - the question to the backend, an error handed over - come to its end */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function start(name: "main" | "analysis" = "main") {
  vi.resetModules();
  const reports = await import("./crashReports");
  reports.startCrashReports(name);
  await settle();
  return reports;
}

const commands = (page: Page) => page.calls.map(([command]) => command);
const lastCall = (page: Page) => page.calls[page.calls.length - 1];

afterEach(() => {
  vi.doUnmock("@tauri-apps/api/core");
  vi.unstubAllGlobals();
});

describe("startCrashReports", () => {
  it("leaves crash reports off at a first start, and hands no error over", async () => {
    const page = openPage();
    const reports = await start();
    expect(reports.getCrashReports()).toEqual({
      available: true,
      enabled: false,
      server: "reports.example.org",
      ownServer: false,
    });
    page.dispatch("error", { error: new Error("boom"), message: "Uncaught Error: boom" });
    page.dispatch("unhandledrejection", { reason: "rejected" });
    await settle();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(page.stored.size).toBe(0);
  });

  it("switches the backend on when the user had switched crash reports on", async () => {
    const page = openPage();
    page.stored.set(KEY, "on");
    const reports = await start();
    expect(page.calls).toEqual([
      ["crash_reports_state", undefined],
      ["set_crash_reports", { enabled: true }],
    ]);
    expect(reports.getCrashReports().enabled).toBe(true);
  });

  it("takes only the value it writes for a yes", async () => {
    const page = openPage();
    page.stored.set(KEY, "true");
    const reports = await start();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(reports.getCrashReports().enabled).toBe(false);
  });

  it("does not switch on what a build without a report address cannot send", async () => {
    const page = openPage();
    page.backend = { available: false, enabled: false, server: null, ownServer: false };
    page.stored.set(KEY, "on");
    const reports = await start();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(reports.getCrashReports()).toEqual({ available: false, enabled: false, server: null, ownServer: false });
    page.dispatch("error", { error: new Error("boom") });
    await settle();
    expect(await reports.reportError(new Error("boom"), "render", { once: true })).toBe("unavailable");
    await reports.setCrashReports(true);
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(page.stored.get(KEY)).toBe("on"); // left as it was: the choice holds for a build that can send
  });

  it("stays off when the storage cannot be read", async () => {
    const page = openPage();
    page.stored.set(KEY, "on");
    page.refuses = "everything";
    const reports = await start();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(reports.getCrashReports().enabled).toBe(false);
  });

  it("takes over a switch that is on in the backend already: the other window of this run turned it", async () => {
    const page = openPage();
    page.backend.enabled = true;
    const reports = await start("analysis");
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(reports.getCrashReports().enabled).toBe(true);
  });

  it("stays unavailable without a backend to ask", async () => {
    const page = openPage();
    page.failing.add("crash_reports_state");
    const reports = await start();
    expect(reports.getCrashReports().available).toBe(false);
    page.dispatch("error", { error: new Error("boom") });
    await settle();
    expect(page.reports()).toEqual([]);
  });

  it("does its work once", async () => {
    const page = openPage();
    const reports = await start();
    reports.startCrashReports("analysis");
    await settle();
    expect(commands(page)).toEqual(["crash_reports_state"]);
  });
});

describe("uncaught errors, while crash reports are on", () => {
  async function startOn(name: "main" | "analysis" = "main") {
    const page = openPage();
    page.stored.set(KEY, "on");
    const reports = await start(name);
    page.calls.length = 0;
    return { page, reports };
  }

  it("hands an uncaught error to the backend with its stack", async () => {
    const { page } = await startOn();
    const error = new Error("boom");
    page.dispatch("error", { error, message: "Uncaught Error: boom" });
    await settle();
    expect(page.reports()).toEqual([
      { message: "boom", stack: error.stack, componentStack: undefined, source: "error", window: "main", once: undefined },
    ]);
  });

  it("hands an unhandled rejection over, whatever was rejected with", async () => {
    const { page } = await startOn("analysis");
    page.dispatch("unhandledrejection", { reason: "Python 3 was not found." });
    await settle();
    expect(page.reports()).toMatchObject([
      { message: "Python 3 was not found.", stack: undefined, source: "unhandledrejection", window: "analysis" },
    ]);
  });

  it("says where a script error without its object happened", async () => {
    const { page } = await startOn();
    page.dispatch("error", { message: "Script error.", filename: "http://tauri.localhost/assets/index.js", lineno: 3, colno: 9 });
    await settle();
    expect(page.reports()).toMatchObject([
      { message: "Script error.", stack: "    at http://tauri.localhost/assets/index.js:3:9" },
    ]);
  });

  it("ignores what is no error of the program", async () => {
    const { page } = await startOn();
    page.dispatch("error"); // an image that did not load
    page.dispatch("error", { message: "ResizeObserver loop completed with undelivered notifications." });
    await settle();
    expect(page.reports()).toEqual([]);
  });

  it("hands the same message over once, and no more than twenty in all", async () => {
    const { page } = await startOn();
    for (let i = 0; i < 25; i++) {
      page.dispatch("error", { error: new Error(`error ${i}`) });
      page.dispatch("unhandledrejection", { reason: new Error(`error ${i}`) });
    }
    await settle();
    expect(page.reports().map((r) => r.message)).toEqual(Array.from({ length: 20 }, (_, i) => `error ${i}`));
  });

  it("cuts a text that is too long to cross to the backend", async () => {
    const { page } = await startOn();
    page.dispatch("error", { error: { message: "m".repeat(5000), stack: "s".repeat(30000) } });
    await settle();
    const [report] = page.reports();
    expect((report.message as string).length).toBe(4000);
    expect((report.stack as string).length).toBe(20000);
  });

  it("stops when crash reports are switched off", async () => {
    const { page, reports } = await startOn();
    await reports.setCrashReports(false);
    page.dispatch("error", { error: new Error("boom") });
    await settle();
    expect(page.reports()).toEqual([]);
  });
});

describe("errors of the first moments", () => {
  // the window is started, but the backend has not answered yet
  async function startUnsettled() {
    vi.resetModules();
    const reports = await import("./crashReports");
    reports.startCrashReports("main");
    return reports;
  }

  it("are handed over once the backend has said that crash reports are on", async () => {
    const page = openPage();
    page.stored.set(KEY, "on");
    await startUnsettled();
    page.dispatch("error", { error: new Error("at start") });
    expect(page.reports()).toEqual([]);
    await settle();
    expect(page.reports().map((r) => r.message)).toEqual(["at start"]);
  });

  it("are dropped when crash reports are off", async () => {
    const page = openPage();
    await startUnsettled();
    page.dispatch("error", { error: new Error("at start") });
    await settle();
    expect(page.reports()).toEqual([]);
  });

  it("are no more than five", async () => {
    const page = openPage();
    page.stored.set(KEY, "on");
    await startUnsettled();
    for (let i = 0; i < 8; i++) page.dispatch("error", { error: new Error(`at start ${i}`) });
    await settle();
    expect(page.reports()).toHaveLength(5);
  });
});

describe("setCrashReports", () => {
  it("tells the backend, stores the choice and tells its subscribers", async () => {
    const page = openPage();
    const reports = await start();
    const heard = vi.fn();
    const leave = reports.subscribeCrashReports(heard);

    await reports.setCrashReports(true);
    expect(lastCall(page)).toEqual(["set_crash_reports", { enabled: true }]);
    expect([...page.stored]).toEqual([[KEY, "on"]]);
    expect(reports.getCrashReports().enabled).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);

    await reports.setCrashReports(true);
    expect(heard).toHaveBeenCalledTimes(1);

    await reports.setCrashReports(false);
    expect(lastCall(page)).toEqual(["set_crash_reports", { enabled: false }]);
    expect(page.stored.size).toBe(0); // absent, not "off"
    expect(reports.getCrashReports().enabled).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);

    leave();
    await reports.setCrashReports(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("still switches, for this run, when the choice cannot be stored", async () => {
    const page = openPage();
    const reports = await start();
    page.refuses = "writing";
    await reports.setCrashReports(true);
    expect(reports.getCrashReports().enabled).toBe(true);
    expect(page.backend.enabled).toBe(true);
    expect(page.stored.size).toBe(0);
  });

  it("changes nothing when the backend cannot be told", async () => {
    const page = openPage();
    const reports = await start();
    page.failing.add("set_crash_reports");
    await expect(reports.setCrashReports(true)).rejects.toBe("set_crash_reports failed");
    expect(reports.getCrashReports().enabled).toBe(false);
    expect(page.stored.size).toBe(0);
  });
});

describe("the other window", () => {
  it("is followed: its switch arrives as a change of the storage, and the backend is asked again", async () => {
    const page = openPage();
    const reports = await start();
    const heard = vi.fn();
    reports.subscribeCrashReports(heard);

    // the other window has switched crash reports on
    page.backend.enabled = true;
    page.stored.set(KEY, "on");
    page.dispatch("storage", { key: "some-other-key" });
    await settle();
    expect(reports.getCrashReports().enabled).toBe(false);
    page.dispatch("storage", { key: KEY });
    await settle();
    expect(reports.getCrashReports().enabled).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    // asked, not told: the switch is the backend's
    expect(commands(page)).toEqual(["crash_reports_state", "crash_reports_state"]);

    page.backend.enabled = false;
    page.dispatch("focus");
    await settle();
    expect(reports.getCrashReports().enabled).toBe(false);
  });

  it("does not turn the backend on again from a storage that still says on", async () => {
    const page = openPage();
    page.stored.set(KEY, "on");
    const reports = await start();
    // the other window switched off, and its storage could not be written
    page.backend.enabled = false;
    page.dispatch("focus");
    await settle();
    expect(reports.getCrashReports().enabled).toBe(false);
    expect(page.backend.enabled).toBe(false);
  });
});

describe("reportError", () => {
  it("does not ask the backend while crash reports are off", async () => {
    const page = openPage();
    const reports = await start();
    expect(await reports.reportError(new Error("boom"), "render", { componentStack: "at App" })).toBe("off");
    expect(page.reports()).toEqual([]);
  });

  it("sends the one report the user asks for although they are off", async () => {
    const page = openPage();
    const reports = await start();
    const error = new Error("boom");
    expect(await reports.reportError(error, "render", { componentStack: "at App", once: true })).toBe("sent");
    expect(page.reports()).toEqual([
      { message: "boom", stack: error.stack, componentStack: "at App", source: "render", window: "main", once: true },
    ]);
  });

  it("passes on what the backend made of it", async () => {
    const page = openPage();
    page.stored.set(KEY, "on");
    const reports = await start();
    page.outcome = "duplicate";
    expect(await reports.reportError(new Error("boom"), "render")).toBe("duplicate");
    page.failing.add("report_frontend_error");
    expect(await reports.reportError(new Error("boom"), "render")).toBe("failed");
  });
});

describe("sendTestReport", () => {
  it("resolves to the id of the report, and rejects with what the backend says", async () => {
    const page = openPage();
    const reports = await start();
    expect(await reports.sendTestReport()).toBe("0123456789abcdef0123456789abcdef");
    page.failing.add("send_test_crash_report");
    await expect(reports.sendTestReport()).rejects.toBe("send_test_crash_report failed");
  });
});
