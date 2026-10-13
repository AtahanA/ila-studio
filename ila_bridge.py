#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

"""Bridge between the ILA Studio GUI (Tauri) and the Vivado ILA capture driver (ila_capture.py).

Offline commands print one JSON document on stdout:
  list-profiles | parse-ltx | parse-csv | demo-capture

Hardware commands (query-hardware, capture, run-tcl) take seconds to minutes, so they talk line by line:
  every progress line is printed as it happens (and appended to ila_log.txt),
  "@@CAPTURE <json>" announces each capture file the moment it is on disk,
  "@@RESULT <json>"  is the final answer; it is the last line before the process ends.
The GUI stops a hardware command by creating the file given with --stop-file: the capture loop and the Tcl side
both watch for it, so the Vivado session still ends in order and the JTAG cable is left the way it was found.

"serve" is how the GUI runs them: one process that stays up and takes one job after the other from stdin, each a
line of JSON  {"argv": [<the command line of a hardware command>], "stop_file": "<path>"}  and answered the same
way as above. The Vivado session opened by the first job is KEPT for the next ones - starting Vivado and opening
the target is 9 of the 11 seconds a single capture takes - until a {"argv": ["disconnect"]} job, a job with other
hardware settings, or the end of stdin (the GUI has gone). "@@STATE <json>" says whenever a session opens or closes.

What the GUI uses: the four offline commands, each as a process of its own, and through "serve" the jobs
query-hardware, capture and disconnect. run-tcl is not sent by the GUI: it is there for the command line
(python ila_bridge.py run-tcl --tcl <script> ...), where it sources a script of one's own in a Vivado batch session.

--engines N (the GUI's "Twin Turbo" is 2): the session runs N Vivado processes on the one ILA. In a run of several
windows each of them writes its file while the next one is already capturing the next window; a single capture and
everything else is done by the first one. See fresh_session and cmd_capture.
"""
import argparse
import concurrent.futures
import csv
import datetime
import json
import math
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import threading
import types
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILES_DIR = os.path.join(HERE, "profiles")
CAPTURES_DIR = os.path.join(HERE, "captures")
LOG_FILE = os.path.join(HERE, "ila_log.txt")
LOG_MAX_BYTES = 4 * 1024 * 1024
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def driver():
    """ila_capture is imported on demand: the offline commands run at every GUI start and do not need it."""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import ila_capture
    return ila_capture


def bridge_log(msg):
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_MAX_BYTES:
            with open(LOG_FILE, "rb") as f:               # keep the recent half instead of growing forever
                f.seek(-LOG_MAX_BYTES // 2, os.SEEK_END)
                tail = f.read()
            with open(LOG_FILE, "wb") as f:
                f.write(tail[tail.find(b"\n") + 1:])
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


OUT_LOCK = threading.Lock()


def say(text):
    """One line to the application - a whole one, also while another thread writes (Vivado's output and the
    file work of a run of windows arrive on threads of their own, and half a "@@CAPTURE" line is none).
    When the application has been killed its pipe is gone, and a job must then still end in order - Vivado
    closed, the cable's clock put back - instead of dying on its next progress line."""
    try:
        with OUT_LOCK:
            sys.stdout.write(text + chr(10))
            sys.stdout.flush()
    except (OSError, ValueError):
        pass


def emit(tag, obj):
    say(f"{tag} {json.dumps(obj)}")


# ---------------------------------------------------------------- offline: probe file
NET_INDEX_RE = re.compile(r"\[(\d+)\]$")


def parse_ltx_file(ltx_path):
    """Cores and probes of a Vivado .ltx probe file, plus the debug hub clock, which bounds the JTAG clock:
    TCK has to stay below hub clock / 2.5 or the core cannot be driven."""
    if not ltx_path or not os.path.exists(ltx_path):
        return {"error": f"LTX file not found: {ltx_path}", "cores": [], "probes": []}
    try:
        root = ET.parse(ltx_path).getroot()
    except Exception as e:
        return {"error": f"Failed to parse LTX: {e}", "cores": [], "probes": []}

    cores, probes, hub_hz = {}, [], 0
    for probe_elem in root.iter("probe"):
        opt = {o.get("Id") or o.get("id"): o.get("value") for o in probe_elem.iter("Option")}
        if (probe_elem.get("type") or "ila").lower() != "ila":
            continue                                       # VIO probes cannot be captured or triggered on
        core = opt.get("HW_ILA") or "hw_ila_1"
        # the capture depth is a property of the core in the bitstream; the probe file does not carry it
        # "cell" is what the core is chosen by on the device (--ila-cell): empty where the file does not name it
        cores.setdefault(core, {"name": core, "cell": opt.get("HW_ILA") or "", "depth": 0})
        try:
            hz = int(opt.get("HUB_CLK_INPUT_FREQ_HZ") or 0)
        except ValueError:
            hz = 0
        if hz > 0 and (hub_hz == 0 or hz < hub_hz):
            hub_hz = hz
        nets = [n.get("name") for n in probe_elem.iter("net") if n.get("name")]
        if not nets:
            continue
        try:
            port = int(opt.get("PROBE_PORT") or 0)
        except ValueError:
            port = 0
        try:
            width = int(opt.get("PROBE_PORT_BIT_COUNT") or 0)
        except ValueError:
            width = 0
        width = max(width, len(nets))
        base = NET_INDEX_RE.sub("", nets[0])
        if width > 1:
            idx = [int(m.group(1)) for m in (NET_INDEX_RE.search(n) for n in nets) if m]
            hi, lo = (max(idx), min(idx)) if len(idx) == len(nets) else (width - 1, 0)
            full = f"{base}[{hi}:{lo}]"                    # the name Vivado uses as the CSV column header
        else:
            base, full = nets[0], nets[0]
        probes.append({"name": base.split("/")[-1], "fullName": full, "width": width, "isBus": width > 1,
                       "core": core, "port": port})
    return {"cores": list(cores.values()), "probes": probes, "hubClockHz": hub_hz,
            "maxSafeTckHz": int(hub_hz / 2.5) if hub_hz else 0}


# ---------------------------------------------------------------- offline: profiles
# The sections of a profile: the keys that hold a JSON object, which are those of DEFAULT_PROFILE in the driver.
# They are written out here because the list is read at every start of the GUI, without the driver (see driver).
PROFILE_SECTIONS = ("tools", "hardware", "capture", "hook", "stats")


def list_profiles():
    profiles = []
    if os.path.isdir(PROFILES_DIR):
        for fname in sorted(os.listdir(PROFILES_DIR)):
            if not fname.endswith(".json"):
                continue
            p_path = os.path.join(PROFILES_DIR, fname)
            entry = {"filename": fname, "path": p_path, "name": fname[:-5], "comment": "", "data": {},
                     "ltxExists": False, "mtime": os.path.getmtime(p_path)}
            try:
                with open(p_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # JSON, but no profile: listed with the sentence a job with this file would be refused with (see
                # load_profile in the driver), not with the AttributeError of the lines below
                if not isinstance(data, dict):
                    raise ValueError("this is no profile: the file must hold one JSON object, { ... }")
                for key in PROFILE_SECTIONS:
                    if key in data and not isinstance(data[key], dict):
                        raise ValueError(f'"{key}" must be a JSON object, {{ ... }}')
                ltx = (data.get("hardware") or {}).get("ltx") or ""
                # a profile is a file anyone can edit: a name or a comment that is no text is not passed on as one
                name, comment = data.get("name"), data.get("_comment")
                entry.update(name=name.strip() if isinstance(name, str) and name.strip() else fname[:-5],
                             comment=comment if isinstance(comment, str) else "", data=data,
                             ltxExists=bool(ltx) and os.path.exists(ltx if os.path.isabs(ltx)
                                                                    else os.path.join(HERE, ltx)))
            except Exception as e:
                entry["error"] = str(e)
            profiles.append(entry)
    return profiles


# ---------------------------------------------------------------- offline: capture files
META_COLUMNS = ("sample in buffer", "sample in window")


def parse_csv_capture(path, max_samples=4096):
    """An ILA capture (.csv, .csv.gz or .ila) as waveform channels, thinned to max_samples points for display."""
    if not os.path.exists(path):
        return {"error": f"File not found: {path}"}
    try:
        header, rows, radix = driver().load_ila(path)
    except Exception as e:
        return {"error": f"Not a readable ILA capture: {e}"}
    if not rows:
        return {"error": "The capture file holds no samples (header only)."}

    total = len(rows)
    step = max(1, math.ceil(total / max_samples)) if max_samples > 0 else 1
    shown = rows[::step]
    signals, trigger_sample = [], None
    for col, raw_name in enumerate(header):
        name = raw_name.strip()
        if col == 0 or name.lower() in META_COLUMNS:
            continue
        base = 16 if radix.get(col) == "hex" else 10       # int() takes "0x1F" with base 16 as well
        if name.upper() == "TRIGGER":                      # Vivado marks the trigger sample with a 1 here
            for r in rows:
                if col < len(r) and r[col].strip() == "1":
                    trigger_sample = int(r[0])
                    break
            continue
        m = re.search(r"\[(\d+):(\d+)\]$", name)
        width = abs(int(m.group(1)) - int(m.group(2))) + 1 if m else 1
        values = []
        for r in shown:
            try:
                values.append(int(r[col].strip(), base))
            except (ValueError, IndexError):
                values.append(0)
        # A bus column written signed (see "probe format") is handed on as what every other column is: the bits
        # of the probe as an unsigned number. Viewer and analysis then work as with any capture, and "signed"
        # tells the analysis how the file itself read the bus.
        signed = False
        if width > 1:
            signed = any(v < 0 for v in values) or (
                step > 1 and base == 10 and any(col < len(r) and r[col].lstrip().startswith("-") for r in rows))
            if signed and width <= 53:
                values = [v % (1 << width) for v in values]
        if width > 53:                                     # beyond what a JSON/JavaScript number holds exactly;
            # an integer that size would not even parse downstream (and one past 2^1023 not even as a float).
            # A bus this wide that the file wrote signed is handed on as it stands: -30 is exact, its bits
            # (2^64 - 30) are not - the readers know a negative value of a signed bus for what it is.
            values = [float(max(min(v, 1 << 1023), -(1 << 1023))) for v in values]
        short = re.sub(r"\[\d+:\d+\]$", "", name).split("/")[-1]
        signals.append({"name": short, "fullName": name, "width": width, "isBus": width > 1, "values": values,
                        "signed": signed})
    return {"filePath": path, "totalSamples": total, "displayedSamples": len(shown), "step": step,
            "sampleIndices": [int(r[0]) for r in shown], "signals": signals, "triggerSample": trigger_sample}


def create_demo_capture(out_dir=CAPTURES_DIR, samples=2048):
    """A synthetic capture for trying the UI without hardware."""
    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file = os.path.join(out_dir, f"demo_ila_{stamp}.csv")
    header = ["Sample in Buffer", "Sample in Window", "TRIGGER", "u_top/clk_en", "u_top/reset_n",
              "u_top/trigger_event", "u_top/fsm_state[3:0]", "u_top/tx_data_bus[15:0]",
              "u_top/adc_data[15:0]", "u_top/rx_valid", "u_top/error_flag"]
    rows, tx_val = [], 0x100
    for i in range(samples):
        state = ((i - 500) // 50) % 6 if i >= 500 else 0
        if state in (3, 4):
            tx_val = (tx_val + 7) & 0xFFFF
        envelope = 1.0 + 0.5 * math.sin(2.0 * math.pi * i / 1024.0)
        adc = max(0, min(4095, int(1800 + 1200 * math.sin(2.0 * math.pi * i / 128.0) * envelope + (i % 37) * 4)))
        rows.append([i, i, int(i == 500), int(i % 2 == 0), int(i >= 16), int(500 <= i <= 504), state, tx_val, adc,
                     int(i % 8 == 0 and state != 0), int(i in (1200, 1201))])
    with open(out_file, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return out_file


# ---------------------------------------------------------------- hardware
def concise_error(e):
    """The part of a driver error a person can act on: the Tcl-side reason, without the echoed command line."""
    text = str(e)
    m = re.search(r"failed: (.*)$", text, re.S)
    text = (m.group(1) if m else text).strip().strip("|").strip()
    text = re.sub(r"^ERROR:\s*", "", text)
    return text or type(e).__name__


# ---- the session that stays open between jobs (serve mode) --------------------------------------------------
KEEP = False        # set by "serve": the Vivado session outlives the job that opened it
KEPT = None         # {"viv": the Repl, "extra": the further Repls, "key": what it was opened with,
                    #  "info": ila_info as a dict, "url": server, "solo": why it has one engine only, or ""}
# A session may run more than one Vivado ("Twin Turbo" in the GUI, --engines): in a run of several windows each
# of them writes its file while the next one is already capturing. The first one is the session - it set the
# cable up and puts it back; the further ones ("extra") come and go with what a job asks for.
MAX_ENGINES = 3
# A run "until stopped" (--count 0) ends by itself after this many windows - a day or two at one to two seconds
# a window - so that a run nobody is watching does not go on filling one folder for ever. Its answer says so.
MAX_WINDOWS = 100000
# Capture failures that say something about the request or the signal, not about the session: a fresh session
# would fail the same way.
ASKED_WRONG = re.compile(r"not triggered within|stopped by user|not found - see ila_probes|compare_value|"
                         r"20-1476|trigger must be|ILA index \d+ does not exist|did not fill within|"
                         r"not a probe of the selected|not found on the selected|fits several probes|"
                         r"no probe of this device is called|is not on the device", re.I)


def stamp():
    return f"{datetime.datetime.now():%H:%M:%S}"


def idle_log(msg, quiet=False):
    """Where a kept Vivado's output goes while no job owns it: the log file and the GUI's log, no session folder."""
    bridge_log(msg)
    say(f"{stamp()} {msg}")


def announce_state(reason=""):
    info = KEPT["info"] if KEPT else {}
    try:
        tck = int(info.get("JTAG_FREQ_HZ") or 0)
    except ValueError:
        tck = 0
    emit("@@STATE", {"connected": KEPT is not None, "device": info.get("DEVICE", ""), "tckHz": tck,
                     "server": KEPT["url"] if KEPT else "", "reason": reason,
                     "engines": 1 + len(KEPT["extra"]) if KEPT else 0, "core": info.get("CELL_NAME", "")})


def session_key(s, prof):
    """Everything a Vivado session was opened with: a job that differs in any of it needs a new session.
    Which ILA core of the device a job captures is not part of it: one session holds every core of the device,
    and changes core in a fraction of a second (see open_session)."""
    hw = prof["hardware"]
    ltx = hw.get("ltx") or ""
    try:
        st = os.stat(ltx)
        written = (st.st_mtime_ns, st.st_size)             # a new build writes a new probe file under the old name
    except OSError:
        written = None
    tcl = driver().resolve_tcl(getattr(s.args, "tcl", None))
    try:
        st = os.stat(tcl)
        script = (tcl, st.st_mtime_ns, st.st_size)         # an edited script is sourced by a new Vivado only
    except OSError:
        script = (tcl, None, None)
    return (hw.get("url"), os.path.normcase(os.path.abspath(ltx)), written, hw.get("device_filter") or "*",
            hw.get("target_filter") or "*", int(hw.get("jtag_frequency_hz") or 0),
            script, str((prof.get("tools") or {}).get("vivado") or ""))


def drop_kept(reason):
    """Close the kept session in order - the Tcl side then puts the cable's JTAG clock back - and say so."""
    global KEPT
    if not KEPT:
        return
    kept, KEPT = KEPT, None
    # the further engines first, the first one last: it puts the cable's clock back, and that must come last
    driver().hand_over_cable(kept["viv"], kept["extra"])    # ... unless it is gone: then the last of the others
    for viv in list(kept["extra"]) + [kept["viv"]]:
        viv.log = idle_log
        try:
            viv.close()
        except Exception as e:                             # it is going either way
            bridge_log(f"closing the kept session: {e}")
    bridge_log(f"hardware session closed: {reason}")
    try:
        announce_state(reason)
    except OSError:                                        # the application has gone and taken its pipe along
        pass


def open_session(s, prof):
    """The Vivado session for this job; returns what ila_open / ila_info reports. One-shot commands open their
    own. In serve mode the kept one is used when it was opened with the same settings and still answers - the
    device is looked at again first - and a newly opened one is kept. Either way the session has as many Vivado
    engines as the job asks for (--engines) when this returns, or fewer where one could not be started."""
    global KEPT
    if not KEEP:
        return fresh_session(s, prof, wanted_engines(s))
    key = session_key(s, prof)
    if KEPT and (KEPT["viv"].dead or KEPT["viv"].p.poll() is not None):
        s.log("the hardware session that was kept open has ended; connecting again")
        drop_kept("the Vivado session had ended")
    elif KEPT and KEPT["key"] != key:
        s.log("the hardware settings changed: closing the open session and connecting with the new ones")
        drop_kept("the hardware settings changed")
    if KEPT:
        viv = KEPT["viv"]
        drop_dead_engines()                                # one that ended a moment ago does not take the rest along
        try:
            for r in [viv] + KEPT["extra"]:
                r.log = s.log
                r.cmd(f"set ::STOP_FILE {driver().tcl_path(s.stop_file)}", timeout=60)
            info = viv.cmd("ila_recheck", timeout=180)
            for r in KEPT["extra"]:                        # each Vivado has its own picture of the device
                r.cmd("ila_recheck", timeout=180)
        except RuntimeError as e:
            s.log(f"the open hardware session cannot be used any more ({concise_error(e)}); connecting again")
            drop_kept("it no longer answered")
        else:
            s.viv, s.extra = viv, KEPT["extra"]            # the same list: an engine that joins is kept as well
            s.reused = True                                # see cmd_capture: its first failure gets a second try
            # The core this job asks for, on every engine - each Vivado has its own. A core that is not on the
            # device is the job's mistake, not the session's: it is answered, and the session stays as it is.
            before = KEPT["info"].get("CELL_NAME", "")
            info = s.select_core(viv)
            for r in s.extra:
                s.select_core(r)
            KEPT["info"] = info_dict(info)
            s.log(f"using the open hardware session - ILA: {info}")
            if KEPT["info"].get("CELL_NAME", "") != before:
                announce_state("core")
            for r in [viv] + s.extra:
                s.sync_probe_radix(r)                      # the last job may have had other probes signed
            return match_engines(s, prof, info)
    s.reused = False
    return fresh_session(s, prof, wanted_engines(s))


def wanted_engines(s):
    try:
        return max(1, min(MAX_ENGINES, int(getattr(s.args, "engines", 1) or 1)))
    except (TypeError, ValueError):
        return 1


def can_take_turns(s):
    """Whether further engines may be used with the REPL script of this session: it must be able to keep an
    upload apart from its write, and must know that a further engine leaves the cable's clock alone when it
    goes. With a script that does not - one's own, or an older copy - a further engine would be of no use, and
    would put the cable back to what IT found when it closes, under the first engine that is still working."""
    return not ({"ila_capture_keep", "::JTAG_LEAVE"} & set(getattr(s.viv, "lacks", ())))   # see check_script


def stay_solo(s, why):
    """This session has one engine and keeps it at that, whatever later jobs ask for: starting a further one
    again with every job would cost its ten seconds each time - and where connecting it is what failed, move the
    cable's clock about each time. A session opened anew (Disconnect, other settings) tries again."""
    s.solo = why
    if KEEP and KEPT:
        KEPT["solo"] = why


def fresh_session(s, prof, engines, solo=""):
    """A new Vivado session with that many engines; in serve mode it is kept. The processes of the further
    engines are started while the first one connects - a start takes about four seconds and touches nothing -
    and they connect one after the other once the first one is done.
    A further engine that cannot connect ends the attempt: where the cable runs at a frequency Vivado cannot
    represent, connecting sets the cable's clock anew (see ila_connect in the Tcl script), so after a connect
    that broke off nobody knows what the first engine is working with. Everything is closed then, and the
    session opened again with the first engine alone.
    solo: why this session is to stay with one engine (see stay_solo)."""
    global KEPT
    starting, pool = [], None
    if engines > 1:
        s.log(f"{engines} Vivado engines: one writes its file while the next one captures")
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=engines - 1, thread_name_prefix="engine")
        starting = [pool.submit(s.start_extra_vivado, f"-{i + 2}") for i in range(engines - 1)]

    def started():
        """the processes that came up, and why the others did not"""
        up, why = [], ""
        for f in starting:
            try:
                up.append(f.result())
            except Exception as e:
                why = concise_error(e)
        if pool:
            pool.shutdown(wait=False)
        return up, why

    try:
        info = s.open_vivado()                             # on failure s.viv is closed by end_session, not kept
    except BaseException:
        for r in started()[0]:                             # nothing to connect them to
            r.close()
        raise
    if KEEP:
        KEPT = {"viv": s.viv, "extra": s.extra, "key": session_key(s, prof), "info": info_dict(info),
                "url": prof["hardware"].get("url", ""), "solo": ""}
        announce_state("connected")
    stay_solo(s, solo)
    up, why = started()
    if why:
        s.log(f"WARNING a further Vivado engine did not start ({why}): going on without it")
        stay_solo(s, f"a further Vivado engine did not start ({why})")
    if up and not can_take_turns(s):
        s.log("NOTE this Tcl script cannot take turns between Vivado engines: going on with one")
        stay_solo(s, "the Tcl script of this session cannot take turns between Vivado engines")
        for r in up:                                       # started, never connected to anything
            r.close()
        up = []
    broken = ""
    for r in up:
        if broken:
            r.close()
            continue
        try:
            s.attach_extra_vivado(r)                       # joins s.extra, and with it the kept session
        except RuntimeError as e:
            broken = concise_error(e)
    if broken:
        s.log(f"WARNING a further Vivado engine could not connect ({broken}): connecting again with one engine")
        close_engines(s, "a further Vivado engine could not connect")
        return fresh_session(s, prof, 1, solo=f"a further Vivado engine could not connect ({broken})")
    if KEEP and s.extra:
        announce_state("engines")
    return info


def close_engines(s, reason):
    """Every Vivado of this job's session, in order - the kept session, when that is the one."""
    if KEEP and KEPT and s.viv is KEPT["viv"]:
        s.viv, s.extra = None, []
        drop_kept(reason)
        return
    for r in list(s.extra) + [s.viv]:
        if r:
            r.close()
    s.viv, s.extra = None, []


def match_engines(s, prof, info):
    """The open session with as many Vivado engines as this job asks for: one too many is closed (it leaves the
    cable's clock alone, see attach_extra_vivado), a missing one is started and connected."""
    want, changed = wanted_engines(s), False
    if want == 1:
        stay_solo(s, "")                                   # asked for one: asking for more later is a new try
    s.solo = KEPT.get("solo", "") if KEEP and KEPT else getattr(s, "solo", "")
    if want - 1 > len(s.extra) and not s.solo and not can_take_turns(s):
        stay_solo(s, "the Tcl script of this session cannot take turns between Vivado engines")
    if want - 1 > len(s.extra) and s.solo:
        s.log(f"NOTE this session stays with {1 + len(s.extra)} Vivado engine(s): {s.solo}. "
              f"Untick Twin Turbo for a capture, or disconnect and connect, to try again.")
        want = 1 + len(s.extra)
    while len(s.extra) > want - 1:
        r = s.extra.pop()
        s.log(f"closing Vivado engine {len(s.extra) + 2}: this job runs with {want}")
        r.close()
        changed = True
    while len(s.extra) < want - 1:
        number = len(s.extra) + 2
        s.log(f"starting Vivado engine {number} (about ten seconds)")
        try:
            r = s.start_extra_vivado(f"-{number}")
        except RuntimeError as e:
            s.log(f"WARNING Vivado engine {number} did not start ({concise_error(e)}): going on without it")
            stay_solo(s, f"a further Vivado engine did not start ({concise_error(e)})")
            break
        try:
            s.attach_extra_vivado(r)
        except RuntimeError as e:                          # see fresh_session: the cable is in doubt now
            s.log(f"WARNING Vivado engine {number} could not connect ({concise_error(e)}): "
                  f"connecting again with one engine")
            close_engines(s, "a further Vivado engine could not connect")
            s.reused = False
            return fresh_session(s, prof, 1, solo=f"a further Vivado engine could not connect ({concise_error(e)})")
        changed = True
    if changed and KEEP and KEPT:
        announce_state("engines")
    return info


def end_session(s):
    """The job is over. One-shot: close Vivado. Serve mode: Vivado stays for the next job, unless it has died."""
    if not s:
        return
    if KEEP and KEPT and s.viv is KEPT["viv"]:
        viv, s.viv, s.extra = s.viv, None, []              # s.close() below must not end them
        if viv.dead or viv.p.poll() is not None:
            drop_kept("the Vivado session ended")
        else:
            viv.log = idle_log
            for r in KEPT["extra"]:
                r.settle()                                 # a file it is still writing belongs to this job
                r.log = idle_log
            drop_dead_engines()
    s.close()
    if getattr(s, "logf", None):                           # one session folder per job: do not collect open files
        try:
            s.logf.close()
        except OSError:
            pass
        s.logf = None


def drop_dead_engines():
    """A further engine of the kept session that has ended (crashed, killed) leaves it; the session goes on
    with the others, and the next job that asks for more starts a new one."""
    gone = [r for r in KEPT["extra"] if r.dead or r.p.poll() is not None] if KEPT else []
    for r in gone:
        KEPT["extra"].remove(r)
        r.log = idle_log
        r.close()
    if gone:
        bridge_log(f"{len(gone)} further Vivado engine(s) had ended")
        try:
            announce_state("a Vivado engine ended")
        except OSError:
            pass


def answer(s, result):
    """The job's result and the end of its session, in the order that suits the mode: a one-shot command answers
    first, because closing Vivado takes a few seconds; in serve mode nothing is closed, and a session that has
    died must be reported (@@STATE) before the answer, while the GUI is still listening."""
    if KEEP:
        end_session(s)
        emit("@@RESULT", result)
    else:
        emit("@@RESULT", result)
        end_session(s)


def job_profile(a):
    """The profile a job runs with: the file --profile names laid over the built-in defaults, or the defaults
    alone when the job names none - which is what the page sends for "-- Custom Configuration --".
    A file that is named and is not there is no reason to go on with the defaults: what the page does not send
    itself comes from the profile - which Vivado, which cable of a hw_server with several, the folder of the
    captures - and a job that drops all of that without a word captures through another cable or into another
    folder. RuntimeError, as a sentence that names the file, for that and for a file that is no profile."""
    path = a.profile or None
    if path and not os.path.isfile(path):
        raise RuntimeError(f"profile not found: {path}")
    try:
        return driver().load_profile(path)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{path}: invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}")
    except ValueError as e:                                # JSON, but no profile: the driver's sentence
        raise RuntimeError(str(e))


def make_session(a, ephemeral):
    """A driver Session whose every log line also goes to stdout (live progress in the GUI) and ila_log.txt."""
    ic = driver()

    class GuiSession(ic.Session):
        log_lock = threading.Lock()

        def log(self, msg, quiet=False):
            line = f"{datetime.datetime.now():%H:%M:%S} {msg}"
            with self.log_lock:
                if self.logf:
                    self.logf.write(line + "\n")
                    self.logf.flush()
                bridge_log(msg)
            say(line)

    ns = types.SimpleNamespace(
        ltx=a.ltx or None, server=a.server or None, device=a.device or None, ila_index=a.ila_index,
        jtag_hz=a.jtag_hz, tcl=None, target=getattr(a, "target", "unit"), out=getattr(a, "out", None),
        trigger=getattr(a, "trigger", None) or None, position=getattr(a, "position", None),
        format=getattr(a, "format", None), engines=getattr(a, "engines", 1),
        ila_cell=getattr(a, "ila_cell", "") or None)
    prof = ic.apply_overrides(job_profile(a), ns)
    hw, cap = prof["hardware"], prof["capture"]
    # The driver's check of an address, the one the command line goes by as well. The session would apply it by
    # itself; it is asked here because the log line and the reachability check below come before the session.
    hw["url"] = ic.normalise_url(hw.get("url"))
    if not hw.get("ltx"):
        raise RuntimeError("no probe file (.ltx) given - it is what names the probes of the bitstream on the board")
    if not os.path.isabs(hw["ltx"]):
        hw["ltx"] = os.path.abspath(os.path.join(HERE, hw["ltx"]))
    if not os.path.isfile(hw["ltx"]):
        raise RuntimeError(f"probe file not found: {hw['ltx']}")
    # The Tcl script of the session (ns.tcl: its full path, or None for the bundled one). --tcl decides wherever
    # it is given: a script that is named has to be there, and an empty one IS the bundled script - that is how
    # an emptied Tcl script field can mean the bundled script while the selected profile names another. Only a
    # job that does not say (no --tcl) uses the script of the profile, tools.tcl_script. Should that one be
    # missing, the bundled script is used after all, and the job says so: a profile saved on another PC names a
    # path of that PC, and failing here would leave no way to use it short of editing the file.
    script_missing = ""
    if a.tcl is not None:
        ns.tcl = ic.resolve_tcl(a.tcl.strip()) if a.tcl.strip() else None
    else:
        named = str(prof["tools"].get("tcl_script") or "").strip()
        try:
            ns.tcl = ic.resolve_tcl(named) if named else None
            ns.tcl_of_profile = bool(named)                # check_script: whose script it is, should it be older
        except RuntimeError:
            script_missing = (f"The Tcl script {named} that the profile names (tools.tcl_script) was not found: "
                              f"the bundled one is used instead")
    if not os.path.isabs(cap.get("out") or ""):
        cap["out"] = os.path.join(HERE, cap.get("out") or "captures")
    if getattr(a, "timeout_min", None):
        cap["timeout_min"] = a.timeout_min
    if getattr(a, "position", None) is not None:           # the driver takes the position from here; 0 is one too
        cap["position"] = a.position
    if ns.format:                                          # ... and checks the format it finds here: the job's
        cap["format"] = ns.format
    if getattr(a, "probe_formats", None) is not None:
        # the GUI's choice per probe, whole: it replaces what the profile says, so that nothing is written in a
        # format the probe list does not show
        try:
            chosen = json.loads(a.probe_formats)
            if not isinstance(chosen, dict):
                raise ValueError("not a list of probes")
            cap["probe_format"] = chosen
            cap["radix"] = "UNSIGNED"                      # ... and so does a radix for all buses in a profile
        except ValueError as e:
            raise RuntimeError(f"the probe formats could not be read: {e}")
    try:
        formats = ic.probe_format_map(cap.get("probe_format"))
    except ValueError as e:
        raise RuntimeError(str(e))
    bridge_log(f"---- {'query' if ephemeral else 'capture'}: server={hw['url']} ltx={hw['ltx']} "
               f"device={hw.get('device_filter')} ila={hw.get('ila_index')} tck={hw.get('jtag_frequency_hz')}"
               + (f" core={hw['ila_cell']}" if hw.get("ila_cell") else "")
               + ("" if ephemeral else f" trigger={{{ns.trigger or cap.get('trigger')}}}")
               + (f" engines={ns.engines}" if isinstance(ns.engines, int) and ns.engines > 1 else "")
               + ("" if ephemeral or not formats else " formats=" + ",".join(
                   f"{n.split('/')[-1]}:{f}" for n, f in sorted(formats.items()))))
    check_reachable(hw["url"])                           # before a session folder is created for nothing
    s = GuiSession(ns, prof, ephemeral=ephemeral)
    if a.stop_file:                                        # the GUI's stop signal instead of the session's own
        s.stop_file, s.own_stop_file = a.stop_file, False
    s.script_missing = script_missing                      # for the answer of the job as well, see script_note
    if script_missing:
        s.log(f"NOTE {script_missing}")
    return s, prof


def check_reachable(url):
    """Fail in three seconds with a plain sentence instead of after Vivado's own 20 s connect timeout."""
    if url.count(":") > 1 and not url.startswith("["):
        return                                             # a bare IPv6 address: leave the judging to Vivado
    m = re.match(r"^\[?(.*?)\]?:(\d+)$", url)
    host, port = (m.group(1), int(m.group(2))) if m else (url, 3121)
    try:
        socket.create_connection((host, port), timeout=3).close()
    except OSError as e:
        raise RuntimeError(f"hw_server at {url} is not reachable from this PC ({e}). Check the address, the "
                           f"network, and that the cable / hw_server is powered and running.")


def info_dict(info):
    return dict(p.split("=", 1) for p in (info or "").split(";") if "=" in p)


def cores_from(listing):
    cores = []
    for item in filter(None, (x.strip() for x in (listing or "").split(";"))):
        m = re.match(r"(?:(\d+)=)?(.*?)(?:\(depth\s*(\d+)\))?$", item)
        cores.append({"name": m.group(2).strip(), "cell": m.group(2).strip(), "depth": int(m.group(3) or 0)})
    return cores


def probes_from(listing, core):
    """ila_probes answers "<name>[<width>];..." - the width is the LAST bracket, a name may hold others."""
    probes = []
    for port, item in enumerate(filter(None, (x.strip() for x in (listing or "").split(";")))):
        m = re.match(r"^(.*)\[(\d+)\]$", item)
        name, width = (m.group(1), int(m.group(2))) if m else (item, 1)
        probes.append({"name": name.split("/")[-1], "fullName": name, "width": width, "isBus": width > 1,
                       "core": core, "port": port})
    return probes


def script_note(s):
    """For the answer of a job that opened a session: that the script its profile names was not there (see
    make_session), and what the driver found wrong with the REPL script (see check_script) - said where the
    person looks, not only in the log."""
    if not s or getattr(s, "reused", False):
        return ""
    return "".join(f". {note}" for note in (getattr(s, "script_missing", ""), getattr(s, "script_note", "")) if note)


def cmd_query_hardware(a):
    result = {"success": False, "message": "", "cores": [], "probes": [], "rawOutput": ""}
    s = None
    try:
        s, prof = make_session(a, ephemeral=True)
        other = ""
        try:
            info = info_dict(open_session(s, prof))
        except RuntimeError as e:
            # The core the request names is not on the device (another bitstream, or a probe file that calls it
            # differently). A capture has to be refused then - it would be the capture of another core. Connect
            # is how one finds out what IS there: it goes on with the device's own cores and says so.
            named = prof["hardware"].get("ila_cell") or ""
            if not named or "is not on the device" not in str(e):
                raise
            s.log(f"NOTE {concise_error(e)} Reading the cores the device has.")
            if s.viv and not (KEEP and KEPT and s.viv is KEPT["viv"]):
                close_engines(s, "the core asked for is not on the device")    # a session that was not kept
            prof["hardware"]["ila_cell"], prof["hardware"]["ila_index"] = "", 0
            info = info_dict(open_session(s, prof))
            other = f" The device has no ILA core called {named}: these are the cores it has - select one of them."
        if a.stop_file and os.path.exists(a.stop_file):
            raise RuntimeError("stopped by user")
        cores = cores_from(s.viv.cmd("ila_list", timeout=120))
        # The probes of EVERY core of the device, each with its core: the list in the GUI is then the same list
        # whichever core is selected, and tells a probe of another core from one of the selected core. The
        # position is set directly and put back, so that nothing said about the selected core is forgotten.
        selected = info.get("CELL_NAME", "")
        here = s.viv.cmd("set ::ILA_INDEX", timeout=60).strip()        # the position the session is on
        at = int(here) if here.isdigit() and int(here) < len(cores) else next(
            (i for i, c in enumerate(cores) if c["name"] == selected), 0)
        probes = []
        try:
            for i, c in enumerate(cores):
                s.viv.cmd(f"set ::ILA_INDEX {i}", timeout=60)
                probes += probes_from(s.viv.cmd("ila_probes", timeout=120), c["name"])
        finally:
            if not s.viv.dead:
                s.viv.cmd(f"set ::ILA_INDEX {at}", timeout=60)
        s.log("ILA cores: " + "; ".join(f"[{i}] {c['name']} (depth {c['depth']}, "
                                         f"{sum(p['core'] == c['name'] for p in probes)} probes)"
                                         for i, c in enumerate(cores)))
        s.log(f"probes: {len(probes)}; selected core: [{at}] {selected}")
        result.update(core=selected, coreIndex=at)
        note = info.get("JTAG_NOTE", "")
        engines, asked = 1 + len(s.extra), wanted_engines(s)
        result.update(success=True, cores=cores, probes=probes, info=info, engines=engines,
                      message=f"Connected: {len(cores)} ILA core(s), {len(probes)} probe(s) on "
                              f"{info.get('DEVICE', 'the device')}, TCK {info.get('JTAG_FREQ_HZ', '?')} Hz"
                              + (f", {engines} Vivado engines" if engines > 1 else "")
                              + (f" (only {engines} of the {asked} Vivado engines asked for: "
                                 f"{getattr(s, 'solo', '') or 'see the log'})" if engines < asked else "")
                              + (f". {note}" if note else "") + script_note(s) + (f".{other}" if other else ""))
    except Exception as e:
        result["message"] = concise_error(e)
        result["stopped"] = bool(a.stop_file) and os.path.exists(a.stop_file)
        bridge_log(f"query failed: {e}")
        say(f"{datetime.datetime.now():%H:%M:%S} ERROR: {result['message']}")
    answer(s, result)
    return 0 if result["success"] else 1


def cmd_capture(a):
    """One capture, or with --count N / --count 0 (until stopped) several in the same Vivado session."""
    ic = driver()
    result = {"success": False, "message": "", "csvPath": None, "sessionDir": None, "captures": 0, "stopped": False}
    stop = a.stop_file or ""

    def stopped():
        return bool(stop) and os.path.exists(stop)

    s = None
    try:
        s, prof = make_session(a, ephemeral=False)
        result["sessionDir"] = s.out
        info = info_dict(open_session(s, prof))
        result["info"] = info
        single = a.count == 1
        until_stopped = a.count <= 0
        limit = a.count if a.count > 0 else MAX_WINDOWS
        misses, last_error, ended_by, n = 0, "", "", 0
        at_limit = ""                                      # an until-stopped run that came to MAX_WINDOWS: no failure
        reconnected = False
        # In a run of several windows, what is left to do once Vivado has written a window's file - putting the
        # CSV into the formats asked for, statistics, the row in index.csv, telling the GUI - is done by a second
        # thread, in the order of the windows: the next window is armed without waiting for any of it.
        worker = None if single else concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="window")
        # With more than one Vivado engine, in a run of several windows: an engine arms, waits and uploads, and
        # then writes its file on a thread of its own while the next engine takes the next window. Only the
        # writing overlaps - JTAG is used by one engine at a time - so a window costs the upload plus whatever of
        # the writing the other engines' turns do not cover (measured with a 16k-sample core of a few dozen columns:
        # CSV 2.0 s -> 1.45 s per window with two engines, CSV + .ila 3.9 s -> 2.1 s). Such a window counts once
        # its file is there, which the second thread sees, in the order of the windows.
        overlap = not single and len(s.extra) > 0
        writers = None
        turn = dropped = 0
        # windows on disk; uploaded but not written - in a row, in all - and why
        tally = {"done": 0, "bad": 0, "lost": 0, "error": ""}
        tally_lock = threading.Lock()

        def counted(path):
            with tally_lock:
                tally["done"] += 1
                result.update(csvPath=path, captures=tally["done"])
                return tally["done"]

        def complete(done, name, path, index):
            st = {}
            try:
                st = done() or {}
            except Exception as e:                         # the file is written; only working on it failed
                s.log(f"WARNING {name}: {type(e).__name__}: {e}")
            emit("@@CAPTURE", {"csvPath": path, "name": name, "index": index, "rows": st.get("rows", 0)})

        def complete_written(written_file, finish, name):
            try:
                path = written_file()                      # waits for the engine that is writing it
            except Exception as e:
                tally["bad"] += 1
                tally["lost"] += 1
                tally["error"] = concise_error(e)
                s.log(f"{name}: NOT CAPTURED: {tally['error']}")
                return
            tally["bad"] = 0
            complete(lambda: finish(path), name, path, counted(path))

        try:
            while n < limit and not stopped():
                name = a.name if single else f"{a.name}_{n:04d}"
                st, error, later, split, viv = {}, "", [], None, s.viv
                try:
                    if overlap:
                        engines = [s.viv] + s.extra
                        viv = engines[turn % len(engines)]
                        if writers is None:
                            writers = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_ENGINES,
                                                                            thread_name_prefix="write")
                        split = s.capture_split(viv, name, dict(note=""), writers)
                    else:
                        st = s.capture(name, dict(note=""), finish=None if single else later.append)
                except RuntimeError as e:
                    error = concise_error(e)
                except ValueError as e:                        # the file is written; only reading it back failed
                    s.log(f"WARNING {name}: {e}")
                path = None if split else next((os.path.join(s.out, name + ext) for ext in (".csv", ".ila")
                                                if os.path.exists(os.path.join(s.out, name + ext))), None)
                if error or not (path or split):
                    last_error = error or "no capture file was written"
                    s.log(f"{name}: NOT CAPTURED: {last_error}")
                    if stopped():
                        break
                    if overlap and "invalid command name" in last_error:
                        # a REPL script of one's own that cannot split a capture: one engine does it all
                        s.log("NOTE this Tcl script cannot take turns between Vivado engines: capturing with one")
                        overlap = False
                        continue
                    if overlap and viv is not s.viv and (viv.dead or not ASKED_WRONG.search(last_error)):
                        # A further engine has gone, or fails at something that is not the request's fault: the
                        # others carry on, the first one alone if need be. Whether the session itself is at fault
                        # shows when the first engine takes this window - the rules below are about that one.
                        s.log(f"{viv.name} {'has ended' if viv.dead else 'failed'}: "
                              f"going on with {len(s.extra)} Vivado engine(s)")
                        s.extra.remove(viv)
                        viv.close()                            # it leaves the cable's clock alone
                        if KEEP and KEPT:
                            announce_state("a Vivado engine ended")
                        dropped += 1
                        last_error = ""
                        continue
                    if KEEP and getattr(s, "reused", False) and not reconnected and not ASKED_WRONG.search(last_error):
                        # The session had been open since an earlier job, and something has happened to it since
                        # that looking at the device again did not show. Seen in testing: another program sets
                        # the cable's JTAG clock back, the open session still believes in its own (the property is
                        # cached) and every capture ends with "the ILA core does not run". A fresh session cures it.
                        reconnected = True
                        s.log("this session was kept open from an earlier job: connecting afresh and trying once more")
                        s.viv, s.extra = None, []
                        drop_kept("a capture failed in it")    # each engine finishes the file it is writing first
                        try:
                            info = info_dict(open_session(s, prof))
                        except RuntimeError as e:              # no new session either: that is how this run ends,
                            last_error = ended_by = concise_error(e)   # with whatever it had captured before
                            s.log(f"connecting afresh failed: {last_error}")
                            break
                        result["info"] = info
                        last_error = ""
                        overlap = not single and len(s.extra) > 0
                        continue
                    # a trigger that did not come within the timeout is what an until-stopped run waits out; any
                    # other failure three times in a row (bad compare value, core not running) will not get better
                    if not (until_stopped and last_error.startswith("not triggered within")):
                        misses += 1
                    if single or misses >= 3 or s.viv.dead:
                        ended_by = last_error
                        break
                    continue
                misses = 0
                n += 1
                turn += 1
                if split:
                    worker.submit(complete_written, split[0], split[1], name)
                    if tally["bad"] >= 3:                      # the upload works, the files do not arrive
                        ended_by = last_error = tally["error"]
                        s.log(f"stopping: three windows in a row were not written: {ended_by}")
                        break
                elif worker and later:
                    worker.submit(complete, later[0], name, path, counted(path))
                else:
                    emit("@@CAPTURE", {"csvPath": path, "name": name, "index": counted(path),
                                       "rows": (st or {}).get("rows", 0)})
                if not single and shutil.disk_usage(s.out).free < (1 << 30):
                    ended_by = last_error = "less than 1 GB free on the capture drive"
                    s.log(f"stopping: {ended_by}")
                    break
                if until_stopped and n >= limit and not stopped():
                    at_limit = f"the limit of {limit} windows of one run was reached"
                    s.log(f"stopping: {at_limit}")         # the loop ends here by itself; the log says why
        finally:
            # every window is written, finished and announced before the job answers: the answer is the last
            # line of a job, and the session folder's log is closed with it
            if worker:
                worker.shutdown(wait=True)
            if writers:
                writers.shutdown(wait=True)
            if tally["error"] and not last_error:
                last_error = tally["error"]
        result["stopped"] = stopped()
        result["lost"] = tally["lost"]                     # uploaded, but the file could not be written
        result["success"] = result["captures"] > 0
        note = info.get("JTAG_NOTE", "")
        if result["success"]:
            result["message"] = (f"Captured {result['captures']} window(s) into {s.out}" if not single
                                 else f"Capture saved: {result['csvPath']}") \
                + (f" - the run ended early: {ended_by}" if ended_by and not single else "") \
                + (f" - the run ended by itself: {at_limit}; start it again to go on" if at_limit else "") \
                + (f"; {tally['lost']} more window(s) were uploaded but could not be written: {tally['error']}"
                   if tally["lost"] and tally["error"] != ended_by else "") \
                + (f"; {dropped} Vivado engine(s) dropped out on the way, the run went on with "
                   f"{1 + len(s.extra)}" if dropped else "") \
                + script_note(s) \
                + (f". {note}" if note else "")
        else:
            result["message"] = "Stopped before anything was captured." if result["stopped"] and not last_error \
                else (last_error or "Nothing was captured.")
    except Exception as e:
        result["message"] = concise_error(e)
        if s:
            s.log(f"ERROR: {result['message']}")           # into session.log too: the folder explains itself
        else:
            bridge_log(f"capture failed: {e}")
            say(f"{datetime.datetime.now():%H:%M:%S} ERROR: {result['message']}")
    answer(s, result)
    return 0 if result["success"] else 1


def cmd_run_tcl(a):
    """The REPL script is "run" by connecting with it (same as query-hardware); any other script is sourced in a
    Vivado batch session and its output returned."""
    ic = driver()
    try:
        # a path that was typed but does not exist is an error (resolve_tcl), not a reason to run the bundled script
        tcl = ic.resolve_tcl((a.tcl or "").strip())
        # ... and so is a profile that is gone. It is asked for here, before the open hardware session is closed
        # for the script: a job that is refused leaves the session as it is. (A connect asks for it itself.)
        prof = None if "repl" in os.path.basename(tcl).lower() else job_profile(a)
    except RuntimeError as e:
        emit("@@RESULT", {"success": False, "message": str(e), "cores": [], "probes": [], "rawOutput": ""})
        return 1
    if "repl" in os.path.basename(tcl).lower():
        return cmd_query_hardware(a)
    result = {"success": False, "message": "", "cores": [], "probes": [], "rawOutput": ""}
    if KEPT:
        # the script runs in a Vivado of its own, which must find the cable the way it expects it - not held by
        # the kept session at a JTAG clock that Vivado cannot even represent ("bad enum default")
        idle_log("closing the open hardware session before the script runs; connect again afterwards")
        drop_kept("a Tcl script was run")
    p = None
    try:
        argv = ic.launch(ic.resolve_vivado(prof["tools"]["vivado"]), "-mode", "batch", "-nolog", "-nojournal",
                         "-notrace", "-source", tcl)
        bridge_log(f"---- run-tcl: {' '.join(argv)}")
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, errors="backslashreplace", cwd=HERE, creationflags=NO_WINDOW)
        out = queue.Queue()

        def reader():
            try:
                for text in p.stdout:
                    out.put(text.rstrip("\r\n"))
            finally:
                out.put(None)

        threading.Thread(target=reader, daemon=True).start()
        lines, stopped = [], False
        while True:
            # looked at on every pass: a script that prints all the time must notice the stop request as well
            if a.stop_file and os.path.exists(a.stop_file):
                ic.kill_tree(p)
                stopped = True
                break
            try:
                line = out.get(timeout=0.3)
            except queue.Empty:
                continue
            if line is None:
                break
            lines.append(line)
            bridge_log(f"[vivado] {line}")
            say(f"{datetime.datetime.now():%H:%M:%S} [vivado] {line}")
        rc = p.wait()
        result.update(success=rc == 0 and not stopped, stopped=stopped, rawOutput="\n".join(lines),
                      message="Stopped by user." if stopped else "Tcl script finished" if rc == 0
                      else f"Tcl script failed (exit code {rc})")
    except Exception as e:
        if p is not None and p.poll() is None:             # nobody is left to read it: do not leave it running
            ic.kill_tree(p)
        result["message"] = concise_error(e)
    emit("@@RESULT", result)
    return 0 if result["success"] else 1


def cmd_serve():
    """Take hardware jobs from stdin until it ends; see the module text. Never dies with a job unanswered."""
    global KEEP
    KEEP = True
    parser = build_parser()
    bridge_log("---- serve: waiting for jobs")
    # stdin is read by a thread of its own, so that the loop below can also look after an idle session, and so
    # that the end of the input - the application has gone - reaches a job that is still waiting for a trigger
    lines = queue.Queue()
    running = {"stop_file": "", "input_ended": False}

    def read_input():
        try:
            for text in sys.stdin:
                lines.put(text)
        finally:
            running["input_ended"] = True
            stop = running["stop_file"]
            if stop:                                       # the job in flight ends as if Stop had been pressed
                try:
                    open(stop, "w").close()
                except OSError:
                    pass
            lines.put(None)

    threading.Thread(target=read_input, daemon=True).start()
    while True:
        try:
            raw = lines.get(timeout=1.0)
        except queue.Empty:
            # nothing to do: has the kept Vivado ended by itself (crashed, killed to free the cable)? The button
            # in the GUI must not go on showing a connection that is not there.
            if KEPT and (KEPT["viv"].dead or KEPT["viv"].p.poll() is not None):
                drop_kept("the Vivado session ended")
            else:
                drop_dead_engines()
            continue
        if raw is None:
            break
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            argv = [str(x) for x in req.get("argv") or []]
            stop_file = str(req.get("stop_file") or "")
        except (ValueError, AttributeError):
            emit("@@RESULT", {"success": False, "message": "The bridge was sent a request it cannot read."})
            continue
        # a stop file left over from an earlier job is removed by the sender before it sends: removing it here
        # could swallow a Stop that was pressed while this process was still starting
        running["stop_file"] = stop_file
        if running["input_ended"]:
            continue                                       # nobody is there to stop or to hear this job
        try:
            if argv[:1] == ["disconnect"]:
                was_open = KEPT is not None
                alive = was_open and not KEPT["viv"].dead and KEPT["viv"].p.poll() is None
                drop_kept("disconnected")
                emit("@@RESULT", {"success": True, "message":
                                  "Hardware session closed: Vivado has exited and the cable has its JTAG clock back."
                                  if alive else
                                  "The hardware session had already ended (Vivado was gone). The cable's JTAG clock may "
                                  "still be lowered; the next connect puts it right."
                                  if was_open else "No hardware session was open."})
            elif argv[:1] == ["exit"]:
                break
            elif argv[:1] and argv[0] in ("capture", "query-hardware", "run-tcl"):
                try:
                    a = parser.parse_args(argv + (["--stop-file", stop_file] if stop_file else []))
                except SystemExit:                         # argparse's way of refusing a command line
                    emit("@@RESULT", {"success": False, "message": f"The bridge does not understand: {' '.join(argv)}"})
                    continue
                {"capture": cmd_capture, "query-hardware": cmd_query_hardware, "run-tcl": cmd_run_tcl}[argv[0]](a)
            else:
                emit("@@RESULT", {"success": False, "message": f"Not a hardware command: {' '.join(argv[:1])}"})
        except Exception as e:                             # whatever a job does, the next one must find us here
            bridge_log(f"serve: job failed: {e!r}")
            emit("@@RESULT", {"success": False, "message": concise_error(e)})
        finally:
            running["stop_file"] = ""
    drop_kept("the application closed")
    bridge_log("---- serve: ended")
    return 0


def add_hw_args(p):
    p.add_argument("--server", default="")
    p.add_argument("--ltx", default="")
    p.add_argument("--tcl", default=None,
                   help="the Tcl script of the session; empty: the bundled one. Left out, the script the profile "
                        "names (tools.tcl_script) is used, and the bundled one when it names none")
    p.add_argument("--device", default="")
    p.add_argument("--jtag-hz", type=int, default=None, help="0 or omitted: automatic")
    p.add_argument("--ila-index", type=int, default=None)
    p.add_argument("--ila-cell", default="",
                   help="the ILA core by its cell name (as in the probe file); wins over --ila-index")
    p.add_argument("--profile", default="")
    p.add_argument("--stop-file", default="")
    p.add_argument("--engines", type=int, default=1,
                   help=f"Vivado processes of the session, 1 to {MAX_ENGINES}: with more than one, each writes its "
                        f"file while the next one captures the next window of a run")


def build_parser():
    parser = argparse.ArgumentParser(description="ILA Studio bridge for the Tauri GUI")
    sub = parser.add_subparsers(dest="subcommand", required=True)
    sub.add_parser("list-profiles")
    sub.add_parser("serve")
    p = sub.add_parser("parse-ltx"); p.add_argument("--ltx", required=True)
    p = sub.add_parser("parse-csv"); p.add_argument("--file", required=True)
    p.add_argument("--max-samples", type=int, default=4096)
    p = sub.add_parser("demo-capture"); p.add_argument("--samples", type=int, default=2048)
    add_hw_args(sub.add_parser("query-hardware"))
    add_hw_args(sub.add_parser("run-tcl"))
    p = sub.add_parser("capture"); add_hw_args(p)
    p.add_argument("--name", required=True)
    p.add_argument("--trigger", default="now")
    p.add_argument("--position", type=int, default=None)
    p.add_argument("--timeout-min", type=float, default=None)
    p.add_argument("--format", choices=["both", "ila", "csv"], default=None)
    p.add_argument("--probe-formats", default=None,
                   help='JSON, how single probes are written into the CSV: {"<net name>": "unsigned|signed|hex"}')
    p.add_argument("--count", type=int, default=1, help="captures to take in this session; 0 = until stopped")
    p.add_argument("--target", default="unit")
    p.add_argument("--out", default=None)
    return parser


def main():
    for stream in (sys.stdout, sys.stderr, sys.stdin):     # the GUI reads and writes UTF-8, whatever the code page
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    a = build_parser().parse_args()

    if a.subcommand == "serve":
        sys.exit(cmd_serve())
    if a.subcommand == "list-profiles":
        print(json.dumps(list_profiles()))
    elif a.subcommand == "parse-ltx":
        print(json.dumps(parse_ltx_file(a.ltx)))
    elif a.subcommand == "parse-csv":
        print(json.dumps(parse_csv_capture(a.file, a.max_samples)))
    elif a.subcommand == "demo-capture":
        print(json.dumps({"filePath": create_demo_capture(samples=a.samples), "status": "ok"}))
    elif a.subcommand == "query-hardware":
        sys.exit(cmd_query_hardware(a))
    elif a.subcommand == "run-tcl":
        sys.exit(cmd_run_tcl(a))
    elif a.subcommand == "capture":
        sys.exit(cmd_capture(a))


if __name__ == "__main__":
    main()
