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
$exe = Join-Path $install 'gitdesktop.exe'
$hashA = (Get-Content -Raw (Join-Path $fixture 'a/app.sha256')).Trim()
$hashB = (Get-Content -Raw (Join-Path $fixture 'b/app.sha256')).Trim()
if ($hashA -eq $hashB) { throw 'A and B executables unexpectedly have identical hashes.' }

Write-Host 'START: isolated, per-user installation of A'
$seed = Start-Process -FilePath (Join-Path $fixture 'a/setup.exe') -ArgumentList @('/S', "/D=$install") -WindowStyle Hidden -PassThru
if (!$seed.WaitForExit(120000)) {
    Stop-Process -Id $seed.Id -Force -ErrorAction SilentlyContinue
    throw 'A installer did not finish.'
}
if ($seed.ExitCode -ne 0 -or !(Test-Path -LiteralPath $exe) -or
    (Get-FileHash -LiteralPath $exe).Hash -ne $hashA) {
    throw 'App A did not install at the isolated path with the expected hash.'
}
if ((Get-Content -Raw (Join-Path $fixture 'downloads')).Trim() -ne '0') {
    throw 'B downloaded before the fixture allowed installation.'
}
Write-Host 'PASS: A matches the compiled 1.0.1 executable; B has not downloaded'

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
if (!$updated) { throw 'Native installer did not replace the isolated file with compiled B.' }
if ((Get-Content -Raw (Join-Path $fixture 'downloads')).Trim() -ne '1') {
    throw 'Expected exactly one signed B download.'
}
Write-Host 'PASS: native NSIS replaced A with the exact compiled B executable (1.1.1)'

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
