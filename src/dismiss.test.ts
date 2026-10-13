// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { describe, expect, it } from "vitest";
import { type DismissedBy, listenForDismiss } from "./dismiss";

type Handler = (event: unknown) => void;

/** A window that only keeps the listeners it is given, each with the phase it was registered for. */
function page() {
  const listeners: { type: string; handler: Handler; capture: boolean }[] = [];
  const on = {
    addEventListener: (type: string, handler: Handler, capture = false) => void listeners.push({ type, handler, capture }),
    removeEventListener: (type: string, handler: Handler, capture = false) => {
      const at = listeners.findIndex((l) => l.type === type && l.handler === handler && l.capture === capture);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  /** an event of the page, as the listeners for it get it; answers whether one of them stopped it */
  const send = (type: string, event: object) => {
    let stopped = false;
    for (const l of listeners.filter((x) => x.type === type)) l.handler({ ...event, stopPropagation: () => (stopped = true) });
    return stopped;
  };
  return { on: on as unknown as Pick<Window, "addEventListener" | "removeEventListener">, listeners, send };
}

/** the popover with its button: `inside` is an element of it, anything else is the rest of the page */
const inside = { name: "a row of the menu" };
const popover = { contains: (node: unknown) => node === inside } as unknown as Node;

function opened(root: () => Node | null = () => popover) {
  const p = page();
  const closed: DismissedBy[] = [];
  const stop = listenForDismiss(root, (by) => void closed.push(by), p.on);
  return { ...p, closed, stop };
}

describe("listenForDismiss", () => {
  it("closes on a press outside, and keeps that press from the page", () => {
    const { send, closed } = opened();
    expect(send("pointerdown", { target: { name: "a plot" } })).toBe(true);
    expect(closed).toEqual(["press"]);
  });

  it("takes the press before the page sees it", () => {
    // in the capture phase: a plot under the press handles it in the bubble phase, which it never reaches
    const { listeners } = opened();
    expect(listeners.map((l) => `${l.type} ${l.capture ? "capture" : "bubble"}`)).toEqual(["pointerdown capture", "keydown bubble"]);
  });

  it("leaves a press inside alone", () => {
    const { send, closed } = opened();
    expect(send("pointerdown", { target: inside })).toBe(false);
    expect(closed).toEqual([]);
  });

  it("closes on Escape and on no other key", () => {
    const { send, closed } = opened();
    send("keydown", { key: "Enter" });
    send("keydown", { key: "a" });
    expect(closed).toEqual([]);
    send("keydown", { key: "Escape" });
    expect(closed).toEqual(["escape"]);
  });

  it("does nothing on a press while the popover has no element", () => {
    const { send, closed } = opened(() => null);
    expect(send("pointerdown", { target: { name: "a plot" } })).toBe(false);
    expect(closed).toEqual([]);
  });

  it("asks for the element at every press: it may be another one by then", () => {
    let root: Node | null = null;
    const { send, closed } = opened(() => root);
    send("pointerdown", { target: { name: "a plot" } });
    root = popover;
    send("pointerdown", { target: { name: "a plot" } });
    expect(closed).toEqual(["press"]);
  });

  it("stops listening when told to", () => {
    const { send, closed, listeners, stop } = opened();
    stop();
    expect(listeners).toEqual([]);
    expect(send("pointerdown", { target: { name: "a plot" } })).toBe(false);
    send("keydown", { key: "Escape" });
    expect(closed).toEqual([]);
  });
});
