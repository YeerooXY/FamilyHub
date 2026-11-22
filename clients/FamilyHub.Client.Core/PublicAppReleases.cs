using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public sealed class PublicAppReleases(HttpClient http)
{
    public const string HistoryUrl = "https://github.com/YeerooXY/FamilyHub/releases";
    private const string LatestUrl = "https://api.github.com/repos/YeerooXY/FamilyHub/releases/latest";

    private sealed record Release([property: JsonPropertyName("tag_name")] string Tag, Asset[] Assets);
    private sealed record Asset(string Name, string State, long Size, string? Digest);

    public async Task<AppRelease?> CheckAsync(string platform, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, LatestUrl);
        request.Headers.UserAgent.ParseAdd("FamilyHub");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = await http.SendAsync(request, token);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        var release = await response.Content.ReadFromJsonAsync<Release>(cancellationToken: token);
        if (release?.Tag is not { Length: > 1 } tag || tag[0] != 'v' || release.Assets is null)
            throw new InvalidDataException("GitHub returned invalid release information.");
        var version = tag[1..];
        var file = FileName(platform, version);
        if (file is null) return null;
        var asset = release.Assets.FirstOrDefault(asset => asset?.Name == file && asset.State == "uploaded");
        if (asset is null) return null;
        if (asset.Digest is not { Length: 71 } digest || !digest.StartsWith("sha256:", StringComparison.Ordinal) ||
            !ValidPackage(digest[7..], asset.Size))
            throw new InvalidDataException("GitHub returned invalid download information.");
        return new AppRelease(version, digest[7..], asset.Size, DownloadUrl(version, file));
    }

    public static bool ValidPackage(string? sha256, long size) =>
        size is > 0 and <= 262144000 && Regex.IsMatch(sha256 ?? "", "^[0-9a-f]{64}$");

    public static bool IsPublic(AppRelease release, string platform) =>
        FileName(platform, release.Version) is { } file && release.DownloadUrl == DownloadUrl(release.Version, file);

    public Task<HttpResponseMessage> OpenDownloadAsync(AppRelease release, string platform, CancellationToken token)
    {
        if (!IsPublic(release, platform)) throw new InvalidDataException("Invalid public update URL.");
        return http.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, token);
    }

    private static string DownloadUrl(string version, string file) => $"{HistoryUrl}/download/v{version}/{file}";

    private static string? FileName(string platform, string version)
    {
        if (!Version.TryParse(version, out var parsed) || parsed.Revision != -1 || parsed.Build < 0 ||
            parsed.ToString(3) != version) return null;
        return platform switch
        {
            "windows-x64" => $"FamilyHub-Music-Windows-{version}.zip",
            "android" => $"FamilyHub-Music-Android-{version}.apk",
            "ios" => $"FamilyHub-Music-iOS-{version}-unsigned.ipa",
            _ => null
        };
    }
}
