#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'An iOS build requires macOS and Xcode. Use the manual native-ios workflow or a Mac.' >&2
  exit 1
fi
command -v dotnet >/dev/null || { echo 'Install the .NET 10 SDK and maui-ios workload.' >&2; exit 1; }
xcrun --find clang >/dev/null
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for extension in css js; do
  cp "$repo/packages/paddock-effects/effects.$extension" "$repo/clients/FamilyHub.App/wwwroot/paddock-theme.$extension"
done
output="$repo/.local/artifacts/native/ios"
mkdir -p "$output"
ipa="$output/FamilyHub-Music-unsigned.ipa"

dotnet publish "$repo/clients/FamilyHub.App/FamilyHub.App.csproj" \
  -f net10.0-ios -c Release \
  -p:FamilyHubTargetFramework=net10.0-ios -p:RuntimeIdentifier=ios-arm64 \
  -p:EnableCodeSigning=false -p:CodesignRequireProvisioningProfile=false \
  -p:BuildIpa=true -p:ArchiveOnBuild=false -p:IpaPackagePath="$ipa"

if [[ ! -s "$ipa" ]]; then
  echo 'Build completed without the requested IPA. No installable artifact is claimed.' >&2
  exit 1
fi
unzip -t "$ipa" >/dev/null
if ! unzip -Z1 "$ipa" | grep -E '^Payload/[^/]+\.app/Info\.plist$' >/dev/null; then
  echo 'The archive does not contain an iOS app bundle.' >&2
  exit 1
fi
echo "Unsigned build: $ipa"
echo 'Sign and install with your own Apple account through SideStore/AltStore. This file cannot install directly.'
