using System.Text.Json.Serialization;

namespace FamilyHub.Client.Core;

public sealed record AppRelease(string Version, string Sha256, long Size,
    [property: JsonPropertyName("download_url")] string DownloadUrl);
