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
$changed = [System.Collections.Generic.List[object]]::new()
try {
    $listener = Get-Process -Id $ListenerProcessId -ErrorAction SilentlyContinue
    if ($listener) {
        if ($listener.Path -ne $executable) { throw 'The listener process does not match this installation.' }
        if (-not $listener.WaitForExit(60000)) { throw 'FamilyHub did not close. Close it and try the update again.' }
    }
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($payload.Length).TrimStart('\')
        $target = [IO.Path]::GetFullPath((Join-Path $install $relative))
        if (-not $target.StartsWith($install.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'An update file escaped the application folder.' }
        $previous = Join-Path $backup $relative
        $existed = Test-Path -LiteralPath $target -PathType Leaf
        if ($existed) {
            New-Item -ItemType Directory -Path (Split-Path $previous) -Force | Out-Null
            Copy-Item -LiteralPath $target -Destination $previous
        }
        $changed.Add([pscustomobject]@{ Target=$target; Previous=$previous; Existed=$existed })
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
    $installedRoot = Split-Path -Parent $install
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
    $message = if ($rollbackErrors.Count) { 'The update failed and some files could not be restored. Extract a fresh FamilyHub ZIP into a new folder.' } else { 'The update failed. Your previous application files were restored.' }
    [System.Windows.MessageBox]::Show($message + "`n" + $failure + "`nDetails: " + (Join-Path $stage 'update.log'), 'FamilyHub update') | Out-Null
    if (-not $rollbackErrors.Count) { Start-Process -FilePath $executable -WorkingDirectory $install }
    exit 1
}
