// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WaveformResult } from "../types";
import { AnalysisPanel } from "./AnalysisPanel";
import { CaptureImport } from "./CaptureImport";
import { CaptureCompare, comparisonChange, useComparedCaptures } from "./CaptureCompare";
import { CaptureItem, CaptureNavigator } from "./CaptureNavigator";

/** What the main window tells the analysis window: which capture is on screen there. */
export interface AnalysisSync {
  filePath: string | null;
  /** counts up with every capture shown, so the same path announced again is loaded again */
  seq: number;
  samplePeriodNs: number;
  maxSamples: number;
  /** the captures of the session and which of them is on screen, for the navigator */
  captures?: CaptureItem[];
  captureIndex?: number;
  /** the file the number stands for; it differs from filePath while the main window is still reading it */
  shownPath?: string | null;
  live?: boolean;
  following?: boolean;
  /** the files of the captures chosen with "Compare", in the order chosen */
  compared?: string[];
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/**
 * The analysis view in a window of its own (label "analysis"), to be put on another screen. It has no capture
 * controls: the main window announces every capture it shows ("analysis-sync") and this window loads the same
 * file. It asks once at start ("analysis-hello") for whatever is on screen already.
 */
export function AnalysisWindow() {
  const [waveform, setWaveform] = useState<WaveformResult | null>(null);
  const [samplePeriodNs, setSamplePeriodNs] = useState(0); // not known until the main window tells (as there)
  const [note, setNote] = useState("");
  // how an import started here ended: this window has no status line, the main window does the importing
  const [info, setInfo] = useState("");
  const [captures, setCaptures] = useState<CaptureItem[]>([]);
  const [captureIndex, setCaptureIndex] = useState(-1);
  const [live, setLive] = useState(false);
  const [following, setFollowing] = useState<boolean | undefined>(undefined);
  const [numberedPath, setNumberedPath] = useState<string | null>(null);
  // The main window owns the choice of compared captures; this window reads their files itself. Every sync
  // names the choice again: it is taken over only when it has changed, so nothing is read or redrawn for it.
  const [compared, setCompared] = useState<string[]>([]);
  const [maxSamples, setMaxSamples] = useState(131072);
  // A capture that is on screen and compared is parsed once and is one object for both (see load below).
  const shown = useRef<WaveformResult | null>(null);
  const comparison = useComparedCaptures(compared, captures, maxSamples, (path) =>
    shown.current?.filePath === path ? shown.current : undefined,
  );
  const comparisonRef = useRef(comparison);
  comparisonRef.current = comparison;
  const capturesRef = useRef(captures);
  capturesRef.current = captures;
  /** number and name of a capture of the session, for a plotted curve that names its file */
  const captureOf = useCallback((path: string) => capturesRef.current.find((c) => c.path === path), []);
  // the main window owns the choice: it is told the step taken, and announces the choice that results
  const changeComparison = (paths: string[]) => void emit("analysis-compare", comparisonChange(compared, paths));

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const keep = (un: () => void) => (disposed ? un() : unlisten.push(un));
    let wanted: AnalysisSync | null = null;
    let shownSeq = -1;
    let shownFile: string | null | undefined;
    let loading = false;

    // captures can arrive faster than they load: always go on to the newest one announced
    const load = async () => {
      if (loading) return;
      loading = true;
      // the file is compared as well: a number alone once let another capture's plots stand under it
      while (!disposed && wanted && (wanted.seq !== shownSeq || wanted.filePath !== shownFile)) {
        const job = wanted;
        // the same file announced again was read again over there (opened or imported anew): so it is here
        const again = job.filePath === shownFile;
        shownSeq = job.seq;
        shownFile = job.filePath;
        if (!job.filePath) {
          shown.current = null;
          setWaveform(null);
          continue;
        }
        try {
          // another capture coming on screen that is compared is in memory already
          const held = again ? undefined : comparisonRef.current.loaded(job.filePath);
          const res = held ?? (await invoke<WaveformResult>("load_csv_data", { filePath: job.filePath, maxSamples: job.maxSamples }));
          if (!disposed) {
            shown.current = res;
            // read anew while it is compared: the comparison takes this reading over
            if (!held && comparisonRef.current.loaded(job.filePath)) comparisonRef.current.forget(job.filePath);
            setWaveform(res);
            setNote("");
          }
        } catch (e) {
          if (!disposed) setNote(`Could not load ${job.filePath}: ${e}`);
        }
      }
      loading = false;
    };

    listen<AnalysisSync>("analysis-sync", (e) => {
      setSamplePeriodNs(e.payload.samplePeriodNs);
      setCaptures(Array.isArray(e.payload.captures) ? e.payload.captures : []);
      setCaptureIndex(typeof e.payload.captureIndex === "number" ? e.payload.captureIndex : -1);
      setLive(e.payload.live === true);
      setFollowing(typeof e.payload.following === "boolean" ? e.payload.following : undefined);
      setNumberedPath(typeof e.payload.shownPath === "string" ? e.payload.shownPath : null);
      const chosen = Array.isArray(e.payload.compared) ? e.payload.compared.filter((p) => typeof p === "string") : [];
      setCompared((now) => (sameList(now, chosen) ? now : chosen));
      if (e.payload.maxSamples > 0) setMaxSamples(e.payload.maxSamples);
      wanted = e.payload;
      void load();
    })
      .then(keep)
      .then(() => emit("analysis-hello"));
    let fade = 0;
    listen<string>("analysis-import-result", (e) => {
      setInfo(typeof e.payload === "string" ? e.payload : "");
      window.clearTimeout(fade);
      fade = window.setTimeout(() => setInfo(""), 8000);
    }).then(keep);
    return () => {
      disposed = true;
      window.clearTimeout(fade);
      unlisten.forEach((un) => un());
    };
  }, []);

  return (
    <div className="analysis-window">
      {note && <div className="analysis-window-note">{note}</div>}
      {info && <div className="analysis-window-note info">{info}</div>}
      <AnalysisPanel
        waveform={waveform}
        samplePeriodNs={samplePeriodNs}
        onSamplePeriodChange={(ns) => {
          setSamplePeriodNs(ns);
          void emit("analysis-sample-period", ns);
        }}
        onDock={() => void invoke("close_analysis_window")}
        captureNav={
          // the main window owns the list and loads the capture; this window then follows as with any capture
          <CaptureNavigator
            items={captures}
            index={captureIndex}
            live={live}
            following={following}
            pending={numberedPath !== null && numberedPath !== waveform?.filePath}
            onSelect={(i) => void emit("analysis-navigate", i)}
          />
        }
        captureImport={<CaptureImport onImport={(paths) => void emit("analysis-import", paths)} />}
        captureCompare={
          // as with the navigator: the main window takes the choice and announces it back
          <CaptureCompare
            items={captures}
            chosen={compared}
            current={numberedPath}
            onChange={changeComparison}
          />
        }
        compare={comparison.list}
        onCompareRemove={(path) => void emit("analysis-compare", { remove: path })}
        captureOf={captureOf}
      />
    </div>
  );
}
