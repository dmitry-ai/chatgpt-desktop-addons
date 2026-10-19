param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Prepare-CodexUpdate {
    param([string]$OriginPackage)
    $family = [CodexPackage]::Family
    $current = Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PackageFamilyName -eq $family } |
        Sort-Object Version -Descending | Select-Object -First 1
    if (-not $current) { throw 'Codex is not registered for this user.' }
    $administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    $available = if ($administrator) { @(Get-AppxPackage -Name OpenAI.Codex -AllUsers) } else { @($current) }
    $candidate = $available | Where-Object {
        $_.PackageFamilyName -eq $family -and $_.Status -eq 'Ok' -and [version]$_.Version -gt [version]$current.Version
    } | Sort-Object Version -Descending | Select-Object -First 1
    $inUse = @([C1Runtime]::PackageProcesses())
    $deferred = $false
    if ($candidate) {
        # Never force another profile or an active app to close. Register only
        # when no package processes are running so registration finishes synchronously
        # before activation and never drops launch arguments.
        if ($inUse.Count -eq 0) {
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            $manager = New-Object Windows.Management.Deployment.PackageManager
            $options = New-Object Windows.Management.Deployment.RegisterPackageOptions
            $options.DeferRegistrationWhenPackagesAreInUse = $false
            $options.ForceAppShutdown = $false
            $options.ForceTargetAppShutdown = $false
            $options.DeveloperMode = $false
            $resultType = [Windows.Management.Deployment.DeploymentResult,Windows.Management.Deployment,ContentType=WindowsRuntime]
            $progressType = [Windows.Management.Deployment.DeploymentProgress,Windows.Management.Deployment,ContentType=WindowsRuntime]
            $adapter = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
                $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
                $_.GetGenericArguments().Count -eq 2 -and $_.GetParameters().Count -eq 1
            })
            if ($adapter.Count -ne 1) { throw 'Cannot await the Windows registration operation.' }
            $operation = $manager.RegisterPackagesByFullNameAsync([string[]]@($candidate.PackageFullName),$options)
            $task = $adapter[0].MakeGenericMethod($resultType,$progressType).Invoke($null,@($operation))
            if (-not $task.Wait(30000)) { throw 'Windows registration has not completed within 30 seconds.' }
            $result = $task.GetAwaiter().GetResult()
            if ($result.ExtendedErrorCode -and $result.ExtendedErrorCode.HResult -ne 0) { throw $result.ExtendedErrorCode }
            $current = Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PackageFamilyName -eq $family } |
                Sort-Object Version -Descending | Select-Object -First 1
            $deferred = [version]$current.Version -lt [version]$candidate.Version
        } else { $deferred = $true }
    }
    $newer = $false
    if ($OriginPackage) {
        if ($OriginPackage -notmatch '^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_') { throw 'Invalid original package identity.' }
        $newer = [version]$current.Version -gt [version]$Matches[1]
    }
    return @{RegisteredPackage=$current.PackageFullName;PendingPackage=if($deferred){$candidate.PackageFullName}else{$null};
        Ready=(-not $deferred);Newer=$newer;RunningProcesses=$inUse;PreparationAvailable=$administrator}
}
try {
    $packageSource = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Multi-Account\code\CodexPackage.cs'
    Add-Type -Path @($packageSource, (Join-Path $PSScriptRoot 'C1Runtime.cs')) -ReferencedAssemblies @('System.Xml.dll','System.Xml.Linq.dll','System.Management.dll')
    if ($Launch) {
        $existing = [C1Runtime]::Probe()
        if ($null -eq $existing) {
            $prepared = Prepare-CodexUpdate
            if (-not $prepared.Ready) { throw 'A Codex update is waiting for other Codex processes to exit. Fully exit C1/C2, then open C1 again.' }
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
