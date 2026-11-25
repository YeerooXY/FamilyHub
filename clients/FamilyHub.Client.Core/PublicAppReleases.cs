using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public sealed class PublicAppReleases(HttpClient http)
{
    public const string HistoryUrl = "https://github.com/YeerooXY/FamilyHub/releases";
    private const string LatestUrl = "https://api.github.com/repos/YeerooXY/FamilyHub/releases/latest";

    private sealed record Release([property: JsonPropertyName("tag_name")] string Tag, Asset[] Assets);
    private sealed record Asset(string Name, string State, long Size, string? Digest);
    private sealed record ReleaseNotes([property: JsonPropertyName("tag_name")] string Tag, string? Body);

    public const int MaxNotes = 5;
    public const int MaxNoteLength = 110;

    /// <summary>The bullet lines of the GitHub release notes for one version, for the update screen. Empty when unavailable.</summary>
    public async Task<IReadOnlyList<string>> NotesAsync(string version, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, LatestUrl);
        request.Headers.UserAgent.ParseAdd("FamilyHub");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = await http.SendAsync(request, token);
        if (!response.IsSuccessStatusCode) return [];
        var release = await response.Content.ReadFromJsonAsync<ReleaseNotes>(cancellationToken: token);
        return release?.Tag == "v" + version ? ParseNotes(release.Body) : [];
    }

    /// <summary>Bullet lines only ("- " or "* "), without markdown marks or links, at most five and 110 characters each.</summary>
    public static IReadOnlyList<string> ParseNotes(string? body)
    {
        var notes = new List<string>();
        foreach (var raw in (body ?? "").Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length < 3 || (line[0] != '-' && line[0] != '*') || line[1] != ' ') continue;
            line = Regex.Replace(line[2..], @"\[([^\]]*)\]\([^)]*\)", "$1");
            line = Regex.Replace(line, @"[`*_]|<[^>]*>", "");
            line = Regex.Replace(line, @"\s+", " ").Trim();
            if (line.Length == 0) continue;
            if (line.Length > MaxNoteLength) line = line[..(line.LastIndexOf(' ', MaxNoteLength - 1) is > 40 and var cut ? cut : MaxNoteLength - 1)].TrimEnd(' ', ',', ';', ':') + "…";
            notes.Add(line);
            if (notes.Count == MaxNotes) break;
        }
        return notes;
    }

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

    public static bool MatchesMirror(AppRelease published, AppRelease mirrored, string platform) =>
        IsPublic(published, platform) && ValidPackage(published.Sha256, published.Size) &&
        mirrored.Version == published.Version && mirrored.Sha256 == published.Sha256 && mirrored.Size == published.Size &&
        mirrored.DownloadUrl == $"/api/app-updates/{platform}/{published.Sha256}";

    public async Task RequireInstallableAsync(AppRelease release, string platform, Version installed, CancellationToken token)
    {
        if (!Version.TryParse(release.Version, out var version) || version <= installed)
            throw new InvalidDataException("This update must be newer than the installed version.");
        var published = await CheckAsync(platform, token);
        if (published is null || (release != published && (platform != "windows-x64" || !MatchesMirror(published, release, platform))))
            throw new InvalidDataException("This update does not match the official GitHub release.");
    }

    public async Task<HttpResponseMessage> OpenDownloadAsync(AppRelease release, string platform, CancellationToken token)
    {
        if (!IsPublic(release, platform)) throw new InvalidDataException("Invalid public update URL.");
        var uri = new Uri(release.DownloadUrl);
        for (var hops = 0; hops < 4; hops++)
        {
            var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, token);
            if ((int)response.StatusCode is not (301 or 302 or 303 or 307 or 308)) return response;
            using (response)
            {
                if (response.Headers.Location is not { } location || !Uri.TryCreate(uri, location, out var next) ||
                    next.Scheme != Uri.UriSchemeHttps || !next.IsDefaultPort || next.UserInfo.Length != 0 ||
                    next.Host is not ("release-assets.githubusercontent.com" or "objects.githubusercontent.com" or "github-releases.githubusercontent.com"))
                    throw new InvalidDataException("GitHub returned an invalid update download redirect.");
                uri = next;
            }
        }
        throw new InvalidDataException("GitHub redirected the update download too many times.");
    }

    public static async Task WriteVerifiedPackageAsync(HttpResponseMessage response, Stream output, AppRelease release,
        Action<int> progress, CancellationToken token)
    {
        response.EnsureSuccessStatusCode();
        if (!ValidPackage(release.Sha256, release.Size) ||
            response.Content.Headers.ContentLength is long size && size != release.Size)
            throw new InvalidDataException("The update download has an unexpected size.");
        await using var input = await response.Content.ReadAsStreamAsync(token);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long received = 0;
        var lastPercent = -1;
        int count;
        while ((count = await input.ReadAsync(buffer, token)) != 0)
        {
            received += count;
            if (received > release.Size) throw new InvalidDataException("The update exceeds its published size.");
            hash.AppendData(buffer.AsSpan(0, count));
            await output.WriteAsync(buffer.AsMemory(0, count), token);
            var percent = (int)(100 * received / release.Size);
            if (percent != lastPercent) { progress(percent); lastPercent = percent; }
        }
        if (received != release.Size || Convert.ToHexStringLower(hash.GetHashAndReset()) != release.Sha256)
            throw new InvalidDataException("The update failed its integrity check. Try downloading it again.");
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
