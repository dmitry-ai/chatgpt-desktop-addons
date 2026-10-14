param(
    [string]$OutputDirectory = $PSScriptRoot,
    [switch]$Test,
    [switch]$RuntimeTest
)
$ErrorActionPreference = 'Stop'
$buildOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $buildOutput -Force | Out-Null
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$sourceFiles = @('ChatGPT2Launcher.cs','CodexPackage.cs','AppExecLink.cs','C2Process.cs') |
    ForEach-Object { Join-Path $PSScriptRoot $_ }
$compilerArguments = @('/nologo','/platform:x64','/optimize+','/reference:System.Xml.Linq.dll','/reference:System.Management.dll')
$launcherOutput = Join-Path $buildOutput 'ChatGPT2Launcher.exe'
& $compilerPath @compilerArguments /target:winexe "/win32icon:$PSScriptRoot\ChatGPT2.ico" "/out:$launcherOutput" @sourceFiles
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed ($LASTEXITCODE)." }
if ($Test -or $RuntimeTest) {
    $testOutput = Join-Path $buildOutput 'LauncherTests.exe'
    & $compilerPath @compilerArguments /target:exe /main:LauncherTests "/out:$testOutput" @sourceFiles (Join-Path $PSScriptRoot 'tests\LauncherTests.cs')
    if ($LASTEXITCODE -ne 0) { throw "Test compilation failed ($LASTEXITCODE)." }
    $testArguments = @()
    if ($RuntimeTest) { $testArguments += '--runtime' }
    & $testOutput @testArguments
    if ($LASTEXITCODE -ne 0) { throw "Launcher tests failed ($LASTEXITCODE)." }
}
Write-Output "Launcher built: $launcherOutput"
