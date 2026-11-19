using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.JSInterop;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;
using FamilyHub.ServerWork.Tests.Components;

Directory.CreateDirectory(".local/ui");
var session = (MusicSession)Activator.CreateInstance(typeof(MusicSession), BindingFlags.Instance | BindingFlags.NonPublic, null, new object[]{(Func<Uri, FamilyHubApi>)(origin => new FamilyHubApi(origin, new FixtureHandler()))}, null)!;
await session.ConnectServerAsync("https://ui-check.test");
await session.SelectProfileAsync("alex");
var activator = new CaptureActivator();
var services = new ServiceCollection().AddLogging().AddSingleton(session).AddSingleton(new MusicPlayer())
    .AddSingleton<IJSRuntime, NoJs>().AddSingleton<IComponentActivator>(activator).BuildServiceProvider();
await using var renderer = new HtmlRenderer(services, services.GetRequiredService<ILoggerFactory>());
await renderer.Dispatcher.InvokeAsync(async () => {
    var stats = await renderer.RenderComponentAsync<ServerStats>();
    var review = await renderer.RenderComponentAsync<CatalogueReviewPanel>();
    async Task Refresh(Type type) => await (Task)type.GetMethod("Refresh", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(activator.Instances[type], null)!;
    var watch = System.Diagnostics.Stopwatch.StartNew();
    await Task.WhenAll(Refresh(typeof(ServerStats)), Refresh(typeof(CatalogueReviewPanel)));
    var html = stats.ToHtmlString() + review.ToHtmlString();
    if (!html.Contains("Retry server work") || !html.Contains("Retry song review") || html.Contains("aria-busy=\"true\"")) throw new Exception("Timeout did not end loading and expose retries");
    if (watch.Elapsed.TotalSeconds > 7) throw new Exception("Component timeout exceeded bound");
    Save("error", html);
    FixtureHandler.Block = false;
    await Task.WhenAll(Refresh(typeof(ServerStats)), Refresh(typeof(CatalogueReviewPanel)));
    html = stats.ToHtmlString() + review.ToHtmlString();
    if (html.Contains("Retry server work") || html.Contains("Retry song review")) throw new Exception("Retry did not recover");
    Save("loaded", html);
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
    var css = string.Join("\n", new[]{"music_web/static/shell.css", "clients/FamilyHub.App/wwwroot/app-native.css", "clients/FamilyHub.App/wwwroot/server-stats.css", "clients/FamilyHub.App/wwwroot/stats-pages.css", "clients/FamilyHub.App/wwwroot/music-admin.css"}.Where(File.Exists).Select(File.ReadAllText));
    File.WriteAllText($".local/ui/{name}.html", "<!doctype html><html><meta name='viewport' content='width=device-width,initial-scale=1'><style>"+css+"\nhtml,body{height:auto;min-height:100%;overflow:visible}body{display:block;margin:0;padding:24px;background:#07101f;color:#edf2fa;font-family:Arial,sans-serif}.server-work-page{height:auto;overflow:visible;max-width:1100px;margin:auto;display:grid;gap:24px}button{min-height:44px}</style><main class='server-work-page'>"+html+"</main></html>");
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
    public const string PlaylistId = "0123456789abcdefghijkl";
    public static bool OtherDeviceAddedSong;
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
        if (AlbumMode && request.Method == HttpMethod.Post && path == "/api/playlists") AlbumCreates++;
        if (path == "/api/playlists/" + AlbumId && request.Method == HttpMethod.Patch)
        {
            using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync(token).GetAwaiter().GetResult());
            var version = body.RootElement.GetProperty("revision").GetInt32();
            if (version != AlbumSongs.Count + 1) return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Conflict));
            if (AlbumSongs.Count == 1 && rejectSecondSong)
            {
                rejectSecondSong = false;
                return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable));
            }
            AlbumSongs.Add(body.RootElement.GetProperty("add_source_id").GetString()!);
        }
        if(Block && (path=="/api/server/stats" || path.StartsWith("/api/catalogue/"))) return new TaskCompletionSource<HttpResponseMessage>().Task;
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
            "/api/catalogue/review" => new {can_edit=false,metadata=Array.Empty<object>(),trimming=Array.Empty<object>()},
            "/api/server/stats" => new {workers=new[]{new{id="acquisition-0",title="Listener",state="working",current_title="Veridis Quo"}},jobs=Array.Empty<object>(),worker_stages=new[]{new{stage="fetch",queued=24,backing_off=0,running=1}},storage_total_bytes=1000000000000L,storage_free_bytes=600000000000L},
            _ => new {} };
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(data),Encoding.UTF8,"application/json")});
    }
}
namespace FamilyHub.App.Services { public sealed class MusicPlayer { public bool FollowingHost => false; public MusicTrack? Current => null; public double Position => 0; public Task PlayAsync(MusicTrack track)=>Task.CompletedTask; } }

namespace FamilyHub.ServerWork.Tests.Components { public sealed class ListenerMenu : ComponentBase { [Parameter] public ListenerStatistics? Profile { get; set; } } }
