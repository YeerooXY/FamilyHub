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
}
public sealed record DiscoveryPage { public List<DiscoveryItem> Items { get; init; } = []; }
public sealed record DiscoveryQuery { public string Query { get; init; } = ""; }
public sealed record LibraryAddition
{
    public string Id { get; init; } = "";
    [JsonPropertyName("source_id")] public string SourceId { get; init; } = "";
    public string Title { get; init; } = "";
    public string State { get; init; } = "";
    public bool Saved { get; init; }
}
public sealed record LibraryAdditionPage { public List<LibraryAddition> Jobs { get; init; } = []; }
public sealed record ArtistMapping
{
    public string Name { get; init; } = "";
    public string Confidence { get; init; } = "";
    [JsonPropertyName("deezer_id")] public long? DeezerId { get; init; }
    public List<long> Candidates { get; init; } = [];
}
public sealed record ArtistMappingPage { public List<ArtistMapping> Artists { get; init; } = []; }

public sealed record FollowedArtists { public List<string> Artists { get; init; } = []; }
