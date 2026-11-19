using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Security.Cryptography;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;
using FamilyHub.ServerWork.Tests;
using FamilyHub.ServerWork.Tests.Components;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.JSInterop;

internal static class DownloadStateChecks
{
    public static async Task RunAsync()
    {
        var server = new DownloadFixtureServer();
        var session = await server.ConnectAsync();
        server.WaitingForAutoDownload = true;
        var activator = new CaptureActivator();
        await using var services = new ServiceCollection().AddLogging().AddSingleton(session)
            .AddSingleton<MusicPlayer>().AddSingleton<IJSRuntime, NoJs>().AddSingleton<IComponentActivator>(activator).BuildServiceProvider();
        await using var renderer = new HtmlRenderer(services, services.GetRequiredService<ILoggerFactory>());
        var page = await renderer.Dispatcher.InvokeAsync(() => renderer.RenderComponentAsync<DownloadPlaylistFixture>());
        async Task CheckAsync(string description, Func<string, bool> matches)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            while (!matches(await renderer.Dispatcher.InvokeAsync(page.ToHtmlString)))
            {
                try { await Task.Delay(30, timeout.Token); }
                catch (OperationCanceledException) { throw new InvalidOperationException(description); }
            }
        }

        await CheckAsync("The playlist did not show the automatic download queued during import.",
            html => html.Contains("Download queued"));
        server.WaitingForAutoDownload = false;
        await CheckAsync("The playlist stopped watching at the end of matching.",
            html => html.Contains("Downloading to server") && Row(html, "Next song").Contains("aria-label=\"Not on server\""));
        var initialRequests = server.PlaylistReads;
        var initialPolls = server.StatusReads;
        await CheckAsync("The open playlist did not poll progress again.", _ => server.StatusReads > initialPolls);
        if (server.PlaylistReads != initialRequests) throw new InvalidOperationException("Byte progress reloaded the catalogue.");

        server.ReadyRecordings = 2;
        await CheckAsync("A completed server recording did not update while the next song was still downloading.",
            html => Row(html, "Next song").Contains("aria-label=\"On server\"") &&
                Row(html, "Final song").Contains("aria-label=\"Not on server\"") && html.Contains("Downloading to server"));
        server.FailServerDownload = true;
        await CheckAsync("A failed server download did not show what happened or offer a retry.",
            html => html.Contains("Retry server download") && html.Contains("Some songs could not be downloaded to the server."));
        var transfer = activator.Instances[typeof(PlaylistTransfer)];
        var retryServer = typeof(PlaylistTransfer).GetMethod("Start", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await renderer.Dispatcher.InvokeAsync(() => (Task)retryServer.Invoke(transfer, ["download"])!);
        server.ReadyRecordings = 3;
        await CheckAsync("Server download completion did not update the playlist control.",
            html => html.Contains("Playlist on server") && Row(html, "Final song").Contains("aria-label=\"On server\""));

        session.SetStreamingQualityWifi("max");
        await session.CachePlaybackAsync(server.Tracks[0], CancellationToken.None);
        await CheckAsync("The open playlist did not display a newly cached song.",
            html => html.Contains("1 cached") && Row(html, "First song").Contains("aria-label=\"Cached\""));

        server.FailAudio = true;
        try
        {
            await renderer.Dispatcher.InvokeAsync(() => session.DownloadAsync([server.Tracks[1]]));
            throw new InvalidOperationException("A failed transfer was accepted.");
        }
        catch (FamilyHubApiException) { }
        await CheckAsync("The row did not show the download error and retry.",
            html => Row(html, "Next song").Contains("Retry download") &&
                Row(html, "Next song").Contains("The server could not send the audio.") && html.Contains("Retry playlist download"));

        server.FailAudio = false;
        var resume = server.AudioGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var download = renderer.Dispatcher.InvokeAsync(() => session.DownloadAsync(server.Tracks));
        try
        {
            await CheckAsync("The first device download did not update the row and both sets of counts during the batch.",
                html => html.Contains("1 downloaded") && html.Contains("0 cached") && html.Contains("<dd>1 song,") &&
                    html.Contains("Device download progress") && Row(html, "First song").Contains("aria-label=\"Downloaded\"") &&
                    Row(html, "Next song").Contains("aria-label=\"Downloading\"") && html.Contains("Downloading playlist to this device"));
        }
        finally { resume.TrySetResult(); }
        await download.WaitAsync(TimeSpan.FromSeconds(8));
        await CheckAsync("The open playlist missed the final download.",
            html => html.Contains("3 downloaded") && html.Contains("<dd>3 songs,") &&
                html.Contains("Playlist downloaded") && Row(html, "Final song").Contains("aria-label=\"Downloaded\""));
        Console.WriteLine("PASS live playlist server and device downloads, cached and downloaded counts, failure, and retry");
    }

    private static string Row(string html, string title) =>
        html.Split("</article>").Single(part => part.Contains($"<strong>{title}</strong>")).Split("<article")[^1];
}

public sealed class DownloadFixtureServer : HttpMessageHandler
{
    private static readonly byte[] Audio = [0x11, 0x22, 0x33, 0x44];
    public MusicTrack[] Tracks { get; } = [Track("firstSong01", "First song"), Track("nextSong002", "Next song"), Track("lateSong003", "Final song")];
    public volatile int ReadyRecordings = 1;
    public volatile int PlaylistReads, StatusReads;
    public volatile bool FailAudio;
    public volatile bool WaitingForAutoDownload, FailServerDownload;
    public TaskCompletionSource? AudioGate;

    public async Task<MusicSession> ConnectAsync()
    {
        var session = (MusicSession)Activator.CreateInstance(typeof(MusicSession), BindingFlags.Instance | BindingFlags.NonPublic, null,
            new object[] { (Func<Uri, FamilyHubApi>)(origin => new FamilyHubApi(origin, this)) }, null)!;
        await session.ConnectServerAsync($"https://downloads-{Guid.NewGuid():N}.test");
        await session.SelectProfileAsync("alex");
        return session;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path.EndsWith("/download"))
        {
            if (FailAudio) return new(HttpStatusCode.ServiceUnavailable);
            if (AudioGate is { } gate) await gate.Task.WaitAsync(token);
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(Audio) };
        }
        var ready = ReadyRecordings;
        var reads = StatusReads;
        if (path == "/api/playlists") PlaylistReads++;
        if (path.EndsWith("/prepare"))
        {
            StatusReads++;
            if (request.Method == HttpMethod.Post) FailServerDownload = false;
        }
        object data = path switch
        {
            "/api/connect" => new { family_profiles = true, csrf_token = "boot", profiles = new[] { new { id = "alex", name = "Alex" } } },
            "/api/profile/select" => new { profile = new { id = "alex", name = "Alex" }, csrf_token = "selected", preferences = new { spotify_subscribed = false } },
            "/api/library" => new { results = Tracks[..ready] },
            "/api/playlists" => new { playlists = new[] { Playlist(ready) } },
            "/api/playlists/fixture/prepare" => new
            {
                state = WaitingForAutoDownload || FailServerDownload || ready == Tracks.Length ? "done" : "running",
                mode = WaitingForAutoDownload ? "import" : "download", phase = WaitingForAutoDownload ? "matching" : "download",
                download_after_matching = WaitingForAutoDownload, failed = FailServerDownload && ready < Tracks.Length ? 1 : 0,
                total = Tracks.Length, processed = ready, saved = ready, found = ready, download_bytes = reads * 4096, download_total_bytes = 131072
            },
            _ => new { }
        };
        return new(HttpStatusCode.OK) { Content = JsonContent.Create(data) };
    }

    private MusicPlaylist Playlist(int ready) => new()
    {
        Id = "fixture", OwnerId = "alex", Name = "Download test playlist", CanEdit = true,
        Tracks = Tracks.Select((track, index) => new PlaylistTrack
        {
            SourceId = track.Id, Title = track.Title, Artist = track.Channel,
            State = index < ready ? "saved" : "ready", Match = index < ready ? track : null
        }).ToList()
    };

    private static MusicTrack Track(string id, string title) => new()
    {
        Id = id, Title = title, Channel = "Test Artist", Saved = true, DownloadSize = Audio.Length,
        DownloadSha256 = Convert.ToHexString(SHA256.HashData(Audio)), DownloadExtension = ".m4a", DownloadUrl = $"/api/library/{id}/download"
    };
}
