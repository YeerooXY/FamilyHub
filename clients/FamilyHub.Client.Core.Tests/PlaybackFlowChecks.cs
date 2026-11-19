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
        FamilyHubApi Api(Uri origin) => new(origin, new Handler(async request =>
        {
            object value;
            if (request.RequestUri!.AbsolutePath == "/api/jobs")
            {
                requests.Add(JsonSerializer.Deserialize<JsonElement>(await request.Content!.ReadAsStringAsync()));
                value = new { job = new { id = "job", source_id = track.Id, state = "running", stream_url = "/api/jobs/job/media/index.m3u8?ticket=fixture" } };
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
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
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
            Check(requests[1].GetProperty("prefetch").GetBoolean(), "Upcoming song took explicit-play priority");
            session.StreamingFailed();
            Check(!session.CanStream, "Failed streaming lost the local-cache fallback");
        }
        finally { session.Api?.Dispose(); }
        return checks;
    }

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => respond(request);
    }
}
