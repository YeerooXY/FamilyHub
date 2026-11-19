FamilyHub playback and Server work verification, 19 November 2026.

Explicit play now has reserved acquisition, provider-metadata, transfer, scratch and HTTP capacity. Native next-song preparation, Radio downloads and playlist additions send a separate prefetch intent. They do not replace the current song, cancel another download, or claim listener priority. Browser queue prefetch also stays below explicit play.

The native player accepts the existing signed progressive HLS stream on Windows, Android and iOS. Windows previously opened only local files, and `CanStream` excluded Windows and iOS. For saved recordings, a streaming request can use the verified listening edition immediately while a smaller Opus copy is unavailable. That first stream can therefore transfer more bytes than the selected compressed tier. Download and cache requests still require complete, verified files.

Server work and song review mount independently. Their GET endpoints read bounded, profile-specific snapshots; a cold read waits at most 200 ms before returning a retryable error. Existing snapshots remain available while a refresh waits for worker locks. The UI marks older snapshots and enforces its own five-second deadline, including when a transport ignores cancellation. Errors expose distinct Retry controls. Snapshot wrappers apply only to GET requests. Catalogue writes retain their normal authorization and execution path.

Measured local results:

| Reproduction | Before | After |
| --- | ---: | ---: |
| Play POST acknowledgment | 2 ms | 2 ms |
| Acquisition worker entry | 3 ms | 3 ms |
| Metadata admission with a stalled background lookup | 3,010 ms | 1,036 ms |
| First decodable HLS audio over loopback HTTP | 3,276 ms | 1,258 ms |
| Server stats with 12 open status watches | 2,008 ms | 2 ms |
| Rendered UI with a transport that never answers | Previously relied on cooperative cancellation | 5.03 s, errors and working retries |

The playback reproduction runs the Flask app through Waitress and uses real FFmpeg encoding and decoding. Six background transfer leases and a metadata lookup are held for three seconds. A local 40-second Opus source supplies half its bytes, waits two seconds, and then supplies the rest. After the fix, audio arrives before the backlog releases and before source completion. The remaining metadata delay is the existing one-second provider pacing. These are individual controlled measurements, not production percentiles or measurements of the owner's live “Veridis Quo” source.

The HTTP comparison runs the same status-watch workload against the old shared 12-thread dispatcher and the new dispatcher. A two-second timer releases the watches so the old dispatcher can finish. The new dispatcher has 6 ordinary, 2 listener, 2 control, 4 media and 4 watch threads. These are HTTP/I/O threads, separate from encoder CPU admission. New requests and job-status reads do not share a pool with long-lived watches or media responses.

Background acquisition defaults to half the effective CPU count, respecting affinity and container quota. Existing idle acquisition expansion remains available for I/O. Heavy background subprocess admission is capped at half the effective cores, keeps listener headroom where capacity permits, and retains the existing spare-core and single-thread FFmpeg rules. Tagging, review and analysis do not use the listener metadata lane. The existing background niceness and idle-only scanners remain in place.

Verification:

- Full Python discovery: 541 tests, 7 skips, passed in 69.797 s. Subsequent focused CPU, analysis and listener checks: 36 passed. Final promotion, progressive media, playlist and Server work checks: 85 passed. Skips cover optional dependencies/network and platform-specific checks.
- Four initial regression assertions failed before the fixes: native prefetch cancelled explicit play, listener metadata waited for background metadata, full idle transfers blocked listeners, and review GET flushed state to disk.
- Added coverage includes 24 queued downloads, scratch headroom, immediate saved streaming, cold snapshot timeout and retry, warm snapshots during lock contention, profile/admin isolation, uncached catalogue mutations, and 12 real HTTP watches.
- Client core: 897 checks passed. Player regression executable passed.
- Rendered Razor components: a deliberately non-cooperative transport times out, clears loading, exposes both Retry controls, and successfully reloads both sections.
- Windows MAUI build passed. The existing `MainPage.xaml.cs:240` CS8620 warning remains.
- All tests/builds ran in hidden background processes at idle priority, restricted to eight logical CPUs, leaving other CPUs available. Media subprocesses inherited these limits.

Rerun from the repository root with the project's Python dependencies, FFmpeg/FFprobe and .NET 10 available. Apply idle priority and CPU affinity to the parent process before running these commands:

```text
python -m unittest discover -s tests -p test_*.py -q
python -m tests.play_on_demand_benchmark
python -m tests.server_work_benchmark --legacy-http
python -m tests.server_work_benchmark
dotnet run --project clients/FamilyHub.Client.Core.Tests
dotnet run --project clients/FamilyHub.Player.Tests
dotnet run --project clients/FamilyHub.ServerWork.Tests
node tests/server_work_visual.cjs
```

The visual script accepts `PLAYWRIGHT_MODULE` for an existing Playwright installation. It uses headless Chromium for Windows desktop and Android, and WebKit for Mac and iPhone profiles. It checks timeout and loaded states, focus, overflow, and 1280/2000-pixel desktop widths. Screenshots in this directory show the actual rendered components with fixture data; the surrounding native app shell is omitted. Mac, Android and iPhone checks are emulated. Physical-device font rendering and native audio playback remain unverified.

The four protected documentation files were not changed. No deployment, release or push was performed.
