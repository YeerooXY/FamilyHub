# Private iPhone installation

Follow the [iPhone and platform release plan](PLATFORM_RELEASE_PLAN.md) for installer comparisons, automatic-renewal testing, update feeds and rollout checks. This page covers the existing unsigned build and installation procedure.

FamilyHub Music uses the configured FamilyHub server and stores downloaded songs on the phone. The native iOS source and build script are included. An iPhone installation has **not** been verified. The available test phone runs **iOS 26.6.2**, as reported by its owner; device compatibility still needs a build and a physical test.

## Build without owning a Mac

Apple's iOS toolchain requires macOS and Xcode. Windows cannot produce this MAUI iPhone build by itself. A GitHub-hosted macOS runner can perform that build while the repository stays private. The included `.github/workflows/native-ios.yml` runs **only when manually dispatched**. It has not been run as part of this implementation.

Before running it, check the repository owner's current Actions allowance and configure a spending limit that stops usage beyond the free allowance. Private-repository macOS builds consume that allowance. GitHub currently describes a $12 monthly included compute allowance for GitHub Free, with separate artifact storage limits; account plans and existing usage affect what remains. A free build is therefore conditional on available allowance. Do not enable paid overages to use these instructions. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

1. Make the source available in your private GitHub repository through your normal review/push process.
2. Check Actions usage and the spending limit. Open **Actions → Build private iPhone app → Run workflow** and check the allowance confirmation only after doing that check.
3. Download the `FamilyHub-Music-unsigned` artifact after a successful run. Artifacts are retained for one day. Extract `FamilyHub-Music-unsigned.ipa` from the artifact ZIP.
4. Sign and install the IPA using your own Apple account through SideStore or AltStore Classic. A GitHub download link alone cannot install an unsigned IPA on an iPhone.

The workflow pins the .NET SDK and action revisions and selects Xcode 26.5 from the `macos-26` image. Hosted image contents can change; a missing Xcode version fails the build explicitly. See the [runner image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md).

For a borrowed or future Mac, install .NET 10 and the compatible `maui-ios` workload/Xcode, then run:

```bash
bash scripts/build-ios-app.sh
```

The script requests an unsigned device IPA with `EnableCodeSigning=false`, `CodesignRequireProvisioningProfile=false`, and `BuildIpa=true`, then checks that the resulting ZIP contains an app bundle. It does not create a signed distribution archive or claim successful installation. These are documented [.NET iOS build properties](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties). This build path still needs its first macOS run.

## Free Apple-account setup

Each person should use their own Apple account. Enter credentials only in the chosen installer; never put passwords, pairing files, or signing keys in this repository, workflow, or chat.

Follow the current [SideStore installation guide](https://docs.sidestore.io/docs/installation/install), which covers its Windows installer, USB pairing, Developer Mode, and LocalDevVPN. Initial installation requires the phone and a computer. After setup, SideStore can refresh signing on the phone with Wi-Fi and LocalDevVPN; cellular-only access does not meet its current prerequisites. In SideStore, open **My Apps** and tap the expiry/refresh control. Prompts or account sign-in may occasionally require attention. AltStore Classic also supports phone-only renewal after setup through [Remote AltServer](https://faq.altstore.io/altstore-classic/remote-altservers), with Wi-Fi and LocalDevVPN. Select and test a route using the release plan.

With a free Apple account, signing expires after **seven days**. Refresh before that deadline. Background refresh may help, but should not be treated as guaranteed. An expired app stops opening, including when its songs are stored offline. Restore signing to use it again. The free-account limit of three sideloaded apps includes the installer app. These limits are documented in [AltStore Classic's app management guide](https://faq.altstore.io/altstore-classic/your-altstore).

If pairing stops working after an iOS update, reset, or other change, repeat the installer's computer pairing steps. Update the existing FamilyHub app using the same app identity/account to retain its local data; avoid deleting it during recovery, because uninstalling removes downloaded songs. Compatibility with the supplied iOS 26.6.2 device must be checked against the current installer's requirements during setup.

## First-device acceptance checks

- Install and open the signed app on the supplied iPhone.
- Connect to the configured HTTPS server; confirm the local-network prompt when applicable.
- Download a song, restart the app with the server unreachable, and play the saved file.
- Check playback with the screen locked and while another app is active.
- Refresh signing, reopen the app, and confirm downloaded music remains available.
- Install an updated IPA over the existing app and confirm settings and downloads persist.

The app does not bypass HTTPS certificate validation. Configure a trusted HTTPS endpoint for the server. iOS enables background audio and includes a local-network explanation; actual background playback and offline persistence require the physical checks above.
