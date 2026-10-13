// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { afterEach, describe, expect, it, vi } from "vitest";
import { consentFor, describeError, isBenign } from "./crashReports";

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

// The address the stand-in for the backend reports to, as the backend names it (without the key), and what the
// page stores when the box is ticked for it.
const DESTINATION = "https://reports.example.org:443/1";
const ON = `on ${DESTINATION}`;

describe("consentFor", () => {
  it("holds for the address the box was ticked for", () => {
    expect(consentFor(ON, DESTINATION)).toBe(true);
    expect(consentFor("on http://127.0.0.1:9000/2", "http://127.0.0.1:9000/2")).toBe(true);
  });

  it("does not hold for another server, port, project or scheme", () => {
    expect(consentFor(ON, "https://sentry.example.net:443/1")).toBe(false);
    expect(consentFor(ON, "https://reports.example.org:8443/1")).toBe(false);
    expect(consentFor(ON, "https://reports.example.org:443/2")).toBe(false);
    expect(consentFor(ON, "https://reports.example.org:443/11")).toBe(false);
    expect(consentFor(ON, "http://reports.example.org:443/1")).toBe(false);
    expect(consentFor(ON, "https://reports.example.org:443/behind/1")).toBe(false);
  });

  it("does not hold in a program that has no address now", () => {
    expect(consentFor(ON, null)).toBe(false);
    expect(consentFor("on ", "")).toBe(false);
    expect(consentFor("on null", null)).toBe(false);
  });

  it("is not given by the bare value an earlier version stored, nor by anything else", () => {
    expect(consentFor("on", DESTINATION)).toBe(false);
    expect(consentFor("on ", DESTINATION)).toBe(false);
    expect(consentFor("true", DESTINATION)).toBe(false);
    expect(consentFor(DESTINATION, DESTINATION)).toBe(false);
    expect(consentFor(`ON ${DESTINATION}`, DESTINATION)).toBe(false);
    expect(consentFor(`${ON} `, DESTINATION)).toBe(false);
    expect(consentFor(null, DESTINATION)).toBe(false);
    expect(consentFor(null, null)).toBe(false);
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
  backend: {
    available: boolean;
    enabled: boolean;
    server: string | null;
    ownServer: boolean;
    destination: string | null;
    unencrypted: boolean;
  };
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
    backend: {
      available: true,
      enabled: false,
      server: "reports.example.org",
      ownServer: false,
      destination: DESTINATION,
      unencrypted: false,
    },
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
const NO_ADDRESS = {
  available: false,
  enabled: false,
  server: null,
  ownServer: false,
  destination: null,
  unencrypted: false,
};

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
      destination: DESTINATION,
      unencrypted: false,
    });
    page.dispatch("error", { error: new Error("boom"), message: "Uncaught Error: boom" });
    page.dispatch("unhandledrejection", { reason: "rejected" });
    await settle();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(page.stored.size).toBe(0);
  });

  it("switches the backend on when the user had switched crash reports on, for this address", async () => {
    const page = openPage();
    page.stored.set(KEY, ON);
    const reports = await start();
    expect(page.calls).toEqual([
      ["crash_reports_state", undefined],
      ["set_crash_reports", { enabled: true }],
    ]);
    expect(reports.getCrashReports().enabled).toBe(true);
    expect(page.stored.get(KEY)).toBe(ON);
  });

  // The box was ticked while reports went to one server; this start has another - a different ILA_SENTRY_DSN, or
  // none any more, and so the address of the build. Nobody was asked about that one.
  it.each([
    ["another server", "https://sentry.example.net:443/1"],
    ["another project of the same server", "https://reports.example.org:443/2"],
    ["the same server without encryption", "http://reports.example.org:443/1"],
  ])("stays off when the choice was made for %s, and forgets it", async (_what, earlier) => {
    const page = openPage();
    page.stored.set(KEY, `on ${earlier}`);
    const reports = await start();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(reports.getCrashReports().enabled).toBe(false);
    expect(page.backend.enabled).toBe(false);
    expect(page.stored.size).toBe(0);
    page.dispatch("error", { error: new Error("boom") });
    await settle();
    expect(page.reports()).toEqual([]);
    // the box ticked again, now for this address
    await reports.setCrashReports(true);
    expect(page.stored.get(KEY)).toBe(ON);
  });

  it("takes only the value it writes for a yes: not the bare one of an earlier version, which named no address", async () => {
    for (const value of ["on", "true", "", DESTINATION]) {
      const page = openPage();
      page.stored.set(KEY, value);
      const reports = await start();
      expect(commands(page)).toEqual(["crash_reports_state"]);
      expect(reports.getCrashReports().enabled).toBe(false);
      expect(page.stored.size).toBe(0);
    }
  });

  it("does not switch on what a build without a report address cannot send", async () => {
    const page = openPage();
    page.backend = { ...NO_ADDRESS };
    page.stored.set(KEY, ON);
    const reports = await start();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(reports.getCrashReports()).toEqual(NO_ADDRESS);
    page.dispatch("error", { error: new Error("boom") });
    await settle();
    expect(await reports.reportError(new Error("boom"), "render", { once: true })).toBe("unavailable");
    await reports.setCrashReports(true);
    expect(commands(page)).toEqual(["crash_reports_state"]);
    // Changed on purpose (it was left as it was, to hold again in a build that can send): the choice was made
    // for an address, and a start without that address ends it like a start with another one.
    expect(page.stored.size).toBe(0);
  });

  it("stays off when the storage cannot be read", async () => {
    const page = openPage();
    page.stored.set(KEY, ON);
    page.refuses = "everything";
    const reports = await start();
    expect(commands(page)).toEqual(["crash_reports_state"]);
    expect(reports.getCrashReports().enabled).toBe(false);
    // and when it cannot be written: the choice for another address cannot be removed, and is still not taken
    const other = openPage();
    other.stored.set(KEY, "on https://sentry.example.net:443/1");
    other.refuses = "writing";
    const again = await start();
    expect(commands(other)).toEqual(["crash_reports_state"]);
    expect(again.getCrashReports().enabled).toBe(false);
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
    page.stored.set(KEY, ON);
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
    page.dispatch("error", { error: { message: "m".repeat(9000), stack: "s".repeat(30000) } });
    await settle();
    const [report] = page.reports();
    // Changed on purpose (it was 4000): the backend takes names and addresses out before it cuts a message to
    // the 2,000 characters a report carries, and a path that the page has cut is not recognised there.
    expect((report.message as string).length).toBe(8000);
    expect((report.stack as string).length).toBe(20000);
  });

  it("hands a message of 5000 characters over whole: the backend cuts it, after it has scrubbed it", async () => {
    const { page } = await startOn();
    const message = `${"m".repeat(4990)} \\\\labserver\\designs\\top.ltx`;
    page.dispatch("error", { error: { message } });
    await settle();
    expect(page.reports()[0].message).toBe(message);
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
    page.stored.set(KEY, ON);
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

  it("are dropped when the stored choice was made for another address", async () => {
    const page = openPage();
    page.stored.set(KEY, "on https://sentry.example.net:443/1");
    await startUnsettled();
    page.dispatch("error", { error: new Error("at start") });
    await settle();
    expect(page.reports()).toEqual([]);
  });

  it("are no more than five", async () => {
    const page = openPage();
    page.stored.set(KEY, ON);
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
    // with the address the box was ticked for (it was a bare "on": see consentFor)
    expect([...page.stored]).toEqual([[KEY, ON]]);
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
    // and it lasts: a storage that never said "on" has not stopped saying it (see "another running copy")
    page.dispatch("focus");
    page.dispatch("storage", { key: KEY });
    await settle();
    expect(reports.getCrashReports().enabled).toBe(true);
    expect(page.backend.enabled).toBe(true);
  });

  it("changes nothing when the backend cannot be told", async () => {
    const page = openPage();
    const reports = await start();
    page.failing.add("set_crash_reports");
    await expect(reports.setCrashReports(true)).rejects.toBe("set_crash_reports failed");
    expect(reports.getCrashReports().enabled).toBe(false);
    expect(page.stored.size).toBe(0);
  });

  it("removes the stored choice before the backend is told to switch off, and even if it cannot be told", async () => {
    const page = openPage();
    page.stored.set(KEY, ON);
    const reports = await start();
    page.failing.add("set_crash_reports");
    await expect(reports.setCrashReports(false)).rejects.toBe("set_crash_reports failed");
    // gone for the next start, and for a window that starts in this moment: it must not switch on again
    expect(page.stored.size).toBe(0);
    // the backend is still on, and the page does not say otherwise
    expect(page.backend.enabled).toBe(true);
    expect(reports.getCrashReports().enabled).toBe(true);
    // every look tells it again, until it can be told
    page.dispatch("focus");
    await settle();
    expect(page.backend.enabled).toBe(true);
    page.failing.clear();
    page.dispatch("focus");
    await settle();
    expect(page.backend.enabled).toBe(false);
    expect(reports.getCrashReports().enabled).toBe(false);
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
    page.stored.set(KEY, ON);
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
    page.stored.set(KEY, ON);
    const reports = await start();
    // the other window switched off, and its storage could not be written
    page.backend.enabled = false;
    page.dispatch("focus");
    await settle();
    expect(reports.getCrashReports().enabled).toBe(false);
    expect(page.backend.enabled).toBe(false);
  });
});

// Two copies of the program run on one PC (two boards): they share the storage of the page, and each has a
// backend of its own. The box of the one is the box of the other.
describe("another running copy of the program", () => {
  it.each([
    ["the storage changes", "storage", { key: KEY }],
    ["the storage is cleared", "storage", { key: null }],
    ["this window gets the focus", "focus", {}],
  ])("switches this backend off when the box was unticked there and %s", async (_when, event, fields) => {
    const page = openPage();
    page.stored.set(KEY, ON);
    const reports = await start();
    expect(page.backend.enabled).toBe(true);
    page.calls.length = 0;

    page.stored.delete(KEY);
    page.dispatch(event, fields);
    await settle();
    expect(page.calls).toEqual([
      ["set_crash_reports", { enabled: false }],
      ["crash_reports_state", undefined],
    ]);
    expect(page.backend.enabled).toBe(false);
    expect(reports.getCrashReports().enabled).toBe(false);
    page.dispatch("error", { error: new Error("after the box was unticked in the other copy") });
    await settle();
    expect(page.reports()).toEqual([]);

    // told once: the next look only asks
    page.calls.length = 0;
    page.dispatch("focus");
    await settle();
    expect(commands(page)).toEqual(["crash_reports_state"]);
  });

  it("switches this backend off when the stored choice is now one for another address", async () => {
    const page = openPage();
    page.stored.set(KEY, ON);
    const reports = await start();
    // a copy that reports elsewhere was started, found a choice that was not made for its address and removed
    // it - or its box was ticked: either way the storage no longer says "on" for the address of this copy
    page.stored.set(KEY, "on https://sentry.example.net:443/1");
    page.dispatch("storage", { key: KEY });
    await settle();
    expect(page.backend.enabled).toBe(false);
    expect(reports.getCrashReports().enabled).toBe(false);
  });

  it("is never switched on from here: a box ticked there does not tick this one", async () => {
    const page = openPage();
    const reports = await start();
    page.stored.set(KEY, ON);
    page.dispatch("storage", { key: KEY });
    page.dispatch("focus");
    await settle();
    expect(commands(page)).toEqual(["crash_reports_state", "crash_reports_state", "crash_reports_state"]);
    expect(page.backend.enabled).toBe(false);
    expect(reports.getCrashReports().enabled).toBe(false);
    // ticked there, unticked there: this copy, which was off all the time, is told so again and stays off
    page.stored.delete(KEY);
    page.dispatch("storage", { key: KEY });
    await settle();
    expect(page.backend.enabled).toBe(false);
  });

  it("leaves this backend as it is while the storage cannot be read", async () => {
    const page = openPage();
    page.stored.set(KEY, ON);
    const reports = await start();
    page.refuses = "everything";
    page.dispatch("focus");
    await settle();
    expect(page.backend.enabled).toBe(true);
    expect(reports.getCrashReports().enabled).toBe(true);
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
    page.stored.set(KEY, ON);
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
