// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

import React, { useEffect, useRef, useState } from "react";
import { ProfileInfo } from "../types";
import { Save } from "lucide-react";

/** What the backend answers to a save: done, or "that file is there - ask". */
export interface SaveAnswer {
  saved: boolean;
  exists?: boolean;
  /** the file that holds what the profile's file held before, when a file was replaced */
  kept?: string | null;
  filename: string;
  path: string;
}

interface SaveProfileDialogProps {
  /** the name the field starts with: that of the selected profile if it was saved here, else one to be typed over */
  suggested: string;
  profiles: ProfileInfo[];
  /** the profile the page was started from: saved under its name, it is this file that is replaced */
  selectedPath: string;
  /** what that profile holds beyond the page and passes on to the one saved now, in words; null: nothing */
  inherits: { from: string; what: string } | null;
  /** the capture script uses another export format with the selected profile than the page shows (the page never
   *  took it; a profile that names none means "both" to the script): said, since the saved profile gets the page's */
  formatChange: { profile: string; from: string; to: string } | null;
  /** `file`: the profile file to replace, when the name is that of a listed profile */
  onSave: (name: string, overwrite: boolean, file?: string) => Promise<SaveAnswer>;
  onClose: () => void;
}

/**
 * "Save configuration": the capture page as it stands goes into a profile under a name, and from then on stands
 * in the Profile list. A name that is taken replaces that profile - after saying which.
 */
export const SaveProfileDialog: React.FC<SaveProfileDialogProps> = ({ suggested, profiles, selectedPath, inherits, formatChange, onSave, onClose }) => {
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // the file the backend found to hold a profile of this very name which the list did not show
  const [inTheWay, setInTheWay] = useState<{ name: string; file: string } | null>(null);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    field.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const wanted = name.trim();
  // A listed profile of this name is the one that is saved again: its file, whatever that is called. Of several
  // of one name, the one that is selected.
  const sameName = profiles.filter((p) => String(p.name ?? "").trim().toLowerCase() === wanted.toLowerCase());
  const listed = wanted === "" ? undefined : (sameName.find((p) => p.path === selectedPath) ?? sameName[0]);
  const again = listed !== undefined && listed.path === selectedPath;
  const replaces = listed?.filename ?? (inTheWay && inTheWay.name === wanted ? inTheWay.file : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (wanted === "" || busy) return;
    setBusy(true);
    setError("");
    try {
      const answer = await onSave(wanted, replaces !== null, listed?.filename);
      if (answer.saved) onClose();
      else if (answer.exists) setInTheWay({ name: wanted, file: answer.filename });
      else setError("The configuration was not saved.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal-card save-profile-card" onSubmit={submit}>
        <div className="modal-header">
          <h3>Save configuration</h3>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <label className="save-profile-label" htmlFor="save-profile-name">
            Name
          </label>
          <input
            id="save-profile-name"
            ref={field}
            className="text-input save-profile-name"
            value={name}
            maxLength={80}
            autoFocus
            spellCheck={false}
            placeholder="e.g. my-board adc capture"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="save-profile-note">
            Saved as a profile in the folder <code>profiles</code> next to the program, to be selected in the Profile list
            from then on. It holds the settings of the tab "ILA Capture &amp; Trigger Rules": hw_server, probe file, device,
            JTAG clock, Tcl script, the selected ILA core, the capture mode with its trigger, position, timeout, export
            format and sample period, the capture name, the number formats of the buses, and Twin Turbo.
          </p>
          <p className="save-profile-note">
            Not part of it: the plots of the Signal Analysis and the theme, which are remembered on this PC by themselves,
            and the signals ticked for the viewer. To remove a profile, delete its file in that folder; to rename one,
            save it under the new name and delete the old file.
          </p>
          {inherits && (
            <p className="save-profile-note save-profile-inherits">
              Built on the selected profile "{inherits.from}": what that holds beyond the page goes along - {inherits.what}.
              For a profile of the page alone, select "-- Custom Configuration --" first.
            </p>
          )}
          {formatChange && (
            <p className="save-profile-note save-profile-format">
              The export format is the page's: "{formatChange.to}", where the capture script uses "{formatChange.from}" with
              the profile "{formatChange.profile}" - also for runs of the capture script with the saved profile. To keep "
              {formatChange.from}", choose it under Export Format before saving.
            </p>
          )}
          {replaces !== null &&
            (again ? (
              <p className="save-profile-note save-profile-again">
                Saves the selected profile again (<code>profiles\{replaces}</code>). What the file holds now is kept beside it.
              </p>
            ) : (
              <p className="save-profile-warn">
                <b>profiles\{replaces}</b> holds {listed ? `the profile "${listed.name}"` : "a profile of this name"}: saving
                replaces that profile. What the file holds now is kept beside it.
              </p>
            ))}
          {error !== "" && <p className="save-profile-error">{error}</p>}
        </div>
        <div className="modal-footer save-profile-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={wanted === "" || busy}>
            <Save size={15} />
            <span>{busy ? "Saving..." : replaces !== null && !again ? "Replace" : "Save"}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
