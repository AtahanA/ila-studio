// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import { CURVE_SLOTS, curveColor, plotPalette } from "./theme";

describe("plotPalette", () => {
  it("returns the same object for a theme each time", () => {
    expect(plotPalette("dark")).toBe(plotPalette("dark"));
    expect(plotPalette("light")).toBe(plotPalette("light"));
    expect(plotPalette("light")).not.toBe(plotPalette("dark"));
  });

  it("has a colour for every curve slot in both themes, no two alike", () => {
    for (const theme of ["light", "dark"] as const) {
      const { curves } = plotPalette(theme);
      expect(curves).toHaveLength(CURVE_SLOTS.length);
      expect(new Set(curves).size).toBe(curves.length);
    }
  });
});

describe("curveColor", () => {
  it("shows a stored slot colour as the colour of that slot in the theme", () => {
    expect(curveColor(CURVE_SLOTS[1], plotPalette("light"))).toBe("#807500");
    for (const slot of CURVE_SLOTS) expect(curveColor(slot, plotPalette("dark"))).toBe(slot);
  });

  it("shows a colour that is not from the list as it is", () => {
    expect(curveColor("#123456", plotPalette("light"))).toBe("#123456");
    expect(curveColor("#123456", plotPalette("dark"))).toBe("#123456");
  });
});

// The theme of a window lives in the module, so every case loads theme.ts anew - into a page that is no more than
// what the module touches: the data-theme of <html>, the storage, and the events of the window.
const KEY = "ila-studio-theme";

interface Page {
  root: { dataset: Record<string, string> };
  stored: Map<string, string>;
  /** what the storage refuses from now on: a full one to be written, that of a locked-down webview everything */
  refuses: "nothing" | "writing" | "everything";
  /** what the other window of the app causes here when it stores `key` (null: when the storage is cleared) */
  storageEvent: (key: string | null) => void;
  focus: () => void;
}

function openPage(): Page {
  const events = new EventTarget();
  const page: Page = {
    root: { dataset: {} },
    stored: new Map(),
    refuses: "nothing",
    storageEvent: (key) => void events.dispatchEvent(Object.assign(new Event("storage"), { key })),
    focus: () => void events.dispatchEvent(new Event("focus")),
  };
  vi.stubGlobal("document", { documentElement: page.root });
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
  });
  return page;
}

async function loadTheme() {
  vi.resetModules();
  return import("./theme");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setTheme", () => {
  it("sets data-theme on <html> and stores the theme", async () => {
    const page = openPage();
    const theme = await loadTheme();
    theme.setTheme("dark");
    expect(page.root.dataset.theme).toBe("dark");
    expect(theme.getTheme()).toBe("dark");
    expect([...page.stored]).toEqual([[KEY, "dark"]]);
  });

  it("tells its subscribers of a switch once, and not of the theme that is on already", async () => {
    openPage();
    const theme = await loadTheme();
    const heard = vi.fn();
    theme.subscribe(heard);
    theme.setTheme("dark");
    expect(heard).toHaveBeenCalledTimes(1);
    theme.setTheme("dark");
    expect(heard).toHaveBeenCalledTimes(1);
    theme.setTheme("light");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("no longer tells a subscriber that has left", async () => {
    openPage();
    const theme = await loadTheme();
    const heard = vi.fn();
    const leave = theme.subscribe(heard);
    leave();
    theme.setTheme("dark");
    expect(heard).not.toHaveBeenCalled();
  });

  it("still switches when the theme cannot be stored", async () => {
    const page = openPage();
    const theme = await loadTheme();
    page.refuses = "everything";
    theme.setTheme("dark");
    expect(page.root.dataset.theme).toBe("dark");
    expect(theme.getTheme()).toBe("dark");
    expect(page.stored.size).toBe(0);
  });
});

describe("initTheme", () => {
  it("starts with the stored theme", async () => {
    const page = openPage();
    page.stored.set(KEY, "dark");
    const theme = await loadTheme();
    theme.initTheme();
    expect(page.root.dataset.theme).toBe("dark");
    expect(theme.getTheme()).toBe("dark");
  });

  it("starts light when nothing is stored", async () => {
    const page = openPage();
    (await loadTheme()).initTheme();
    expect(page.root.dataset.theme).toBe("light");
  });

  it("starts light when what is stored is no theme", async () => {
    const page = openPage();
    page.stored.set(KEY, "blue");
    (await loadTheme()).initTheme();
    expect(page.root.dataset.theme).toBe("light");
  });

  it("starts light when the storage cannot be read", async () => {
    const page = openPage();
    page.stored.set(KEY, "dark");
    page.refuses = "everything";
    (await loadTheme()).initTheme();
    expect(page.root.dataset.theme).toBe("light");
  });

  it("does its work once", async () => {
    const page = openPage();
    const theme = await loadTheme();
    theme.initTheme();
    page.root.dataset.theme = "set by the test";
    theme.initTheme();
    expect(page.root.dataset.theme).toBe("set by the test");
  });

  it("follows a switch made in the other window", async () => {
    const page = openPage();
    const theme = await loadTheme();
    theme.initTheme();
    const heard = vi.fn();
    theme.subscribe(heard);

    page.stored.set(KEY, "dark");
    page.storageEvent("some-other-key");
    expect(theme.getTheme()).toBe("light");
    page.storageEvent(KEY);
    expect(theme.getTheme()).toBe("dark");
    expect(page.root.dataset.theme).toBe("dark");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("goes back to light when the storage is cleared", async () => {
    const page = openPage();
    page.stored.set(KEY, "dark");
    const theme = await loadTheme();
    theme.initTheme();
    page.stored.clear();
    page.storageEvent(null);
    expect(theme.getTheme()).toBe("light");
  });

  it("looks at the storage again when the window gets the focus", async () => {
    const page = openPage();
    const theme = await loadTheme();
    theme.initTheme();
    page.stored.set(KEY, "dark");
    page.focus();
    expect(theme.getTheme()).toBe("dark");
  });

  it("gives the storage no say over a theme that could not be stored, until the other window stores one", async () => {
    const page = openPage();
    page.stored.set(KEY, "light");
    const theme = await loadTheme();
    theme.initTheme();
    page.refuses = "writing";
    theme.setTheme("dark");
    page.focus();
    expect(theme.getTheme()).toBe("dark"); // although the storage still says light

    page.storageEvent(KEY);
    expect(theme.getTheme()).toBe("light");
  });
});

// index.html sets the theme with a script of its own before the bundle loads (a start must not flash the other
// theme). It and theme.ts have to agree on the key and on the theme of a first start.
describe("the inline script of index.html", () => {
  it("reads the key that setTheme writes", async () => {
    const page = openPage();
    const theme = await loadTheme();
    theme.setTheme("dark");
    const read = /localStorage\.getItem\("([^"]+)"\)/.exec(indexHtml);
    expect(read).not.toBeNull();
    expect([...page.stored.keys()]).toEqual([read?.[1]]);
  });

  it("starts with the theme initTheme starts with when nothing is stored", async () => {
    const page = openPage();
    (await loadTheme()).initTheme();
    const start = /var theme = "(\w+)";/.exec(indexHtml);
    expect(start).not.toBeNull();
    expect(page.root.dataset.theme).toBe(start?.[1]);
  });
});
