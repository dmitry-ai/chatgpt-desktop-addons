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
if (-not ($Test -or $RuntimeTest -or $LifecycleTest)) {
    Write-Output "Launcher built: $launcherOutput"
    return
}
$testRunId = [Guid]::NewGuid().ToString('N')
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRunRoot = Join-Path $temporaryRoot ('CodexC2Run-' + $testRunId)
$testBin = Join-Path $testRunRoot 'bin'
$originalTestRoot = $env:CODEX_C2_TEST_RUN_ROOT
$env:CODEX_C2_TEST_RUN_ROOT = $testRunRoot
$testSupport = Join-Path $PSScriptRoot 'tests\TestWorkspace.cs'
try {
    New-Item -ItemType Directory -Path $testBin | Out-Null
    $testOutput = Join-Path $testBin 'LauncherTests.exe'
    & $compilerPath @compilerArguments /target:exe /main:LauncherTests "/out:$testOutput" @sourceFiles $testSupport (Join-Path $PSScriptRoot 'tests\LauncherTests.cs')
    if ($LASTEXITCODE -ne 0) { throw "Test compilation failed ($LASTEXITCODE)." }
    $testArguments = @()
    if ($RuntimeTest) { $testArguments += '--runtime' }
    & $testOutput @testArguments
    if ($LASTEXITCODE -ne 0) { throw "Launcher tests failed ($LASTEXITCODE)." }
    if ($RuntimeTest) {
        $activationOutput = Join-Path $testBin 'AliasActivationRegression.exe'
        & $compilerPath @compilerArguments /target:winexe /main:AliasActivationRegression "/out:$activationOutput" @sourceFiles $testSupport (Join-Path $PSScriptRoot 'tests\AliasActivationRegression.cs')
        if ($LASTEXITCODE -ne 0) { throw "Alias activation regression compilation failed ($LASTEXITCODE)." }
        Invoke-HiddenRegression -Program $activationOutput -TargetArguments @((Join-Path $PSScriptRoot 'ChatGPT2.ico')) `
            -ResultLog (Join-Path $testBin 'alias-activation-regression.log')
    }
    if ($LifecycleTest) {
        $windowHost = Join-Path $testBin 'WindowLifecycleHost.exe'
        & $compilerPath /nologo /platform:x64 /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$windowHost" (Join-Path $PSScriptRoot 'tests\WindowLifecycleHost.cs')
        if ($LASTEXITCODE -ne 0) { throw "Window fixture compilation failed ($LASTEXITCODE)." }
        $regressionOutput = Join-Path $testBin 'SupervisorRegression.exe'
        & $compilerPath @compilerArguments /target:winexe /main:SupervisorRegression "/out:$regressionOutput" @sourceFiles $testSupport (Join-Path $PSScriptRoot 'tests\SupervisorRegression.cs')
        if ($LASTEXITCODE -ne 0) { throw "Supervisor regression compilation failed ($LASTEXITCODE)." }
        $regressionLog = Join-Path $testBin 'supervisor-regression.log'
        Invoke-HiddenRegression -Program $regressionOutput -TargetArguments @($windowHost, (Join-Path $PSScriptRoot 'ChatGPT2.ico')) -ResultLog $regressionLog
    }
} finally {
    $env:CODEX_C2_TEST_RUN_ROOT = $originalTestRoot
    $webRoot = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Codex\web')).TrimEnd('\')
    foreach ($kind in @('runtime', 'startup')) {
        $testWebProfile = [IO.Path]::GetFullPath((Join-Path $webRoot ('c2-launcher-test-' + $testRunId + '-' + $kind)))
        if ([IO.Path]::GetDirectoryName($testWebProfile) -ne $webRoot) { throw "Unsafe test profile path: $testWebProfile" }
        if (Test-Path -LiteralPath $testWebProfile) { Remove-Item -LiteralPath $testWebProfile -Recurse -Force }
    }
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRunRoot)
    if ([IO.Path]::GetDirectoryName($resolvedTestRoot) -ne $temporaryRoot -or
        [IO.Path]::GetFileName($resolvedTestRoot) -ne ('CodexC2Run-' + $testRunId)) {
        throw "Unsafe test cleanup path: $resolvedTestRoot"
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
    Write-Output 'Temporary test builds and profiles removed.'
}
Write-Output "Launcher built: $launcherOutput"
