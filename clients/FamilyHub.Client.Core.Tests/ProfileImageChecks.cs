using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;

internal static class ProfileImageChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var bytes = new byte[] { 255, 216, 255, 1, 2, 3 };
        var owner = Hash(Encoding.UTF8.GetBytes("alex"));
        var digest = Hash(bytes);
        var profile = new ListenerProfile { Id = "alex", Name = "Alex", Color = "#abcdef",
            ImageSha256 = digest, ImageUrl = $"/api/profile-images/{owner}/{digest}.jpg" };
        var imageRequests = 0;
        var reachable = true;
        var mime = "image/jpeg";
        FamilyHubApi Api(Uri origin) => new(origin, new Handler(request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/connect")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(
                    JsonSerializer.Serialize(new { family_profiles = true, profiles = new[] { profile }, csrf_token = "boot" }, FamilyHubApi.JsonOptions), Encoding.UTF8, "application/json") });
            imageRequests++;
            if (!reachable) throw new HttpRequestException("Unavailable");
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
            response.Content.Headers.ContentType = new MediaTypeHeaderValue(mime);
            return Task.FromResult(response);
        }));
        var session = new MusicSession(Api);
        try
        {
            await session.ConnectServerAsync("https://profile-pictures.test");
            Check(session.NeedsProfileSelection, "Profile image fixture should be at the chooser");
            Check(await ProfileImages.GetAsync(session, profile with { ImageSha256 = null! }) is null, "Null image digest did not fall back");
            Check(await ProfileImages.GetAsync(session, profile with { Id = null! }) is null, "Null profile ID did not fall back");
            Check(await ProfileImages.GetAsync(session, profile with { ImageUrl = "https://evil.test/picture.jpg" }) is null && imageRequests == 0,
                "Avatar metadata escaped its expected server route");
            var image = await ProfileImages.GetAsync(session, profile);
            Check(image == "data:image/jpeg;base64," + Convert.ToBase64String(bytes) && imageRequests == 1,
                "Profile chooser did not fetch verified picture before selecting a profile");
            reachable = false;
            Check(await ProfileImages.GetAsync(session, profile) == image && imageRequests == 1, "Cached avatar required a network request");
            var root = Path.Combine(FileSystem.AppDataDirectory, "profile-images", Hash(Encoding.UTF8.GetBytes(session.Server)));
            var cache = Path.Combine(root, owner + "-" + digest + ".txt");
            await File.WriteAllTextAsync(cache, "data:image/jpeg;base64," + Convert.ToBase64String(new byte[] { 255, 216, 255, 99 }));
            Check(await ProfileImages.GetAsync(session, profile) is null, "Tampered avatar cache was accepted");
            reachable = true; mime = "text/html";
            Check(await ProfileImages.GetAsync(session, profile) is null, "Unexpected avatar MIME caused a render failure or was accepted");
            mime = "image/jpeg";
            Check(await ProfileImages.GetAsync(session, profile with { ImageSha256 = new string('a', 64), ImageUrl = $"/api/profile-images/{owner}/{new string('a', 64)}.jpg" }) is null,
                "Avatar response did not match its declared SHA-256");
            await ProfileImages.GetAsync(session, profile);
            reachable = false;
            await session.ConnectServerAsync("https://other-profile-pictures.test");
            Check(await ProfileImages.GetAsync(session, profile) is null, "Avatar cache leaked across server origins");
        }
        finally
        {
            session.Api?.Dispose();
            var fixture = Path.GetFullPath(FileSystem.AppDataDirectory);
            var temporaryRoot = Path.GetFullPath(Path.GetTempPath());
            if (!fixture.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(fixture).StartsWith("familyhub-session-tests-", StringComparison.Ordinal))
                throw new InvalidOperationException("Refusing to remove a directory outside this test fixture.");
            if (Directory.Exists(fixture)) Directory.Delete(fixture, true);
        }
        return checks;
    }
}
