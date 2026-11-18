using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public sealed class OfflineLibrary
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Uri server;
    private readonly string user;
    private readonly Dictionary<string, (long Length, DateTime Written, DateTime Created, string Hash)> verified = [];
    private static readonly HashSet<string> Extensions = [".m4a", ".mp3", ".flac", ".wav", ".ogg", ".opus", ".webm", ".aac", ".mp4"];
    public string RootDirectory { get; }

    public OfflineLibrary(string storageRoot, Uri serverOrigin, string user)
    {
        server = FamilyHubApi.NormalizeOrigin(serverOrigin);
        if (string.IsNullOrWhiteSpace(user)) throw new ArgumentException("An account is required for device storage.");
        this.user = user.Trim();
        var accountKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(server.AbsoluteUri + "\n" + user.Trim()))).ToLowerInvariant();
        RootDirectory = Path.Combine(Path.GetFullPath(storageRoot), accountKey);
        Directory.CreateDirectory(RootDirectory);
    }

    public Task SaveLibraryAsync(IEnumerable<MusicTrack> tracks, CancellationToken cancellationToken = default) =>
        WriteJsonAsync("library.json", tracks.ToList(), cancellationToken);
    public Task<List<MusicTrack>> GetLibraryAsync(CancellationToken cancellationToken = default) =>
        ReadJsonAsync<List<MusicTrack>>("library.json", cancellationToken);
    public Task SavePlaylistsAsync(IEnumerable<MusicPlaylist> playlists, CancellationToken cancellationToken = default) =>
        WriteJsonAsync("playlists.json", playlists.ToList(), cancellationToken);
    public Task<List<MusicPlaylist>> GetPlaylistsAsync(CancellationToken cancellationToken = default) =>
        ReadJsonAsync<List<MusicPlaylist>>("playlists.json", cancellationToken);

    public void SavePlayback(PlaybackResume value)
    {
        if (!value.IsValid) throw new InvalidDataException("Invalid saved playback position.");
        var target = Path.Combine(RootDirectory, "playback.json");
        var temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(value, FamilyHubApi.JsonOptions)); File.Move(temporary, target, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public PlaybackResume? GetPlayback()
    {
        try
        {
            var value = JsonSerializer.Deserialize<PlaybackResume>(File.ReadAllText(Path.Combine(RootDirectory, "playback.json")), FamilyHubApi.JsonOptions);
            return value is { IsValid: true } ? value : null;
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException or UnauthorizedAccessException) { return null; }
    }

    public string? GetDownloadedPath(string trackId)
    {
        ValidateId(trackId);
        try
        {
            var metadata = Path.Combine(RootDirectory, FileKey(trackId) + ".download.json");
            if (!File.Exists(metadata)) return null;
            var track = JsonSerializer.Deserialize<MusicTrack>(File.ReadAllText(metadata), FamilyHubApi.JsonOptions);
            if (track is null || track.Id != trackId) return null;
            ValidateTrack(track);
            var path = AudioPath(track);
            if (!File.Exists(path) || new FileInfo(path).Length != track.DownloadSize) return null;
            return path;
        }
        catch (Exception error) when (error is IOException or JsonException or ArgumentException or InvalidDataException)
        {
            return null;
        }
    }

    public async Task<List<MusicTrack>> ListDownloadsAsync(CancellationToken cancellationToken = default)
    {
        var tracks = new List<MusicTrack>();
        foreach (var path in Directory.EnumerateFiles(RootDirectory, "*.download.json"))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var track = JsonSerializer.Deserialize<MusicTrack>(await File.ReadAllTextAsync(path, cancellationToken), FamilyHubApi.JsonOptions);
                if (track is not null && GetDownloadedPath(track.Id) is not null) tracks.Add(track);
            }
            catch (Exception error) when (error is IOException or JsonException or ArgumentException) { }
        }
        return tracks.OrderBy(t => t.Title, StringComparer.CurrentCultureIgnoreCase).ToList();
    }

    public async Task<long> GetDownloadedBytesAsync(CancellationToken cancellationToken = default) =>
        (await ListDownloadsAsync(cancellationToken)).Sum(t => t.DownloadSize);

    public async Task<string?> GetVerifiedDownloadedPathAsync(MusicTrack track, CancellationToken cancellationToken = default)
    {
        ValidateTrack(track);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var path = AudioPath(track);
            return await HasExpectedHashAsync(path, track, cancellationToken) ? path : null;
        }
        finally { gate.Release(); }
    }

    public async Task<string> DownloadAsync(MusicTrack track, FamilyHubApi api, CancellationToken cancellationToken = default,
        IProgress<DownloadProgress>? progress = null, OfflineLibrary? sourceCache = null, bool background = false)
    {
        ValidateTrack(track);
        if (api.ServerOrigin != server) throw new ArgumentException("The download belongs to a different server.");
        if (api.UserName is not null && api.UserName != user) throw new ArgumentException("The download belongs to a different account.");
        if (sourceCache is not null && (sourceCache.server != server || sourceCache.user != user || sourceCache == this))
            throw new ArgumentException("The source cache belongs to a different account or is the destination.");
        api.ResolveUri(track.DownloadUrl);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var final = AudioPath(track);
            if (await HasExpectedHashAsync(final, track, cancellationToken))
            {
                await WriteJsonAsync(FileKey(track.Id) + ".download.json", track, cancellationToken);
                RemoveSupersededAudio(track, final);
                progress?.Report(new(track.DownloadSize, track.DownloadSize));
                return final;
            }
            // Hash-specific partial files cannot be resumed into a newer recording of the same source.
            var part = Path.Combine(RootDirectory, FileKey(track.Id) + "." + track.DownloadSha256.ToLowerInvariant() + ".part");
            if (sourceCache is not null && await sourceCache.GetVerifiedDownloadedPathAsync(track, cancellationToken) is { } cached)
            {
                // The final checksum below also protects against changes during the copy.
                try
                {
                    await using var input = File.OpenRead(cached);
                    await using var output = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true);
                    await input.CopyToAsync(output, cancellationToken);
                }
                catch (FileNotFoundException) { /* Cache eviction won the race; use the resumable network path. */ }
            }
            var offset = File.Exists(part) ? new FileInfo(part).Length : 0;
            if (offset > track.DownloadSize) { File.Delete(part); offset = 0; }
            if (offset < track.DownloadSize)
            {
                using var response = await api.OpenDownloadAsync(track, offset, cancellationToken, background);
                await FamilyHubApi.EnsureSuccessAsync(response, cancellationToken);
                if (response.Content.Headers.ContentEncoding.Any()) throw new InvalidDataException("Encoded download responses cannot be resumed safely.");
                if (response.StatusCode == HttpStatusCode.PartialContent)
                {
                    var range = response.Content.Headers.ContentRange;
                    if (range is null || range.Unit != "bytes" || range.From != offset || range.Length != track.DownloadSize
                        || range.To != track.DownloadSize - 1)
                        throw new InvalidDataException("The server returned an unexpected download range.");
                }
                else if (response.StatusCode == HttpStatusCode.OK) offset = 0;
                else throw new InvalidDataException("The server did not return an audio download.");
                if (response.Content.Headers.ContentLength is { } length && length != track.DownloadSize - offset)
                    throw new InvalidDataException("The download length does not match the library metadata.");
                var received = offset;
                await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
                await using (var output = new FileStream(part, offset == 0 ? FileMode.Create : FileMode.Append, FileAccess.Write, FileShare.None, 65536, true))
                {
                    var buffer = new byte[65536];
                    int count;
                    while ((count = await input.ReadAsync(buffer, cancellationToken)) > 0)
                    {
                        if (received + count > track.DownloadSize) throw new InvalidDataException("The download exceeds its declared size.");
                        await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
                        received += count;
                        progress?.Report(new(received, track.DownloadSize));
                    }
                    await output.FlushAsync(cancellationToken);
                }
            }
            if (File.Exists(part) && new FileInfo(part).Length < track.DownloadSize)
                throw new EndOfStreamException("The audio download was interrupted. Download it again to resume.");
            if (!await HasExpectedHashAsync(part, track, cancellationToken))
            {
                File.Delete(part);
                throw new InvalidDataException("The audio download failed its size or SHA-256 check. Download it again.");
            }
            File.Move(part, final, true);
            verified.Remove(part);
            RememberVerified(final, track);
            await WriteJsonAsync(FileKey(track.Id) + ".download.json", track, cancellationToken);
            RemoveSupersededAudio(track, final);
            progress?.Report(new(track.DownloadSize, track.DownloadSize));
            return final;
        }
        finally { gate.Release(); }
    }

    public async Task RemoveDownloadAsync(string trackId, CancellationToken cancellationToken = default, Func<bool>? canRemove = null)
    {
        ValidateId(trackId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            // Recheck after queued downloads finish; a recording may have become active while waiting.
            if (canRemove is not null && !canRemove()) return;
            var key = FileKey(trackId);
            foreach (var path in Directory.EnumerateFiles(RootDirectory, key + ".*")) { File.Delete(path); verified.Remove(path); }
        }
        finally { gate.Release(); }
    }

    private string AudioPath(MusicTrack track) => Path.Combine(RootDirectory, FileKey(track.Id) + "." + track.DownloadSha256.ToLowerInvariant() + track.DownloadExtension.ToLowerInvariant());
    private void RemoveSupersededAudio(MusicTrack track, string currentPath)
    {
        var key = FileKey(track.Id);
        foreach (var path in Directory.EnumerateFiles(RootDirectory, key + ".*"))
        {
            if (path.Equals(currentPath, StringComparison.OrdinalIgnoreCase)
                || !Extensions.Contains(Path.GetExtension(path).ToLowerInvariant())
                || !Regex.IsMatch(Path.GetFileNameWithoutExtension(path), "^" + key + @"\.[a-f0-9]{64}$")) continue;
            // An actively playing Windows file may stay locked until the next download.
            try { File.Delete(path); verified.Remove(path); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
    // Source IDs are case-sensitive, including on Windows filesystems.
    private static string FileKey(string id) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant();
    private static void ValidateId(string id)
    {
        if (!Regex.IsMatch(id, "^(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})$")) throw new ArgumentException("Invalid recording identifier.");
    }
    private void ValidateTrack(MusicTrack track)
    {
        ValidateId(track.Id);
        if (!track.Saved || track.DownloadSize is <= 0 or > 2L * 1024 * 1024 * 1024
            || !Regex.IsMatch(track.DownloadSha256, "^[A-Fa-f0-9]{64}$")
            || !Extensions.Contains(track.DownloadExtension.ToLowerInvariant())
            || (track.DownloadUrl != "/api/library/" + track.Id + "/download"
                && !(Regex.IsMatch(track.PlaybackSourceSha256, "^[a-f0-9]{64}$")
                    && (track.DownloadUrl == $"/api/library/{track.Id}/playback/{track.PlaybackSourceSha256}/audio.m4a"
                        || new[] { "low", "normal", "high" }.Any(quality => track.DownloadUrl ==
                            $"/api/library/{track.Id}/playback/{track.PlaybackSourceSha256}/audio.m4a?quality={quality}")))))
            throw new InvalidDataException("This recording does not have valid saved-audio metadata.");
    }
    private async Task<bool> HasExpectedHashAsync(string path, MusicTrack track, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var info = new FileInfo(path);
        if (!info.Exists || info.Length != track.DownloadSize) { verified.Remove(path); return false; }
        var stamp = (info.Length, info.LastWriteTimeUtc, info.CreationTimeUtc, track.DownloadSha256.ToUpperInvariant());
        if (verified.TryGetValue(path, out var previous) && previous == stamp) return true;
        await using var input = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(input, cancellationToken);
        if (!Convert.ToHexString(hash).Equals(track.DownloadSha256, StringComparison.OrdinalIgnoreCase))
        { verified.Remove(path); return false; }
        verified[path] = stamp;
        return true;
    }
    private void RememberVerified(string path, MusicTrack track)
    { var info = new FileInfo(path); verified[path] = (info.Length, info.LastWriteTimeUtc, info.CreationTimeUtc, track.DownloadSha256.ToUpperInvariant()); }
    private async Task WriteJsonAsync<T>(string filename, T data, CancellationToken cancellationToken)
    {
        var destination = Path.Combine(RootDirectory, filename);
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(data, FamilyHubApi.JsonOptions), cancellationToken);
            File.Move(temporary, destination, true);
        }
        finally { File.Delete(temporary); }
    }
    private async Task<T> ReadJsonAsync<T>(string filename, CancellationToken cancellationToken) where T : new()
    {
        try
        {
            return JsonSerializer.Deserialize<T>(await File.ReadAllTextAsync(Path.Combine(RootDirectory, filename), cancellationToken), FamilyHubApi.JsonOptions) ?? new();
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException or JsonException) { return new(); }
    }
}
