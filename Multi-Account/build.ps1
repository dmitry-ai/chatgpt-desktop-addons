param(
    [string]$OutputDirectory = $PSScriptRoot,
    [switch]$Test,
    [switch]$RuntimeTest,
    [switch]$LifecycleTest
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
if ($Test -or $RuntimeTest -or $LifecycleTest) {
    $testOutput = Join-Path $buildOutput 'LauncherTests.exe'
    & $compilerPath @compilerArguments /target:exe /main:LauncherTests "/out:$testOutput" @sourceFiles (Join-Path $PSScriptRoot 'tests\LauncherTests.cs')
    if ($LASTEXITCODE -ne 0) { throw "Test compilation failed ($LASTEXITCODE)." }
    $testArguments = @()
    if ($RuntimeTest) { $testArguments += '--runtime' }
    & $testOutput @testArguments
    if ($LASTEXITCODE -ne 0) { throw "Launcher tests failed ($LASTEXITCODE)." }
}
if ($LifecycleTest) {
    $windowHost = Join-Path $buildOutput 'WindowLifecycleHost.exe'
    & $compilerPath /nologo /platform:x64 /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$windowHost" (Join-Path $PSScriptRoot 'tests\WindowLifecycleHost.cs')
    if ($LASTEXITCODE -ne 0) { throw "Window fixture compilation failed ($LASTEXITCODE)." }
    $regressionOutput = Join-Path $buildOutput 'SupervisorRegression.exe'
    & $compilerPath @compilerArguments /target:exe /main:SupervisorRegression "/out:$regressionOutput" @sourceFiles (Join-Path $PSScriptRoot 'tests\SupervisorRegression.cs')
    if ($LASTEXITCODE -ne 0) { throw "Supervisor regression compilation failed ($LASTEXITCODE)." }
    & $regressionOutput $windowHost (Join-Path $PSScriptRoot 'ChatGPT2.ico')
    if ($LASTEXITCODE -ne 0) { throw "Supervisor lifecycle checks failed ($LASTEXITCODE)." }
}
Write-Output "Launcher built: $launcherOutput"
