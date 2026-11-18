using System.Net;
using System.Text;
using System.Text.Json;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;

internal static class HistoryChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        var now = DateTimeOffset.Parse("2026-11-18T12:00:00Z");
        MusicTrack Track(string id, string artist = "A") => new() { Id = id, Channel = artist, Genre = "Pop", Duration = 100 };
        var candidates = new[] { Track("a"), Track("b"), Track("c"), Track("d", "B"), Track("e", "C") };
        var summary = new ListeningSummary
        {
            Artists = new() { ["A"] = new() { Completes = 10, Score = 100 } },
            Recordings = new() { ["e"] = new() { LastEarlySkip = now.AddDays(-1) } }
        };
        var ranked = ListeningRecommendations.Rank(candidates, summary, [], now);
        Check(ranked.Select(t => t.Id).SequenceEqual(["a", "b", "d", "c"]), "Ranking must favour completes, exclude early skips and limit artist runs");
        Check(ListeningRecommendations.Rank(candidates.Reverse(), summary, [], now).SequenceEqual(ranked), "Ranking is nondeterministic");
        Check(!ListeningRecommendations.Rank(candidates, summary, ["a"], now).Any(t => t.Id == "a"), "Recent recording repeated");
        Check(ListeningRecommendations.Rank(candidates, summary, Enumerable.Repeat("a", 1).Concat(Enumerable.Repeat("x", 50)), now).Any(t => t.Id == "a"), "Repeat window exceeds 50 plays");
        Check(ListeningRecommendations.Rank(candidates, summary, [], now.AddDays(8)).Any(t => t.Id == "e"), "Early skip exclusion did not expire");
        Check(ListeningRecommendations.Rank(candidates, null, [], now).Count == candidates.Length, "Offline ranking requires summaries");

        Check(ListeningRecommendations.Rank([Track("seed", "B"), Track("z", "B"), Track("a", "A")], null, ["seed"], now)[0].Id == "z", "Offline migration lost local artist seeds");
        var online = true; var acknowledge = false; var posts = 0; var summaries = 0; var clears = 0;
        var uploaded = new List<ListeningEvent>();
        var batchSizes = new List<int>();
        FamilyHubApi Api(Uri origin) => new(origin, new Handler(request =>
        {
            if (!online) throw new HttpRequestException("offline");
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/listening/events")
            {
                posts++;
                using var json = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                var batch = json.RootElement.GetProperty("events").Deserialize<List<ListeningEvent>>()!;
                uploaded.AddRange(batch); batchSizes.Add(batch.Count);
                return Json(new { acknowledged = acknowledge ? batch.Select(e => e.EventId).ToArray() : [] });
            }
            if (path == "/api/listening/summary") { summaries++; return Json(new ListeningSummary { RecentHistory = ["remote00001"] }); }
            if (path == "/api/listening/history") { clears++; return Json(new { cleared = true }); }
            if (path == "/api/profile/preferences")
            {
                using var json = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                return Json(new { preferences = json.RootElement.Clone() });
            }
            return path switch
            {
                "/api/connect" => Json(new { family_profiles = true, csrf_token = "boot", profiles = new[] { new { id = "alex", name = "Alex" } } }),
                "/api/profile/select" => Json(new { profile = new { id = "alex", name = "Alex" }, csrf_token = "selected", preferences = new { } }),
                "/api/library" => Json(new { results = new[] { Track("legacy00001"), Track("remote00001"), Track("pending0001") } }),
                "/api/playlists" => Json(new { playlists = Array.Empty<object>() }),
                _ => new(HttpStatusCode.NotFound)
            };
        }));
        var session = new MusicSession(Api);
        await session.ConnectServerAsync("https://history-checks.test");
        await session.SelectProfileAsync("alex");
        // Record legacy ids locally, without inventing events, then simulate the first history migration.
        session.RecordListen(Track("legacy00001"));
        var migratedKey = PreferencesKey(session) + ":history-v1:migrated";
        Preferences.Default.Set(migratedKey, "false");
        await session.SyncHistoryAsync();
        Check(session.RecentlyPlayed(10).Select(t => t.Id).SequenceEqual(["remote00001", "legacy00001"]), "Legacy history was not merged with server history");
        Check(posts == 0, "Migration uploaded synthetic events");
        var owner = session.HistoryOwner;
        online = false;
        session.QueueListeningEvent(Track("pending0001"), now, 12, 100, 12, "skipped", "search", owner);
        await session.SyncHistoryAsync();
        var pendingFile = Path.Combine(session.Offline!.RootDirectory, "history-pending.json");
        var pending = JsonSerializer.Deserialize<List<ListeningEvent>>(File.ReadAllText(pendingFile))!;
        Check(pending.Count == 1 && pending[0].Outcome == "skipped" && pending[0].DeviceKind == "windows", "Offline event not persisted");
        session.Api!.Dispose();
        var restarted = new MusicSession(Api);
        await restarted.InitializeAsync();
        online = true;
        await restarted.ConnectServerAsync("https://history-checks.test");
        await restarted.SelectProfileAsync("alex");
        Check(JsonSerializer.Deserialize<List<ListeningEvent>>(File.ReadAllText(pendingFile))!.Count == 1, "Unacknowledged events were removed after restart");
        acknowledge = true;
        await restarted.SyncHistoryAsync();
        Check(JsonSerializer.Deserialize<List<ListeningEvent>>(File.ReadAllText(pendingFile))!.Count == 0, "Acknowledged event was retained");
        Check(uploaded.All(e => e.EventId == pending[0].EventId), "Retry changed event UUID");
        online = false;
        for (var i = 0; i < 105; i++) restarted.QueueListeningEvent(Track("pending0001"), now, 1, 100, 1, "stopped", "library", restarted.HistoryOwner);
        online = true; batchSizes.Clear();
        await restarted.SyncHistoryAsync();
        Check(batchSizes.SequenceEqual([100, 5]), "Upload batches must be bounded to 100 events");
        var beforeWrongOwner = posts;
        restarted.QueueListeningEvent(Track("pending0001"), now, 1, 100, 1, "stopped", "library", "another-profile");
        await restarted.SyncHistoryAsync();
        Check(posts == beforeWrongOwner, "An event crossed profile boundaries");
        await restarted.SavePreferencesAsync(1, false, listeningHistoryPaused: true);
        restarted.QueueListeningEvent(Track("pending0001"), now, 12, 100, 12, "skipped", "queue", restarted.HistoryOwner);
        Check(JsonSerializer.Deserialize<List<ListeningEvent>>(File.ReadAllText(pendingFile))!.Count == 0, "Paused history queued an event");
        await restarted.ClearListeningHistoryAsync();
        Check(clears == 1 && !restarted.HasListeningHistory, "Clear retained local recommendation history");
        Check(restarted.HistoryOwner != owner, "Clear did not invalidate the active listening event");
        restarted.Api?.Dispose();
        return checks;
    }
    private static string PreferencesKey(MusicSession session) => "familyhub:profile-prefs:" + Convert.ToHexString(
        System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(session.Server + "\n" + session.User)));
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK)
        { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(respond(request));
    }
}
