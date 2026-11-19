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
    FixtureHandler.Offline = true;
    await session.RefreshAsync();
    if (session.Connected || !stats.ToHtmlString().Contains("Use Refresh to reconnect"))
        throw new Exception("Offline server work did not explain how to reconnect");
    FixtureHandler.Offline = false;
    await (Task)typeof(ServerStats).GetMethod("RefreshNow", BindingFlags.NonPublic | BindingFlags.Instance)!
        .Invoke(activator.Instances[typeof(ServerStats)], null)!;
    if (!session.Connected || stats.ToHtmlString().Contains("Use Refresh to reconnect"))
        throw new Exception("Server work could not reconnect from its own Refresh button");
    var leaderboard = await renderer.RenderComponentAsync<ServerStats>(ParameterView.FromDictionary(
        new Dictionary<string, object?> { [nameof(ServerStats.Leaderboard)] = true }));
    FixtureHandler.Block = true;
    await Refresh(typeof(ServerStats));
    if (!leaderboard.ToHtmlString().Contains("Retry leaderboard")) throw new Exception("Leaderboard did not name its retry");
    FixtureHandler.Block = false;
    await Refresh(typeof(ServerStats));
    var empty = leaderboard.ToHtmlString();
    if (!empty.Contains("No listening recorded for this period") || !empty.Contains("listening summary.")
        || !empty.Contains("Alex") || empty.Contains("lb-wrapped-card") || empty.Contains("lb-place-1") || empty.Contains("stats-line-chart"))
        throw new Exception("Empty leaderboard ranked a listener or omitted the Wrapped empty state and online profile");
    Save("leaderboard-empty", empty);
    foreach (var (platform, action, help) in new[]
    {
        ("windows-x64", "Download and restart", "Playback stops"),
        ("android", "Download update", "downloaded APK"),
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
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        var path=request.RequestUri!.AbsolutePath;
        if (Offline) throw new HttpRequestException("Fixture server offline");
        if(Block && (path=="/api/server/stats" || path.StartsWith("/api/catalogue/"))) return new TaskCompletionSource<HttpResponseMessage>().Task;
        object data=path switch {
            "/api/connect" => new { family_profiles=true,csrf_token="boot",profiles=new[]{new{id="alex",name="Alex"}}},
            "/api/profile/select" => new {profile=new{id="alex",name="Alex"},csrf_token="chosen",preferences=new{volume=1}},
            "/api/library" => new {results=Array.Empty<object>()},
            "/api/playlists" => new {playlists=Array.Empty<object>()},
            "/api/catalogue/review" => new {can_edit=false,metadata=Array.Empty<object>(),trimming=Array.Empty<object>()},
            "/api/server/stats" when request.RequestUri.Query == "?leaderboard=1" => new {wrapped_year=2026,daily=new[]{new{day="2026-11-19",seconds=0}},profiles=new[]{new{id="alex",name="Alex",online=true,wrapped=new{total_minutes=0,songs_added=0}}}},
            "/api/server/stats" => new {workers=new[]{new{id="acquisition-0",title="Listener",state="working",current_title="Veridis Quo"}},jobs=Array.Empty<object>(),worker_stages=new[]{new{stage="fetch",queued=24,backing_off=0,running=1}},storage_total_bytes=1000000000000L,storage_free_bytes=600000000000L},
            _ => new {} };
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(data),Encoding.UTF8,"application/json")});
    }
}
namespace FamilyHub.App.Services { public sealed class MusicPlayer { public bool FollowingHost => false; public MusicTrack? Current => null; public double Position => 0; public Task PlayAsync(MusicTrack track)=>Task.CompletedTask; } }

namespace FamilyHub.App.Services
{
    public static class AppUpdater
    {
        public static string? Platform { get; set; }
        public static bool UpdatesInSideStore => Platform == "ios";
        public static Task InstallAsync(FamilyHubApi api, AppRelease release, Action<int> progress) => Task.CompletedTask;
    }
}

namespace FamilyHub.ServerWork.Tests.Components { public sealed class ListenerMenu : ComponentBase { [Parameter] public ListenerStatistics? Profile { get; set; } } }
