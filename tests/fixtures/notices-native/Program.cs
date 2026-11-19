using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;
using HarmonyLib;
using Microsoft.Extensions.FileProviders;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Storage;
using NoticesHost;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseStaticWebAssets();
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddScoped(_ =>
{
    var server = new Uri("https://notices.fixture.test/");
    var session = new MusicSession { UiActive = false };
    var api = new FamilyHubApi(server, new FixtureApi());
    typeof(FamilyHubApi).GetField("csrf", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(api, "fixture-csrf");
    void Set(string name, object value) => typeof(MusicSession).GetProperty(name)!.SetValue(session, value);
    Set("Ready", true);
    Set("Connected", true);
    Set("User", "fixture");
    Set("ProfileName", "Alex");
    Set("Server", server.ToString());
    Set("Api", api);
    Set("Offline", new OfflineLibrary(Path.GetFullPath(Path.Combine("..", "..", "..", ".local", "notices", "cache")), server, "fixture"));
    Set("PlaybackPreferences", new ListenerPreferences { SpotifySubscribed = false });
    return session;
});
builder.Services.AddScoped<MusicPlayer>();
builder.Services.AddScoped<ListenTogether>();
builder.Services.AddScoped<PlaybackConnection>();
builder.Services.AddScoped<PlaybackDevicePoll>();

typeof(Preferences).GetFields(BindingFlags.Static | BindingFlags.NonPublic)
    .Single(field => field.FieldType == typeof(IPreferences)).SetValue(null, new MemoryPreferences());
new Harmony("familyhub.notices.fixture").Patch(AccessTools.PropertyGetter(typeof(MainThread), "PlatformIsMainThread"),
    prefix: new HarmonyMethod(typeof(PlatformStub), nameof(PlatformStub.OnMainThread)));

var app = builder.Build();
var repo = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "..", ".."));
var native = Path.Combine(repo, "clients", "FamilyHub.App", "wwwroot");
app.MapGet("/native.js", () => Results.File(Path.Combine(native, "app.js"), "text/javascript"));
foreach (var folder in new[] { native, Path.Combine(repo, "music_web", "static") })
    app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(folder) });
app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<Review>().AddInteractiveServerRenderMode();
app.Run("http://127.0.0.1:38876");

static class PlatformStub
{
    public static bool OnMainThread(ref bool __result) { __result = true; return false; }
}

sealed class MemoryPreferences : IPreferences
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, object?> data = new();
    public bool ContainsKey(string key, string? sharedName = null) => data.ContainsKey(key);
    public void Remove(string key, string? sharedName = null) => data.TryRemove(key, out _);
    public void Clear(string? sharedName = null) => data.Clear();
    public void Set<T>(string key, T value, string? sharedName = null) => data[key] = value;
    public T Get<T>(string key, T defaultValue, string? sharedName = null) =>
        data.TryGetValue(key, out var value) && value is T result ? result : defaultValue;
}

sealed class FixtureApi : HttpMessageHandler
{
    private int stats, review;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path == "/api/server/stats" && ++stats == 1)
            throw new OperationCanceledException("Fixture server timed out.");
        if (path == "/api/catalogue/review" && ++review == 1)
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
        object body = path switch
        {
            "/api/search" => new { results = Array.Empty<object>(), complete = true },
            "/api/library" => new { results = Array.Empty<object>() },
            "/api/playlists" => new { playlists = Array.Empty<object>() },
            "/api/discovery" => new { items = Array.Empty<object>() },
            _ => new { },
        };
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(body) });
    }
}
