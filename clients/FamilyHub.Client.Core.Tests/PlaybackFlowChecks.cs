using System.Net;
using System.Text;
using System.Text.Json;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;

internal static class PlaybackFlowChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
        var requests = new List<JsonElement>();
        var track = new MusicTrack { Id = "abcdefghijk", Title = "Playback fixture", Url = "https://www.youtube.com/watch?v=abcdefghijk" };
        var checkWindowsPreview = false;
        var sourceReady = true;
        var growingPolls = 0;
        var recordReads = 0;
        var streamAttempts = 0;
        var completedId = "ABCDEFGHIJK";
        var completed = track with { Id = completedId, Url = "https://www.youtube.com/watch?v=" + completedId };
        var stale = track with { Saved = true, DownloadUrl = "/api/library/abcdefghijk/download",
            PlaybackInfoUrl = "/api/library/abcdefghijk/playback-info", DownloadSha256 = new string('a', 64), DownloadSize = 10 };
        var current = stale with { DownloadUrl = "/api/library/abcdefghijk/playback-source/" + new string('b', 64),
            DownloadSha256 = new string('b', 64), DownloadSize = 30 };
        object GrowingPreview(bool ready) => new { job = new { id = "job", source_id = track.Id, state = "running",
            windows_preview_ready = ready, stream_url = "/api/jobs/job/media/index.m3u8?ticket=fixture",
            fallback_stream_url = sourceReady ? "/api/jobs/job/media/source?ticket=fixture" : null } };
        FamilyHubApi Api(Uri origin) => new(origin, new NetworkStub(async request =>
        {
            object value;
            if (request.Method == HttpMethod.Head && request.RequestUri!.AbsolutePath.StartsWith("/api/jobs/job/media/", StringComparison.Ordinal))
                return new(HttpStatusCode.OK);
            if (request.RequestUri!.AbsolutePath == "/api/jobs")
            {
                requests.Add(JsonSerializer.Deserialize<JsonElement>(await request.Content!.ReadAsStringAsync()));
                value = requests[^1].GetProperty("url").GetString() == completed.Url
                    ? new { job = new { id = "finished", source_id = completedId, state = "error" } } : GrowingPreview(true);
            }
            else if (request.RequestUri.AbsolutePath == "/api/jobs/job")
                value = GrowingPreview(!checkWindowsPreview || ++growingPolls > 1);
            else if (request.RequestUri.PathAndQuery == "/api/library?id=abcdefghijk")
            {
                recordReads++;
                value = new { results = new[] { current } };
            }
            else if (request.RequestUri.PathAndQuery == "/api/library?id=" + completedId)
            {
                recordReads++;
                value = new { results = new[] { completed with { Saved = true, DownloadUrl = "/api/library/" + completedId + "/download" } } };
            }
            else if (request.RequestUri.AbsolutePath == current.PlaybackInfoUrl)
            {
                if (++streamAttempts == 1) return new(HttpStatusCode.NotFound);
                value = current with { StreamUrl = current.DownloadUrl + "?ticket=refreshed" };
            }
            else value = request.RequestUri.AbsolutePath switch
            {
                "/api/connect" => new { family_profiles = true, csrf_token = "boot", profiles = new[] { new { id = "alex", name = "Alex" } } },
                "/api/profile/select" => new { profile = new { id = "alex", name = "Alex" }, csrf_token = "selected", preferences = new { volume = 1 } },
                "/api/listening/summary" => new { },
                "/api/library" => new { results = Array.Empty<object>() },
                "/api/playlists" => new { playlists = Array.Empty<object>() },
                _ => throw new Exception("Playback waited for completion or requested an unexpected endpoint")
            };
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value, FamilyHubApi.JsonOptions), Encoding.UTF8, "application/json") };
        }));
        var session = new MusicSession(Api);
        try
        {
            await session.ConnectServerAsync("https://playback-flow.test");
            await session.SelectProfileAsync("alex");
            Check(session.CanStream, "This platform still waits for complete downloads");
            var playing = await session.EnsureServerRecordingAsync(track, CancellationToken.None, allowPreview: true);
            Check(playing.PlaybackVersion == "preview-hls", "Listener did not receive the in-progress stream");
            Check(!requests[0].GetProperty("prefetch").GetBoolean(), "Explicit play was demoted");
            Check((await session.StreamPlaybackAsync(playing, 0, CancellationToken.None)).Contains("index.m3u8"), "Preview was discarded before playback");
            await session.EnsureServerRecordingAsync(track, CancellationToken.None, allowPreview: true, background: true, prefetch: true);
            var action = Guid.NewGuid().ToString("N");
            var alternate = await session.EnsureServerRecordingAsync(playing, CancellationToken.None, allowPreview: true, action: action, fallback: true);
            Check(alternate.PlaybackVersion == "preview-source", "A failed preview waited for purification or reused HLS");
            Check(requests.Count == 1, "Prefetch and retry must reuse the active job");
            Check((await session.StreamPlaybackAsync(alternate, 0, CancellationToken.None)).Contains("/media/source"), "Recovery opened the wrong edition");
            var following = await session.EnsureServerRecordingAsync(track, CancellationToken.None, allowPreview: true);
            Check(following.PlaybackVersion == "preview-hls", "A previous attempt disabled streaming");
            checkWindowsPreview = true;
            sourceReady = false;
            var growing = await session.EnsureServerRecordingAsync(track, CancellationToken.None, allowPreview: true);
            Check(growing.PlaybackVersion == "preview-hls" && growingPolls == (OperatingSystem.IsWindows() ? 2 : 1),
                "The Windows preview buffer flag was not applied per platform");
            sourceReady = true;
            growingPolls = 0;
            var readySource = await session.EnsureServerRecordingAsync(track, CancellationToken.None, allowPreview: true);
            Check(readySource.PlaybackVersion == (OperatingSystem.IsWindows() ? "preview-source" : "preview-hls")
                && growingPolls == 1, "An openable source did not start immediately");
            try
            {
                await session.StreamPlaybackAsync(stale, 0, CancellationToken.None);
                throw new Exception("The stale recording fixture must fail first");
            }
            catch (FamilyHubApiException error) when (error.StatusCode == 404) { }
            var refreshed = await session.EnsureServerRecordingAsync(stale, CancellationToken.None, allowPreview: true, fallback: true);
            Check(refreshed == current && session.CurrentRecording(stale) == current && recordReads == 1 && requests.Count == 1,
                "Library recovery did not replace the stale record through one targeted request");
            var retried = await session.StreamPlaybackAsync(refreshed, 0, CancellationToken.None);
            Check(retried.EndsWith(current.DownloadUrl + "?ticket=refreshed", StringComparison.Ordinal) && streamAttempts == 2,
                "The library retry did not open the refreshed recording");
            var imported = await session.EnsureServerRecordingAsync(completed, CancellationToken.None, allowPreview: true);
            Check(imported.Saved && imported.DownloadUrl.Length > 0 && session.CurrentRecording(completed) == imported &&
                recordReads == 2 && requests.Count == 2, "A stale terminal job should re-read the imported record once before reporting failure");
        }
        finally { session.Api?.Dispose(); }
        return checks;
    }

    private sealed class NetworkStub(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => respond(request);
    }
}
