param(
    [ValidateSet('Windows', 'Android')][string]$Platform = 'Windows',
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
    [string]$AndroidSdkDirectory,
    [string]$JavaSdkDirectory
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
foreach ($extension in @('css', 'js')) {
    Copy-Item -LiteralPath (Join-Path $repo "packages/paddock-effects/effects.$extension") -Destination (Join-Path $repo "clients/FamilyHub.App/wwwroot/paddock-theme.$extension") -Force
}
$project = Join-Path $repo 'clients/FamilyHub.App/FamilyHub.App.csproj'
$output = Join-Path $repo ('.local/artifacts/native/' + $Platform.ToLowerInvariant())
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'Install the .NET 10 SDK and the target MAUI workload first.' }

if ($Platform -eq 'Windows') {
    $framework = 'net10.0-windows10.0.19041.0'
    $arguments = @('publish', $project, '-f', $framework, '-c', $Configuration,
        "-p:FamilyHubTargetFramework=$framework", '-p:RuntimeIdentifier=win-x64',
        '-p:WindowsPackageType=None', '-p:WindowsAppSDKSelfContained=true',
        '-p:SelfContained=true', '-o', $output)
} else {
    if ($Configuration -ne 'Debug') { throw 'This private Android script builds a debug-signed APK. Use -Configuration Debug; release signing is not configured.' }
    if (-not $AndroidSdkDirectory) {
        $AndroidSdkDirectory = $env:ANDROID_HOME
        if (-not $AndroidSdkDirectory) { $AndroidSdkDirectory = Join-Path ${env:ProgramFiles(x86)} 'Android/android-sdk' }
    }
    if (-not $JavaSdkDirectory) {
        $JavaSdkDirectory = $env:JAVA_HOME
        if (-not $JavaSdkDirectory) {
            $jdkRoot = Join-Path $env:ProgramFiles 'Android/openjdk'
            $JavaSdkDirectory = (Get-ChildItem -LiteralPath $jdkRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/javac.exe') } |
                Sort-Object Name -Descending | Select-Object -First 1).FullName
        }
    }
    if (-not $JavaSdkDirectory -or -not (Test-Path -LiteralPath (Join-Path $JavaSdkDirectory 'bin/javac.exe'))) {
        throw 'A JDK is required. Set JAVA_HOME or pass -JavaSdkDirectory.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $AndroidSdkDirectory 'platforms/android-36/android.jar'))) {
        throw 'Android SDK Platform 36 is required. Pass -AndroidSdkDirectory for the installed SDK.'
    }
    $framework = 'net10.0-android'
    $arguments = @('build', $project, '-t:SignAndroidPackage', '-f', $framework, '-c', 'Debug',
        "-p:FamilyHubTargetFramework=$framework", '-p:AndroidPackageFormats=apk', '-p:EmbedAssembliesIntoApk=true',
        "-p:AndroidSdkDirectory=$AndroidSdkDirectory", "-p:JavaSdkDirectory=$JavaSdkDirectory")
}
& dotnet @arguments
if ($LASTEXITCODE -ne 0) { throw "The $Platform build failed with exit code $LASTEXITCODE." }
if ($Platform -eq 'Android') {
    $apkRoot = Join-Path $repo 'clients/FamilyHub.App/bin/Debug/net10.0-android'
    $apk = Get-ChildItem -LiteralPath $apkRoot -Filter '*-Signed.apk' -File | Select-Object -First 1
    if (-not $apk) { throw 'Build completed without a signed APK. Inspect the build output.' }
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    Copy-Item -LiteralPath $apk.FullName -Destination (Join-Path $output 'FamilyHub-Music.apk')
} elseif (-not (Test-Path -LiteralPath (Join-Path $output 'FamilyHub.App.exe'))) {
    throw 'Publish completed without FamilyHub.App.exe. Inspect the build output.'
}
Write-Output "Build artifacts: $output"
