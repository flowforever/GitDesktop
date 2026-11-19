param([switch] $Cleanup)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preview-windows-nsis-common.ps1')
$fixture = Get-FixturePath

if ($Cleanup) {
    if (!(Test-Path -LiteralPath $fixture -PathType Container)) { return }
    $nameFile = Join-Path $fixture 'b/app.name'
    if (Test-Path -LiteralPath $nameFile -PathType Leaf) {
        $name = (Get-Content -Raw $nameFile).Trim()
        if ($name -match '^[\w][\w. -]*\.exe$') {
            $exe = Join-Path (Join-Path $fixture 'installed') $name
            foreach ($process in @(Get-FixtureProcesses $exe)) {
                Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue
                try { [void] $process.WaitForExit(5000) } catch { }
            }
        }
    }
    Remove-Item -LiteralPath $fixture -Recurse -Force
    return
}

$install, $exe, $hashA, $hashB = Get-FixturePayload $fixture
$observedHash = '(not readable yet)'
function Write-ObservedState {
    $version = '(not readable)'
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        try { $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } catch { }
    }
    Write-Host "Isolated path: $exe; expected A=$hashA; expected B=$hashB; observed SHA-256=$observedHash; PE product version=$version"
    $processes = @(Get-FixtureProcesses $exe)
    if ($processes.Count -eq 0) { Write-Host 'No process found with the exact isolated executable path.' }
    foreach ($process in $processes) {
        try {
            $process.Refresh()
            Write-Host "Isolated PID=$($process.Id); window=$($process.MainWindowHandle); title=$($process.MainWindowTitle)"
        } catch {
            Write-Host "Isolated PID=$($process.Id) exited during diagnosis."
        }
    }
}

try {
    $marker = Join-Path $fixture 'native-handoff-completed'
    if (!(Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -Raw -LiteralPath $marker).Trim() -cne $hashB) {
        throw 'Native signed-updater handoff was not confirmed by the previous step.'
    }
    Write-Host 'START: independently await the exact B payload after native NSIS handoff'
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        try { $observedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash } catch {
            $observedHash = '(not readable)'
        }
        if ($observedHash -eq $hashB) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($observedHash -ne $hashB) { throw 'Native installer did not replace the isolated executable with exact B.' }
    Write-Host 'PASS: native NSIS replaced A with the exact embedded B executable (1.1.1)'

    Add-Type -Namespace PreviewFixture -Name NativeWindow -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr window);
'@
    if (@(Get-FixtureProcesses $exe).Count -eq 0) {
        Write-Host 'START: launch the exact isolated B executable'
        $started = Start-Process -FilePath $exe -PassThru
        Write-Host "Requested app launch PID=$($started.Id)"
    } else {
        Write-Host 'START: verify the already-running app at the exact isolated path'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    do {
        foreach ($process in @(Get-FixtureProcesses $exe)) {
            try {
                $process.Refresh()
                $window = $process.MainWindowHandle
                if ($window -ne [IntPtr]::Zero -and [PreviewFixture.NativeWindow]::IsWindowVisible($window) -and
                    !$process.HasExited -and (Get-FileHash -LiteralPath $process.Path -Algorithm SHA256).Hash -eq $hashB) {
                    Write-Host "PASS: the exact installed B binary (PID=$($process.Id)) opened a visible window"
                    return
                }
            } catch {
                # Process exited or file briefly locked; continue bounded polling.
            }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The exact installed B executable did not open a visible window.'
} catch {
    try { $observedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash } catch { }
    Write-ObservedState
    throw
}
