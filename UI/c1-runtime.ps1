$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $packageSource = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Multi-Account\code\CodexPackage.cs'
    Add-Type -Path @($packageSource, (Join-Path $PSScriptRoot 'C1Runtime.cs')) -ReferencedAssemblies @('System.Xml.dll','System.Xml.Linq.dll','System.Management.dll')
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $request = $line | ConvertFrom-Json
            switch ($request.command) {
                'probe' { $result = [C1Runtime]::Probe() }
                'recover' { $result = [C1Runtime]::Recover([int]$request.pid, [string]$request.startTicks) }
                default { throw 'Unknown C1 runtime command.' }
            }
            [Console]::WriteLine((@{ok=$true;result=$result} | ConvertTo-Json -Depth 5 -Compress))
        } catch {
            [Console]::WriteLine((@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress))
        }
    }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
