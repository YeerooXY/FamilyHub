param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$repoDirectory = Split-Path -Parent $PSScriptRoot
$publishDirectory = Join-Path $repoDirectory '.local\desktop-publish'
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\FamilyHub Music'
$project = Join-Path $repoDirectory 'desktop\FamilyHub.Music.csproj'
& dotnet publish $project -c Release -r win-x64 --self-contained false --nologo -o $publishDirectory
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed; the installed app was not changed.' }
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
# Copy directory contents using a literal source directory, including the WebView2 loader.
Get-ChildItem -LiteralPath $publishDirectory | Copy-Item -Destination $installDirectory -Recurse -Force
$exe = Join-Path $installDirectory 'FamilyHub Music.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($directory in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $directory 'FamilyHub Music.lnk'))
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $installDirectory
    $shortcut.IconLocation = "$exe,0"
    $shortcut.Description = 'FamilyHub Music'
    $shortcut.Save()
}
if ($Launch) { Start-Process -FilePath $exe }
Write-Output "Installed: $exe"
