using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public sealed class FamilyHubApi : IDisposable
{
    private readonly HttpClient http;
    private CookieContainer cookies = new();
    private string? csrf;
    public Uri ServerOrigin { get; }
    public string? UserName { get; private set; }
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public FamilyHubApi(Uri server) : this(server, DefaultHandler()) { }

    // Cookies are kept here, from Set-Cookie headers. On iOS HttpClientHandler wraps NSURLSession, which handles
    // Set-Cookie itself and leaves the session cookie out of the response, so the server never sees its CSRF
    // session again. The managed handler (as on Windows) passes every header through.
    private static HttpMessageHandler DefaultHandler()
    {
        const System.Net.DecompressionMethods compression = System.Net.DecompressionMethods.GZip | System.Net.DecompressionMethods.Brotli;
        if (OperatingSystem.IsIOS() || OperatingSystem.IsMacCatalyst())
            return new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, AutomaticDecompression = compression };
        return new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, AutomaticDecompression = compression };
    }

    // Supplied handlers must not follow redirects: each destination is checked before sending credentials.
    public FamilyHubApi(Uri server, HttpMessageHandler handler)
    {
        ServerOrigin = NormalizeOrigin(server);
        http = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(10) };
    }

    public static Uri NormalizeOrigin(Uri server)
    {
        if (!server.IsAbsoluteUri || server.Scheme != Uri.UriSchemeHttps || server.UserInfo.Length != 0
            || server.AbsolutePath != "/" || server.Query.Length != 0 || server.Fragment.Length != 0)
            throw new ArgumentException("Enter an HTTPS server address without a path, credentials, query or fragment.");
        return new Uri(server.GetLeftPart(UriPartial.Authority) + "/");
    }

    public Uri ResolveUri(string path)
    {
        if (!Uri.TryCreate(ServerOrigin, path, out var uri) || uri.Scheme != ServerOrigin.Scheme
            || uri.Host != ServerOrigin.Host || uri.Port != ServerOrigin.Port || uri.UserInfo.Length != 0)
            throw new ArgumentException("The request must stay on the configured FamilyHub server.");
        return uri;
    }

    public async Task LoginAsync(string user, string password, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(user) || user.Length > 64 || string.IsNullOrEmpty(password) || password.Length > 256)
            throw new ArgumentException("Enter a username and password.");
        cookies = new CookieContainer(); csrf = null; UserName = null;
        using var loginPage = await SendAsync(HttpMethod.Get, "/login", null, cancellationToken);
        await EnsureSuccessAsync(loginPage, cancellationToken);
        var loginToken = FindHtmlAttribute(await loginPage.Content.ReadAsStringAsync(cancellationToken), "input", "name", "csrf_token", "value");
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["username"] = user, ["password"] = password, ["remember"] = "1", ["csrf_token"] = loginToken
        });
        using var login = await SendAsync(HttpMethod.Post, "/login", form, cancellationToken);
        await EnsureSuccessAsync(login, cancellationToken);
        using var home = await SendAsync(HttpMethod.Get, "/", null, cancellationToken);
        await EnsureSuccessAsync(home, cancellationToken);
        csrf = FindHtmlAttribute(await home.Content.ReadAsStringAsync(cancellationToken), "meta", "name", "csrf-token", "content");
        UserName = user.Trim();
    }

    public Task<ServerStatistics> GetServerStatsAsync(CancellationToken cancellationToken = default) =>
        RequestJsonAsync<ServerStatistics>(HttpMethod.Get, "/api/server/stats", cancellationToken: cancellationToken);

    public Task<ActivityReceipt> ReportPlaybackActivityAsync(string deviceId, bool playing, CancellationToken cancellationToken = default, IReadOnlyList<ListeningCounter>? counters = null, string? counterDeviceId = null, MusicTrack? track = null, string? deviceName = null, string? deviceKind = null, double? position = null, long activation = 0, long sequence = 0, bool followingHost = false, string remoteDeviceId = "") =>
        RequestJsonAsync<ActivityReceipt>(HttpMethod.Post, "/api/playback/activity", new { device_id = deviceId, playing, counters, counter_device_id = counterDeviceId, track = track is null ? null : new { id = track.Id, title = track.Title, channel = track.Channel },
            device_info = deviceName is null ? null : new { name = deviceName, kind = deviceKind, activation, sequence, following_host = followingHost, remote_device = remoteDeviceId }, position }, cancellationToken);

    public Task<PlaybackDevicesResponse> GetPlaybackDevicesAsync(string deviceId, CancellationToken cancellationToken = default) =>
        RequestJsonAsync<PlaybackDevicesResponse>(HttpMethod.Get, "/api/playback/devices?device_id=" + Uri.EscapeDataString(deviceId), cancellationToken: cancellationToken);

    public Task ControlPlaybackAsync(string fromDevice, string toDevice, string action, double? position = null, CancellationToken cancellationToken = default) =>
        RequestJsonAsync<System.Text.Json.JsonElement>(HttpMethod.Post, "/api/playback/control", new { from = fromDevice, to = toDevice, action, position }, cancellationToken);

    public Task<PlaybackTransferReceipt> TransferPlaybackAsync(string fromDevice, string toDevice, PlaybackResume resume, bool playing, CancellationToken cancellationToken = default) =>
        RequestJsonAsync<PlaybackTransferReceipt>(HttpMethod.Post, "/api/playback/transfer", new { from = fromDevice, to = toDevice, resume, playing }, cancellationToken);

    public async Task<List<MusicTrack>> GetLibraryAsync(CancellationToken cancellationToken = default) =>
        (await RequestJsonAsync<LibraryResponse>(HttpMethod.Get, "/api/library", null, cancellationToken)).Results;

    // Background refreshes: null when the list has not changed since this connection last read it.
    public async Task<List<MusicTrack>?> GetLibraryIfChangedAsync(CancellationToken cancellationToken = default) =>
        (await GetIfChangedAsync<LibraryResponse>("/api/library", cancellationToken))?.Results;

    public async Task<List<MusicPlaylist>?> GetPlaylistsIfChangedAsync(CancellationToken cancellationToken = default) =>
        (await GetIfChangedAsync<PlaylistsResponse>("/api/playlists", cancellationToken))?.Playlists;

    private readonly Dictionary<string, string> listTags = [];
    private async Task<T?> GetIfChangedAsync<T>(string path, CancellationToken cancellationToken) where T : class
    {
        string? tag;
        lock (listTags) listTags.TryGetValue(path, out tag);
        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken, ifNoneMatch: tag);
        if (response.StatusCode == System.Net.HttpStatusCode.NotModified && tag is not null) return null;
        await EnsureSuccessAsync(response, cancellationToken);
        var value = await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken)
            ?? throw new InvalidDataException("The server returned no data.");
        lock (listTags)
        {
            if (response.Headers.ETag is { } etag) listTags[path] = etag.ToString();
            else listTags.Remove(path);
        }
        return value;
    }

    public Task LegacyLoginAsync(string user, string password, CancellationToken cancellationToken = default) => LoginAsync(user, password, cancellationToken);

    public async Task<ProfileConnection> ConnectAsync(CancellationToken cancellationToken = default)
    {
        ProfileConnection result;
        try { result = await RequestJsonAsync<ProfileConnection>(HttpMethod.Get, "/api/connect", cancellationToken: cancellationToken); }
        catch (FamilyHubApiException error) when (error.StatusCode is 404 or 409)
        { throw new InvalidOperationException("Family profiles are unavailable on this server. Check the server address and enable family profile mode on the server.", error); }
        if (!result.FamilyProfiles || string.IsNullOrWhiteSpace(result.CsrfToken))
            throw new InvalidDataException("This server does not support family profiles.");
        csrf = result.CsrfToken;
        return result;
    }

    public async Task<ProfileSelection> SelectProfileAsync(string id, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 64) throw new ArgumentException("Choose a profile.");
        var result = await RequestJsonAsync<ProfileSelection>(HttpMethod.Post, "/api/profile/select", new { profile_id = id }, cancellationToken);
        if (result.Profile.Id != id || string.IsNullOrWhiteSpace(result.CsrfToken))
            throw new InvalidDataException("The server returned an invalid profile selection.");
        csrf = result.CsrfToken;
        UserName = id;
        return result;
    }

    public async Task<ListenerProfile> CreateProfileAsync(string name, CancellationToken cancellationToken = default) =>
        (await RequestJsonAsync<ProfileResponse>(HttpMethod.Post, "/api/profiles", new { name }, cancellationToken)).Profile;

    public async Task<ListenerPreferences> GetPreferencesAsync(CancellationToken cancellationToken = default) =>
        (await RequestJsonAsync<PreferencesResponse>(HttpMethod.Get, "/api/profile/preferences", cancellationToken: cancellationToken)).Preferences;

    public async Task<ListenerPreferences> SaveSpotifyStatusAsync(bool subscribed, CancellationToken cancellationToken = default) =>
        (await RequestJsonAsync<PreferencesResponse>(HttpMethod.Patch, "/api/profile/preferences", new { spotify_subscribed = subscribed }, cancellationToken)).Preferences;

    public async Task<ListenerPreferences> SavePreferencesAsync(ListenerPreferences preferences, CancellationToken cancellationToken = default)
    {
        if (!double.IsFinite(preferences.Volume) || preferences.Volume is < 0 or > 1) throw new ArgumentException("Volume must be between zero and one.");
        if (preferences.VolumeLevel is not ("loud" or "normal" or "quiet")) throw new ArgumentException("Choose Loud, Normal or Quiet volume level.");
        return (await RequestJsonAsync<PreferencesResponse>(HttpMethod.Patch, "/api/profile/preferences", new { volume_level = preferences.VolumeLevel, volume = preferences.Volume, shuffle = preferences.Shuffle, auto_dj = preferences.AutoDj, crossfade_seconds = preferences.CrossfadeSeconds, repeat_mode = preferences.RepeatMode }, cancellationToken)).Preferences;
    }

    public async Task<List<MusicPlaylist>> GetPlaylistsAsync(CancellationToken cancellationToken = default) =>
        (await RequestJsonAsync<PlaylistsResponse>(HttpMethod.Get, "/api/playlists", null, cancellationToken)).Playlists;

    public async Task<MusicPlaylist> CreatePlaylistAsync(string name, CancellationToken cancellationToken = default) =>
        (await RequestJsonAsync<PlaylistResponse>(HttpMethod.Post, "/api/playlists", new { name }, cancellationToken)).Playlist;

    public async Task<MusicPlaylist> UpdatePlaylistAsync(string id, int revision, object mutation, CancellationToken cancellationToken = default, string? ownerId = null)
    {
        var body = JsonSerializer.SerializeToElement(mutation, JsonOptions).EnumerateObject()
            .ToDictionary(p => p.Name, p => (object?)p.Value);
        body["revision"] = revision;
        if (!string.IsNullOrEmpty(ownerId)) body["owner_id"] = ownerId;
        return (await RequestJsonAsync<PlaylistResponse>(HttpMethod.Patch, PlaylistPath(id), body, cancellationToken)).Playlist;
    }

    public async Task DeletePlaylistAsync(string id, int revision, string ownerId, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Delete, PlaylistPath(id), JsonContent.Create(new { revision, owner_id = ownerId }), cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task<T> RequestJsonAsync<T>(HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(method, path, body is null ? null : JsonContent.Create(body, options: JsonOptions), cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken)
            ?? throw new InvalidDataException("The server returned no data.");
    }

    public async Task<JsonElement> UploadAudioAsync(Stream file, long size, string filename, string title, string artist, string album, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        if (size is <= 0 or > 134217728) throw new ArgumentException("Choose an audio file smaller than 128 MB.");
        using var form = new MultipartFormDataContent();
        form.Add(new AudioUploadContent(file, size, progress), "file", Path.GetFileName(filename));
        form.Add(new StringContent("true"), "read_tags");
        form.Add(new StringContent(title), "title"); form.Add(new StringContent(artist), "artist"); form.Add(new StringContent(album), "album");
        using var response = await SendAsync(HttpMethod.Post, "/api/uploads", form, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<JsonElement>(JsonOptions, cancellationToken);
    }

    public Task<HttpResponseMessage> OpenDownloadAsync(MusicTrack track, long offset, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Get, track.DownloadUrl, null, cancellationToken, offset, track.DownloadSha256);

    public Task<AppRelease> GetAppReleaseAsync(string platform, CancellationToken cancellationToken = default) =>
        RequestJsonAsync<AppRelease>(HttpMethod.Get, "/api/app-updates/" + Uri.EscapeDataString(platform), cancellationToken: cancellationToken);

    public Task<HttpResponseMessage> OpenAppUpdateAsync(AppRelease release, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Get, release.DownloadUrl, null, cancellationToken);

    public Task<SongLyrics> GetLyricsAsync(string id, CancellationToken cancellationToken = default)
    {
        if (!Regex.IsMatch(id, "^(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})$")) throw new ArgumentException("Invalid recording identifier.");
        return RequestJsonAsync<SongLyrics>(HttpMethod.Get, "/api/library/" + id + "/lyrics", cancellationToken: cancellationToken);
    }

    public async Task<string> GetArtworkAsync(string id, CancellationToken cancellationToken = default)
    {
        if (!Regex.IsMatch(id, "^[A-Za-z0-9_-]{11}$")) throw new ArgumentException("Invalid recording identifier.");
        return await GetImageAsync("/api/artwork/" + id, cancellationToken);
    }

    public async Task<string> GetImageAsync(string path, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        var mime = response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant();
        const int maximum = 2 * 1024 * 1024;
        if (mime is not ("image/jpeg" or "image/png" or "image/webp") || response.Content.Headers.ContentLength > maximum)
            throw new InvalidDataException("The server returned unsupported artwork.");
        using var output = new MemoryStream();
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        var buffer = new byte[8192];
        int count;
        while ((count = await input.ReadAsync(buffer, cancellationToken)) != 0)
        {
            if (output.Length + count > maximum) throw new InvalidDataException("Artwork exceeds the size limit.");
            output.Write(buffer, 0, count);
        }
        var bytes = output.ToArray();
        var valid = mime switch
        {
            "image/jpeg" => bytes.Length >= 3 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255,
            "image/png" => bytes.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }),
            "image/webp" => bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8),
            _ => false
        };
        if (!valid) throw new InvalidDataException("The server returned invalid artwork.");
        return "data:" + mime + ";base64," + Convert.ToBase64String(bytes);
    }

    public (Uri Uri, IReadOnlyDictionary<string, string> Headers) CreateMediaRequest(string path)
    {
        if (!Regex.IsMatch(path, "^/api/library/(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})/download$"))
            throw new ArgumentException("Media must use a saved FamilyHub recording.");
        var uri = ResolveUri(path);
        var header = cookies.GetCookieHeader(uri);
        return (uri, header.Length == 0 ? new Dictionary<string, string>() : new Dictionary<string, string> { ["Cookie"] = header });
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, HttpContent? content,
        CancellationToken cancellationToken, long rangeStart = 0, string? etag = null, string? ifNoneMatch = null)
    {
        var uri = ResolveUri(path);
        for (var redirects = 0; redirects < 6; redirects++)
        {
            using var request = new HttpRequestMessage(method, uri) { Content = content };
            request.Headers.Add("Origin", ServerOrigin.GetLeftPart(UriPartial.Authority));
            var cookieHeader = cookies.GetCookieHeader(uri);
            if (cookieHeader.Length > 0) request.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
            if (method != HttpMethod.Get && method != HttpMethod.Head && csrf is not null)
                request.Headers.Add("X-CSRFToken", csrf);
            if (ifNoneMatch is not null) request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
            if (rangeStart > 0)
            {
                request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(rangeStart, null);
                request.Headers.IfRange = new System.Net.Http.Headers.RangeConditionHeaderValue(new System.Net.Http.Headers.EntityTagHeaderValue('"' + etag + '"'));
            }
            var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.RequestMessage?.RequestUri is { } actual) ResolveUri(actual.AbsoluteUri);
            if (response.Headers.TryGetValues("Set-Cookie", out var setCookies))
                foreach (var cookie in setCookies) cookies.SetCookies(uri, cookie);
            if ((int)response.StatusCode is not (301 or 302 or 303 or 307 or 308)) return response;
            var location = response.Headers.Location;
            response.Dispose();
            if (location is null) throw new InvalidDataException("The server returned a redirect without a destination.");
            uri = ResolveUri(new Uri(uri, location).AbsoluteUri);
            if (method != HttpMethod.Get && method != HttpMethod.Head)
            {
                // Login's successful POST redirects to the home page. Other write redirects are refused.
                if (path != "/login" || (int)response.StatusCode is not (301 or 302 or 303))
                    throw new InvalidDataException("The server redirected a write request.");
                method = HttpMethod.Get; content = null;
            }
        }
        throw new InvalidDataException("The server redirected too many times.");
    }

    internal static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var message = response.StatusCode switch
        {
            HttpStatusCode.Unauthorized => "Sign in to the server again. Your device downloads remain available.",
            HttpStatusCode.Conflict => "The request conflicts with the server's current state. Try again.",
            _ => $"The server returned HTTP {(int)response.StatusCode}."
        };
        if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Conflict or HttpStatusCode.RequestEntityTooLarge or HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable && response.Content.Headers.ContentType?.MediaType == "application/json")
        {
            try
            {
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
                var buffer = new byte[4097];
                var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, cancellationToken);
                if (length < buffer.Length)
                {
                    using var body = JsonDocument.Parse(buffer.AsMemory(0, length));
                    if (body.RootElement.ValueKind == JsonValueKind.Object && body.RootElement.TryGetProperty("error", out var error)
                        && error.ValueKind == JsonValueKind.String && error.GetString() is { Length: > 0 and <= 512 } detail
                        && !detail.Any(char.IsControl)) message = detail;
                }
            }
            catch (JsonException) { }
            catch (IOException) { }
        }
        throw new FamilyHubApiException(message, (int)response.StatusCode);
    }

    private static string FindHtmlAttribute(string html, string tag, string key, string expected, string attribute)
    {
        foreach (Match element in Regex.Matches(html, "<" + tag + "\\b[^>]*>", RegexOptions.IgnoreCase))
        {
            var attrs = Regex.Matches(element.Value, "([\\w-]+)\\s*=\\s*([\"'])(.*?)\\2", RegexOptions.Singleline)
                .ToDictionary(m => m.Groups[1].Value.ToLowerInvariant(), m => WebUtility.HtmlDecode(m.Groups[3].Value));
            if (attrs.GetValueOrDefault(key) == expected && attrs.TryGetValue(attribute, out var value) && value.Length > 0)
                return value;
        }
        throw new InvalidDataException("The server did not return a FamilyHub sign-in token.");
    }

    private static string PlaylistPath(string id) => Regex.IsMatch(id, "^[A-Za-z0-9]{22}$")
        ? "/api/playlists/" + id : throw new ArgumentException("Invalid playlist identifier.");

    public void Dispose() => http.Dispose();
    private sealed record LibraryResponse(List<MusicTrack> Results);
    private sealed record PlaylistsResponse(List<MusicPlaylist> Playlists);
    private sealed record PlaylistResponse(MusicPlaylist Playlist);
    private sealed record ProfileResponse(ListenerProfile Profile);
    private sealed record PreferencesResponse(ListenerPreferences Preferences);
}
