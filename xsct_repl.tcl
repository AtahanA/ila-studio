# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

# xsct command server for ila_capture.py.
# Started as: xsct xsct_repl.tcl <url> [core-filter]
#   url         : tcp:<host>:3121 - the SAME hw_server the Vivado side talks to
#   core-filter : targets filter for the CPU that runs the software hook, default a Zynq-7000 core 0
# Reads one Tcl command per line from stdin, answers with "@@RC <code>", "@@RES <result>", "@@END".
#
# Only three things are ever done to the target: read its state, read memory, resume it. Nothing is
# downloaded, reset or written, so an IDE debug session can stay open next to this.

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

# Plant a hardware breakpoint from here when no IDE is attached. Needs the core to be halted.
proc add_bp {addr} { core; bpadd -addr $addr -type hw }

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
