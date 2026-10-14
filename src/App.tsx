// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  ProfileInfo,
  IlaCore,
  IlaProbe,
  LtxResult,
  WaveformResult,
  CaptureConfig,
  HwResult,
  HwSession,
  ProbeFormat,
  StopAnswer,
  VIEWER_MAX_SAMPLES,
} from "./types";
import { probeKey, ruleForProbe, ruleTarget, ruleTrigger } from "./trigger";
import {
  SavedSettings,
  beyondThePage,
  formatOf,
  guiOf,
  nameToOffer,
  profileNote,
  profileOf,
  profileValues,
  sameFileName,
  settingsOf,
} from "./profile";
import { captureLabel, cleanFormats, pathKey, shortCore, statusFromLogLine } from "./names";
import { Header } from "./components/Header";
import { SaveAnswer, SaveProfileDialog } from "./components/SaveProfileDialog";
import { HardwareConfig } from "./components/HardwareConfig";
import { ProbeSelector } from "./components/ProbeSelector";
import { TriggerRuleBuilder } from "./components/TriggerRuleBuilder";
import { WaveformViewer } from "./components/WaveformViewer";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { CaptureImport } from "./components/CaptureImport";
import {
  CaptureCompare,
  applyComparisonChange,
  cleanComparison,
  comparisonChange,
  useComparedCaptures,
} from "./components/CaptureCompare";
import { CaptureItem, CaptureNavigator } from "./components/CaptureNavigator";
import { CaptureControlBar } from "./components/CaptureControlBar";
import { FileText } from "lucide-react";
import "./App.css";

// The hardware settings of the last session (SavedSettings), so the app comes back the way it was left.
const SETTINGS_KEY = "ila-studio-settings-v1";

// How the buses of a design are written into the CSV: chosen in the probe list, kept per probe file.
const FORMATS_KEY = "ila-studio-probe-formats-v1";
type ProbeFormats = Record<string, ProbeFormat>;

function storedFormats(): Record<string, ProbeFormats> {
  try {
    const all = JSON.parse(localStorage.getItem(FORMATS_KEY) || "{}");
    return all && typeof all === "object" ? (all as Record<string, ProbeFormats>) : {};
  } catch {
    return {};
  }
}

/** one probe file, however its path was typed: what its formats are stored under, and what tells it from another */
const formatsKey = pathKey;

/** What scan_capture_paths answers: the capture files among what was named for an import. */
interface CaptureScan {
  files: { path: string; modifiedMs: number }[];
  /** CSV files that are no ILA captures (index.csv lies in every session folder) */
  skipped: number;
  /** there were more captures than the list takes */
  truncated: boolean;
}

/**
 * The profiles of the folder, as the files hold them now. A profile is a file anyone can edit: a "name" that is
 * no text is replaced by the name of the file.
 */
async function readProfiles(): Promise<ProfileInfo[]> {
  const list = await invoke<ProfileInfo[]>("list_profiles");
  return list.map((p) => (typeof p.name === "string" && p.name.trim() !== "" ? p : { ...p, name: p.filename.replace(/\.json$/i, "") }));
}

function loadSettings(): Partial<SavedSettings> | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? settingsOf(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Payload of the backend's "ila-capture" event: one capture file is complete on disk. */
interface CaptureEvent {
  csvPath?: string | null;
  name?: string;
  index?: number;
  rows?: number;
}

/** One capture this session has seen: taken on the hardware, opened from disk, or the demo data. */
interface CaptureEntry extends CaptureItem {
  path: string;
  /** listed by an import without having been read: whether it is a capture at all shows when it is looked at */
  unread?: boolean;
}

const MAX_LIVE_LOG_LINES = 3000;
// The list of captures one can step through. A constant capture left running adds one every few seconds: beyond
// this many the oldest leave the list (their files stay on disk, and "Open File" brings one back). Every entry
// keeps the number it was given, so the count goes on and a capture being looked at does not change its number.
// Twice what one import brings (MAX_IMPORT in lib.rs): after a full import the list still has room, and what
// arrives next pushes out what stood before the imported captures, not those.
const MAX_CAPTURE_HISTORY = 4000;
// Parsed captures kept in memory so that stepping back and forth does not read the files again: this many
// values in all (about six captures of 16384 samples and 60 signals).
const WAVE_CACHE_VALUES = 6_000_000;
// A second click that lands on the button right after it turned into "Stop" is the tail of a double-click.
const STOP_GUARD_MS = 700;
const NOTHING_COMPARED: string[] = [];

export function App() {
  // Profiles
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [selectedProfilePath, setSelectedProfilePath] = useState<string>("");
  // "Save configuration" is open
  const [savingProfile, setSavingProfile] = useState<boolean>(false);
  const closeSaveProfile = useCallback(() => setSavingProfile(false), []);

  // Hardware State
  const [serverUrl, setServerUrl] = useState<string>("127.0.0.1:3121");
  const [ltxPath, setLtxPath] = useState<string>("");
  const [tclPath, setTclPath] = useState<string>("");
  const [deviceFilter, setDeviceFilter] = useState<string>("*");
  const [omitJtagFreq, setOmitJtagFreq] = useState<boolean>(false);
  const [jtagFreqHz, setJtagFreqHz] = useState<number>(0);
  const [cores, setCores] = useState<IlaCore[]>([]);
  const [selectedCoreIndex, setSelectedCoreIndex] = useState<number>(0);
  const [probes, setProbes] = useState<IlaProbe[]>([]);
  // how each bus is written into the CSV (by probeKey; absent = unsigned), and the probe file that belongs to
  const [probeFormats, setProbeFormats] = useState<ProbeFormats>({});
  const [formatsOf, setFormatsOf] = useState<string>("");
  // ... and the probe file whose probes the list shows now ("" for the demo data, which has none)
  const [listOf, setListOf] = useState<string>("");
  const [hubClockHz, setHubClockHz] = useState<number>(0);
  const [isParsingLtx, setIsParsingLtx] = useState<boolean>(false);
  const [isQueryingHw, setIsQueryingHw] = useState<boolean>(false);
  // "Twin Turbo": the hardware session runs two Vivado engines, one writes its file while the other captures
  const [twinTurbo, setTwinTurbo] = useState<boolean>(false);
  const [settingsReady, setSettingsReady] = useState<boolean>(false);

  // Capture Configuration
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>({
    mode: "just_capture",
    captureName: "cap_run_001",
    position: 1000,
    timeoutMin: 1,
    format: "csv",
    // 0: not known, and times are then given in samples. It is the period of the ILA clock of a design, which
    // only the toolbar of the analysis or a profile (capture.sample_period_ns) can tell.
    samplePeriodNs: 0,
    activeRule: null,
    customTriggerStr: "",
  });

  // Waveform & Plot State
  const [waveform, setWaveform] = useState<WaveformResult | null>(null);
  const [selectedWaveformSignals, setSelectedWaveformSignals] = useState<string[]>([]);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [isStopping, setIsStopping] = useState<boolean>(false);
  // a constant capture is running: captures keep arriving
  const [liveRun, setLiveRun] = useState<boolean>(false);
  // the Vivado session the backend keeps open between jobs, and whether its button is at work
  const [hwSession, setHwSession] = useState<HwSession>({ connected: false });
  const [isDisconnecting, setIsDisconnecting] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("Ready");
  const [lastRunFailed, setLastRunFailed] = useState<boolean>(false);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [showErrorModal, setShowErrorModal] = useState<boolean>(false);

  const [activeTab, setActiveTab] = useState<"capture" | "analysis">("capture");

  // The captures of this session, in the order they arrived, and which of them is on screen. The refs carry the
  // same for the event handlers, which must not work with the values of an older render.
  const [captures, setCaptures] = useState<CaptureEntry[]>([]);
  const [captureIndex, setCaptureIndex] = useState<number>(-1);
  const capturesRef = useRef<CaptureEntry[]>([]);
  const captureIndexRef = useRef<number>(-1);
  // While the newest capture is the one on screen, each new one is shown as it arrives. Someone who has stepped
  // back to an older capture is left there: new ones are only added to the list.
  const followNewest = useRef<boolean>(true);
  // the same as state, for the navigator's dot and texts: they must say what will happen, and "the newest is
  // on screen" does not tell (a capture just started follows from wherever one was)
  const [following, setFollowingState] = useState<boolean>(true);
  const setFollowing = (on: boolean) => {
    followNewest.current = on;
    setFollowingState(on);
  };
  const captureSerial = useRef<number>(0);
  // "Compare" of the analysis: the files of the captures laid over the one on screen, in the order chosen. It
  // lasts for the session; their parsed data is held apart from waveCache (see useComparedCaptures).
  const [compared, setCompared] = useState<string[]>([]);

  const liveLog = useRef<string[]>([]);
  /** the file whose data is on screen, and the one that should be (they differ while a file is being read) */
  const loadedCsv = useRef<string>("");
  const wantedCsv = useRef<string>("");
  const loaderRunning = useRef<boolean>(false);
  const waveCache = useRef<Map<string, WaveformResult>>(new Map());
  const signalSetKey = useRef<string>("");
  const jobStartedAt = useRef<number>(0);
  // the analysis view can live in a window of its own; that window is told which capture is on screen here
  const [analysisPopped, setAnalysisPopped] = useState<boolean>(false);
  // Whether that window is open is asked at start. Until the answer is here the analysis is shown in neither
  // place: after a reload of this page with the window open, a panel mounted here for a moment would write its
  // layout over the one that window is working with.
  const [analysisKnown, setAnalysisKnown] = useState<boolean>(false);
  const waveSeq = useRef<number>(0);
  // the number of the capture on screen as state, set together with it: what is announced to the analysis window
  // then takes file and number from the same render (a ref read later can already belong to the next capture)
  const [shownSeq, setShownSeq] = useState<number>(0);
  const hwBusy = isCapturing || isQueryingHw;

  // ---- waveform files ------------------------------------------------------------------------------------
  const showWaveform = (res: WaveformResult) => {
    waveSeq.current += 1;
    setShownSeq(waveSeq.current);
    setWaveform(res);
    // Keep the user's choice of plotted signals while successive captures carry the same signals - unless
    // nothing of that choice exists in this capture, which would leave an empty viewer. A signal is told by its
    // hierarchical name, as a probe of the list is: two of them may share a leaf name.
    const names = res.signals.map(probeKey);
    const key = names.join("|");
    const changed = key !== signalSetKey.current;
    signalSetKey.current = key;
    setSelectedWaveformSignals((prev) => (changed || !prev.some((n) => names.includes(n)) ? names : prev));
  };

  const remember = (path: string, res: WaveformResult) => {
    const cache = waveCache.current;
    cache.delete(path);
    cache.set(path, res); // newest last
    const cost = (w: WaveformResult) => w.sampleIndices.length * (w.signals.length + 1);
    let total = 0;
    for (const w of cache.values()) total += cost(w);
    for (const key of [...cache.keys()]) {
      if (total <= WAVE_CACHE_VALUES || cache.size <= 1) break;
      total -= cost(cache.get(key)!);
      cache.delete(key);
    }
  };

  /**
   * A step of the choice made with "Compare", in this window or in the analysis window (see ComparisonChange). It
   * is applied to the choice as it stands now: two steps arriving one after the other both count.
   */
  const changeComparison = (change: unknown) =>
    setCompared((now) => {
      const next = cleanComparison(applyComparisonChange(now, change), capturesRef.current);
      return next.length === now.length && next.every((p, i) => p === now[i]) ? now : next;
    });
  // While the analysis has a window of its own, that window holds their data and this one lets it go: the files
  // are read again when the view moves, rather than up to eight captures being held twice.
  const comparison = useComparedCaptures(analysisPopped ? NOTHING_COMPARED : compared, captures, VIEWER_MAX_SAMPLES, (path) =>
    waveCache.current.get(path),
  );
  /** number and name of a capture of the session, for a plotted curve that names its file */
  const captureOf = useCallback((path: string) => capturesRef.current.find((c) => c.path === path), []);
  // a capture that has left the list has left the comparison too
  useEffect(() => {
    if (compared.length === 0) return;
    const still = cleanComparison(compared, captures);
    if (still.length !== compared.length) setCompared(still);
  }, [captures]);

  const setShownIndex = (index: number) => {
    captureIndexRef.current = index;
    setCaptureIndex(index);
  };

  /** Brings the capture named by wantedCsv onto the screen; asked for another one meanwhile, it goes on to that. */
  const runLoader = async (quiet: boolean) => {
    if (loaderRunning.current) return;
    loaderRunning.current = true;
    try {
      while (wantedCsv.current && wantedCsv.current !== loadedCsv.current) {
        const path = wantedCsv.current;
        // a capture that is compared is in memory already, whatever waveCache has let go meanwhile; taking it
        // from there also makes it one object for the analysis, which then prepares its signals once
        let res = waveCache.current.get(path) ?? comparison.loaded(path) ?? null;
        if (!res) {
          if (!quiet) setStatusMessage(`Loading ${path}...`);
          try {
            res = await invoke<WaveformResult>("load_csv_data", { filePath: path, maxSamples: VIEWER_MAX_SAMPLES });
          } catch (e) {
            setStatusMessage(`Could not load the capture: ${e}`);
            // An import lists files without reading them. One that then cannot be read is no capture: it leaves
            // the list, or every step onto it would end here again and the captures behind it stay out of reach.
            if (capturesRef.current.some((c) => c.path === path && c.unread)) {
              capturesRef.current = capturesRef.current.filter((c) => c.path !== path);
              setCaptures(capturesRef.current);
            }
            if (wantedCsv.current === path) {
              // stay with what is on screen, and say so in the navigator
              wantedCsv.current = loadedCsv.current;
              const back = capturesRef.current.findIndex((c) => c.path === loadedCsv.current);
              setShownIndex(back);
              // a capture that cannot be read does not end the following: the next one is shown again
              setFollowing(followNewest.current || back === capturesRef.current.length - 1);
            } else {
              // Another capture was asked for meanwhile, and its number is a place in the list: with this entry
              // gone from it, that place has moved (the number would name the capture behind it, or none at all).
              setShownIndex(capturesRef.current.findIndex((c) => c.path === wantedCsv.current));
            }
            continue;
          }
        }
        remember(path, res);
        if (res.totalSamples > 0) {
          const list = capturesRef.current;
          const i = list.findIndex((c) => c.path === path);
          if (i >= 0 && (list[i].rows !== res.totalSamples || list[i].unread)) {
            capturesRef.current = list.map((c, k) => (k === i ? { ...c, rows: res.totalSamples, unread: false } : c));
            setCaptures(capturesRef.current);
          }
        }
        if (wantedCsv.current !== path) continue; // another capture was asked for while this one was read
        loadedCsv.current = path;
        showWaveform(res);
        if (!quiet) setStatusMessage(`Loaded ${res.totalSamples.toLocaleString()} samples from ${path}`);
      }
    } finally {
      loaderRunning.current = false;
    }
  };

  /** Shows capture number `index` of the list (the navigator's buttons, and new captures while following). */
  const showCapture = (index: number, quiet = true) => {
    const list = capturesRef.current;
    if (list.length === 0) return;
    const i = Math.max(0, Math.min(list.length - 1, Math.round(index) || 0));
    setFollowing(i === list.length - 1);
    setShownIndex(i);
    wantedCsv.current = list[i].path;
    void runLoader(quiet);
  };

  /**
   * A capture file exists: it joins the list. `show` true puts it on screen in any case (a capture that was asked
   * for, an opened file); "follow" only while the newest capture is the one on screen.
   */
  const addCapture = (path: string, rows: number, show: boolean | "follow", quiet = true, at = Date.now()) => {
    let list = capturesRef.current;
    const key = pathKey(path);
    let i = list.findIndex((c) => pathKey(c.path) === key);
    if (i < 0) {
      const wasFollowing = followNewest.current || list.length === 0;
      captureSerial.current += 1;
      list = [...list, { id: captureSerial.current, path, name: captureLabel(path), rows, at }];
      if (list.length > MAX_CAPTURE_HISTORY) {
        const dropped = list.length - MAX_CAPTURE_HISTORY;
        list = list.slice(dropped);
        setShownIndex(captureIndexRef.current >= dropped ? captureIndexRef.current - dropped : -1);
      }
      capturesRef.current = list;
      setCaptures(list);
      i = list.length - 1;
      if (show === true || (show === "follow" && wasFollowing)) showCapture(i, quiet);
    } else if (show === true) {
      showCapture(i, quiet);
    }
  };

  /**
   * "Open File": the file is read again even if it was shown before - it may have been written anew. It is read
   * FIRST: a file that is no capture (index.csv lies next to every capture) must not join the list, move the
   * number or end the following.
   */
  const openCaptureFile = async (path: string, at = 0): Promise<string> => {
    const say = (text: string) => {
      setStatusMessage(text);
      return text;
    };
    setStatusMessage(`Loading ${path}...`);
    let res: WaveformResult;
    try {
      res = await invoke<WaveformResult>("load_csv_data", { filePath: path, maxSamples: VIEWER_MAX_SAMPLES });
    } catch (e) {
      return say(`Could not load the capture: ${e}`);
    }
    remember(path, res);
    // compared as well: the comparison takes what was read just now, not what the file held before
    comparison.forget(path);
    if (loadedCsv.current === path) loadedCsv.current = "";
    addCapture(path, res.totalSamples, true, true, at);
    return say(`Loaded ${res.totalSamples.toLocaleString()} samples from ${path}`);
  };

  /**
   * "Import" of the analysis: files and folders chosen there. The captures among them join the list in the order
   * of their paths - which is the order they were taken in - and the first of them is shown. They are read when
   * they are looked at, not now: a session folder can hold hundreds.
   */
  const importCaptures = async (paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) return;
    // how it ended is also told to the analysis window, which has no status line of its own
    const say = (text: string) => {
      setStatusMessage(text);
      void emit("analysis-import-result", text);
    };
    setStatusMessage("Looking for captures...");
    let scan: CaptureScan;
    try {
      scan = await invoke<CaptureScan>("scan_capture_paths", { paths });
    } catch (e) {
      say(`Import failed: ${e}`);
      return;
    }
    const left = scan.skipped > 0 ? `${scan.skipped} file${scan.skipped === 1 ? " that is no ILA capture" : "s that are no ILA captures"} left out` : "";
    if (scan.files.length === 0) {
      // a single table that does not begin like an ILA export may still be one this tool reads: try it
      if (paths.length === 1 && scan.skipped === 1 && /\.(csv|gz|ila)$/i.test(paths[0])) say(await openCaptureFile(paths[0]));
      else say(`No ILA capture found there${left ? ` (${left})` : ""}.`);
      return;
    }
    if (scan.files.length === 1) {
      say(await openCaptureFile(scan.files[0].path, scan.files[0].modifiedMs));
      return;
    }
    // One import is one block at the end of the list, in the order of its paths. A file that was listed already
    // leaves its old place and gets a new number: left there it would stand out of order, and with a full list
    // be the very entry that is cut.
    const scanned = new Set(scan.files.map((f) => pathKey(f.path)));
    const kept = capturesRef.current.filter((c) => !scanned.has(pathKey(c.path)));
    const known = capturesRef.current.length - kept.length;
    const list = [...kept];
    for (const file of scan.files) {
      // read anew when it is looked at: it may have been written again since it was last on screen
      waveCache.current.delete(file.path);
      comparison.forget(file.path);
      if (pathKey(loadedCsv.current) === pathKey(file.path)) loadedCsv.current = "";
      captureSerial.current += 1;
      list.push({ id: captureSerial.current, path: file.path, name: captureLabel(file.path), rows: 0, at: file.modifiedMs, unread: true });
    }
    // an import is never longer than half the list: what is cut stood before it
    const dropped = Math.max(0, list.length - MAX_CAPTURE_HISTORY);
    capturesRef.current = dropped > 0 ? list.slice(dropped) : list;
    setCaptures(capturesRef.current);
    showCapture(kept.length - dropped);
    const notes = [
      known > 0 ? `${known} were in the list already` : "",
      left,
      scan.truncated ? "there are more: one import takes no more" : "",
    ].filter(Boolean);
    say(`Imported ${scan.files.length} captures${notes.length > 0 ? ` (${notes.join("; ")})` : ""}.`);
  };

  // ---- live events from a running hardware job ------------------------------------------------------------
  const onLogLine = (line: string) => {
    liveLog.current.push(line);
    if (liveLog.current.length > MAX_LIVE_LOG_LINES) liveLog.current.splice(0, 500);
    const status = statusFromLogLine(line);
    if (status) setStatusMessage(status.length > 200 ? status.slice(0, 200) + "…" : status);
  };

  const onCaptureEvent = (payload: CaptureEvent) => {
    if (!payload.csvPath) return;
    // A capture file is complete on disk: it joins the list, and is shown now - without waiting for the Vivado
    // session to close - unless an older capture is being looked at.
    addCapture(payload.csvPath, payload.rows || 0, "follow");
  };

  const syncAnalysisWindow = () =>
    void emit("analysis-sync", {
      filePath: waveform?.filePath ?? null,
      seq: shownSeq,
      samplePeriodNs: captureConfig.samplePeriodNs,
      maxSamples: VIEWER_MAX_SAMPLES,
      captures: captures.map(({ id, name, path, at, rows }) => ({ id, name, path, at, rows })),
      captureIndex,
      // the capture the number stands for: while it differs from the file shown, that one is still being read
      shownPath: captureIndex >= 0 ? (captures[captureIndex]?.path ?? null) : null,
      live: liveRun,
      following,
      // that window reads the compared captures itself, as it reads the one on screen
      compared,
    });

  // What sticks below the header (the signal list of the analysis) has to know how tall the header is: it
  // takes two rows in a narrow window.
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".app-header");
    if (!header) return;
    const publish = () => document.documentElement.style.setProperty("--app-header-h", `${header.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const handlers = useRef({ onLogLine, onCaptureEvent, syncAnalysisWindow, showCapture, importCaptures, changeComparison });
  handlers.current = { onLogLine, onCaptureEvent, syncAnalysisWindow, showCapture, importCaptures, changeComparison };

  // every capture shown here, the list of captures and a changed sample period go on to the analysis window
  // while it is open
  useEffect(() => {
    if (analysisPopped) syncAnalysisWindow();
  }, [analysisPopped, waveform, shownSeq, captureConfig.samplePeriodNs, captures, captureIndex, liveRun, following, compared]);

  const handlePopOutAnalysis = async () => {
    try {
      await invoke("open_analysis_window");
      setAnalysisPopped(true);
    } catch (e) {
      setStatusMessage(`Could not open the analysis window: ${e}`);
    }
  };

  /** "Show it here again". A window that cannot be closed says so: the click would otherwise do nothing at all
   *  (the sentence is the backend's own, which names what could not be done). */
  const handleDockAnalysis = () => void invoke("close_analysis_window").catch((e) => setStatusMessage(String(e)));

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const keep = (un: () => void) => (disposed ? un() : unlisten.push(un));
    listen<string>("ila-log", (e) => handlers.current.onLogLine(e.payload)).then(keep);
    listen<CaptureEvent>("ila-capture", (e) => handlers.current.onCaptureEvent(e.payload)).then(keep);
    // the analysis window: it asks for the capture on screen when it opens, and reports back
    listen("analysis-hello", () => handlers.current.syncAnalysisWindow()).then(keep);
    listen("analysis-window-closed", () => setAnalysisPopped(false)).then(keep);
    listen<number>("analysis-sample-period", (e) =>
      setCaptureConfig((c) => (c.samplePeriodNs === e.payload ? c : { ...c, samplePeriodNs: e.payload })),
    ).then(keep);
    // the hardware session opened or closed (by a job, the button, or by itself when Vivado ended)
    listen<HwSession>("ila-session", (e) => setHwSession(e.payload && typeof e.payload === "object" ? e.payload : { connected: false })).then(keep);
    invoke<HwSession | null>("hardware_session")
      .then((st) => !disposed && st && setHwSession(st))
      .catch(() => undefined);
    // the navigator of the analysis window: which capture it wants to see
    listen<number>("analysis-navigate", (e) => handlers.current.showCapture(Number(e.payload))).then(keep);
    // ... and its "Import": the files and folders chosen there
    listen<string[]>("analysis-import", (e) => void handlers.current.importCaptures(e.payload)).then(keep);
    // ... and its "Compare": the step taken there (a capture chosen, taken out, or a new choice altogether)
    listen<unknown>("analysis-compare", (e) => handlers.current.changeComparison(e.payload)).then(keep);
    invoke<boolean>("analysis_window_open")
      .then((open) => {
        if (disposed) return;
        setAnalysisPopped(open);
        setAnalysisKnown(true);
      })
      .catch(() => !disposed && setAnalysisKnown(true));
    // (what follows the reading of the folder is not done for a page that is gone: in development React
    // StrictMode runs this effect twice, and the profile and its probe file would be applied and read twice)
    void loadProfiles(() => disposed);

    // A job started before the page was (re)loaded runs on in the backend: show it as running, with Stop,
    // until it is gone. Without this a reloaded page could neither see nor end it.
    let poll: number | undefined;
    invoke<string | null>("current_hardware_job")
      .then((kind) => {
        if (!kind || disposed) return;
        setIsCapturing(true);
        setStatusMessage(`A ${kind} started earlier is still running.`);
        poll = window.setInterval(async () => {
          const still = await invoke<string | null>("current_hardware_job").catch(() => null);
          if (still) return;
          window.clearInterval(poll);
          setIsCapturing(false);
          setIsStopping(false);
          setStatusMessage("The earlier job has ended.");
        }, 1000);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (poll !== undefined) window.clearInterval(poll);
      unlisten.forEach((un) => un());
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    const s: SavedSettings = {
      selectedProfilePath,
      serverUrl,
      ltxPath,
      tclPath,
      deviceFilter,
      omitJtagFreq,
      jtagFreqHz,
      selectedCoreIndex: wantedCore.current.index,
      selectedCoreName: wantedCore.current.name,
      twinTurbo,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable: the settings simply do not persist */
    }
  }, [settingsReady, selectedProfilePath, serverUrl, ltxPath, tclPath, deviceFilter, omitJtagFreq, jtagFreqHz, selectedCoreIndex, cores, twinTurbo]);

  /**
   * The formats of a probe file whose probes have just been listed: what was chosen for it before (also when
   * that was "nothing"), else what the profile that names this file suggests, else everything unsigned.
   * They are held by the probeKey of the buses in the list, and of those only: a name given without its
   * hierarchy - as a profile may - goes to the bus it means, and one that fits no bus of the list is not
   * taken. Nothing is sent with a capture that the list does not show.
   */
  const adoptFormats = (ltx: string, listed: IlaProbe[], profile?: ProfileInfo, asSaved = false) => {
    const key = formatsKey(ltx);
    const all = storedFormats();
    // The formats a profile names are those of its own probe file. A profile saved from the page names the buses
    // in full: it also speaks for a file of the same name in another folder - the design moved to another PC,
    // or built again elsewhere.
    const of = profile ? profileValues(profile.data).ltx : "";
    const suggested =
      profile && (formatsKey(of) === key || (guiOf(profile.data) !== null && sameFileName(of, ltx))) ? profile.data?.capture?.probe_format : undefined;
    // `asSaved`: a profile saved from this page has just been selected. What it was saved with is no suggestion
    // but the choice itself, and takes the place of what was chosen for the file since.
    const restored = asSaved && suggested !== undefined;
    const given = cleanFormats(restored ? suggested : (all[key] ?? suggested));
    const formats: ProbeFormats = {};
    for (const bus of listed.filter((p) => p.isBus).map(probeKey)) {
      const name = given[bus] ? bus : Object.keys(given).find((n) => bus.endsWith("/" + n));
      if (name) formats[bus] = given[name];
    }
    setFormatsOf(key);
    setListOf(key);
    setProbeFormats(formats);
    if (restored) {
      // stored as a choice made in the list is: under the names of the list's buses (what the profile names
      // otherwise, a bus of a core the list does not show, stays as it is named)
      const taken = new Set(Object.keys(given).filter((n) => listed.some((p) => p.isBus && (probeKey(p) === n || probeKey(p).endsWith("/" + n)))));
      const others = Object.fromEntries(Object.entries(given).filter(([n]) => !taken.has(n)));
      try {
        localStorage.setItem(FORMATS_KEY, JSON.stringify({ ...all, [key]: { ...others, ...formats } }));
      } catch {
        /* storage unavailable: the choice holds for this run */
      }
    }
  };

  // The list may show and take a choice only while it is the list of the probe file a capture would be taken
  // with: not for the demo data, and not after another path was typed that has not been read yet.
  const formatsLive = listOf !== "" && listOf === formatsOf && formatsOf === formatsKey(ltxPath);

  /** A choice made in the list. It is stored at once - an emptied one too, which then stands against whatever a
   *  profile suggests. What is stored for probes the list does not show (another ILA core) stays as it is. */
  const handleSetProbeFormat = (keys: string[], format: ProbeFormat) => {
    if (!formatsLive) return;
    const next = { ...probeFormats };
    for (const key of keys) {
      if (format === "unsigned") delete next[key];
      else next[key] = format;
    }
    setProbeFormats(next);
    try {
      const all = storedFormats();
      const shown = new Set(probes.filter((p) => p.isBus).map(probeKey));
      const others = Object.entries(cleanFormats(all[formatsOf])).filter(([name]) => !shown.has(name));
      all[formatsOf] = { ...Object.fromEntries(others), ...next };
      localStorage.setItem(FORMATS_KEY, JSON.stringify(all));
    } catch {
      /* storage unavailable: the choice simply does not persist */
    }
  };

  /** What goes with a capture: the formats of the probe file it is taken with, of the ILA core it is taken
   *  from where the list tells the cores apart - and nothing while the formats belong to another probe file. */
  const formatsToSend = (): ProbeFormats => {
    if (formatsOf !== formatsKey(ltxPath)) return {};
    const core = cores[selectedCoreIndex]?.name;
    const ofCore = listOf === formatsOf && core ? new Set(probes.filter((p) => p.core === core).map(probeKey)) : null;
    if (!ofCore || ofCore.size === 0) return probeFormats;
    return Object.fromEntries(Object.entries(probeFormats).filter(([name]) => ofCore.has(name)));
  };

  // ---- several ILA cores ------------------------------------------------------------------------------------
  // A design may hold several ILA cores, each with probes of its own, and one capture is the capture of ONE core.
  // What is on screen belongs to the selected core: the probe list, the trigger card, the trigger. (With the
  // probes of several cores in one list, a trigger was set on a probe of another core than the one captured,
  // and Vivado answered "probe not found".)
  const selectedCore: IlaCore | undefined = cores[selectedCoreIndex];
  /** the list tells the cores apart: some probe names a core of the list (the demo data and a file without core
   *  names do not) */
  const coresKnown = useMemo(() => {
    const names = new Set(cores.map((c) => c.name));
    return cores.length > 0 && probes.some((p) => names.has(p.core));
  }, [cores, probes]);
  const probesOfCore = useMemo(
    () => (coresKnown && selectedCore ? probes.filter((p) => p.core === selectedCore.name) : probes),
    [coresKnown, probes, selectedCore],
  );
  const coreProbeCounts = useMemo(() => cores.map((c) => probes.filter((p) => p.core === c.name).length), [cores, probes]);
  const coreLabel = (index: number) => `[${index}] ${shortCore(cores[index]?.name || "")}`;
  /** The core that is wanted, for a list of cores that is read later: by name where the list has it, else by
   *  position (a profile gives a position). */
  /** ... kept apart from the list on screen, which may be another's for a while (the demo data): `cell` is what
   *  the core is chosen by on the device, `file` the probe file it is a core of. */
  const wantedCore = useRef<{ name: string; index: number; cell?: string; file?: string }>({ name: "", index: 0 });
  /** A new list of cores of the probe file `file` (read from it, or told by the hardware): the selected core is
   *  found in it again. `at`: the position the hardware says it is on. Depths the hardware has told are kept
   *  for a list of the SAME probe file that has none - another file's core of the same name is another core. */
  const adoptCores = (list: IlaCore[], file: string, at?: number) => {
    const sameFile = wantedCore.current.file === formatsKey(file);
    const known = new Map(sameFile ? cores.filter((c) => c.depth > 0).map((c) => [c.name, c.depth] as const) : []);
    const next = list.map((c) => (c.depth > 0 || !known.has(c.name) ? c : { ...c, depth: known.get(c.name) || 0 }));
    const byName = next.findIndex((c) => c.name === wantedCore.current.name);
    const index =
      at !== undefined && at >= 0 && at < next.length
        ? at
        : byName >= 0
          ? byName
          : wantedCore.current.index < next.length
            ? wantedCore.current.index
            : 0;
    wantedCore.current = { name: next[index]?.name ?? "", index, cell: next[index]?.cell || "", file: formatsKey(file) };
    setCores(next);
    setSelectedCoreIndex(index);
  };
  // whatever else sets the position: it never points beyond the list
  useEffect(() => {
    if (cores.length > 0 && selectedCoreIndex >= cores.length) setSelectedCoreIndex(0);
  }, [cores, selectedCoreIndex]);

  /** Has this core of the list a probe of this name? Looked for the way the hardware side does: the full name,
   *  the leaf name, or the end of the full name from a "/" on. */
  const coreHasProbe = (index: number, name: string) => {
    const plain = name.replace(/\[\d+:\d+\]$/, "");
    const core = cores[index]?.name;
    return probes.some((p) => p.core === core && (probeKey(p) === plain || p.name === plain || probeKey(p).endsWith("/" + plain)));
  };

  /** A click on a core chip (or on a core the probe search points to). */
  const handleSelectCore = (index: number) => {
    if (hwBusy || isDisconnecting || index === selectedCoreIndex || !cores[index]) return;
    wantedCore.current = { ...wantedCore.current, name: cores[index].name, index, cell: cores[index].cell || "" };
    setSelectedCoreIndex(index);
    // a rule on a probe of the core that was selected is no rule for this one
    const rule = captureConfig.activeRule;
    const key = rule ? rule.probeFullName || rule.probeName : "";
    if (rule && coresKnown && !probes.some((p) => p.core === cores[index].name && probeKey(p) === key)) {
      const toJustCapture = captureConfig.mode === "trigger_rule" && !captureConfig.customTriggerStr.trim();
      changeCaptureConfig({ activeRule: null, ...(toJustCapture ? { mode: "just_capture" as const } : {}) });
      setStatusMessage(
        `ILA core ${coreLabel(index)} selected. The trigger on ${rule.probeName} belonged to core ${coreLabel(selectedCoreIndex)} and was removed` +
          (toJustCapture ? ": back to Just Capture." : "."),
      );
    } else {
      setStatusMessage(`ILA core ${coreLabel(index)} selected: ${coreProbeCounts[index] || 0} probes.`);
    }
  };

  // the trigger position cannot lie beyond the buffer once the hardware has told its depth
  const coreDepth = cores[selectedCoreIndex]?.depth || 0;
  useEffect(() => {
    if (coreDepth > 0) setCaptureConfig((c) => (c.position > coreDepth - 1 ? { ...c, position: coreDepth - 1 } : c));
  }, [coreDepth]);

  // ---- profiles and the probe file --------------------------------------------------------------------------
  /** `gone`: asked once the folder has been read - true when the page that asked is no longer there */
  const loadProfiles = async (gone: () => boolean) => {
    let list: ProfileInfo[] = [];
    try {
      list = await readProfiles();
      if (gone()) return;
      setProfiles(list);
    } catch (e) {
      if (gone()) return;
      setStatusMessage(`Could not read the profiles: ${e}`);
      setLastRunFailed(true);
      setErrorDetails(String(e));
    }
    const saved = loadSettings();
    if (saved && (saved.ltxPath || saved.serverUrl)) {
      // the profile supplies the capture settings again; the hardware fields are the ones that were last used
      const profile = list.find((p) => p.path === saved.selectedProfilePath);
      // (what it names that cannot be used is said at every start, with the probe file or without)
      const note = profile ? applyProfile(profile, false) : "";
      if (saved.serverUrl) setServerUrl(saved.serverUrl);
      if (saved.tclPath !== undefined) setTclPath(saved.tclPath);
      if (saved.deviceFilter) setDeviceFilter(saved.deviceFilter);
      if (saved.omitJtagFreq !== undefined) setOmitJtagFreq(saved.omitJtagFreq);
      if (saved.jtagFreqHz !== undefined) setJtagFreqHz(saved.jtagFreqHz);
      if (saved.selectedCoreIndex !== undefined) {
        wantedCore.current = { name: saved.selectedCoreName || "", index: saved.selectedCoreIndex };
        setSelectedCoreIndex(saved.selectedCoreIndex);
        // The profile's rule is one of the core it was saved with. With another core left selected it has no
        // place - selecting that core took it away then, and it must not come back with the profile.
        const gui = profile ? guiOf(profile.data) : null;
        if (gui?.rule && gui.core !== "" && saved.selectedCoreName && gui.core !== saved.selectedCoreName) {
          setCaptureConfig((c) => ({
            ...c,
            activeRule: null,
            ...(c.mode === "trigger_rule" && !c.customTriggerStr.trim() ? { mode: "just_capture" as const } : {}),
          }));
        }
      }
      const ltx = saved.ltxPath || (profile ? profileValues(profile.data).ltx : "");
      if (ltx) {
        setLtxPath(ltx);
        void parseLtxFile(ltx, profile, false, note);
      } else if (note) {
        setStatusMessage(note);
      }
    } else if (list.length > 0) {
      // first start: the most recently edited profile whose probe file is actually on this PC. Without such a
      // one the page stays on "-- Custom Configuration --": a profile written on another PC (the examples that
      // come with the program) would only bring the path of a probe file that is not here.
      const usable = list.filter((p) => p.ltxExists).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      if (usable.length > 0) applyProfile(usable[0]);
    }
    // as it was left, whatever the profile was saved with (set after the profile, so that it stands)
    if (saved?.twinTurbo !== undefined) setTwinTurbo(saved.twinTurbo === true);
    setSettingsReady(true);
  };

  /**
   * `chosen`: picked in the Profile list just now (not the profile of the last session coming back at start).
   * Returns what the status line has to say of the profile ("" for one taken as it is): `withProbeFile` false
   * leaves the saying to the caller, who reads the probe file.
   */
  const applyProfile = (prof: ProfileInfo, withProbeFile = true, chosen = false): string => {
    setSelectedProfilePath(prof.path);
    // A profile is a file anyone can edit. Its values are taken only as the kind their keys hold (a number
    // written as text is that number); what is not is left out here and named in the status line now - not by
    // the backend when a capture is started, which would name neither the profile nor the key.
    const named = profileValues(prof.data);
    const note = profileNote(prof, named.ignored);
    // A profile saved from this page ("Save configuration") says more than one written for the capture script:
    // the mode, the rule the trigger was built from, the capture name, the core by its name, Twin Turbo.
    const gui = guiOf(prof.data);
    const format = gui ? formatOf(prof.data) : null;

    if (named.url || (gui && named.url !== null)) setServerUrl(named.url || "");
    setTclPath(named.tclScript);
    setDeviceFilter(named.deviceFilter || "*");
    setOmitJtagFreq(false);
    setJtagFreqHz(named.jtagHz);
    wantedCore.current = { name: gui?.core || "", index: named.ilaIndex };
    setSelectedCoreIndex(named.ilaIndex);
    if (gui) setTwinTurbo(gui.twinTurbo);
    if (withProbeFile && named.ltx) {
      setLtxPath(named.ltx);
      void parseLtxFile(named.ltx, prof, chosen && gui !== null, note);
    } else if (withProbeFile && note) {
      setStatusMessage(note);
    }

    setCaptureConfig((c) => ({
      ...c,
      position: named.position ?? c.position,
      timeoutMin: named.timeoutMin || c.timeoutMin,
      samplePeriodNs: named.samplePeriodNs || c.samplePeriodNs,
      ...(gui
        ? {
            mode: gui.mode,
            activeRule: gui.rule,
            customTriggerStr: gui.customTrigger,
            // the page as it was: no capture name and a sample period of 0 (times in samples) are settings too
            captureName: gui.captureName ?? c.captureName,
            ...(named.samplePeriodNs !== null ? { samplePeriodNs: named.samplePeriodNs } : {}),
            ...(format ? { format } : {}),
          }
        : named.trigger && named.trigger !== "now"
          ? { mode: "trigger_rule" as const, customTriggerStr: named.trigger, activeRule: null }
          : { customTriggerStr: "" }),
    }));
    return note;
  };

  const handleProfileSelect = (path: string) => {
    const found = profiles.find((p) => p.path === path);
    if (found) {
      applyProfile(found, true, true);
    } else {
      setSelectedProfilePath("");
    }
  };

  // Every read of a probe file is a process of its own, so the answers can overtake one another (two profiles
  // picked in quick succession, a large file and a small one). Only the answer to the newest read counts: an
  // older one - its probes, its failure, the end of "Parsing..." - belongs to a file nobody is waiting for.
  const ltxSeq = useRef<number>(0);

  /** `profile`: the one being applied right now, whose selection is not in the state yet; `asSaved`: it was
   *  saved from this page and has just been picked - see adoptFormats; `note`: what there is to say of that
   *  profile (see applyProfile), which stays in the status line in front of how the reading went */
  const parseLtxFile = async (pathOverride?: string, profile?: ProfileInfo, asSaved = false, note = "") => {
    const targetPath = pathOverride || ltxPath;
    if (!targetPath) return;

    const seq = ++ltxSeq.current;
    const say = (text: string) => setStatusMessage(note ? `${note} ${text}` : text);
    setIsParsingLtx(true);
    say("Reading the probe file...");
    try {
      const res: LtxResult = await invoke("parse_ltx", { path: targetPath });
      if (seq !== ltxSeq.current) return;
      if (res.error) {
        say(res.error);
      } else {
        adoptCores(res.cores, targetPath);
        setProbes(res.probes);
        adoptFormats(targetPath, res.probes, profile ?? profiles.find((p) => p.path === selectedProfilePath), asSaved);
        setHubClockHz(res.hubClockHz || 0);
        // ticked by the hierarchical name: two probes may share a leaf name (see shownSignals)
        setSelectedWaveformSignals(res.probes.map(probeKey));
        say(`Probe file: ${res.probes.length} probes in ${res.cores.length} ILA core(s).`);
      }
    } catch (e) {
      if (seq === ltxSeq.current) say(`Could not read the probe file: ${e}`);
    } finally {
      if (seq === ltxSeq.current) setIsParsingLtx(false);
    }
  };

  const handleLoadDemo = async () => {
    setStatusMessage("Generating demo capture...");
    try {
      const res: WaveformResult = await invoke("create_demo_capture", { samples: 2048 });
      // Every demo is a new file (captures\demo_ila_<date>_<time>.csv) - but the name changes with the second: two
      // clicks within one second write the same file, and what was read from it before is then out of date.
      remember(res.filePath, res);
      if (loadedCsv.current === res.filePath) loadedCsv.current = "";
      addCapture(res.filePath, res.totalSamples, true);
      setListOf(""); // the list now shows the demo's signals: no probe file's formats are chosen there
      setProbes(
        res.signals.map((s, idx) => ({
          name: s.name,
          fullName: s.fullName,
          width: s.width,
          isBus: s.isBus,
          core: "u_ila_demo",
          port: idx,
        })),
      );
      setCores([{ name: "u_ila_demo", cell: "u_top/u_ila_demo", depth: 16384 }]);
      setStatusMessage(`Loaded ${res.totalSamples.toLocaleString()} samples of simulated ILA data.`);
    } catch (e) {
      setStatusMessage(`Demo load failed: ${e}`);
    }
  };

  // ---- hardware ---------------------------------------------------------------------------------------------
  const hardwareRequest = () => ({
    profile: selectedProfilePath || null,
    ltx: ltxPath || null,
    // as the field has it, empty too: an emptied field asks for the bundled script although the profile names one
    tcl: tclPath,
    server: serverUrl || null,
    device: deviceFilter || null,
    // The core: by its cell name, which is what it is chosen by on the device, and by position for where a name
    // cannot be used. While the list on screen is that of the probe file in the field, it is the selected core;
    // while it is not a probe file's list at all (the demo data), the core that was selected before it came -
    // if that was a core of the file in the field; and for a path typed but not read yet, the position alone.
    ...(listOf !== "" && listOf === formatsKey(ltxPath)
      ? { ilaIndex: selectedCoreIndex, ilaCell: selectedCore?.cell || null }
      : listOf === "" && wantedCore.current.file === formatsKey(ltxPath)
        ? { ilaIndex: wantedCore.current.index, ilaCell: wantedCore.current.cell || null }
        : { ilaIndex: selectedCoreIndex, ilaCell: null }),
    jtagHz: omitJtagFreq ? 0 : jtagFreqHz || 0,
    omitJtagFreq,
    // how many Vivado engines the session is to have
    engines: twinTurbo ? 2 : 1,
  });

  /** The trigger as the Tcl side takes it: "now" or "<probe> <compare-value>"; null when a rule is still
   *  missing. Throws (with a sentence for the status bar) when the rule's value cannot be right. */
  const buildTrigger = (): string | null => {
    if (captureConfig.mode === "just_capture") return "now";
    const custom = captureConfig.customTriggerStr.trim();
    if (custom) return custom;
    const r = captureConfig.activeRule;
    if (!r || !r.probeName) return captureConfig.mode === "constant_capture" ? "now" : null;
    // by the hierarchical name, which is unambiguous where two probes share a leaf name; the trigger card makes
    // its preview with the same call and the same list
    return ruleTrigger(r, ruleTarget(r, probes));
  };

  /**
   * "Save configuration": the page as it stands, written as a profile under a name (see profile.ts) and from then
   * on a profile of the list - the selected one, since the page is that profile now. `file`: the profile file
   * that is replaced, when the name is that of a profile of the list.
   */
  const handleSaveProfile = async (name: string, overwrite: boolean, file?: string): Promise<SaveAnswer> => {
    // The profile the page was started from, as its file holds it NOW: it may have been edited since the list
    // was read, and what it holds beyond the page goes into the save.
    const list = await readProfiles().catch(() => profiles);
    const base = list.find((p) => p.path === selectedProfilePath);
    let trigger = "now";
    try {
      trigger = buildTrigger() ?? "now";
    } catch {
      /* a rule whose value cannot be right yet: the profile holds the rule as it is, and "now" for the script */
    }
    // The formats of the whole probe file: those of the buses on screen, and what is stored for its other cores.
    // For a path in the field that has not been read, what is stored for that file - and where nothing is
    // known at all, nothing is said (see profileOf).
    const key = formatsKey(ltxPath);
    const known = formatsOf === key;
    const stored = storedFormats()[key];
    const shown = new Set(probes.filter((p) => p.isBus).map(probeKey));
    const others = known ? Object.entries(cleanFormats(stored)).filter(([bus]) => !shown.has(bus)) : [];
    const data = profileOf(
      name,
      // (under the name the list shows it by: a profile written without a name is called after its file)
      base && !base.error ? { ...(base.data as Record<string, unknown>), name: base.name } : undefined,
      {
        serverUrl,
        ltxPath,
        tclPath,
        deviceFilter,
        jtagHz: omitJtagFreq ? 0 : jtagFreqHz || 0,
        coreIndex: wantedCore.current.index,
        coreName: wantedCore.current.name,
        capture: captureConfig,
        trigger,
        twinTurbo,
        probeFormats: known ? { ...Object.fromEntries(others), ...probeFormats } : stored !== undefined ? cleanFormats(stored) : null,
      },
      new Date().toLocaleDateString("en-CA"),
    );
    const answer = await invoke<SaveAnswer>("save_profile", { name, text: JSON.stringify(data, null, 2), overwrite, file: file ?? null });
    if (!answer.saved) {
      setProfiles(list); // the dialog asks about a file: with the list as it is now
      return answer;
    }
    try {
      const now = await readProfiles();
      setProfiles(now);
      const entry = now.find((p) => p.filename.toLowerCase() === answer.filename.toLowerCase());
      if (entry) setSelectedProfilePath(entry.path);
    } catch {
      /* it is saved all the same: the list shows it at the next start */
    }
    setLastRunFailed(false);
    setStatusMessage(
      `Configuration saved as profile "${name}" (profiles\\${answer.filename})` +
        (answer.kept ? `; what the file held before is kept as ${answer.kept}.` : "."),
    );
    return answer;
  };

  /** "Save" in the header: the dialog, with the list of profiles as the folder holds it now. */
  const openSaveProfile = () => {
    setSavingProfile(true);
    readProfiles()
      .then(setProfiles)
      .catch(() => undefined);
  };
  const selectedProfile = profiles.find((p) => p.path === selectedProfilePath);
  // what a save takes along from the selected profile, said in the dialog
  const inherited = selectedProfile && !selectedProfile.error ? beyondThePage(selectedProfile.data) : null;
  // The export format of a profile written by hand never came onto the page (see applyProfile): saved on top of
  // it, the profile gets the page's - which the capture script then follows too. The dialog says so. (A profile
  // that names none leaves the script at its own: both.)
  const formatBefore =
    selectedProfile && !selectedProfile.error && guiOf(selectedProfile.data) === null
      ? (formatOf(selectedProfile.data) ?? (selectedProfile.data?.capture?.format === undefined ? "both" : null))
      : null;

  const startJob = (label: string) => {
    liveLog.current = [];
    jobStartedAt.current = Date.now();
    setLastRunFailed(false);
    setErrorDetails(null);
    setStatusMessage(label);
  };

  const finishJob = (res: HwResult, failedText: string) => {
    setErrorDetails(res.log || res.rawOutput || res.message || null);
    setStatusMessage(res.message || (res.success ? "Done" : failedText));
    setLastRunFailed(!res.success && !res.stopped);
    if (!res.success && !res.stopped) setShowErrorModal(true);
  };

  const failJob = (e: unknown, text: string) => {
    setStatusMessage(`${text}: ${e}`);
    setErrorDetails([String(e), ...liveLog.current].join("\n"));
    setLastRunFailed(true);
    setShowErrorModal(true);
  };

  const handleExecuteCapture = async () => {
    if (hwBusy || isDisconnecting) return;
    let trigger: string | null;
    try {
      trigger = buildTrigger();
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : String(e));
      setLastRunFailed(true);
      return;
    }
    if (trigger === null) {
      setStatusMessage("Choose a trigger probe first (or switch to Just Capture).");
      setLastRunFailed(true);
      return;
    }
    // A trigger can only use a probe of the core that is captured. A name that is on another core of the list and
    // not on this one is refused here, with both cores named; one the list does not know at all is left to the
    // hardware, which knows the probes for certain.
    // ... and only while the list IS that of the probe file in the field: for any other the hardware answers.
    if (trigger !== "now" && coresKnown && listOf !== "" && listOf === formatsKey(ltxPath)) {
      const name = trigger.split(/\s+/)[0];
      const elsewhere = coreHasProbe(selectedCoreIndex, name) ? -1 : cores.findIndex((_, i) => i !== selectedCoreIndex && coreHasProbe(i, name));
      if (elsewhere >= 0) {
        setStatusMessage(
          `The trigger probe ${name.split("/").pop()} is not a probe of the selected ILA core ${coreLabel(selectedCoreIndex)}: ` +
            `it belongs to core ${coreLabel(elsewhere)}. Select that core, or choose a trigger probe of this one.`,
        );
        setLastRunFailed(true);
        return;
      }
    }
    const continuous = captureConfig.mode === "constant_capture";
    // whoever starts a capture wants to see what it brings: follow the newest again
    setFollowing(true);
    setLiveRun(continuous);
    setIsCapturing(true);
    startJob(continuous ? "Starting continuous capture..." : "Starting capture...");
    try {
      const res = await invoke<HwResult>("run_single_capture", {
        request: {
          ...hardwareRequest(),
          trigger,
          position: Math.max(0, Math.round(captureConfig.position) || 0),
          timeoutMin: captureConfig.timeoutMin > 0 ? captureConfig.timeoutMin : 1,
          format: captureConfig.format,
          captureName: captureConfig.captureName.trim() || `cap_${Date.now()}`,
          continuous,
          // the formats chosen for the probe file this capture is taken with - not those of another one whose
          // probes happen to be in the list
          probeFormats: formatsToSend(),
        },
      });
      // Normally the capture is in the list and on screen already (its event came first). A single capture is
      // shown in any case - it was asked for; the last window of a constant capture only while following.
      if (res.success && res.csvPath) addCapture(res.csvPath, 0, continuous ? "follow" : true);
      finishJob(res, "Capture failed");
    } catch (e) {
      failJob(e, "Capture could not be started");
    } finally {
      setLiveRun(false);
      setIsCapturing(false);
      setIsStopping(false);
    }
  };

  const handleStopJob = async () => {
    if (isStopping || Date.now() - jobStartedAt.current < STOP_GUARD_MS) return;
    setIsStopping(true);
    setStatusMessage("Stopping the running job...");
    try {
      // no job was in flight: nothing will end and take "Stopping..." away, so it is taken away here
      const answer = await invoke<StopAnswer>("stop_hardware_job");
      if (!answer.running) setIsStopping(false);
    } catch (e) {
      setStatusMessage(`Stop failed: ${e}`);
      setIsStopping(false);
    }
  };

  const applyHardwareAnswer = (res: HwResult) => {
    // the hardware's own list: every core of the device, and the position of the one the session is on
    if (res.cores && res.cores.length > 0) adoptCores(res.cores, ltxPath, res.coreIndex);
    if (res.probes && res.probes.length > 0) {
      setProbes(res.probes);
      // (the hardware names a bus without its range, the probe file with it: probeKey is the same for both)
      setSelectedWaveformSignals(res.probes.map(probeKey));
      // the hardware was asked with the probe file in the field: the list is that file's now
      if (ltxPath) adoptFormats(ltxPath, res.probes, profiles.find((p) => p.path === selectedProfilePath));
    }
    const hub = Number(res.info?.HUB_CLK_HZ || 0);
    if (hub > 0) setHubClockHz(hub);
  };

  const handleQueryHardware = async () => {
    if (hwBusy || isDisconnecting) return;
    setIsQueryingHw(true);
    startJob(`Connecting to hw_server at ${serverUrl}${twinTurbo ? " with two Vivado engines" : ""}...`);
    try {
      const res = await invoke<HwResult>("query_hardware_info", { request: hardwareRequest() });
      if (res.success) applyHardwareAnswer(res);
      finishJob(res, "Hardware query failed");
    } catch (e) {
      failJob(e, "Hardware query could not be started");
    } finally {
      setIsQueryingHw(false);
      setIsStopping(false);
    }
  };

  /** The button at the bottom right: opens the hardware session and leaves it open, or closes it. */
  const handleToggleConnection = async () => {
    if (hwBusy || isDisconnecting) return;
    if (!hwSession.connected) {
      // connecting is a hardware query whose session stays: it also reads the cores and probes of the device
      await handleQueryHardware();
      return;
    }
    setIsDisconnecting(true);
    setLastRunFailed(false);
    setStatusMessage("Closing the hardware session...");
    try {
      const res = await invoke<HwResult>("disconnect_hardware");
      setStatusMessage(res.message || "Hardware session closed.");
    } catch (e) {
      setStatusMessage(`Could not close the hardware session: ${e}`);
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleOpenLog = async () => {
    try {
      await invoke("open_log_file");
    } catch (e) {
      setStatusMessage(`Could not open ila_log.txt: ${e}`);
    }
  };

  // ---- probes and trigger rules -----------------------------------------------------------------------------
  const changeCaptureConfig = (cfg: Partial<CaptureConfig>) =>
    setCaptureConfig((prev) => ({
      ...prev,
      ...cfg,
      // a rule picked in the builder replaces a trigger expression that came from a profile
      ...(cfg.activeRule ? { customTriggerStr: "" } : {}),
    }));

  const handleSelectTriggerProbe = (probe: IlaProbe) => {
    changeCaptureConfig({
      mode: captureConfig.mode === "just_capture" ? "trigger_rule" : captureConfig.mode,
      activeRule: ruleForProbe(probe),
    });
    setStatusMessage(`Selected ${probe.name} for the trigger rule.`);
  };

  /** The button of the probe that is the trigger, clicked again: the rule goes, and with it the mode it brought. */
  const handleClearTrigger = () => {
    const name = captureConfig.activeRule?.probeName;
    const custom = captureConfig.customTriggerStr.trim();
    const toJustCapture = captureConfig.mode === "trigger_rule" && !custom;
    changeCaptureConfig({ activeRule: null, ...(toJustCapture ? { mode: "just_capture" as const } : {}) });
    setStatusMessage(
      `Trigger${name ? ` on ${name}` : ""} removed` +
        (custom
          ? `: the custom trigger expression "${custom}" still applies.`
          : toJustCapture
            ? ": back to Just Capture."
            : captureConfig.mode === "constant_capture"
              ? ": the constant capture takes window after window at once."
              : "."),
    );
  };

  /** `key`: the probeKey of the probe whose "Plot" box was clicked */
  const handleToggleWaveformSignal = (key: string) => {
    setSelectedWaveformSignals((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]
    );
  };

  const handleSelectAllWaveformSignals = () => {
    const listed = probesOfCore.map(probeKey);
    if (listed.length > 0 && listed.every((key) => selectedWaveformSignals.includes(key))) {
      setSelectedWaveformSignals((prev) => prev.filter((key) => !listed.includes(key)));
    } else {
      setSelectedWaveformSignals((prev) => [...new Set([...prev, ...listed])]);
    }
  };

  const openLogDetails = () => {
    // while a job runs the log is still growing: show what has arrived so far
    if (hwBusy) setErrorDetails(liveLog.current.join("\n"));
    setShowErrorModal(true);
  };
  // the log window closes on Escape, as "Save configuration" does
  const logOpen = showErrorModal && errorDetails !== null;
  useEffect(() => {
    if (!logOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowErrorModal(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [logOpen]);

  return (
    <div className="app-container">
      <Header
        profiles={profiles}
        selectedProfile={selectedProfilePath}
        onSelectProfile={handleProfileSelect}
        onSaveProfile={openSaveProfile}
        onLoadDemo={handleLoadDemo}
        onOpenLog={handleOpenLog}
        isCapturing={hwBusy}
        statusText={statusMessage}
        hasError={lastRunFailed}
        hasLog={errorDetails !== null || hwBusy}
        onShowLogDetails={openLogDetails}
      />

      {/* Navigation Tabs. Which of the two is shown is said as a state as well: a class alone tells a screen
          reader nothing. */}
      <div className="nav-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "capture"}
          className={`nav-tab ${activeTab === "capture" ? "active" : ""}`}
          onClick={() => setActiveTab("capture")}
        >
          ILA Capture & Trigger Rules
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "analysis"}
          className={`nav-tab ${activeTab === "analysis" ? "active" : ""}`}
          onClick={() => setActiveTab("analysis")}
        >
          Signal Analysis
        </button>
      </div>

      <main className="app-main">
        {activeTab === "capture" ? (
          <>
            <div className="dashboard-grid">
              {/* Left Column: Hardware Config & Trigger Rule Builder */}
              <div className="dashboard-col left-col">
                <HardwareConfig
                  serverUrl={serverUrl}
                  setServerUrl={setServerUrl}
                  ltxPath={ltxPath}
                  setLtxPath={setLtxPath}
                  tclPath={tclPath}
                  setTclPath={setTclPath}
                  deviceFilter={deviceFilter}
                  setDeviceFilter={setDeviceFilter}
                  omitJtagFreq={omitJtagFreq}
                  setOmitJtagFreq={setOmitJtagFreq}
                  jtagFreqHz={jtagFreqHz}
                  setJtagFreqHz={setJtagFreqHz}
                  hubClockHz={hubClockHz}
                  cores={cores}
                  selectedCoreIndex={selectedCoreIndex}
                  setSelectedCoreIndex={handleSelectCore}
                  coreProbeCounts={coreProbeCounts}
                  coresLocked={hwBusy || isDisconnecting}
                  onParseLtx={(path) => parseLtxFile(path)}
                  isParsing={isParsingLtx}
                  onError={setStatusMessage}
                />

                <TriggerRuleBuilder
                  config={captureConfig}
                  onChangeConfig={changeCaptureConfig}
                  availableProbes={probesOfCore}
                  allProbes={probes}
                  maxPosition={coreDepth > 0 ? coreDepth - 1 : 131071}
                />
              </div>

              {/* Right Column: Parameters/Probes Explorer */}
              <div className="dashboard-col right-col">
                <ProbeSelector
                  probes={probesOfCore}
                  allProbes={coresKnown ? probes : undefined}
                  cores={cores}
                  selectedCoreIndex={selectedCoreIndex}
                  onSelectCore={handleSelectCore}
                  coresLocked={hwBusy || isDisconnecting}
                  activeRule={captureConfig.activeRule}
                  onSelectTriggerProbe={handleSelectTriggerProbe}
                  onClearTrigger={handleClearTrigger}
                  selectedWaveformSignals={selectedWaveformSignals}
                  onToggleWaveformSignal={handleToggleWaveformSignal}
                  onSelectAllWaveformSignals={handleSelectAllWaveformSignals}
                  formats={formatsLive ? probeFormats : {}}
                  onSetFormat={handleSetProbeFormat}
                  formatsLocked={
                    !formatsLive
                      ? probes.length > 0 && listOf === ""
                        ? "These are not the probes of a probe file: read it (Parse File, or Connect) to choose formats"
                        : "Read the probe file first (Parse File, or Connect): this list is not that of the file in the field above"
                      : isCapturing
                        ? "A capture is running, and its formats were fixed when it started: stop it to change them"
                        : ""
                  }
                />
              </div>
            </div>

            {/* Bottom Section: Waveform Viewer */}
            <div className="waveform-section">
              <WaveformViewer
                waveform={waveform}
                selectedSignals={selectedWaveformSignals}
                // the trigger of the capture on screen, where its file marks one - never the position set above,
                // which is that of the next capture
                triggerPosition={waveform?.triggerSample ?? null}
                samplePeriodNs={captureConfig.samplePeriodNs}
                onOpenAnalysis={() => setActiveTab("analysis")}
              />
            </div>
          </>
        ) : null}
        {/* always mounted, only hidden: the zoom, cursors and plots survive a look at another tab, and a capture
            taken meanwhile is already in the plots on return */}
        <div style={{ display: activeTab === "analysis" ? "block" : "none" }}>
          {analysisPopped ? (
            <div className="card">
              <div className="empty-state" style={{ padding: 60 }}>
                <p>The signal analysis is shown in its own window.</p>
                <span>
                  It shows the capture chosen with its navigator and follows new captures while the newest one is on
                  screen. Close that window to have it back in this tab.
                </span>
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <button className="btn btn-secondary btn-small" onClick={handlePopOutAnalysis}>
                    Bring the window to the front
                  </button>
                  <button className="btn btn-secondary btn-small" onClick={handleDockAnalysis}>
                    Show it here again
                  </button>
                </div>
              </div>
            </div>
          ) : !analysisKnown ? null : (
            <AnalysisPanel
              waveform={waveform}
              samplePeriodNs={captureConfig.samplePeriodNs}
              onSamplePeriodChange={(ns) => changeCaptureConfig({ samplePeriodNs: ns })}
              onPopOut={handlePopOutAnalysis}
              captureNav={
                <CaptureNavigator
                  items={captures}
                  index={captureIndex}
                  onSelect={(i) => showCapture(i)}
                  live={liveRun}
                  following={following}
                  pending={captureIndex >= 0 && captures[captureIndex]?.path !== waveform?.filePath}
                />
              }
              captureImport={<CaptureImport onImport={(paths) => void importCaptures(paths)} onError={setStatusMessage} />}
              captureCompare={
                <CaptureCompare
                  items={captures}
                  chosen={compared}
                  onChange={(paths) => changeComparison(comparisonChange(compared, paths))}
                  current={captureIndex >= 0 ? captures[captureIndex]?.path : null}
                />
              }
              compare={comparison.list}
              onCompareRemove={(path) => changeComparison({ remove: path })}
              captureOf={captureOf}
            />
          )}
        </div>
      </main>

      {/* Floating Capture Action Bar */}
      <CaptureControlBar
        config={captureConfig}
        onChangeConfig={changeCaptureConfig}
        onExecuteCapture={handleExecuteCapture}
        onStopCapture={handleStopJob}
        isCapturing={hwBusy}
        session={hwSession}
        sessionBusy={hwBusy || isDisconnecting}
        captureDisabled={isDisconnecting}
        onToggleConnection={() => void handleToggleConnection()}
        twinTurbo={twinTurbo}
        onToggleTwinTurbo={setTwinTurbo}
        isStopping={isStopping}
        stopLabel={isCapturing ? "Stop Capture" : "Stop Connecting"}
        onLoadExistingCsv={(path) => void openCaptureFile(path)}
        onError={setStatusMessage}
      />

      {savingProfile && (
        <SaveProfileDialog
          // A profile saved here is saved again under its name. One written by hand is not offered for that:
          // its name has to be typed to replace it - a new name is what is usually meant.
          suggested={nameToOffer(selectedProfile, profiles, ltxPath)}
          profiles={profiles}
          selectedPath={selectedProfilePath}
          inherits={selectedProfile && inherited ? { from: selectedProfile.name, what: inherited } : null}
          formatChange={
            selectedProfile && formatBefore && formatBefore !== captureConfig.format
              ? { profile: selectedProfile.name, from: formatBefore, to: captureConfig.format }
              : null
          }
          onSave={handleSaveProfile}
          onClose={closeSaveProfile}
        />
      )}

      {/* Log Details Modal. A press on the backdrop itself closes it, not a click: marking the log with the mouse
          may end outside the card, and the click of that lands on the backdrop. */}
      {logOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowErrorModal(false)}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="log-modal-title">
            <div className="modal-header">
              <h3 id="log-modal-title">Hardware / Capture Log Details</h3>
              <button className="btn-close" onClick={() => setShowErrorModal(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="modal-body">
              <pre className="error-log-pre">{errorDetails || "(no output yet)"}</pre>
            </div>
            <div
              className="modal-footer"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <button
                className="btn btn-secondary"
                onClick={handleOpenLog}
                title="Open ila_log.txt in Notepad for full details"
                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                <FileText size={15} />
                <span>Open ila_log.txt in Notepad</span>
              </button>
              <button className="btn btn-primary" onClick={() => setShowErrorModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
