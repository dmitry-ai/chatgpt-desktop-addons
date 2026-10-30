param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Prepare-CodexUpdate {
    param([string]$OriginPackage)
    $installed = @([CodexPackage]::SelectCandidates([CodexPackage]::Installed(), $null))
    $available = @([CodexPackage]::SelectCandidates([CodexPackage]::Available(), $null))
    if ($installed.Count -eq 0 -and $available.Count -eq 0) { throw 'Codex is not registered for this user.' }
    $current = if ($installed.Count -gt 0) { $installed[0] } else { $null }
    $best = if ($available.Count -gt 0) { $available[0] } else { $current }
    $candidate = $null
    if ($null -eq $current -or $best.Version -gt $current.Version -or [CodexPackage]::NeedsRegistration($best.FullName)) {
        $candidate = $best
    }
    $inUse = @([C1Runtime]::PackageProcesses())
    $deferred = $false
    if ($candidate) {
        # Never force another profile or an active UI window to close. When no
        # interactive Codex UI process is open, clean up any orphaned container
        # descendants and complete registration of the highest available version.
        if ($inUse.Count -eq 0) {
            [CodexPackage]::EnsureRegistered($candidate, $null) | Out-Null
            $installed = @([CodexPackage]::SelectCandidates([CodexPackage]::Installed(), $null))
            $current = if ($installed.Count -gt 0) { $installed[0] } else { $current }
            $deferred = ($null -eq $current) -or ($current.Version -lt $candidate.Version) -or [CodexPackage]::NeedsRegistration($current.FullName)
        } else { $deferred = $true }
    }
    $newer = $false
    if ($OriginPackage) {
        if ($OriginPackage -notmatch '^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_') { throw 'Invalid original package identity.' }
        $newer = ($null -ne $current) -and ($current.Version -gt [version]$Matches[1])
    }
    return @{RegisteredPackage=if($current){$current.FullName}else{$null};PendingPackage=if($deferred){$candidate.FullName}else{$null};
        Ready=(-not $deferred);Newer=$newer;RunningProcesses=$inUse;PreparationAvailable=$true}
}
try {
    $packageSource = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Multi-Account\code\CodexPackage.cs'
    Add-Type -Path @($packageSource, (Join-Path $PSScriptRoot 'C1Runtime.cs')) -ReferencedAssemblies @('System.Xml.dll','System.Xml.Linq.dll','System.Management.dll')
    if ($Launch) {
        $existing = [C1Runtime]::Probe()
        if ($null -eq $existing) {
            $prepared = Prepare-CodexUpdate
            if (-not $prepared.Ready) {
                Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ui.log') -Value (([DateTime]::UtcNow.ToString('o'))+' Codex update is pending/deferred; launching C1.')
            }
        }
        $pidStarted = [C1Runtime]::Launch($true)
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ui.log') -Value (([DateTime]::UtcNow.ToString('o'))+' C1 shortcut launch verified, PID '+$pidStarted)
        exit 0
    }
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $request = $line | ConvertFrom-Json
            switch ($request.command) {
                'probe' { $result = [C1Runtime]::Probe() }
                'probe-window' { $result = [C1Runtime]::ProbePortWindow([int]$request.port) }
                'close-hidden' { $result = [C1Runtime]::CloseHiddenProcess([int]$request.pid, [string]$request.startTicks) }
                'recover' { $result = [C1Runtime]::Recover([int]$request.pid, [string]$request.startTicks) }
                'prepare-update' { $result = Prepare-CodexUpdate -OriginPackage ([string]$request.originPackage) }
                'launch' { $result = [C1Runtime]::Launch($false) }
                default { throw 'Unknown C1 runtime command.' }
            }
            [Console]::WriteLine((@{ok=$true;result=$result} | ConvertTo-Json -Depth 5 -Compress))
        } catch {
            $errMsg = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
            [Console]::WriteLine((@{ok=$false;error=$errMsg} | ConvertTo-Json -Compress))
        }
    }
} catch {
    $errMsg = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
    [Console]::Error.WriteLine($errMsg)
    if ($Launch) {
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ui.log') -Value (([DateTime]::UtcNow.ToString('o'))+' C1 launch failed: '+$errMsg)
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($errMsg,'Codex — C1') | Out-Null
    }
    exit 1
}
