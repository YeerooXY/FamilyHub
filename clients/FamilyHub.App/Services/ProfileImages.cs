using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public static class ProfileImages
{
    private const string Prefix = "data:image/jpeg;base64,";
    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    public static async Task<string?> GetAsync(MusicSession session, ListenerProfile profile, CancellationToken token = default)
    {
        if (string.IsNullOrWhiteSpace(profile.Id) || string.IsNullOrEmpty(profile.ImageSha256)
            || !Regex.IsMatch(profile.ImageSha256, "^[a-f0-9]{64}$")) return null;
        var owner = Hash(profile.Id);
        if (profile.ImageUrl != $"/api/profile-images/{owner}/{profile.ImageSha256}.jpg") return null;
        var server = session.Server;
        if (string.IsNullOrEmpty(server)) return null;
        var directory = Path.Combine(FileSystem.AppDataDirectory, "profile-images", Hash(server));
        var path = Path.Combine(directory, owner + "-" + profile.ImageSha256 + ".txt");
        try
        {
            if (File.Exists(path) && new FileInfo(path).Length <= 400000)
            {
                var cached = await File.ReadAllTextAsync(path, token);
                if (Valid(cached, profile.ImageSha256)) return cached;
            }
            var api = session.Api;
            if (api is null || (!session.Connected && !session.NeedsProfileSelection)) return null;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var image = await api.GetImageAsync(profile.ImageUrl, timeout.Token);
            if (session.Server != server || !Valid(image, profile.ImageSha256)) return null;
            Directory.CreateDirectory(directory);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await File.WriteAllTextAsync(temporary, image, token);
                File.Move(temporary, path, true);
            }
            finally { File.Delete(temporary); }
            return image;
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or HttpRequestException or FamilyHubApiException)
        { return null; }
    }

    private static bool Valid(string image, string digest)
    {
        if (image.Length > 400000 || !image.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        try
        {
            var bytes = Convert.FromBase64String(image[Prefix.Length..]);
            return bytes.Length is > 3 and <= 256 * 1024 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255
                && Convert.ToHexString(SHA256.HashData(bytes)).Equals(digest, StringComparison.OrdinalIgnoreCase);
        }
        catch (FormatException) { return false; }
    }
}
