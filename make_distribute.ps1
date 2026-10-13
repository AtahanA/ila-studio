# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

# Build the release executable of ILA Studio and refresh the distribute\ folder from the sources in this folder.
#   .\make_distribute.ps1               build, then copy
#   .\make_distribute.ps1 -NoBuild      copy only (the Python / Tcl side changed, the executable did not)
#   .\make_distribute.ps1 -AllProfiles  take every profile of profiles\ along, not only the shipped examples
#                                       (for a folder that stays on this PC: saved profiles hold local paths)
#   .\make_distribute.ps1 -OutDir <dir> assemble the folder there and leave distribute\ alone (make_release.ps1
#                                       does: distribute\ is in use, it holds somebody's captures and profiles)
param([switch]$NoBuild, [switch]$AllProfiles, [string]$OutDir)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
# a relative -OutDir counts from the folder the script is called in; it need not exist yet
$dist = if ($OutDir) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir) }
        else { Join-Path $root "distribute" }
# ... and this is how the messages name the folder
$distName = if ($OutDir) { $dist } else { "distribute\" }
# one name for the executable: as cargo builds it, as it is copied, and as the process that may be running
$exeName = "ila-studio.exe"

if (-not $NoBuild) {
    Push-Location $root
    try {
        # The crates put the full path of their source files into the executable (the places of their panics):
        # C:\Users\<name>\.cargo\registry\... The folder is named "cargo" instead, so that a release does not
        # carry the user folder of the PC it was built on.
        $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
        $env:CARGO_ENCODED_RUSTFLAGS = "--remap-path-prefix=$cargoHome=cargo"
        # --no-bundle: only the executable; an installer would come without the Python / Tcl side it drives
        cmd /c "npx tauri build --no-bundle"
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
}

$exe = Join-Path $root "src-tauri\target\release\$exeName"
if (-not (Test-Path $exe)) { throw "$exe not found - build first" }
# (with -OutDir the copy goes to another folder: a program that runs from distribute\ is not in its way)
if (-not $OutDir -and (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exeName)) -ErrorAction SilentlyContinue)) {
    throw "$exeName is running - close it before refreshing distribute\"
}

New-Item -ItemType Directory -Force (Join-Path $dist "scripts"), (Join-Path $dist "profiles") | Out-Null
Copy-Item $exe (Join-Path $dist $exeName) -Force
# the licence and the documents go wherever the program goes (the README links to the others)
foreach ($f in "ila_bridge.py", "ila_capture.py", "xsct_repl.tcl", "LICENSE", "README.md", "SECURITY.md",
               "CONTRIBUTING.md", "CHANGELOG.md") {
    Copy-Item (Join-Path $root $f) (Join-Path $dist $f) -Force
}
New-Item -ItemType Directory -Force (Join-Path $dist "docs") | Out-Null
Copy-Item (Join-Path $root "docs\*") (Join-Path $dist "docs") -Recurse -Force
foreach ($f in "vivado_ila_repl.tcl") {
    Copy-Item (Join-Path $root "scripts\$f") (Join-Path $dist "scripts\$f") -Force
}
# the notices of the third-party code, once that file has been written
$notices = Join-Path $root "THIRD-PARTY-NOTICES.md"
if (Test-Path $notices) { Copy-Item $notices (Join-Path $dist "THIRD-PARTY-NOTICES.md") -Force }
# Only the shipped examples unless -AllProfiles says otherwise: a profile somebody saved holds local paths and
# addresses, and this folder is what a release is made of. They are named one by one (as in .gitignore): a
# profile saved as "example-..." is somebody's profile all the same.
# A profile in distribute\ that is newer than its source was saved there from the app ("Save configuration"):
# it stays as it is. The others are refreshed, and new ones are added. (A copy carries the time of its source.)
$shipped = "example-basic.json", "example-hook-uart.json"
$kept = @()
foreach ($p in Get-ChildItem (Join-Path $root "profiles\*.json") | Where-Object { $AllProfiles -or $shipped -contains $_.Name }) {
    $there = Join-Path $dist "profiles\$($p.Name)"
    if ((Test-Path $there) -and (Get-Item $there).LastWriteTime -gt $p.LastWriteTime) {
        Write-Host "profiles\$($p.Name): kept as it is in $distName (saved there after its source was written)" -ForegroundColor Yellow
        $kept += Get-Item $there
    } else {
        Copy-Item $p.FullName $there -Force
    }
}
# stale byte code of the previous scripts must not be picked up
Remove-Item (Join-Path $dist "__pycache__") -Recurse -Force -ErrorAction SilentlyContinue

# What use has left in distribute\ stays there - and it is not for anybody else: it names local paths, the
# hw_server address and the probes of a design. Said aloud, in case this folder is about to be published.
if (-not $AllProfiles) {
    # (a shipped example that was changed in distribute\ - the examples say "change two values before use" - too)
    $left = @($kept) + @(Get-ChildItem (Join-Path $dist "profiles") -File | Where-Object { $shipped -notcontains $_.Name })
    $left += @("ila_log.txt", "captures" | ForEach-Object { Join-Path $dist $_ } | Where-Object { Test-Path $_ } | Get-Item)
    if ($left) {
        Write-Host "Not for a release - left in $distName by use:" -ForegroundColor Yellow
        $left | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Yellow }
    }
}

Write-Host "$distName refreshed:" -ForegroundColor Green
Get-ChildItem $dist -File | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
