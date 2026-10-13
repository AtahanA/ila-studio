# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

# xsct command server for ila_capture.py.
# Started as: xsct xsct_repl.tcl <url> [core-filter]
#   url         : tcp:<host>:3121 - the SAME hw_server the Vivado side talks to
#   core-filter : targets filter for the CPU that runs the software hook, default a Zynq-7000 core 0. The driver
#                 does not write it here: it sets ::CORE_FILTER with its first command, because a filter has
#                 quotes of its own and the command line of the driver passes through cmd.
# Reads one Tcl command per line from stdin, answers with "@@RC <code>", "@@RES <result>", "@@END".
#
# Three things are done to the target: its state is read, its memory is read, it is resumed. Nothing is
# downloaded, reset or written, so an IDE debug session can stay open next to this. The one exception is asked
# for with "hook --plant": a hardware breakpoint is set at the hook (add_bp), and taken away again before the
# run ends (del_bp).

proc hex {v} { if {![string match -nocase "0x*" $v]} { set v "0x$v" }; return [expr {$v + 0}] }
proc core {} { targets -set -nocase -filter $::CORE_FILTER }

# State and PC in one call: "Running", "Stopped: (Breakpoint) 0x00100000" or "Unreachable".
# A dropped connection is reconnected here rather than failing the caller, because a long capture session
# outlives the occasional JTAG hiccup.
proc core_state {} {
    if {[catch {core; set st [state]}]} { catch {disconnect}; catch {connect -url $::URL}; return "Unreachable" }
    if {[string match "Stopped*" $st]} {
        if {![catch {set pc [hex [dict get [rrd -nvlist] pc]]}]} { return [format "%s 0x%08x" $st $pc] }
    }
    return $st
}

# n 32-bit words from addr, as 0x%08x strings. mrd -value is used when available and the textual output of
# mrd is parsed otherwise, because older xsct builds differ.
proc read_words {addr n} {
    core
    set out {}
    if {[catch {set w [mrd -value $addr $n]}]} {
        set w {}
        foreach line [split [mrd $addr $n] "\n"] { if {[regexp {:\s+([0-9A-Fa-f]+)} $line -> v]} { lappend w [hex $v] } }
    }
    foreach x $w { lappend out [format 0x%08x [expr {$x & 0xFFFFFFFF}]] }
    return $out
}

proc resume {} { core; if {[string match "Stopped*" [state]]} { con }; return [state] }

# Plant a hardware breakpoint from here when no IDE is attached. Needs the core to be halted. Returns the id
# xsct gives the breakpoint, and keeps it: del_bp must find it also where the driver never read this answer.
set PLANTED {}
proc add_bp {addr} { core; set id [bpadd -addr $addr -type hw]; lappend ::PLANTED $id; return $id }

# Take away every breakpoint add_bp planted and return their ids (nothing was planted: an empty answer). A
# breakpoint that is left behind halts the core at the next call of the hook with nobody there to resume it,
# so the driver calls this before it resumes the core for the last time. An error of bpremove is passed on,
# and the breakpoint stays on the list. No core is selected first: xsct removes a breakpoint by its id, and
# a core that cannot be reached must not stand in the way.
proc del_bp {} {
    set gone {}
    while {[llength $::PLANTED] > 0} {
        bpremove [lindex $::PLANTED 0]
        lappend gone [lindex $::PLANTED 0]
        set ::PLANTED [lrange $::PLANTED 1 end]
    }
    return $gone
}

set URL [lindex $argv 0]
if {$URL eq ""} { set URL tcp:127.0.0.1:3121 }
set CORE_FILTER [lindex $argv 1]
if {$CORE_FILTER eq ""} { set CORE_FILTER {name =~ "*Cortex-A9*#0*"} }
connect -url $URL
fconfigure stdout -buffering line
puts "@@READY"
while {[gets stdin line] >= 0} {
    if {[string trim $line] eq ""} { continue }
    set rc [catch {uplevel #0 $line} res]
    puts "@@RC $rc"
    puts "@@RES [string map [list \n { | } \r {}] $res]"
    puts "@@END"
    flush stdout
    if {[string trim $line] eq "exit"} { break }
}
catch {disconnect}
