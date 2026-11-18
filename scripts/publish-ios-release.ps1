param(
    # The finished native-ios.yml run that built this version's IPA.
    [Parameter(Mandatory)][long]$RunId
)
# Attaches the iPhone build to the already published release, publishes the SideStore source next to it,
# and tells the server about the new version so the iPhone app shows "Update available".
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    [xml]$project = Get-Content -LiteralPath clients/FamilyHub.App/FamilyHub.App.csproj
    $version = [string]$project.Project.PropertyGroup.ApplicationDisplayVersion
    $tag = 'v' + $version
    $repository = 'YeerooXY/FamilyHub'
    $release = Join-Path $repo ('.local/artifacts/releases/' + $tag)
    New-Item -ItemType Directory -Force -Path $release | Out-Null
    $download = Join-Path ([IO.Path]::GetTempPath()) ('familyhub-ios-' + $RunId)
    if (Test-Path $download) { Remove-Item -Recurse -Force $download }
    & gh run download $RunId --repo $repository --dir $download
    if ($LASTEXITCODE) { throw 'Could not download the iPhone build. Check that the run finished successfully.' }
    $built = Get-ChildItem -LiteralPath $download -Recurse -Filter *.ipa | Select-Object -First 1
    if (-not $built) { throw 'The run has no IPA.' }
    $name = "FamilyHub-Music-iOS-$version-unsigned.ipa"
    Copy-Item -LiteralPath $built.FullName -Destination (Join-Path $release $name) -Force
    & python scripts/sidestore-source.py --release $release --version $version --ipa $name
    if ($LASTEXITCODE) { throw 'Could not write the SideStore source.' }
    & gh release upload $tag (Join-Path $release $name) (Join-Path $release 'sidestore.json') --repo $repository --clobber
    if ($LASTEXITCODE) { throw 'GitHub upload failed.' }
    & python scripts/deploy-native-updates.py $release --platforms ios
    if ($LASTEXITCODE) { throw 'The server update notice failed. The GitHub release already has the IPA and source.' }
    Write-Output "SideStore source: https://github.com/$repository/releases/latest/download/sidestore.json"
} finally { Pop-Location }
