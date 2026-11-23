# iPhone and platform release plan

Research date: 16 November 2026. Status: proposed rollout; Apple builds, installation and renewal reliability remain unverified. This document records findings and work to follow. Unchecked tasks are pending, and recommendations are not approved support commitments.

## Requirements

- Keep distribution and signing free for the developer and family members.
- Preserve the native music app, retained song downloads and offline playback.
- After initial setup, aim for opening FamilyHub directly with at most one or two taps when intervention is needed. Free iOS signing cannot guarantee that limit during recovery.
- Deliver future versions through an installer update feed so users do not repeatedly visit GitHub.
- Reuse the existing client and limit platform-specific implementation and release work.

## Findings

### Signing, renewal and downloads

A GitHub release download can remain available indefinitely. A downloaded IPA needs signing and installation before it can run. Apple's free Personal Team provisioning expires seven days after issuance. Each successful renewal starts a new seven-day period; uploading a new release does not renew existing installations. See [Apple's account rules](https://developer.apple.com/help/account/basics/about-your-developer-account).

| Event | Expected effect on music and app data | Verification needed |
| --- | --- | --- |
| Signing renewed before expiry | Existing downloads, cache, profiles and settings remain | Physical iPhone renewal test |
| Signing expires | Local files remain, but iOS prevents FamilyHub from opening, including for offline playback | Expiry and recovery test |
| Updated IPA installed over the existing app with the same account and app identity | Downloads and settings should remain | Physical update test |
| FamilyHub deleted | Its local downloads, cache and settings are removed | Recovery instructions must warn against deletion |
| Playback cache pruned by FamilyHub | Temporary cached songs can be removed independently of renewal | Confirm retained downloads remain separate |

FamilyHub stores retained downloads under app data and manages a separate bounded playback cache. Inspect [MusicSession](../clients/FamilyHub.App/Services/MusicSession.cs), [OfflineLibrary](../clients/FamilyHub.Client.Core/OfflineLibrary.cs) and [iOS download storage](../clients/FamilyHub.App/Platforms/iOS/DownloadStorage.cs). Expected iOS persistence is not a recorded device result. Installer guidance also describes updating in place with the same account and identity. See [Sideloadly's FAQ](https://sideloadly.io/faq).

Renewal and version updates are separate operations. Renewal keeps the installed version usable. An update installs a newer FamilyHub version. A release feed addresses version delivery; it does not remove signing expiry.

### Free renewal options

| Option | How renewal works | Dependencies | Proposed use |
| --- | --- | --- | --- |
| AltStore Classic with local AltServer | Automatic attempts while the phone and computer can communicate over home Wi-Fi; USB is a recovery option | Windows PC or Mac running AltServer | First candidate when a computer is regularly on at home |
| AltStore Classic with Remote AltServer | Phone-only installation and renewal after initial pairing/setup | Wi-Fi, LocalDevVPN, remote-service availability and working Apple login | First candidate when independence from a home computer matters |
| Standalone SideStore with Shortcuts | Phone-only renewal after initial computer setup; background attempts and a refresh action for automation | Wi-Fi, LocalDevVPN, working pairing/login and automation | Alternative if the AltStore pilot does not meet the requirements |

Current AltStore Classic supports Remote AltServer. Earlier advice that AltStore always needs a nearby computer for routine renewal is outdated. Remote renewal requires Wi-Fi, not cellular-only access. SideStore's current prerequisites also require Wi-Fi and LocalDevVPN. These requirements apply to installation, updates and renewal, not playback of completed local downloads. See [AltServer](https://faq.altstore.io/altstore-classic/altserver), [Remote AltServer](https://faq.altstore.io/altstore-classic/remote-altservers), [SideStore prerequisites](https://docs.sidestore.io/docs/installation/prerequisites) and [SideStore's FAQ](https://docs.sidestore.io/docs/faq.html).

Sideloadly also supports automatic renewal through a computer daemon when the device is detected over Wi-Fi or USB. It is a recovery or computer-managed alternative; new IPA versions must be supplied to it. See [Sideloadly's FAQ](https://sideloadly.io/faq).

### What user reports establish

There is no representative success-rate evidence in the reviewed sources to identify a signer that works for most users. Forum posts and issue trackers show successful configurations and failure cases; their counts do not measure reliability across all installations.

- A [SideStore automation discussion](https://www.reddit.com/r/sideloaded/comments/1qqyn59/auto_refresh_for_sidestore_with_localdevvpn/) includes reports of dependable daily refresh and reports that scheduled refresh fails while manual refresh works.
- A [SideStore project discussion](https://github.com/orgs/SideStore/discussions/1303) discusses inconsistent background scheduling and suggests Shortcuts as an alternative trigger.
- An [AltStore authentication issue](https://github.com/altstoreio/AltStore/issues/1842) includes successful recovery after updates alongside continuing sign-in failures.
- [AltStore's release notes](https://faq.altstore.io/release-notes/altstore) record fixes for background refresh and signing errors. [SideStore's releases](https://github.com/SideStore/SideStore/releases) record Apple-side authentication changes that broke older versions.

Recommendation: pilot the current official AltStore Classic release first, choose local or remote renewal according to available hardware, and keep standalone SideStore as an alternative. Record the exact versions tested. Free signing remains dependent on Apple and installer behavior, so occasional assistance must remain an explicit limitation.

### Web app alternative

A Home Screen web app can open without Safari tabs or an address bar, and caching can reduce repeat network transfers. Audio data use depends primarily on the delivered files and caching strategy. Browser storage has quotas and eviction rules; persistent storage is subject to WebKit's policy. Offline-library retention and background queue playback still need physical iPhone tests. See [Apple's web-app explanation](https://developer.apple.com/videos/play/wwdc2023/10120/) and [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

The proposed rollout keeps the native client because retained downloads and background music behavior are priorities. The existing web client remains useful for browser access and Linux.

## Current project state

These observations come from source and documentation inspected on 16 November 2026. The working tree includes unrelated changes. Recheck the selected release commit before implementation.

| Area | Observed state | Source |
| --- | --- | --- |
| Shared native client | MAUI Blazor app with Android and iOS targets; Windows target enabled on Windows | [App project](../clients/FamilyHub.App/FamilyHub.App.csproj) |
| Shared storage and server access | Portable client core used by the native app | [Client core](../clients/FamilyHub.Client.Core/README.md) |
| iPhone build | Unsigned IPA script and manually dispatched macOS workflow exist; existing records report build/device checks pending | [Build script](../scripts/build-ios-app.sh), [workflow](../.github/workflows/native-ios.yml), [installation guide](IOS_PRIVATE_INSTALL.md) |
| iPhone and iPad | Device families 1 and 2 declared; background audio declared | [iOS Info.plist](../clients/FamilyHub.App/Platforms/iOS/Info.plist) |
| Mac | Mac Catalyst starter files exist; target is absent from the app's target-framework list | [Mac platform files](../clients/FamilyHub.App/Platforms/MacCatalyst), [app project](../clients/FamilyHub.App/FamilyHub.App.csproj) |
| Apple playback | Non-Windows native media adapter exists; Apple lock-screen, queue and codec behavior need device checks | [Media adapter](../clients/FamilyHub.App/Services/MauiAudioDeck.cs), [Android playback controls](../clients/FamilyHub.App/Platforms/Android/PlaybackControls.cs) |
| File access and audio output | Folder picker implements Windows/Android paths; audio-output UI is restricted to those platforms | [Folder picker](../clients/FamilyHub.App/Services/LocalAudioFolderPicker.cs), [audio-output UI](../clients/FamilyHub.App/Components/AudioOutputPicker.razor) |
| Releases and updates | Packaging, server update mirror and in-app update platform selection currently cover Windows and Android | [Packager](../scripts/package-native-release.py), [publisher](../scripts/publish-native-release.ps1), [mirror](../scripts/deploy-native-updates.py), [updater](../clients/FamilyHub.App/Services/AppUpdater.cs) |

Windows has the strongest recorded device verification. Android builds exist, while mobile acceptance gaps remain in [Native apps](NATIVE_APPS.md). An enabled target or successful compilation does not establish device support.

## Rollout steps

### 1. Establish the first iPhone build

- [ ] Record the release commit, .NET SDK/workload and compatible Xcode versions. Check that the workflow's selected Xcode exists on its runner.
- [ ] Check the owner's available Actions allowance and an enforced spending stop before dispatching a private-repository build. Keep paid overages disabled.
- [ ] Build the unsigned IPA with the existing script and verify the artifact structure.
- [ ] Install through the selected signer with the phone owner's Apple account. Record installer, VPN and iOS versions.
- [ ] Connect to the trusted HTTPS FamilyHub endpoint and select a profile. For the current private server, verify Tailscale access as well as ordinary Wi-Fi.

Enter Apple credentials only in the chosen installer. Keep credentials, pairing files and signing keys out of source, release assets and chat. Follow [Private iPhone installation](IOS_PRIVATE_INSTALL.md) for the existing build procedure.

### 2. Verify and finish native music behavior

- [ ] Play the actual server formats and both quality settings. Add compatible delivery only if device tests identify a codec/container problem.
- [ ] Download songs, fully close and reopen the app, then play in airplane mode. Reboot the phone and repeat.
- [ ] Confirm retained downloads survive playback-cache pruning and profile switching.
- [ ] Test screen-locked playback through several queue transitions, pause/resume, seeking and next/previous.
- [ ] Check lock-screen controls, headphones, Bluetooth routing and interruptions. Implement missing Apple-specific controls where needed.
- [ ] Interrupt a download and verify recovery without accepting a partial file as complete.
- [ ] Test downloads with the app backgrounded. Either implement reliable background transfer or document the observed foreground requirement.
- [ ] Check Wi-Fi-only download preferences and changes between Wi-Fi, cellular and no network.
- [ ] Implement or clearly omit unsupported Apple file-import actions. Keep ordinary music playback independent of optional folder importing.

### 3. Check iPhone and iPad interactions

- [ ] Verify notch/home-indicator spacing, small screens, text enlargement, keyboard opening, portrait and landscape layouts.
- [ ] Verify touch target sizes, VoiceOver names, visible errors and focus after controls disappear. Test Tab, Shift+Tab, Enter and Space where keyboard input applies.
- [ ] Verify the universal package on an actual iPad, including narrow multitasking widths, before claiming iPad support.
- [ ] For shared website visual changes, retain PC Chromium, Mac Safari, Android Chrome and iPhone Safari captures and a verification record. Label emulation and outstanding real-device checks accurately.

Keep the selected FamilyHub composition. Reuse live accessible text and controls; preserve the project's exclusions for baked-in artwork text, callouts and clusters of three radiating strokes.

### 4. Test automatic renewal before family rollout

- [ ] Configure daily renewal of FamilyHub and the installer, with several days of expiry margin. For local AltServer, start it with the computer and test home Wi-Fi discovery.
- [ ] For phone-only renewal, configure the required Wi-Fi/VPN steps and test the actual Shortcuts refresh action. Do not make opening FamilyHub the only trigger.
- [ ] Provide a visible way to check expiry/refresh status and a manual refresh fallback. Verify success in the installer instead of assuming that an automation notification proves renewal.
- [ ] Observe the setup for two to three weeks. Include locked-phone operation, reboot, low-power conditions, missed Wi-Fi opportunities and reconnecting afterward.
- [ ] On a test installation, let FamilyHub expire while retaining a working recovery path. Renew it in place and verify that downloads, profiles and settings remain.
- [ ] Test recovery if the installer expires or pairing/login fails. Record when a computer is needed. Do not delete FamilyHub as the default recovery step.
- [ ] Have one family member follow the instructions. Record assistance required and whether ordinary use meets the one-or-two-tap goal.

Advance only when actual renewal, offline playback and in-place updates pass. If common recovery exceeds the user's acceptable effort, record that the free-native route does not meet the requirement. Do not describe it as maintenance-free.

### 5. Integrate installation and future updates

- [ ] Choose accessible HTTPS hosting for the IPA and installer source feed. The repository was private when checked; an installer cannot be assumed to have browser GitHub authentication. Verify downloads through the actual installer.
- [ ] Generate source metadata from the packaged app, including stable bundle identity, version/build, compatible OS range, file size and permissions. Include checksums where supported.
- [ ] Upload and verify the IPA before advertising it in the feed. Preserve previous compatible versions and publish the feed only after validation.
- [ ] Add the source once during setup. Verify that a later release appears and installs through the installer without another GitHub visit. [AltStore distribution](https://faq.altstore.io/developers/distribute-with-altstore-classic) and [update format](https://faq.altstore.io/developers/updating-apps) describe this process.
- [ ] Keep the same Apple account and installed app identity for updates. Avoid identity changes or experimental bundle randomization during the persistence pilot.
- [ ] Verify that a failed update leaves the existing installation and downloaded music usable. Test two successive versions.
- [ ] Extend packaging and publication for Apple assets without claiming that FamilyHub's Windows/Android updater can install an iOS IPA itself.

## Platform support and maintenance

Proposed initial support groups:

| Devices | Distribution target | Additional work |
| --- | --- | --- |
| Windows PCs and tablets | Windows package | Native window, playback and update checks; test tablet layout if offered |
| Android phones and tablets | Android APK | Background playback, Android installation and phone/tablet layout checks |
| iPhone and iPad | One universal iOS IPA | Apple playback, renewal and updates; physical checks on both device types |
| Mac desktops and laptops | Mac Catalyst package | Enable target, build/package, test desktop interaction and installation |
| Linux desktops | Existing browser client initially | Browser compatibility checks; native desktop support remains a separate decision |

Share interface components, API behavior, storage, playlists and player logic. Keep platform-specific playback, file access, installation and update behavior in their existing platform boundaries. Phone and tablet layouts still need separate checks even when their binary is shared.

MAUI's standard targets include Windows, Android, iOS and Mac Catalyst. Linux support is experimental and explicitly unsupported by Microsoft. A native Linux promise would add a separate compatibility and testing obligation. See [supported platforms](https://learn.microsoft.com/en-us/dotnet/maui/supported-platforms?view=net-maui-10.0) and [experimental backends](https://learn.microsoft.com/en-us/dotnet/maui/developer-tools/platform-backends/?view=net-maui-10.0).

After the iPhone pilot, enable and verify Mac Catalyst separately. Free unsigned distribution is supported, but normal macOS installation can require explicit security approval. Test that experience on a clean Mac and document the observed steps. Decide Apple Silicon/Intel coverage before advertising it. See [unsigned Mac publishing](https://learn.microsoft.com/en-us/dotnet/maui/mac-catalyst/deployment/publish-unsigned?view=net-maui-10.0).

### Future release process

1. Select the changed scope. A platform-specific hotfix can ship independently. Shared changes require checks across supported targets. A compatible server-only change can ship without rebuilding clients.
2. Run shared core/player and relevant server checks. Build affected packages from the same selected commit with pinned toolchains. A common release should build every supported native target.
3. Check installation/update, profile restoration, a downloaded offline song and playback on supported devices. Exercise background playback and routing when media or lifecycle code changes. Run the full acceptance set for new platforms and toolchain/major OS changes.
4. Package artifacts, matching source and checksums. Proposed common assets are a Windows ZIP, Android APK, universal iOS IPA and Mac package. Label availability and verification per platform.
5. Upload as a draft, verify files and hashes, then publish release metadata and installer feeds. Keep the prior release available. Separate client packaging from server deployment when the server does not need updating.
6. Record the source commit, toolchain, devices, passed checks and remaining gaps. Preserve API compatibility for the installed client versions explicitly listed as supported; agree that version window before removing API behavior.

Preserve Android's existing installation signing identity when moving builds into automation. The current helper produces a private debug-signed APK. A different key can prevent in-place updates, so release-key migration needs a separate plan that accounts for installed users and their data.

Automate package creation and feed generation. Human/device verification, OS-specific regressions and occasional .NET/Xcode/Android toolchain upgrades remain ongoing work. Avoid adding CPU architectures or older OS versions without a concrete user need and a way to test them.

### Cost and effort

Planning estimates, not measured delivery times:

| Scope | Estimate |
| --- | --- |
| iPhone build, device fixes and release/update integration | 3 to 6 engineering days, subject to first-build and playback findings |
| Renewal observation | 2 to 3 calendar weeks, overlapping other work |
| Mac support after the iPhone pilot | 1 to 3 engineering days, subject to packaging and device findings |
| Routine shared releases | Moderate additional build and device-check work; estimate after the first complete release |
| Native Linux and broad architecture/old-OS coverage | Separate scope; no estimate until requirements and a prototype exist |

The earlier conversation's 2-to-5-day estimate covered optimistic packaging work. It should not be used as a promise for tested family-ready support on both Apple platforms.

The private repository's hosted builds consume the owner's included Actions allowance. Public standard-runner builds are free under GitHub's documented rules, while private builds and artifact storage have allowances and billing conditions. A public binary-distribution repository alone does not make private-source builds free. Use an existing/borrowed Mac or enforce the private build/storage budget. No billing setting or repository visibility change is authorized by this plan. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Pilot record

Fill this in during execution. The current document records research and source inspection only; no build, installation, renewal or device test was performed for this documentation task.

| Field | Result |
| --- | --- |
| Release commit and version | Pending |
| .NET/workload/Xcode versions | Pending |
| Device models and actual OS versions | Pending; previous owner-reported iPhone version needs confirmation |
| Installer/VPN versions and local or remote renewal mode | Pending |
| First install and server connection | Pending |
| Actual audio formats and background queue | Pending |
| Offline downloads after restart/reboot | Pending |
| Renewal observation dates and confirmed renewals | Pending |
| Deliberate expiry and in-place recovery | Pending |
| Successive version update and retained downloads | Pending |
| Family-member setup/use and assistance required | Pending |
| iPad, Mac and other device checks | Pending |
| Decision and accepted limitations | Pending |

Recheck external installer documentation and release notes before execution. Signing services and Apple authentication behavior can change independently of FamilyHub releases.
