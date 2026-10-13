// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

/**
 * The sample under the pointer. It changes at pointer speed, so it is kept out of React state: a chart redraws
 * only its thin overlay and a read-out re-renders only its own number, at most once per display frame - instead
 * of the whole analysis view re-rendering and every chart being redrawn for each mouse move.
 */
export class HoverStore {
  private value: number | null = null;
  private listeners = new Set<() => void>();
  private frame = 0;

  get = (): number | null => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set = (value: number | null): void => {
    if (value === this.value) return;
    this.value = value;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.listeners.forEach((listener) => listener());
    });
  };
}
