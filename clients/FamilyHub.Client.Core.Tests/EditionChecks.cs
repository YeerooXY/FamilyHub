using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;

internal static class EditionChecks
{
    public static async Task<int> RunAsync()
    {
        var count = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); count++; }
        var original = Encoding.UTF8.GetBytes("original with quiet beginning and ending");
        var trimmed = Encoding.UTF8.GetBytes("retained music packets");
        var track = new MusicTrack { Id = "abcdefghijk", Saved = true, Title = "Edition check",
            DownloadUrl = "/api/library/abcdefghijk/download", DownloadExtension = ".opus",
            DownloadSha256 = Convert.ToHexString(SHA256.HashData(original)).ToLowerInvariant(), DownloadSize = original.Length };
        var current = track;
        var requests = 0;
        FamilyHubApi Api(Uri origin) => new(origin, new EditionHandler(request =>
        {
            object data = request.RequestUri!.AbsolutePath switch
            {
                "/api/connect" => new { family_profiles = true, csrf_token = "boot", profiles = new[] { new { id = "alex", name = "Alex" } } },
                "/api/profile/select" => new { profile = new { id = "alex", name = "Alex" }, csrf_token = "selected", preferences = new { volume = 1, shuffle = false } },
                "/api/listening/summary" => new { },
                "/api/library" => new { results = new[] { current } },
                "/api/playlists" => new { playlists = Array.Empty<object>() },
                "/api/library/abcdefghijk/download" => new { },
                _ => throw new Exception("Unexpected edition endpoint")
            };
            if (request.RequestUri.AbsolutePath == track.DownloadUrl)
            {
                requests++;
                return new(HttpStatusCode.OK) { Content = new ByteArrayContent(current == track ? original : trimmed) };
            }
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(data, FamilyHubApi.JsonOptions), Encoding.UTF8, "application/json") };
        }));
        var session = new MusicSession(Api);
        try
        {
            await session.ConnectServerAsync("https://editions.test");
            await session.SelectProfileAsync("alex");
            var oldDownload = await session.Offline!.DownloadAsync(track, session.Api!);
            Check(session.LocalPath(track) == oldDownload, "Original offline fixture missing");
            current = track with { ListeningVersion = "trimmed", DownloadSha256 = Convert.ToHexString(SHA256.HashData(trimmed)).ToLowerInvariant(), DownloadSize = trimmed.Length };
            await session.RefreshAsync();
            Check(session.CurrentRecording(track) == current, "Stale queue did not resolve current edition");
            Check(session.LocalPath(track) is null, "Old offline original was used instead of current edition online");
            var path = await session.CachePlaybackAsync(track, CancellationToken.None);
            Check(File.ReadAllBytes(path).SequenceEqual(trimmed), "Current edition was not downloaded");
            Check(requests == 2, "Edition update unexpectedly downloaded extra copies");
            Check(File.ReadAllBytes(oldDownload).SequenceEqual(original), "Edition update destroyed the existing offline original");
            Check(await session.CachePlaybackAsync(track, CancellationToken.None) == path && requests == 2, "Current edition cache was not reused");
        }
        finally { session.Api?.Dispose(); }
        return count;
    }

    private sealed class EditionHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(respond(request));
    }
}
