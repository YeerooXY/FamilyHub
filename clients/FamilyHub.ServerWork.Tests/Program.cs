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
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        var path=request.RequestUri!.AbsolutePath;
        if(Block && (path=="/api/server/stats" || path.StartsWith("/api/catalogue/"))) return new TaskCompletionSource<HttpResponseMessage>().Task;
        object data=path switch {
            "/api/connect" => new { family_profiles=true,csrf_token="boot",profiles=new[]{new{id="alex",name="Alex"}}},
            "/api/profile/select" => new {profile=new{id="alex",name="Alex"},csrf_token="chosen",preferences=new{volume=1}},
            "/api/library" => new {results=Array.Empty<object>()},
            "/api/playlists" => new {playlists=Array.Empty<object>()},
            "/api/catalogue/review" => new {can_edit=false,metadata=Array.Empty<object>(),trimming=Array.Empty<object>()},
            "/api/server/stats" => new {workers=new[]{new{id="acquisition-0",title="Listener",state="working",current_title="Veridis Quo"}},jobs=Array.Empty<object>(),worker_stages=new[]{new{stage="fetch",queued=24,backing_off=0,running=1}},storage_total_bytes=1000000000000L,storage_free_bytes=600000000000L},
            _ => new {} };
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(data),Encoding.UTF8,"application/json")});
    }
}
namespace FamilyHub.App.Services { public sealed class MusicPlayer { public bool FollowingHost => false; public MusicTrack? Current => null; public double Position => 0; public Task PlayAsync(MusicTrack track)=>Task.CompletedTask; } }

namespace FamilyHub.ServerWork.Tests.Components { public sealed class ListenerMenu : ComponentBase { [Parameter] public ListenerStatistics? Profile { get; set; } } }
