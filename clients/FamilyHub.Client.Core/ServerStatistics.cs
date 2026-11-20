using System.Text.Json.Serialization;

namespace FamilyHub.Client.Core;

public sealed record ServerStatistics
{
    [JsonPropertyName("snapshot_age_seconds")] public int SnapshotAgeSeconds { get; init; }
    public string Since { get; init; } = "";
    [JsonPropertyName("total_seconds")] public double TotalSeconds { get; init; }
    [JsonPropertyName("total_qualified_plays")] public long TotalQualifiedPlays { get; init; }
    [JsonPropertyName("royalty_usd")] public double RoyaltyUsd { get; init; }
    [JsonPropertyName("saved_huf")] public long SavedHuf { get; init; }
    [JsonPropertyName("monthly_saved_huf")] public long MonthlySavedHuf { get; init; }
    public List<DailyListening> Daily { get; init; } = [];
    public List<ListenerStatistics> Profiles { get; init; } = [];
    public List<ServerWork> Jobs { get; init; } = [];
    public List<ServerWork> Workers { get; init; } = [];
    [JsonPropertyName("worker_stages")] public List<WorkerStage>? WorkerStages { get; init; }
    [JsonPropertyName("playlist_backlog")] public PlaylistBacklog? PlaylistBacklog { get; init; }
    [JsonPropertyName("catalogue_workers")] public CatalogueWorkerSettings? CatalogueWorkers { get; init; }
    public List<ListeningRecord> Records { get; init; } = [];
    [JsonPropertyName("wrapped_year")] public int? WrappedYear { get; init; }
    [JsonPropertyName("catalogue_paused")] public bool CataloguePaused { get; init; }
    [JsonPropertyName("storage_total_bytes")] public long StorageTotalBytes { get; init; }
    [JsonPropertyName("storage_free_bytes")] public long StorageFreeBytes { get; init; }
}

public sealed record CatalogueWorkerSettings
{
    public bool Metadata { get; init; }
    [JsonPropertyName("source_scan")] public bool SourceScan { get; init; }
    [JsonPropertyName("source_auto_replace")] public bool SourceAutoReplace { get; init; }
    [JsonPropertyName("automatic_attempts_per_hour")] public int AttemptsPerHour { get; init; }
    [JsonPropertyName("playlist_matching")] public bool PlaylistMatching { get; init; }
}

public sealed record PlaylistBacklog
{
    [JsonPropertyName("backlog_pending")] public int Pending { get; init; }
    [JsonPropertyName("backlog_backing_off")] public int WaitingToRetry { get; init; }
    [JsonPropertyName("backlog_running")] public int Running { get; init; }
}

public sealed record WorkerStage
{
    public string Stage { get; init; } = "";
    public int Queued { get; init; }
    [JsonPropertyName("backing_off")] public int BackingOff { get; init; }
    public int Running { get; init; }
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
    public WrappedStatistics? Wrapped { get; init; }
}
public sealed record WrappedStatistics
{
    [JsonPropertyName("songs_added")] public int SongsAdded { get; init; }
    [JsonPropertyName("favourite_artist")] public string? FavouriteArtist { get; init; }
    [JsonPropertyName("favourite_genre")] public string? FavouriteGenre { get; init; }
    [JsonPropertyName("total_minutes")] public double TotalMinutes { get; init; }
    [JsonPropertyName("longest_streak_days")] public int LongestStreakDays { get; init; }
    [JsonPropertyName("night_owl_share")] public double? NightOwlShare { get; init; }
    [JsonPropertyName("most_replayed_song")] public WrappedSong? MostReplayedSong { get; init; }
    [JsonPropertyName("mainstream_score")] public double? MainstreamScore { get; init; }
    [JsonPropertyName("early_listeners")] public List<string> EarlyListeners { get; init; } = [];
    [JsonPropertyName("chart_date")] public string? ChartDate { get; init; }
}
public sealed record WrappedSong
{
    public string? Title { get; init; }
    public string? Artist { get; init; }
    public int Replays { get; init; }
}
public sealed record ServerWork
{
    public string Id { get; init; } = "";
    public double? Progress { get; init; }
    [JsonPropertyName("waiting_for")] public string WaitingFor { get; init; } = "";
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

public sealed record ListeningRecord
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string Owner { get; init; } = "";
    public string User { get; init; } = "";
    public string Day { get; init; } = "";
    [JsonPropertyName("end_day")] public string EndDay { get; init; } = "";
    public double? Seconds { get; init; }
    public int? Days { get; init; }
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
