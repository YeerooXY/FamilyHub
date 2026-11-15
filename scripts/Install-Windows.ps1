param([string]$InstallDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\FamilyHub Music'), [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$destination = [IO.Path]::GetFullPath($InstallDirectory)
$appDirectory = Join-Path $destination 'app'
$executable = Join-Path $appDirectory 'FamilyHub.App.exe'
if (-not (Test-Path -LiteralPath (Join-Path $source 'FamilyHub.App.exe') -PathType Leaf)) { throw 'Extract the complete FamilyHub Windows ZIP before installing.' }
if ($appDirectory.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an installation folder outside the extracted ZIP folder.' }
if ($source.TrimEnd('\') -ne $appDirectory.TrimEnd('\')) {
    if (Get-Process 'FamilyHub.App' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable }) { throw 'Close the installed FamilyHub Music app before installing.' }
    New-Item -ItemType Directory -Path $appDirectory -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $source) {
        if ($entry.Name -like '*.WebView2' -or $entry.Name -in @('User Data','EBWebView')) { continue }
        Copy-Item -LiteralPath $entry.FullName -Destination $appDirectory -Recurse -Force
    }
}
$iconSource = Join-Path $appDirectory 'FamilyHub.ico'
$iconDigest = (Get-FileHash -LiteralPath $iconSource -Algorithm SHA256).Hash.Substring(0,12)
$shortcutIcon = Join-Path $appDirectory ('FamilyHub-' + $iconDigest + '.ico')
if (-not (Test-Path -LiteralPath $shortcutIcon)) { Copy-Item -LiteralPath $iconSource -Destination $shortcutIcon }
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'FamilyHub Music.lnk'))
    $shortcut.TargetPath = $executable
    $shortcut.WorkingDirectory = $appDirectory
    $shortcut.IconLocation = $shortcutIcon + ',0'
    $shortcut.Description = 'FamilyHub Music'
    $shortcut.Save()
}
('@echo off' + "`r`n" + 'start "" "%~dp0app\FamilyHub.App.exe"') | Set-Content -LiteralPath (Join-Path $destination 'FamilyHub Music.cmd') -Encoding ASCII
if (-not $NoLaunch) { Start-Process -FilePath $executable -WorkingDirectory $appDirectory }
Write-Output ('Installed FamilyHub Music: ' + $destination)
