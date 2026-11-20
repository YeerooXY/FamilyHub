using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public sealed class MusicSession
{
    private readonly Func<Uri, FamilyHubApi> createApi;
    public MusicSession() : this(origin => new FamilyHubApi(origin)) { }
    internal MusicSession(Func<Uri, FamilyHubApi> createApi) => this.createApi = createApi;
    public event Action? Changed;
    public FamilyHubApi? Api { get; private set; }
    public OfflineLibrary? Offline { get; private set; }
    public string Server { get; private set; } = "";
    public string User { get; private set; } = "";
    public string ProfileName { get; private set; } = "";
    public List<ListenerProfile> Profiles { get; private set; } = [];
    public bool NeedsProfileSelection { get; private set; }
    public ListenerPreferences PlaybackPreferences { get; private set; } = new();
    public bool Connected { get; private set; }
    public bool UiActive { get; set; } = true;
    public int IdleHeartbeatSeconds { get; set; } = 5;
    public bool HandoffPending { get; set; }
    public bool Ready { get; private set; }
    public string Message { get; private set; } = "";
    public string MessageLevel { get; private set; } = "info";
    public long MessageRevision { get; private set; }
    public bool PlaybackMessage { get; private set; }
    private List<MusicTrack> library = [];
    private Dictionary<string, MusicTrack> libraryById = [];
    public List<MusicTrack> Library { get => library; private set { library = value; libraryById = value.DistinctBy(t => t.Id).ToDictionary(t => t.Id); } }
    private List<MusicTrack> downloads = [];
    private Dictionary<string, MusicTrack> downloadsById = [];
    public List<MusicTrack> Downloads { get => downloads; private set { downloads = value; downloadsById = value.DistinctBy(t => t.Id).ToDictionary(t => t.Id); } }
    public List<MusicPlaylist> Playlists { get; private set; } = [];
    public DownloadProgress? Progress { get; private set; }
    public event Action? DownloadProgressChanged;
    public string? DownloadingId { get; private set; }
    public string DownloadStatus { get; private set; } = "";
    public (string TrackId, string Message)? DownloadFailure { get; private set; }
    private System.Collections.Immutable.ImmutableHashSet<string> pendingDeviceDownloads = [];
    public bool WaitingForDeviceDownload(MusicTrack track) => pendingDeviceDownloads.Contains(track.Id);
    public long DownloadedBytes { get; private set; }
    private MusicTrack[] cachedTracks = [];
    private long cachedBytes;
    private Dictionary<string, HashSet<string>> cachedHashes = [];
    private readonly SemaphoreSlim artworkLoading = new(4, 4);
    public List<MusicTrack> DeviceTracks => Downloads.Concat(Volatile.Read(ref cachedTracks))
        .Where(OnThisDevice).DistinctBy(t => t.Id).OrderBy(t => t.Title, StringComparer.CurrentCultureIgnoreCase).ToList();
    public long DeviceBytes => DownloadedBytes + Interlocked.Read(ref cachedBytes);
    public bool KeptOnDevice(MusicTrack track) => downloadsById.ContainsKey(track.Id);
    private CancellationTokenSource? downloadCancellation;
    private readonly SemaphoreSlim connectionLock = new(1, 1);
    private int accountVersion;
    private readonly Dictionary<string, OfflineLibrary> playbackCaches = [];
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> cachedEditions = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, MusicTrack> playbackRecords = new();
    public string StreamingQualityWifi { get; private set; } = "high";
    public string StreamingQualityMobile { get; private set; } = "high";
    public string DownloadQuality { get; private set; } = "max";
    public string ActiveStreamingQuality => HomeConnection ? StreamingQualityWifi : StreamingQualityMobile;
    public int CacheLimitGb { get; private set; } = 3;
    public bool DownloadsWifiOnly { get; private set; } = true;
    internal bool CanWarmPlayback { get; set; }
    private static bool HomeConnection => Microsoft.Maui.Networking.Connectivity.Current.ConnectionProfiles.Any(
        p => p is Microsoft.Maui.Networking.ConnectionProfile.WiFi or Microsoft.Maui.Networking.ConnectionProfile.Ethernet)
        && !Microsoft.Maui.Networking.Connectivity.Current.ConnectionProfiles.Contains(Microsoft.Maui.Networking.ConnectionProfile.Cellular);
    public void SetCacheLimit(int gigabytes)
    {
        if (gigabytes is not (1 or 3 or 5 or 10)) throw new ArgumentOutOfRangeException(nameof(gigabytes));
        CacheLimitGb = gigabytes;
        Preferences.Default.Set(PreferenceKey(Server, User) + ":cache-gb", gigabytes.ToString());
        _ = PrunePlaybackCacheAsync(playbackCaches.Values.ToArray(), accountVersion);
        Changed?.Invoke();
    }
    public void SetDownloadsWifiOnly(bool value)
    {
        DownloadsWifiOnly = value;
        Preferences.Default.Set(PreferenceKey(Server, User) + ":downloads-wifi", value ? "true" : "false");
        if (value && !HomeConnection) CancelDownload();
        Changed?.Invoke();
    }
    private string? playingCacheId;
    private string? preparingCacheId;
    private string? upcomingCacheId, preparingNextCacheId;
    private readonly SemaphoreSlim cacheMaintenance = new(1, 1);
    private const string ConfigurationKey = "familyhub:connection:v1";

    private readonly string activityDevice = Guid.NewGuid().ToString("N");
    private ListeningJournal? listeningJournal;
    private MusicTrack? activityTrack;
    public void ObserveListening(MusicTrack? track, int index, double position, bool playing)
    {
        activityTrack = track;
        if (!PlaybackPreferences.ListeningHistoryPaused) listeningJournal?.Observe(track?.Id, index, position, playing);
        else listeningJournal?.InvalidateBaseline();
    }
    public void InvalidateListeningBaseline() => listeningJournal?.InvalidateBaseline();
    public void FlushListening() => listeningJournal?.Flush();
    private sealed record Activity(bool Playing, double? Position, bool FollowingHost, string RemoteDeviceId,
        bool Background, string? Status, double? Duration, MusicTrack? Track, bool Force);
    private long lastActivity;
    private bool lastActivityPlaying, activityInFlight;
    private Activity? pendingActivity;
    private TaskCompletionSource? pendingActivityCompletion;
    private string lastActivityTrackId = "";
    private string? lastActivityStatus;
    private double? lastActivityDuration;
    private string lastActivityRemoteDevice = "";
    private bool lastActivityFollowingHost;
    private FamilyHubApi? lastActivityApi;
    private long activitySequence, activationWatermark, lastActivityActivation;
    private long? playbackEpoch, localPlaybackEpoch;
    private long queueRevision, sentQueueRevision;
    private string[] queueIds = [];
    private IReadOnlyList<MusicTrack>? observedQueue;
    private string[]? sentQueueIds;
    private (bool? Shuffle, string? RepeatMode, bool? Autoplay) queueModes, sentQueueModes;
    private int sentQueueStart;
    private bool compactQueue = true;
    private int activityQueueIndex = -1;
    private readonly HashSet<string> pendingAcks = [];
    public long PlaybackActivation { get; private set; }
    public void MarkLocalPlayback()
    {
        localPlaybackEpoch = playbackEpoch ?? 0;
        PlaybackActivation = Math.Max(DateTime.UtcNow.Ticks, Math.Max(PlaybackActivation, activationWatermark) + 1);
    }
    /// <summary>This app's id in "Connect to a device"; new on every start, like the activity device.</summary>
    public string DeviceId => activityDevice;
    public static string DeviceName => DeviceInfo.Current.Platform == DevicePlatform.WinUI ? Environment.MachineName : DeviceInfo.Current.Name is { Length: > 0 } name ? name : DeviceInfo.Current.Model;
    public static string DeviceKind => DeviceInfo.Current.Platform == DevicePlatform.WinUI ? "windows" : DeviceInfo.Current.Platform == DevicePlatform.Android ? "android"
        : DeviceInfo.Current.Platform == DevicePlatform.MacCatalyst ? "mac" : DeviceInfo.Current.Idiom == DeviceIdiom.Tablet ? "ipad" : DeviceInfo.Current.Platform == DevicePlatform.iOS ? "iphone" : "other";
    /// <summary>Raised for playback transfers and another device becoming active.</summary>
    public event Action<PlaybackHandover>? PlaybackHandedOver;
    /// <summary>Raised for each play/pause/next/previous/seek the controlling device sends.</summary>
    public event Action<PlaybackControl>? RemoteControlReceived;
    public event Func<Task>? PlaybackCheckInRequested;
    // Keep delivered handover IDs after acknowledgement so a retained command cannot restart playback.
    private readonly HashSet<string> handovers = [], controlsSeen = [];
    public Task RequestPlaybackCheckInAsync() => PlaybackCheckInRequested?.Invoke() ?? Task.CompletedTask;
    public bool HasReceivedPlaybackCommand(string id) { lock (handovers) return handovers.Contains(id); }
    private bool RememberPlaybackCommand(string id) { lock (handovers) return handovers.Add(id); }
    public void RetryPauseCommand(string id) { lock (handovers) handovers.Remove(id); }
    public bool IsCurrentPlaybackCommand(PlaybackHandover command) => command.Epoch is null || command.Epoch == playbackEpoch;
    public void AcknowledgePlaybackCommand(string id)
    {
        pendingAcks.Add(id);
        _ = RequestPlaybackCheckInAsync();
    }

    public Task ReportPlaybackActivityAsync(bool playing, double? position = null, bool followingHost = false, string remoteDeviceId = "", bool background = true,
        string? status = null, double? duration = null, MusicTrack? track = null, IReadOnlyList<MusicTrack>? queue = null, int queueIndex = -1, bool force = false,
        bool? shuffle = null, string? repeatMode = null, bool? autoplay = null)
    {
        if (DateTime.UtcNow - lastHistorySync > TimeSpan.FromMinutes(1)) { lastHistorySync = DateTime.UtcNow; _ = SyncHistoryAsync(); }
        if (queue is not null)
        {
            var idsChanged = !ReferenceEquals(queue, observedQueue) && !queue.Select(t => t.Id).SequenceEqual(queueIds);
            observedQueue = queue;
            if (idsChanged) queueIds = queue.Select(t => t.Id).ToArray();
            var modes = (shuffle, repeatMode, autoplay);
            if (idsChanged || activityQueueIndex != queueIndex || queueModes != modes) queueRevision++;
            activityQueueIndex = queueIndex;
            queueModes = modes;
        }
        return SendPlaybackActivityAsync(new(playing, position, followingHost, remoteDeviceId, background, status, duration, status is null ? activityTrack : track, force));
    }

    private async Task SendPlaybackActivityAsync(Activity activity)
    {
        var api = Api;
        if (!Connected || api is null || !UiActive && !activity.Playing && !HandoffPending) return;
        if (activityInFlight)
        {
            pendingActivity = activity with { Background = activity.Background && pendingActivity?.Background != false, Force = activity.Force || pendingActivity?.Force == true };
            if (activity.Force)
            {
                pendingActivityCompletion ??= new(TaskCreationOptions.RunContinuationsAsynchronously);
                await pendingActivityCompletion.Task;
            }
            return;
        }
        var trackId = activity.Track?.Id ?? "";
        var activation = PlaybackActivation;
        var profileVersion = accountVersion;
        var activityAt = Environment.TickCount64;
        var sameApi = ReferenceEquals(api, lastActivityApi);
        var revision = queueRevision;
        // After a minute without a check-in the server discards the device and its queue.
        var needsFullQueue = !sameApi || activityAt - lastActivity >= 60_000 || sentQueueIds is null;
        var queueChanged = needsFullQueue || revision != sentQueueRevision;
        var localPlay = activity.Playing && !activity.FollowingHost && activity.RemoteDeviceId.Length == 0 && activity.Status != "paused"
            && activation != 0 && activation != lastActivityActivation;
        var acks = pendingAcks.ToArray();
        // Allow timer jitter around five-second check-ins (server expiry is 15 seconds).
        var interval = !activity.Playing && activity.Status != "buffering" && !HandoffPending
            ? IdleHeartbeatSeconds : 5;
        if (!activity.Force && acks.Length == 0 && !queueChanged && !localPlay && trackId == lastActivityTrackId
            && activity.Playing == lastActivityPlaying && activity.Status == lastActivityStatus && activity.Duration == lastActivityDuration
            && activity.FollowingHost == lastActivityFollowingHost && activity.RemoteDeviceId == lastActivityRemoteDevice && activityAt - lastActivity < interval * 1000 - 200) return;
        var ids = queueIds;
        var modes = queueModes;
        var start = 0;
        int? compactIndex = null;
        PlaybackResume? snapshot = null;
        if (queueChanged && revision != 0 && activityQueueIndex >= 0 && activityQueueIndex < queueIds.Length)
        {
            // Keep the published 1000-track window until the playhead leaves it.
            start = ReferenceEquals(sentQueueIds, ids) && activityQueueIndex >= sentQueueStart && activityQueueIndex < sentQueueStart + 1000
                ? sentQueueStart : Math.Min(activityQueueIndex, Math.Max(0, ids.Length - 1000));
            if (compactQueue && !needsFullQueue && ReferenceEquals(sentQueueIds, ids) && start == sentQueueStart && modes == sentQueueModes)
                compactIndex = activityQueueIndex - start;
            else
            {
                snapshot = new()
                {
                    TrackIds = ids.Skip(start).Take(1000).ToList(), Index = activityQueueIndex - start,
                    Shuffle = modes.Shuffle, RepeatMode = modes.RepeatMode, Autoplay = modes.Autoplay
                };
                if (!snapshot.IsValid) snapshot = null;
            }
        }
        if (queueChanged && compactIndex is null && revision != 0) snapshot ??= new() { Index = -1 };
        activityInFlight = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            var journal = listeningJournal;
            var counters = journal?.Pending();
            var receipt = await api.ReportPlaybackActivityAsync(activityDevice, activity.Playing, timeout.Token, counters, journal?.DeviceId, activity.Track, DeviceName, DeviceKind,
                activity.Position, activation, ++activitySequence, activity.FollowingHost, activity.RemoteDeviceId, activity.Background,
                activity.Status, activity.Duration, snapshot, revision, localPlay ? localPlaybackEpoch : playbackEpoch, localPlay, acks, compactIndex);
            if (receipt.CountersAccepted && journal is not null && counters is { Count: > 0 }) journal.Acknowledge(counters);
            if (profileVersion != accountVersion || !ReferenceEquals(api, Api)) return;
            var epoch = receipt.Epoch ?? receipt.Command?.Epoch;
            var serverRestarted = epoch < playbackEpoch;
            playbackEpoch = epoch ?? playbackEpoch;
            pendingAcks.ExceptWith(acks);
            lastActivity = activityAt; lastActivityPlaying = activity.Playing; lastActivityTrackId = trackId; lastActivityApi = api;
            if (localPlay) lastActivityActivation = activation;
            lastActivityStatus = activity.Status; lastActivityDuration = activity.Duration;
            lastActivityFollowingHost = activity.FollowingHost; lastActivityRemoteDevice = activity.RemoteDeviceId;
            sentQueueRevision = revision;
            sentQueueIds = serverRestarted ? null : ids;
            sentQueueModes = modes;
            if (queueChanged) sentQueueStart = start;
            if (receipt.Command is { } command) activationWatermark = Math.Max(activationWatermark, command.Activation);
            if (activation == PlaybackActivation && !activity.FollowingHost)
            {
                if (receipt.Command is { } handover && (handover is { Action: "play", Resume.IsValid: true } || handover is { Action: "pause", DeviceId.Length: 32 }) && RememberPlaybackCommand(handover.Id))
                    PlaybackHandedOver?.Invoke(handover);
                foreach (var control in receipt.Controls) if (controlsSeen.Add(control.Id)) RemoteControlReceived?.Invoke(control);
            }
            else if (activation != PlaybackActivation) PlaybackActivation = Math.Max(PlaybackActivation, activationWatermark + 1);
        }
        catch (FamilyHubApiException error) when (error.StatusCode == 400 && compactIndex is not null && ReferenceEquals(api, Api))
        {
            // Older servers require track_ids on index changes. Retry the latest check-in in full.
            compactQueue = false;
            pendingActivity ??= activity;
        }
        catch (Exception error) when (error is HttpRequestException or FamilyHubApiException or OperationCanceledException or ObjectDisposedException) { }
        finally
        {
            activityInFlight = false;
            var pending = pendingActivity; pendingActivity = null;
            var completion = pendingActivityCompletion; pendingActivityCompletion = null;
            try { if (pending is { } next) await SendPlaybackActivityAsync(next); }
            finally { completion?.TrySetResult(); }
        }
    }

    public async Task InitializeAsync()
    {
        if (Ready) return;
        try
        {
            var config = JsonSerializer.Deserialize<Connection>(Preferences.Default.Get(ConfigurationKey, "null"));
            if (config is not null)
            {
                if (string.IsNullOrEmpty(config.User))
                {
                    Server = FamilyHubApi.NormalizeOrigin(new Uri(config.Server)).AbsoluteUri;
                    Api = createApi(new Uri(Server)); NeedsProfileSelection = true;
                }
                else
                {
                    Configure(config.Server, config.User);
                    ProfileName = config.ProfileName ?? config.User;
                    PlaybackPreferences = ReadPreferences().Value;
                    Library = await Offline!.GetLibraryAsync();
                    Playlists = await Offline.GetPlaylistsAsync();
                    await ReadDownloadsAsync();
                }
                Profiles = ReadProfiles(Server);
            }
        }
        catch { SetMessage("Could not read the saved connection. Enter your server again.", "error"); }
        Ready = true;
        Changed?.Invoke();
        if (Api is not null) _ = ReconnectAsync(background: true);
    }

    private void Configure(string server, string user, FamilyHubApi? authenticatedApi = null, OfflineLibrary? offline = null)
    {
        var origin = FamilyHubApi.NormalizeOrigin(new Uri(server));
        if (string.IsNullOrWhiteSpace(user) || user.Length > 64) throw new ArgumentException("Choose a profile.");
        var sameAccount = Server == origin.AbsoluteUri && User == user;
        Api?.Dispose();
        Api = authenticatedApi ?? createApi(origin);
        Server = origin.AbsoluteUri;
        User = user;
        listeningJournal?.Flush();
        Offline = offline ?? new OfflineLibrary(Path.Combine(FileSystem.AppDataDirectory, "downloads"), origin, user);
        if (!sameAccount || listeningJournal is null) listeningJournal = new ListeningJournal(Offline.RootDirectory);
        #if IOS
        DownloadStorage.Configure(Offline.RootDirectory);
#endif
        accountVersion++; pendingActivity = null; compactQueue = true; sentQueueIds = null; observedQueue = null; TopListenerId = null; topListenerChecked = default;
        if (!sameAccount)
        {
            PlaybackActivation = 0; activationWatermark = 0; controlsSeen.Clear();
            lock (handovers) handovers.Clear();
            playbackEpoch = null; localPlaybackEpoch = null; pendingAcks.Clear(); queueIds = []; activityQueueIndex = -1; queueRevision = 0; queueModes = default;
            playbackCaches.Clear();
            cachedEditions.Clear();
            playbackRecords.Clear();
            Volatile.Write(ref cachedHashes, []);
            Volatile.Write(ref cachedTracks, []);
            Interlocked.Exchange(ref cachedBytes, 0);
            PinPlayback(null); PinPreparingPlayback(null);
            PinUpcomingPlayback(null); PinPreparingNextPlayback(null);
        }
        Connected = false;
        var prefPrefix = PreferenceKey(Server, User);
        if (Preferences.Default.ContainsKey(prefPrefix + ":quality-wifi"))
        {
            var wifi = Preferences.Default.Get(prefPrefix + ":quality-wifi", "high");
            var mobile = Preferences.Default.Get(prefPrefix + ":quality-mobile", "high");
            var download = Preferences.Default.Get(prefPrefix + ":quality-download", "max");
            StreamingQualityWifi = IsValidQuality(wifi) ? wifi : "high";
            StreamingQualityMobile = IsValidQuality(mobile) ? mobile : "high";
            DownloadQuality = IsValidQuality(download) ? download : "max";
        }
        else
        {
            var oldQuality = Preferences.Default.Get(prefPrefix + ":quality", "max");
            if (oldQuality == "lower")
            {
                StreamingQualityWifi = "normal";
                StreamingQualityMobile = "normal";
                DownloadQuality = "max";
            }
            else
            {
                StreamingQualityWifi = Preferences.Default.ContainsKey(prefPrefix + ":quality") && oldQuality == "max" ? "max" : "high";
                StreamingQualityMobile = "high";
                DownloadQuality = "max";
            }
            Preferences.Default.Set(prefPrefix + ":quality-wifi", StreamingQualityWifi);
            Preferences.Default.Set(prefPrefix + ":quality-mobile", StreamingQualityMobile);
            Preferences.Default.Set(prefPrefix + ":quality-download", DownloadQuality);
        }
        CacheLimitGb = int.TryParse(Preferences.Default.Get(prefPrefix + ":cache-gb", "3"), out var limit)
            && limit is 1 or 3 or 5 or 10 ? limit : 3;
        DownloadsWifiOnly = Preferences.Default.Get(prefPrefix + ":downloads-wifi", "true") != "false";
        EnsurePlaybackCaches();
        var cacheVersion = accountVersion;
        var caches = playbackCaches.Values.ToArray();
        _ = Task.Run(() => ReadPlaybackAvailabilityAsync(cacheVersion, caches));
    }

    private async Task ReadPlaybackAvailabilityAsync(int version, OfflineLibrary[] caches)
    {
        try
        {
            var tracks = new List<MusicTrack>();
            foreach (var cache in caches)
                tracks.AddRange(await cache.ListDownloadsAsync());
            if (version != accountVersion) return;
            cachedEditions.Clear();
            foreach (var track in tracks)
                cachedEditions[track.Id] = string.IsNullOrEmpty(track.PlaybackSourceSha256) ? track.DownloadSha256 : track.PlaybackSourceSha256;
            Volatile.Write(ref cachedHashes, tracks.GroupBy(t => t.Id).ToDictionary(g => g.Key,
                g => g.Select(t => string.IsNullOrEmpty(t.PlaybackSourceSha256) ? t.DownloadSha256 : t.PlaybackSourceSha256).ToHashSet()));
            Volatile.Write(ref cachedTracks, tracks.ToArray());
            Interlocked.Exchange(ref cachedBytes, tracks.Sum(t => t.DownloadSize));
            Changed?.Invoke();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
    public bool OnThisDevice(MusicTrack track) => KeptOnDevice(track) ||
        Volatile.Read(ref cachedHashes).TryGetValue(track.Id, out var editions) && (!Connected || editions.Contains(CurrentRecording(track).DownloadSha256));

    private static bool IsValidQuality(string quality) => quality is "low" or "normal" or "high" or "max";

    public void SetStreamingQualityWifi(string quality)
    {
        if (!IsValidQuality(quality)) throw new ArgumentException("Choose Low, Normal, High or Max quality.");
        StreamingQualityWifi = quality;
        Preferences.Default.Set(PreferenceKey(Server, User) + ":quality-wifi", quality);
        Changed?.Invoke();
    }

    public void SetStreamingQualityMobile(string quality)
    {
        if (!IsValidQuality(quality)) throw new ArgumentException("Choose Low, Normal, High or Max quality.");
        StreamingQualityMobile = quality;
        Preferences.Default.Set(PreferenceKey(Server, User) + ":quality-mobile", quality);
        Changed?.Invoke();
    }

    public void SetDownloadQuality(string quality)
    {
        if (!IsValidQuality(quality)) throw new ArgumentException("Choose Low, Normal, High or Max quality.");
        DownloadQuality = quality;
        Preferences.Default.Set(PreferenceKey(Server, User) + ":quality-download", quality);
        Changed?.Invoke();
    }

    private readonly SemaphoreSlim historyGate = new(1, 1);
    private DateTime lastHistorySync;
    public long HistoryRevision { get; private set; }
    public string HistoryOwner => PreferenceKey(Server, User) + Preferences.Default.Get(HistoryKey + ":generation", "");
    private string HistoryKey => PreferenceKey(Server, User) + ":history-v1";
    private readonly object historyStorageLock = new();
    private T ReadHistory<T>(string suffix, T fallback)
    {
        lock (historyStorageLock)
        {
            if (Offline is null) return fallback;
            try { return JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(Offline.RootDirectory, "history" + suffix.Replace(":", "-") + ".json"))) ?? fallback; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return fallback; }
        }
    }
    private void WriteHistory<T>(string suffix, T value)
    {
        lock (historyStorageLock)
        {
            if (Offline is null) return;
            var target = Path.Combine(Offline.RootDirectory, "history" + suffix.Replace(":", "-") + ".json");
            var temporary = target + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(value));
            File.Move(temporary, target, true);
        }
    }
    public Dictionary<string, double> ArtistPreferences()
    {
        var summary = ReadHistory<ListeningSummary?>(":summary", null);
        return (summary?.Artists ?? []).GroupBy(p => Similarity.Artist(new MusicTrack { Channel = p.Key }))
            .ToDictionary(g => g.Key, g => g.Sum(p => p.Value.Score));
    }
    public List<MusicTrack> RankRecommendations(IEnumerable<MusicTrack> candidates) => ListeningRecommendations.Rank(
        candidates, ReadHistory<ListeningSummary?>(":summary", null), ListeningHistory(), DateTimeOffset.UtcNow);

    internal event Action<LibraryAddition>? LibraryAdditionUpdated;
    internal void ReportLibraryAddition(LibraryAddition job) => LibraryAdditionUpdated?.Invoke(job);

    public Dictionary<string, int> GenrePlayCounts()
    {
        var summary = ReadHistory<ListeningSummary?>(":summary", null);
        if (summary is not null)
            return summary.Genres.GroupBy(row => GenreNames.Key(row.Key))
                .ToDictionary(group => group.Key, group => group.Sum(row => row.Value.Plays));
        var tracks = Library.Concat(DeviceTracks).DistinctBy(track => track.Id).ToDictionary(track => track.Id);
        return ListeningHistory().Where(tracks.ContainsKey).GroupBy(id => GenreNames.Key(tracks[id].Genre))
            .ToDictionary(group => group.Key, group => group.Count());
    }

    public void QueueListeningEvent(MusicTrack track, DateTimeOffset started, double seconds, double duration, double position, string outcome, string source, string owner)
    {
        if (owner != HistoryOwner || string.IsNullOrEmpty(User) || PlaybackPreferences.ListeningHistoryPaused || !double.IsFinite(seconds) || !double.IsFinite(duration) || !double.IsFinite(position) || (seconds <= 0 && outcome == "stopped") || duration <= 0 || duration > 86400) return;
        static string Tag(string value) => string.Concat(value.Where(c => c >= ' ').Take(200)).Trim();
        lock (historyStorageLock)
        {
            var pending = ReadHistory<List<ListeningEvent>>(":pending", []);
            pending.Add(new() { RecordingId = track.Id, StartedAt = started, ListenedSeconds = Math.Clamp(seconds, 0, duration),
                Duration = duration, Position = Math.Clamp(position, 0, duration), Outcome = outcome, Source = source,
                DeviceKind = DeviceInfo.Current.Platform == DevicePlatform.WinUI ? "windows" : DeviceInfo.Current.Platform == DevicePlatform.Android ? "android" : "iphone",
                Track = new() { ["title"] = Tag(track.Title), ["channel"] = Tag(track.Channel),
                    ["library_album"] = Tag(track.LibraryAlbum), ["genre"] = Tag(track.Genre) } });
            WriteHistory(":pending", pending.TakeLast(2000).ToList());
        }
        _ = SyncHistoryAsync();
    }
    private sealed record HistoryAck([property: JsonPropertyName("acknowledged")] List<string> Acknowledged);
    public async Task SyncHistoryAsync()
    {
        if (!Connected || Api is null || string.IsNullOrEmpty(User)) return;
        var key = HistoryKey; var api = Api; var version = accountVersion;
        if (!await historyGate.WaitAsync(0)) return;
        try
        {
            if (version != accountVersion) return;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            // Dirty offline preferences (including pause) reach the server before queued events.
            if (ReadPreferences().Dirty)
            {
                var saved = await api.SavePreferencesAsync(PlaybackPreferences, timeout.Token, background: true);
                if (version != accountVersion) return;
                PlaybackPreferences = saved; StorePreferences(saved, false);
            }
            while (version == accountVersion)
            {
                var batch = ReadHistory<List<ListeningEvent>>(":pending", []).Take(100).ToList();
                if (batch.Count == 0) break;
                var ack = await api.RequestJsonAsync<HistoryAck>(HttpMethod.Post, "/api/listening/events", new { events = batch }, timeout.Token, background: true);
                if (version != accountVersion) return;
                var ids = ack.Acknowledged.ToHashSet();
                if (!batch.All(e => ids.Contains(e.EventId))) return;
                lock (historyStorageLock)
                {
                    var pending = ReadHistory<List<ListeningEvent>>(":pending", []).Where(e => !ids.Contains(e.EventId)).ToList();
                    WriteHistory(":pending", pending);
                }
            }
            var summary = await api.RequestJsonAsync<ListeningSummary>(HttpMethod.Get, "/api/listening/summary", cancellationToken: timeout.Token, background: true);
            if (version != accountVersion) return;
            var previous = ReadHistory<ListeningSummary?>(":summary", null);
            if (summary.ClearedAt is { } cleared && (previous?.ClearedAt is null || cleared > previous.ClearedAt))
            {
                WriteHistory(":legacy", new List<string>());
                Preferences.Default.Set(key + ":migrated", "true");
                Preferences.Default.Set(key + ":generation", Guid.NewGuid().ToString());
            }
            if (Preferences.Default.Get(key + ":migrated", "false") != "true")
            {
                WriteHistory(":legacy", ListeningHistory());
                Preferences.Default.Set(key + ":migrated", "true");
            }
            var legacy = ReadHistory<List<string>>(":legacy", []);
            var pendingIds = ReadHistory<List<ListeningEvent>>(":pending", []).Select(e => e.RecordingId);
            Preferences.Default.Set(PreferenceKey(Server, User) + ":listening-history", JsonSerializer.Serialize(
                legacy.Concat(summary.RecentHistory).Concat(pendingIds).TakeLast(200)));
            WriteHistory(":summary", summary); HistoryRevision++;
            Changed?.Invoke();
        }
        catch (Exception error) when (error is HttpRequestException or IOException or FamilyHubApiException or OperationCanceledException or JsonException or UnauthorizedAccessException) { }
        finally { historyGate.Release(); }
    }
    private sealed record HistoryClear([property: JsonPropertyName("cleared_at")] DateTimeOffset? ClearedAt);
    public async Task ClearListeningHistoryAsync()
    {
        var api = OnlineApi(); var version = accountVersion;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await historyGate.WaitAsync(timeout.Token);
        try
        {
            EnsureCurrent(version);
            var cleared = await api.RequestJsonAsync<HistoryClear>(HttpMethod.Delete, "/api/listening/history", cancellationToken: timeout.Token);
            EnsureCurrent(version);
            Preferences.Default.Set(HistoryKey + ":generation", Guid.NewGuid().ToString());
            WriteHistory(":pending", new List<ListeningEvent>());
            WriteHistory(":legacy", new List<string>());
            WriteHistory(":summary", new ListeningSummary { ClearedAt = cleared.ClearedAt });
            Preferences.Default.Set(HistoryKey + ":migrated", "true");
            Preferences.Default.Set(PreferenceKey(Server, User) + ":listening-history", "[]");
            HistoryRevision++; SetMessage("Listening history cleared.", "success");
        }
        finally { historyGate.Release(); }
    }

    private List<string> ListeningHistory()
    {
        try { return JsonSerializer.Deserialize<List<string>>(Preferences.Default.Get(PreferenceKey(Server, User) + ":listening-history", "[]")) ?? []; }
        catch (JsonException) { return []; }
    }
    public bool HasListeningHistory => ListeningHistory().Count > 0;
    // Most recent first, one entry per recording, limited to recordings this device can still resolve.
    public List<MusicTrack> RecentlyPlayed(int count)
    {
        var source = (Connected ? Library : Downloads).DistinctBy(t => t.Id).ToDictionary(t => t.Id);
        return ListeningHistory().AsEnumerable().Reverse().Distinct().Select(id => source.GetValueOrDefault(id)).OfType<MusicTrack>().Take(count).ToList();
    }
    public void RecordListen(MusicTrack track)
    {
        if (string.IsNullOrEmpty(User)) return;
        if (PlaybackPreferences.ListeningHistoryPaused) return;
        var recent = ListeningHistory();
        recent.Add(track.Id); HistoryRevision++;
        Preferences.Default.Set(PreferenceKey(Server, User) + ":listening-history", JsonSerializer.Serialize(recent.TakeLast(200)));
    }
    public List<MusicTrack> QuickPlayQueue() => RankRecommendations(Connected ? Library : Downloads);

    private void PersistConnection() => Preferences.Default.Set(ConfigurationKey,
        JsonSerializer.Serialize(new Connection(Server, User, ProfileName)));

    private static string ProfilesKey(string server) => "familyhub:profiles:" +
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(server)));
    private static List<ListenerProfile> ReadProfiles(string server) =>
        JsonSerializer.Deserialize<List<ListenerProfile>>(Preferences.Default.Get(ProfilesKey(server), "[]")) ?? [];
    private static void StoreProfiles(string server, List<ListenerProfile> profiles) =>
        Preferences.Default.Set(ProfilesKey(server), JsonSerializer.Serialize(profiles));

    private static string PreferenceKey(string server, string user) => "familyhub:profile-prefs:" +
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(server + "\n" + user)));
    public bool PreferencesPending => ReadPreferences().Dirty;
    private CachedPreferences ReadPreferences() => JsonSerializer.Deserialize<CachedPreferences>(
        Preferences.Default.Get(PreferenceKey(Server, User), "null")) ?? new(new(), false);
    private void StorePreferences(ListenerPreferences value, bool dirty) => Preferences.Default.Set(
        PreferenceKey(Server, User), JsonSerializer.Serialize(new CachedPreferences(value, dirty)));

    public async Task ConnectServerAsync(string server, Func<Task>? beforeSwitch = null)
    {
        await connectionLock.WaitAsync();
        FamilyHubApi? candidate = null;
        try
        {
            RequireIdleDownload();
            candidate = createApi(FamilyHubApi.NormalizeOrigin(new Uri(server.Trim())));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            ProfileConnection connection;
            ProfileSelection? selection = null;
            try
            {
                connection = await candidate.ConnectAsync(timeout.Token);
                if (candidate.ServerOrigin.AbsoluteUri == Server && !string.IsNullOrEmpty(User)
                    && connection.Profiles.Any(p => p.Id == User))
                    selection = await candidate.SelectProfileAsync(User, timeout.Token);
            }
            catch (HttpRequestException error) when (error.HttpRequestError == HttpRequestError.SecureConnectionError)
            {
                throw new InvalidOperationException("Could not establish a secure connection. Check the server address and certificate.", error);
            }
            catch (HttpRequestException error)
            {
                throw new InvalidOperationException("Could not reach your server. Check the address and your connection, then try again.", error);
            }
            if (beforeSwitch is not null) await beforeSwitch();
            StoreProfiles(candidate.ServerOrigin.AbsoluteUri, connection.Profiles);
            if (selection is not null)
            {
                await ApplySelectionAsync(candidate, selection, connection.Profiles);
                candidate = null;
                await RefreshAsync();
                return;
            }
            Api?.Dispose(); Api = candidate; candidate = null;
            Server = Api.ServerOrigin.AbsoluteUri;
            ClearProfile(); Profiles = connection.Profiles;
            PersistConnection(); SetMessage("Choose who's listening.");
        }
        finally { if (!ReferenceEquals(Api, candidate)) candidate?.Dispose(); connectionLock.Release(); }
    }

    private void RequireIdleDownload()
    { if (downloadCancellation is not null) throw new InvalidOperationException("Pause the download before changing profiles or servers."); }

    private void ClearProfile()
    {
        accountVersion++; TopListenerId = null; topListenerChecked = default;
        playbackCaches.Clear();
        PinPlayback(null); PinPreparingPlayback(null);
        User = ""; ProfileName = ""; Offline = null; Connected = false;
        Library = []; Playlists = []; Downloads = []; DownloadedBytes = 0;
        DownloadFailure = null;
        PlaybackPreferences = new(); NeedsProfileSelection = true;
    }

    public async Task SelectProfileAsync(string id)
    {
        await connectionLock.WaitAsync();
        FamilyHubApi? candidate = null;
        try
        {
            RequireIdleDownload();
            if (string.IsNullOrEmpty(Server)) throw new InvalidOperationException("Connect to your server first.");
            var server = Server;
            var version = accountVersion;
            candidate = createApi(new Uri(server));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            ProfileConnection connection;
            ProfileSelection selection;
            try
            {
                connection = await candidate.ConnectAsync(timeout.Token);
                Profiles = connection.Profiles;
                StoreProfiles(server, Profiles);
                if (!Profiles.Any(profile => profile.Id == id))
                    throw new InvalidOperationException("This profile is no longer available. Choose another profile.");
                selection = await candidate.SelectProfileAsync(id, timeout.Token);
            }
            catch (Exception error) when (error is HttpRequestException { StatusCode: null } or OperationCanceledException)
            {
                RequireIdleDownload(); EnsureCurrent(version);
                if (Server != server) throw new OperationCanceledException("The server changed.");
                var profile = ReadProfiles(server).FirstOrDefault(profile => profile.Id == id)
                    ?? throw new InvalidOperationException("This profile is not available offline. Reconnect to your server first.");
                var offline = new OfflineLibrary(Path.Combine(FileSystem.AppDataDirectory, "downloads"), candidate.ServerOrigin, id);
                var library = await offline.GetLibraryAsync();
                var playlists = await offline.GetPlaylistsAsync();
                RequireIdleDownload(); EnsureCurrent(version);
                Configure(server, id, candidate, offline); candidate = null;
                ProfileName = profile.Name; NeedsProfileSelection = false;
                Profiles = ReadProfiles(server); Library = library; Playlists = playlists;
                PlaybackPreferences = ReadPreferences().Value;
                PersistConnection(); await ReadDownloadsAsync();
                SetMessage("Server unavailable. Downloaded songs are available offline.", "warning");
                return;
            }
            await ApplySelectionAsync(candidate, selection, connection.Profiles);
            candidate = null;
            await RefreshAsync();
        }
        finally { if (!ReferenceEquals(Api, candidate)) candidate?.Dispose(); connectionLock.Release(); }
    }

    private async Task ApplySelectionAsync(FamilyHubApi candidate, ProfileSelection selection, List<ListenerProfile> profiles)
    {
        var offline = new OfflineLibrary(Path.Combine(FileSystem.AppDataDirectory, "downloads"), candidate.ServerOrigin, selection.Profile.Id);
        var library = await offline.GetLibraryAsync();
        var playlists = await offline.GetPlaylistsAsync();
        Configure(candidate.ServerOrigin.AbsoluteUri, selection.Profile.Id, candidate, offline);
        ProfileName = selection.Profile.Name; Profiles = profiles; NeedsProfileSelection = false;
        StoreProfiles(Server, profiles);
        Library = library; Playlists = playlists; Connected = true; UpdateMessage("", "info");
        PersistConnection();
        var cached = ReadPreferences();
        PlaybackPreferences = cached.Dirty ? cached.Value : selection.Preferences;
        StorePreferences(PlaybackPreferences, cached.Dirty);
        await ReadDownloadsAsync();
        if (cached.Dirty)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                PlaybackPreferences = await candidate.SavePreferencesAsync(cached.Value, timeout.Token, background: true);
                StorePreferences(PlaybackPreferences, false);
            }
            catch (Exception error) when (error is HttpRequestException or IOException or FamilyHubApiException or OperationCanceledException)
            { SetMessage("Preferences saved on this device. They will sync when the server reconnects."); }
        }
        Changed?.Invoke();
    }

    public async Task CreateProfileAsync(string name)
    {
        await connectionLock.WaitAsync();
        try
        {
            if (Api is null) throw new InvalidOperationException("Connect to your server first.");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var profile = await Api.CreateProfileAsync(name.Trim(), timeout.Token);
            Profiles.Add(profile); StoreProfiles(Server, Profiles); Changed?.Invoke();
        }
        finally { connectionLock.Release(); }
    }

    public async Task SwitchProfileAsync()
    {
        await connectionLock.WaitAsync();
        try
        {
            RequireIdleDownload();
            ClearProfile(); PersistConnection();
            Api?.Dispose(); Api = string.IsNullOrEmpty(Server) ? null : createApi(new Uri(Server));
            Changed?.Invoke();
        }
        finally { connectionLock.Release(); }
        await ReconnectAsync();
    }

    public async Task ReconnectAsync(bool background = false)
    {
        await connectionLock.WaitAsync();
        FamilyHubApi? candidate = null;
        try
        {
            if (string.IsNullOrEmpty(Server)) return;
            RequireIdleDownload();
            candidate = createApi(new Uri(Server));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var connection = await candidate.ConnectAsync(timeout.Token, background);
            StoreProfiles(Server, connection.Profiles);
            if (string.IsNullOrEmpty(User) || !connection.Profiles.Any(p => p.Id == User))
            {
                Api?.Dispose(); Api = candidate; candidate = null;
                ClearProfile(); Profiles = connection.Profiles; PersistConnection();
                SetMessage("Choose who's listening."); return;
            }
            var selection = await candidate.SelectProfileAsync(User, timeout.Token, background);
            await ApplySelectionAsync(candidate, selection, connection.Profiles);
            candidate = null;
            await RefreshAsync(background);
        }
        catch (Exception error) { OfflineError(error); }
        finally { if (!ReferenceEquals(Api, candidate)) candidate?.Dispose(); connectionLock.Release(); }
    }

    public async Task SavePreferencesAsync(double volume, bool shuffle, bool? autoDj = null, string? repeatMode = null, int? crossfadeSeconds = null, string? volumeLevel = null, bool? listeningHistoryPaused = null)
    {
        if (!double.IsFinite(volume) || volume is < 0 or > 1) throw new ArgumentException("Volume must be between zero and one.");
        if (volumeLevel is not (null or "loud" or "normal" or "quiet")) throw new ArgumentException("Choose Loud, Normal or Quiet volume level.");
        await connectionLock.WaitAsync();
        try
        {
            if (string.IsNullOrEmpty(User)) return;
            if (listeningHistoryPaused is { } paused && paused != PlaybackPreferences.ListeningHistoryPaused)
            {
                Preferences.Default.Set(HistoryKey + ":generation", Guid.NewGuid().ToString());
                listeningJournal?.InvalidateBaseline();
            }
            PlaybackPreferences = PlaybackPreferences with { ListeningHistoryPaused = listeningHistoryPaused ?? PlaybackPreferences.ListeningHistoryPaused, Volume = volume, Shuffle = shuffle, AutoDj = autoDj ?? PlaybackPreferences.AutoDj, RepeatMode = repeatMode ?? PlaybackPreferences.RepeatMode, CrossfadeSeconds = crossfadeSeconds ?? PlaybackPreferences.CrossfadeSeconds, VolumeLevel = volumeLevel ?? PlaybackPreferences.VolumeLevel };
            StorePreferences(PlaybackPreferences, true); Changed?.Invoke();
            if (!Connected || Api is null) return;
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                PlaybackPreferences = await Api.SavePreferencesAsync(PlaybackPreferences, timeout.Token);
                StorePreferences(PlaybackPreferences, false);
            }
            catch (FamilyHubApiException error) when (error.RequiresSignIn)
            { OfflineError(error); }
            catch (Exception error) when (error is HttpRequestException or IOException or FamilyHubApiException or OperationCanceledException)
            { SetMessage("Preferences saved on this device. They will sync when the server reconnects."); }
        }
        finally { connectionLock.Release(); }
    }

    public async Task SaveSpotifyStatusAsync(bool subscribed)
    {
        var api = OnlineApi();
        var version = accountVersion;
        var preferences = await api.SaveSpotifyStatusAsync(subscribed);
        EnsureCurrent(version);
        PlaybackPreferences = preferences; StorePreferences(preferences, false); Changed?.Invoke();
    }

    // A phone waking up or switching networks drops a request or two while the VPN reconnects.
    // Automatic refreshes try again a few times before saying the server is unavailable.
    private static readonly TimeSpan[] quietRetries = [TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(8), TimeSpan.FromSeconds(20)];
    private bool retryingQuietly;
    public async Task RefreshLibraryAutomaticallyAsync()
    {
        if (string.IsNullOrEmpty(User) || DownloadingId is not null || retryingQuietly) return;
        var version = accountVersion;
        retryingQuietly = true;
        try
        {
            for (var attempt = 0; ; attempt++)
            {
                if (attempt == quietRetries.Length) retryingQuietly = false;
                if (!Connected) await ReconnectAsync(background: true);
                else if (await connectionLock.WaitAsync(0))
                {
                    try { await RefreshAsync(background: true); }
                    finally { connectionLock.Release(); }
                }
                else return;
                if (Connected || !retryingQuietly || version != accountVersion || string.IsNullOrEmpty(User)) return;
                await Task.Delay(quietRetries[attempt]);
            }
        }
        finally { retryingQuietly = false; }
    }

    // This month's top listener wears a crown on their picture everywhere in the app.
    public string? TopListenerId { get; private set; }
    private DateTime topListenerChecked;
    public void UpdateTopListener(ServerStatistics stats)
    {
        topListenerChecked = DateTime.UtcNow;
        var top = stats.Profiles.Where(p => p.MonthSeconds >= 60).OrderByDescending(p => p.MonthSeconds).ThenBy(p => p.Name).FirstOrDefault()?.Id;
        if (top == TopListenerId) return;
        TopListenerId = top; Changed?.Invoke();
    }
    private async Task RefreshTopListenerAsync(FamilyHubApi api, int version)
    {
        if (DateTime.UtcNow - topListenerChecked < TimeSpan.FromMinutes(10)) return;
        topListenerChecked = DateTime.UtcNow;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var stats = await api.GetServerStatsAsync(timeout.Token, background: true);
            if (version == accountVersion) UpdateTopListener(stats);
        }
        catch (Exception error) when (error is HttpRequestException or FamilyHubApiException or OperationCanceledException or System.Text.Json.JsonException) { }
    }

    public async Task RefreshAsync(bool background = false)
    {
        if (Api is null || Offline is null) return;
        _ = RefreshTopListenerAsync(Api, accountVersion);
        var version = accountVersion;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            await RefreshCatalogueAsync(timeout.Token, background);
            if (version != accountVersion) return;
            Connected = true; UpdateMessage("", "info");
            await SyncHistoryAsync();
            await ReadDownloadsAsync();
            await ReadPlaybackAvailabilityAsync(version, playbackCaches.Values.ToArray());
            if (version == accountVersion && Message is "Library updated."
                or "Server unavailable. Downloaded songs are available offline."
                or "Reconnect to your server. Downloaded songs are available offline.") SetMessage("");
        }
        catch (Exception error) { if (version == accountVersion) OfflineError(error); }
    }

    private readonly SemaphoreSlim catalogueRefresh = new(1, 1);
    public async Task RefreshCatalogueAsync(CancellationToken token, bool background = true)
    {
        if (Api is not { } api || Offline is not { } offline) return;
        var version = accountVersion;
        await catalogueRefresh.WaitAsync(token);
        var changed = false;
        try
        {
            EnsureCurrent(version);
            // Publish each conditional response so its ETag and the displayed snapshot advance together.
            var library = await api.GetLibraryIfChangedAsync(token, background);
            EnsureCurrent(version);
            if (library is not null)
            {
                Library = library;
                changed = true;
                await offline.SaveLibraryAsync(library);
            }
            var playlists = await api.GetPlaylistsIfChangedAsync(token, background);
            EnsureCurrent(version);
            if (playlists is not null)
            {
                Playlists = playlists;
                changed = true;
                await offline.SavePlaylistsAsync(playlists);
            }
        }
        finally
        {
            catalogueRefresh.Release();
            if (changed && version == accountVersion) Changed?.Invoke();
        }
    }

    private void UpdateMessage(string message, string level, bool playback = false)
    {
        Message = message;
        MessageLevel = level;
        PlaybackMessage = playback;
        MessageRevision++;
    }
    public void SetMessage(string message, string level = "info", bool playback = false)
    {
        UpdateMessage(message, level, playback);
        Changed?.Invoke();
    }
    private void OfflineError(Exception error)
    {
        Connected = false;
        if (retryingQuietly && error is not FamilyHubApiException { RequiresSignIn: true }) { Changed?.Invoke(); return; }
        SetMessage(error is FamilyHubApiException { RequiresSignIn: true }
            ? "Reconnect to your server. Downloaded songs are available offline."
            : "Server unavailable. Downloaded songs are available offline.", "warning");
    }

    public bool OnServer(PlaylistTrack entry) => entry.RecordingId is { Length: > 0 } id
        && (libraryById.ContainsKey(id) || entry.State == "saved" && entry.Match is { Saved: true, DownloadUrl.Length: > 0 } saved && saved.Id == id);

    public MusicTrack? Resolve(PlaylistTrack entry)
    {
        if (entry.RecordingId is not { } id) return null;
        return libraryById.GetValueOrDefault(id) ?? downloadsById.GetValueOrDefault(id)
            ?? (Connected && entry.State == "saved" && entry.Match is { DownloadUrl.Length: > 0 } saved && saved.Id == id ? saved : null);
    }
    public MusicTrack CurrentRecording(MusicTrack track) =>
        libraryById.TryGetValue(track.Id, out var current) && (Connected || current.DownloadSha256 == track.DownloadSha256) ? current : track;

    public MusicTrack PlaybackRecording(MusicTrack track, string path)
    {
        if (IsStream(path)) return playbackRecords.TryRemove(path, out var stream) ? stream : track;
        return Offline?.GetDownloadedPath(track.Id) == path && downloadsById.TryGetValue(track.Id, out var saved) ? saved :
            playbackRecords.GetValueOrDefault(path, track);
    }

    public string? LocalPath(MusicTrack track)
    {
        track = CurrentRecording(track);
        var path = Offline?.GetDownloadedPath(track.Id);
        if (path is null || !Connected || string.IsNullOrEmpty(track.DownloadSha256)) return path;
        var saved = Downloads.FirstOrDefault(t => t.Id == track.Id);
        if (saved is not null)
        {
            var sourceHash = string.IsNullOrEmpty(saved.PlaybackSourceSha256) ? saved.DownloadSha256 : saved.PlaybackSourceSha256;
            if (sourceHash == track.DownloadSha256) return path;
        }
        // Keep old offline downloads, but fetch the current edition when connected.
        return path.EndsWith("." + track.DownloadSha256 + track.DownloadExtension,
            StringComparison.OrdinalIgnoreCase) ? path : null;
    }
    public Task<string?> GetArtworkAsync(MusicTrack track, CancellationToken cancellationToken = default) =>
        System.Text.RegularExpressions.Regex.IsMatch(track.Id, "^[A-Za-z0-9_-]{11}$")
            ? GetCachedImageAsync(track.Id, (api, token) => api.GetArtworkAsync(track.Id, token), cancellationToken)
            : Task.FromResult<string?>(null);

    public Task<string?> GetPlaylistArtworkAsync(MusicPlaylist playlist, CancellationToken cancellationToken = default) =>
        string.IsNullOrEmpty(playlist.CoverUrl) ? Task.FromResult<string?>(null)
            : GetCachedImageAsync(playlist.CoverUrl, (api, token) => api.GetImageAsync(playlist.CoverUrl, token), cancellationToken);

    // Covers reach the page as short app addresses (fh-art/...), so the web view loads, decodes and
    // caches them itself instead of receiving every image as text through Blazor.
    private (string Account, string Scope) artworkScope = ("", "");
    public string ArtworkScope
    {
        get
        {
            var account = Server + "\n" + User;
            var known = artworkScope;
            if (known.Account == account && known.Scope.Length > 0) return known.Scope;
            var scope = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(account)))[..12].ToLowerInvariant();
            artworkScope = (account, scope);
            return scope;
        }
    }
    public static string TrackArtworkUrl(string scope, string trackId) => $"fh-art/t/{trackId}?s={scope}";
    public static string PlaylistArtworkUrl(string scope, MusicPlaylist playlist) =>
        $"fh-art/p?u={Uri.EscapeDataString(playlist.CoverUrl)}&v={Uri.EscapeDataString(playlist.CoverSha256)}&s={scope}";

    /// <summary>Image bytes and type for an fh-art address, from the disk cache or the server; null when unavailable.</summary>
    public async Task<(byte[] Data, string Type)?> OpenArtworkAsync(Uri address, CancellationToken cancellationToken = default)
    {
        var path = address.AbsolutePath;
        var query = System.Web.HttpUtility.ParseQueryString(address.Query);
        string? image = null;
        if (path.StartsWith("/fh-art/t/", StringComparison.Ordinal))
        {
            var id = path["/fh-art/t/".Length..];
            if (System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9_-]{11}$"))
                image = await LoadCachedImageAsync(id, (api, token) => api.GetArtworkAsync(id, token), cancellationToken);
        }
        else if (path == "/fh-art/p" && query["u"] is { } cover && cover.StartsWith("/api/", StringComparison.Ordinal))
            image = await LoadCachedImageAsync(cover, (api, token) => api.GetImageAsync(cover, token), cancellationToken);
        if (image is null) return null;
        var comma = image.IndexOf(',');
        if (comma < 0 || !image.StartsWith("data:", StringComparison.Ordinal)) return null;
        var type = image[5..image.IndexOf(';')];
        return (Convert.FromBase64String(image[(comma + 1)..]), type);
    }

    // Recently shown covers stay in memory so scrolling back does not re-read and re-decode them.
    private readonly Dictionary<string, LinkedListNode<(string Key, string Value)>> recentArtwork = [];
    private readonly LinkedList<(string Key, string Value)> recentArtworkOrder = new();
    private string? RecentArtwork(string key)
    {
        lock (recentArtwork)
        {
            if (!recentArtwork.TryGetValue(key, out var node)) return null;
            recentArtworkOrder.Remove(node); recentArtworkOrder.AddFirst(node);
            return node.Value.Value;
        }
    }
    private void RememberArtwork(string key, string value)
    {
        lock (recentArtwork)
        {
            if (recentArtwork.Remove(key, out var old)) recentArtworkOrder.Remove(old);
            recentArtwork[key] = recentArtworkOrder.AddFirst((key, value));
            while (recentArtworkOrder.Count > 120) { recentArtwork.Remove(recentArtworkOrder.Last!.Value.Key); recentArtworkOrder.RemoveLast(); }
        }
    }

    private async Task<string?> GetCachedImageAsync(string identity, Func<FamilyHubApi, CancellationToken, Task<string>> fetch, CancellationToken cancellationToken)
    {
        var memoryKey = accountVersion + ":" + identity;
        if (RecentArtwork(memoryKey) is { } remembered) return remembered;
        var image = await LoadCachedImageAsync(identity, fetch, cancellationToken);
        if (image is not null) RememberArtwork(memoryKey, image);
        return image;
    }

    private async Task<string?> LoadCachedImageAsync(string identity, Func<FamilyHubApi, CancellationToken, Task<string>> fetch, CancellationToken cancellationToken)
    {
        var version = accountVersion;
        var offline = Offline;
        var api = Api;
        if (offline is null) return null;
        var directory = Path.Combine(offline.RootDirectory, "art");
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        var path = Path.Combine(directory, key + ".txt");
        await artworkLoading.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(path) && new FileInfo(path).Length <= 2800000)
            {
                var cached = await File.ReadAllTextAsync(path, cancellationToken);
                EnsureCurrent(version);
                if (cached.StartsWith("data:image/jpeg;base64,", StringComparison.Ordinal)
                    || cached.StartsWith("data:image/png;base64,", StringComparison.Ordinal)
                    || cached.StartsWith("data:image/webp;base64,", StringComparison.Ordinal)) return cached;
            }
            if (!Connected || api is null) return null;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var artwork = await fetch(api, timeout.Token);
            EnsureCurrent(version);
            Directory.CreateDirectory(directory);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await File.WriteAllTextAsync(temporary, artwork, cancellationToken);
                File.Move(temporary, path, true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            EnsureCurrent(version);
            return artwork;
        }
        catch (Exception error) when (error is IOException or HttpRequestException or FamilyHubApiException) { return null; }
        finally { artworkLoading.Release(); }
    }
    private readonly SemaphoreSlim downloadIndex = new(1, 1);
    public async Task ReadDownloadsAsync()
    {
        if (Offline is not { } offline) return;
        var version = accountVersion;
        await downloadIndex.WaitAsync();
        try
        {
            var downloads = await offline.ListDownloadsAsync();
            if (version != accountVersion) return;
            Downloads = downloads;
            DownloadedBytes = downloads.Sum(t => t.DownloadSize);
        }
        finally { downloadIndex.Release(); }
        Changed?.Invoke();
    }

    public async Task DownloadAsync(IEnumerable<MusicTrack> tracks)
    {
        FamilyHubApi api;
        OfflineLibrary offline;
        CancellationTokenSource cancellation;
        int version;
        await connectionLock.WaitAsync();
        try
        {
            if (!Connected || Api is null || Offline is null) throw new InvalidOperationException("Connect to download songs.");
            if (downloadCancellation is not null) throw new InvalidOperationException("A download is already running.");
            api = Api; offline = Offline; version = accountVersion;
            cancellation = downloadCancellation = new CancellationTokenSource();
            DownloadFailure = null;
        }
        finally { connectionLock.Release(); }
        using var cancellationScope = cancellation;
        var quality = DownloadQuality;
        var networkPaused = false;
        void NetworkChanged(object? sender, Microsoft.Maui.Networking.ConnectivityChangedEventArgs args)
        {
            if (DownloadsWifiOnly && !HomeConnection) { networkPaused = true; cancellation.Cancel(); }
        }
        Microsoft.Maui.Networking.Connectivity.Current.ConnectivityChanged += NetworkChanged;
        try
        {
            EnsurePlaybackCaches();
            var selected = tracks.Select(CurrentRecording).DistinctBy(t => t.Id).ToList();
            pendingDeviceDownloads = System.Collections.Immutable.ImmutableHashSet.CreateRange(selected.Select(track => track.Id));
            for (var index = 0; index < selected.Count; index++)
            {
                var original = selected[index];
                pendingDeviceDownloads = pendingDeviceDownloads.Remove(original.Id);
                DownloadingId = original.Id; Progress = null;
                DownloadStatus = $"Downloading {index + 1} of {selected.Count} · {original.Title}";
                Changed?.Invoke();
                cancellation.Token.ThrowIfCancellationRequested();
                if (DownloadsWifiOnly && !HomeConnection)
                    throw new InvalidOperationException("Connect to Wi-Fi or Ethernet to keep songs offline, or turn off Wi-Fi-only downloads in settings.");
                MusicTrack track;
                using (var preparation = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token))
                {
                    preparation.CancelAfter(TimeSpan.FromMinutes(10));
                    var recording = await EnsureServerRecordingAsync(original, preparation.Token, background: true, prefetch: true);
                    track = await PlaybackEditionAsync(recording, api, quality, preparation.Token);
                }
                EnsureCurrent(version);
                Progress = new(0, track.DownloadSize);
                DownloadProgressChanged?.Invoke();
                await offline.DownloadAsync(track, api, cancellation.Token,
                    new Progress<DownloadProgress>(value =>
                    {
                        if (version != accountVersion || !ReferenceEquals(downloadCancellation, cancellation) || DownloadingId != track.Id) return;
                        Progress = value; DownloadProgressChanged?.Invoke();
                    }), playbackCaches.GetValueOrDefault(quality));
                await downloadIndex.WaitAsync();
                try
                {
                    EnsureCurrent(version);
                    Downloads = Downloads.Where(t => t.Id != track.Id).Append(track).ToList();
                    DownloadedBytes = Downloads.Sum(t => t.DownloadSize);
                }
                finally { downloadIndex.Release(); }
                Changed?.Invoke();
            }
            if (version == accountVersion) UpdateMessage(selected.Count == 1 ? "Song downloaded." : "Songs downloaded.", "success");
        }
        catch (Exception) when (cancellation.IsCancellationRequested)
        { if (version == accountVersion) UpdateMessage(networkPaused ? "Download paused. Connect to Wi-Fi, then download again." : "Download paused. Download again to resume.", "warning"); }
        catch (Exception error)
        {
            if (version == accountVersion && DownloadingId is { } id)
                DownloadFailure = (id, DownloadErrorMessage(error));
            throw;
        }
        finally
        {
            Microsoft.Maui.Networking.Connectivity.Current.ConnectivityChanged -= NetworkChanged;
            pendingDeviceDownloads = [];
            downloadCancellation = null; DownloadingId = null; Progress = null; DownloadStatus = ""; Changed?.Invoke();
        }
    }

    public static string DownloadErrorMessage(Exception error) => error switch
    {
        FamilyHubApiException { StatusCode: 401 } => "Sign in to the server again.",
        FamilyHubApiException or HttpRequestException => "The server could not send the audio. Check the connection.",
        OperationCanceledException => "The download timed out.",
        InvalidDataException => "The audio did not pass verification.",
        EndOfStreamException => "The audio transfer was interrupted.",
        IOException or UnauthorizedAccessException => "The device could not save the audio. Check available storage.",
        InvalidOperationException => error.Message,
        _ => "The song could not be downloaded."
    };

    public void CancelDownload() => downloadCancellation?.Cancel();
    public Task RemoveDownloadAsync(MusicTrack track) => RemoveDownloadsAsync([track]);

    public async Task RemoveDownloadsAsync(IReadOnlyList<MusicTrack> tracks)
    {
        if (DownloadingId is { } id && tracks.Any(track => track.Id == id))
            throw new InvalidOperationException("Pause this download before removing it.");
        if (Offline is not { } offline || tracks.Count == 0) return;
        var version = accountVersion;
        try
        {
            foreach (var track in tracks)
            {
                EnsureCurrent(version);
                await offline.RemoveDownloadAsync(track.Id);
            }
        }
        finally
        {
            if (version == accountVersion) await ReadDownloadsAsync();
        }
        if (version == accountVersion) SetMessage(tracks.Count == 1 ? "Song removed from this device." : "Songs removed from this device.", "success");
    }

    private static readonly (string Quality, string Folder)[] PlaybackCacheTiers =
    [
        ("max", "playback"),
        ("normal", "playback-lower"),
        ("low", "playback-low"),
        ("high", "playback-high"),
    ];

    private void EnsurePlaybackCaches()
    {
        if (string.IsNullOrEmpty(User) || string.IsNullOrEmpty(Server)) return;
        if (playbackCaches.Count == 0)
        {
            var uri = new Uri(Server);
            foreach (var (quality, folder) in PlaybackCacheTiers)
                playbackCaches[quality] = new OfflineLibrary(Path.Combine(FileSystem.CacheDirectory, folder), uri, User);
        }
    }

    private OfflineLibrary? PlaybackCache
    {
        get
        {
            EnsurePlaybackCaches();
            return playbackCaches.GetValueOrDefault(ActiveStreamingQuality);
        }
    }

    public static string TierVersion(string quality) => quality switch
    {
        "low" => "opus48-v2",
        "normal" => "opus96-v2",
        "high" => "opus160-v2",
        _ => throw new ArgumentException("Choose Low, Normal or High quality.")
    };

    public void PinPlayback(string? trackId) => Volatile.Write(ref playingCacheId, trackId);
    public void PinPreparingPlayback(string? trackId) => Volatile.Write(ref preparingCacheId, trackId);
    public void PinUpcomingPlayback(string? trackId) => Volatile.Write(ref upcomingCacheId, trackId);
    public void PinPreparingNextPlayback(string? trackId) => Volatile.Write(ref preparingNextCacheId, trackId);
    private bool PlaybackPinned(string trackId) =>
        Volatile.Read(ref playingCacheId) == trackId || Volatile.Read(ref preparingCacheId) == trackId ||
        Volatile.Read(ref upcomingCacheId) == trackId || Volatile.Read(ref preparingNextCacheId) == trackId;

    public async Task<string?> GetCachedPlaybackPathAsync(MusicTrack track, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var version = accountVersion;
        var quality = ActiveStreamingQuality;
        var cache = PlaybackCache;
        if (cache is null || !track.Saved || string.IsNullOrEmpty(track.DownloadSha256)) return null;
        if (quality != "max")
        {
            var expectedVersion = TierVersion(quality);
            var compressed = (await cache.ListDownloadsAsync(cancellationToken)).FirstOrDefault(t =>
                t.Id == track.Id && t.PlaybackSourceSha256 == track.DownloadSha256
                    && (!Connected || t.PlaybackVersion == expectedVersion));
            if (compressed is not null) track = compressed;
        }
        string? path;
        try { path = await cache.GetVerifiedDownloadedPathAsync(track, cancellationToken); }
        catch (InvalidDataException) { return null; }
        EnsureCurrent(version);
        if (path is not null) { playbackRecords[path] = track; TouchPlayback(path); }
        return path;
    }

    public bool CanStream => true;
    public static bool IsStream(string source) => source.StartsWith("https://", StringComparison.Ordinal);

    internal void ReportPlaybackStage(string action, string stage, long elapsed)
    {
        if (Connected && Api is { } api && elapsed is >= 0 and <= 3600000)
            _ = SendPlaybackStageAsync(api, action, stage, elapsed);
    }
    private static async Task SendPlaybackStageAsync(FamilyHubApi api, string action, string stage, long elapsed)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try
        {
            await api.RequestJsonAsync<JsonElement>(HttpMethod.Post, "/api/playback/diagnostics",
                new { action, stage, elapsed_ms = elapsed }, timeout.Token, background: true);
        }
        catch (Exception error) when (error is HttpRequestException or FamilyHubApiException or OperationCanceledException
            or ObjectDisposedException or JsonException or IOException or InvalidDataException) { }
    }

    public async Task<string> StreamPlaybackAsync(MusicTrack track, double lead, CancellationToken cancellationToken, bool background = false, string? action = null)
    {
        var api = OnlineApi();
        var version = accountVersion;
        cancellationToken.ThrowIfCancellationRequested();
        if (track.PlaybackVersion is "preview-hls" or "preview-source" && track.StreamUrl.Length > 0)
        {
            var preview = api.ResolveUri(track.StreamUrl).AbsoluteUri;
            playbackRecords[preview] = track;
            return preview;
        }
        track = CurrentRecording(track);
        if (track.PlaybackInfoUrl != $"/api/library/{track.Id}/playback-info")
            throw new InvalidDataException("Streaming is unavailable for this recording.");
        var url = PlaybackInfoUrl(track, ActiveStreamingQuality, lead) + "&stream=1";
        if (action is not null) url += "&play_action=" + Uri.EscapeDataString(action);
        var info = await api.RequestJsonAsync<MusicTrack>(HttpMethod.Get, url, cancellationToken: cancellationToken, background: background);
        cancellationToken.ThrowIfCancellationRequested();
        EnsureCurrent(version);
        if (info.Id != track.Id || info.StreamUrl.Length == 0) throw new InvalidDataException("The stream link does not match this recording.");
        var stream = api.ResolveUri(info.StreamUrl).AbsoluteUri;
        playbackRecords[stream] = info;
        return stream;
    }

    // lead: seconds until the song is needed, so the server encodes the song needed soonest first.
    private static string PlaybackInfoUrl(MusicTrack track, string quality, double lead) =>
        $"{track.PlaybackInfoUrl}?quality={quality}&lead={Math.Clamp(lead, 0, 3600).ToString("0", System.Globalization.CultureInfo.InvariantCulture)}";

    public async Task<string> CachePlaybackAsync(MusicTrack track, CancellationToken cancellationToken, double lead = 0, bool background = false)
    {
        track = CurrentRecording(track);
        cancellationToken.ThrowIfCancellationRequested();
        var local = LocalPath(track) ?? await GetCachedPlaybackPathAsync(track, cancellationToken);
        if (local is not null) return local;
        var api = OnlineApi();
        var version = accountVersion;
        var quality = ActiveStreamingQuality;
        EnsurePlaybackCaches();
        var cache = playbackCaches[quality];
        track = await PlaybackEditionAsync(track, api, quality, cancellationToken, lead, background);
        EnsureCurrent(version);
        var path = await cache.DownloadAsync(track, api, cancellationToken, background: background);
        cancellationToken.ThrowIfCancellationRequested();
        EnsureCurrent(version);
        playbackRecords[path] = track;
        TouchPlayback(path);
        cachedEditions[track.Id] = string.IsNullOrEmpty(track.PlaybackSourceSha256) ? track.DownloadSha256 : track.PlaybackSourceSha256;
        // Cache maintenance must not delay handing verified audio to the player.
        var caches = playbackCaches.Values.ToArray();
        _ = Task.Run(async () => { await ReadPlaybackAvailabilityAsync(version, caches); await PrunePlaybackCacheAsync(caches, version); });
        return path;
    }

    private static async Task<MusicTrack> PlaybackEditionAsync(MusicTrack track, FamilyHubApi api, string quality, CancellationToken token, double lead = 0, bool background = false)
    {
        if (quality == "max") return track;
        if (track.PlaybackInfoUrl != $"/api/library/{track.Id}/playback-info")
            throw new InvalidDataException("Audio quality is unavailable for this recording. Refresh the library and try again.");
        var url = PlaybackInfoUrl(track, quality, lead);
        var compressed = await api.RequestJsonAsync<MusicTrack>(HttpMethod.Get, url, cancellationToken: token, background: background);
        if (compressed.Id != track.Id || compressed.PlaybackSourceSha256 != track.DownloadSha256)
            throw new InvalidDataException("The playback copy does not match this recording.");
        return compressed;
    }

    private async Task PrunePlaybackCacheAsync(OfflineLibrary[] caches, int version)
    {
        if (!await cacheMaintenance.WaitAsync(0)) return;
        try
        {
            var entries = new List<(OfflineLibrary Cache, MusicTrack Track, string Path)>();
            foreach (var cache in caches)
                foreach (var track in await cache.ListDownloadsAsync())
                    if (cache.GetDownloadedPath(track.Id) is { } path) entries.Add((cache, track, path));
            long retainedBytes = 0;
            foreach (var item in entries.OrderByDescending(item => File.GetLastAccessTimeUtc(item.Path)))
            {
                retainedBytes += item.Track.DownloadSize;
                // Recent selections may still be opening; leave them for the next cleanup.
                if (retainedBytes <= (long)CacheLimitGb * 1024 * 1024 * 1024
                    || File.GetLastAccessTimeUtc(item.Path!) > DateTime.UtcNow.AddMinutes(-2)) continue;
                if (PlaybackPinned(item.Track.Id)) continue;
                try
                {
                    await item.Cache.RemoveDownloadAsync(item.Track.Id, canRemove: () => !PlaybackPinned(item.Track.Id));
                    playbackRecords.TryRemove(item.Path, out _);
                    if (version == accountVersion && caches.All(cache => cache.GetDownloadedPath(item.Track.Id) is null))
                        cachedEditions.TryRemove(item.Track.Id, out _);
                }
                catch (IOException) { }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        finally { cacheMaintenance.Release(); }
        await ReadPlaybackAvailabilityAsync(version, caches);
    }

    private static void TouchPlayback(string path)
    {
        try { File.SetLastAccessTimeUtc(path, DateTime.UtcNow); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private FamilyHubApi OnlineApi() => Connected && Api is not null ? Api : throw new InvalidOperationException("Connect to edit playlists or search.");
    private void EnsureCurrent(int version)
    { if (version != accountVersion) throw new OperationCanceledException("The server account changed."); }
    private sealed record RadioResponse(MusicPlaylist Playlist);
    /// <summary>"Song Radio": a new playlist of similar songs the server finds and downloads.</summary>
    public async Task<MusicPlaylist> StartRadioAsync(string artist, string title = "")
    {
        var version = accountVersion;
        var created = await OnlineApi().RequestJsonAsync<RadioResponse>(HttpMethod.Post, "/api/radio", new { artist, title });
        EnsureCurrent(version);
        Playlists.Add(created.Playlist); await SavePlaylistsAsync();
        return created.Playlist;
    }
    public async Task<MusicPlaylist> CreatePlaylistAsync(string name)
    {
        var version = accountVersion;
        var playlist = await OnlineApi().CreatePlaylistAsync(name);
        EnsureCurrent(version);
        Playlists.Add(playlist); await SavePlaylistsAsync();
        return playlist;
    }
    private sealed record ProfileImageResponse(ListenerProfile Profile);
    public async Task SetProfileImageAsync(string dataUri)
    {
        var version = accountVersion;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var result = await OnlineApi().RequestJsonAsync<ProfileImageResponse>(HttpMethod.Post,
            "/api/profile/image", new { image = dataUri }, timeout.Token);
        EnsureCurrent(version);
        if (result.Profile.Id != User) throw new InvalidDataException("The profile image belongs to another listener.");
        var index = Profiles.FindIndex(p => p.Id == User);
        if (index >= 0) Profiles[index] = result.Profile;
        StoreProfiles(Server, Profiles);
        Changed?.Invoke();
    }

    private sealed record ImportedPlaylist(MusicPlaylist Playlist);
    public async Task ImportPlaylistAsync(MusicPlaylist target, string provider, string url)
    {
        if (!target.CanEdit || target.Tracks.Count != 0) throw new InvalidOperationException("Choose an empty playlist you own.");
        if (provider is not ("spotify" or "youtube")) throw new ArgumentException("Invalid playlist provider.");
        var version = accountVersion;
        var response = await OnlineApi().RequestJsonAsync<ImportedPlaylist>(HttpMethod.Post,
            "/api/playlists/" + provider, new { url, target_id = target.Id, revision = target.Revision });
        EnsureCurrent(version);
        var index = Playlists.FindIndex(p => p.Id == target.Id && p.OwnerId == target.OwnerId);
        if (index >= 0) Playlists[index] = response.Playlist;
        await SavePlaylistsAsync();
    }

    public async Task EditPlaylistAsync(MusicPlaylist playlist, object mutation)
    {
        if (!playlist.CanEdit) throw new InvalidOperationException("Only the owner or a co-author can edit it.");
        var version = accountVersion;
        try
        {
            var updated = await OnlineApi().UpdatePlaylistAsync(playlist.Id, playlist.Revision, mutation, ownerId: playlist.OwnerId);
            EnsureCurrent(version);
            var index = Playlists.FindIndex(p => p.Id == playlist.Id && p.OwnerId == playlist.OwnerId);
            if (index < 0) { await RefreshAsync(); return; }
            Playlists[index] = updated;
            await SavePlaylistsAsync();
        }
        catch (FamilyHubApiException error) when (error.StatusCode == 409)
        { EnsureCurrent(version); await RefreshAsync(); throw new InvalidOperationException(error.Message); }
    }
    public async Task DeletePlaylistAsync(MusicPlaylist playlist)
    {
        if (!playlist.CanDelete) throw new InvalidOperationException("Only an admin can delete playlists.");
        var version = accountVersion;
        try { await OnlineApi().DeletePlaylistAsync(playlist.Id, playlist.Revision, playlist.OwnerId); }
        catch (FamilyHubApiException error) when (error.StatusCode == 409)
        { EnsureCurrent(version); await RefreshAsync(); throw new InvalidOperationException(error.Message); }
        EnsureCurrent(version);
        Playlists.RemoveAll(p => p.Id == playlist.Id && p.OwnerId == playlist.OwnerId); await SavePlaylistsAsync();
    }
    private async Task SavePlaylistsAsync()
    { if (Offline is not null) await Offline.SavePlaylistsAsync(Playlists); Changed?.Invoke(); }

    private string savedQueueIdentity = "";
    private readonly SemaphoreSlim playbackSaveGate = new(1, 1);
    private sealed record SavedPlayback(string ProfileId, PlaybackResume? Playback)
    {
        [JsonPropertyName("profile_id")] public string ProfileId { get; init; } = ProfileId;
    }
    public void SavePlaybackLocally(PlaybackResume? value)
    {
        if (value is not { IsValid: true } || Offline is null) return;
        try { Offline.SavePlayback(value with { UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
    public async Task SavePlaybackAsync(PlaybackResume? value, bool background = false)
    {
        SavePlaybackLocally(value);
        if (value is not { IsValid: true } || !Connected || Api is null) return;
        var owner = User; var api = Api; var version = accountVersion;
        await playbackSaveGate.WaitAsync();
        try
        {
            if (version != accountVersion) return;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            var identity = Server + "|" + owner + "|" + string.Join(",", value.TrackIds);
            var full = identity != savedQueueIdentity;
            try
            {
                await api.RequestJsonAsync<SavedPlayback>(full ? HttpMethod.Put : HttpMethod.Patch, "/api/profile/playback",
                    new { profile_id = owner, playback = full ? (object)value : new { track_id = value.TrackIds[value.Index], index = value.Index, position = value.Position } }, timeout.Token, background);
                savedQueueIdentity = identity;
            }
            catch (FamilyHubApiException) { savedQueueIdentity = ""; throw; }
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or FamilyHubApiException or JsonException) { }
        finally { playbackSaveGate.Release(); }
    }
    public async Task<PlaybackResume?> GetPlaybackAsync()
    {
        var local = Offline?.GetPlayback();
        var owner = User; var version = accountVersion;
        if (Connected && Api is not null)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
                var remote = await Api.RequestJsonAsync<SavedPlayback>(HttpMethod.Get, "/api/profile/playback", cancellationToken: timeout.Token, background: true);
                EnsureCurrent(version);
                if (remote.ProfileId == owner && remote.Playback is { IsValid: true } state && (local is null || state.UpdatedAt > local.UpdatedAt))
                { Offline?.SavePlayback(state); return state; }
            }
            catch (Exception error) when (error is HttpRequestException or OperationCanceledException or FamilyHubApiException or IOException or JsonException) { }
        }
        return version == accountVersion ? local : null;
    }
    public async Task<List<MusicTrack>> SearchAsync(string query, CancellationToken cancellationToken = default) =>
        (await SearchPageAsync(query, 0, cancellationToken)).Tracks;
    public async Task<SearchPage> SearchPageAsync(string query, int offset, CancellationToken cancellationToken = default, bool background = false)
    {
        var version = accountVersion;
        var result = await OnlineApi().RequestJsonAsync<SearchPage>(HttpMethod.Post, "/api/search", new { query, offset }, cancellationToken, background);
        EnsureCurrent(version);
        return result;
    }
    public List<MusicTrack> AutoplayQueue(MusicTrack seed)
    {
        var similar = Library.Where(t => t.Id != seed.Id && Similarity.IsSimilar(seed, t))
            .DistinctBy(Similarity.SongKey).ToArray();
        return [seed, .. RankRecommendations(similar).Take(30)];
    }
    public async Task<List<MusicTrack>> SimilarAsync(MusicTrack seed)
    {
        if (!Connected) return RankRecommendations(Downloads.Where(t => t.Id != seed.Id && Similarity.IsSimilar(seed, t)));
        var version = accountVersion;
        var artist = Similarity.Artist(seed);
        if (string.IsNullOrEmpty(artist)) return [];
        var candidates = new List<MusicTrack>();
        string? seedGenre = null; int? offset = 0;
        for (var page = 0; page < 4 && offset is not null; page++)
        {
            var result = await OnlineApi().RequestJsonAsync<Results>(HttpMethod.Post, "/api/recommendations",
                new { query = artist[..Math.Min(artist.Length, 120)] + " official audio", seed_artist = artist[..Math.Min(artist.Length, 120)], offset = offset.Value },
                background: page > 0);
            EnsureCurrent(version); seedGenre ??= result.SeedGenre;
            candidates.AddRange(result.Tracks); offset = result.NextOffset;
        }
        var anchor = seed with { Genre = string.IsNullOrEmpty(seed.Genre) || seed.Genre == "Unsorted" ? seedGenre ?? "" : seed.Genre };
        return RankRecommendations(candidates.Concat(Library).Where(t => t.Id != seed.Id && Similarity.IsSimilar(anchor, t))
            .DistinctBy(Similarity.SongKey));
    }

    public async Task<MusicTrack> EnsureServerRecordingAsync(MusicTrack track, CancellationToken cancellationToken, bool allowPreview = false,
        bool background = false, bool prefetch = false, string? action = null, bool fallback = false)
    {
        if (!string.IsNullOrEmpty(track.DownloadUrl)) return track;
        var version = accountVersion;
        var api = OnlineApi();
        var created = await api.RequestJsonAsync<JsonElement>(HttpMethod.Post, "/api/jobs",
            new { url = track.Url, title = track.Title, channel = track.Channel, allow_new = true, prefetch, play_action = action }, cancellationToken, background);
        var job = created.GetProperty("job");
        var id = job.GetProperty("id").GetString();
        while (true)
        {
            if (allowPreview && job.TryGetProperty("source_id", out var source) && source.GetString() == track.Id)
            {
                EnsureCurrent(version);
                if (!fallback && job.TryGetProperty("stream_url", out var preview) && preview.GetString() is { Length: > 0 } url)
                    return track with { StreamUrl = url, PlaybackVersion = "preview-hls" };
                if (job.TryGetProperty("fallback_stream_url", out var original) && original.GetString() is { Length: > 0 } originalUrl)
                    return track with { StreamUrl = originalUrl, PlaybackVersion = "preview-source" };
            }
            if (job.GetProperty("state").GetString() is not ("queued" or "running")) break;
            await Task.Delay(allowPreview ? 300 : 1000, cancellationToken);
            job = (await api.RequestJsonAsync<JsonElement>(HttpMethod.Get, "/api/jobs/" + id, cancellationToken: cancellationToken, background: true)).GetProperty("job");
        }
        if (job.GetProperty("state").GetString() != "done")
        {
            var message = job.TryGetProperty("message", out var detail) && detail.ValueKind == JsonValueKind.String
                ? detail.GetString() : null;
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(message)
                ? "The server could not prepare this recording." : message);
        }
        EnsureCurrent(version);
        await RefreshAsync(background: true);
        EnsureCurrent(version);
        return Library.FirstOrDefault(t => t.Id == track.Id) ?? throw new InvalidOperationException("The recording is not in the server library yet. Refresh and try again.");
    }

    private sealed record Connection(string Server, string User, string? ProfileName = null);
    private sealed record CachedPreferences(ListenerPreferences Value, bool Dirty);
    private sealed record Results
    {
        [JsonPropertyName("results")] public List<MusicTrack> Tracks { get; init; } = [];
        [JsonPropertyName("next_offset")] public int? NextOffset { get; init; }
        [JsonPropertyName("seed_genre")] public string SeedGenre { get; init; } = "";
    }
}
