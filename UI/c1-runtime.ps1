# 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
# "Register staged MSIX updates in c1-runtime.ps1 and activate C1 on WinSta0\Default via IApplicationActivationManager":
# https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/10
param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Prepare-CodexUpdate {
	param([string]$OriginPackage)
	$installed = @([CodexPackage]::SelectCandidates([CodexPackage]::Installed(), $null))
	$available = @([CodexPackage]::SelectCandidates([CodexPackage]::Available(), $null))
	if (0 -eq $installed.Count -and 0 -eq $available.Count) {
		throw 'Codex is not registered for this user.'
	}
	$current = if (0 -lt $installed.Count) { $installed[0] } else { $null }
	$best = if (0 -lt $available.Count) { $available[0] } else { $current }
	$candidate = $null
	if ($null -eq $current -or $best.Version -gt $current.Version -or [CodexPackage]::NeedsRegistration($best.FullName)) {
		$candidate = $best
	}
	$inUse = @([C1Runtime]::PackageProcesses())
	$deferred = $false
	if ($candidate) {
		if (0 -ne $inUse.Count) {
			$deferred = $true
		}
		else {
			[CodexPackage]::EnsureRegistered($candidate, $null) | Out-Null
			$installed = @([CodexPackage]::SelectCandidates([CodexPackage]::Installed(), $null))
			$current = if (0 -lt $installed.Count) { $installed[0] } else { $current }
			$deferred = ($null -eq $current) -or ($current.Version -lt $candidate.Version) -or [CodexPackage]::NeedsRegistration($current.FullName)
		}
	}
	$newer = $false
	if ($OriginPackage) {
		if ($OriginPackage -notmatch '^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_') {
			throw 'Invalid original package identity.'
		}
		$newer = ($null -ne $current) -and ($current.Version -gt [version]$Matches[1])
	}
	return @{
		RegisteredPackage = if ($current) { $current.FullName } else { $null }
		PendingPackage = if ($deferred) { $candidate.FullName } else { $null }
		Ready = (-not $deferred)
		Newer = $newer
		RunningProcesses = $inUse
		PreparationAvailable = $true
	}
}
try {
	# 2026-10-30 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	# "Split project into code and meta (_) repositories, relocate tool KBs to _/KB/tools, and flatten code/<tool> hierarchy":
	# https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/15
	$packageSource = Join-Path (Split-Path $PSScriptRoot -Parent) 'Multi-Account\CodexPackage.cs'
	Add-Type -Path @($packageSource, (Join-Path $PSScriptRoot 'C1Runtime.cs')) -ReferencedAssemblies @('System.Xml.dll', 'System.Xml.Linq.dll', 'System.Management.dll')
	if ($Launch) {
		$existing = [C1Runtime]::Probe()
		if ($null -eq $existing) {
			$prepared = Prepare-CodexUpdate
			if (-not $prepared.Ready) {
				Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ui.log') -Value (([DateTime]::UtcNow.ToString('o')) + ' Codex update is pending/deferred; launching C1.')
			}
		}
		$pidStarted = [C1Runtime]::Launch($true)
		Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ui.log') -Value (([DateTime]::UtcNow.ToString('o')) + ' C1 shortcut launch verified, PID ' + $pidStarted)
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
			[Console]::WriteLine((@{ok = $true; result = $result} | ConvertTo-Json -Depth 5 -Compress))
		}
		catch {
			$errMsg = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
			[Console]::WriteLine((@{ok = $false; error = $errMsg} | ConvertTo-Json -Compress))
		}
	}
}
catch {
	$errMsg = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
	[Console]::Error.WriteLine($errMsg)
	if ($Launch) {
		Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ui.log') -Value (([DateTime]::UtcNow.ToString('o')) + ' C1 launch failed: ' + $errMsg)
		Add-Type -AssemblyName System.Windows.Forms
		[System.Windows.Forms.MessageBox]::Show($errMsg, 'Codex — C1') | Out-Null
	}
	exit 1
}
