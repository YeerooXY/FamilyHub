using System.Text.Json.Serialization;
namespace FamilyHub.Client.Core;
public sealed record CatalogueReviewSnapshot
{
    [JsonPropertyName("trimming")] public List<TrimmingRequest> Trimming { get; init; } = [];
    [JsonPropertyName("metadata")] public List<MetadataRequest> Metadata { get; init; } = [];
    [JsonPropertyName("trimming_total")] public int TrimmingTotal { get; init; }
    [JsonPropertyName("metadata_total")] public int MetadataTotal { get; init; }
    [JsonPropertyName("can_edit")] public bool CanEdit { get; init; }
}
public sealed record TrimmingRequest
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("title")] public string Title { get; init; } = "";
    [JsonPropertyName("artist")] public string Artist { get; init; } = "";
    [JsonPropertyName("positions")] public List<double> Positions { get; init; } = [];
    [JsonPropertyName("requested_by")] public List<string> RequestedBy { get; init; } = [];
}
public sealed record MetadataRequest
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("title")] public string Title { get; init; } = "";
    [JsonPropertyName("revision")] public int Revision { get; init; }
    [JsonPropertyName("current")] public Dictionary<string,string> Current { get; init; } = [];
    [JsonPropertyName("missing")] public List<string> Missing { get; init; } = [];
    [JsonPropertyName("state")] public string State { get; init; } = "";
    [JsonPropertyName("source_url")] public string SourceUrl { get; init; } = "";
    [JsonPropertyName("source")] public string Source { get; init; } = "";
    [JsonPropertyName("suggested")] public Dictionary<string,string> Suggested { get; init; } = [];
    /// <summary>The value to edit: a suggestion fills a field that is still missing.</summary>
    public string Draft(string key) => Missing.Contains(key) && Suggested.TryGetValue(key, out var value) && value.Length > 0 ? value : Current.GetValueOrDefault(key, "");
}
