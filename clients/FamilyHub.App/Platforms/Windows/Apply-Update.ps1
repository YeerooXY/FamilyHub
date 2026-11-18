param(
    [Parameter(Mandatory)][string]$StageDirectory,
    [Parameter(Mandatory)][string]$InstallDirectory,
    [Parameter(Mandatory)][int]$ListenerProcessId
)
$ErrorActionPreference = 'Stop'
$stage = (Resolve-Path -LiteralPath $StageDirectory).Path
$install = (Resolve-Path -LiteralPath $InstallDirectory).Path
$allowedStage = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FamilyHub\AppUpdates'
if (-not $stage.StartsWith($allowedStage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected update staging directory.' }
$payload = Join-Path $stage 'extracted\FamilyHub-Music'
$executable = Join-Path $install 'FamilyHub.App.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'The installed FamilyHub executable is missing.' }
$files = @(Get-ChildItem -LiteralPath $payload -Recurse -File)
$backup = Join-Path $stage 'backup'
$installPrefix = $install.TrimEnd('\') + '\'
$installedRoot = Split-Path -Parent $install
$launcher = if ((Split-Path -Leaf $install) -eq 'app') { Join-Path $installedRoot 'FamilyHub Music.exe' }
$changed = [System.Collections.Generic.List[object]]::new()
try {
    $listener = Get-Process -Id $ListenerProcessId -ErrorAction SilentlyContinue
    if ($listener -and $listener.Path -ne $executable -and -not $listener.HasExited) {
        throw 'The listener process does not match this installation.'
    }
    $wait = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $running = Get-Process | Where-Object {
            $path = $_.Path
            $path -and ($path.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $path -eq $launcher)
        } | Select-Object -First 1
        if (-not $running) { break }

        $remaining = 60000 - $wait.ElapsedMilliseconds
        if ($remaining -gt 0) {
            $null = $running.WaitForExit([int]$remaining)
            continue
        }

        Add-Type -AssemblyName PresentationFramework
        $choice = [System.Windows.MessageBox]::Show('Close all FamilyHub Music windows, then select Retry.', 'FamilyHub Music update', 'RetryCancel')
        if ($choice -ne 'Retry') { exit 1 }
        $wait.Restart()
    }
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($payload.Length).TrimStart('\')
        $target = [IO.Path]::GetFullPath((Join-Path $install $relative))
        if (-not $target.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'An update file escaped the application folder.' }
        $previous = Join-Path $backup $relative
        $existed = Test-Path -LiteralPath $target -PathType Leaf
        if ($existed) {
            New-Item -ItemType Directory -Path (Split-Path $previous) -Force | Out-Null
            Copy-Item -LiteralPath $target -Destination $previous
        }
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        $changed.Add([pscustomobject]@{ Target=$target; Previous=$previous; Existed=$existed })
    }
    if ((Split-Path -Leaf $install) -eq 'app' -and (Test-Path -LiteralPath (Join-Path $installedRoot 'FamilyHub Music.cmd'))) {
        & (Join-Path $install 'Install-Windows.ps1') -InstallDirectory $installedRoot -NoLaunch | Out-Null
    }
    Start-Process -FilePath $executable -WorkingDirectory $install
    # The resolved stage was checked above; installed music and profiles live elsewhere.
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    $failure = $_.Exception.Message
    $rollbackErrors = @()
    foreach ($file in $changed) {
        try {
            if ($file.Existed) { Copy-Item -LiteralPath $file.Previous -Destination $file.Target -Force }
            else { Remove-Item -LiteralPath $file.Target -Force }
        } catch { $rollbackErrors += $_.Exception.Message }
    }
    ($failure + "`n" + ($rollbackErrors -join "`n")) | Set-Content (Join-Path $stage 'update.log')
    Add-Type -AssemblyName PresentationFramework
    $message = if ($rollbackErrors.Count) {
        'The update failed and could not undo some file changes. Extract a fresh FamilyHub ZIP into a new folder.'
    } elseif ($changed.Count) {
        'The update failed. Changes from completed file copies were undone.'
    } else {
        'The update failed before any file copies completed.'
    }
    [System.Windows.MessageBox]::Show($message + "`n" + $failure + "`nDetails: " + (Join-Path $stage 'update.log'), 'FamilyHub update') | Out-Null
    if (-not $rollbackErrors.Count) { Start-Process -FilePath $executable -WorkingDirectory $install }
    exit 1
}
