# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

# Vivado Hardware Manager command server for ila_capture.py.
# Started as: vivado -mode tcl -nolog -nojournal -notrace -source vivado_ila_repl.tcl
# Reads one Tcl command per line from stdin, answers with "@@RC <code>", "@@RES <result>", "@@END".
#
# A single long-lived Vivado process is used because starting Vivado costs 30-60 s, while a capture costs
# a few seconds. Only the ILA is touched: the device is never programmed. The JTAG frequency is changed only
# when one is asked for, or when the cable's default is too fast for the design's debug hub (see jtag_set_freq).
#
# Proven with Vivado 2017.4 on a Zynq-7000 over a remote hw_server. Newer Vivado versions use the same
# commands; open_hw_manager has replaced open_hw in them, and both are handled.

set ::DEVICE_FILTER "*"
set ::TARGET_FILTER "*"
set ::ILA_INDEX 0
set ::JTAG_FREQ 0
set ::JTAG_MAX_SAFE 0
set ::JTAG_NOTE ""
set ::HUB_CLK_HZ 0
set ::CONNECT_NOTE ""
set ::JTAG_ORIG ""
set ::JTAG_PROP ""
set ::JTAG_LEAVE 0
set ::STOP_FILE ""
set ::PROBE_RADIX {}
# Counted up whenever the driver (ila_capture.py) needs something new from this script; the driver asks for it
# and for the procs it uses when it starts Vivado, and says so when the script is older than itself.
set ::ILA_REPL_VERSION 3

proc say {msg} { puts "\[ILA_REPL\] $msg" }

# url          : hw_server, e.g. 192.0.2.10:3121 for a remote cable (localhost:3121 for a local one)
# ltx          : probe file written by the implementation run; without it probes have no names
# device_filter: glob for the device on the JTAG chain, e.g. xc7z020* - "*" finds the device that carries the ILA
# ila_index    : which ILA core of that device to drive when the design has several (see ila_list)
# target_filter: glob for the JTAG target when several cables/servers are connected, e.g. *<cable serial>*
# freq_hz      : TCK frequency; 0 keeps the cable's default unless that is too fast for the debug hub. Upload time
#                scales almost inversely with it (measured: 10 MHz 1205 ms, 20 MHz 643 ms for a deep, wide core
#                of 32k samples and a few hundred probe bits), but too high a value makes the readback corrupt -
#                see jtag_set_freq.
proc ila_open {url ltx {device_filter *} {ila_index 0} {target_filter *} {freq_hz 0}} {
    if {$device_filter eq ""} { set device_filter * }
    if {$target_filter eq ""} { set target_filter * }
    set ::DEVICE_FILTER $device_filter
    set ::TARGET_FILTER $target_filter
    set ::ILA_INDEX $ila_index
    set ::JTAG_FREQ $freq_hz
    set ::HUB_CLK_HZ [ltx_hub_clock_hz $ltx]
    set ::JTAG_MAX_SAFE [expr {int($::HUB_CLK_HZ / 2.5)}]

    set tck_txt [expr {$freq_hz > 0 ? "$freq_hz Hz" : "auto"}]
    say "ila_open url=$url device=$device_filter ila_index=$ila_index target=$target_filter tck=$tck_txt"
    say "probe file: $ltx (debug hub clock $::HUB_CLK_HZ Hz)"
    if {$ltx ne "" && ![file exists $ltx]} { error "probe file not found: $ltx" }

    if {[info commands open_hw_manager] ne ""} { open_hw_manager } else { open_hw }
    ila_connect $url
    set tgt [ila_pick_target $url $target_filter]
    current_hw_target $tgt

    # the TCK frequency can only be set while the target is closed, i.e. here
    set tck [jtag_set_freq $freq_hz]
    if {$::JTAG_NOTE ne ""} { say "NOTE: $::JTAG_NOTE" }
    set open_err ""
    catch {open_hw_target} open_err                ;# no -quiet: it would swallow the reason reported below
    set opened 0
    catch { set opened [get_property IS_OPENED $tgt] }
    if {!$opened} { error "cannot open JTAG target $tgt: $open_err" }
    say "JTAG target $tgt open, TCK [jtag_freq] Hz"

    set dev [ila_pick_device $device_filter $ltx]
    say "ILA device: $dev"
    return [ila_info]
}

# Slowest debug-hub clock named in the probe file, 0 when the file does not say.
proc ltx_hub_clock_hz {ltx} {
    set hz 0
    catch {
        set f [open $ltx r]
        set txt [read $f]
        close $f
        foreach {m v} [regexp -all -inline {HUB_CLK_INPUT_FREQ_HZ"\s+value="([0-9]+)"} $txt] {
            if {$v > 0 && ($hz == 0 || $v < $hz)} { set hz $v }
        }
    }
    return $hz
}

# "[Common 17-70] Application Exception: bad enum default" from connect_hw_server, followed by "No hardware
# targets exist on the server": Vivado keeps the cable's TCK frequency as an ENUM of the values the cable lists,
# and the cable reports the frequency it really runs at. A SmartLynq asked for 6 MHz runs at 6034482 Hz; that
# number is in no list, so Vivado (2017.4) throws while registering the target and ends up with none. The cable
# keeps such a frequency for as long as ANY client holds the JTAG port open (an SDK debug session is enough), so
# the failure outlives the session that set it. Seen in testing: every connect failed while the cable sat at
# 6034482 Hz and worked again the moment it was put back to 10000000 Hz - with nothing else changed.
# The way out is to give the cable a frequency it can produce exactly, which only xsdb can do at that point
# (Vivado has no target object to set a property on). ila_close puts the original frequency back for the same
# reason.
proc ila_connect {url} {
    set ::CONNECT_NOTE ""
    if {[llength [get_hw_servers -quiet]] > 0} { return }
    for {set attempt 1} {$attempt <= 2} {incr attempt} {
        say "Connecting to hw_server at $url..."
        set err ""
        if {[catch {connect_hw_server -url $url} err]} {
            set ::CONNECT_NOTE [string trim $err]
            say "connect_hw_server raised: $::CONNECT_NOTE"
        }
        if {[llength [get_hw_servers -quiet]] == 0} {
            error "cannot connect to hw_server at $url - check that it is running and reachable from this PC ($::CONNECT_NOTE)"
        }
        if {[llength [get_hw_targets -quiet]] > 0 || $attempt == 2} { break }
        if {![string match "*bad enum*" $::CONNECT_NOTE]} { break }
        say "the cable runs at a TCK frequency Vivado cannot represent; resetting it through xsdb..."
        set fixed [jtag_reset_cable_freq $url]
        say "xsdb: $fixed"
        if {![string match "*TCK_RESET*" $fixed]} {
            error "the JTAG cable runs at a TCK frequency Vivado cannot represent ($::CONNECT_NOTE) and it could not be reset: $fixed. Reset it by hand in xsdb/xsct: connect -url tcp:$url; jtag targets 1; jtag frequency 10000000"
        }
        catch { disconnect_hw_server }
        set ::CONNECT_NOTE ""
    }
    say "Connected to hw_server [get_hw_servers -quiet]"
}

# Put every cable of the server whose TCK frequency is not one of its own listed values onto a listed value it
# can produce exactly (10 MHz first: the default of the Xilinx cables). Runs xsdb from the Vivado installation.
# Returns xsdb's output: one "TCK_RESET <old> -> <new>" line per cable that was changed.
proc jtag_reset_cable_freq {url} {
    set xsdb ""
    foreach dir [list [file dirname [info nameofexecutable]] \
                      [expr {[info exists ::env(XILINX_VIVADO)] ? [file join $::env(XILINX_VIVADO) bin] : ""}]] {
        foreach name {xsdb.bat xsdb} {
            if {$dir ne "" && [file exists [file join $dir $name]]} { set xsdb [file join $dir $name]; break }
        }
        if {$xsdb ne ""} { break }
    }
    if {$xsdb eq ""} { return "xsdb not found next to Vivado - set the cable frequency back by hand (xsdb: jtag frequency 10000000)" }
    set tmpdir [expr {[info exists ::env(TEMP)] ? $::env(TEMP) : [pwd]}]
    set script [file join $tmpdir "ila_tck_reset_[pid].tcl"]
    set f [open $script w]
    # the address as one Tcl word (list): written as it stands, an IPv6 address in brackets - or any text with a
    # bracket, a semicolon or a space in it - would be run by xsdb as part of this script
    puts $f "if {\[catch {connect -url [list tcp:$url]} e\]} { puts \"xsdb connect failed: \$e\"; exit 1 }"
    puts $f {
        proc fix_cable {id} {
            jtag targets $id
            set cur [jtag frequency]
            set valid [jtag frequency -list]
            if {[lsearch -exact $valid $cur] >= 0} { return "TCK_OK $cur" }
            foreach hz [concat 10000000 [lsort -integer -decreasing $valid]] {
                if {[lsearch -exact $valid $hz] < 0 || $hz > 10000000} { continue }
                jtag frequency $hz
                if {[jtag frequency] == $hz} { return "TCK_RESET $cur -> $hz" }
            }
            return "TCK_STUCK $cur"
        }
        foreach t [jtag targets -target-properties] {
            if {[dict get $t level] != 0} { continue }
            if {[catch {fix_cable [dict get $t node_id]} res]} { set res "xsdb: $res" }
            puts $res
        }
        catch { disconnect }
        exit 0
    }
    close $f
    set out ""
    if {[info exists ::tcl_platform(platform)] && $::tcl_platform(platform) eq "windows"} {
        catch { exec cmd /c [file nativename $xsdb] [file nativename $script] 2>@1 } out
    } else {
        catch { exec $xsdb $script 2>@1 } out
    }
    catch { file delete $script }
    return [string map [list \n { | } \r {}] [string trim $out]]
}

# Leave the cable as it was found: put back the TCK frequency this session changed (see ila_connect for why a
# left-over frequency locks Vivado out), close the target and the server. Called by the REPL loop before "exit"
# and when stdin closes, so every orderly end of a session goes through it.
#
# ::JTAG_LEAVE 1 (set by the driver for the second, third ... Vivado on one cable): this one does not put anything
# back. What it "found" is what the first Vivado had set - or the 10 MHz of the xsdb reset in ila_connect - and
# putting that back would change the clock under the first one, which is still working with it (seen in
# testing: the cable ended at 10 MHz instead of the 40 MHz it had before the session). The first one restores.
proc ila_close {} {
    set out "tck unchanged"
    if {[catch {current_hw_target} tgt] || $tgt eq ""} { return "no target" }
    if {!$::JTAG_LEAVE && $::JTAG_ORIG ne "" && $::JTAG_PROP ne ""} {
        set now ""
        catch { set now [get_property $::JTAG_PROP $tgt] }
        if {$now ne "" && $now != $::JTAG_ORIG} {
            catch { close_hw_target }
            if {![catch {set_property $::JTAG_PROP $::JTAG_ORIG $tgt}]} {
                catch { open_hw_target -quiet }
                set out "tck restored to $::JTAG_ORIG Hz"
            }
        }
    }
    catch { close_hw_target }
    catch { disconnect_hw_server }
    set ::JTAG_ORIG ""
    return $out
}

proc ila_pick_target {url target_filter} {
    for {set try 1} {$try <= 3} {incr try} {
        set tgt [lindex [get_hw_targets -quiet $target_filter] 0]
        if {$tgt ne ""} { return $tgt }
        say "no JTAG target on the server yet, refreshing (attempt $try/3)..."
        after 1500
        catch { refresh_hw_server -quiet [current_hw_server] }
    }
    set tgt [lindex [get_hw_targets -quiet $target_filter] 0]
    if {$tgt ne ""} { return $tgt }
    set why "hw_server at $url answers but offers no JTAG target matching '$target_filter': the board is probably"
    append why " powered off, or the cable is not attached to it"
    if {$::CONNECT_NOTE ne ""} { append why " (Vivado said: $::CONNECT_NOTE)" }
    error $why
}

# The device that carries the ILA. An explicit filter is honoured; with "*" the chain is searched, because on a
# Zynq the first device is the ARM DAP, which never holds a debug core - taking index 0 there finds no ILA.
proc ila_pick_device {device_filter ltx} {
    set all [get_hw_devices -quiet]
    set devs [get_hw_devices -quiet $device_filter]
    if {[llength $all] == 0} {
        error "the JTAG chain is empty: the cable is there but sees no device - the board is probably powered off (no device matching '$device_filter' on the JTAG chain)"
    }
    if {[llength $devs] == 0} { error "no device matching '$device_filter' on the JTAG chain (chain: $all)" }
    set cands {}
    foreach d $devs {
        set part ""
        catch { set part [get_property PART $d] }
        if {[string match -nocase "arm_dap*" $part] || [string match -nocase "arm_dap*" $d]} { continue }
        lappend cands $d
    }
    if {[llength $cands] == 0} {
        error "'$device_filter' matches only the ARM debug port ($devs); the ILA lives in the FPGA device (chain: $all)"
    }
    set why ""
    foreach d $cands {
        current_hw_device $d
        if {$ltx ne ""} {
            set_property PROBES.FILE $ltx $d
            catch { set_property FULL_PROBES.FILE $ltx $d }
        }
        say "Refreshing device $d with probes..."
        if {[catch {refresh_hw_device $d} err_r]} {
            say "WARNING: refresh_hw_device $d failed with probes: $err_r"
            append why " $d: [string trim $err_r]"
            catch { refresh_hw_device -update_hw_probes false $d }
        }
        if {[llength [get_hw_ilas -quiet -of_objects $d]] > 0} { return $d }
        # not this one: take the probe file off it again
        catch { set_property PROBES.FILE {} $d }
        catch { set_property FULL_PROBES.FILE {} $d }
    }
    # Vivado sees the device but no debug hub in it. Which of the usual reasons it is can only be told where the
    # DONE pin can be read (the name of that register field is the 7-series one; anything else is left open).
    set msg "no ILA core found on [join $cands {, }]: Vivado sees the device but no debug hub in it."
    set done ""
    catch { set done [get_property REGISTER.CONFIG_STATUS.BIT14_DONE_PIN [lindex $cands 0]] }
    if {$done eq "0"} {
        append msg " The FPGA is not configured (DONE is low): load the bitstream, or wait until the board has booted."
    } elseif {$done eq "1"} {
        append msg " The FPGA is configured (DONE is high): either its debug hub clock is not running, or the loaded bitstream has no ILA / is not the one this .ltx belongs to."
    } else {
        append msg " Either the FPGA is not configured yet or its debug hub clock is not running, or the loaded bitstream has no ILA / is not the one this .ltx belongs to."
    }
    if {$why ne ""} { append msg " (Vivado said:$why)" }
    error $msg
}

# The TCK frequency is a property of the target and must be set while the target is CLOSED. It is not
# persistent: a new hardware manager session starts from the cable's default again, so nothing has to be
# restored afterwards.
#
# Two things are checked instead of trusting the number that was asked for:
#  * the cable only takes a fixed list of frequencies (a SmartLynq has 6 and 7.5 MHz but no 5 MHz); an unlisted
#    value is rejected by Vivado, and silently staying at the default then looks like "the setting did not help".
#    The request is therefore snapped DOWN to the nearest listed value.
#  * TCK must stay below the debug hub clock / 2.5 (the rule in UG908). Well above that the core cannot be
#    driven at all: it stays IDLE after run_hw_ila and the upload says "No data to upload" or
#    "[Labtools 27-3312] Data read from hw_ila is corrupted". For example, with a 15.6 MHz hub clock a core was
#    dead at the cable default of 10 MHz (ratio 1.6) and clean at 6 MHz (2.6). The rule has some margin - with a
#    40 MHz hub clock one was stable at 20 MHz (2.0) and corrupt at 30 MHz (1.3) - so it is only ENFORCED when no
#    frequency was asked for (hz 0: the cable default is lowered if it breaks the rule). A frequency asked for
#    explicitly is used as given, with a note when it is above the rule. The hub clock is read from the .ltx.
# Returns the frequency the target will open with; ::JTAG_NOTE says why it differs from the request.
proc jtag_set_freq {hz} {
    set ::JTAG_NOTE ""
    set tgt [current_hw_target]
    set prop ""
    foreach p {PARAM.FREQUENCY FREQUENCY} {
        if {![catch {get_property $p $tgt}]} { set prop $p; break }
    }
    if {$prop eq ""} {
        if {$hz > 0} { set ::JTAG_NOTE "this cable has no settable TCK frequency; $hz Hz was not applied" }
        return "unknown"
    }
    set cur [get_property $prop $tgt]
    if {![string is integer -strict $cur]} { return $cur }
    if {$::JTAG_ORIG eq ""} { set ::JTAG_ORIG $cur; set ::JTAG_PROP $prop }
    set goal [expr {$hz > 0 ? $hz : $cur}]
    # automatic: only step in when the cable default breaks the hub rule. An explicit request is honoured.
    set limited [expr {$hz <= 0 && $::JTAG_MAX_SAFE > 0 && $goal > $::JTAG_MAX_SAFE}]
    if {$limited} { set goal $::JTAG_MAX_SAFE }
    set valid {}
    catch { set valid [lsort -integer [list_property_value $prop $tgt]] }
    set pick $goal
    if {[llength $valid] > 0} {
        set pick [lindex $valid 0]
        foreach v $valid { if {$v <= $goal} { set pick $v } }
    }
    if {$limited} {
        set ::JTAG_NOTE "TCK set to $pick Hz instead of the cable default of $cur Hz: the debug hub clock is $::HUB_CLK_HZ Hz and TCK must stay below hub clock / 2.5"
    } elseif {$pick != $goal} {
        set ::JTAG_NOTE "the cable has no $goal Hz setting, using $pick Hz (it offers: $valid)"
    }
    if {$hz > 0 && $::JTAG_MAX_SAFE > 0 && $pick > $::JTAG_MAX_SAFE} {
        if {$::JTAG_NOTE ne ""} { append ::JTAG_NOTE ". " }
        append ::JTAG_NOTE "TCK $pick Hz is above debug hub clock / 2.5 ($::JTAG_MAX_SAFE Hz) - if the core stays IDLE or the readback is corrupt, lower it or use automatic"
    }
    if {$pick == $cur} { return $cur }
    catch { close_hw_target }
    if {[catch {set_property $prop $pick $tgt} e]} {
        set ::JTAG_NOTE "could not set TCK to $pick Hz ([string trim $e]); the cable stays at $cur Hz"
        return $cur
    }
    return $pick
}

proc jtag_freq {} {
    foreach p {PARAM.FREQUENCY FREQUENCY} {
        if {![catch {set v [get_property $p [current_hw_target]]}]} { return $v }
    }
    return "unknown"
}

proc ila_obj {} {
    set ilas [get_hw_ilas -quiet -of_objects [current_hw_device]]
    set ila [lindex $ilas $::ILA_INDEX]
    if {$ila eq ""} { error "ILA index $::ILA_INDEX does not exist: the device has [llength $ilas] core(s) - see ila_list" }
    return $ila
}

# Choose the ILA core that is driven from now on: by its cell name - the name the probe file and the GUI know
# it by - or, with an empty name, by its position in the device's list. A design may hold several cores, and the
# position of a core in that list is not promised to be its position in the probe file: Vivado leaves out a core
# it cannot find on the device, and lists one the file does not know. Returns ila_info of the core.
proc ila_select {cell {index 0}} {
    set ilas [get_hw_ilas -quiet -of_objects [current_hw_device]]
    if {$cell ne ""} {
        set index -1
        set i 0
        foreach ila $ilas {
            if {[get_property CELL_NAME $ila] eq $cell} { set index $i; break }
            incr i
        }
        if {$index < 0} {
            set have [ila_list]
            if {$have eq ""} { set have "no ILA core at all" }
            error "ILA core $cell is not on the device, which has: $have - is the bitstream that belongs to the probe file loaded?"
        }
    }
    # refused before anything is changed: a session kept open must still be on the core it was on
    if {![string is integer -strict $index] || $index < 0 || $index >= [llength $ilas]} {
        error "ILA index $index does not exist: the device has [llength $ilas] core(s) - see ila_list"
    }
    if {$index != $::ILA_INDEX} {
        # what was said about the probes of the core before, and its last upload, are not this core's
        set ::PROBE_RADIX {}
        catch { unset ::LAST_ILA_DATA }
    }
    set ::ILA_INDEX $index
    return [ila_info]
}

# Every ILA core of the current device, in the order ila_index selects them. Run this before deciding ila_index.
proc ila_list {} {
    set out {}
    set i 0
    foreach ila [get_hw_ilas -quiet -of_objects [current_hw_device]] {
        lappend out "$i=[get_property CELL_NAME $ila](depth [get_property CONTROL.DATA_DEPTH $ila])"
        incr i
    }
    return [join $out ";"]
}

# Core properties. Read them once per session: DATA_DEPTH and the probe list tell you what the capture can hold.
proc ila_info {} {
    set ila [ila_obj]
    set out {}
    foreach p {NAME CELL_NAME CONTROL.DATA_DEPTH CONTROL.TRIGGER_POSITION CONTROL.TRIGGER_MODE CONTROL.CAPTURE_MODE
               CONTROL.WINDOW_COUNT STATUS.CORE_STATUS CONTROL.IS_ADVANCED_TRIGGER_MODE_SUPPORTED
               CONTROL.IS_CAPTURE_CONTROL_SUPPORTED CORE_UUID} {
        if {![catch {set v [get_property $p $ila]}]} { lappend out "$p=$v" }
    }
    lappend out "PROBES=[llength [get_hw_probes -quiet -of_objects $ila]]"
    lappend out "DEVICE=[current_hw_device]"
    lappend out "JTAG_FREQ_HZ=[jtag_freq]"
    lappend out "HUB_CLK_HZ=$::HUB_CLK_HZ"
    if {$::JTAG_NOTE ne ""} { lappend out "JTAG_NOTE=[string map {; ,} $::JTAG_NOTE]" }
    return [join $out ";"]
}

# List the probes with their widths: the names you may use in a trigger condition.
proc ila_probes {} {
    set out {}
    foreach p [get_hw_probes -quiet -of_objects [ila_obj]] {
        lappend out "[get_property NAME $p]\[[get_property WIDTH $p]\]"
    }
    return [join $out ";"]
}

# Clear every trigger compare value to don't-care and show multi-bit probes in unsigned decimal.
# Leftover compare values from an earlier session (or from the GUI) are the usual reason a trigger never fires,
# so they are reset on every arm. The radix decides how the CSV export is written, and a decimal export is
# unambiguous.
#
# A probe named with ila_probe_radix gets the radix given there instead. Vivado takes the radix of a probe at the
# moment a capture is UPLOADED: measured on Vivado 2017.4, a data object that is already uploaded is written
# the same whatever the property says afterwards, and uploading the same buffer again follows the property. So
# the radix is set here, before the core is armed, on every arm.
proc ila_prepare_probes {ila {radix UNSIGNED}} {
    foreach p [get_hw_probes -quiet -of_objects $ila] {
        set w [get_property WIDTH $p]
        catch { set_property TRIGGER_COMPARE_VALUE "eq${w}'b[string repeat X $w]" $p }
        if {$w > 1} {
            set r $radix
            set n [get_property NAME $p]
            if {[dict exists $::PROBE_RADIX $n]} { set r [dict get $::PROBE_RADIX $n] }
            catch { set_property DISPLAY_RADIX $r $p }
        }
    }
}

# The probes that are written with a radix of their own, as a list "name radix name radix ..." (an empty list:
# none). A name is found the way a trigger probe is (see ila_find_probes). It holds until it is given again,
# for every capture of this session. Returns "set=<n>;missing=<names that are not on this core>".
# SIGNED is two's complement of the probe width: a 14-bit probe at 16383 is written -1 (checked sample by
# sample against an unsigned upload of the same buffer).
proc ila_probe_radix {pairs} {
    set ila [ila_obj]
    set ::PROBE_RADIX {}
    set missing {}
    set ambiguous {}
    foreach {name radix} $pairs {
        set hits [ila_find_probes $ila $name]
        if {[llength $hits] == 0} { lappend missing $name; continue }
        if {[llength $hits] > 1} { lappend ambiguous $name; continue }
        dict set ::PROBE_RADIX [get_property NAME [lindex $hits 0]] [string toupper $radix]
    }
    return "set=[dict size $::PROBE_RADIX];missing=[join $missing ,];ambiguous=[join $ambiguous ,]"
}

# Set the trigger. trig is "now" or "<probe-name> <compare-value>", e.g. "frame_start eq1'bR" (rising edge),
# "state eq4'h3", "addr eq32'hDEAD_BEEF". The name may be the full hierarchical name, the leaf name or the end
# of the hierarchical name from a "/" on (see ila_find_probes); it must name ONE probe of the selected core.
# Returns 1 when the ILA was armed on a condition, 0 for trigger_now.
proc ila_set_trigger {ila trig} {
    if {$trig eq "now" || $trig eq ""} { return 0 }
    set name [lindex $trig 0]
    set val [lindex $trig 1]
    if {$val eq ""} { error "trigger must be \"now\" or \"<probe> <compare-value>\", got \"$trig\"" }
    set hits [ila_find_probes $ila $name]
    if {[llength $hits] == 0} { error [ila_probe_missing $ila $name] }
    if {[llength $hits] > 1} {
        set names {}
        foreach p $hits { lappend names [get_property NAME $p] }
        error "the name $name fits several probes of this ILA core ([join $names {, }]) - give the full name"
    }
    set_property TRIGGER_COMPARE_VALUE [ila_compare_value $val] [lindex $hits 0]
    return 1
}

# Why a probe was not found on the core that is captured, in words the person at the GUI can act on: which core
# was searched, and - a design may hold several ILA cores, each with probes of its own - which other core of the
# device has a probe of that name. A trigger can only use probes of the core that is captured.
proc ila_probe_missing {ila name} {
    set here [get_property CELL_NAME $ila]
    set there {}
    catch { set there [ila_where $name] }
    if {[llength $there] > 0} {
        return "probe $name is not a probe of the selected ILA core ($here): it belongs to [join $there { and }] - select that core, or choose a trigger probe of the selected one"
    }
    # Nothing is called that. Names that merely END in it were taken by earlier versions of this script ("valid"
    # for "rx_valid"): say which probes those would be, so that the right name can be given, before doubting the
    # bitstream.
    regsub {\[[0-9]+:[0-9]+\]$} $name {} plain
    set near {}
    set len [string length $plain]
    if {$len > 0} {
        foreach other [get_hw_ilas -quiet -of_objects [current_hw_device]] {
            foreach p [get_hw_probes -quiet -of_objects $other] {
                set n [get_property NAME $p]
                if {[string length $n] > $len && [string equal [string range $n end-[expr {$len - 1}] end] $plain]} { lappend near $n }
                if {[llength $near] >= 6} { break }
            }
            if {[llength $near] >= 6} { break }
        }
    }
    if {[llength $near] > 0} {
        return "probe $name not found: no probe of this device is called that. Names that end in it: [join $near {, }] - give the leaf name or the full name"
    }
    return "probe $name not found on the selected ILA core ($here) nor on any other core of the device - does the probe file belong to the loaded bitstream?"
}

# The other ILA cores of the device that have a probe of this name (full name or leaf name; not the loose end-of-
# name match, which would point at look-alikes), as "core <index> <cell>".
proc ila_where {name} {
    set out {}
    set i 0
    foreach ila [get_hw_ilas -quiet -of_objects [current_hw_device]] {
        if {$i != $::ILA_INDEX && [llength [ila_find_probes $ila $name {exact leaf}]] > 0} {
            lappend out "core $i [get_property CELL_NAME $ila]"
        }
        incr i
    }
    return $out
}

# Vivado wants every digit of the probe width written out: "eq14'h0" is refused with "The hw_probe compare_value
# [eq14'h0] has [1] value characters. The required number of value characters for radix [H], is [4]". A hex or
# binary value that is too short is therefore left-padded with zeros; anything else is passed on as it is.
proc ila_compare_value {val} {
    if {[regexp {^([a-z]+)([0-9]+)'([hHbB])(.+)$} $val -> op w rdx body]} {
        set need [expr {[string tolower $rdx] eq "h" ? ($w + 3) / 4 : $w}]
        set have [string length [string map {_ {}} $body]]
        if {$have < $need} { set val "$op$w'$rdx[string repeat 0 [expr {$need - $have}]]$body" }
    }
    return $val
}

# The probes of a core called $name, most exact way of naming first: the whole hierarchical name, else the leaf
# name, else the end of the hierarchical name from a "/" on ("b/valid" for "a/b/valid"). The first way that fits
# anything decides, and all probes it fits are returned - the caller says what more than one means. Compared as
# plain strings, because a net name may hold "[3]", which a glob filter would read as a character class. A bus
# range as it appears in a CSV header ("data[15:0]") is accepted and ignored.
# The end-of-name way matches at a path boundary only: "start" must not land on "rx_start" (seen with the probes
# of several cores in one list: a name meant for another core armed a look-alike of the selected one).
proc ila_find_probes {ila name {ways {exact leaf suffix}}} {
    regsub {\[[0-9]+:[0-9]+\]$} $name {} name
    set probes [get_hw_probes -quiet -of_objects $ila]
    set names {}
    foreach p $probes { lappend names [get_property NAME $p] }
    set tail "/$name"
    set len [string length $tail]
    foreach way $ways {
        set hits {}
        set i 0
        foreach n $names {
            switch $way {
                exact  { set hit [string equal $n $name] }
                leaf   { set hit [string equal [lindex [split $n /] end] $name] }
                suffix { set hit [expr {[string length $n] > $len && [string equal [string range $n end-[expr {$len - 1}] end] $tail]}] }
            }
            if {$hit} { lappend hits [lindex $probes $i] }
            incr i
        }
        if {[llength $hits] > 0} { return $hits }
    }
    return {}
}

# Block until the core is FULL or the timeout (minutes) has passed, and return the core status.
# wait_on_hw_ila alone cannot be trusted: on Vivado 2017.4 it also returns without an error while the core has
# not triggered, and uploading then gives a header-only file. A core that reads IDLE right after it was armed is
# not running at all (see jtag_set_freq), so that case is reported at once instead of after the whole timeout.
#
# The wait is cut into slices of about a second so that a stop request (the file named by ::STOP_FILE appearing)
# ends it promptly: a process blocked in wait_on_hw_ila for minutes could otherwise only be killed, and a killed
# session cannot put the cable's TCK back (see ila_close).
proc ila_wait_full {ila timeout} {
    set deadline [expr {[clock milliseconds] + int($timeout * 60000)}]
    set idle 0
    set st ""
    while 1 {
        if {$::STOP_FILE ne "" && [file exists $::STOP_FILE]} { return "STOPPED" }
        set left [expr {($deadline - [clock milliseconds]) / 60000.0}]
        if {$left <= 0} { break }
        set slice [expr {$left > 0.02 ? 0.02 : ($left < 0.005 ? 0.005 : $left)}]
        catch { wait_on_hw_ila -quiet -timeout $slice $ila }
        set st [get_property STATUS.CORE_STATUS $ila]
        if {[string toupper $st] eq "FULL"} { return $st }
        if {[string toupper $st] eq "IDLE"} {
            if {[incr idle] >= 3} { return $st }
        } else {
            set idle 0
        }
        after 250
    }
    # the deadline has passed (or was 0 from the start): one last look, so that a trigger which fired during
    # the final pause is not thrown away
    catch { wait_on_hw_ila -quiet -timeout 0.005 $ila }
    return [get_property STATUS.CORE_STATUS $ila]
}

# One capture, start to finish.
#   prefix  : output path without extension
#   trig    : "now" or "<probe> <compare-value>"
#   pos     : trigger position in samples (how much pre-trigger history to keep)
#   timeout : minutes to wait for the trigger
#   fmt     : both | ila | csv - the .ila already contains the CSV, so "ila" writes half as much
# Nothing is written unless the core really filled: an empty or header-only file is worse than an error.
proc ila_capture {prefix {trig now} {pos 1000} {timeout 1} {fmt both} {radix UNSIGNED} {capture_mode ALWAYS}} {
    set timing [ila_capture_keep $trig $pos $timeout $radix $capture_mode]
    set t2 [clock milliseconds]
    if {$fmt ne "ila"} { write_hw_ila_data -force -csv_file "$prefix.csv" $::LAST_ILA_DATA }
    if {$fmt ne "csv"} { write_hw_ila_data -force "$prefix.ila" $::LAST_ILA_DATA }
    return "$timing;write_ms=[expr {[clock milliseconds] - $t2}]"
}

# The same capture up to and including the upload: the data stays in this Vivado (::LAST_ILA_DATA) and
# ila_write_last writes it. The two are apart for the sake of several Vivado clients on one ILA: while one of them
# writes its file - the slowest step - the next one arms the core and uploads the next window. Only the writes
# may overlap; everything in here goes over JTAG, which the clients must use one after the other.
# Returns "wait_ms=..;upload_ms=..".
proc ila_capture_keep {{trig now} {pos 1000} {timeout 1} {radix UNSIGNED} {capture_mode ALWAYS}} {
    set ila [ila_obj]
    set depth [get_property CONTROL.DATA_DEPTH $ila]
    if {$pos < 0} { set pos 0 }
    if {$pos > $depth - 1} {
        say "trigger position $pos is beyond the $depth-sample buffer; using [expr {$depth - 1}]"
        set pos [expr {$depth - 1}]
    }
    set_property CONTROL.TRIGGER_POSITION $pos $ila
    catch { set_property CONTROL.CAPTURE_MODE $capture_mode $ila }
    ila_prepare_probes $ila $radix
    set t0 [clock milliseconds]
    set armed [ila_set_trigger $ila $trig]
    if {$armed} { run_hw_ila $ila } else { run_hw_ila -trigger_now $ila }
    set st [ila_wait_full $ila $timeout]
    set t1 [clock milliseconds]
    if {[string toupper $st] ne "FULL"} {
        catch { reset_hw_ila $ila }
        if {$st eq "STOPPED"} { error "stopped by user before the ILA triggered" }
        if {[string toupper $st] eq "IDLE"} {
            error "the ILA core does not run: it is still IDLE after being armed. TCK ([jtag_freq] Hz) is too fast for the debug hub clock ($::HUB_CLK_HZ Hz), or the ILA/hub clock is stopped"
        }
        if {$armed} { error "not triggered within $timeout min (core status $st): the condition {$trig} did not occur" }
        error "the ILA buffer did not fill within $timeout min (core status $st): is the ILA clock running?"
    }
    set ::LAST_ILA_DATA [upload_hw_ila_data $ila]
    return "wait_ms=[expr {$t1 - $t0}];upload_ms=[expr {[clock milliseconds] - $t1}]"
}

# ---- split arm / collect ---------------------------------------------------------------------------------
# Used when the capture must be synchronised with software: arm, let the target run, and collect after the
# CPU halts at the hook. Keeping arm and collect apart is what makes the window land on the event of interest.

# A session that was left open between two jobs: look at the device again before trusting it. A board that was
# power-cycled or given another bitstream meanwhile has other debug cores (or none) than the ones remembered.
# Re-reading the device takes about a tenth of a second, so it is done before every job of a kept session. Any
# error here makes the driver drop the session and open a fresh one, whose messages then say what is wrong.
# Note: refresh_hw_device must run WITH the probes; "-update_hw_probes false" takes them off the device and the
# next run_hw_ila fails with [Labtools 27-188].
proc ila_recheck {} {
    if {[catch {current_hw_target} tgt] || $tgt eq ""} { error "no JTAG target is open any more" }
    set opened 0
    catch { set opened [get_property IS_OPENED $tgt] }
    if {!$opened} { error "the JTAG target is no longer open" }
    set d [current_hw_device]
    set before ""
    catch { set before [get_property CORE_UUID [ila_obj]] }
    refresh_hw_device $d
    if {[llength [get_hw_ilas -quiet -of_objects $d]] == 0} { error "there is no ILA core on $d any more" }
    set now ""
    catch { set now [get_property CORE_UUID [ila_obj]] }
    if {$before ne "" && $now ne $before} { error "the FPGA holds another design than when the session was opened" }
    return [ila_info]
}

# Re-enumerate after the PL was reconfigured (board power cycle, new bitstream): the old ILA handle is stale.
proc ila_refresh {ltx} {
    catch { close_hw_target }
    set tgt [lindex [get_hw_targets -quiet $::TARGET_FILTER] 0]
    if {$tgt eq ""} { error "no JTAG target matching $::TARGET_FILTER - cable unplugged or hw_server gone?" }
    current_hw_target $tgt
    jtag_set_freq $::JTAG_FREQ
    open_hw_target
    ila_pick_device $::DEVICE_FILTER $ltx
    return [ila_info]
}

# Arm without waiting. Returns the core status (should be "WAITING_FOR_TRIGGER", or FULL after trigger_now).
proc ila_arm {{trig now} {pos 1000} {radix UNSIGNED} {capture_mode ALWAYS}} {
    set ila [ila_obj]
    set_property CONTROL.TRIGGER_POSITION $pos $ila
    catch { set_property CONTROL.CAPTURE_MODE $capture_mode $ila }
    ila_prepare_probes $ila $radix
    if {[ila_set_trigger $ila $trig]} { run_hw_ila $ila } else { run_hw_ila -trigger_now $ila }
    return [get_property STATUS.CORE_STATUS $ila]
}

# Collect an armed capture. fmt: both | ila | csv. Errors if the ILA never triggered, so the caller can tell
# "the event did not happen" from "the upload failed"; the core is reset so the next arm starts clean.
proc ila_collect {prefix {fmt ila} {timeout 0.05}} {
    set ila [ila_obj]
    set t0 [clock milliseconds]
    set werr ""
    catch {wait_on_hw_ila -timeout $timeout $ila} werr
    set st [get_property STATUS.CORE_STATUS $ila]
    if {[string toupper $st] ne "FULL"} {
        catch { reset_hw_ila $ila }
        error "not triggered (core status $st): $werr"
    }
    set data [upload_hw_ila_data $ila]
    set t1 [clock milliseconds]
    if {$fmt ne "csv"} { write_hw_ila_data -force "$prefix.ila" $data }
    if {$fmt ne "ila"} { write_hw_ila_data -force -csv_file "$prefix.csv" $data }
    set t2 [clock milliseconds]
    return "status=$st;upload_ms=[expr {$t1 - $t0}];write_ms=[expr {$t2 - $t1}]"
}

# ---- continuous watching ---------------------------------------------------------------------------------
# Collect an armed capture and re-arm BEFORE the file is written. Writing costs more than the upload
# (measured on a deep, wide core of 32k samples and a few hundred probe bits: upload 1.22 s, CSV 1.21 s, .ila
# 2.87 s), so re-arming first means the ILA is collecting again during the write and the dead time per cycle is
# the upload alone.
# Returns "status=..;upload_ms=..;rearm_ms=.." or "status=<core status>;armed=1" when nothing triggered yet.
proc ila_collect_rearm {trig {pos 1000} {timeout 0.02} {radix UNSIGNED} {capture_mode ALWAYS} {rearm 1}} {
    set ila [ila_obj]
    # wait_on_hw_ila blocks for up to $timeout minutes, but whether it raises on a core that never triggered
    # differs between versions - on Vivado 2017.4 it returned happily while the core still said
    # "WAITING FOR TRIGGER", and uploading then yields a header-only, zero-sample file. So the CORE STATUS
    # decides, not the wait: only FULL means there is a captured window to upload.
    catch { wait_on_hw_ila -timeout $timeout $ila }
    set st [get_property STATUS.CORE_STATUS $ila]
    if {[string toupper $st] ne "FULL"} { return "status=$st;armed=1" }
    set t0 [clock milliseconds]
    set ::LAST_ILA_DATA [upload_hw_ila_data $ila]
    set t1 [clock milliseconds]
    # With several clients the NEXT client arms, so that this one is free to spend its time formatting the
    # file while the ILA is already collecting again.
    if {$rearm} { ila_arm $trig $pos $radix $capture_mode }
    set t2 [clock milliseconds]
    return "status=$st;upload_ms=[expr {$t1 - $t0}];rearm_ms=[expr {$t2 - $t1}]"
}

# Write the data of the last ila_collect_rearm or ila_capture_keep. fmt: csv (fastest) | ila (smallest) | both.
proc ila_write_last {prefix {fmt csv}} {
    if {![info exists ::LAST_ILA_DATA]} { error "nothing uploaded yet" }
    set t0 [clock milliseconds]
    if {$fmt ne "ila"} { write_hw_ila_data -force -csv_file "$prefix.csv" $::LAST_ILA_DATA }
    if {$fmt ne "csv"} { write_hw_ila_data -force "$prefix.ila" $::LAST_ILA_DATA }
    return "write_ms=[expr {[clock milliseconds] - $t0}]"
}

fconfigure stdout -buffering line
puts "@@READY"
while {[gets stdin line] >= 0} {
    if {[string trim $line] eq ""} { continue }
    if {[string trim $line] eq "exit"} {
        if {![catch {ila_close} res]} { say "closing: $res" }
    }
    set rc [catch {uplevel #0 $line} res]
    puts "@@RC $rc"
    puts "@@RES [string map [list \n { | } \r {}] $res]"
    puts "@@END"
    flush stdout
    if {[string trim $line] eq "exit"} { break }
}
# stdin closed without "exit": the driver is gone. Still leave the cable in order before going.
catch { ila_close }
exit
