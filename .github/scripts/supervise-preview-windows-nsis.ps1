$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'The native installation test is limited to a disposable GitHub-hosted runner.'
}
$fixture = [IO.Path]::GetFullPath($env:GD_WIN_FIXTURE_DIR)
$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (!$fixture.StartsWith($runnerTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    !(Split-Path $fixture -Leaf).StartsWith('gd-win.')) {
    throw 'Fixture must be below the dedicated runner temporary directory.'
}
$install = Join-Path $fixture 'installed'
$nameA = (Get-Content -Raw (Join-Path $fixture 'a/app.name')).Trim()
$nameB = (Get-Content -Raw (Join-Path $fixture 'b/app.name')).Trim()
if ($nameA -notmatch '^[\w][\w. -]*\.exe$' -or $nameA -cne $nameB) {
    throw 'The rendered A and B installers do not agree on their executable name.'
}
$exe = Join-Path $install $nameA
$hashA = (Get-Content -Raw (Join-Path $fixture 'a/app.sha256')).Trim()
$hashB = (Get-Content -Raw (Join-Path $fixture 'b/app.sha256')).Trim()
if ($hashA -eq $hashB) { throw 'A and B executables unexpectedly have identical hashes.' }

Write-Host 'START: isolated, per-user installation of A'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $fixture 'a/setup.exe'
$start.WorkingDirectory = $fixture
$start.UseShellExecute = $false
# NSIS /D must be the final argument and must not be quoted, even if
# its value contains spaces. Do not let PowerShell rejoin or re-quote it.
$start.Arguments = "/S /D=$install"
$seed = [Diagnostics.Process]::new()
$seed.StartInfo = $start
try {
    if (!$seed.Start()) { throw 'Unable to start the A installer.' }
    Write-Host "Seed installer PID: $($seed.Id); expected path: $exe"
    if (!$seed.WaitForExit(120000)) {
        $seed.Kill($true)
        throw 'A installer did not finish within 120 seconds.'
    }
    $seedExit = $seed.ExitCode
} finally {
    $seed.Dispose()
}
$installedExists = Test-Path -LiteralPath $exe -PathType Leaf
Write-Host "Seed installer exit: $seedExit; expected executable exists: $installedExists"
if ($seedExit -ne 0 -or !$installedExists) {
    if (Test-Path -LiteralPath $install -PathType Container) {
        $files = @(Get-ChildItem -LiteralPath $install -File -Force | Select-Object -First 20 -ExpandProperty Name)
        Write-Host "Files at the isolated install path (first 20): $($files -join ', ')"
    }
    if ($seedExit -ne 0) { throw "A installer returned exit code $seedExit." }
    throw "A installer returned success but did not create $exe."
}
$installedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if ($installedHash -ne $hashA) {
    throw "A executable hash differs from the independently extracted NSIS payload. Expected $hashA; got $installedHash."
}
if ((Get-Content -Raw (Join-Path $fixture 'downloads')).Trim() -ne '0') {
    throw 'B downloaded before the fixture allowed installation.'
}
Write-Host 'PASS: A matches the embedded 1.0.1 executable; B has not downloaded'

$env:GD_WIN_INSTALLED_EXE = $exe
$env:GD_WIN_INSTALL_DIR = $install
Write-Host 'START: deliver signed B through native Tauri updater'
cargo test --release --locked --manifest-path src-tauri/Cargo.toml --features windows-updater-fixture --lib preview_update_windows_test::install_signed_nsis_fixture -- --ignored --exact
if ($LASTEXITCODE -ne 0) { throw "Native updater test child failed: $LASTEXITCODE" }
if (!(Test-Path -LiteralPath (Join-Path $fixture 'native-update-invoked')) -or
    (Get-Content -Raw (Join-Path $fixture 'native-update-invoked')).Trim() -ne '1.1.1') {
    throw 'Test child did not reach native installation.'
}

$deadline = [DateTime]::UtcNow.AddSeconds(120)
$updated = $false
while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $exe) {
        try {
            if ((Get-FileHash -LiteralPath $exe).Hash -eq $hashB) {
                $updated = $true
                break
            }
        } catch {
            # The installer may briefly hold the old file open.
        }
    }
    Start-Sleep -Milliseconds 500
}
if (!$updated) { throw 'Native installer did not replace the isolated file with the embedded B payload.' }
if ((Get-Content -Raw (Join-Path $fixture 'downloads')).Trim() -ne '1') {
    throw 'Expected exactly one signed B download.'
}
Write-Host 'PASS: native NSIS replaced A with the exact embedded B executable (1.1.1)'

Write-Host 'START: launch the installed B executable'
$launched = Start-Process -FilePath $exe -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    do {
        Start-Sleep -Milliseconds 500
        $launched.Refresh()
        if ($launched.HasExited) { throw "Installed B quit early: $($launched.ExitCode)" }
    } until ($launched.MainWindowHandle -ne [IntPtr]::Zero -or [DateTime]::UtcNow -gt $deadline)
    if ($launched.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Installed B did not create its window.' }
    if ((Get-FileHash -LiteralPath $launched.Path).Hash -ne $hashB) { throw 'The launched executable was not B.' }
    Write-Host 'PASS: the installed B binary relaunched and opened a window'
} finally {
    Stop-Process -Id $launched.Id -Force -ErrorAction SilentlyContinue
}
