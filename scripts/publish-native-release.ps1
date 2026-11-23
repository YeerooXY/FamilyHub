param(
    [Parameter(Mandatory)][string]$NotesFile,
    [string]$WindowsDirectory,
    [string]$AndroidPackage,
    [switch]$AssetsOnly
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    [xml]$project = Get-Content -LiteralPath clients/FamilyHub.App/FamilyHub.App.csproj
    $version = [string]$project.Project.PropertyGroup.ApplicationDisplayVersion
    $tag = 'v' + $version
    $repository = 'YeerooXY/FamilyHub'
    $arguments = @('scripts/package-native-release.py')
    if ($WindowsDirectory) { $arguments += @('--windows', $WindowsDirectory) }
    if ($AndroidPackage) { $arguments += @('--android', $AndroidPackage) }
    & python @arguments
    if ($LASTEXITCODE) { throw 'Packaging failed.' }
    $release = Join-Path $repo ('.local/artifacts/releases/' + $tag)
    $assets = @(Get-ChildItem -LiteralPath $release -File | Select-Object -ExpandProperty FullName)
    $existing = @((& gh api "repos/$repository/releases" | ConvertFrom-Json) | Where-Object tag_name -eq $tag)
    if ($LASTEXITCODE) { throw 'Could not inspect existing releases.' }
    if ($existing.Count) {
        if ($existing.Count -ne 1 -or -not $existing[0].draft) { throw 'This version is already published. Increase the application version before publishing again.' }
        & gh release upload $tag @assets --repo $repository --clobber
    } else {
        & gh release create $tag @assets --repo $repository --draft --target main --title "FamilyHub $version" --notes-file $NotesFile
    }
    if ($LASTEXITCODE) { throw 'GitHub draft release upload failed. Inspect the release before retrying.' }
    $published = (& gh api "repos/$repository/releases" | ConvertFrom-Json) | Where-Object tag_name -eq $tag
    if ($LASTEXITCODE) { throw 'Could not verify the uploaded release.' }
    foreach ($file in $assets) {
        $local = Get-Item -LiteralPath $file
        $remote = @($published.assets | Where-Object name -eq $local.Name)
        $digest = 'sha256:' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($remote.Count -ne 1 -or $remote[0].size -ne $local.Length -or $remote[0].digest -ne $digest) {
            throw "GitHub package verification failed for $($local.Name). The release remains a draft."
        }
    }
    $mirrorArguments = @('scripts/deploy-native-updates.py', $release)
    if ($AssetsOnly) { $mirrorArguments += '--assets-only' }
    & python @mirrorArguments
    if ($LASTEXITCODE) { throw 'The update mirror deployment failed. The GitHub release remains a draft.' }
    & gh release edit $tag --repo $repository --draft=false --latest
    if ($LASTEXITCODE) { throw 'The update mirror is ready, but GitHub release publication failed.' }
    & gh release view $tag --repo $repository --json url,tagName,isDraft,assets
    # SideStore reads its source from the latest release, so a release without the iPhone build hides every iPhone update.
    Write-Warning ('This release has no iPhone build yet. Run the Build private iPhone app workflow (native-ios.yml), then scripts/publish-ios-release.ps1 -RunId <run> for ' + $tag + '.')
} finally { Pop-Location }
