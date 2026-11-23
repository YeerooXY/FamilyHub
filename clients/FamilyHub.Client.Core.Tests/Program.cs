using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FamilyHub.Client.Core;

var origin = new Uri("https://music.test:8444/");
var checks = 0;
void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
var shownSearch = new List<MusicTrack> { new() { Id = "first", Title = "First" } };
var originalSearchRow = shownSearch[0];
SearchPage.AppendNew(shownSearch, [new() { Id = "extra" }, new() { Id = "first" }, new() { Id = "extra" }]);
Check(shownSearch.Select(t => t.Id).SequenceEqual(["first", "extra"]), "Search enrichment appends unique rows without reordering");
Check(ReferenceEquals(shownSearch[0], originalSearchRow), "Search enrichment preserves existing row identity");
Check(JsonSerializer.Deserialize<SearchPage>("{}")!.Complete, "Older search responses default to complete");
Check(!JsonSerializer.Deserialize<SearchPage>("{\"complete\":false}")!.Complete, "Partial search response is recognized");
Check(JsonSerializer.Deserialize<DiscoveryItem>("{\"source_ids\":{\"album\":302127,\"track\":5}}")!.CoverUrl == "https://api.deezer.com/album/302127/image?size=big", "Discovery cards use the release's Deezer album cover");
Check(JsonSerializer.Deserialize<DiscoveryItem>("{\"cover\":\"https://cdn.test/c.jpg\",\"source_ids\":{\"album\":1}}")!.CoverUrl == "https://cdn.test/c.jpg", "A server cover address takes precedence");
Check(JsonSerializer.Deserialize<DiscoveryItem>("{\"cover\":\"http://private/c.jpg\"}")!.CoverUrl is null, "Discovery covers load only over HTTPS");
var discordSnapshot = new DiscordSnapshot("Song", "Artist - Topic", "Album", "abcdefghijk", true, 12, 100, false);
using (var activity = JsonDocument.Parse(JsonSerializer.Serialize(DiscordActivity.Build(discordSnapshot, 100000))))
{
    var root = activity.RootElement;
    Check(root.GetProperty("state").GetString() == "Artist", "Discord artist should remove Topic suffix");
    Check(root.GetProperty("timestamps").GetProperty("start").GetInt64() == 88000 && root.GetProperty("timestamps").GetProperty("end").GetInt64() == 188000, "Discord timestamps should reflect playback position");
    Check(root.GetProperty("assets").GetProperty("large_image").GetString() == "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg", "Discord cover should use YouTube ID");
}
var pausedDiscord = JsonSerializer.Serialize(DiscordActivity.Build(discordSnapshot with { Playing = false, RecordingId = "http://private-server/cover", Album = "ftp://private-server/album" }, 100000));
using (var paused = JsonDocument.Parse(pausedDiscord))
{
    Check(paused.RootElement.GetProperty("timestamps").ValueKind == JsonValueKind.Null, "Paused Discord activity must not have timestamps");
    Check(paused.RootElement.GetProperty("state").GetString() == "Paused · Artist", "Paused Discord activity must say paused");
    Check(paused.RootElement.GetProperty("assets").GetProperty("large_image").ValueKind == JsonValueKind.Null && !pausedDiscord.Contains("private-server"), "Discord activity must not expose private URLs");
}
var discordFrame = DiscordFrame.EncodeBytes(1, Encoding.UTF8.GetBytes("{}"));
Check(discordFrame.SequenceEqual(new byte[] { 1, 0, 0, 0, 2, 0, 0, 0, 123, 125 }), "Discord frame layout must use little-endian header");
async Task Throws<T>(Func<Task> action, string message) where T : Exception
{
    try { await action(); } catch (T) { checks++; return; }
    throw new Exception(message);
}
HttpResponseMessage Html(string text) => new(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, "text/html") };
HttpResponseMessage Json(string text) => new(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, "application/json") };

var loginRequests = new List<string>();
using (var api = new FamilyHubApi(origin, new Handler(async request =>
{
    loginRequests.Add(request.Method + " " + request.RequestUri!.PathAndQuery);
    Check(request.Headers.GetValues("Origin").Single() == "https://music.test:8444", "Origin header must match configured server");
    if (request.RequestUri.AbsolutePath == "/login" && request.Method == HttpMethod.Get)
    {
        var response = Html("<input value='login&amp;token' type='hidden' name='csrf_token'>");
        response.Headers.Add("Set-Cookie", "session=first; Secure; HttpOnly; Path=/");
        return response;
    }
    Check(request.Headers.GetValues("Cookie").Single().Contains("session="), "Session cookie was not replayed");
    if (request.RequestUri.AbsolutePath == "/login")
    {
        var form = await request.Content!.ReadAsStringAsync();
        Check(form.Contains("csrf_token=login%26token") && form.Contains("password=private-password"), "Login form is incorrect");
        var response = new HttpResponseMessage(HttpStatusCode.Found);
        response.Headers.Location = new Uri("/", UriKind.Relative);
        response.Headers.Add("Set-Cookie", "session=authenticated; Secure; HttpOnly; Path=/");
        return response;
    }
    if (request.RequestUri.AbsolutePath == "/") return Html("<meta content=\"api-token\" name=\"csrf-token\">");
    if (request.RequestUri.AbsolutePath == "/api/artwork/abcdefghijk")
    {
        Check(request.Headers.GetValues("Cookie").Single().Contains("authenticated"), "Artwork missed authenticated cookie");
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([255, 216, 255, 224]) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
        return response;
    }
    if (request.Method == HttpMethod.Post)
    {
        Check(request.Headers.GetValues("X-CSRFToken").Single() == "api-token", "Mutation missed CSRF token");
        return Json("{\"playlist\":{\"id\":\"1234567890123456789012\",\"name\":\"Music\",\"revision\":1,\"tracks\":[]}}");
    }
    return Json("{\"results\":[]}");
})))
{
    await api.LoginAsync("user", "private-password");
    Check(api.UserName == "user", "Signed-in identity was not recorded");
    Check((await api.GetLibraryAsync()).Count == 0, "Library DTO failed");
    Check((await api.CreatePlaylistAsync("Music")).Revision == 1, "Playlist mutation failed");
    Check(await api.GetArtworkAsync("abcdefghijk") == "data:image/jpeg;base64,/9j/4A==", "Artwork data URI failed");
    await Throws<ArgumentException>(() => api.GetArtworkAsync("../external"), "Artwork allowed path injection");
    var media = api.CreateMediaRequest("/api/library/abcdefghijk/download");
    Check(media.Uri.Host == "music.test" && media.Headers["Cookie"].Contains("authenticated"), "Media authentication failed");
    await Throws<ArgumentException>(() => Task.FromResult(api.CreateMediaRequest("https://evil.test/file")), "Media accepted external origin");
}

using (var api = new FamilyHubApi(origin, new Handler(async request =>
{
    if (request.RequestUri!.AbsolutePath == "/login") return request.Method == HttpMethod.Get ? Html("<input name='csrf_token' value='token'>") : Html("<meta name='csrf-token' content='token'>");
    if (request.RequestUri.AbsolutePath == "/") return Html("<meta name='csrf-token' content='token'>");
    if (request.Method == HttpMethod.Patch)
    {
        Check(request.RequestUri.AbsolutePath == "/api/playlists/1234567890123456789012", "Upload targeted another playlist");
        using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
        var mutation = document.RootElement;
        Check(mutation.GetProperty("owner_id").GetString() == "other-user" && mutation.GetProperty("revision").GetInt32() == 7
            && mutation.GetProperty("add_source_id").GetString() == "local-0123456789abcdef", "Uploaded song lost its playlist owner, revision or source");
        return Json("{\"playlist\":{\"id\":\"1234567890123456789012\",\"owner_id\":\"other-user\",\"revision\":8,\"tracks\":[{\"title\":\"Existing\"},{\"source_id\":\"local-0123456789abcdef\",\"added_at\":\"2026-11-17T12:00:00Z\"}]}}");
    }
    Check(request.Method == HttpMethod.Post && request.RequestUri.AbsolutePath == "/api/uploads", "Wrong upload route");
    Check(request.Headers.GetValues("X-CSRFToken").Single() == "token", "Upload missed CSRF");
    var upload = ((MultipartFormDataContent)request.Content!).First();
    if (upload.Headers.ContentLength == 134217729)
        return Json("{\"job\":{\"id\":\"large\",\"state\":\"queued\"}}");
    var body = await request.Content!.ReadAsStringAsync();
    Check(body.Contains("audio fixture") && body.Contains("read_tags") && body.Contains("true"), "Upload omitted audio or metadata mode");
    return Json("{\"job\":{\"id\":\"uploaded\",\"state\":\"done\",\"source_id\":\"local-0123456789abcdef\"}}");
})))
{
    await api.LoginAsync("user", "password");
    long received = 0;
    var uploadBytes = Encoding.UTF8.GetBytes("audio fixture");
    var response = await api.UploadAudioAsync(new MemoryStream(uploadBytes), uploadBytes.Length, "song.flac", "", "", "", new ImmediateProgress(p => received = p.Received));
    Check(received == uploadBytes.Length && response.GetProperty("job").GetProperty("id").GetString() == "uploaded", "Upload progress/result mismatch");
    var updated = await api.UpdatePlaylistAsync("1234567890123456789012", 7,
        new { add_source_id = response.GetProperty("job").GetProperty("source_id").GetString() }, ownerId: "other-user");
    Check(updated.Revision == 8 && updated.Tracks.Count == 2 && updated.Tracks[0].Title == "Existing"
        && updated.Tracks[1].AddedAt == "2026-11-17T12:00:00Z", "Upload append lost existing entries or the date added");
    Check(api.CreateMediaRequest("/api/library/local-0123456789abcdef/download").Uri.AbsolutePath.EndsWith("/download"), "Local media path rejected");
    Check(new PlaybackResume { TrackIds = ["local-0123456789abcdef"], Index = 0, Position = 10 }.IsValid, "Local recording resume rejected");
    var large = await api.UploadAudioAsync(new MemoryStream(), 134217729, "large.flac", "", "", "");
    Check(large.GetProperty("job").GetProperty("id").GetString() == "large", "The client rejected a large upload before the server could check it");
    await Throws<ArgumentException>(() => api.UploadAudioAsync(new MemoryStream(), 0, "empty.flac", "", "", ""), "Empty file accepted");
}

var relativeNow = DateTimeOffset.Parse("2026-11-15T12:00:00Z");
foreach (var (seconds, expected) in new (double, string)[] { (0,"Just now"), (59,"Just now"), (60,"1 minute ago"), (120,"2 minutes ago"), (3599,"59 minutes ago"), (3600,"1 hour ago"), (7200,"2 hours ago"), (86400,"1 day ago"), (172800,"2 days ago"), (604800,"1 week ago"), (1209600,"2 weeks ago"), (2592000,"1 month ago"), (5184000,"2 months ago"), (31536000,"1 year ago"), (63072000,"2 years ago"), (-3600,"Just now") })
    Check(RelativeDate.Describe(relativeNow.AddSeconds(-seconds), relativeNow) == expected, "Relative date boundary: " + seconds);
Check(RelativeDate.Describe((string?)null, relativeNow) == "" && RelativeDate.Describe("invalid", relativeNow) == "", "Unknown date must stay blank");
Check(RelativeDate.Exact("2026-11-14T12:00:00Z") is { Length: > 0 } && RelativeDate.Exact("invalid") is null, "Exact date tooltip missing/invalid");
var attributedPlaylist = JsonSerializer.Deserialize<MusicPlaylist>("{\"owner_id\":\"alex\",\"tracks\":[{\"title\":\"New\",\"added_by\":\"sam\"},{\"title\":\"Older\"}]}", FamilyHubApi.JsonOptions)!;
var cachedPlaylist = JsonSerializer.Deserialize<MusicPlaylist>(JsonSerializer.Serialize(attributedPlaylist, FamilyHubApi.JsonOptions), FamilyHubApi.JsonOptions)!;
Check(cachedPlaylist.Tracks[0].AddedBy == "sam" && cachedPlaylist.Tracks[1].AddedBy is null, "Playlist author attribution was lost in the device cache");

var workSnapshot = JsonSerializer.Deserialize<ServerStatistics>("{\"jobs\":[{\"owner\":\"alex\",\"kind\":\"playlist_download\",\"processed\":1,\"total\":4,\"remaining\":3,\"current_title\":\"Song\",\"files\":[{\"index\":2,\"title\":\"Song\",\"message\":\"Purifying audio\",\"download_bytes\":20,\"download_total_bytes\":40}]}]}", FamilyHubApi.JsonOptions)!;
Check(workSnapshot.Jobs[0].Owner == "alex" && workSnapshot.Jobs[0].Remaining == 3 && workSnapshot.Jobs[0].Files[0].DownloadTotalBytes == 40, "Server work lost requester, remaining count or file progress");
var recordSnapshot = JsonSerializer.Deserialize<ServerStatistics>("""{"workers":[{"id":"acquisition-0","title":"Acquisition / preparation 1","state":"working","current_title":"Song","progress":25.5,"waiting_for":""},{"id":"opus-background-0","state":"idle","waiting_for":"A recording"}],"records":[{"id":"streak-alex","title":"Longest listening streak","owner":"alex","user":"Alex","day":"2026-11-10","end_day":"2026-11-12","days":3},{"id":"family-day","day":"2026-11-12","seconds":3600.5}]}""", FamilyHubApi.JsonOptions)!;
Check(recordSnapshot.Workers[0].Id == "acquisition-0" && recordSnapshot.Workers[0].CurrentTitle == "Song" && recordSnapshot.Workers[0].Progress == 25.5 && recordSnapshot.Workers[1].Progress is null && recordSnapshot.Workers[1].WaitingFor == "A recording", "Worker slot identity, unknown progress or wait reason was lost");
Check(recordSnapshot.Records[0].Owner == "alex" && recordSnapshot.Records[0].EndDay == "2026-11-12" && recordSnapshot.Records[0].Days == 3 && recordSnapshot.Records[0].Seconds is null && recordSnapshot.Records[1].Seconds == 3600.5, "Listening record owner, date range or units were lost");

var redirectRequests = 0;
var profileRequests = 0;
using (var api = new FamilyHubApi(origin, new Handler(async request =>
{
    profileRequests++;
    if (request.RequestUri!.AbsolutePath == "/api/connect")
    {
        var response = Json("{\"family_profiles\":true,\"profiles\":[{\"id\":\"olduser\",\"name\":\"Alex\",\"color\":\"#abcdef\"}],\"csrf_token\":\"bootstrap\"}");
        response.Headers.Add("Set-Cookie", "session=profiles; Secure; HttpOnly; Path=/");
        return response;
    }
    Check(request.Headers.GetValues("Cookie").Single().Contains("session=profiles"), "Profile request omitted bootstrap cookie");
    if (request.RequestUri.AbsolutePath == "/api/profile/select")
    {
        Check(request.Headers.GetValues("X-CSRFToken").Single() == "bootstrap", "Profile selection omitted bootstrap CSRF");
        Check((await request.Content!.ReadAsStringAsync()).Contains("olduser"), "Profile identifier missing");
        return Json("{\"profile\":{\"id\":\"olduser\",\"name\":\"Alex\"},\"preferences\":{\"volume\":0.6,\"shuffle\":true},\"csrf_token\":\"selected\"}");
    }
    Check(request.Headers.GetValues("X-CSRFToken").Single() == "selected", "Profile CSRF did not rotate");
    if (request.RequestUri.AbsolutePath == "/api/profiles")
        return Json("{\"profile\":{\"id\":\"newprofile\",\"name\":\"Sam\",\"color\":\"#eeeeee\"}}");
    Check(request.Method == HttpMethod.Patch, "Preferences must use PATCH");
    var saved = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
    Check(saved.RootElement.GetProperty("volume_level").GetString() == "quiet", "Volume level missing from preference update");
    return Json("{\"preferences\":{\"volume\":0.25,\"shuffle\":false,\"volume_level\":\"quiet\"}}");
})))
{
    Check((await api.ConnectAsync()).Profiles.Single().Name == "Alex", "Family profile bootstrap failed");
    var selected = await api.SelectProfileAsync("olduser");
    Check(api.UserName == "olduser" && selected.Preferences.Volume == 0.6 && selected.Preferences.Shuffle, "Selected identity/preferences failed");
    var preferences = await api.SavePreferencesAsync(new() { Volume = 0.25, VolumeLevel = "quiet" });
    Check(preferences.Volume == 0.25 && preferences.VolumeLevel == "quiet", "Preference update failed");
    Check((await api.CreateProfileAsync("Sam")).Name == "Sam", "Profile creation failed");
    await Throws<ArgumentException>(() => api.SavePreferencesAsync(new() { Volume = double.NaN }), "Nonfinite volume accepted");
    await Throws<ArgumentException>(() => api.SavePreferencesAsync(new() { VolumeLevel = "invalid" }), "Invalid volume level accepted");
    Check(profileRequests == 4, "Invalid preferences reached server");
}
using (var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict)))))
    await Throws<InvalidOperationException>(() => api.ConnectAsync(), "Disabled family mode did not explain configuration");
foreach (var (status, guidance) in new[]
{
    (HttpStatusCode.Unauthorized, "Sign in"),
    (HttpStatusCode.Forbidden, "Check your access"),
    (HttpStatusCode.GatewayTimeout, "timed out"),
    (HttpStatusCode.ServiceUnavailable, "busy")
})
{
    using var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(status))));
    try { await api.GetLibraryAsync(); Check(false, "Failed request did not throw"); }
    catch (FamilyHubApiException ex)
    {
        Check(ex.StatusCode == (int)status && ex.Message.Contains(guidance) && !ex.Message.Contains("HTTP"), "Request error lacked recovery guidance");
    }
}
using (var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
    { Content = System.Net.Http.Json.JsonContent.Create(new { error = "HTTP/1.1 503 Service Unavailable" }) }))))
{
    try { await api.GetLibraryAsync(); Check(false, "Failed request did not throw"); }
    catch (FamilyHubApiException error)
    {
        Check(error.Message == "The server is busy. Wait a moment and try again.", "A raw response code reached the UI");
    }
}
using (var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
    { Content = new StringContent("<html>Unrelated server</html>") }))))
{
    try { await api.ConnectAsync(); Check(false, "Unrelated server was accepted"); }
    catch (InvalidDataException error) { Check(error.Message.Contains("address points to FamilyHub"), "Unrelated server exposed a parser error"); }
}
foreach (var detail in new[] { "Another playlist operation is running. Wait for it to finish.", "This playlist changed. Refresh it before editing." })
{
    using var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict)
        { Content = System.Net.Http.Json.JsonContent.Create(new { error = detail }) })));
    try { await api.RequestJsonAsync<JsonElement>(HttpMethod.Get, "/api/playlists"); Check(false, "Conflict did not throw"); }
    catch (FamilyHubApiException ex) { Check(ex.StatusCode == 409 && ex.Message == detail, "Conflict reason was replaced with a stale-playlist claim"); }
}
using (var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
    { Content = System.Net.Http.Json.JsonContent.Create(new { error = "YouTube is limiting searches right now. Try again in a moment." }) }))))
{
    try { await api.RequestJsonAsync<JsonElement>(HttpMethod.Post, "/api/search", new { query = "Artist" }); Check(false, "Unavailable search did not throw"); }
    catch (FamilyHubApiException ex) { Check(ex.StatusCode == 503 && ex.Message == "YouTube is limiting searches right now. Try again in a moment.", "Search limitation message was discarded"); }
}
foreach (var (status, recovery) in new[]
{
    (HttpStatusCode.Unauthorized, "Sign in"), (HttpStatusCode.Forbidden, "Check your access"),
    (HttpStatusCode.NotFound, "unavailable"), (HttpStatusCode.TooManyRequests, "Wait"),
    (HttpStatusCode.ServiceUnavailable, "busy"), (HttpStatusCode.GatewayTimeout, "timed out")
})
{
    using var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(status))));
    var release = new AppRelease("0.1.72", new string('a', 64), 12, "/api/app-updates/windows-x64/package");
    foreach (Func<Task> request in new Func<Task>[]
        { () => api.GetServerStatsAsync(), () => api.OpenAppUpdateAsync(release) })
    {
        try { await request(); Check(false, "Server refusal did not throw"); }
        catch (FamilyHubApiException ex)
        {
            Check(ex.StatusCode == (int)status && ex.Message.Contains(recovery) && !ex.Message.Contains("HTTP"),
                "Server refusal did not give a recovery instruction");
        }
    }
}
foreach (var (code, stale) in new[] { ("csrf", true), ("invalid", false) })
{
    using var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
        { Content = System.Net.Http.Json.JsonContent.Create(new { code, error = "Check your input." }) })));
    try { await api.GetLibraryAsync(); Check(false, "Bad request did not throw"); }
    catch (FamilyHubApiException ex)
    {
        Check(ex.StatusCode == 400 && ex.RequiresSignIn == stale
            && ex.Message.Contains(stale ? "Reconnect" : "Check your input"), "CSRF rejection was confused with another bad request");
    }
}
foreach (var body in new[] { "not json", "[]", "{\"error\":\"" + new string('x', 5000) + "\"}" })
{
    using var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict)
        { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") })));
    try { await api.RequestJsonAsync<JsonElement>(HttpMethod.Get, "/api/playlists"); Check(false, "Conflict did not throw"); }
    catch (FamilyHubApiException ex) { Check(ex.Message.Contains("current state") && !ex.Message.Contains("another device"), "Invalid error response did not use neutral fallback"); }
}
var sharedPlaylist = JsonSerializer.Deserialize<MusicPlaylist>("{\"id\":\"same\",\"owner_id\":\"other\",\"owner_name\":\"Sam\",\"shared\":true,\"can_edit\":false}")!;
Check(sharedPlaylist.OwnerId == "other" && sharedPlaylist.OwnerName == "Sam" && sharedPlaylist.Shared && !sharedPlaylist.CanEdit, "Shared playlist ownership was lost");
foreach (var (status, recovery) in new[] { (HttpStatusCode.Forbidden, "switch profiles"), (HttpStatusCode.GatewayTimeout, "Try again"),
    (HttpStatusCode.InsufficientStorage, "Free up space"), (HttpStatusCode.ServiceUnavailable, "try again") })
{
    using var api = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(status))));
    try { await api.GetLibraryAsync(); Check(false, "Failed request did not throw"); }
    catch (FamilyHubApiException ex)
    {
        Check(ex.StatusCode == (int)status && ex.Message.Contains(recovery) && !ex.Message.Contains("HTTP"),
            "Failed request did not explain how to recover");
    }
}

using (var api = new FamilyHubApi(origin, new Handler(request =>
{
    redirectRequests++;
    var response = new HttpResponseMessage(HttpStatusCode.Found);
    response.Headers.Location = new Uri("https://evil.test/collect");
    return Task.FromResult(response);
})))
{
    await Throws<ArgumentException>(() => api.GetLibraryAsync(), "Cross-origin redirect accepted");
    Check(redirectRequests == 1, "External destination received a request");
    await Throws<ArgumentException>(() => api.RequestJsonAsync<JsonElement>(HttpMethod.Get, "https://evil.test/api/library"), "External request accepted");
    Check(redirectRequests == 1, "Unvalidated destination received a request");
    await Throws<ArgumentException>(() => api.GetArtworkAsync("abcdefghijk"), "Artwork followed external redirect");
    Check(redirectRequests == 2, "Artwork leaked a request to external destination");
}
foreach (var (mime, bytes, length) in new (string, byte[], long?)[]
{
    ("image/svg+xml", Encoding.UTF8.GetBytes("<svg/>"), null),
    ("image/png", Encoding.UTF8.GetBytes("not a png"), null),
    ("image/jpeg", [255, 216, 255], 2097153),
    ("image/jpeg", new byte[2097153], null)
})
{
    using var artworkApi = new FamilyHubApi(origin, new Handler(_ =>
    {
        var content = new StreamContent(new MemoryStream(bytes));
        content.Headers.ContentType = new MediaTypeHeaderValue(mime);
        if (length.HasValue) content.Headers.ContentLength = length;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    }));
    await Throws<InvalidDataException>(() => artworkApi.GetArtworkAsync("abcdefghijk"), "Invalid or oversized artwork accepted");
}
await Throws<ArgumentException>(() => Task.FromResult(FamilyHubApi.NormalizeOrigin(new Uri("http://music.test/"))), "HTTP allowed");
await Throws<ArgumentException>(() => Task.FromResult(FamilyHubApi.NormalizeOrigin(new Uri("https://name:secret@music.test/"))), "Credentials in origin allowed");
var rockSeed = new MusicTrack { Title = "Numb", Channel = "Linkin Park", Genre = "Rock" };
Check(Similarity.Artist(new() { Title = "[Drum&Bass] - Muzzy - Endgame" }) == "muzz", "Muzzy alias or genre prefix failed");
Check(Similarity.RadioTitle(new() { Title = "BETON.HOFI - PÁNCZÉL (OFFICIAL AUDIO) [HD]" }) == "PÁNCZÉL", "Radio title retained upload tags or artist prefix");
Check(Similarity.RadioTitle(new() { Title = "Colors (Original Life is Strange Inspired Song)" }) == "Colors", "Radio title retained the upload description");
Check(Similarity.RadioTitle(new() { Title = "Artist – Song (Live) [Lyrics]" }) == "Song (Live)", "Radio title lost the performance name");
var valmar = new MusicTrack { Title = "VALMAR ft. Nemazalany & Sofi - Almatlan estek (Official Music Video)", Channel = "Uploader" };
Check(Similarity.Artist(valmar) == "valmar" && Similarity.RadioTitle(valmar) == "Almatlan estek",
    "Radio lookup retained featured credits or upload noise");
Check(!Similarity.IsRecommendation(new() { Title = "Muzzy - Endgame HQ (second half)" }, new() { Title = "[Drum&Bass] - MUZZ - Endgame", Channel = "MUZZ" }), "Same song entered autoplay under another upload");
Check(!Similarity.IsRecommendation(new() { Title = "Muzzy - Endgame" }, new() { Title = "Muzzy - Feeling Stronger (second half)" }), "Partial upload entered autoplay");
Check(Similarity.IsRecommendation(new() { Title = "Muzzy - Endgame" }, new() { Title = "MUZZ - Lost Forever" }), "Artist alias rejected a different song");
Check(!Similarity.IsRecommendation(new() { Title = "50 Cent - Wanksta", Genre = "Hip-hop" }, new() { Title = "Beton.Hofi - HELLO HELLO", Genre = "Hip-hop" }), "Broad genre accepted as recommendation");
Check(Similarity.IsRecommendation(new() { Title = "50 Cent - Wanksta", Genre = "Hip-hop" }, new() { Title = "In Da Club", Channel = "50 Cent", Genre = "Hip-hop" }), "Matching artist recommendation rejected");
Check(Similarity.IsSimilar(rockSeed, new() { Title = "Linkin Park - Faint", Channel = "Uploader", Genre = "Unsorted" }), "Same artist should work with unknown genre");
Check(Similarity.IsSimilar(rockSeed, new() { Title = "Bring Me To Life", Channel = "Evanescence", Genre = "Rock" }), "Matching known genre rejected");
Check(!Similarity.IsSimilar(rockSeed, new() { Title = "Barbie Girl", Channel = "Aqua", Genre = "Pop" }), "Pop song entered Rock mix");
Check(!Similarity.IsSimilar(rockSeed, new() { Title = "Unknown", Channel = "Other artist", Genre = "Unsorted" }), "Unknown artist filled mix");
Check(!Similarity.IsSimilar(rockSeed, new() { Title = "Other", Channel = "Linkin Park", Genre = "Pop" }), "Conflicting known genre accepted");

var data = Encoding.UTF8.GetBytes("audio fixture bytes for resume and verification");
var track = new MusicTrack { Id = "abcdefghijk", Title = "Song", Channel = "Artist", Saved = true,
    DownloadUrl = "/api/library/abcdefghijk/download", DownloadExtension = ".m4a", DownloadSize = data.Length,
    DownloadSha256 = Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant() };
var folder = Path.Combine(Path.GetTempPath(), "familyhub-core-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(folder);
try
{
    var library = new OfflineLibrary(folder, origin, "user");
    var calls = 0;
    using var api = new FamilyHubApi(origin, new Handler(request =>
    {
        calls++;
        Check(request.RequestUri!.AbsolutePath == track.DownloadUrl, "Unexpected download URL");
        if (calls == 1)
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new InterruptedStream(data, 9)) };
            response.Content.Headers.ContentLength = data.Length;
            return Task.FromResult(response);
        }
        Check(request.Headers.Range!.Ranges.Single().From == 9, "Download did not resume at persisted byte offset");
        Check(request.Headers.IfRange!.EntityTag!.Tag == '"' + track.DownloadSha256 + '"', "Resume missed If-Range hash");
        var complete = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(data[9..]) };
        complete.Content.Headers.ContentRange = new ContentRangeHeaderValue(9, data.Length - 1, data.Length);
        return Task.FromResult(complete);
    }));
    await Throws<IOException>(() => library.DownloadAsync(track, api), "Interrupted response succeeded");
    Check(library.GetDownloadedPath(track.Id) is null, "Partial file marked downloaded");
    Check((await library.ListDownloadsAsync()).Count == 0, "Partial leaked into downloaded library");
    var file = await library.DownloadAsync(track, api);
    var superseded = Path.Combine(library.RootDirectory,
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(track.Id))).ToLowerInvariant()
        + "." + new string('a', 64) + ".flac");
    File.WriteAllText(superseded, "previous server edition");
    using (var noNetwork = new FamilyHubApi(origin, new Handler(_ => throw new Exception("Warm cache contacted server"))))
        Check(await library.DownloadAsync(track, noNetwork) == file, "Warm download did not reuse finished edition");
    Check(!File.Exists(superseded), "Superseded audio retained after verified replacement");
    Check(File.Exists(file), "Superseded cleanup deleted current edition");
    Check(File.ReadAllBytes(file).SequenceEqual(data), "Downloaded bytes differ");
    Check(await library.GetVerifiedDownloadedPathAsync(track) == file, "Verified warm cache was missed");
    Check(library.GetDownloadedTrack(track.Id) == track, "Single recording metadata lookup changed the downloaded track");
    var otherTrack = track with { Id = "zzzzzzzzzzz", DownloadUrl = "/api/library/zzzzzzzzzzz/download" };
    var transferStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseTransfer = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
    using (var slow = new FamilyHubApi(origin, new Handler(_ =>
    {
        transferStarted.SetResult();
        return releaseTransfer.Task;
    })))
    {
        var download = library.DownloadAsync(otherTrack, slow);
        try
        {
            await transferStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Check(await library.GetVerifiedDownloadedPathAsync(track).WaitAsync(TimeSpan.FromSeconds(5)) == file,
                "A cached recording waited for another song to download");
            Check(await library.GetVerifiedDownloadedPathAsync(otherTrack).WaitAsync(TimeSpan.FromSeconds(5)) is null,
                "In-progress download appeared as a verified file");
            Check(library.GetDownloadedTrack(otherTrack.Id) is null, "In-progress download appeared in the metadata lookup");
        }
        finally
        {
            releaseTransfer.SetResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(data) });
            await download;
        }
    }
    await library.RemoveDownloadAsync(otherTrack.Id);
    await library.RemoveDownloadAsync(track.Id, canRemove: () => false);
    Check(File.Exists(file), "Pinned playback file was removed");
    Check(await library.GetVerifiedDownloadedPathAsync(track with { DownloadSha256 = new string('0', 64) }) is null,
        "Changed server hash reused previous recording");
    using (var cancelledLookup = new CancellationTokenSource())
    {
        cancelledLookup.Cancel();
        await Throws<OperationCanceledException>(() => library.GetVerifiedDownloadedPathAsync(track, cancelledLookup.Token), "Warm cache ignored cancellation");
    }
    File.WriteAllBytes(file, new byte[data.Length]);
    File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(2));
    Check(await library.GetVerifiedDownloadedPathAsync(track) is null, "Changed cached file bypassed SHA verification");
    Check(await new OfflineLibrary(folder, origin, "user").GetVerifiedDownloadedPathAsync(track) is null, "Restart trusted corrupted cached file");
    File.WriteAllBytes(file, data);
    Check(await library.GetVerifiedDownloadedPathAsync(track) == file, "Repaired cached file failed verification");
    Check((await library.ListDownloadsAsync()).Single() == track, "Downloaded metadata differs");
    Check(await library.GetDownloadedBytesAsync() == data.Length, "Download storage count differs");
    await library.SaveLibraryAsync([track]);
    var playlist = new MusicPlaylist { Id = "1234567890123456789012", Name = "Offline", Revision = 2,
        Tracks = [new PlaylistTrack { Title = track.Title, SourceId = track.Id }, new PlaylistTrack { Title = track.Title, SourceId = track.Id }] };
    await library.SavePlaylistsAsync([playlist]);
    var restarted = new OfflineLibrary(folder, origin, "user");
    Check(restarted.GetDownloadedPath(track.Id) == file, "Offline restart lost downloaded file");
    Check((await restarted.GetLibraryAsync()).Single() == track, "Offline restart lost library");
    Check((await restarted.GetPlaylistsAsync()).Single().Tracks.Count == 2, "Offline playlist lost duplicate occurrence");
    using (var disconnected = new FamilyHubApi(origin, new Handler(_ => throw new IOException("Server unreachable"))))
        Check(await restarted.DownloadAsync(track, disconnected) == file, "Completed download contacted network");
    Check(new OfflineLibrary(folder, origin, "other").GetDownloadedPath(track.Id) is null, "Account data leaked");
    Check(new OfflineLibrary(folder, new Uri("https://other.test/"), "user").GetDownloadedPath(track.Id) is null, "Server data leaked");
    Check(!Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories).Where(p => p.EndsWith(".json")).Any(p => File.ReadAllText(p).Contains("private-password")), "Credentials persisted to cache");
    await restarted.RemoveDownloadAsync(track.Id);
    Check(restarted.GetDownloadedPath(track.Id) is null && !File.Exists(file), "Remove left downloaded audio");

    using (var bad = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[data.Length]) }))))
        await Throws<InvalidDataException>(() => restarted.DownloadAsync(track, bad), "Wrong hash accepted");
    Check(restarted.GetDownloadedPath(track.Id) is null, "Hash failure published audio");
    Check(!Directory.EnumerateFiles(restarted.RootDirectory, "*.part").Any(), "Corrupt partial retained for repeated hash failures");
    await Throws<InvalidDataException>(() => restarted.DownloadAsync(track with { DownloadUrl = "https://evil.test/file" }, api), "External media URL accepted");
    foreach (var quality in new[] { "low", "normal", "high" })
    {
        var tier = track with { PlaybackSourceSha256 = track.DownloadSha256,
            DownloadUrl = $"/api/library/{track.Id}/playback/{track.DownloadSha256}/audio.m4a?quality={quality}" };
        var tierLibrary = new OfflineLibrary(Path.Combine(folder, quality), origin, "user");
        using var tierApi = new FamilyHubApi(origin, new Handler(request =>
        {
            Check(request.RequestUri!.PathAndQuery == tier.DownloadUrl, "Download lost quality query");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(data) });
        }));
        var tierPath = await tierLibrary.DownloadAsync(tier, tierApi);
        Check(File.ReadAllBytes(tierPath).SequenceEqual(data), "Quality download changed bytes");
        await Throws<InvalidDataException>(() => tierLibrary.DownloadAsync(tier with { DownloadUrl = tier.DownloadUrl + "&redirect=external" }, tierApi), "Unexpected query accepted");
        await Throws<InvalidDataException>(() => tierLibrary.DownloadAsync(tier with { DownloadUrl = tier.DownloadUrl.Replace(quality, "invalid") }, tierApi), "Unknown quality accepted");
    }
    await Throws<ArgumentException>(() => restarted.DownloadAsync(track with { Id = "../outside" }, api), "Unsafe file identifier accepted");
    await Throws<InvalidDataException>(() => restarted.DownloadAsync(track with { DownloadExtension = "/../bad" }, api), "Unsafe extension accepted");

    var partial = Path.Combine(restarted.RootDirectory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(track.Id))).ToLowerInvariant() + "." + track.DownloadSha256 + ".part");
    File.WriteAllBytes(partial, data[..9]);
    using (var wrongRange = new FamilyHubApi(origin, new Handler(_ =>
    {
        var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(data) };
        response.Content.Headers.ContentRange = new ContentRangeHeaderValue(0, data.Length - 1, data.Length);
        return Task.FromResult(response);
    }))) await Throws<InvalidDataException>(() => restarted.DownloadAsync(track, wrongRange), "Incorrect response range accepted");
    Check(File.ReadAllBytes(partial).SequenceEqual(data[..9]), "Invalid response altered partial bytes");
    using (var ignoredRange = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(data) }))))
    {
        Check(File.ReadAllBytes(await restarted.DownloadAsync(track, ignoredRange)).SequenceEqual(data), "200 restart did not replace partial");
        var upper = track with { Id = track.Id.ToUpperInvariant(), DownloadUrl = "/api/library/" + track.Id.ToUpperInvariant() + "/download" };
        var upperPath = await restarted.DownloadAsync(upper, ignoredRange);
        Check(upperPath != restarted.GetDownloadedPath(track.Id), "Case-sensitive source IDs collided on disk");
        Check((await restarted.ListDownloadsAsync()).Count == 2, "Case-sensitive source ID lost an entry");
    }
    await restarted.RemoveDownloadAsync(track.Id);
    using var cancellation = new CancellationTokenSource();
    using (var cancelled = new FamilyHubApi(origin, new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StreamContent(new InterruptedStream(data, 9)) }))))
        await Throws<OperationCanceledException>(() => restarted.DownloadAsync(track, cancelled, cancellation.Token,
            new ImmediateProgress(_ => cancellation.Cancel())), "Cancellation was ignored");
    Check(File.ReadAllBytes(partial).SequenceEqual(data[..9]) && restarted.GetDownloadedPath(track.Id) is null,
        "Cancellation lost resumable bytes or published incomplete audio");
}
finally { Directory.Delete(folder, true); }
{
    var patches = new List<JsonElement>();
    using var api = new FamilyHubApi(origin, new Handler(async request =>
    {
        using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
        patches.Add(document.RootElement.Clone());
        return Json("{\"preferences\":{\"volume\":1,\"spotify_subscribed\":true}}");
    }));
    await api.SavePreferencesAsync(new ListenerPreferences { SpotifySubscribed = false });
    Check(!patches[0].TryGetProperty("spotify_subscribed", out _), "Changing volume overwrote another device's Spotify answer");
    await api.SaveSpotifyStatusAsync(false);
    Check(patches[1].EnumerateObject().Count() == 1 && !patches[1].GetProperty("spotify_subscribed").GetBoolean(), "Spotify answer changed unrelated playback preferences");
}
{
    using var api = new FamilyHubApi(origin, new Handler(async request =>
    {
        using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
        var data = document.RootElement;
        Check(data.GetProperty("owner_id").GetString() == "other-user" && data.GetProperty("remove_index").GetInt32() == 2 && data.GetProperty("revision").GetInt32() == 7, "Co-author edit lost the playlist owner or revision");
        return Json("{\"playlist\":{\"id\":\"1234567890123456789012\",\"owner_id\":\"other-user\",\"revision\":8}}");
    }));
    await api.UpdatePlaylistAsync("1234567890123456789012", 7, new { remove_index = 2 }, ownerId: "other-user");
}
{
    using var api = new FamilyHubApi(origin, new Handler(async request =>
    {
        using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
        var track = document.RootElement.GetProperty("track");
        Check(track.GetProperty("title").GetString() == "Current song" && track.EnumerateObject().Count() == 3, "Activity metadata omitted the title or sent unrelated download data");
        return Json("{\"ok\":true}");
    }));
    await api.ReportPlaybackActivityAsync(new string('a', 32), true, track: new MusicTrack { Id = "abcdefghijk", Title = "Current song", Channel = "Artist", DownloadSha256 = new string('b', 64) });
}
{
    var now = DateTimeOffset.UtcNow; var pending = new PendingSessionPoke("target", "server|me", now.AddMinutes(2));
    Check(pending.IsCurrent("server|me", false, now), "Poke did not wait for a session");
    Check(!pending.IsCurrent("other|me", false, now) && !pending.IsCurrent("server|me", true, now) && !pending.IsCurrent("server|me", false, now.AddMinutes(2)), "Poke crossed accounts, replaced a session or outlived expiry");
    Check(pending.Find([new ListeningRoom { Id = "wrong", HostUser = "other" }, new ListeningRoom { Id = "right", HostUser = "target" }])?.Id == "right", "Poke joined the wrong host");
}
checks += await HistoryChecks.RunAsync();
checks += ListeningChecks.Run();
checks += PlaylistSongChecks.Run();
checks += await SessionChecks.RunAsync();
checks += await EditionChecks.RunAsync();
checks += await PlaybackFlowChecks.RunAsync();
checks += await ProfileImageChecks.RunAsync();
var quickLibrary = new List<MusicTrack>
{
    new() { Id = "favorite", Title = "Favorite", Channel = "Artist A", Genre = "Electronic" },
    new() { Id = "related", Title = "Related", Channel = "Artist A", Genre = "Electronic" },
    new() { Id = "other", Title = "Other", Channel = "Artist B", Genre = "Rock" }
};
Check(QuickPlay.Queue([], []).Count == 0, "Quick play empty library");
Check(QuickPlay.Queue(quickLibrary.Concat(quickLibrary), []).Count == 3, "Quick play duplicated recordings");
var randomQuickPlay = new Random(42);
var relatedStarts = 0;
for (var run = 0; run < 500; run++)
{
    var queue = QuickPlay.Queue(quickLibrary, Enumerable.Repeat("favorite", 10).ToList(), randomQuickPlay);
    Check(queue[0].Id != "favorite" && queue.Select(t => t.Id).Distinct().Count() == 3, "Quick play repeated the last song or lost a recording");
    if (queue[0].Id == "related") relatedStarts++;
}
Check(relatedStarts > 450, "Quick play did not favor listening preferences");
Check(QuickPlay.Queue(quickLibrary, ["removed-recording"]).Count == 3, "Quick play failed with deleted history");
using (var updates = new FamilyHubApi(origin, new Handler(request => Task.FromResult(Json("{\"version\":\"0.1.2\",\"sha256\":\"abc\",\"size\":123,\"download_url\":\"/api/app-updates/windows-x64/abc\"}")))))
{
    var release = await updates.GetAppReleaseAsync("windows-x64");
    Check(release.Version == "0.1.2" && release.DownloadUrl == "/api/app-updates/windows-x64/abc", "App update metadata did not deserialize");
    await Throws<ArgumentException>(() => updates.OpenAppUpdateAsync(release with { DownloadUrl = "https://other.test/package.zip" }), "App updates escaped server origin");
}
var package = Encoding.UTF8.GetBytes("local verified update package");
var packageHash = Convert.ToHexStringLower(SHA256.HashData(package));
var publishedUpdate = new AppRelease("1.2.3", packageHash, package.Length,
    PublicAppReleases.HistoryUrl + "/download/v1.2.3/FamilyHub-Music-Windows-1.2.3.zip");
var mirrorUpdate = publishedUpdate with { DownloadUrl = $"/api/app-updates/windows-x64/{packageHash}" };
var releaseJson = JsonSerializer.Serialize(new
{
    tag_name = "v1.2.3", assets = new[] { new { name = "FamilyHub-Music-Windows-1.2.3.zip", state = "uploaded",
        digest = "sha256:" + packageHash, size = package.Length } }
});
using (var http = new HttpClient(new Handler(_ => Task.FromResult(Json(releaseJson)))))
{
    var releases = new PublicAppReleases(http);
    await releases.RequireInstallableAsync(mirrorUpdate, "windows-x64", new Version(1, 2, 2), default);
    await Throws<InvalidDataException>(() => releases.RequireInstallableAsync(mirrorUpdate with { Version = "9.9.9" },
        "windows-x64", new Version(1, 2, 2), default), "A mirror cannot invent a newer release");
    await Throws<InvalidDataException>(() => releases.RequireInstallableAsync(publishedUpdate,
        "windows-x64", new Version(1, 2, 4), default), "An installed app cannot downgrade");
}
Check(!PublicAppReleases.MatchesMirror(publishedUpdate, mirrorUpdate with { Size = 1 }, "windows-x64"), "Mirror size must match GitHub");
Check(!PublicAppReleases.MatchesMirror(publishedUpdate, mirrorUpdate with { Sha256 = new string('a', 64) }, "windows-x64"), "Mirror digest must match GitHub");
foreach (var redirect in new[] { "http://release-assets.githubusercontent.com/package", "https://untrusted.test/package" })
{
    var requests = 0;
    using var http = new HttpClient(new Handler(_ =>
    {
        requests++;
        var response = new HttpResponseMessage(HttpStatusCode.Redirect);
        response.Headers.Location = new Uri(redirect);
        return Task.FromResult(response);
    }));
    await Throws<InvalidDataException>(() => new PublicAppReleases(http).OpenDownloadAsync(publishedUpdate, "windows-x64", default), "Update redirect escaped trusted HTTPS hosts");
    Check(requests == 1, "Untrusted update redirect was followed");
}
using (var http = new HttpClient(new Handler(request =>
{
    if (request.RequestUri!.Host != "github.com") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(package) });
    var response = new HttpResponseMessage(HttpStatusCode.Redirect);
    response.Headers.Location = new Uri("https://release-assets.githubusercontent.com/package");
    return Task.FromResult(response);
})))
using (var response = await new PublicAppReleases(http).OpenDownloadAsync(publishedUpdate, "windows-x64", default))
using (var saved = new MemoryStream())
{
    await PublicAppReleases.WriteVerifiedPackageAsync(response, saved, publishedUpdate, _ => { }, default);
    Check(saved.ToArray().SequenceEqual(package), "Official package did not pass digest and length verification");
}
using (var altered = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[package.Length]) })
    await Throws<InvalidDataException>(() => PublicAppReleases.WriteVerifiedPackageAsync(altered, Stream.Null, publishedUpdate, _ => { }, default),
        "A replaced package of the same size failed to trigger an integrity error");

var downloadDirectory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(downloadDirectory);
try
{
    File.WriteAllText(Path.Combine(downloadDirectory, "report.txt"), "original");
    using var first = new StringContent("first");
    using var second = new StringContent("second");
    var paths = await Task.WhenAll(FileDownload.SaveNewAsync(downloadDirectory, "report.txt", first, default),
        FileDownload.SaveNewAsync(downloadDirectory, "report.txt", second, default));
    Check(paths[0] != paths[1] && paths.All(File.Exists) && File.ReadAllText(Path.Combine(downloadDirectory, "report.txt")) == "original",
        "Concurrent file downloads must save separate copies and preserve existing files");
    using var invalid = new StringContent("unused");
    foreach (var item in new[] { "../report.txt", "CON.txt", "-name" })
        await Throws<IOException>(() => FileDownload.SaveNewAsync(downloadDirectory, item, invalid, default), "Unsafe file download name was accepted");
}
finally { Directory.Delete(downloadDirectory, true); }

Console.WriteLine($"PASS: {checks} checks for sessions, CSRF, origin boundaries, verified resume, offline restart, playlists, account isolation and update trust.");

sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request);
}

sealed class InterruptedStream(byte[] data, int prefix) : Stream
{
    private bool read;
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (read) throw new IOException("Interrupted fixture connection");
        read = true; data.AsMemory(0, prefix).CopyTo(buffer); return ValueTask.FromResult(prefix);
    }
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

sealed class ImmediateProgress(Action<DownloadProgress> report) : IProgress<DownloadProgress>
{
    public void Report(DownloadProgress value) => report(value);
}

