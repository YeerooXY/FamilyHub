using System.Text.Json.Serialization;

namespace FamilyHub.Client.Core;

public sealed record ListeningEvent
{
    [JsonPropertyName("event_id")] public string EventId { get; init; } = Guid.NewGuid().ToString();
    [JsonPropertyName("recording_id")] public string RecordingId { get; init; } = "";
    [JsonPropertyName("started_at")] public DateTimeOffset StartedAt { get; init; }
    [JsonPropertyName("listened_seconds")] public double ListenedSeconds { get; init; }
    [JsonPropertyName("duration")] public double Duration { get; init; }
    [JsonPropertyName("position")] public double Position { get; init; }
    [JsonPropertyName("outcome")] public string Outcome { get; init; } = "stopped";
    [JsonPropertyName("source")] public string Source { get; init; } = "other";
    [JsonPropertyName("device_kind")] public string DeviceKind { get; init; } = "windows";
    [JsonPropertyName("track"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? Track { get; init; }
}

public sealed record ListeningCounts
{
    [JsonPropertyName("plays")] public int Plays { get; init; }
    [JsonPropertyName("completes")] public int Completes { get; init; }
    [JsonPropertyName("skips")] public int Skips { get; init; }
    [JsonPropertyName("score")] public double Score { get; init; }
    [JsonPropertyName("last_early_skip")] public DateTimeOffset? LastEarlySkip { get; init; }
}

public sealed record ListeningSummary
{
    [JsonPropertyName("cleared_at")] public DateTimeOffset? ClearedAt { get; init; }
    [JsonPropertyName("recordings")] public Dictionary<string, ListeningCounts> Recordings { get; init; } = [];
    [JsonPropertyName("artists")] public Dictionary<string, ListeningCounts> Artists { get; init; } = [];
    [JsonPropertyName("genres")] public Dictionary<string, ListeningCounts> Genres { get; init; } = [];
    // Oldest first, including repeated plays.
    [JsonPropertyName("recent_history")] public List<string> RecentHistory { get; init; } = [];
}

public static class ListeningRecommendations
{
    public static List<MusicTrack> Rank(IEnumerable<MusicTrack> candidates, ListeningSummary? summary,
        IEnumerable<string> recentHistory, DateTimeOffset now)
    {
        var history = recentHistory.TakeLast(200).ToList();
        var recent = history.TakeLast(50).ToHashSet();
        var tracks = candidates.DistinctBy(t => t.Id).ToList();
        var artists = (summary?.Artists ?? []).GroupBy(p => Similarity.Artist(new MusicTrack { Channel = p.Key }))
            .ToDictionary(g => g.Key, g => g.Sum(p => p.Value.Score + Math.Log2(1 + p.Value.Completes)));
        var genres = (summary?.Genres ?? []).GroupBy(p => GenreNames.Key(p.Key))
            .ToDictionary(g => g.Key, g => g.Sum(p => p.Value.Score));
        if (summary is null || summary.Artists.Count == 0)
        {
            var byId = tracks.ToDictionary(t => t.Id);
            foreach (var (id, index) in history.Select((id, index) => (id, index)))
                if (byId.TryGetValue(id, out var seed))
                {
                    var artist = Similarity.Artist(seed);
                    artists[artist] = artists.GetValueOrDefault(artist) + (index + 1d) / history.Count;
                }
        }
        var remaining = tracks.Where(t => !recent.Contains(t.Id)
            && !(summary?.Recordings.GetValueOrDefault(t.Id)?.LastEarlySkip is { } at && now - at < TimeSpan.FromDays(7)))
            .Select(t => (Track: t, Artist: Similarity.Artist(t), Score: artists.GetValueOrDefault(Similarity.Artist(t))
                + genres.GetValueOrDefault(GenreNames.Key(t.Genre))))
            .OrderByDescending(t => t.Score).ThenBy(t => t.Track.Id, StringComparer.Ordinal).ToList();
        var result = new List<MusicTrack>();
        var used = new Dictionary<string, int>();
        string? previous = null; var run = 0;
        while (remaining.Count > 0)
        {
            var varied = remaining.Where(t => run < 2 || t.Artist != previous).ToList();
            var next = (varied.Count > 0 ? varied : remaining).MaxBy(t => t.Score - 4 * used.GetValueOrDefault(t.Artist));
            remaining.Remove(next); result.Add(next.Track);
            used[next.Artist] = used.GetValueOrDefault(next.Artist) + 1;
            run = next.Artist == previous ? run + 1 : 1; previous = next.Artist;
        }
        return result;
    }
}
