function Get-FixturePath {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:RUNNER_OS -cne 'Windows') {
        throw 'The native installation test is limited to a disposable GitHub-hosted Windows runner.'
    }
    $fixture = [IO.Path]::GetFullPath($env:GD_WIN_FIXTURE_DIR)
    $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (![string]::Equals([IO.Path]::GetDirectoryName($fixture), $runnerTemp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($fixture) -cnotmatch '^gd-win\.[a-zA-Z0-9]{6}$') {
        throw 'Fixture must be an immediate gd-win child of runner temporary storage.'
    }
    foreach ($path in @($fixture, (Join-Path $fixture 'installed'))) {
        if ((Test-Path -LiteralPath $path) -and
            ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Unexpected reparse point in fixture isolation path: $path"
        }
    }
    return $fixture
}

function Get-FixturePayload([string] $Fixture) {
    $install = Join-Path $Fixture 'installed'
    $nameA = (Get-Content -Raw (Join-Path $Fixture 'a/app.name')).Trim()
    $nameB = (Get-Content -Raw (Join-Path $Fixture 'b/app.name')).Trim()
    if ($nameA -notmatch '^[\w][\w. -]*\.exe$' -or $nameA -cne $nameB) {
        throw 'The rendered A and B installers do not agree on their executable name.'
    }
    $hashA = (Get-Content -Raw (Join-Path $Fixture 'a/app.sha256')).Trim()
    $hashB = (Get-Content -Raw (Join-Path $Fixture 'b/app.sha256')).Trim()
    if ($hashA -notmatch '^[a-f0-9]{64}$' -or $hashB -notmatch '^[a-f0-9]{64}$' -or $hashA -eq $hashB) {
        throw 'Expected valid, distinct hashes for A and B.'
    }
    return $install, (Join-Path $install $nameA), $hashA, $hashB
}

function Get-FixtureProcesses([string] $ExePath) {
    $processName = [IO.Path]::GetFileNameWithoutExtension($ExePath)
    foreach ($process in (Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
        try {
            if ([string]::Equals($process.Path, $ExePath, [StringComparison]::OrdinalIgnoreCase)) {
                $process
            }
        } catch {
            # Exited or inaccessible process; not an identity match.
        }
    }
}
