using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Localization;
using Microsoft.JSInterop;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;
using FamilyHub.ServerWork.Tests.Components;

Directory.CreateDirectory(".local/ui");
var session = (MusicSession)Activator.CreateInstance(typeof(MusicSession), BindingFlags.Instance | BindingFlags.NonPublic, null, new object[]{(Func<Uri, FamilyHubApi>)(origin => new FamilyHubApi(origin, new FixtureHandler()))}, null)!;
await session.ConnectServerAsync("https://ui-check.test");
await session.SelectProfileAsync("alex");
var activator = new CaptureActivator();
var services = new ServiceCollection().AddLogging().AddLocalization()
    .AddSingleton<IStringLocalizer>(services => services.GetRequiredService<IStringLocalizerFactory>().Create(typeof(Program)))
    .AddSingleton(session).AddSingleton(new MusicPlayer())
    .AddSingleton(new PublicAppReleases(new HttpClient(new FixtureHandler())))
    .AddSingleton<IJSRuntime, NoJs>().AddSingleton<IComponentActivator>(activator).BuildServiceProvider();
await using var renderer = new HtmlRenderer(services, services.GetRequiredService<ILoggerFactory>());
// A status card stays in the markup with the hidden attribute while its screen is healthy, so "shown" means not hidden.
static bool Shown(string html, string label) => System.Text.RegularExpressions.Regex.Replace(
    html, @"<div class=""service-status[ ""][^>]*\bhidden\b[^>]*>.*?</button></div></div>", "",
    System.Text.RegularExpressions.RegexOptions.Singleline).Contains(label, StringComparison.Ordinal);
await renderer.Dispatcher.InvokeAsync(async () => {
    RenderFragment songReview = builder =>
    {
        builder.OpenComponent<CatalogueReviewPanel>(0);
        builder.CloseComponent();
    };
    var stats = await renderer.RenderComponentAsync<ServerStats>(ParameterView.FromDictionary(
        new Dictionary<string, object?>
        {
            [nameof(ServerStats.ChildContent)] = songReview,
            [nameof(ServerStats.RefreshReview)] = EventCallback.Factory.Create(activator,
                () => ((CatalogueReviewPanel)activator.Instances[typeof(CatalogueReviewPanel)]).Refresh())
        }));
    async Task Refresh(Type type) => await (Task)type.GetMethod("Refresh", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(activator.Instances[type], null)!;
    var watch = System.Diagnostics.Stopwatch.StartNew();
    await Task.WhenAll(Refresh(typeof(ServerStats)), Refresh(typeof(CatalogueReviewPanel)));
    var html = stats.ToHtmlString();
    if (!Shown(html, "Retry server work") || !Shown(html, "Retry song review") || html.Contains("aria-busy=\"true\"")) throw new Exception("Timeout did not end loading and expose retries");
    if (watch.Elapsed.TotalSeconds > 7) throw new Exception("Component timeout exceeded bound");
    Save("error", html);
    FixtureHandler.Block = false;
    await (Task)typeof(ServerStats).GetMethod("RefreshPage", BindingFlags.NonPublic | BindingFlags.Instance)!
        .Invoke(activator.Instances[typeof(ServerStats)], null)!;
    html = stats.ToHtmlString();
    if (Shown(html, "Retry server work") || Shown(html, "Retry song review")) throw new Exception("Retry did not recover: server " + Shown(html, "Retry server work") + " review " + Shown(html, "Retry song review") + " connected " + session.Connected + " error=" + typeof(ServerStats).GetField("error", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(activator.Instances[typeof(ServerStats)]) + " snippet=" + html.Substring(html.IndexOf("Retry server work", StringComparison.Ordinal) - 120, 160) + " ## " + html.Substring(html.IndexOf("class=\"service-status", StringComparison.Ordinal) - 10, 260) + " refreshing=" + typeof(ServerStats).GetProperty("Refreshing", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(activator.Instances[typeof(ServerStats)]));
    if (html.Contains("Refresh review") || html.Contains("Songs that need work") || !html.Contains("Refresh server work"))
        throw new Exception("Server work should have one shared refresh control");
    var automatic = html.IndexOf("Automatic work", StringComparison.Ordinal);
    var reviewHeading = html.IndexOf(">Song review</h2>", StringComparison.Ordinal);
    var details = html.IndexOf("<summary>Server details</summary>", StringComparison.Ordinal);
    if (automatic < 0 || reviewHeading <= automatic || details <= reviewHeading
        || !html.Contains("Veridis Quo") || !html.Contains("24 queued") || !html.Contains("0 waiting to retry")
        || !html.Contains("Catalogue worker configuration") || !html.Contains("Automatic catalogue attempts per hour")
        || !html.Contains("Needs your choice") || html.Contains("Recently fixed")
        || !html.Contains("catalogue-filter-metadata") || html.Contains("catalogue-category-panel"))
        throw new Exception("The dashboard did not render live worker data, review defaults and collapsed details in order");
    Save("loaded", html);
    async Task CheckIndependentFailure(string path, string expectedRetry, string healthyContent)
    {
        FixtureHandler.FailedPath = path;
        await (Task)typeof(ServerStats).GetMethod("RefreshPage", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(activator.Instances[typeof(ServerStats)], null)!;
        var dashboard = stats.ToHtmlString();
        if (!Shown(dashboard, expectedRetry) || !dashboard.Contains(healthyContent))
            throw new Exception("The failed section hid its retry or interrupted the healthy section");
    }
    await CheckIndependentFailure("/api/server/stats", "Retry server work", "catalogue-filter-metadata");
    await CheckIndependentFailure("/api/catalogue/review", "Retry song review", "Veridis Quo");
    FixtureHandler.FailedPath = null;
    FixtureHandler.CatalogueRows = true;
    var activeReview = typeof(CatalogueReviewPanel).GetField("active", BindingFlags.NonPublic | BindingFlags.Instance)!;
    async Task<string> RenderReview(string category)
    {
        activeReview.SetValue(activator.Instances[typeof(CatalogueReviewPanel)], category);
        await Refresh(typeof(CatalogueReviewPanel));
        return stats.ToHtmlString();
    }
    var metadataReview = await RenderReview("metadata");
    if (!metadataReview.Contains("MusicBrainz rate limit") || !metadataReview.Contains("Retry after") || !metadataReview.Contains("catalogue-timestamp")
        || !metadataReview.Contains("Verify title") || !metadataReview.Contains("Edit details")
        || !metadataReview.Contains("Looking up song details"))
        throw new Exception("Song details did not render the retry, processing and edit states");
    var openMetadata = typeof(CatalogueReviewPanel).GetMethod("Open", BindingFlags.NonPublic | BindingFlags.Instance)!;
    await (Task)openMetadata.Invoke(activator.Instances[typeof(CatalogueReviewPanel)], [
        new MetadataRequest { Id = "abcdefghijk", Title = "Fixture title (Official Audio)",
            Current = new() { ["title"] = "Fixture title (Official Audio)" },
            Suggested = new() { ["title"] = "Fixture title" }, Missing = ["title"] }
    ])!;
    var editor = stats.ToHtmlString();
    if (!editor.Contains("metadata-track-title") || !editor.Contains("Fixture title (Official Audio)")
        || !editor.Contains("Check the suggested values before saving."))
        throw new Exception("The title editor omitted the proposed title or original title");
    var closeMetadata = typeof(CatalogueReviewPanel).GetMethod("Close", BindingFlags.NonPublic | BindingFlags.Instance)!;
    await (Task)closeMetadata.Invoke(activator.Instances[typeof(CatalogueReviewPanel)], null)!;
    var sourceReview = await RenderReview("damaged");
    if (!sourceReview.Contains("Source search unavailable") || !sourceReview.Contains("Choose recording"))
        throw new Exception("Source review did not render the failed search action");
    var fixedReview = await RenderReview("fixed");
    if (!fixedReview.Contains("Undo the fix for") || !fixedReview.Contains("Updated title")
        || !fixedReview.Contains("Recording replaced."))
        throw new Exception("Automatic fix history did not render both undo actions");
    FixtureHandler.CatalogueRows = false;
    FixtureHandler.Offline = true;
    await session.RefreshAsync();
    if (session.Connected || !Shown(stats.ToHtmlString(), "Retry server work"))
        throw new Exception("Offline server work did not explain how to reconnect");
    FixtureHandler.Offline = false;
    await (Task)typeof(ServerStats).GetMethod("RefreshNow", BindingFlags.NonPublic | BindingFlags.Instance)!
        .Invoke(activator.Instances[typeof(ServerStats)], null)!;
    if (!session.Connected || Shown(stats.ToHtmlString(), "Retry server work"))
        throw new Exception("Server work could not reconnect from its own Refresh button");
    var leaderboard = await renderer.RenderComponentAsync<ServerStats>(ParameterView.FromDictionary(
        new Dictionary<string, object?> { [nameof(ServerStats.Leaderboard)] = true }));
    FixtureHandler.Block = true;
    await Refresh(typeof(ServerStats));
    if (!Shown(leaderboard.ToHtmlString(), "Retry leaderboard")) throw new Exception("Leaderboard did not name its retry");
    FixtureHandler.Block = false;
    await Refresh(typeof(ServerStats));
    var empty = leaderboard.ToHtmlString();
    if (!empty.Contains("Nothing recorded for this period") || !empty.Contains("Listen to music or watch a film")
        || !empty.Contains("No listening or song additions recorded")
        || !empty.Contains("Alex") || empty.Contains("lb-wrapped-table")
        || empty.Contains("How scores are counted") || empty.Contains("lb-card-1") || empty.Contains("lb-top")
        || empty.Contains("lb-measure") || empty.Contains("stats-line-chart") || empty.Contains("Who's here"))
        throw new Exception("Empty leaderboard ranked a listener, drew a chart or omitted the Wrapped empty state and how to fill the view");
    Save("leaderboard-empty", empty);
    foreach (var (platform, action, help) in new[]
    {
        ("windows-x64", "Download and restart", "Playback stops"),
        ("android", "Download update", "Android installer"),
        ("ios", "Open SideStore", "In SideStore, tap Update"),
    })
    {
        AppUpdater.Platform = platform;
        var update = await renderer.RenderComponentAsync<AppUpdate>(ParameterView.FromDictionary(
            new Dictionary<string, object?> { [nameof(AppUpdate.InitialRelease)] = new AppRelease("0.1.72", new string('a', 64), 12, "/fixture") }));
        var prompt = update.ToHtmlString();
        if (!prompt.Contains(action) || !prompt.Contains(help)) throw new Exception($"{platform} did not render its update action");
    }
    Console.WriteLine($"PASS rendered component timeouts in {watch.Elapsed.TotalSeconds:F2}s and successful retries");
    await renderer.RenderComponentAsync<SongPlaylistPicker>();
    var picker = (SongPlaylistPicker)activator.Instances[typeof(SongPlaylistPicker)];
    var flags = BindingFlags.Instance | BindingFlags.NonPublic;
    Task SavePicker() => (Task)typeof(SongPlaylistPicker).GetMethod("Save", flags)!.Invoke(picker, null)!;
    picker.Open(new MusicTrack { Id = "abcdefghijk", Saved = true }, "content");
    FixtureHandler.OtherDeviceAddedSong = true;
    await session.RefreshCatalogueAsync(CancellationToken.None);
    await SavePicker();
    if (FixtureHandler.Removals != 0) throw new Exception("The picker removed a song added on another device");
    picker.Open(new MusicTrack { Id = "abcdefghijk", Saved = true }, "content");
    typeof(SongPlaylistPicker).GetMethod("Select", flags)!.Invoke(picker, new object[]
        { "alex:" + FixtureHandler.PlaylistId, new ChangeEventArgs { Value = false } });
    await SavePicker();
    if (FixtureHandler.Removals != 1) throw new Exception("The picker did not remove the explicitly unchecked song");
    Console.WriteLine("PASS playlist picker preserves a concurrent addition and applies an explicit removal");

    FixtureHandler.AlbumMode = true;
    await session.RefreshCatalogueAsync(CancellationToken.None);
    var home = await renderer.RenderComponentAsync<HomeView>();
    var homeInstance = activator.Instances[typeof(HomeView)];
    var album = ((System.Collections.IList)typeof(HomeView).GetField("albums", flags)!.GetValue(homeInstance)!)[0];
    Task SaveAlbum() => (Task)typeof(HomeView).GetMethod("SaveAlbum", flags)!.Invoke(homeInstance, new[] { album })!;
    await SaveAlbum();
    if (FixtureHandler.AlbumSongs.Count != 1) throw new Exception("Fixture did not interrupt the second album song");
    await SaveAlbum();
    if (FixtureHandler.AlbumCreates != 1 || !FixtureHandler.AlbumSongs.SequenceEqual(new[] { "albumtrack1", "albumtrack2" }))
        throw new Exception("Album retry lost songs or created another playlist");
    Console.WriteLine("PASS album save uses the current revision and retries the incomplete playlist");

    var moved = false;
    var moveLater = EventCallback.Factory.Create(activator, () => { moved = true; });
    var row = await renderer.RenderComponentAsync<SongRow>(ParameterView.FromDictionary(new Dictionary<string, object?>
    {
        ["Track"] = new MusicTrack { Id = "albumtrack1", Title = "Track one" },
        ["OptionsId"] = "playlist-row-options-0", ["MoveLater"] = moveLater
    }));
    if (!row.ToHtmlString().Contains("Move later") || row.ToHtmlString().Contains("Move earlier"))
        throw new Exception("The playlist row did not render the available move");
    await (Task)typeof(SongRow).GetMethod("MenuMove", flags)!.Invoke(activator.Instances[typeof(SongRow)], new object[] { moveLater })!;
    if (!moved) throw new Exception("The playlist move control did not invoke the row action");
});
await DownloadStateChecks.RunAsync();
void Save(string name, string html) {
    var css = string.Join("\n", new[]{"music_web/static/shell.css", "clients/FamilyHub.App/wwwroot/app-native.css", "clients/FamilyHub.App/wwwroot/server-stats.css", "clients/FamilyHub.App/wwwroot/stats-pages.css", "clients/FamilyHub.App/wwwroot/music-admin.css", "packages/paddock-effects/effects.css"}.Where(File.Exists).Select(File.ReadAllText));
    File.WriteAllText($".local/ui/{name}.html", "<!doctype html><html><meta name='viewport' content='width=device-width,initial-scale=1'><style>"+css+"\nhtml,body{height:auto;min-height:100%;overflow:visible}body{display:block;margin:0;padding:24px;background:#07101f;color:#edf2fa;font-family:Arial,sans-serif}.server-work-page{height:auto;overflow:visible;max-width:1100px;margin:auto;display:grid;gap:24px}button{min-height:44px}</style><body data-theme='classic'><main class='server-work-page'>"+html+"</main></body></html>");
}
sealed class CaptureActivator : IComponentActivator {
    public Dictionary<Type,IComponent> Instances = new();
    public IComponent CreateInstance(Type type) { var component=(IComponent)Activator.CreateInstance(type)!; Instances[type]=component; return component; }
}
sealed class NoJs : IJSRuntime {
    public ValueTask<T> InvokeAsync<T>(string id, object?[]? args) => ValueTask.FromResult(default(T)!);
    public ValueTask<T> InvokeAsync<T>(string id, CancellationToken token, object?[]? args) => ValueTask.FromResult(default(T)!);
}
sealed class Launcher {
    public static Launcher Default { get; } = new();
    public Task<bool> OpenAsync(Uri uri) => Task.FromResult(true);
}
sealed class FixtureHandler : HttpMessageHandler {
    public static bool Block = true;
    public static bool Offline;
    public static bool CatalogueRows;
    public const string PlaylistId = "0123456789abcdefghijkl";
    public static bool OtherDeviceAddedSong;
    // Flask marks every response of its own, so a single failing section is not mistaken for an unreachable server.
    private static HttpResponseMessage FlaskError(System.Net.HttpStatusCode status)
    {
        var response = new HttpResponseMessage(status);
        response.Headers.TryAddWithoutValidation("X-Content-Type-Options", "nosniff");
        return response;
    }
    public static string? FailedPath;
    public static int Removals;
    public static bool AlbumMode;
    public static int AlbumCreates;
    public static List<string> AlbumSongs = [];
    static bool rejectSecondSong = true;
    const string AlbumId = "abcdefghijkl0123456789";
    static object AlbumPlaylist => new { id = AlbumId, owner_id = "alex", name = "Fixture Album", can_edit = true,
        revision = 1 + AlbumSongs.Count, tracks = AlbumSongs.Select(id => new { source_id = id }) };
    static object Playlist => new { id = PlaylistId, owner_id = "alex", name = "Test playlist", can_edit = true,
        tracks = OtherDeviceAddedSong ? new[] { new { source_id = "abcdefghijk" } } : [] };
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        var path=request.RequestUri!.AbsolutePath;
        if (path == FailedPath) return Task.FromResult(FlaskError(System.Net.HttpStatusCode.ServiceUnavailable));
        if (Offline) throw new HttpRequestException("Fixture server offline");
        if (AlbumMode && request.Method == HttpMethod.Post && path == "/api/playlists") AlbumCreates++;
        if (path == "/api/playlists/" + AlbumId && request.Method == HttpMethod.Patch)
        {
            using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync(token).GetAwaiter().GetResult());
            var version = body.RootElement.GetProperty("revision").GetInt32();
            if (version != AlbumSongs.Count + 1) return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Conflict));
            if (AlbumSongs.Count == 1 && rejectSecondSong)
            {
                rejectSecondSong = false;
                return Task.FromResult(FlaskError(System.Net.HttpStatusCode.ServiceUnavailable));
            }
            AlbumSongs.Add(body.RootElement.GetProperty("add_source_id").GetString()!);
        }
        if(Block && (path is "/api/server/stats" or "/api/activity/stats" || path.StartsWith("/api/catalogue/"))) return new TaskCompletionSource<HttpResponseMessage>().Task;
        if (request.Method == HttpMethod.Patch && path == "/api/playlists/" + PlaylistId)
        {
            Removals++;
            OtherDeviceAddedSong = false;
        }
        object data=path switch {
            "/api/connect" => new { family_profiles=true,csrf_token="boot",profiles=new[]{new{id="alex",name="Alex"}}},
            "/api/profile/select" => new {profile=new{id="alex",name="Alex"},csrf_token="chosen",preferences=new{volume=1}},
            "/api/library" => new { results = AlbumMode ? new[] {
                new { id = "albumtrack1", title = "Track one", channel = "Fixture Artist", library_album = "Fixture Album", saved = true },
                new { id = "albumtrack2", title = "Track two", channel = "Fixture Artist", library_album = "Fixture Album", saved = true }
            } : [] },
            "/api/playlists" when AlbumMode && request.Method == HttpMethod.Post => new { playlist = AlbumPlaylist },
            "/api/playlists" => new {playlists=new[]{Playlist}},
            "/api/playlists/" + PlaylistId => new { playlist = Playlist },
            "/api/playlists/" + AlbumId => new { playlist = AlbumPlaylist },
            "/api/discovery" => new { items = Array.Empty<object>() },
            "/api/catalogue/review" when CatalogueRows => new {
                can_edit = true, metadata_automatic = true, metadata_total = 2,
                metadata = new[] {
                    new { id = "abcdefghijk", title = "Fixture title", missing = new[] { "title" }, state = "queued", retry_at = 1795200000.5, retry_reason = "MusicBrainz rate limit" },
                    new { id = "lmnopqrstuv", title = "Fixture processing", missing = new[] { "album" }, state = "processing", retry_at = 0d, retry_reason = "" }
                },
                metadata_fixed = new[] { new { id = "12345678901", title = "Verified title", fields = new[] { "title" }, fixed_at = 1795100000L } }
            },
            "/api/catalogue/review" => new {can_edit=false,metadata=Array.Empty<object>(),trimming=Array.Empty<object>()},
            "/api/catalogue/source-quality" => new {
                songs = new[] { new { id = "abcdefghijk", title = "Source search", verdict = "suspect", replacement_checked = true, retry_at = 0, retry_reason = "Source search unavailable" } },
                @fixed = new[] { new { id = "lmnopqrstuv", title = "Official source", replaced_by = "vwxyz012345", fixed_at = 1795100001L } }
            },
            "/api/catalogue/reports" => new { reports = Array.Empty<object>() },
            "/api/activity/stats" => new {wrapped_year=2026,daily=new[]{new{day="2026-11-19",seconds=0}},profiles=new[]{new{id="alex",name="Alex",online=true,wrapped=new{total_minutes=0,songs_added=0}}}},
            "/api/server/stats" => new {workers=new[]{new{id="acquisition-0",title="Listener",state="working",current_title="Veridis Quo"}},jobs=Array.Empty<object>(),worker_stages=new[]{new{stage="fetch",queued=24,backing_off=0,running=1}},catalogue_workers=new{metadata=true,source_scan=true,source_auto_replace=false,playlist_matching=true,automatic_attempts_per_hour=30},storage_total_bytes=1000000000000L,storage_free_bytes=600000000000L},
            _ => new {} };
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(data),Encoding.UTF8,"application/json")});
    }
}
namespace FamilyHub.App.Services { public sealed class MusicPlayer { public bool FollowingHost => false; public MusicTrack? Current => null; public double Position => 0; public static long PlaybackTimestamp() => System.Diagnostics.Stopwatch.GetTimestamp(); public Task PlayAsync(MusicTrack track, long? requestedAt = null)=>Task.CompletedTask; } }

namespace FamilyHub.App.Services
{
    public static class AppUpdater
    {
        public static string CurrentVersion => "1.1.0";
        public static string? Platform { get; set; }
        public static bool UpdatesInSideStore => Platform == "ios";
        public const string ShortcutName = "Update FamilyHub";
        public static bool OneTapUpdate { get; set; }
        public static Task InstallAsync(FamilyHubApi? api, PublicAppReleases releases, AppRelease release, Action<int> progress) => Task.CompletedTask;
    }
}

namespace FamilyHub.ServerWork.Tests.Components { public sealed class ListenerMenu : ComponentBase { [Parameter] public ListenerStatistics? Profile { get; set; } } }
