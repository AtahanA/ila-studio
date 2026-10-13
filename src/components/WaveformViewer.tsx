// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useRef, useEffect, useState, useMemo } from "react";
import { SignalData, WaveformResult } from "../types";
import { Extremes, envelopeOf, extremes, formatSI, toSigned } from "../analysis";
import { drawCurve } from "../plotDraw";
import { plotPalette, useTheme } from "../theme";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Activity,
  TrendingUp,
} from "lucide-react";

// A bus the file wrote signed is drawn as a wave from its two's complement reading: from its bits a signal around
// zero would jump between the bottom and the top of its row. Kept per capture, so its envelope is built once.
const signedWaves = new WeakMap<number[], Float64Array>();
function waveValues(sig: SignalData): ArrayLike<number> {
  if (!sig.signed) return sig.values;
  let wave = signedWaves.get(sig.values);
  if (!wave) {
    wave = Float64Array.from(sig.values, (v) => toSigned(v, sig.width));
    signedWaves.set(sig.values, wave);
  }
  return wave;
}

/** the bits of a bus value as hex text; a negative value is that of a wide bus the file wrote signed */
const hexOf = (v: number, width: number) => `0x${(v < 0 ? v + 2 ** width : v).toString(16).toUpperCase()}`;

interface WaveformViewerProps {
  waveform: WaveformResult | null;
  selectedSignals: string[];
  /** buffer index of the trigger sample of the capture on screen */
  triggerPosition: number;
  samplePeriodNs: number;
  /** show this capture in the Signal Analysis tab */
  onOpenAnalysis: () => void;
}

const ROW_HEIGHT = 44;
const RULER_HEIGHT = 24;
const MIN_VISIBLE_SAMPLES = 16;

export const WaveformViewer: React.FC<WaveformViewerProps> = ({
  waveform,
  selectedSignals,
  triggerPosition,
  samplePeriodNs,
  onOpenAnalysis,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // the canvas colours of the theme on screen; a switch of the theme redraws
  const palette = plotPalette(useTheme());

  // Zoom & Pan state
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [panOffset, setPanOffset] = useState(0); // in samples
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [analogModeMap, setAnalogModeMap] = useState<Record<string, boolean>>({});
  const [containerWidth, setContainerWidth] = useState(0);
  const drag = useRef<{ startX: number; startOffset: number } | null>(null);

  const displayedSignals = useMemo(() => {
    if (!waveform) return [];
    if (selectedSignals.length === 0) return waveform.signals;
    return waveform.signals.filter((s) => selectedSignals.includes(s.name));
  }, [waveform, selectedSignals]);

  const totalSamples = waveform ? waveform.sampleIndices.length : 0;
  const maxZoom = Math.max(1, totalSamples / MIN_VISIBLE_SAMPLES);
  const samplesVisible = Math.max(1, Math.min(totalSamples, Math.max(MIN_VISIBLE_SAMPLES, Math.floor(totalSamples / zoomLevel))));
  const startSample = Math.max(0, Math.min(totalSamples - samplesVisible, Math.floor(panOffset)));
  const endSample = Math.min(totalSamples, startSample + samplesVisible);
  const canvasHeight = Math.max(300, RULER_HEIGHT + displayedSignals.length * ROW_HEIGHT);

  // what is on screen, for the wheel handler: it zooms around the pointer and several steps can arrive before
  // the next render
  const view = useRef({ zoom: 1, start: 0, visible: 1, total: 0 });
  view.current = {
    zoom: zoomLevel,
    start: Math.max(0, Math.min(totalSamples - samplesVisible, panOffset)),
    visible: samplesVisible,
    total: totalSamples,
  };

  const toggleAnalogMode = (name: string) => {
    setAnalogModeMap((prev) => ({
      ...prev,
      [name]: !prev[name],
    }));
  };

  // a new capture can be shorter than the one before it
  useEffect(() => {
    setZoomLevel((z) => Math.min(z, maxZoom));
    setPanOffset((p) => Math.max(0, Math.min(p, Math.max(0, totalSamples - MIN_VISIBLE_SAMPLES))));
  }, [totalSamples, maxZoom]);

  // Track the width of the drawing area. The canvas is sized inside the drawing effect below, because setting
  // canvas.width erases it: sizing in a separate effect wiped the picture right after it had been drawn.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setContainerWidth(container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [waveform !== null]);

  // Ctrl + wheel zooms; the plain wheel scrolls the signal rows. Registered natively because React's onWheel is
  // passive and cannot stop the page from scrolling while zooming.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // one notch of a wheel is about 100; a touchpad sends many small steps and gets a smooth zoom
      const dy = (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1) * e.deltaY;
      if (dy === 0) return;
      const factor = Math.pow(1.25, Math.max(-3, Math.min(3, -dy / 100)));
      // the sample under the pointer stays under the pointer
      const v = view.current;
      const rect = container.getBoundingClientRect();
      const at = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const zoom = Math.max(1.0, Math.min(maxZoom, v.zoom * factor));
      const visible = Math.max(1, Math.min(v.total, Math.max(MIN_VISIBLE_SAMPLES, Math.floor(v.total / zoom))));
      const start = Math.max(0, Math.min(v.total - visible, v.start + at * (v.visible - visible)));
      view.current = { ...v, zoom, start, visible };
      setZoomLevel(zoom);
      setPanOffset(start);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [maxZoom, waveform !== null]);

  // Canvas Drawing Logic. Everything is drawn per pixel column, so the cost and the look do not depend on how
  // many samples share a column: a one-sample pulse still shows as a spike when the whole buffer is on screen.
  // Traces and bus boxes are made of plain rectangles: long anti-aliased paths are slow on a graphics card.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform || containerWidth <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = containerWidth;
    const height = canvasHeight;
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    if (totalSamples === 0 || displayedSignals.length === 0) return;

    const sampleToX = (sIdx: number) => ((sIdx - startSample) / samplesVisible) * width;

    // Draw background grid lines
    ctx.lineWidth = 1;
    const gridStep = Math.max(1, Math.floor(samplesVisible / 10));
    let labelEnd = -Infinity;
    for (let s = startSample - (startSample % gridStep); s <= endSample; s += gridStep) {
      const x = sampleToX(s);
      ctx.strokeStyle = palette.waveGrid;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Time ruler markers
      ctx.fillStyle = palette.waveRulerText;
      ctx.font = "10px monospace";
      const sampleVal = waveform.sampleIndices[s] ?? s;
      // enough digits to tell neighbouring samples apart; a label that would run into the one before is left out
      const timeStr = samplePeriodNs > 0 ? formatSI(sampleVal * samplePeriodNs * 1e-9, "s", 7) : `${sampleVal}`;
      if (x + 4 >= labelEnd) {
        ctx.fillText(timeStr, x + 4, 16);
        labelEnd = x + 4 + ctx.measureText(timeStr).width + 8;
      }
    }

    // Draw ruler separator line
    ctx.strokeStyle = palette.waveRulerLine;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT);
    ctx.lineTo(width, RULER_HEIGHT);
    ctx.stroke();

    // Draw signals
    displayedSignals.forEach((sig, idx) => {
      const yBase = RULER_HEIGHT + idx * ROW_HEIGHT;
      const isAnalog = analogModeMap[sig.name] || false;
      const vals = sig.isBus && isAnalog ? waveValues(sig) : sig.values;

      // Track row separator
      ctx.strokeStyle = palette.waveRowLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yBase + ROW_HEIGHT);
      ctx.lineTo(width, yBase + ROW_HEIGHT);
      ctx.stroke();

      if (!sig.isBus || isAnalog) {
        // 1-bit trace, or a bus drawn as an oscilloscope wave: per pixel column the min..max span
        const env = envelopeOf(vals);
        let minV = 0;
        let maxV = 1;
        if (sig.isBus) {
          const acc: Extremes = { min: Infinity, max: -Infinity };
          extremes(vals, env, startSample, endSample - 1, acc);
          minV = Number.isFinite(acc.min) ? acc.min : 0;
          maxV = Number.isFinite(acc.max) && acc.max > minV ? acc.max : minV + 1;
        }
        const yLow = yBase + ROW_HEIGHT - 10;
        const yHigh = yBase + 8;
        ctx.fillStyle = sig.isBus ? palette.waveAnalog : palette.waveBit;
        drawCurve(
          ctx,
          vals,
          env,
          !sig.isBus, // logic: hold the level, then step; wave: join the samples
          // a wave has its sample in the middle of the sample's cell (where the hover line reads it); a logic
          // level fills the cell from its left edge
          {
            left: 0,
            top: yHigh,
            width,
            height: yLow - yHigh,
            lo: startSample - (sig.isBus ? 0.5 : 0),
            hi: startSample + samplesVisible - (sig.isBus ? 0.5 : 0),
            v0: minV,
            v1: maxV,
          },
          1.6,
          1,
        );
      } else {
        // Multi-bit Bus in Hex Box Mode
        const yTop = yBase + 10;
        const yBot = yBase + ROW_HEIGHT - 10;
        const yMid = (yTop + yBot) / 2;
        ctx.font = "10px monospace";

        let segStart = startSample;
        let currentVal = vals[startSample] ?? 0;
        let lastDensePx = -1;

        for (let s = startSample + 1; s <= endSample; s++) {
          const val = s < endSample ? (vals[s] ?? 0) : null;
          if (val === currentVal) continue;
          const x0 = sampleToX(segStart);
          const x1 = sampleToX(s);
          const w = x1 - x0;

          if (w > 2) {
            // a box per value: tinted, with a line above and below and a bar where the value changes
            const xa = Math.round(x0);
            const xb = Math.round(x1);
            ctx.fillStyle = palette.waveBusFill;
            ctx.fillRect(xa, yTop, xb - xa, yBot - yTop);
            ctx.fillStyle = palette.waveBus;
            ctx.fillRect(xa, yTop, xb - xa, 1);
            ctx.fillRect(xa, yBot - 1, xb - xa, 1);
            ctx.fillRect(xa, yTop, 1, yBot - yTop);

            // Draw value text if space allows
            if (w > 36) {
              ctx.fillStyle = palette.waveBusText;
              ctx.fillText(hexOf(currentVal, sig.width), Math.max(x0, 0) + 6, yMid + 3);
            }
          } else {
            // the value changes faster than the pixels: mark the busy stretch instead of leaving a gap
            const px = Math.floor(x0);
            if (px !== lastDensePx) {
              ctx.fillStyle = palette.waveBusDense;
              ctx.fillRect(px, yTop, 1, yBot - yTop);
              lastDensePx = px;
            }
          }

          segStart = s;
          currentVal = val ?? 0;
        }
      }
    });

    // Trigger line marker
    const trigIdx = waveform.sampleIndices.findIndex((idx) => idx >= triggerPosition);
    if (trigIdx >= startSample && trigIdx <= endSample) {
      const tx = sampleToX(trigIdx);
      ctx.save();
      ctx.strokeStyle = palette.waveTrigger;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx, height);
      ctx.stroke();
      ctx.fillStyle = palette.waveTrigger;
      ctx.font = "bold 10px monospace";
      ctx.fillText("TRIG", tx + 4, RULER_HEIGHT + 14);
      ctx.restore();
    }
  }, [waveform, displayedSignals, containerWidth, canvasHeight, startSample, endSample, samplesVisible, totalSamples, analogModeMap, triggerPosition, samplePeriodNs, palette]);

  // Mouse Interactions
  const handleMouseDown = (e: React.MouseEvent) => {
    drag.current = { startX: e.clientX, startOffset: startSample };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container || !waveform || containerWidth <= 0) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const hovered = Math.floor(startSample + (mouseX / containerWidth) * samplesVisible);
    setHoverIndex(Math.max(0, Math.min(totalSamples - 1, hovered)));

    if (drag.current) {
      const deltaSamples = ((e.clientX - drag.current.startX) / containerWidth) * samplesVisible;
      setPanOffset(Math.max(0, Math.min(totalSamples - samplesVisible, drag.current.startOffset - deltaSamples)));
    }
  };

  const hoverLeft =
    hoverIndex !== null && hoverIndex >= startSample && hoverIndex < endSample
      ? ((hoverIndex - startSample + 0.5) / samplesVisible) * containerWidth
      : null;

  return (
    <div className="card waveform-card">
      <div className="card-header">
        <div className="card-title">
          <Activity size={18} className="text-accent" />
          <h3>Interactive Logic Analyzer Waveform</h3>
        </div>

        <div className="waveform-controls">
          <button
            className="btn btn-tiny"
            onClick={() => setZoomLevel((z) => Math.min(maxZoom, z * 1.3))}
            title="Zoom In (Ctrl + mouse wheel)"
          >
            <ZoomIn size={14} />
          </button>
          <button
            className="btn btn-tiny"
            onClick={() => setZoomLevel((z) => Math.max(1.0, z / 1.3))}
            title="Zoom Out (Ctrl + mouse wheel)"
          >
            <ZoomOut size={14} />
          </button>
          <button
            className="btn btn-tiny"
            onClick={() => {
              setZoomLevel(1.0);
              setPanOffset(0);
            }}
            title="Reset Zoom"
          >
            <RotateCcw size={14} />
          </button>

          <button
            className="btn btn-tiny"
            onClick={onOpenAnalysis}
            title="Plots, cursors, measurements and spectrum of this capture"
          >
            <Activity size={14} />
            <span>Signal Analysis</span>
          </button>
        </div>
      </div>

      <div className="waveform-layout">
        {/* Signal Labels Track on Left */}
        <div className="signals-sidebar">
          <div className="sidebar-header">
            <span>Signals ({displayedSignals.length})</span>
          </div>

          <div className="signals-list">
            {displayedSignals.map((sig) => {
              const currentHoverVal =
                hoverIndex !== null && sig.values[hoverIndex] !== undefined
                  ? sig.values[hoverIndex]
                  : sig.values[0] ?? 0;
              const isAnalog = analogModeMap[sig.name] || false;

              return (
                <div key={sig.fullName} className="signal-row-label">
                  <div className="sig-info">
                    <span className="sig-name" title={sig.fullName}>
                      {sig.name}
                    </span>
                    <span className={`sig-width ${sig.isBus ? "bus" : "bit"}`}>
                      {sig.width > 1 ? `[${sig.width - 1}:0]` : "1b"}
                    </span>
                  </div>

                  <div className="sig-actions">
                    <span className="sig-hover-val">
                      {sig.isBus ? hexOf(currentHoverVal, sig.width) : currentHoverVal}
                    </span>
                    {sig.isBus && (
                      <button
                        className={`btn-mode-toggle ${isAnalog ? "active" : ""}`}
                        onClick={() => toggleAnalogMode(sig.name)}
                        title={isAnalog ? "Switch to Hex Bus" : "Switch to Analog Wave"}
                      >
                        <TrendingUp size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Waveform Canvas on Right */}
        <div
          ref={containerRef}
          className="waveform-canvas-container"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={() => (drag.current = null)}
          onMouseLeave={() => {
            drag.current = null;
            setHoverIndex(null);
          }}
        >
          {waveform ? (
            <>
              <canvas ref={canvasRef} className="waveform-canvas" />
              {hoverLeft !== null && <div className="waveform-hover-cursor" style={{ left: hoverLeft }} />}
            </>
          ) : (
            <div className="empty-state">
              <Activity size={36} className="empty-icon" />
              <p>No waveform capture loaded yet.</p>
              <span>Click "Just Capture (Now)", "Open File" or "Demo Data" to visualize logic signals.</span>
            </div>
          )}
        </div>
      </div>

      {/* Footer Info Bar */}
      {waveform && (
        <div className="waveform-footer">
          <span className="footer-item">
            <strong>Buffer Depth:</strong> {waveform.totalSamples.toLocaleString()} samples
            {waveform.step > 1 ? ` (every ${waveform.step}th shown)` : ""}
          </span>
          <span className="footer-item">
            <strong>Trigger at:</strong> sample {triggerPosition}
          </span>
          {hoverIndex !== null && (
            <span className="footer-item highlight">
              <strong>Sample Index:</strong> {waveform.sampleIndices[hoverIndex] ?? hoverIndex}
            </span>
          )}
          <span className="footer-item" title={waveform.filePath}>
            <strong>Source:</strong> {waveform.filePath}
          </span>
        </div>
      )}
    </div>
  );
};
