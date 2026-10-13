// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { type RefObject, useEffect, useRef } from "react";

/** How a popover was told to go: by a press outside of it, or by Escape. */
export type DismissedBy = "press" | "escape";

/** what the listeners are put on: the window, or a stand-in for it in a test */
type Listens = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * Listens for what closes a popover that is open - the list of the navigator, the menus of Import and Compare: a
 * press anywhere outside of it, and Escape. The press only closes: it is taken before the page sees it and goes
 * no further, so that it does not also place a cursor in the plot it happens to land on, or start a drag there.
 * `root` gives the element that holds the button and its popover. Returns the function that stops listening.
 */
export function listenForDismiss(root: () => Node | null, close: (by: DismissedBy) => void, on: Listens = window): () => void {
  const outside = (e: PointerEvent) => {
    const within = root();
    if (within && !within.contains(e.target as Node)) {
      close("press");
      e.stopPropagation();
    }
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") close("escape");
  };
  on.addEventListener("pointerdown", outside, true);
  on.addEventListener("keydown", key);
  return () => {
    on.removeEventListener("pointerdown", outside, true);
    on.removeEventListener("keydown", key);
  };
}

/** listenForDismiss for as long as `open` holds. `close` need not be the same function at every render. */
export function useDismiss(open: boolean, root: RefObject<Node | null>, close: (by: DismissedBy) => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    return listenForDismiss(
      () => root.current,
      (by) => latest.current(by),
    );
  }, [open, root]);
}
