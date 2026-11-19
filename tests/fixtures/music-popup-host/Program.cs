using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;
using Microsoft.Extensions.FileProviders;
using Microsoft.Maui.Storage;
using HarmonyLib;
using Microsoft.Maui.ApplicationModel;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseStaticWebAssets();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
var checkout = new DirectoryInfo(builder.Environment.ContentRootPath);
while (checkout is not null && !Directory.Exists(Path.Combine(checkout.FullName, "music_web")))
    checkout = checkout.Parent;
var repo = checkout?.FullName ?? throw new InvalidOperationException("Run the fixture inside the FamilyHub checkout.");
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddScoped<MusicSession>(_ => MakeSession(repo));
builder.Services.AddScoped(service => {
    var player = new MusicPlayer(service.GetRequiredService<MusicSession>());
    typeof(MusicPlayer).GetMethod("AttachDecks", BindingFlags.Instance | BindingFlags.NonPublic)!
        .Invoke(player, new object?[] { new FixtureDeck(), null });
    return player;
});
builder.Services.AddScoped<ListenTogether>();
builder.Services.AddScoped<PlaybackConnection>();
builder.Services.AddScoped<PlaybackDevicePoll>();
typeof(Preferences).GetFields(BindingFlags.Static | BindingFlags.NonPublic)
    .Single(f => f.FieldType == typeof(IPreferences)).SetValue(null, new MemoryPreferences());
var patcher = new Harmony("familyhub.fixture");
patcher.Patch(AccessTools.PropertyGetter(typeof(MainThread), "PlatformIsMainThread"), prefix: new HarmonyMethod(typeof(PlatformStubs), nameof(PlatformStubs.OnMainThread)));
patcher.Patch(AccessTools.Method(typeof(MusicPlayer), "PrepareFile"), prefix: new HarmonyMethod(typeof(PlatformStubs), nameof(PlatformStubs.CachedFile)));
patcher.Patch(AccessTools.Method(typeof(MusicSession), "OfflineError"), prefix: new HarmonyMethod(typeof(PlatformStubs), nameof(PlatformStubs.LogOfflineError)));
patcher.Patch(AccessTools.PropertyGetter(typeof(MusicSession), "DeviceName"), prefix: new HarmonyMethod(typeof(PlatformStubs), nameof(PlatformStubs.DeviceName)));
patcher.Patch(AccessTools.Method(typeof(AudioOutputs), nameof(AudioOutputs.ListAsync)), prefix: new HarmonyMethod(typeof(PlatformStubs), nameof(PlatformStubs.ListAudioOutputs)));
patcher.Patch(AccessTools.Method(typeof(FamilyHubApi), "DefaultHandler"), prefix: new HarmonyMethod(typeof(PlatformStubs), nameof(PlatformStubs.DefaultHttpHandler)));
var app = builder.Build();

foreach (var folder in new[] { "clients/FamilyHub.App/wwwroot", "music_web/static" })
    app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(folder.StartsWith("clients") && Environment.GetEnvironmentVariable("POPUP_BASELINE_ASSETS") is { } assets ? assets : Path.Combine(repo, folder)) });
app.UseAntiforgery();
app.MapPost("/fixture/listening-request/{show:bool}", (bool show) => FixtureApi.ListenRequest = show);
app.MapPost("/fixture/startup/{scenario}", (string scenario) => FixtureApi.Startup = scenario);

app.MapStaticAssets();
app.MapRazorComponents<MusicPopupHost.Review>().AddInteractiveServerRenderMode();
app.Run(Environment.GetEnvironmentVariable("POPUP_URL") ?? "http://127.0.0.1:38869");

static MusicSession MakeSession(string repo)
{
    var session = new MusicSession();
    void Set(string name, object value) => typeof(MusicSession).GetProperty(name)!.SetValue(session, value);
    Set("Ready", true);
    Set("Connected", true);
    session.UiActive = true;
    Set("User", "fixture");
    Set("Profiles", new List<ListenerProfile> { new() { Id = "fixture", Name = "Alex" }, new() { Id = "june", Name = "June" } });
    Set("ProfileName", "Alex");
    Set("Server", "https://music.fixture.test/");
    Set("Offline", new OfflineLibrary(Path.Combine(repo, ".local", "popup-fixture-cache"), new Uri(session.Server), session.User));
    Set("PlaybackPreferences", new ListenerPreferences { SpotifySubscribed = FixtureApi.Startup == "spotify" ? null : false });
    string[] albums = ["Evening Signals", "Night Windows", "Long Way Home", "Early Hours", "All Along the Water", "Motion Study", "Winter Sessions", "Return to the Coast"];
    var library = albums.SelectMany((album, number) => Enumerable.Range(1, 3).Select(i => new MusicTrack {
        Title = i == 1 ? new[] { "First Light", "City Lights", "Afterglow", "Northbound", "Passing Clouds", "Soft Focus", "Midwinter", "Sand and Stone" }[number] : album + " – Part " + i,
        LibraryAlbum = album, Channel = new[] { "North Atlas", "Glass Harbor", "June Echo", "Silver Current" }[number % 4],
        Id = (number * 10 + i).ToString("D11"), Duration = 203, Saved = true
    })).ToList();
    Set("Library", library);
    var api = new FamilyHubApi(new Uri(session.Server), new FixtureApi(library));
    typeof(FamilyHubApi).GetField("csrf", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(api, "fixture-csrf");
    Set("Api", api);
    string[] mixes = ["Late Night Mix", "Quiet Mornings", "Weekend Drive", "After Hours", "On the Road", "House Mix", "November Picks", "First Listen"];
    Set("Playlists", mixes.Select((name, i) => new MusicPlaylist { Id = "mix" + i, Name = name, OwnerId = "fixture", OwnerName = "Alex", CanEdit = true, CanDelete = true, CanManageAuthors = true, Shared = true, CoverUrl = "/test/mix" + (20 + i),
        Tracks = library.Skip(i * 2).Take(4).Select(t => new PlaylistTrack {
            Title = t.Title, Artist = t.Channel, SourceId = t.Id, State = "saved", Duration = t.Duration, Album = t.LibraryAlbum, AddedBy = "fixture", AddedAt = "2026-11-17T18:00:00Z"
        }).Concat(i == 7 ? [new PlaylistTrack { Title = "Station Lights", Artist = "North Atlas", State = "review" }] : []).ToList()
    }).ToList());
    foreach (var track in library.Where((_, i) => i % 3 == 0).Reverse()) session.RecordListen(track);
    return session;
}

sealed class MemoryPreferences : IPreferences
{
    readonly System.Collections.Concurrent.ConcurrentDictionary<string, object?> data = new();
    public bool ContainsKey(string key, string? sharedName = null) => data.ContainsKey(key);
    public void Remove(string key, string? sharedName = null) => data.TryRemove(key, out _);
    public void Clear(string? sharedName = null) => data.Clear();
    public void Set<T>(string key, T value, string? sharedName = null) => data[key] = value;
    public T Get<T>(string key, T defaultValue, string? sharedName = null) => data.TryGetValue(key, out var value) && value is T result ? result : defaultValue;
}

static class PlatformStubs
{
    public static bool OnMainThread(ref bool __result) { __result = true; return false; }
    public static bool CachedFile(ref Task<string> __result) { __result = Task.FromResult("fixture.mp3"); return false; }
    public static bool DeviceName(ref string __result) { __result = "This computer"; return false; }
    public static bool DefaultHttpHandler(ref HttpMessageHandler __result) { __result = new FixtureApi([]); return false; }
    public static bool ListAudioOutputs(ref Task<List<AudioOutput>> __result)
    {
        __result = Task.FromResult<List<AudioOutput>>([new("", "System default"), new("desk", "Desktop speakers")]);
        return false;
    }
    public static void LogOfflineError(Exception error) => Console.WriteLine("FIXTURE OFFLINE " + error);
}

sealed class FixtureDeck : IAudioDeck
{
    public event Action? Changed;
    public event Action? Ended { add { } remove { } }
    public event Action<string>? Failed { add { } remove { } }
    public bool Opening => false;
    public bool PlaybackRequested => Playing;
    public bool Playing { get; private set; }
    public double Position { get; private set; }
    public double Duration => 203;
    public double Volume { get; set; }
    public bool TransportEnabled { private get; set; }
    public void PlayFile(string path, string title, string artist, bool play = true, bool background = false) => SetPlaying(play);
    public void SetPlaying(bool play) { Playing = play; Changed?.Invoke(); }
    public void RefreshPosition() { }
    public Task SeekAsync(double seconds) { Position = seconds; return Task.CompletedTask; }
    public void Stop() { Playing = false; Position = 0; }
}

sealed class FixtureApi(List<MusicTrack> library) : HttpMessageHandler
{
    public static volatile bool ListenRequest;
    public static volatile string Startup = "none";
    private static readonly string ReleaseHash = new('a', 64);
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path == "/api/listening/events") {
            using var events = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new {
                acknowledged = events.RootElement.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("event_id").GetString()).ToList()
            }), Encoding.UTF8, "application/json") };
        }
        var body = path switch
        {
            "/api/library" => JsonSerializer.Serialize(new { results = library }),
            "/api/search" => "{\"tracks\":[],\"results\":[],\"complete\":true}",
            "/api/listening/rooms" => """{"rooms":[]}""",
            "/api/listening/pokes" when ListenRequest => """{"requests":[{"id":"invite-1","sender":"june","name":"June","kind":"invite","room_id":"fixture-room"}]}""",
            "/api/listening/pokes" => """{"requests":[]}""",
            "/api/app-updates/windows-x64" when Startup == "update" => JsonSerializer.Serialize(
                new AppRelease("9.9.9", ReleaseHash, 32 * 1024 * 1024, "/api/app-updates/windows-x64/" + ReleaseHash)),
            "/api/discovery/follow" => """{"artists":[]}""",
            "/api/playback/devices" => """{"devices":[{"id":"other","name":"Living room PC","kind":"windows"},{"id":"phone","name":"June’s phone","kind":"android"}]}""",
            "/api/catalogue/reports" when request.Method == HttpMethod.Get => """{"reports":[]}""",
            "/api/catalogue/review" => """
                {"can_edit":true,"metadata_total":1,
                 "metadata":[{"id":"00000000001","title":"First Light","missing":["album"],"current":{"artist":"North Atlas","title":"First Light"},"suggested":{"album":"Evening Signals"}}],
                 "trimming_total":1,"trimming":[{"id":"00000000002","title":"Evening Signals – Part 2","artist":"North Atlas","positions":[8.5],"requested_by":["June"]}],
                 "playlist_gaps_total":1,"playlist_gaps":[{"playlist_id":"mix7","owner_id":"fixture","playlist_name":"First Listen","index":4,"title":"Station Lights","artist":"North Atlas","state":"review","can_edit":true}]}
                """,
            "/api/playlists/mix7/match" => """{"revision":0,"track":{"candidates":[{"id":"Station0001","title":"Station Lights","channel":"North Atlas","duration":192}]}}""",
            "/api/admin/discovery" => """{"artists":[{"name":"North Atlas","deezer_id":345912,"status":"verified"},{"name":"June Echo","status":"quarantined"},{"name":"Glass Harbor","status":"pending"}]}""",
            "/api/server/stats" => """
                {"total_seconds":10800,"storage_total_bytes":107374182400,"storage_free_bytes":64424509440,
                 "wrapped_year":2026,"daily":[{"day":"2026-11-17","seconds":3600},{"day":"2026-11-18","seconds":7200}],
                 "profiles":[{"id":"fixture","name":"Alex","online":true,"seconds":7000,"qualified_plays":41,"active_months":3,
                  "wrapped":{"songs_added":14,"total_minutes":116,"favourite_artist":"North Atlas","favourite_genre":"Indie rock","longest_streak_days":6}},
                 {"id":"june","name":"June","seconds":3800,"qualified_plays":22,"active_months":2,
                  "wrapped":{"songs_added":7,"total_minutes":63,"favourite_artist":"June Echo","favourite_genre":"Ambient","longest_streak_days":4}}],
                 "jobs":[{"id":"job1","title":"Late Night Mix","kind":"playlist","state":"running","progress":38,"total":8,"processed":3}]}
                """,
            _ when path.EndsWith("/lyrics") => "{\"state\":\"synced\",\"lines\":[{\"t\":0,\"text\":\"Streetlights fade into the morning\"},{\"t\":12,\"text\":\"The first train crosses the river\"},{\"t\":24,\"text\":\"Clouds move over the northern hills\"},{\"t\":36,\"text\":\"Windows open on the avenue\"}]}",
            "/api/discovery" => JsonSerializer.Serialize(new { items = new[] { "Quiet Harbour", "The Skyline at Dawn", "Turning Point", "Paper Planes", "Signals", "Landmarks", "Late Return", "Sundown" }.Select((title, i) => new {
                id = $"42:{i + 1}", title, artist = new[] { "North Atlas", "Glass Harbor", "June Echo", "Silver Current" }[i % 4],
                cover = i == 3 ? null : $"https://art.fixture.test/release{i}.svg" }) }),
            _ => "{}"
        };
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }
}
