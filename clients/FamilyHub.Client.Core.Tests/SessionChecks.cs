using System.Text.Json;
using System.Net;
using System.Text;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;

internal static class SessionChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        var reachable = true;
        var removed = false;
        var unauthorized = false;
        var publishLibrary = false;
        var audio = Encoding.UTF8.GetBytes("Verified playback cache fixture");
        var recording = new MusicTrack { Id = "abcdefghijk", Saved = true, Title = "Cached recording",
            DownloadUrl = "/api/library/abcdefghijk/download", DownloadExtension = ".m4a", DownloadSize = audio.Length,
            DownloadSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(audio)) };
        PlaybackResume? remotePlayback = null;
        var checkpointCount = 0;
        PlaybackHandover? activityCommand = null;
        var activityReports = new List<JsonElement>();
        JsonElement activityBody = default;
        long? ownershipEpoch = null;
        var rejectActivity = false;
        Action? duringActivity = null;
        var searchOffsets = new List<int>();
        var audioRequests = 0;
        var originalAudioRequests = 0;
        var compressedAudio = Encoding.UTF8.GetBytes("Smaller playback fixture");
        var playbackInfoRequests = 0;
        recording = recording with { PlaybackInfoUrl = "/api/library/abcdefghijk/playback-info" };
        var compressed = recording with { Lufs = -14, TruePeak = -5,
            PlaybackSourceSha256 = recording.DownloadSha256, PlaybackVersion = "opus96-v2",
            DownloadUrl = $"/api/library/abcdefghijk/playback/{recording.DownloadSha256.ToLowerInvariant()}/audio.m4a",
            DownloadSize = compressedAudio.Length,
            DownloadSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(compressedAudio)).ToLowerInvariant()
        };
        // Production SHA-256 values are lower-case, including the source address.
        recording = recording with { DownloadSha256 = recording.DownloadSha256.ToLowerInvariant() };
        compressed = compressed with { PlaybackSourceSha256 = recording.DownloadSha256 };
        HttpResponseMessage Json(string value) => new(HttpStatusCode.OK)
            { Content = new StringContent(value, Encoding.UTF8, "application/json") };
        FamilyHubApi Api(Uri origin) => new(origin, new SessionHandler(request =>
        {
            if (!reachable) throw new HttpRequestException("Server is unreachable.");
            if (unauthorized) return new(HttpStatusCode.Unauthorized);
            if (request.RequestUri!.AbsolutePath == recording.PlaybackInfoUrl)
            { playbackInfoRequests++; return Json(System.Text.Json.JsonSerializer.Serialize(compressed, FamilyHubApi.JsonOptions)); }
            if (request.RequestUri!.AbsolutePath == compressed.DownloadUrl)
            { audioRequests++; return new(HttpStatusCode.OK) { Content = new ByteArrayContent(compressedAudio) }; }
            if (request.RequestUri!.AbsolutePath == recording.DownloadUrl)
            { originalAudioRequests++; return new(HttpStatusCode.OK) { Content = new ByteArrayContent(audio) }; }
            if (request.RequestUri!.AbsolutePath == "/api/profile/playback")
            {
                if (request.Method == HttpMethod.Patch)
                {
                    using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                    var checkpoint = body.RootElement.GetProperty("playback");
                    Check(!checkpoint.TryGetProperty("track_ids", out _) && checkpoint.GetProperty("track_id").GetString() == recording.Id, "Position checkpoint retransmitted the queue");
                    remotePlayback = remotePlayback! with { Position = checkpoint.GetProperty("position").GetDouble() };
                    checkpointCount++;
                }
                if (request.Method == HttpMethod.Put)
                {
                    var body = System.Text.Json.JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                    Check(body.RootElement.GetProperty("profile_id").GetString() == "alex", "Playback upload lost profile identity");
                    remotePlayback = body.RootElement.GetProperty("playback").Deserialize<PlaybackResume>(FamilyHubApi.JsonOptions);
                }
                return Json(System.Text.Json.JsonSerializer.Serialize(new { profile_id = "alex", playback = remotePlayback }, FamilyHubApi.JsonOptions));
            }
            if (request.RequestUri.AbsolutePath == "/api/playback/activity")
            {
                using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                activityBody = body.RootElement.Clone();
                activityReports.Add(body.RootElement.GetProperty("device_info").Clone());
                if (rejectActivity) return new(HttpStatusCode.ServiceUnavailable);
                var response = Json(JsonSerializer.Serialize(new { counters_accepted = true, command = activityCommand, epoch = ownershipEpoch }, FamilyHubApi.JsonOptions));
                var callback = duringActivity; duringActivity = null; callback?.Invoke();
                return response;
            }
            if (request.RequestUri.AbsolutePath == "/api/playback/takeover")
            {
                using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                Check(request.Method == HttpMethod.Post && body.RootElement.GetProperty("from").GetString() == new string('b', 32)
                    && body.RootElement.GetProperty("to").GetString()?.Length == 32, "Takeover posted the wrong devices");
                return Json("""{"id":"takeover","target":"Windows","source_paused":false}""");
            }
            if (request.RequestUri!.AbsolutePath == "/api/search")
            {
                var body = System.Text.Json.JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                var offset = body.RootElement.GetProperty("offset").GetInt32(); searchOffsets.Add(offset);
                return Json(offset == 0 ? "{\"results\":[{\"id\":\"pageone0001\",\"title\":\"First page\"}],\"next_offset\":8}" : "{\"results\":[{\"id\":\"pagetwo0001\",\"title\":\"Second page\"}],\"next_offset\":null}");
            }
            return request.RequestUri!.AbsolutePath switch
            {
                "/api/jobs" => Json("{\"job\":{\"id\":\"preview\",\"source_id\":\"abcdefghijk\",\"state\":\"running\",\"stream_url\":\"/api/jobs/preview/media/index.m3u8?ticket=test\"}}"),
                "/api/connect" => Json("{\"family_profiles\":true,\"csrf_token\":\"boot\",\"profiles\":" +
                    (removed ? "[]" : "[{\"id\":\"alex\",\"name\":\"Alex\"},{\"id\":\"sam\",\"name\":\"Sam\"}]") + "}"),
                "/api/profile/select" => Json("{\"profile\":{\"id\":\"alex\",\"name\":\"Alex\"},\"csrf_token\":\"selected\",\"preferences\":{\"volume\":0.8,\"shuffle\":false}}"),
                "/api/listening/summary" => Json("{}"),
                "/api/library" => Json(System.Text.Json.JsonSerializer.Serialize(new { results = publishLibrary ? new[] { recording } : [] }, FamilyHubApi.JsonOptions)),
                "/api/playlists" => Json("{\"playlists\":[]}"),
                _ => throw new Exception("Unexpected endpoint " + request.RequestUri)
            };
        }));
        var session = new MusicSession(Api);
        try
        {
            await session.ConnectServerAsync("https://profiles.test");
            Check(session.NeedsProfileSelection && session.Profiles.Count == 2, "Connected profile chooser missing");
            await session.SelectProfileAsync("alex");
            Check(session.Connected && session.ProfileName == "Alex", "Online profile selection failed");
            var previewTrack = await session.EnsureServerRecordingAsync(recording with { DownloadUrl = "" }, CancellationToken.None, allowPreview: true);
            Check(previewTrack.PlaybackVersion == "preview-hls", "Acquisition waited past the ready preview");
            var previewStream = await session.StreamPlaybackAsync(previewTrack, 0, CancellationToken.None);
            Check(previewStream.Contains("/api/jobs/preview/media/index.m3u8?ticket=test"), "Preview lost its signed HLS address");
            Check(session.PlaybackRecording(previewTrack, previewStream).PlaybackVersion == "preview-hls" && playbackInfoRequests == 0 && audioRequests == 0,
                "Preview requested a finished phone copy or lost its playback metadata");
            var handedOver = 0;
            session.PlaybackHandedOver += _ => handedOver++;
            await session.ReportPlaybackActivityAsync(false);
            Check(activityReports[^1].GetProperty("activation").GetInt64() == 0, "Startup check-in activated playback");
            session.MarkLocalPlayback();
            var localActivation = session.PlaybackActivation;
            activityCommand = new() { Id = "phone-active", Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel", Playing = true,
                Activation = DateTime.UtcNow.AddDays(1).Ticks, Position = 12, Track = new() { Id = recording.Id } };
            await session.ReportPlaybackActivityAsync(true, 3);
            Check(handedOver == 1 && session.PlaybackActivation == localActivation, "Pause command was dropped or echoed a local activation");
            Check(activityReports[^1].GetProperty("epoch").GetInt64() == 0 && activityReports[^1].GetProperty("local_play").GetBoolean(),
                "First local play omitted its initial ownership epoch");
            await session.ReportPlaybackActivityAsync(false, 12, remoteDeviceId: new string('b', 32));
            Check(handedOver == 1 && activityReports[^1].GetProperty("remote_device").GetString() == new string('b', 32), "Pause command was redelivered or remote target was omitted");
            session.RetryPauseCommand("phone-active");
            await session.ReportPlaybackActivityAsync(false, 12, remoteDeviceId: new string('b', 32), force: true);
            Check(handedOver == 2, "An unapplied pause could not be delivered again");
            session.MarkLocalPlayback();
            Check(session.PlaybackActivation > activityCommand.Activation, "Takeback did not advance beyond the remote activation watermark");
            var takebackActivation = session.PlaybackActivation;
            await session.ReportPlaybackActivityAsync(false, 12, status: "paused");
            Check(!activityReports[^1].TryGetProperty("local_play", out var pausedLocalPlay) || !pausedLocalPlay.GetBoolean(),
                "Leaving remote playback claimed ownership while paused");
            await session.ReportPlaybackActivityAsync(false, 12, status: "buffering");
            Check(!activityReports[^1].TryGetProperty("local_play", out var bufferingLocalPlay) || !bufferingLocalPlay.GetBoolean(),
                "Preparing local playback claimed ownership while buffering");
            await session.ReportPlaybackActivityAsync(true, 12, status: "playing");
            Check(activityReports[^1].TryGetProperty("local_play", out var startedLocalPlay) && startedLocalPlay.GetBoolean()
                && activityReports[^1].GetProperty("activation").GetInt64() == takebackActivation,
                "The paused check-in consumed the activation needed for local playback");
            await session.ReportPlaybackActivityAsync(true, 12, status: "playing", force: true);
            Check(!activityReports[^1].TryGetProperty("local_play", out var repeatedLocalPlay) || !repeatedLocalPlay.GetBoolean(),
                "Continued playback claimed ownership again");
            activityCommand = activityCommand with { Id = "follower-pause" };
            await session.ReportPlaybackActivityAsync(false, followingHost: true);
            Check(handedOver == 2 && activityReports[^1].GetProperty("following_host").GetBoolean(), "Follower received arbitration commands or omitted its exemption");
            activityCommand = activityCommand with { Id = "stale-pause", Activation = activityCommand.Activation + 100 };
            var staleActivation = activityCommand.Activation;
            duringActivity = () =>
            {
                session.MarkLocalPlayback(); activityCommand = null;
                _ = session.ReportPlaybackActivityAsync(true, 15);
            };
            session.MarkLocalPlayback();
            var beforePending = activityReports.Count;
            await session.ReportPlaybackActivityAsync(true, 14);
            Check(handedOver == 2 && activityReports.Count == beforePending + 2, "Stale pause interrupted a newer local action or deferred activation waited for the timer");
            Check(activityReports[^1].GetProperty("activation").GetInt64() > staleActivation, "Deferred local action did not advance past the stale response");
            Check(activityReports.Select(r => r.GetProperty("sequence").GetInt64()).SequenceEqual(Enumerable.Range(1, activityReports.Count).Select(i => (long)i)), "Activity reports lost monotonic ordering");
            activityCommand = null;
            ownershipEpoch = 42;
            await session.ReportPlaybackActivityAsync(false, 12, status: "paused", duration: 180, track: recording, queue: [recording], queueIndex: 0);
            var paused = activityReports[^1];
            Check(paused.GetProperty("status").GetString() == "paused" && paused.GetProperty("duration").GetInt32() == 180
                && paused.GetProperty("queue").GetProperty("track_ids")[0].GetString() == recording.Id
                && activityBody.GetProperty("position").GetDouble() == 12 && activityBody.GetProperty("track").GetProperty("id").GetString() == recording.Id,
                "Paused check-in lost its track, position, or queue");
            var revision = paused.GetProperty("queue_rev").GetInt64();
            session.AcknowledgePlaybackCommand("pause-1");
            rejectActivity = true;
            await session.ReportPlaybackActivityAsync(false, 30, status: "paused", duration: 180, track: recording, queue: [recording], queueIndex: 0, force: true);
            rejectActivity = false;
            await session.ReportPlaybackActivityAsync(false, 30, status: "paused", duration: 180, track: recording, queue: [recording], queueIndex: 0, force: true);
            var seek = activityReports[^1];
            Check(!seek.TryGetProperty("queue", out _) && seek.GetProperty("queue_rev").GetInt64() == revision
                && seek.GetProperty("epoch").GetInt64() == 42 && !seek.GetProperty("local_play").GetBoolean()
                && seek.GetProperty("acks")[0].GetString() == "pause-1" && activityBody.GetProperty("position").GetDouble() == 30,
                "Completed seek was throttled, resent the queue, or omitted the pause acknowledgment");
            await session.ReportPlaybackActivityAsync(false, 30, status: "paused", duration: 180, track: recording, queue: [recording, recording], queueIndex: 1);
            var edited = activityReports[^1];
            Check(edited.GetProperty("queue_rev").GetInt64() == revision + 1 && edited.GetProperty("queue").GetProperty("index").GetInt32() == 1
                && !edited.TryGetProperty("acks", out _), "Queue changes waited for the timer or a successful acknowledgment was repeated");
            ownershipEpoch = 43;
            duringActivity = () =>
            {
                session.MarkLocalPlayback();
                _ = session.ReportPlaybackActivityAsync(true, 31, status: "playing", duration: 180, track: recording);
            };
            await session.ReportPlaybackActivityAsync(false, 30, force: true);
            var localPlay = activityReports[^1];
            Check(localPlay.GetProperty("local_play").GetBoolean() && localPlay.GetProperty("epoch").GetInt64() == 42,
                "A queued local play claimed an ownership epoch issued after the user pressed play");
            var takeover = await session.Api!.TakeOverPlaybackAsync(new string('b', 32), session.DeviceId);
            Check(takeover is { Id: "takeover", Target: "Windows", SourcePaused: false }, "Takeover receipt lost the source pause result");
            activityCommand = new() { Id = takeover.Id, Action = "play", Epoch = ownershipEpoch, Playing = true,
                Resume = new() { TrackIds = [recording.Id], Index = 0, Position = 31 } };
            var beforeTakeover = handedOver;
            await session.ReportPlaybackActivityAsync(false, 30, force: true);
            await session.ReportPlaybackActivityAsync(false, 30, force: true);
            Check(handedOver == beforeTakeover + 1 && session.HasReceivedPlaybackCommand(takeover.Id)
                && !activityReports[^1].TryGetProperty("acks", out _),
                "A retained play was dispatched again or acknowledged before it was applied");
            Task SendTakeoverAck() => session.ReportPlaybackActivityAsync(true, 31, status: "playing", track: recording, force: true);
            Task? requestedCheckIn = null;
            Task OnTakeoverAck() => requestedCheckIn = SendTakeoverAck();
            session.PlaybackCheckInRequested += OnTakeoverAck;
            rejectActivity = true;
            session.AcknowledgePlaybackCommand(takeover.Id);
            session.PlaybackCheckInRequested -= OnTakeoverAck;
            await (requestedCheckIn ?? throw new Exception("Applying a takeover did not request an immediate check-in"));
            Check(activityReports[^1].GetProperty("acks")[0].GetString() == takeover.Id,
                "The immediate check-in omitted the takeover ID");
            rejectActivity = false;
            // Return the retained command again to exercise deduplication even after the ack is sent.
            await SendTakeoverAck();
            Check(handedOver == beforeTakeover + 1 && activityReports[^1].GetProperty("acks")[0].GetString() == takeover.Id,
                "A failed check-in lost the play acknowledgement or replayed the command");
            await SendTakeoverAck();
            Check(handedOver == beforeTakeover + 1 && !activityReports[^1].TryGetProperty("acks", out _),
                "A successful check-in lost the handled play ID or kept sending its acknowledgement");
            activityCommand = null;
            ownershipEpoch = 0;
            await session.ReportPlaybackActivityAsync(false, 30, status: "paused", duration: 180, track: recording, force: true);
            await session.ReportPlaybackActivityAsync(false, 30, status: "paused", duration: 180, track: recording);
            Check(activityReports[^1].GetProperty("epoch").GetInt64() == 0 && activityReports[^1].GetProperty("queue").GetProperty("index").GetInt32() == 1,
                "Check-in did not restore the queue after server ownership reset");
            var device = new PlaybackDevice { Status = "playing", Position = 10, Age = 13, Duration = 24 };
            Check(device.PositionAt(1) == 24 && device.PositionAt(3) == 10 && (device with { Status = "paused" }).PositionAt(1) == 10,
                "Remote position advanced while paused or stale, or went past duration");
            await session.SavePlaybackAsync(new() { TrackIds = [recording.Id], Index = 0, Position = 17 });
            await session.SavePlaybackAsync(new() { TrackIds = [recording.Id], Index = 0, Position = 18 });
            Check(checkpointCount == 1 && remotePlayback?.Position == 18, "Repeated saves did not use position checkpoints");
            await session.SavePlaybackAsync(new() { TrackIds = [recording.Id], Index = 0, Position = 17 });
            Check(session.Offline!.GetPlayback()?.Position == 17 && remotePlayback?.Position == 17, "Playback checkpoint missing from device or server");
            remotePlayback = remotePlayback! with { Position = 42, UpdatedAt = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds() };
            Check((await session.GetPlaybackAsync())?.Position == 42, "Newer playback position from another device ignored");
            Check(new OfflineLibrary(session.Offline.RootDirectory + "-other-profile", new Uri("https://profiles.test"), "sam").GetPlayback() is null, "Playback leaked into another profile");
            var firstPage = await session.SearchPageAsync("Artist", 0);
            var secondPage = await session.SearchPageAsync("Artist", firstPage.NextOffset!.Value);
            Check(searchOffsets.SequenceEqual(new[] {0,8}) && firstPage.Tracks[0].Title == "First page" && secondPage.Tracks[0].Title == "Second page" && secondPage.NextOffset is null, "Search pagination lost cursor, data or exhaustion");
            session.RecordListen(recording);
            Check(session.HasListeningHistory, "Listening history did not persist for this profile");
            publishLibrary = true;
            await session.RefreshLibraryAutomaticallyAsync();
            Check(session.Library.Count == 1 && session.Library[0].Id == recording.Id, "Automatic refresh missed a server library change");
            Check(audioRequests == 0 && originalAudioRequests == 0, "Automatic refresh downloaded audio");
            publishLibrary = false;
            await session.RefreshLibraryAutomaticallyAsync();
            var originalRoot = session.Offline!.RootDirectory;
            Check(session.StreamingQualityWifi == "high", "Wi-Fi playback must default to High Opus");
            session.SetStreamingQualityWifi("max");
            var deviceUpdated = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void DeviceChanged() { if (session.DeviceTracks.Any(t => t.Id == recording.Id)) deviceUpdated.TrySetResult(); }
            session.Changed += DeviceChanged;
            var maxPlayback = await session.CachePlaybackAsync(recording, CancellationToken.None);
            await deviceUpdated.Task.WaitAsync(TimeSpan.FromSeconds(5));
            session.Changed -= DeviceChanged;
            Check(session.OnThisDevice(recording) && !session.KeptOnDevice(recording), "Playback cache was confused with a kept download");
            Check(session.DeviceBytes == audio.Length && session.DeviceTracks.Count == 1, "Device view missed freshly cached bytes or songs");
            Check(originalAudioRequests == 1 && playbackInfoRequests == 0 && File.ReadAllBytes(maxPlayback).SequenceEqual(audio),
                "Max playback transcoded or changed the original audio");
            try { session.SetStreamingQualityWifi("invalid"); throw new Exception("Invalid quality accepted"); }
            catch (ArgumentException) { checks++; }
            session.SetStreamingQualityWifi("normal");
            var cachedPlayback = await session.CachePlaybackAsync(recording, CancellationToken.None);
            Check(cachedPlayback != maxPlayback && File.ReadAllBytes(cachedPlayback).SequenceEqual(compressedAudio),
                "Normal playback reused or overwrote the original cache");
            Check(audioRequests == 1 && File.Exists(cachedPlayback), "Playback did not prepare verified cache");
            Check(session.PlaybackRecording(recording, cachedPlayback).Lufs == -14, "Player used source loudness for a cached copy");
            Check(playbackInfoRequests == 1 && cachedPlayback.EndsWith(".m4a"), "Playback did not request the compressed copy");
            Check(session.CacheLimitGb == 3 && session.DownloadsWifiOnly, "Cache or network defaults changed");
            session.SetCacheLimit(5);
            try { session.SetCacheLimit(2); throw new Exception("Invalid cache limit accepted"); }
            catch (ArgumentOutOfRangeException) { checks++; }
            session.SetDownloadQuality("normal");
            await session.DownloadAsync([recording]);
            Check(audioRequests == 1 && originalAudioRequests == 1, "Keeping a cached song downloaded the audio again");
            Check(session.Downloads.Single().DownloadSha256 == compressed.DownloadSha256, "Offline download ignored selected quality");
            Check(session.LocalPath(recording) is not null, "Saved Normal quality copy unavailable for online playback");
            Check(session.PlaybackRecording(recording, session.LocalPath(recording)!).TruePeak == -5, "Kept copy lost its peak measurement");
            session.SetStreamingQualityWifi("max");
            Check(session.LocalPath(recording) is not null, "Streaming quality overrode a kept download");
            session.SetStreamingQualityWifi("normal");
            Microsoft.Maui.Networking.Connectivity.Current.ConnectionProfiles = [Microsoft.Maui.Networking.ConnectionProfile.Cellular];
            try { await session.DownloadAsync([recording]); throw new Exception("Wi-Fi-only download used mobile data"); }
            catch (InvalidOperationException) { checks++; }
            Microsoft.Maui.Networking.Connectivity.Current.ConnectionProfiles = [Microsoft.Maui.Networking.ConnectionProfile.WiFi];
            await session.RemoveDownloadAsync(recording);
            await session.Offline.SaveLibraryAsync([new() { Id = "abcdefghijk", Title = "Cached recording" }]);
            reachable = false;
            await session.ReconnectAsync();
            Check(await session.GetCachedPlaybackPathAsync(recording) == cachedPlayback, "Offline warm playback cache was unavailable");
            Check(await session.CachePlaybackAsync(recording, CancellationToken.None) == cachedPlayback && audioRequests == 1,
                "Repeated playback unnecessarily downloaded audio");
            session.SetStreamingQualityWifi("max");
            Check(await session.GetCachedPlaybackPathAsync(recording) == maxPlayback && originalAudioRequests == 1,
                "Max quality reused compressed audio or re-downloaded a cached original");
            File.Delete(maxPlayback);
            Check(await session.GetCachedPlaybackPathAsync(recording) is null,
                "Max quality silently fell back to a compressed cache");
            File.WriteAllBytes(maxPlayback, audio);
            session.SetStreamingQualityWifi("normal");
            session.SetStreamingQualityMobile("low");
            session.SetDownloadQuality("high");
            try { session.SetDownloadQuality("invalid"); throw new Exception("Invalid download quality accepted"); }
            catch (ArgumentException) { checks++; }
            try { session.SetStreamingQualityMobile("invalid"); throw new Exception("Invalid mobile quality accepted"); }
            catch (ArgumentException) { checks++; }
            try { MusicSession.TierVersion("invalid"); throw new Exception("Invalid tier accepted"); }
            catch (ArgumentException) { checks++; }
            await session.SavePreferencesAsync(0.25, true, false, volumeLevel: "quiet");
            await session.SwitchProfileAsync();
            Check(session.NeedsProfileSelection && session.Profiles.Count == 2, "Offline switch lost profiles");
            var restarted = new MusicSession(Api);
            await restarted.InitializeAsync();
            Check(restarted.NeedsProfileSelection && restarted.Profiles.Count == 2, "Restart lost offline chooser profiles");
            await restarted.SelectProfileAsync("alex");
            Check(!restarted.Connected && !restarted.NeedsProfileSelection && restarted.ProfileName == "Alex", "Offline selection failed");
            Check(restarted.Offline!.RootDirectory == originalRoot && restarted.Library.Single().Title == "Cached recording", "Offline selection used wrong cache");
            Check(restarted.PlaybackPreferences.Volume == 0.25 && restarted.PlaybackPreferences.Shuffle, "Offline selection lost preferences");
            Check(!restarted.PlaybackPreferences.AutoDj, "Restart lost Auto DJ preference");
            Check(restarted.CacheLimitGb == 5, "Restart lost cache preference");
            Check(restarted.StreamingQualityWifi == "normal" && restarted.StreamingQualityMobile == "low" && restarted.DownloadQuality == "high", "Restart lost quality settings");
            Check(restarted.PlaybackPreferences.VolumeLevel == "quiet", "Restart lost volume level");
            await restarted.SelectProfileAsync("sam");
            Check(restarted.StreamingQualityWifi == "high" && restarted.StreamingQualityMobile == "high" && restarted.DownloadQuality == "max", "Quality setting leaked into another profile");
            Check(restarted.PlaybackPreferences.VolumeLevel == "normal", "Volume level leaked into another profile");
            Check(restarted.User == "sam" && restarted.Library.Count == 0 && restarted.PlaybackPreferences.Volume == 1, "Profile data leaked to another listener");
            try { await restarted.SelectProfileAsync("unknown"); throw new Exception("Unknown offline profile accepted"); }
            catch (InvalidOperationException) { checks++; }
            Check(restarted.User == "sam", "Failed offline selection changed profile");
            reachable = true; removed = true;
            try { await restarted.SelectProfileAsync("alex"); throw new Exception("Removed profile accepted"); }
            catch (InvalidOperationException) { checks++; }
            reachable = false;
            try { await restarted.SelectProfileAsync("alex"); throw new Exception("Confirmed removed profile resurrected offline"); }
            catch (InvalidOperationException) { checks++; }
            reachable = true; removed = false;
            await restarted.SwitchProfileAsync();
            unauthorized = true;
            try { await restarted.SelectProfileAsync("alex"); throw new Exception("Unauthorized response used offline fallback"); }
            catch (FamilyHubApiException error) when (error.StatusCode == 401) { checks++; }
            restarted.Api?.Dispose();
        }
        finally
        {
            session.Api?.Dispose();
            Directory.Delete(FileSystem.AppDataDirectory, true);
        }
        return checks;
    }
    private sealed class SessionHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(handler(request));
    }
}

// Minimal platform storage substitutes let the real app session run without MAUI.
internal static class FileSystem
{
    public static string AppDataDirectory { get; } = Path.Combine(Path.GetTempPath(), "familyhub-session-tests-" + Guid.NewGuid().ToString("N"));
    public static string CacheDirectory => AppDataDirectory;
}
internal sealed class Preferences
{
    public static Preferences Default { get; } = new();
    private readonly Dictionary<string, string> values = [];
    public bool ContainsKey(string key) => values.ContainsKey(key);
    public string Get(string key, string fallback) => values.GetValueOrDefault(key, fallback);
    public void Set(string key, string value) => values[key] = value;
}
internal enum DevicePlatform { WinUI, Android, MacCatalyst, iOS }
internal enum DeviceIdiom { Desktop, Tablet }
internal sealed class DeviceInfo
{
    public static DeviceInfo Current { get; } = new();
    public DevicePlatform Platform => DevicePlatform.WinUI;
    public DeviceIdiom Idiom => DeviceIdiom.Desktop;
    public string Name => "Test device";
    public string Model => "Test";
}
