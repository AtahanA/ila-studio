# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

# Launch script for ILA Studio
Write-Host "Starting ILA Studio..." -ForegroundColor Cyan

# The distributed build first (it sits next to the Python / Tcl scripts it drives), then a local release build.
$candidates = @(
    (Join-Path $PSScriptRoot "distribute\ila-studio.exe"),
    (Join-Path $PSScriptRoot "src-tauri\target\release\ila-studio.exe")
)
$builtExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($builtExe) {
    Start-Process -FilePath $builtExe -WorkingDirectory (Split-Path $builtExe)
} else {
    Push-Location $PSScriptRoot
    try {
        # a fresh clone has no packages yet, and "npm run tauri dev" does not say that this is what it lacks
        if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
            Write-Host "node_modules is missing: installing the packages first (npm ci)..." -ForegroundColor Yellow
            npm ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
        }
        Write-Host "Building and launching via Tauri CLI..." -ForegroundColor Yellow
        npm run tauri dev
    } finally { Pop-Location }
}
