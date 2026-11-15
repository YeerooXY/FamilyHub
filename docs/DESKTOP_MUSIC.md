# FamilyHub Music for Windows

Open **FamilyHub Music** from the Desktop or Start menu. The installed executable is `%LOCALAPPDATA%\Programs\FamilyHub Music\FamilyHub Music.exe`.

The Windows client has its own window, icon and persistent WebView2 profile. It reuses the existing music interface and private server. Tailscale, the Windows host, Debian VM and current forwarding processes must remain running. This installation does not change those connections or add automatic startup.

## Sign in

The non-administrator music account is **yeeroo**, with a generated four-word passphrase from the [EFF word list](https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt). Existing accounts were preserved. No password values appear in this document.

The installed client has its login saved with Windows DPAPI for the current Windows user. Open **Account → Sign-in details**, then **Show passphrase**, to read the login for a phone. The dialog saves client credentials; it does not reset a server password. **Account → Forget sign-in** removes this client's saved credentials and cookies. The interface's **Sign out** action revokes the active server session.

The client reuses a valid session and can sign in again after a server restart using its encrypted login. No password is injected into page JavaScript or saved in browser local storage. Browser sign-in offers an optional **Remember this device for 30 days** checkbox. Otherwise its session cookie ends when the browser session closes, and the server session expires after 12 hours. All server sessions end on a music-service restart.

## Music

- Library lists validated saved recordings supported by the existing source-based playback flow, including Fight Back. Other library files remain available through **Settings → Open full library player**.
- Search selects the exact recording for Listen. Enable **Allow new music downloads and discovery** to acquire new recordings.
- The bottom player has Play/Pause, Previous/Next, seeking, volume, Shuffle and queue access. Playback decks survive navigation.
- Settings holds Autoplay, queue selection, crossfade, DJ beat blending and optional search caching. Existing acquisition/cache limits and conservative transition behavior in [MOBILE_MUSIC.md](MOBILE_MUSIC.md) still apply.
- Playback preferences are saved locally; search terms and passwords are not saved there.

## Build and install

Requirements: Windows x64, .NET 10 Windows Desktop runtime and Microsoft Edge WebView2 Runtime. Both runtimes were already installed on this PC. Building also requires the .NET 10 SDK.

```powershell
./scripts/install-music-desktop.ps1
```

The script publishes the client, installs it under the current user's local Programs directory and creates Desktop and Start menu shortcuts. `-Launch` opens it. The package version and resolution are recorded in the project and lock file; generated build output is ignored. This local build is not a signed public installer.

The client uses Microsoft's [WinForms WebView2 integration](https://learn.microsoft.com/en-us/microsoft-edge/webview2/gettingstarted/winforms). Top-level navigation is limited to the exact music HTTPS origin; the known full-player HTTPS origin may open in the system browser. Other navigation, permission requests, arbitrary new windows and renderer downloads are blocked. Web messages, host objects, developer tools and password autofill are disabled. TLS certificate verification remains enabled.

## Verification, 11 November 2026

Implemented directly by the lead at the owner's request. No worker or paid fallback was started. Reused Flask/Navidrome authentication, existing APIs, source manifests, media decks, HLS attachment, queue and transition code. The new client adds Windows hosting, encrypted client credentials and shortcuts. A self-review covered changed trust boundaries and behavior; no additional independent model review ran.

- Windows suite: 73 tests passed with four expected platform/network skips. Final Debian package: 73 tests passed with one opt-in network skip. The new test checks opt-in cookie persistence, matching absolute server expiry and expired-session revocation.
- Final browser harness: Windows Chromium, emulated macOS WebKit, Android Chromium and iPhone WebKit passed navigation, error recovery, focus, Tab/Shift+Tab/Enter/Space and overflow checks. Library, search, queue, settings and sign-in captures were inspected and retained under `.local/music-browser/`. Primary-action errors remain visible outside collapsed playback details.
- Chromium decoded non-silent synthetic HLS, paused/resumed, sought, changed both decks' volume and completed the existing pitch-preserving overlap check. Desktop WebKit on this host cannot establish audio playback.
- The installed executable authenticated as yeeroo, loaded the actual library and played Fight Back with advancing playback time and media readyState 4. Native navigation-boundary/DPAPI self-check exited 0. Web messages and host objects were confirmed disabled. Physical speaker output and musical transition quality are not established by this check.
- Native keyboard input opened the Account sign-in dialog and Escape closed it. A UI Automation Invoke call timed out while the modal dialog was open; its helper was stopped without closing the app. A separate native message probe did not enumerate edit controls, so it does not establish masking behavior. The constructor sets `UseSystemPasswordChar=true`, with an explicit Show passphrase checkbox; native field masking and full dialog Tab order remain manual checks.
- Release publish completed without warnings. NuGet reported no known vulnerable packages. Source whitespace checks passed. New-account login, authenticated HLS and the existing full player succeeded over normal HTTPS.
- Deployment retained rollback copies and the existing runtime/resource limits, restarting only the music web service. Records are `.local/music/desktop-deployment.json`, `desktop-debian-check.json`, `desktop-live-api.json` and `desktop-live-smoke.json`. These records contain no passwords.

Physical Mac, Android and iPhone rendering, phone lock-screen/background playback, system media keys and DJ transition quality remain acceptance checks. Emulated captures do not establish native fonts or physical-device behavior.

The affected page/security checklist retains the private, noncommercial service scope: no payment, marketing, email, AI or public signup flows were introduced. Login/CSRF/origin checks, allowlisting, ownership checks, upload/path safeguards, CSP, TLS and finite resource limits remain. New checks cover session persistence, DPAPI, exact navigation origins and disabled native bridges. Off-machine restore and external monitoring remain outside this task; no compliance certification is claimed.
