# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Atahan Aggunlu

# Build the package of a release from the checkout this script is in. It writes, into release\:
#   ila-studio-<version>-windows-x64\             the portable folder, assembled by make_distribute.ps1
#   ila-studio-<version>-windows-x64.zip          that folder, packed
#   ila-studio-<version>-windows-x64.zip.sha256   the SHA-256 sum of the archive, as "sha256sum -c" reads it
#   ila-studio-<version>-windows-x64-notes.md     the text of the release: the changelog entry and the sum
#
#   .\make_release.ps1                  from a clean checkout
#   .\make_release.ps1 -Tag v0.4.0      ... as the release of this tag: the version must fit it, and the changelog
#                                       must carry the date (the release workflow names the tag through
#                                       GITHUB_REF_TYPE / GITHUB_REF_NAME instead)
#   .\make_release.ps1 -AllowDirty      a rehearsal with changes that are not committed
#
# It publishes nothing: .github\workflows\release.yml uploads what is written here. A release cannot be taken
# back once somebody has downloaded it, so everything that can be checked is checked before the folder is packed,
# and the first thing that is not as it should be stops the script.
param([string]$Tag, [switch]$AllowDirty)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$exeName = "ila-studio.exe"
# The same two names as in make_distribute.ps1 and .gitignore: nothing else may be in profiles\ of a release.
$shipped = "example-basic.json", "example-hook-uart.json"

function Step([string]$title) { Write-Host "`n== $title" -ForegroundColor Cyan }

# --- 1. One version everywhere ------------------------------------------------------------------------------
Step "Version"
# The application takes its version from Cargo.toml (tauri.conf.json has none); the other places must follow.
function Get-CargoValue([string]$key) {
    $inPackage = $false
    foreach ($line in Get-Content (Join-Path $root "src-tauri\Cargo.toml") -Encoding UTF8) {
        if ($line -match '^\s*\[(.+)\]\s*$') { $inPackage = $Matches[1] -eq "package" }
        elseif ($inPackage -and $line -match "^\s*$key\s*=\s*`"([^`"]+)`"") { return $Matches[1] }
    }
    throw "src-tauri\Cargo.toml has no $key in [package]"
}
$version = Get-CargoValue "version"
$stated = [ordered]@{}
$stated["package.json"] = (Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
# Windows PowerShell 5.1 cannot read package-lock.json as JSON (its "packages" has an entry named ""), and both
# places npm writes the version to are at the top of the file.
$lock = Get-Content (Join-Path $root "package-lock.json") -Raw -Encoding UTF8
if ($lock -match '^\s*\{\s*"name"\s*:\s*"[^"]*"\s*,\s*"version"\s*:\s*"([^"]+)"') {
    $stated["package-lock.json"] = $Matches[1]
} else { throw "package-lock.json does not begin with a name and a version" }
if ($lock -match '"packages"\s*:\s*\{\s*""\s*:\s*\{[^{}]*?"version"\s*:\s*"([^"]+)"') {
    $stated["package-lock.json (packages, root entry)"] = $Matches[1]
} else { throw "package-lock.json has no version in the root entry of its packages" }
# cargo writes the version into its lock file by itself, but only when a cargo command runs after the change
$crate = [regex]::Escape((Get-CargoValue "name"))
$cargoLock = Get-Content (Join-Path $root "src-tauri\Cargo.lock") -Raw -Encoding UTF8
if ($cargoLock -match "(?m)^name = `"$crate`"\r?\nversion = `"([^`"]+)`"") {
    $stated["src-tauri\Cargo.lock"] = $Matches[1]
} else { throw "src-tauri\Cargo.lock does not name the application" }
foreach ($place in $stated.Keys) {
    if ($stated[$place] -ne $version) {
        throw ("The version is not the same everywhere: src-tauri\Cargo.toml says $version, $place says " +
               "$($stated[$place]). The release checklist in CONTRIBUTING.md says where it is set.")
    }
}
# The release workflow runs for a pushed tag and says so in the environment; -Tag says it by hand.
if (-not $Tag -and $env:GITHUB_REF_TYPE -eq "tag") { $Tag = $env:GITHUB_REF_NAME }
if ($Tag -and $Tag -ne "v$version") {
    throw ("The tag $Tag does not fit the version: src-tauri\Cargo.toml says $version, and the tag of that " +
           "version is v$version.")
}
# The changelog entry is the text of the release.
$changelog = @(Get-Content (Join-Path $root "CHANGELOG.md") -Encoding UTF8)
$heading = "## [$version]"
$first = -1
for ($i = 0; $i -lt $changelog.Count; $i++) { if ($changelog[$i].StartsWith($heading)) { $first = $i; break } }
if ($first -lt 0) {
    $newest = $changelog | Where-Object { $_ -match '^## \[' } | Select-Object -First 1
    throw "CHANGELOG.md has no section `"$heading`" for version $version (its newest section is `"$newest`")."
}
if ($Tag -and $changelog[$first] -match 'Unreleased') {
    throw ("CHANGELOG.md still says `"$($changelog[$first])`": the heading of a released version carries the " +
           "date of the release, not `"Unreleased`" (tag $Tag).")
}
# the entry ends at the next version, or at the link definitions some changelogs have at their end
$section = @()
for ($i = $first + 1; $i -lt $changelog.Count -and $changelog[$i] -notmatch '^## |^\[[^\]]+\]:\s'; $i++) {
    $section += $changelog[$i]
}
$section = @(($section -join "`n").Trim() -split "`n")
Write-Host ("ILA Studio $version$(if ($Tag) { " (tag $Tag)" }): the same in Cargo.toml, Cargo.lock, package.json " +
            "and package-lock.json; CHANGELOG.md has `"$($changelog[$first])`".")

# --- 2. Nothing but the commit ------------------------------------------------------------------------------
Step "Work tree"
# A release is built from what its tag names. A changed or untracked file would get into the package without
# being in the source that is published with it. (What .gitignore names does not count: node_modules, target.)
$dirty = $null
if (Get-Command git -ErrorAction SilentlyContinue) {
    $dirty = @(git -C $root status --porcelain)
    if ($LASTEXITCODE -ne 0) { $dirty = $null }
}
if ($null -eq $dirty) {
    if (-not $AllowDirty) {
        throw ("git cannot say whether this folder is a clean checkout (is git installed, is this a clone?). " +
               "A release is built from a commit; -AllowDirty builds a rehearsal from whatever is here.")
    }
    Write-Host "Rehearsal (-AllowDirty): not a git checkout, so nothing says which source this package is built from." -ForegroundColor Yellow
} elseif ($dirty.Count -gt 0) {
    $list = ($dirty | ForEach-Object { "  $_" }) -join "`n"
    if (-not $AllowDirty) {
        throw "The work tree is not clean - commit or remove these, or rehearse with -AllowDirty:`n$list"
    }
    Write-Host "Rehearsal (-AllowDirty): these changes are in no commit, so this package is not a release:`n$list" -ForegroundColor Yellow
} else {
    Write-Host "Clean: commit $(git -C $root rev-parse HEAD)."
}

# --- 3. The notices of the third-party software, and the licence gate ---------------------------------------
Step "Third-party notices"
# both the notices and the build read node_modules, and "npx tauri" without it would look for a tauri elsewhere
if (-not (Test-Path (Join-Path $root "node_modules\.bin\tauri.cmd"))) {
    throw "The npm packages are not installed: run `"npm ci`" first."
}
function Test-Python([string[]]$command) {
    # "python" may be the placeholder of the Microsoft Store, which is no Python and says so on stderr: ask for
    # the version. (Windows PowerShell makes errors of what a program writes to a redirected stderr, and with
    # "Stop" the first of them would end the script.)
    $ErrorActionPreference = "Continue"
    $rest = @($command | Select-Object -Skip 1)
    try {
        & $command[0] @rest -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" 2>$null | Out-Null
    } catch { return $false }
    return $LASTEXITCODE -eq 0
}
$python = $null
foreach ($candidate in @("python"), @("py", "-3")) {
    if (-not $python -and (Test-Python $candidate)) { $python = $candidate }
}
if (-not $python) {
    throw "Python 3.8 or newer was not found (tried `"python`" and `"py -3`"): tools\third_party_notices.py needs it."
}
# The tool writes THIRD-PARTY-NOTICES.md into this folder, where make_distribute.ps1 picks it up. It stops with
# exit code 1 when a component has a licence that may not go into a GPL-3.0-or-later program.
$pythonArgs = @($python | Select-Object -Skip 1) + @("-B", (Join-Path $root "tools\third_party_notices.py"))
& $python[0] @pythonArgs
if ($LASTEXITCODE -ne 0) {
    throw ("tools\third_party_notices.py stopped with exit code $LASTEXITCODE (1: a licence was refused, " +
           "2: the list could not be made) - see its message above.")
}

# --- 4. Build and assemble ----------------------------------------------------------------------------------
Step "Build"
$name = "ila-studio-$version-windows-x64"
$release = Join-Path $root "release"
$folder = Join-Path $release $name
$zip = Join-Path $release "$name.zip"
$sumFile = "$zip.sha256"
$notesFile = Join-Path $release "$name-notes.md"
# What this script wrote for this version before is its own to remove, and must not survive a run that fails.
# Never distribute\: people run the program from there, it holds their captures and saved profiles.
foreach ($old in $folder, $zip, $sumFile, $notesFile) { if (Test-Path $old) { Remove-Item $old -Recurse -Force } }
# The address crash reports are sent to is compiled into the executable from this variable. The release workflow
# hands over a repository secret, and a secret that is not set arrives as an empty variable: for the build that
# must be the same as no variable at all. The value is never printed.
if ([string]::IsNullOrWhiteSpace($env:ILA_SENTRY_DSN)) {
    [Environment]::SetEnvironmentVariable("ILA_SENTRY_DSN", $null)
    Write-Host "Crash reports: ILA_SENTRY_DSN is not set - this build has no address to send reports to."
} else {
    Write-Host "Crash reports: the address in ILA_SENTRY_DSN is compiled into this build."
}
& (Join-Path $root "make_distribute.ps1") -OutDir $folder

# --- 5. Look at the folder before it is packed --------------------------------------------------------------
Step "Checks of $folder"
$problems = @()
function Check([string]$what, [string[]]$found) {
    if (-not $found) { Write-Host "ok      $what"; return }
    $script:problems += $found
    Write-Host "FAILED  $what" -ForegroundColor Red
    $found | ForEach-Object { Write-Host "        $_" -ForegroundColor Red }
}
$expected = @($exeName, "ila_bridge.py", "ila_capture.py", "xsct_repl.tcl", "scripts\vivado_ila_repl.tcl", "LICENSE",
              "README.md", "THIRD-PARTY-NOTICES.md") + ($shipped | ForEach-Object { "profiles\$_" })
Check "the program, its scripts, the licence, the notices and the example profiles are there" @(
    $expected | Where-Object { -not (Test-Path (Join-Path $folder $_) -PathType Leaf) } |
        ForEach-Object { "missing: $_" })
# a saved profile holds local paths and the address of a hw_server
Check "profiles\ holds the shipped examples and nothing else" @(
    Get-ChildItem (Join-Path $folder "profiles") -Force | Where-Object { $shipped -notcontains $_.Name } |
        ForEach-Object { "not a shipped example: profiles\$($_.Name)" })
# what use leaves behind: the log names paths, addresses and probes, a capture holds the signals of a design
Check "no ila_log.txt, no captures\, no __pycache__" @(
    Get-ChildItem $folder -Recurse -Force |
        Where-Object { "ila_log.txt", "captures", "__pycache__" -contains $_.Name } |
        ForEach-Object { "left by use: $($_.FullName)" })

# The crates leave the paths of their source files in the executable (make_distribute.ps1 renames the cargo
# folder in them), and a path below the user folder names the person who built the release. The bytes are
# searched as text, one character for each byte, without regard to case: once as a program holds a path in
# UTF-8, once as Windows holds it in UTF-16.
$exe = Join-Path $folder $exeName
$latin1 = [Text.Encoding]::GetEncoding(28591)
$bytes = $latin1.GetString([IO.File]::ReadAllBytes($exe))
$paths = @("\Users\", "/Users/")
# a runner of GitHub keeps cargo in C:\Users\runneradmin; a PC may have its user folders somewhere else
if ($env:USERPROFILE) { $paths += $env:USERPROFILE, $env:USERPROFILE.Replace("\", "/") }
$named = @()
foreach ($path in $paths | Select-Object -Unique) {
    foreach ($form in @{ "UTF-8" = [Text.Encoding]::UTF8; "UTF-16" = [Text.Encoding]::Unicode }.GetEnumerator()) {
        $at = $bytes.IndexOf($latin1.GetString($form.Value.GetBytes($path)), [StringComparison]::OrdinalIgnoreCase)
        if ($at -ge 0) {
            # what stands around it says which crate or tool has left it there
            $from = [Math]::Max(0, $at - 40)
            $around = $bytes.Substring($from, [Math]::Min(160, $bytes.Length - $from)) -replace "`0", ""
            $named += "`"$path`" ($($form.Key)) at byte $($at): ...$($around -replace '[^\x20-\x7e]', '.')..."
        }
    }
}
Check "$exeName does not name a user folder of the PC it was built on" $named
$info = (Get-Item $exe).VersionInfo
Check "$exeName says it is version $version" @(
    ([ordered]@{ "product version" = $info.ProductVersion; "file version" = $info.FileVersion }).GetEnumerator() |
        Where-Object { $_.Value -ne $version } | ForEach-Object { "its $($_.Key) is `"$($_.Value)`"" })
if ($problems) {
    throw "The folder is not fit for a release ($($problems.Count) finding(s) above); nothing was packed."
}

# --- 6. Pack ------------------------------------------------------------------------------------------------
Step "Package"
# The folder is the one entry at the top of the archive, so that unpacking makes one folder wherever it is done.
# The names are written with "/" by hand: that is what a zip file has, whereas Compress-Archive of Windows
# PowerShell 5.1 writes "\", which other systems unpack as one long file name.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$files = @(Get-ChildItem $folder -Recurse -File -Force | Sort-Object FullName)
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $entry = "$name/" + $file.FullName.Substring($folder.Length + 1).Replace("\", "/")
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $archive.Dispose() }
# read it back: every file is in it, below the one folder
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try { $entries = @($archive.Entries | ForEach-Object { $_.FullName }) } finally { $archive.Dispose() }
if ($entries.Count -ne $files.Count -or ($entries | Where-Object { -not $_.StartsWith("$name/") -or $_.Contains("\") })) {
    throw "$zip does not hold the $($files.Count) files of the folder as it should ($($entries.Count) entries)."
}
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
# "<sum>  <file name>" and a line feed, without a byte order mark: the form "sha256sum -c" checks
[IO.File]::WriteAllText($sumFile, "$hash  $name.zip`n", (New-Object Text.ASCIIEncoding))
# The text of the release. Said every time: where the source is (the GPL asks that a binary comes with it),
# and that nobody has signed the executable, which Windows will remark on.
$notes = $section + @(
    "",
    "---",
    "",
    "SHA-256 of ``$name.zip``: ``$hash``",
    "",
    ("The executable is not signed. The source of this build is the tag ``v$version`` of this repository " +
     "(GPL-3.0-or-later); ``THIRD-PARTY-NOTICES.md`` in the folder lists the third-party software inside the " +
     "executable and its licences.")
)
[IO.File]::WriteAllText($notesFile, ($notes -join "`n") + "`n", (New-Object Text.UTF8Encoding $false))

Write-Host "Release package of ILA Studio $($version):" -ForegroundColor Green
Write-Host "  $zip  ($((Get-Item $zip).Length) bytes, $($files.Count) files)"
Write-Host "  $sumFile"
Write-Host "  $notesFile"
Write-Host "  SHA-256  $hash"
Write-Host "Nothing was published: the release workflow uploads these files, or you do."
