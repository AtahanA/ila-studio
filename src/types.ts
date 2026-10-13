// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

export interface IlaCore {
  name: string;
  cell: string;
  /** Capture depth in samples; 0 while it is unknown (the .ltx does not carry it, the hardware query does). */
  depth: number;
}

/**
 * How a multi-bit probe is written into the CSV of a capture. unsigned: the plain number. signed: two's complement
 * of the probe width (Vivado writes it). hex: "0x" and every digit of the width (written by this tool).
 */
export type ProbeFormat = "unsigned" | "signed" | "hex";
export const PROBE_FORMATS: ProbeFormat[] = ["unsigned", "signed", "hex"];

export interface IlaProbe {
  name: string;
  fullName: string;
  width: number;
  isBus: boolean;
  core: string;
  port: number;
}

export interface LtxResult {
  cores: IlaCore[];
  probes: IlaProbe[];
  /** Slowest debug hub clock named in the probe file, 0 if absent. TCK must stay below hubClockHz / 2.5. */
  hubClockHz?: number;
  maxSafeTckHz?: number;
  error?: string;
}

export interface ProfileInfo {
  filename: string;
  path: string;
  name: string;
  comment: string;
  ltxExists?: boolean;
  mtime?: number;
  error?: string;
  data: {
    hardware?: {
      url?: string;
      ltx?: string;
      device_filter?: string;
      ila_index?: number;
      jtag_frequency_hz?: number;
    };
    capture?: {
      trigger?: string;
      position?: number;
      timeout_min?: number;
      format?: string;
      sample_period_ns?: number;
      /** the formats a design is usually captured with, by net name: where the probe list starts from */
      probe_format?: Record<string, string>;
    };
    tools?: {
      vivado?: string;
      tcl_script?: string;
    };
  };
}

export interface SignalData {
  name: string;
  fullName: string;
  width: number;
  isBus: boolean;
  /**
   * The bits of the probe as an unsigned number, however the file wrote them. One exception: a bus wider than 53
   * bits that the file wrote signed comes as the signed numbers it holds - a small negative value is exact that
   * way, its bits (2^64 - 30) would not be.
   */
  values: number[];
  /** the file wrote this bus signed (it was captured with the probe's format set to signed) */
  signed?: boolean;
}

export interface WaveformResult {
  filePath: string;
  totalSamples: number;
  displayedSamples: number;
  step: number;
  sampleIndices: number[];
  signals: SignalData[];
  /** Buffer index of the sample Vivado marked as the trigger, when the file says so. */
  triggerSample?: number | null;
  error?: string;
}

/**
 * A capture of the session that the analysis lays over the one on screen ("Compare"): its signals can be plotted
 * next to those of the capture on screen, and stay while one steps through the captures.
 */
export interface ComparedCapture {
  /** the file: what a curve pinned to this capture names */
  path: string;
  /** its number in the session, as the navigator shows it; 0 when it is not known */
  id: number;
  name: string;
  /** null while the file is being read, and when it could not be read (see error) */
  waveform: WaveformResult | null;
  error?: string;
}

/** Answer of a hardware command (query / capture / Tcl run) as the backend returns it. */
/** The Vivado hardware session the backend keeps open between jobs (its "ila-session" event). */
export interface HwSession {
    connected: boolean;
    device?: string;
    tckHz?: number;
    server?: string;
    reason?: string;
    /** how many Vivado engines the session runs (2 with Twin Turbo) */
    engines?: number;
}

export interface HwResult {
  success: boolean;
  message: string;
  log?: string;
  cores?: IlaCore[];
  probes?: IlaProbe[];
  info?: Record<string, string>;
  csvPath?: string | null;
  sessionDir?: string | null;
  captures?: number;
  stopped?: boolean;
  rawOutput?: string;
  /** a hardware query: the cell name of the core the session is on, and its position among `cores` */
  core?: string;
  coreIndex?: number;
}

/**
 * Answer of stop_hardware_job (StopAnswer in src-tauri/src/lib.rs): what "Stop" found, as data. The page goes by
 * these fields, never by the wording of a sentence.
 */
export interface StopAnswer {
  /** a hardware job was in flight when the stop arrived; false: there was nothing to stop */
  running: boolean;
  /** it did not end in order within the time it is given and was ended, the hardware session with it */
  killed: boolean;
}

export type CaptureMode = "just_capture" | "trigger_rule" | "constant_capture";

export type TriggerOperator1Bit = "1" | "0" | "R" | "F" | "B" | "X";
export type TriggerOperatorMultiBit = "hex" | "dec" | "bin" | "custom";

export interface TriggerRule {
  probeName: string;
  /** hierarchical name without bus range: tells apart two probes that share a leaf name */
  probeFullName?: string;
  isBus: boolean;
  width: number;
  op1Bit?: TriggerOperator1Bit;
  opMultiBit?: TriggerOperatorMultiBit;
  value?: string;
  rawExpression?: string;
}

export interface CaptureConfig {
  mode: CaptureMode;
  captureName: string;
  position: number;
  timeoutMin: number;
  format: "both" | "csv" | "ila";
  samplePeriodNs: number;
  activeRule: TriggerRule | null;
  customTriggerStr: string;
}
