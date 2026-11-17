using System.Text.Json.Serialization;

namespace FamilyHub.Client.Core;

public sealed record MusicTrack
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("url")] public string Url { get; init; } = "";
    [JsonPropertyName("title")] public string Title { get; init; } = "";
    [JsonPropertyName("channel")] public string Channel { get; init; } = "";
    [JsonPropertyName("library_album")] public string LibraryAlbum { get; init; } = "";
    [JsonPropertyName("genre")] public string Genre { get; init; } = "";
    [JsonPropertyName("playback_gain_db")] public double? PlaybackGainDb { get; init; }
    [JsonPropertyName("lufs")] public double? Lufs { get; init; }
    [JsonPropertyName("true_peak")] public double? TruePeak { get; init; }
    [JsonPropertyName("duration")] public double Duration { get; init; }
    [JsonPropertyName("bpm")] public int? Bpm { get; init; }
    [JsonPropertyName("key")] public string? Key { get; init; }
    [JsonPropertyName("key_name")] public string? KeyName { get; init; }
    [JsonPropertyName("saved")] public bool Saved { get; init; }
    [JsonPropertyName("download_url")] public string DownloadUrl { get; init; } = "";
    [JsonPropertyName("download_size")] public long DownloadSize { get; init; }
    [JsonPropertyName("download_sha256")] public string DownloadSha256 { get; init; } = "";
    [JsonPropertyName("download_extension")] public string DownloadExtension { get; init; } = "";
    [JsonPropertyName("playback_info_url")] public string PlaybackInfoUrl { get; init; } = "";
    [JsonPropertyName("playback_source_sha256")] public string PlaybackSourceSha256 { get; init; } = "";
    [JsonPropertyName("playback_version")] public string PlaybackVersion { get; init; } = "";
    [JsonPropertyName("listening_version")] public string ListeningVersion { get; init; } = "";
}

/// <summary>A song's lyrics: state is synced, plain, instrumental or none. Synced line times are playback seconds.</summary>
public sealed record SongLyrics
{
    [JsonPropertyName("state")] public string State { get; init; } = "none";
    [JsonPropertyName("lines")] public List<LyricLine> Lines { get; init; } = [];
    [JsonPropertyName("text")] public string Text { get; init; } = "";
}

public sealed record LyricLine
{
    [JsonPropertyName("t")] public double Time { get; init; }
    [JsonPropertyName("text")] public string Text { get; init; } = "";
}

public sealed record MusicPlaylist
{
    [JsonPropertyName("description")] public string Description { get; init; } = "";
    [JsonPropertyName("cover_url")] public string CoverUrl { get; init; } = "";
    [JsonPropertyName("cover_sha256")] public string CoverSha256 { get; init; } = "";
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("revision")] public int Revision { get; init; }
    [JsonPropertyName("owner_id")] public string OwnerId { get; init; } = "";
    [JsonPropertyName("owner_name")] public string OwnerName { get; init; } = "";
    [JsonPropertyName("can_edit")] public bool CanEdit { get; init; }
    [JsonPropertyName("can_manage_authors")] public bool CanManageAuthors { get; init; }
    [JsonPropertyName("co_authors")] public List<string> CoAuthors { get; init; } = [];
    [JsonPropertyName("can_delete")] public bool CanDelete { get; init; }
    [JsonPropertyName("shared")] public bool Shared { get; init; }
    [JsonPropertyName("tracks")] public List<PlaylistTrack> Tracks { get; init; } = [];
}

public sealed record PlaylistTrack
{
    [JsonPropertyName("album")] public string Album { get; init; } = "";
    [JsonPropertyName("added_at")] public string? AddedAt { get; init; }
    [JsonPropertyName("added_by")] public string? AddedBy { get; init; }
    [JsonPropertyName("title")] public string Title { get; init; } = "";
    [JsonPropertyName("artist")] public string Artist { get; init; } = "";
    [JsonPropertyName("duration")] public double Duration { get; init; }
    [JsonPropertyName("source_id")] public string? SourceId { get; init; }
    [JsonPropertyName("spotify_uri")] public string SpotifyUri { get; init; } = "";
    [JsonPropertyName("match")] public MusicTrack? Match { get; init; }
    [JsonPropertyName("state")] public string State { get; init; } = "unmatched";
    [JsonIgnore] public string? RecordingId => SourceId ?? Match?.Id;
}

public sealed record DownloadProgress(long Received, long Total);

public sealed record ListenerProfile
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("color")] public string Color { get; init; } = "";
    [JsonPropertyName("image_url")] public string ImageUrl { get; init; } = "";
    [JsonPropertyName("image_sha256")] public string ImageSha256 { get; init; } = "";
}

public sealed record ListenerPreferences
{
    [JsonPropertyName("volume")] public double Volume { get; init; } = 1;
    [JsonPropertyName("shuffle")] public bool Shuffle { get; init; }
    [JsonPropertyName("auto_dj")] public bool AutoDj { get; init; } = true;
    [JsonPropertyName("volume_level")] public string VolumeLevel { get; init; } = "normal";
    [JsonPropertyName("crossfade_seconds")] public int CrossfadeSeconds { get; init; } = 6;
    [JsonPropertyName("repeat_mode")] public string RepeatMode { get; init; } = "off";
    [JsonPropertyName("spotify_subscribed"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? SpotifySubscribed { get; init; }
}

public sealed record ProfileConnection
{
    [JsonPropertyName("family_profiles")] public bool FamilyProfiles { get; init; }
    [JsonPropertyName("profiles")] public List<ListenerProfile> Profiles { get; init; } = [];
    [JsonPropertyName("csrf_token")] public string CsrfToken { get; init; } = "";
}

public sealed record ProfileSelection
{
    [JsonPropertyName("profile")] public ListenerProfile Profile { get; init; } = new();
    [JsonPropertyName("preferences")] public ListenerPreferences Preferences { get; init; } = new();
    [JsonPropertyName("csrf_token")] public string CsrfToken { get; init; } = "";
}

public sealed class FamilyHubApiException(string message, int statusCode) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

public sealed record SearchPage
{
    [JsonPropertyName("results")] public List<MusicTrack> Tracks { get; init; } = [];
    [JsonPropertyName("next_offset")] public int? NextOffset { get; init; }
}

public sealed record PlaybackResume
{
    [JsonPropertyName("track_ids")] public List<string> TrackIds { get; init; } = [];
    [JsonPropertyName("index")] public int Index { get; init; }
    [JsonPropertyName("position")] public double Position { get; init; }
    [JsonPropertyName("updated_at")] public long UpdatedAt { get; init; }
    [JsonIgnore] public bool IsValid => TrackIds is { Count: > 0 and <= 1000 } && Index >= 0 && Index < TrackIds.Count
        && double.IsFinite(Position) && Position >= 0 && Position <= 86400
        && TrackIds.All(id => id is not null && System.Text.RegularExpressions.Regex.IsMatch(id, "^(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})$"));
}
