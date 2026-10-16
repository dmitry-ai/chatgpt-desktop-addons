$ErrorActionPreference = 'Stop'
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testName = 'CodexUIRecovery-' + [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $temporaryParent $testName
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $program = Join-Path $testRoot 'RecoveryNativeTests.exe'
    $packageSource = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Multi-Account\code\CodexPackage.cs'
    & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /platform:x64 /target:exe /main:RecoveryNativeTests `
        /reference:System.Xml.Linq.dll /reference:System.Management.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
        "/out:$program" $packageSource (Join-Path $PSScriptRoot 'C1Runtime.cs') (Join-Path $PSScriptRoot 'RecoveryNativeTests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Native recovery test compilation failed.' }
    & $program
    if ($LASTEXITCODE -ne 0) { throw 'Native recovery tests failed.' }
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetDirectoryName($resolvedTestRoot) -ne $temporaryParent -or [IO.Path]::GetFileName($resolvedTestRoot) -ne $testName) {
        throw 'Unexpected temporary test path.'
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) {
        Add-Type -AssemblyName Microsoft.VisualBasic.Core
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($resolvedTestRoot,
            [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    }
}
