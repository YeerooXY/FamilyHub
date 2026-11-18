using System.Text.Json.Serialization;
namespace FamilyHub.Client.Core;

public sealed record DiscoveryItem
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string Artist { get; init; } = "";
    [JsonPropertyName("release_date")] public string ReleaseDate { get; init; } = "";
    [JsonPropertyName("source_url")] public string SourceUrl { get; init; } = "";
    public bool Seen { get; set; }
    public bool Stale { get; init; }
    public string Reason { get; init; } = "";
    /// <summary>A cover address the server supplies, when it has one.</summary>
    [JsonPropertyName("cover")] public string? Cover { get; init; }
    [JsonPropertyName("source_ids")] public DiscoverySourceIds? SourceIds { get; init; }

    /// <summary>The release cover: the server's address, else Deezer's album image for the release.</summary>
    [JsonIgnore]
    public string? CoverUrl => Cover is { } cover && Uri.TryCreate(cover, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps ? cover
        : SourceIds?.Album is > 0 and var album ? "https://api.deezer.com/album/" + album + "/image?size=big" : null;
}
public sealed record DiscoverySourceIds { [JsonPropertyName("album")] public long? Album { get; init; } }
public sealed record DiscoveryPage { public List<DiscoveryItem> Items { get; init; } = []; }
public sealed record DiscoveryQuery { public string Query { get; init; } = ""; }
public sealed record LibraryAddition
{
    public string Id { get; init; } = "";
    [JsonPropertyName("source_id")] public string? SourceId { get; init; }
    public string Title { get; init; } = "";
    public string State { get; init; } = "";
    public string Message { get; init; } = "";
    [JsonPropertyName("playlist_error")] public string? PlaylistError { get; init; }
    public bool Saved { get; init; }
    [JsonIgnore] public bool Pending => State is "queued" or "running";
    [JsonIgnore] public string Key => SourceId is { Length: 11 } ? SourceId : Id;
}
public sealed record LibraryAdditionStatus(LibraryAddition Job);
public sealed record LibraryAdditionPage { public List<LibraryAddition> Jobs { get; init; } = []; }
public sealed record ArtistMapping
{
    public string Name { get; init; } = "";
    public string Confidence { get; init; } = "";
    public string Status { get; init; } = "";
    public int Revision { get; init; }
    public List<string> Aliases { get; init; } = [];
    [JsonPropertyName("deezer_id")] public long? DeezerId { get; init; }
    public List<long> Candidates { get; init; } = [];
}
public sealed record ArtistMappingPage { public List<ArtistMapping> Artists { get; init; } = []; }

public sealed record FollowedArtists { public List<string> Artists { get; init; } = []; }
