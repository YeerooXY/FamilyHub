using System.Globalization;
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

if (Environment.GetEnvironmentVariable("POPUP_CULTURE") is { Length: > 0 } culture)
    CultureInfo.DefaultThreadCurrentCulture = CultureInfo.GetCultureInfo(culture);

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseStaticWebAssets();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
var checkout = new DirectoryInfo(builder.Environment.ContentRootPath);
while (checkout is not null && !Directory.Exists(Path.Combine(checkout.FullName, "music_web")))
    checkout = checkout.Parent;
var repo = checkout?.FullName ?? throw new InvalidOperationException("Run the fixture inside the FamilyHub checkout.");
var feedbackDrafts = Path.Combine(repo, ".local", "popup-feedback-drafts", Guid.NewGuid().ToString("N"));
builder.Services.AddRazorComponents().AddInteractiveServerComponents()
    .AddHubOptions(options => options.MaximumReceiveMessageSize = 256 * 1024);
builder.Services.AddScoped<MusicSession>(_ => MakeSession(repo));
builder.Services.AddSingleton(new FeedbackDrafts(feedbackDrafts));
builder.Services.AddSingleton(_ => new PublicAppReleases(new HttpClient(new FixtureApi([]))));
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
typeof(SecureStorage).GetFields(BindingFlags.Static | BindingFlags.NonPublic)
    .Single(f => f.FieldType == typeof(ISecureStorage)).SetValue(null, new MemorySecureStorage());
typeof(Launcher).GetFields(BindingFlags.Static | BindingFlags.NonPublic)
    .Single(f => f.FieldType == typeof(ILauncher)).SetValue(null, new FixtureLauncher());
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
app.MapPost("/fixture/startup/{scenario}", (string scenario) =>
{
    FixtureApi.SimilarRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
    Interlocked.Exchange(ref FixtureApi.UpdateChecks, 0);
    FixtureLauncher.LastAddress = null;
    FixtureApi.Startup = scenario;
});
app.MapGet("/fixture/update-check", () => new { Count = Volatile.Read(ref FixtureApi.UpdateChecks), FixtureLauncher.LastAddress });
app.MapPost("/fixture/server-health/{state}", (string state) => FixtureApi.HealthState = state);
app.MapPost("/fixture/similar-release", () => FixtureApi.SimilarRelease.TrySetResult());
app.MapPost("/fixture/wordle-reset/{seconds:int}", (int seconds) =>
    FixtureApi.WordleReset = DateTimeOffset.UtcNow.AddSeconds(Math.Max(1, seconds)));
app.MapPost("/fixture/wordle-member/{count:int}/{submitted:bool}", (int count, bool submitted) =>
{
    FixtureApi.WordleMember = (count, submitted);
});
app.MapGet("/fixture/wordle-activity", () => Results.Text(FixtureApi.WordleActivity, "application/json"));
app.MapGet("/fixture/feedback-submission", () => Results.Text(FixtureApi.FeedbackSubmission, "application/json"));
app.MapGet("/fixture/feedback-draft", () => Results.Json(Directory.Exists(feedbackDrafts) && Directory.EnumerateFiles(feedbackDrafts, "*.json").Any()));

app.MapStaticAssets();
app.MapRazorComponents<MusicPopupHost.Review>().AddInteractiveServerRenderMode();
app.Run(Environment.GetEnvironmentVariable("POPUP_URL") ?? "http://127.0.0.1:38869");

static MusicSession MakeSession(string repo)
{
    var session = new MusicSession();
    void Set(string name, object value) => typeof(MusicSession).GetProperty(name)!.SetValue(session, value);
    Set("Ready", true);
    Set("Connected", FixtureApi.Startup != "update-offline");
    Set("MoviesEnabled", true);
    Set("ServerHealthAdmin", FixtureApi.Startup == "health-admin");
    session.UiActive = true;
    Set("User", "fixture");
    Set("Profiles", new List<ListenerProfile> { new() { Id = "fixture", Name = "Alex" }, new() { Id = "june", Name = "June" } });
    Set("ProfileName", "Alex");
    if (FixtureApi.Startup is "password-create" or "password-signin")
    {
        var create = FixtureApi.Startup == "password-create";
        Set("Profiles", new List<ListenerProfile> {
            new() { Id = "fixture", Name = "Yeeroo", RequiresPassword = true, NeedsPasswordSetup = create },
            new() { Id = "june", Name = "June" }, new() { Id = "kit", Name = "Nemozoli" }, new() { Id = "zaza", Name = "Zaza" } });
        typeof(MusicSession).GetProperty("NeedsProfileSelection")!.SetValue(session, true);
    }
    Set("Server", "https://music.fixture.test/");
    Set("Offline", new OfflineLibrary(Path.Combine(repo, ".local", "popup-fixture-cache"), new Uri(session.Server), session.User));
    Set("PlaybackPreferences", new ListenerPreferences { SpotifySubscribed = FixtureApi.Startup == "spotify" ? null : false });
    string[] albums = ["Evening Signals", "Night Windows", "Long Way Home", "Early Hours", "All Along the Water", "Motion Study", "Winter Sessions", "Return to the Coast"];
    var library = albums.SelectMany((album, number) => Enumerable.Range(1, 3).Select(i => new MusicTrack {
        Title = i == 1 ? new[] { "First Light", "City Lights", "Afterglow", "Northbound", "Passing Clouds", "Soft Focus", "Midwinter", "Sand and Stone" }[number] : album + " – Part " + i,
        LibraryAlbum = album, Channel = new[] { "North Atlas", "Glass Harbor", "June Echo", "Silver Current" }[number % 4],
        Genre = new[] { "R&B / Soul", "Rhythm and Blues", "Drum and Bass", "DnB", "Rock", "Pop", "Jazz", "Ambient" }[number],
        Id = (number * 10 + i).ToString("D11"), Duration = 203, Saved = true
    })).ToList();
    if (FixtureApi.Startup.StartsWith("similar-"))
        library[0] = library[0] with { Channel = "Fixture Seed", Genre = "Fixture Genre" };
    if (FixtureApi.Startup == "similar-preparing")
        library[1] = library[1] with { Title = "Local Match", Channel = "Fixture Seed", Genre = "Fixture Genre" };
    if (FixtureApi.Startup == "library-pages")
        library.AddRange(Enumerable.Range(1, 101).Select(i =>
            library[0] with { Id = $"extra{i:D6}", Title = $"Library page song {i}" }));
    Set("Library", library);
    var rememberPlayback = typeof(MusicSession).GetMethod("RememberPlaybackAttempt", BindingFlags.Instance | BindingFlags.NonPublic)!;
    rememberPlayback.Invoke(session, ["fedcba98765432100123456789abcdef", library[0], DateTimeOffset.UtcNow.AddMinutes(-2)]);
    const string interruptedAttempt = "edcba98765432100123456789abcdef0";
    rememberPlayback.Invoke(session, [interruptedAttempt, library[3], DateTimeOffset.UtcNow.AddMinutes(-1)]);
    typeof(MusicSession).GetMethod("RecordPlaybackObservation", BindingFlags.Instance | BindingFlags.NonPublic)!
        .Invoke(session, [interruptedAttempt, "early_end", 49.5, null]);
    var inMemoryAttempts = (System.Collections.IDictionary)typeof(MusicSession)
        .GetField("localPlaybackAttempts", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(session)!;
    inMemoryAttempts.Remove((session.Server, session.User, interruptedAttempt));
    var kept = library[^4];
    var cached = library[^3];
    Set("Downloads", new List<MusicTrack> { kept });
    Set("DownloadedBytes", 2L * 1024 * 1024);
    typeof(MusicSession).GetField("cachedTracks", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(session, new[] { cached });
    typeof(MusicSession).GetField("cachedHashes", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(session,
        new Dictionary<string, HashSet<string>> { [cached.Id] = [cached.DownloadSha256] });
    typeof(MusicSession).GetField("cachedBytes", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(session, 1024L * 1024);
    var api = new FamilyHubApi(new Uri(session.Server), new FixtureApi(library));
    typeof(FamilyHubApi).GetField("csrf", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(api, "fixture-csrf");
    if (FixtureApi.Startup != "update-offline") Set("Api", api);
    string[] mixes = ["Late Night Mix", "Quiet Mornings", "Weekend Drive", "After Hours", "On the Road", "House Mix", "November Picks", "First Listen"];
    Set("Playlists", mixes.Select((name, i) => new MusicPlaylist { Id = "mix" + i, Name = name, OwnerId = "fixture", OwnerName = "Alex", CanEdit = true, CanDelete = true, CanManageAuthors = true, Shared = true, CoverUrl = "/test/mix" + (20 + i),
        Tracks = library.Skip(i * 2).Take(4).Select(t => new PlaylistTrack {
            Title = t.Title, Artist = t.Channel, SourceId = t.Id, State = "saved", Duration = t.Duration, Album = t.LibraryAlbum, AddedBy = "fixture", AddedAt = "2026-11-17T18:00:00Z"
        }).Concat(i == 7 ? [new PlaylistTrack { Title = "Station Lights", Artist = "North Atlas", State = "review" }] : [])
          .Concat(i == 0 && FixtureApi.Startup == "paging"
              ? Enumerable.Range(1, 121).Select(n => new PlaylistTrack { Title = $"Paging song {n:D3}", Artist = "North Atlas" })
              : []).ToList()
    }).Concat([
        new MusicPlaylist { Id = "shared", Name = "Café Tapes", OwnerId = "june", OwnerName = "June", CanEdit = true, CoAuthors = ["fixture"] },
        new MusicPlaylist { Id = "radio", Name = "Night Station", OwnerId = "fixture", OwnerName = "Alex", Radio = true },
        new MusicPlaylist { Id = "old-radio", Name = "Early Station", OwnerId = "fixture", OwnerName = "Alex", SourceUrl = "familyhub-radio:track:42" }
    ]).ToList());
    foreach (var track in library.Where((_, i) => i % 3 == 0).Reverse()) session.RecordListen(track);
    return session;
}

sealed class MemorySecureStorage : ISecureStorage
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> values = new();
    public Task<string?> GetAsync(string key) => Task.FromResult(values.GetValueOrDefault(key));
    public Task SetAsync(string key, string value) { values[key] = value; return Task.CompletedTask; }
    public bool Remove(string key) => values.TryRemove(key, out _);
    public void RemoveAll() => values.Clear();
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
    public static bool CachedFile(MusicTrack track, CancellationToken token, ref Task<string> __result)
    {
        __result = FixtureApi.Startup == "similar-preparing" && track.Id == "00000000001"
            ? DelayFileAsync(token) : Task.FromResult("fixture.mp3");
        return false;
    }
    private static async Task<string> DelayFileAsync(CancellationToken token)
    {
        await Task.Delay(TimeSpan.FromSeconds(15), token);
        return "fixture.mp3";
    }
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
    public double Duration { get; } = FixtureApi.Startup == "seek-localized" ? 317.5 : 203;
    public double Volume { get; set; }
    public bool TransportEnabled { private get; set; }
    public void PlayFile(string path, string title, string artist, bool play = true, bool background = false) => SetPlaying(play);
    public void SetPlaying(bool play) { Playing = play; Changed?.Invoke(); }
    public void RefreshPosition() { }
    public Task SeekAsync(double seconds) { Position = seconds; return Task.CompletedTask; }
    public void Stop() { Playing = false; Position = 0; }
}

sealed class FixtureLauncher : ILauncher
{
    public static volatile string? LastAddress;
    public Task<bool> CanOpenAsync(Uri uri) => Task.FromResult(true);
    public Task<bool> OpenAsync(Uri uri) { LastAddress = uri.AbsoluteUri; return Task.FromResult(true); }
    public Task<bool> OpenAsync(OpenFileRequest request) => Task.FromResult(false);
    public Task<bool> TryOpenAsync(Uri uri) => OpenAsync(uri);
}

sealed class FixtureApi(List<MusicTrack> library) : HttpMessageHandler
{
    internal static string FeedbackSubmission { get; private set; } = "{}";
    private JsonElement? report;
    private string feedbackStatus = "new";
    private readonly List<string> feedbackReplies = [];
    internal static DateTimeOffset WordleReset { get; set; } = DateTimeOffset.UtcNow.AddDays(1);
    internal static (int Count, bool Submitted) WordleMember { get; set; } = (-1, false);
    internal static string WordleActivity { get; private set; } = "{}";
    private readonly List<(string Word, string[] Marks)> wordleGuesses = [];
    private string wordleDate = "";
    private bool hideWordleFamily;
    public static volatile bool ListenRequest;
    public static volatile string Startup = "none";
    public static volatile string HealthState = "ready";
    public static int UpdateChecks;
    public static volatile TaskCompletionSource SimilarRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool reportReplacing;
    private bool qualityReplacing;
    private bool unofficialReplacing;
    private static readonly string ReleaseHash = new('a', 64);
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (Startup is "password-create" or "password-signin")
        {
            var creating = Startup == "password-create";
            if (path == "/api/connect")
                return new(HttpStatusCode.OK) { Content = System.Net.Http.Json.JsonContent.Create(new {
                    family_profiles = true, csrf_token = "fixture-boot", profiles = new[] {
                        new { id = "fixture", name = "Yeeroo", requires_password = true, needs_password_setup = creating }
                    }
                }) };
            if (path is "/api/profile/select" or "/api/profile/password-setup")
            {
                using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                var accepted = payload.RootElement.GetProperty("password").GetString() == "long enough pass"
                    && creating == (path == "/api/profile/password-setup");
                return accepted
                    ? new(HttpStatusCode.OK) { Content = System.Net.Http.Json.JsonContent.Create(new {
                        profile = new { id = "fixture", name = "Yeeroo" }, preferences = new { spotify_subscribed = false }, csrf_token = "fixture-signed-in"
                    }) }
                    : new(HttpStatusCode.Forbidden) { Content = System.Net.Http.Json.JsonContent.Create(new { error = "Incorrect password. Try again." }) };
            }
        }
        if (path == "/api/server/stats/now" || path == "/api/server/stats" && request.RequestUri.Query.StartsWith("?range=", StringComparison.Ordinal))
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            object payload;
            if (path.EndsWith("/now", StringComparison.Ordinal))
            {
                if (HealthState == "current-error") return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
                payload = new ServerHealthNow
                {
                    At = now,
                    Mounts = [
                        new() { Mount = "/", Total = 120L << 30, Used = 38L << 30, Free = 76L << 30, Growth = 1L << 30,
                            Disks = [new("nvme0n1", "Passed")] },
                        new() { Mount = "/srv/familyhub", Total = 4L << 40, Used = 1680L << 30, Free = 2200L << 30, Growth = 37L << 30,
                            Disks = [new("sda", null)] }
                    ],
                    Networks = ["enp3s0", "VPN · tun0"],
                    Values = new()
                    {
                        ["cpu"] = 1.42, ["memory:used"] = 9.3 * (1L << 30), ["memory:available"] = 22.7 * (1L << 30),
                        ["power:cpu"] = 23.8, ["temperature:cpu"] = 73, ["temperature:nvme0n1"] = 41, ["temperature:sda"] = 55,
                        ["network:enp3s0:download"] = 2801254, ["network:enp3s0:upload"] = 183465,
                        ["network:VPN · tun0:download"] = 2570721, ["network:VPN · tun0:upload"] = 113062,
                    },
                    Monthly = new() { ["power:cpu"] = 16.28 },
                };
            }
            else
            {
                if (HealthState == "history-timeout") await Task.Delay(Timeout.InfiniteTimeSpan, token);
                if (HealthState == "empty-history") await Task.Delay(250, token);
                var range = request.RequestUri.Query[7..];
                var length = range switch { "24h" => 86400, "7d" => 604800, "90d" => 7776000, _ => 3600 };
                double[][] Points(double level, double change, int phase) =>
                    Enumerable.Range(1, 36).Select(i => new double[] {
                        now - length + i * (length / 36), Math.Round(level + change *
                            (Math.Sin(i * .45 + phase) + .35 * Math.Sin(i * 2.1 + phase)), 2)
                    }).ToArray();
                payload = new ServerHealthHistory
                {
                    At = now, Since = now - length, Step = length / 36,
                    Series = HealthState == "empty-history" ? [] : new()
                    {
                        ["network:enp3s0:download"] = Points(2150000, 1350000, 1),
                        ["network:enp3s0:upload"] = Points(644000, 430000, 6),
                        ["network:VPN · tun0:download"] = Points(1880000, 1210000, 1),
                        ["network:VPN · tun0:upload"] = Points(355000, 210000, 4),
                        ["cpu"] = Points(1.4, .9, 0), ["memory:used"] = Points(9.1 * (1L << 30), .8 * (1L << 30), 2),
                        ["memory:available"] = Points(22.9 * (1L << 30), .8 * (1L << 30), 5),
                        ["power:cpu"] = Points(23.9, 8.7, 3), ["temperature:cpu"] = Points(67, 12, 2),
                        ["temperature:sda"] = Points(49, 5, 3), ["temperature:nvme0n1"] = Points(39, 4, 4),
                        ["disk:/"] = Points(38L << 30, 1L << 29, 0), ["disk:/srv/familyhub"] = Points(1680L << 30, 8L << 30, 0),
                    },
                    Totals = new()
                    {
                        ["network:enp3s0:download"] = length * 2150000L, ["network:enp3s0:upload"] = length * 644000L,
                        ["network:VPN · tun0:download"] = length * 1880000L, ["network:VPN · tun0:upload"] = length * 355000L,
                    },
                };
            }
            return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent(JsonSerializer.Serialize(payload, FamilyHubApi.JsonOptions), Encoding.UTF8, "application/json") };
        }
        if (path == "/api/profile/name" && request.Method == HttpMethod.Patch)
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            var name = payload.RootElement.GetProperty("name").GetString()!.Trim();
            var duplicate = name.Equals("June", StringComparison.OrdinalIgnoreCase);
            var renameBody = duplicate ? JsonSerializer.Serialize(new { error = "A profile with this name already exists." })
                : JsonSerializer.Serialize(new { profile = new ListenerProfile { Id = "fixture", Name = name } });
            return new HttpResponseMessage(duplicate ? HttpStatusCode.BadRequest : HttpStatusCode.OK)
            { Content = new StringContent(renameBody, Encoding.UTF8, "application/json") };
        }
        if (request.RequestUri!.Host == "api.github.com" && path.EndsWith("/releases/latest", StringComparison.Ordinal))
        {
            if (Startup == "update-failed") return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            if (Startup is not ("update-offline" or "update-background")) return new HttpResponseMessage(HttpStatusCode.NotFound);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(new {
                    tag_name = "v9.9.9",
                    assets = new[] { new { name = "FamilyHub-Music-Windows-9.9.9.zip", state = "uploaded",
                        size = 32 * 1024 * 1024, digest = "sha256:" + ReleaseHash } }
                }), Encoding.UTF8, "application/json")
            };
        }
        if (path == "/api/app-updates/windows-x64")
        {
            Interlocked.Increment(ref UpdateChecks);
            if (Startup == "update-failed") return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            var version = Startup switch
            {
                "update" => "9.9.9",
                "update-current" => AppUpdater.CurrentVersion,
                "update-old" => "0.0.1",
                _ => null
            };
            if (version is null) return new HttpResponseMessage(HttpStatusCode.NotFound);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(
                new AppRelease(version, ReleaseHash, 32 * 1024 * 1024, "/api/app-updates/windows-x64/" + ReleaseHash)),
                Encoding.UTF8, "application/json") };
        }
        if (path == "/api/recommendations" && Startup.StartsWith("similar-"))
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            var offset = payload.RootElement.GetProperty("offset").GetInt32();
            await SimilarRelease.Task.WaitAsync(token);
            await Task.Delay(300, token);
            var failed = Startup == "similar-error" || offset > 0;
            var response = failed ? """{"error":"Similar songs are unavailable right now."}"""
                : Startup == "similar-empty" ? """{"results":[],"state":"empty"}"""
                : """
                  {"results":[
                    {"id":"fixture-001","title":"First Light (Official Audio)","channel":"Fixture Seed"},
                    {"id":"fixture-002","title":"Online Match","channel":"Fixture Seed"},
                    {"id":"fixture-003","title":"Unrelated Song","channel":"Other Artist"}],
                    "next_offset":8,"state":"ready"}
                  """;
            return new HttpResponseMessage(failed ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
            {
                Content = new StringContent(response, Encoding.UTF8, "application/json")
            };
        }
        if (path == "/api/feedback" || path.StartsWith("/api/feedback/", StringComparison.Ordinal))
        {
            static HttpResponseMessage Feedback(object value, HttpStatusCode status = HttpStatusCode.OK) => new(status)
            {
                Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json")
            };
            if (path == "/api/feedback" && request.Method == HttpMethod.Post)
            {
                if (Startup == "feedback-offline") return Feedback(new { error = "Feedback is offline. Try again." }, HttpStatusCode.ServiceUnavailable);
                FeedbackSubmission = await request.Content!.ReadAsStringAsync(token);
                using var payload = JsonDocument.Parse(FeedbackSubmission);
                report = payload.RootElement.Clone();
                return Feedback(new { id = report.Value.GetProperty("id").GetString() }, HttpStatusCode.Created);
            }
            var developer = Startup == "feedback-admin";
            if (report is not { } saved) return Feedback(new { can_manage = developer, reports = Array.Empty<object>() });
            var id = saved.GetProperty("id").GetString();
            var kind = saved.GetProperty("kind").GetString();
            var description = saved.GetProperty("description").GetString();
            if (path == "/api/feedback")
                return Feedback(new { can_manage = developer, reports = new[] { new { id, author = "Alex", kind, summary = description, status = feedbackStatus } } });
            if (path.Contains("/images/", StringComparison.Ordinal))
                return Feedback(new { mime = "image/png", data = saved.GetProperty("images")[0].GetProperty("data").GetString() });
            if (request.Method != HttpMethod.Get)
            {
                using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                if (path.EndsWith("/replies", StringComparison.Ordinal))
                {
                    feedbackReplies.Add(payload.RootElement.GetProperty("message").GetString()!);
                    feedbackStatus = developer ? "waiting" : "new";
                }
                else feedbackStatus = payload.RootElement.GetProperty("status").GetString()!;
                return Feedback(new { ok = true });
            }
            return Feedback(new { id, kind, author = "Alex", description, status = feedbackStatus,
                replies = feedbackReplies.Select(message => new { author = "Developer", message }),
                events = developer ? saved.GetProperty("events") : (JsonElement?)null,
                images = saved.GetProperty("images").EnumerateArray().Select((image, index) => new { index, name = image.GetProperty("name").GetString() }) });
        }
        if (path == "/api/wordle/activity")
        {
            WordleActivity = await request.Content!.ReadAsStringAsync(token);
            return new(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        }
        if (path is "/api/wordle/today" or "/api/wordle/guess" or "/api/wordle/stats" or "/api/wordle/family" or "/api/wordle/settings")
        {
            var nextDay = DateTimeOffset.UtcNow >= WordleReset;
            var day = nextDay ? "2026-11-22" : "2026-11-21";
            if (day != wordleDate) { wordleGuesses.Clear(); wordleDate = day; }
            HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) => new(status)
            {
                Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json")
            };
            if (path == "/api/wordle/settings")
            {
                if (request.Method == HttpMethod.Put)
                {
                    using var data = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                    hideWordleFamily = data.RootElement.GetProperty("hide_family_until_finished").GetBoolean();
                }
                return Json(new { hide_family_until_finished = hideWordleFamily });
            }
            if (path == "/api/wordle/stats")
            {
                var finished = wordleGuesses.LastOrDefault().Word == "crate";
                return Json(new
                {
                    personal = new { played = 1, won = 1, current_streak = 1, best_streak = 1, distribution = new[] { 0, 0, 1, 0, 0, 0 } },
                    family = new[] { new { profile_id = "fixture", name = "Alex", played = 1, won = 1, favorite_guesses = Array.Empty<object>() },
                        new { profile_id = "june", name = "June", played = 3, won = 2,
                            favorite_guesses = new object[] { new { word = "grape", count = finished ? 3 : 2 } } } },
                    family_totals = new { played = 4, won = 3, distribution = new[] { 0, 1, 2, 0, 0, 0 },
                        today = !hideWordleFamily || finished ? new { completed = 2, won = 2, members = 2 } : null },
                    history = new[] { new { date = day, status = "won", guesses = 3 } }
                });
            }
            if (path == "/api/wordle/guess")
            {
                if (Startup == "wordle-delayed") await Task.Delay(4000, token);
                using var data = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                var payload = data.RootElement;
                var word = payload.GetProperty("word").GetString()!;
                if (payload.GetProperty("date").GetString() != day || payload.GetProperty("guess_count").GetInt32() != wordleGuesses.Count)
                    return Json(new { error = "The puzzle changed." }, HttpStatusCode.Conflict);
                if (word == "zzzzz") return Json(new { error = "Not in the word list." }, HttpStatusCode.BadRequest);
                if (word == "plate")
                {
                    wordleGuesses.Add(("brave", ["absent", "correct", "correct", "absent", "correct"]));
                    return Json(new { error = "The puzzle changed." }, HttpStatusCode.Conflict);
                }
                wordleGuesses.Add((word, word == "crate" ? ["correct", "correct", "correct", "correct", "correct"]
                    : ["absent", "absent", "correct", "correct", "correct"]));
            }
            var won = wordleGuesses.LastOrDefault().Word == "crate";
            var lost = Startup == "wordle-unlucky" && wordleGuesses.Count == 6 && !won;
            var finishedBoard = won || lost;
            var fastFamilyWin = Startup == "wordle-lucky";
            string[] juneMarks = ["absent", "correct", "present", "absent", "absent"];
            string[] winningMarks = ["correct", "correct", "correct", "correct", "correct"];
            var member = WordleMember;
            var juneGuesses = new[] { new { word = "grape", marks = juneMarks } };
            if (fastFamilyWin) juneGuesses = [new { word = "crate", marks = winningMarks }];
            else if (member.Submitted) juneGuesses = [.. juneGuesses, new { word = "crate", marks = winningMarks }];
            var family = new[] { new { id = "fixture", name = "Alex", rows = Array.Empty<string[]>(), playing = false, draft_count = 0, guesses = (object?)null, active_ms = finishedBoard ? 23000 : (int?)null, review = (object?)null },
                new { id = "june", name = "June", rows = juneGuesses.Select(guess => guess.marks).ToArray(),
                    playing = member.Count >= 0, draft_count = Math.Max(0, member.Count),
                    guesses = finishedBoard ? juneGuesses : (object?)null,
                    active_ms = fastFamilyWin || member.Submitted ? 11000 : (int?)null,
                    review = finishedBoard && (fastFamilyWin || member.Submitted)
                        ? new { remaining = fastFamilyWin ? new[] { 0 } : new[] { 12, 0 } } : (object?)null } };
            if (hideWordleFamily && !won) family = family[..1];
            if (path == "/api/wordle/family") return Json(new { date = day, family });
            return Json(new
            {
                date = day,
                status = won ? "won" : lost ? "lost" : "playing",
                guesses = wordleGuesses.Select(guess => new { word = guess.Word, marks = guess.Marks }),
                answer = finishedBoard ? "crate" : null,
                active_ms = finishedBoard ? 23000 : (int?)null,
                review = finishedBoard ? new { remaining = wordleGuesses.Select((_, i) => won && i == wordleGuesses.Count - 1 ? 0 : 6 - i),
                    outcome = lost ? "unlucky" : fastFamilyWin ? "lucky" : null,
                    final_options = lost ? 2 : fastFamilyWin ? 5193 : (int?)null,
                    hard_rules = won && wordleGuesses.Count == 2 && wordleGuesses[0].Word == "slate",
                    grades = wordleGuesses.Select((_, i) => new { kind = i == 0 ? "book" : won && i == wordleGuesses.Count - 1 ? "best" : "inaccuracy",
                        better = i == 0 || (won && i == wordleGuesses.Count - 1) ? null : "crane" }),
                    guess_times_ms = wordleGuesses.Select((_, i) => i == 0 ? 4400 : 18600) } : null,
                family,
                local_solution = Startup is "wordle-delayed" or "wordle-lucky" or "wordle-unlucky" ? "crate" : null,
                next_reset = nextDay ? WordleReset.AddDays(1) : WordleReset
            });
        }
        if (path == "/api/listening/events") {
            using var events = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new {
                acknowledged = events.RootElement.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("event_id").GetString()).ToList()
            }), Encoding.UTF8, "application/json") };
        }
        if (request.Method == HttpMethod.Post &&
            (path is "/api/catalogue/reports/replace" or "/api/catalogue/source-quality/00000000002/replace"
                or "/api/catalogue/source-quality/00000000003/replace"))
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            var fields = payload.RootElement;
            var isReport = path == "/api/catalogue/reports/replace";
            var isSuggested = path == "/api/catalogue/source-quality/00000000002/replace";
            var approved = isSuggested
                ? fields.GetProperty("candidate_id").GetString() == "Station0001"
                : (!isReport || fields.GetProperty("key").GetString() == "fixture:00000000001") &&
                    fields.GetProperty("url").GetString() == "https://youtu.be/Station0001";
            if (!approved)
                return new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent("""{"error":"Choose a valid YouTube recording link."}""", Encoding.UTF8, "application/json")
                };
            if (isReport) reportReplacing = true;
            else if (isSuggested) qualityReplacing = true;
            else unofficialReplacing = true;
            return new HttpResponseMessage(HttpStatusCode.Accepted)
            {
                Content = new StringContent("""{"state":"replacing"}""", Encoding.UTF8, "application/json")
            };
        }
        var body = path switch
        {
            "/api/library" => JsonSerializer.Serialize(new { results = library }),
            "/api/playback/diagnostics" => """
                {"actions":[
                    {"action":"fedcba98765432100123456789abcdef","events":[
                        {"stage":"client_play","client_ms":0},
                        {"stage":"stream_response_ready","server_ms":180},
                        {"stage":"client_position_advanced","client_ms":740},
                        {"stage":"client_stream_failed","client_ms":6000},
                        {"stage":"client_failed","client_ms":7000}]},
                    {"action":"adb80533000000000000000000000000","events":[
                        {"stage":"client_fallback","client_ms":35187},
                        {"stage":"client_fallback_ready","client_ms":77640}]},
                    {"action":"cdb80533000000000000000000000000","events":[
                        {"stage":"client_position_advanced","client_ms":745}]},
                    {"action":"ddcba98765432100123456789abcdef0","events":[
                        {"stage":"client_position_advanced","client_ms":745},
                        {"stage":"client_native_error","client_ms":52300,"position_ms":50411,"reason":"ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT"}]}
                ]}
                """,
            "/api/search" => "{\"tracks\":[],\"results\":[],\"complete\":true}",
            "/api/listening/rooms" => """{"rooms":[]}""",
            "/api/listening/pokes" when ListenRequest => """{"requests":[{"id":"invite-1","sender":"june","name":"June","kind":"invite","room_id":"fixture-room"}]}""",
            "/api/listening/pokes" => """{"requests":[]}""",
            "/api/discovery/follow" => """{"artists":[]}""",
            "/api/playback/devices" => """{"devices":[{"id":"other","name":"Living room PC","kind":"windows"},{"id":"phone","name":"June’s phone","kind":"android"}]}""",
            "/api/catalogue/reports" when request.Method == HttpMethod.Get =>
                $$"""{"reports":[{"key":"fixture:00000000001","id":"00000000001","title":"First Light","artist":"North Atlas","profile":"june","reason":"wrong_recording","replacing":{{(reportReplacing ? "true" : "false")}}}]}""",
            "/api/catalogue/source-quality" =>
                $$"""
                {"songs":[
                    {"id":"00000000002","title":"Evening Signals","artist":"North Atlas","verdict":"suspect",
                     "replacing":{{(qualityReplacing ? "true" : "false")}},"queued":{{(qualityReplacing ? "true" : "false")}},
                     "proposed_replacement":{"id":"Station0001","channel":"North Atlas"}
                    },
                    {"id":"00000000003","title":"Northbound","artist":"North Atlas","verdict":"unofficial",
                     "replacing":{{(unofficialReplacing ? "true" : "false")}},"replacement_checked":true}
                ]}
                """,
            "/api/catalogue/review" when request.RequestUri.Query.Contains("work=queue") => """
                {"can_edit":true,"playlist_gaps_total":1,"playlist_gaps":[{"playlist_id":"mix7","owner_id":"fixture","playlist_name":"First Listen","title":"Queued recording","retry_reason":"No verified recording match","retry_at":1800000000,"state":"error"}]}
                """,
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
                  "wrapped":{"songs_added":14,"total_minutes":116,"favourite_artist":"North Atlas","favourite_genre":"Indie rock","longest_streak_days":6,
                   "night_owl_share":0.25,"most_replayed_song":{"title":"Station Lights","artist":"North Atlas","replays":1},"mainstream_score":0.4,
                   "early_listeners":["Glass Harbor","Silver Current"],"chart_date":"2026-11-18"}},
                 {"id":"june","name":"June","seconds":3800,"qualified_plays":22,"active_months":2,
                  "wrapped":{"songs_added":7,"total_minutes":63,"favourite_artist":"June Echo","favourite_genre":"Ambient","longest_streak_days":4}}],
                 "records":[{"id":"streak","title":"Longest streak","owner":"fixture","user":"Alex","day":"2026-11-18","days":6}],
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
