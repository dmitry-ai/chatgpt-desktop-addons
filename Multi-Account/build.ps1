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
function Invoke-HiddenRegression {
    param([string]$Program, [string[]]$TargetArguments, [string]$ResultLog)
    $regressionArguments = @((Join-Path $PSScriptRoot 'tests\RunHidden.vbs'), $Program) + $TargetArguments + @($ResultLog) |
        ForEach-Object { '"' + $_ + '"' }
    $regressionRun = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
        -ArgumentList ($regressionArguments -join ' ') -WindowStyle Hidden -Wait -PassThru
    if (-not (Test-Path -LiteralPath $ResultLog)) { throw "Hidden GUI regression did not produce its log: $ResultLog" }
    Get-Content -LiteralPath $ResultLog
    if ($regressionRun.ExitCode -ne 0) { throw "Hidden GUI regression failed ($($regressionRun.ExitCode))." }
}
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
if ($RuntimeTest) {
    $activationOutput = Join-Path $buildOutput 'AliasActivationRegression.exe'
    & $compilerPath @compilerArguments /target:winexe /main:AliasActivationRegression "/out:$activationOutput" @sourceFiles (Join-Path $PSScriptRoot 'tests\AliasActivationRegression.cs')
    if ($LASTEXITCODE -ne 0) { throw "Alias activation regression compilation failed ($LASTEXITCODE)." }
    Invoke-HiddenRegression -Program $activationOutput -TargetArguments @((Join-Path $PSScriptRoot 'ChatGPT2.ico')) `
        -ResultLog (Join-Path $buildOutput 'alias-activation-regression.log')
}
if ($LifecycleTest) {
    $windowHost = Join-Path $buildOutput 'WindowLifecycleHost.exe'
    & $compilerPath /nologo /platform:x64 /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$windowHost" (Join-Path $PSScriptRoot 'tests\WindowLifecycleHost.cs')
    if ($LASTEXITCODE -ne 0) { throw "Window fixture compilation failed ($LASTEXITCODE)." }
    $regressionOutput = Join-Path $buildOutput 'SupervisorRegression.exe'
    & $compilerPath @compilerArguments /target:winexe /main:SupervisorRegression "/out:$regressionOutput" @sourceFiles (Join-Path $PSScriptRoot 'tests\SupervisorRegression.cs')
    if ($LASTEXITCODE -ne 0) { throw "Supervisor regression compilation failed ($LASTEXITCODE)." }
    $regressionLog = Join-Path $buildOutput 'supervisor-regression.log'
    Invoke-HiddenRegression -Program $regressionOutput -TargetArguments @($windowHost, (Join-Path $PSScriptRoot 'ChatGPT2.ico')) -ResultLog $regressionLog
}
Write-Output "Launcher built: $launcherOutput"
