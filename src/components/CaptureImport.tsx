// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, FolderOpen } from "lucide-react";

interface CaptureImportProps {
  /** the files and folders that were chosen; which of them are captures is for the receiver to find out */
  onImport: (paths: string[]) => void;
}

// The first dialog of a session starts in the folder the captures are written to; after that Windows remembers
// where the last one was left.
let startedInCaptures = false;

/**
 * "Import": brings captures that are on disk into the list the navigator steps through - several files at once,
 * or everything in a folder (a session folder, or the folder that holds the sessions).
 */
export const CaptureImport: React.FC<CaptureImportProps> = ({ onImport }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  // closes on a click elsewhere and on Escape; that click must not also place a cursor in a plot
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        e.stopPropagation();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const choose = async (folder: boolean) => {
    setOpen(false);
    let defaultPath: string | undefined;
    if (!startedInCaptures) {
      defaultPath = await invoke<string>("captures_folder").catch(() => undefined);
    }
    try {
      const chosen = await openDialog(
        folder
          ? { directory: true, multiple: true, defaultPath, title: "Import every capture in a folder" }
          : {
              multiple: true,
              defaultPath,
              title: "Import capture files",
              filters: [{ name: "ILA capture", extensions: ["csv", "gz", "ila"] }],
            },
      );
      const paths = chosen === null ? [] : Array.isArray(chosen) ? chosen : [chosen];
      if (paths.length > 0) {
        startedInCaptures = true;
        onImport(paths);
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <span className="capture-import" ref={rootRef}>
      <button
        className={`btn btn-secondary btn-sm capture-import-btn ${open ? "on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Bring captures from disk into this list, to look at them again: several files, or a whole folder"
      >
        <FolderOpen size={13} />
        <span>Import</span>
      </button>
      {open && (
        <div className="capture-import-menu">
          <button className="capture-import-row" onClick={() => void choose(false)}>
            <FileText size={13} />
            <span>
              Capture files...
              <em>.csv, .csv.gz or .ila - several at once</em>
            </span>
          </button>
          <button className="capture-import-row" onClick={() => void choose(true)}>
            <FolderOpen size={13} />
            <span>
              A folder...
              <em>every capture in it: one session, or all sessions</em>
            </span>
          </button>
        </div>
      )}
    </span>
  );
};
