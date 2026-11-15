using System.Text.Json.Serialization;

namespace FamilyHub.Client.Core;

public sealed record ServerStatistics
{
    public string Since { get; init; } = "";
    [JsonPropertyName("total_seconds")] public double TotalSeconds { get; init; }
    [JsonPropertyName("total_qualified_plays")] public long TotalQualifiedPlays { get; init; }
    [JsonPropertyName("royalty_usd")] public double RoyaltyUsd { get; init; }
    [JsonPropertyName("saved_huf")] public long SavedHuf { get; init; }
    [JsonPropertyName("monthly_saved_huf")] public long MonthlySavedHuf { get; init; }
    public List<DailyListening> Daily { get; init; } = [];
    public List<ListenerStatistics> Profiles { get; init; } = [];
    public List<ServerWork> Jobs { get; init; } = [];
    [JsonPropertyName("catalogue_paused")] public bool CataloguePaused { get; init; }
    [JsonPropertyName("storage_total_bytes")] public long StorageTotalBytes { get; init; }
    [JsonPropertyName("storage_free_bytes")] public long StorageFreeBytes { get; init; }
}
public sealed record ListenerStatistics
{
    public List<DailyListening> Daily { get; init; } = [];
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    [JsonPropertyName("qualified_plays")] public long QualifiedPlays { get; init; }
    [JsonPropertyName("royalty_usd")] public double RoyaltyUsd { get; init; }
    [JsonPropertyName("saved_huf")] public long SavedHuf { get; init; }
    [JsonPropertyName("monthly_saved_huf")] public long MonthlySavedHuf { get; init; }
    [JsonPropertyName("spotify_subscribed")] public bool? SpotifySubscribed { get; init; }
    [JsonPropertyName("current_track")] public MusicTrack? CurrentTrack { get; init; }
    public bool Online { get; init; }
    public bool Listening { get; init; }
    public double Seconds { get; init; }
    [JsonPropertyName("month_seconds")] public double MonthSeconds { get; init; }
    [JsonPropertyName("active_months")] public int ActiveMonths { get; init; }
}
public sealed record ServerWork
{
    public string Owner { get; init; } = "";
    public string Kind { get; init; } = "";
    public int? Processed { get; init; }
    public int? Total { get; init; }
    public int? Remaining { get; init; }
    [JsonPropertyName("current_title")] public string CurrentTitle { get; init; } = "";
    public List<ServerWorkFile> Files { get; init; } = [];
    public string Title { get; init; } = "";
    public string User { get; init; } = "";
    public string Phase { get; init; } = "";
    public string State { get; init; } = "";
    [JsonPropertyName("download_bytes")] public long DownloadBytes { get; init; }
    [JsonPropertyName("download_total_bytes")] public long? DownloadTotalBytes { get; init; }
}

public sealed record DailyListening { public string Day { get; init; } = ""; public double Seconds { get; init; } }

public sealed record ServerWorkFile
{
    public int Index { get; init; }
    public string Title { get; init; } = "";
    public string Message { get; init; } = "";
    [JsonPropertyName("download_bytes")] public long DownloadBytes { get; init; }
    [JsonPropertyName("download_total_bytes")] public long? DownloadTotalBytes { get; init; }
}
