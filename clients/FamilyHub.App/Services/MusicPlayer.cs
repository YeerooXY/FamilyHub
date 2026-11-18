using CommunityToolkit.Maui.Views;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public sealed class MusicPlayer(MusicSession session)
{
    private IAudioDeck? deck, standby;
    private CancellationTokenSource? preparation, upcomingPreparation;
    private readonly List<MusicTrack> queue = [];
    private readonly HashSet<MusicTrack> manualQueue = new(ReferenceEqualityComparer.Instance);
    // The chosen list's own order; shuffle only reorders the queue, so turning it off restores this.
    private List<MusicTrack> order = [];
    private int index = -1, blendTarget = -1;
    private long requestVersion;
    private bool preparing, sourceReady, blending, warming, incomingFailed;
    private double volume = 1, blendGain, listenedSeconds, lastListeningPosition;
    private bool listenRecorded, eventFinalized;
    private bool lastSamplePlaying;
    private long lastListeningSample;
    private DateTimeOffset? eventStarted, incomingStarted;
    private string incomingOwner = "";
    private string eventOwner = "", eventSource = "library", queueSource = "library";
    private void FinishListening(string outcome)
    {
        RecordListening();
        if (!eventFinalized && !FollowingHost && !RemoteActive && Current is { } track && eventStarted is { } started)
            session.QueueListeningEvent(track, started, listenedSeconds, Duration > 0 ? Duration : track.Duration,
                Position, outcome, eventSource, eventOwner);
        eventFinalized = true; eventStarted = null;
    }

    private void FinishIncomingListening(string outcome)
    {
        if (incomingStarted is { } started && !FollowingHost && standby is { } audible && preparedTrack is { } track)
            session.QueueListeningEvent(track, started, audible.Position, audible.Duration, audible.Position, outcome,
                manualQueue.Contains(track) ? "queue" : queueSource == "search" ? "auto_dj" : queueSource, incomingOwner);
        incomingStarted = null;
    }
    private string? attemptedNext;
    private bool nextChosen;
    private long retryUpcomingAt;
    private double? resumePosition;
    private bool resumeStartPending;
    private MusicTrack? preparedTrack;
    private long lastProgressNotice;
    private (bool Playing, bool Opening, bool Requested, double Duration) lastDeckTransport;
    private long lastHostControl = -1, lastDriftSeek;
    private double filteredDrift;
    private int largeDriftSamples, driftDirection;
    public long UserPlaybackRevision { get; private set; }
    public long ControlRevision { get; private set; }
    public long SeekRevision { get; private set; }
    private int syncSeeks;
    public bool UiActive { get; set; } = true;
    public event Action? Changed;
    public MusicTrack? Current { get; private set; }
    public IReadOnlyList<MusicTrack> Queue => queue;
    private MusicTrack[]? queueSnapshot;
    public IReadOnlyList<MusicTrack> QueueSnapshot => queueSnapshot ??= queue.ToArray();
    public int QueueIndex => index;
    public double Volume => volume;
    public bool Shuffle { get; private set; }
    private string repeatMode = "off";
    public string RepeatMode
    {
        get => repeatMode;
        set
        {
            if (value is not ("off" or "all" or "one")) throw new ArgumentException("Choose repeat off, all or one.");
            if (repeatMode == value) return;
            RequirePlaybackControl(); repeatMode = value;
            if (!blending) CancelUpcoming();
            Changed?.Invoke(); if (Playing) WarmNext();
        }
    }
    public bool AutoDj { get; set; } = true;
    /// <summary>Crossfade length in seconds while AutoDj is on (the "Crossfade songs" setting).</summary>
    public double CrossfadeSeconds { get; set; } = CrossfadeEnvelope.Seconds;
    public bool Crossfading => blending;
    public double FadePosition => blending ? standby?.Position ?? 0 : 0;
    public double FadeDuration => CrossfadeEnvelope.Duration(Duration, CrossfadeSeconds);
    public double FadeElapsed => blending ? blendGain * FadeDuration : 0;
    private bool followingHost;
    public bool FollowingHost
    {
        get => followingHost;
        set
        {
            if (followingHost == value) return;
            FinishListening("stopped"); FinishIncomingListening("stopped"); followingHost = value;
            eventStarted = null; eventFinalized = true;
        }
    }
    /// <summary>The device this profile's playback was sent to from here; empty while playing here.</summary>
    public string RemoteDeviceName { get; private set; } = "";
    public string RemoteDeviceId { get; private set; } = "";
    public bool RemoteActive => RemoteDeviceId.Length > 0;
    /// <summary>True while the "playing on another device" bar stands in for this device's own player bar.</summary>
    public bool RemotePeek { get; private set; }
    public void SetRemotePeek(bool value) { if (RemotePeek == value) return; RemotePeek = value; Changed?.Invoke(); }
    /// <summary>Whether the device this profile's music was sent to is playing (as last reported).</summary>
    public bool RemotePlaying { get; private set; }
    private long remoteAt;
    private double remoteValidFor = PlaybackDevice.OnlineSeconds, remoteDuration;

    // Remote mode: this device's copy of the queue follows the other device; resumePosition holds
    // its position, and the transport buttons send actions there instead of playing here.
    public void EnterRemote(string deviceId, string name, double position, bool playing)
    {
        if (FollowingHost) return;
        FinishListening("stopped");
        RemoteDeviceId = deviceId; RemoteDeviceName = name; RemotePlaying = playing; remoteAt = System.Diagnostics.Stopwatch.GetTimestamp();
        remoteValidFor = PlaybackDevice.OnlineSeconds; remoteDuration = 0;
        ++requestVersion; preparation?.Cancel(); preparation = null;
        preparing = false; PlaybackRequested = false; sourceReady = false; resumeStartPending = false;
        CancelUpcoming();
        if (deck is not null) { deck.TransportEnabled = false; deck.SetPlaying(false); }
        session.PinPreparingPlayback(null);
        resumePosition = Math.Max(0, position); ControlRevision++;
        Changed?.Invoke();
    }
    public void ApplyRemoteState(string trackId, bool playing, double? position, double age = 0, double? duration = null)
    {
        if (!RemoteActive) return;
        var at = trackId != Current?.Id && trackId.Length > 0 ? queue.FindIndex(t => t.Id == trackId) : -1;
        if (at >= 0 && at != index) { index = at; Current = queue[at]; }
        resumePosition = position is { } seconds ? Math.Max(0, seconds) : Position;
        remoteAt = System.Diagnostics.Stopwatch.GetTimestamp();
        remoteValidFor = Math.Max(0, PlaybackDevice.OnlineSeconds - age); remoteDuration = duration ?? 0;
        RemotePlaying = playing && remoteValidFor > 0;
        Changed?.Invoke();
    }
    /// <summary>Redraws the position while the other device plays (MainPage calls it twice a second).</summary>
    public event Action? RemotePositionChanged;
    public bool SeekBarVisible { get; private set; }
    public event Action? SeekBarVisibilityChanged;
    public void SetSeekBarVisible(bool visible)
    {
        if (SeekBarVisible == visible) return;
        SeekBarVisible = visible; SeekBarVisibilityChanged?.Invoke();
    }
    public void RemoteTick() { if (RemoteActive && RemotePlaying) RemotePositionChanged?.Invoke(); }
    /// <summary>Ends remote mode; the queue stays at the other device's song and position.</summary>
    public void LeaveRemote()
    {
        if (!RemoteActive) return;
        resumePosition = Position;
        RemoteDeviceId = RemoteDeviceName = ""; RemotePlaying = false;
        Changed?.Invoke();
    }
    private async Task SendRemoteAsync(string action, double? position = null)
    {
        var target = RemoteDeviceId;
        if (session.Api is not { } api || target.Length == 0) return;
        try { await api.ControlPlaybackAsync(session.DeviceId, target, action, position); }
        catch (Exception error) when (error is HttpRequestException or FamilyHubApiException or OperationCanceledException)
        { await MainThread.InvokeOnMainThreadAsync(LeaveRemote); }
    }
    private Task RemoteToggleAsync()
    {
        if (!RemotePlaying) { LeaveRemote(); return ToggleCoreAsync(true); }
        resumePosition = Position; RemotePlaying = false; Changed?.Invoke();
        return SendRemoteAsync("pause");
    }
    public Task PauseLocallyAsync(bool background = true) => MainThread.InvokeOnMainThreadAsync(() =>
    {
        if (!background) UserPlaybackRevision++;
        PlaybackRequested = false; deck?.SetPlaying(false); standby?.SetPlaying(false);
        if (blending) CancelUpcoming();
        Changed?.Invoke();
    });
    private void RequirePlaybackControl()
    {
        if (FollowingHost) throw new InvalidOperationException("The host controls playback. Leave Listen Together to choose your own music.");
    }
    public bool PlaybackRequested { get; private set; }
    public bool Preparing => preparing || (deck?.Opening ?? false);
    public bool Playing => deck?.Playing ?? false;
    public double Position => (!sourceReady || resumeStartPending) && resumePosition is { } saved
        ? RemoteActive && RemotePlaying ? Math.Min(saved + Math.Min(remoteValidFor, System.Diagnostics.Stopwatch.GetElapsedTime(remoteAt).TotalSeconds),
            remoteDuration > 0 ? remoteDuration : Current?.Duration is > 0 and var length ? length : double.MaxValue) : saved
        : deck?.Position ?? 0;
    public double Duration => !sourceReady && resumePosition is not null ? Current?.Duration ?? 0 : deck?.Duration ?? 0;
    public bool Seeking { get; private set; }
    public bool CanSeek => (sourceReady || resumePosition is not null) && !Preparing && !Seeking && Duration > 0;
#if DEBUG
    internal object PlaybackState() => new
    {
        current = Current?.Id, position = Position, duration = Duration, playing = Playing,
        preparing = Preparing, crossfading = blending, gain = blendGain,
        next = preparedTrack?.Id, nextPosition = standby?.Position ?? 0,
        nextPlaying = standby?.Playing ?? false, nextReady = IncomingReady,
        outgoingVolume = deck?.Volume ?? 0, incomingVolume = standby?.Volume ?? 0,
        queueIndex = index, queueCount = queue.Count, queue = queue.Select(t => new { id = t.Id, title = t.Title }).ToArray(),
        playbackRate = deck?.PlaybackRate ?? 1, syncSeeks, filteredDrift
    };
#endif

    public PlaybackResume? CaptureResume() => Current is not null && !RemoteActive && !FollowingHost && !Preparing && index >= 0 && queue.Count <= 1000
        ? new() { TrackIds = queue.Select(t => t.Id).ToList(), Index = index, Position = Math.Max(0, Position) } : null;
    public void RestoreResume(PlaybackResume state, IEnumerable<MusicTrack> available)
    {
        if (Current is not null && (sourceReady || preparing || PlaybackRequested) || FollowingHost || !state.IsValid) return;
        var recordings = available.DistinctBy(t => t.Id).ToDictionary(t => t.Id);
        if (!recordings.ContainsKey(state.TrackIds[state.Index])) return;
        var restored = state.TrackIds.Select((id, at) => (id, at)).Where(row => recordings.ContainsKey(row.id)).ToList();
        queueSnapshot = null; queue.Clear(); queue.AddRange(restored.Select(row => recordings[row.id]));
        order = queue.ToList();
        index = restored.FindIndex(row => row.at == state.Index); Current = queue[index];
        resumePosition = Current.Duration > 0 ? Math.Min(state.Position, Current.Duration) : state.Position;
        queueSource = "other"; sourceReady = false; PlaybackRequested = false; Changed?.Invoke();
    }
    private async Task ApplyResumePositionAsync()
    {
        if (resumePosition is not { } position || !sourceReady || preparing || Seeking || deck is not { } owner || owner.Opening) return;
        var version = requestVersion;
        if (owner.Duration > 0)
        {
            resumePosition = null;
            try { await SeekDeckAsync(Math.Clamp(position, 0, owner.Duration)); }
            catch (Exception error) when (error is IOException or InvalidOperationException) { }
        }
        if (resumeStartPending && version == requestVersion && ReferenceEquals(deck, owner))
        {
            resumeStartPending = false;
            owner.SetPlaying(PlaybackRequested);
        }
    }

    public void Attach(MediaElement element, MediaElement? nextElement = null)
    {
#if WINDOWS
        AttachDecks(new WindowsAudioPlayer(), nextElement is null ? null : new WindowsAudioPlayer());
#else
        AttachDecks(new MauiAudioDeck(element), nextElement is null ? null : new MauiAudioDeck(nextElement));
#endif
    }
    internal void AttachDecks(IAudioDeck primary, IAudioDeck? secondary)
    {
        deck = primary; standby = secondary;
        Bind(primary); if (secondary is not null) Bind(secondary);
        ApplyVolumes();
    }
    private void Bind(IAudioDeck owner)
    {
        owner.Changed += () =>
        {
            if (ReferenceEquals(deck, owner))
            {
                if (RemoteActive) return;
                if (!preparing && sourceReady && !blending && !resumeStartPending)
                {
                    // Native transport play changes the deck directly; app and remote actions set intent first.
                    if (!PlaybackRequested && owner.PlaybackRequested && !FollowingHost && !RemoteActive) session.MarkLocalPlayback();
                    PlaybackRequested = owner.PlaybackRequested;
                }
                _ = ApplyResumePositionAsync();
                RecordListening();
#if !WINDOWS
                if (owner is MauiAudioDeck mobile) mobile.FastPositionWindow = AutoDj && PlaybackRequested && !FollowingHost && RepeatMode != "one"
                    && !blending && preparedTrack is not null && !incomingFailed && Current?.PlaybackVersion != "preview-hls"
                    && preparedTrack.PlaybackVersion != "preview-hls" && FadeDuration > 0 ? FadeDuration + 2 : 0;
#endif
                var transport = (owner.Playing, owner.Opening, owner.PlaybackRequested, owner.Duration);
                if (transport != lastDeckTransport || UiActive && Environment.TickCount64 - lastProgressNotice >= 1000)
                { lastDeckTransport = transport; lastProgressNotice = Environment.TickCount64; Changed?.Invoke(); }
                if (!preparing && sourceReady && Playing) { WarmNext(); TryBlend(); }
            }
            else if (ReferenceEquals(standby, owner))
            {
                if (blending && owner.Playing && incomingStarted is null && !FollowingHost && !session.PlaybackPreferences.ListeningHistoryPaused)
                { incomingStarted = DateTimeOffset.UtcNow; incomingOwner = session.HistoryOwner; }
                TryBlend();
            }
        };
        owner.Ended += async () =>
        {
            if (!ReferenceEquals(deck, owner) || preparing || blending || !sourceReady || !PlaybackRequested) return;
            try
            {
                FinishListening("completed");
                if (RepeatMode == "one" && !FollowingHost && Current is { } repeated)
                    await PlayCoreAsync(repeated, queue, index, true, true, background: true);
                else if (index + 1 < queue.Count || RepeatMode == "all" && !FollowingHost) await NextCoreAsync(background: true);
                else { PlaybackRequested = false; Changed?.Invoke(); }
            }
            catch (Exception error) { session.SetMessage(error.Message); }
        };
        owner.Failed += message =>
        {
            var streamed = streamedDecks.Remove(owner);
            if (streamed) session.StreamingFailed();
            if (ReferenceEquals(deck, owner))
            {
                // A failed stream retries once from a full download, at the same place in the song.
                if (streamed && PlaybackRequested && Current is { } current && !FollowingHost)
                {
                    if (Position > 0) resumePosition = Position;
                    sourceReady = false;
                    _ = MainThread.InvokeOnMainThreadAsync(() => PlayCoreAsync(current, queue, index, true, true, retry: true, background: true));
                    return;
                }
                FinishListening("stopped"); sourceReady = false; resumeStartPending = false;
                PlaybackRequested = false; session.SetMessage(message); Changed?.Invoke();
            }
            else { FinishIncomingListening("stopped"); incomingFailed = true; preparedTrack = null; if (streamed) attemptedNext = null; }
        };
    }
    private readonly HashSet<IAudioDeck> streamedDecks = [];
    private void MarkStream(IAudioDeck target, string source) { if (MusicSession.IsStream(source)) streamedDecks.Add(target); else streamedDecks.Remove(target); }
    private void RecordListening()
    {
        var elapsed = Position - lastListeningPosition; lastListeningPosition = Position;
        var now = Environment.TickCount64;
        var sampleSeconds = (now - lastListeningSample) / 1000d;
        lastListeningSample = now;
        var wasPlaying = lastSamplePlaying;
        lastSamplePlaying = sourceReady && Playing && !Seeking;
        if (FollowingHost || RemoteActive || session.PlaybackPreferences.ListeningHistoryPaused)
        {
            eventStarted = null;
            listenedSeconds = 0;
            lastSamplePlaying = false;
            return;
        }
        if (eventStarted is not null && eventOwner != session.HistoryOwner)
        {
            eventStarted = null;
            listenedSeconds = 0;
            elapsed = 0;
        }
        if (sourceReady && Playing && !eventFinalized && eventStarted is null)
        { eventStarted = DateTimeOffset.UtcNow; eventOwner = session.HistoryOwner; }
        if (eventStarted is not null && sourceReady && !Seeking && (Playing || wasPlaying)
            && elapsed > 0 && (elapsed < 5 || elapsed <= sampleSeconds + 2)) listenedSeconds += elapsed;
        if (!listenRecorded && sourceReady && Playing && Current is { } track && listenedSeconds >= Math.Min(30, Duration > 0 ? Duration / 2 : 30))
        { session.RecordListen(track); listenRecorded = true; }
    }
    public Task PlayAsync(MusicTrack track, IEnumerable<MusicTrack>? sequence = null, int? sequenceStartIndex = null, string source = "library")
    {
        RequirePlaybackControl();
        return MainThread.InvokeOnMainThreadAsync(() =>
        {
            UserPlaybackRevision++;
            session.MarkLocalPlayback();
            LeaveRemote();
            FinishListening("skipped"); queueSource = source;
            return PlayCoreAsync(track, sequence, sequenceStartIndex, true);
        });
    }

    public Task SynchronizeHostAsync(IReadOnlyList<MusicTrack> tracks, int targetIndex, double position, bool playing, bool autoDj, bool hostBlending,
        double fadePosition = 0, double fadeElapsed = 0, double fadeDuration = 6, long controlRevision = 0) =>
        MainThread.InvokeOnMainThreadAsync(async () =>
        {
            if (!FollowingHost || deck is null) return;
            AutoDj = autoDj;
            if ((blending && targetIndex == blendTarget) ||
                (hostBlending && index == targetIndex + 1 && index < tracks.Count && Current?.Id == tracks[index].Id))
            {
                deck.PlaybackRate = 1; if (standby is not null) standby.PlaybackRate = 1;
                // Polls can straddle the end of a fade; never jump back to its outgoing song.
                PlaybackRequested = playing; deck.SetPlaying(playing); if (blending) standby?.SetPlaying(playing);
                return;
            }
            if (Current?.Id != tracks[targetIndex].Id || index != targetIndex)
            {
                // Prepare silently, then use a fresh host position on the next poll.
                await PlayCoreAsync(tracks[targetIndex], tracks, targetIndex, false, background: true);
                return;
            }
            if (Preparing || !sourceReady) return;
            if (!blending && !queue.Select(t => t.Id).SequenceEqual(tracks.Select(t => t.Id)))
            {
                CancelUpcoming(); queueSnapshot = null; queue.Clear(); queue.AddRange(tracks); manualQueue.Clear();
            }
            if (!blending && !hostBlending && CanSeek)
            {
                var error = position - Position;
                var command = lastHostControl != controlRevision || playing != PlaybackRequested;
                // Pause before aligning its position, so a delayed pause never audibly rewinds.
                if (!playing) deck.SetPlaying(false);
                if (command || !playing)
                {
                    filteredDrift = 0; largeDriftSamples = 0; deck.PlaybackRate = 1;
                    if (Math.Abs(error) > .08)
                    { CancelUpcoming(); await SeekDeckAsync(Math.Clamp(position, 0, Duration)); syncSeeks++; }
                }
                else
                {
                    filteredDrift = filteredDrift * .75 + error * .25;
                    var direction = Math.Sign(error);
                    largeDriftSamples = Math.Abs(error) > 2 ? (direction == driftDirection ? largeDriftSamples + 1 : 1) : 0;
                    driftDirection = direction;
                    if (largeDriftSamples >= 3 && Environment.TickCount64 - lastDriftSeek > 10000)
                    {
                        CancelUpcoming(); await SeekDeckAsync(Math.Clamp(position, 0, Duration)); syncSeeks++;
                        lastDriftSeek = Environment.TickCount64; largeDriftSamples = 0; filteredDrift = 0;
                    }
                    deck.PlaybackRate = deck.SupportsPlaybackRate && Math.Abs(filteredDrift) > .08
                        ? 1 + Math.Clamp(filteredDrift / 10, -.015, .015) : 1;
                }
                lastHostControl = controlRevision;
            }
            else { deck.PlaybackRate = 1; if (standby is not null) standby.PlaybackRate = 1; }
            PlaybackRequested = playing;
            deck.SetPlaying(playing); if (blending) standby?.SetPlaying(playing);
            if (hostBlending && !blending && IncomingReady && playing)
            {
                await standby!.SeekAsync(fadePosition);
                _ = BlendAsync(fadeElapsed, fadeDuration);
            }
            if (playing) WarmNext();
            Changed?.Invoke();
        });

    private async Task PlayCoreAsync(MusicTrack track, IEnumerable<MusicTrack>? sequence, int? sequenceStartIndex, bool play, bool advance = false, bool retry = false, bool background = false)
    {
        if (deck is null) throw new InvalidOperationException("Player is starting. Try again.");
        var selected = sequence?.ToList() ?? [track];
        var selectedIndex = sequenceStartIndex ?? selected.FindIndex(t => t.Id == track.Id);
        if (selectedIndex < 0 || selectedIndex >= selected.Count || selected[selectedIndex].Id != track.Id)
            throw new ArgumentException("Choose a recording in this queue.");
        if (!retry)
        {
            FinishListening("skipped");
            eventSource = manualQueue.Contains(track) ? "queue" : advance && queueSource == "search" ? "auto_dj" : queueSource;
            eventFinalized = false; eventStarted = null;
        }
        if (Current?.Id != track.Id) resumePosition = null;
        var previousQueue = queue.ToList(); var previousIndex = index; var previousTrack = Current;
        var previousManual = manualQueue.ToArray();
        var version = ++requestVersion;
        ControlRevision++; lastHostControl = -1; filteredDrift = 0; largeDriftSamples = 0;
        CancelUpcoming(); preparation?.Cancel();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(10));
        preparation = cancellation;
        preparing = true; PlaybackRequested = play; sourceReady = false; resumeStartPending = false;
        if (!ReferenceEquals(sequence, queue)) queueSnapshot = null;
        queue.Clear(); queue.AddRange(selected); index = selectedIndex;
        if (!advance) order = selected.ToList();
        if (!advance) manualQueue.Clear(); else manualQueue.Remove(selected[selectedIndex]);
        track = session.CurrentRecording(track);
        Current = track;
        if (!retry) { listenRecorded = false; listenedSeconds = 0; }
        lastListeningPosition = 0;
        deck.Stop(); session.PinPlayback(null); session.PinPreparingPlayback(track.Id); Changed?.Invoke();
        void Restore()
        {
            var additions = queue.Skip(selected.Count).ToList();
            queueSnapshot = null; queue.Clear(); queue.AddRange(previousQueue); queue.AddRange(additions);
            manualQueue.Clear(); foreach (var entry in previousManual) manualQueue.Add(entry);
            index = previousIndex; Current = previousTrack; PlaybackRequested = false; session.PinPlayback(null);
        }
        try
        {
            var path = await PrepareFile(track, cancellation.Token, background: background);
            cancellation.Token.ThrowIfCancellationRequested();
            if (version != requestVersion) return;
            track = session.PlaybackRecording(session.CurrentRecording(track), path);
            Current = track; queue[index] = track; session.PinPlayback(track.Id);
            preparing = false; sourceReady = true; deck.TransportEnabled = !FollowingHost; ApplyVolumes();
            MarkStream(deck, path);
            resumeStartPending = PlaybackRequested && resumePosition is > 0;
            deck.PlayFile(path, track.Title, track.Channel, PlaybackRequested && !resumeStartPending, background);
        }
        catch (OperationCanceledException) { if (version == requestVersion) { sourceReady = false; Restore(); } }
        catch { if (version != requestVersion) return; sourceReady = false; Restore(); throw; }
        finally
        {
            if (version == requestVersion)
            {
                preparation = null; preparing = false; session.PinPreparingPlayback(null); Changed?.Invoke();
                await ApplyResumePositionAsync();
                if (Playing) WarmNext();
            }
        }
    }
    private async Task<string> PrepareFile(MusicTrack track, CancellationToken token, double lead = 0, bool background = false)
    {
        var path = session.LocalPath(track) ?? await session.GetCachedPlaybackPathAsync(track, token);
        if (path is not null) return path;
        if (!session.Connected) throw new InvalidOperationException("This song is not downloaded on this device. Connect to play it.");
        var saved = await session.EnsureServerRecordingAsync(track, token, session.CanStream && lead <= 0, background);
        if (session.CanStream)
        {
            try { return await session.StreamPlaybackAsync(saved, lead, token, background); }
            catch (Exception error) when (error is InvalidDataException or FamilyHubApiException or HttpRequestException) { }
        }
        return await session.CachePlaybackAsync(saved, token, lead, background);
    }
    private void WarmNext()
    {
        if (receivingHandoff || Current?.PlaybackVersion == "preview-hls") return;
        if (RepeatMode == "one" || standby is null || blending || warming || !PlaybackRequested || index + 1 >= queue.Count) return;
        if (Duration <= 0 || Duration - Position > Math.Max(30, FadeDuration + 15)) return;
        var next = index + 1;
        var key = requestVersion + ":" + next + ":" + queue[next].Id;
        if (attemptedNext == key || Environment.TickCount64 < retryUpcomingAt) return;
        if (Shuffle && !FollowingHost && !nextChosen && !manualQueue.Contains(queue[next]))
        {
            var chosen = Random.Shared.Next(next, queue.Count);
            queueSnapshot = null;
            (queue[next], queue[chosen]) = (queue[chosen], queue[next]);
            key = requestVersion + ":" + next + ":" + queue[next].Id;
        }
        nextChosen = true; attemptedNext = key; warming = true;
        upcomingPreparation?.Cancel(); upcomingPreparation?.Dispose();
        var cancellation = upcomingPreparation = new CancellationTokenSource(TimeSpan.FromMinutes(10));
        _ = PrepareUpcomingAsync(next, queue[next], requestVersion, cancellation);
    }
    private async Task PrepareUpcomingAsync(int next, MusicTrack original, long version, CancellationTokenSource cancellation)
    {
        var token = cancellation.Token;
        session.PinPreparingNextPlayback(original.Id);
        try
        {
            var track = session.CurrentRecording(original);
            var path = await PrepareFile(track, token, Math.Max(0, Duration - Position), background: true);
            token.ThrowIfCancellationRequested();
            if (version != requestVersion || next >= queue.Count || !ReferenceEquals(queue[next], original) || standby is null) return;
            track = session.PlaybackRecording(session.CurrentRecording(track), path);
            if (manualQueue.Remove(original)) { track = track with { }; manualQueue.Add(track); }
            queue[next] = track;
            preparedTrack = null; incomingFailed = false;
            standby.Stop(); standby.TransportEnabled = false; standby.Volume = 0;
            MarkStream(standby, path);
            standby.PlayFile(path, track.Title, track.Channel, false, background: true);
            preparedTrack = track; session.PinUpcomingPlayback(track.Id);
            cancellation.CancelAfter(Timeout.InfiniteTimeSpan);
            Changed?.Invoke(); TryBlend();
        }
        catch (Exception error) when (error is OperationCanceledException or IOException or HttpRequestException or InvalidOperationException or FamilyHubApiException)
        {
            if (ReferenceEquals(upcomingPreparation, cancellation) && version == requestVersion)
            { attemptedNext = null; retryUpcomingAt = Environment.TickCount64 + 10000; }
        }
        finally
        {
            if (ReferenceEquals(upcomingPreparation, cancellation))
            { warming = false; session.PinPreparingNextPlayback(null); }
        }
    }
    private int PreparedIndex => preparedTrack is null ? -1 : queue.FindIndex(index + 1, t => ReferenceEquals(t, preparedTrack));
    private bool IncomingReady => standby is not null && preparedTrack is not null && !standby.Opening && !incomingFailed && PreparedIndex > index;
    private void TryBlend()
    {
        if (Current?.PlaybackVersion == "preview-hls" || preparedTrack?.PlaybackVersion == "preview-hls") return;
        if (RepeatMode == "one" || !AutoDj || FollowingHost || blending || preparing || !sourceReady || !Playing || !PlaybackRequested || !IncomingReady || Duration <= 0) return;
        if (Position < Duration - FadeDuration || Duration - Position <= .15) return;
        _ = BlendAsync(completed: true);
    }
    private async Task BlendAsync(double elapsed = 0, double? duration = null, bool completed = false)
    {
        if (!IncomingReady || deck is null || standby is null || blending) return;
        var next = PreparedIndex;
        // A queued recording still downloading can follow the already prepared next song.
        if (next != index + 1) queueSnapshot = null;
        var incomingTrack = queue[next]; queue.RemoveAt(next); queue.Insert(index + 1, incomingTrack);
        upcomingPreparation?.Cancel(); upcomingPreparation?.Dispose();
        using var cancellation = new CancellationTokenSource();
        upcomingPreparation = cancellation; warming = false;
        blending = true; blendTarget = index + 1;
        incomingStarted = null; incomingOwner = session.HistoryOwner;
        var version = requestVersion; var outgoing = deck; var incoming = standby;
        try
        {
            if (next != blendTarget) Changed?.Invoke();
            await DeckCrossfade.RunAsync(outgoing, incoming, duration ?? FadeDuration,
                () => PlaybackRequested, gain => { blendGain = gain; ApplyVolumes(); }, cancellation.Token, () => incomingFailed, elapsed);
            if (version != requestVersion || !blending) return;
            FinishListening(completed ? "completed" : "skipped");
            eventSource = manualQueue.Contains(incomingTrack) ? "queue" : queueSource == "search" ? "auto_dj" : queueSource;
            eventFinalized = false;
            eventStarted = incomingOwner == session.HistoryOwner && !session.PlaybackPreferences.ListeningHistoryPaused ? incomingStarted : null;
            eventOwner = incomingOwner; incomingStarted = null;
            deck = incoming; standby = outgoing;
            index = blendTarget; Current = incomingTrack; manualQueue.Remove(incomingTrack);
            preparedTrack = null; attemptedNext = null; upcomingPreparation = null;
            blending = false; blendTarget = -1; blendGain = 0;
            listenRecorded = false; listenedSeconds = eventStarted is not null ? incoming.Position : 0; lastListeningPosition = incoming.Position;
            deck.TransportEnabled = !FollowingHost; standby.TransportEnabled = false; standby.Stop(); ApplyVolumes();
            session.PinPlayback(incomingTrack.Id); session.PinUpcomingPlayback(null); session.PinPreparingNextPlayback(null);
            Changed?.Invoke(); WarmNext();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (version == requestVersion && ReferenceEquals(deck, outgoing))
            {
                blending = false; blendTarget = -1; preparedTrack = null; incoming.Stop(); blendGain = 0; ApplyVolumes();
                session.SetMessage(error.Message); Changed?.Invoke();
                if (outgoing.Duration > 0 && outgoing.Position >= outgoing.Duration - .1) await NextCoreAsync(background: true);
            }
        }
    }
    private void CancelUpcoming(bool keepReady = false, bool preserveChoice = false)
    {
        upcomingPreparation?.Cancel(); upcomingPreparation?.Dispose(); upcomingPreparation = null;
        warming = false; attemptedNext = null;
        if (!preserveChoice) { nextChosen = false; retryUpcomingAt = 0; }
        if (!keepReady)
        {
            FinishIncomingListening("skipped");
            blending = false; blendTarget = -1; preparedTrack = null; blendGain = 0;
            standby?.Stop(); session.PinUpcomingPlayback(null);
        }
        session.PinPreparingNextPlayback(null); ApplyVolumes();
    }
    private void ApplyVolumes()
    {
        if (deck is not null) deck.Volume = TrackVolume(Current) * (blending ? 1 - blendGain : 1);
        if (standby is not null) standby.Volume = blending ? TrackVolume(preparedTrack) * blendGain : 0;
    }
    private double TrackVolume(MusicTrack? track)
    {
        var db = NormalizationGainDb(track, session.PlaybackPreferences.VolumeLevel);
        // Windows MediaPlayer and MAUI MediaElement support attenuation only.
        return volume * Math.Pow(10, Math.Min(0, db) / 20);
    }
    public static double NormalizationGainDb(MusicTrack? track, string level)
    {
        var target = level switch
        {
            "loud" => -11,
            "normal" => -14,
            "quiet" => -19,
            _ => throw new ArgumentException("Choose Loud, Normal or Quiet volume level.")
        };
        if (track?.Lufs is { } lufs && double.IsFinite(lufs) &&
            track.TruePeak is { } peak && double.IsFinite(peak))
            return Math.Min(6, Math.Min(target - lufs, -1 - peak));
        var legacy = track?.PlaybackGainDb ?? 0;
        return double.IsFinite(legacy) ? Math.Clamp(legacy, -60, 6) : 0;
    }
    public bool ReplaceUpcoming(string seedId, IEnumerable<MusicTrack> tracks)
    {
        RequirePlaybackControl();
        if (Current?.Id != seedId || preparing) return false;
        var candidates = tracks.Where(t => t.Id != seedId).DistinctBy(t => t.Id).ToList();
        if (candidates.Count == 0) return false;
        var keep = blending ? blendTarget + 1 : index + 1;
        if (!blending) CancelUpcoming();
        queueSnapshot = null; queue.RemoveRange(keep, queue.Count - keep);
        manualQueue.Clear(); queueSource = "auto_dj";
        var audibleNext = blending ? preparedTrack?.Id : null;
        queue.AddRange(candidates.Where(t => t.Id != audibleNext));
        Changed?.Invoke(); if (Playing && !blending) WarmNext();
        return true;
    }
    public Task ToggleAsync() => RemoteActive ? RemoteToggleAsync() : ToggleCoreAsync(true);
    private Task ToggleCoreAsync(bool localUserAction) => MainThread.InvokeOnMainThreadAsync(async () =>
    {
        RequirePlaybackControl();
        if (deck is null || Current is null) return;
        if (localUserAction) UserPlaybackRevision++;
        if (localUserAction && (!PlaybackRequested || !preparing && !sourceReady)) session.MarkLocalPlayback();
        if (!preparing && !sourceReady) { await PlayCoreAsync(Current, queue, index, true, background: !localUserAction); return; }
        PlaybackRequested = !PlaybackRequested;
        ControlRevision++;
        if (!preparing && !resumeStartPending) { deck.SetPlaying(PlaybackRequested); if (blending) standby?.SetPlaying(PlaybackRequested); }
        if (PlaybackRequested && !blending) WarmNext();
        Changed?.Invoke();
    });
    public Task SetVolumeAsync(double value) => MainThread.InvokeOnMainThreadAsync(() =>
    {
        if (!double.IsFinite(value)) throw new ArgumentOutOfRangeException(nameof(value));
        volume = Math.Clamp(value, 0, 1); ApplyVolumes(); Changed?.Invoke();
    });
    public void ToggleShuffle() { RequirePlaybackControl(); Shuffle = !Shuffle; if (!Shuffle && !blending) RestoreOrder(); if (!blending) CancelUpcoming(true); Changed?.Invoke(); if (Playing) WarmNext(); }
    private async Task SeekDeckAsync(double seconds)
    {
        if (deck is null || Seeking) return;
        Seeking = true; lastListeningPosition = seconds; session.InvalidateListeningBaseline();
        try { await deck.SeekAsync(seconds); }
        finally { Seeking = false; SeekRevision++; session.InvalidateListeningBaseline(); Changed?.Invoke(); }
    }
    public Task SeekAsync(double seconds) => SeekAsync(seconds, background: false);
    private Task SeekAsync(double seconds, bool background) => RemoteActive ? RemoteSeekAsync(seconds) : MainThread.InvokeOnMainThreadAsync(async () =>
    {
        RequirePlaybackControl();
        if (!CanSeek || deck is null || !double.IsFinite(seconds)) return;
        if (!background) UserPlaybackRevision++;
        ControlRevision++;
        if (!sourceReady && resumePosition is not null)
        {
            resumePosition = Math.Clamp(seconds, 0, Duration);
            Changed?.Invoke();
            return;
        }
        // Seeking keeps the selected next recording and its preparation.
        if (blending) CancelUpcoming(preserveChoice: true);
        lastListeningPosition = Math.Clamp(seconds, 0, Duration);
        await SeekDeckAsync(lastListeningPosition); if (Playing) WarmNext();
    });
    public Task NextAsync() { if (RemoteActive) return SendRemoteAsync("next"); RequirePlaybackControl(); return MainThread.InvokeOnMainThreadAsync(() => NextCoreAsync(background: false)); }
    private Task NextCoreAsync(bool background)
    {
        var next = blending ? blendTarget + 1 : index + 1;
        if (next >= queue.Count)
        {
            if (RepeatMode == "off" || FollowingHost || queue.Count == 0) return Task.CompletedTask;
            next = 0;
        }
        if (!background) UserPlaybackRevision++;
        if (Current?.PlaybackVersion != "preview-hls" && preparedTrack?.PlaybackVersion != "preview-hls" && AutoDj && !blending && IncomingReady && Playing && Duration - Position > .15) return BlendAsync();
        var sequence = queue;
        if (Shuffle && !FollowingHost && !manualQueue.Contains(queue[next]) && !nextChosen)
        {
            var chosen = Random.Shared.Next(next, queue.Count);
            if (chosen != next)
            {
                sequence = queue.ToList();
                (sequence[next], sequence[chosen]) = (sequence[chosen], sequence[next]);
            }
        }
        return PlayCoreAsync(sequence[next], sequence, next, Current is null || PlaybackRequested, true, background: background);
    }
    public Task PreviousAsync() => PreviousAsync(background: false);
    private Task PreviousAsync(bool background) => RemoteActive ? SendRemoteAsync("previous") : MainThread.InvokeOnMainThreadAsync(() =>
    {
        RequirePlaybackControl();
        if (!Preparing && Position > 3)
        {
            FinishListening("skipped"); eventFinalized = false; eventStarted = null;
            listenRecorded = false; listenedSeconds = 0;
            return SeekAsync(0, background);
        }
        if (index <= 0) return Task.CompletedTask;
        if (!background) UserPlaybackRevision++;
        return PlayCoreAsync(queue[index - 1], queue, index - 1, PlaybackRequested, background: background);
    });
    /// <summary>Shuffle off: the songs after the current one follow the list's own order again
    /// (queued songs stay first), like Spotify.</summary>
    private void RestoreOrder()
    {
        if (FollowingHost || Current is null || index < 0 || index >= queue.Count) return;
        var at = order.FindIndex(t => t.Id == queue[index].Id);
        if (at < 0) return;
        var manual = queue.Skip(index + 1).Where(manualQueue.Contains).ToList();
        queueSnapshot = null; queue.RemoveRange(index + 1, queue.Count - index - 1);
        queue.AddRange(manual); queue.AddRange(order.Skip(at + 1));
    }
    public int AddToQueue(MusicTrack track, bool manual = true) => Enqueue([track], manual, playNext: false);

    public void AddToQueue(IEnumerable<MusicTrack> tracks, bool playNext) => Enqueue(tracks, manual: true, playNext: playNext);

    private int Enqueue(IEnumerable<MusicTrack> tracks, bool manual, bool playNext)
    {
        RequirePlaybackControl();
        if (queue.Count == 0 && Current is not null) { queue.Add(Current); index = 0; }
        var insertion = manual ? (blending ? blendTarget + 1 : index + 1) : queue.Count;
        if (!playNext)
            for (var i = insertion; i < queue.Count; i++) if (manualQueue.Contains(queue[i])) insertion = i + 1;
        var first = -1;
        var changed = false;
        foreach (var track in tracks)
        {
            var entry = manualQueue.FirstOrDefault(t => t.Id == track.Id);
            if (entry is not null)
            {
                var existing = queue.FindIndex(t => ReferenceEquals(t, entry));
                if (!playNext || existing < insertion)
                {
                    if (first < 0) first = existing;
                    continue;
                }
                queue.RemoveAt(existing);
            }
            else
            {
                entry = track with { };
                if (manual) manualQueue.Add(entry);
            }
            if (first < 0) first = insertion;
            queue.Insert(insertion++, entry);
            changed = true;
        }
        if (changed)
        {
            queueSnapshot = null;
            if (manual) UserPlaybackRevision++;
            if (!blending) { CancelUpcoming(true); if (Playing) WarmNext(); }
            Changed?.Invoke();
        }
        return first;
    }
    public string AudioOutputId { get; private set; } = "";
    public Task SetAudioOutputAsync(string id) => MainThread.InvokeOnMainThreadAsync(async () =>
    {
        if (deck is not null) await deck.SetOutputAsync(id);
        if (standby is not null) await standby.SetOutputAsync(id);
        AudioOutputId = id; Changed?.Invoke();
    });
    private Task RemoteSeekAsync(double seconds)
    {
        remoteValidFor = Math.Max(0, remoteValidFor - System.Diagnostics.Stopwatch.GetElapsedTime(remoteAt).TotalSeconds);
        resumePosition = Math.Max(0, seconds); remoteAt = System.Diagnostics.Stopwatch.GetTimestamp(); Changed?.Invoke();
        return SendRemoteAsync("seek", seconds);
    }
    // The check-in reads the muted receiving deck until the server confirms the handoff.
    internal sealed record LoadedHandoff(MusicTrack Track, IReadOnlyList<MusicTrack> Queue, int Index, IAudioDeck Deck);
    internal LoadedHandoff? ReportingHandoff { get; private set; }
    private bool receivingHandoff;

    private async Task<bool> TakeOverAsync(PlaybackResume state, IEnumerable<MusicTrack> available, bool play,
        Func<Task<bool>> confirm, CancellationToken token)
    {
        if (deck is null || standby is not { } incoming || receivingHandoff) return false;
        var recordings = available.DistinctBy(t => t.Id).ToDictionary(t => t.Id);
        if (!recordings.TryGetValue(state.TrackIds[state.Index], out var track)) return false;
        var tracks = state.TrackIds.Where(recordings.ContainsKey).Select(id => recordings[id]).ToArray();
        var at = state.TrackIds.Take(state.Index).Count(recordings.ContainsKey);
        var version = requestVersion;
        receivingHandoff = true;
        CancelUpcoming();
        bool CurrentRequest() => version == requestVersion && !FollowingHost && ReferenceEquals(standby, incoming);
        try
        {
            var path = await PrepareFile(track, token, background: true);
            if (!CurrentRequest()) return false;
            token.ThrowIfCancellationRequested();
            track = tracks[at] = session.PlaybackRecording(track, path);
            session.PinUpcomingPlayback(track.Id);
            incomingFailed = false;
            incoming.TransportEnabled = false;
            MarkStream(incoming, path);
            incoming.PlayFile(path, track.Title, track.Channel, false, background: true);
            while (CurrentRequest() && !incomingFailed && (incoming.Opening || incoming.Duration <= 0))
                await Task.Delay(50, token);
            if (!CurrentRequest() || incomingFailed) return false;
            if (state.Position > 0) await incoming.SeekAsync(state.Position).WaitAsync(token);
            if (!CurrentRequest() || incomingFailed) return false;
            if (play) incoming.SetPlaying(true);
            while (CurrentRequest() && !incomingFailed && (incoming.Opening || incoming.Playing != play))
                await Task.Delay(50, token);
            if (!CurrentRequest() || incomingFailed || !double.IsFinite(incoming.Position) || Math.Abs(incoming.Position - state.Position) > 5) return false;

            ReportingHandoff = new(track, tracks, at, incoming);
            if (!await confirm() || !CurrentRequest() || incomingFailed) return false;
            FinishListening("stopped");
            ++requestVersion; preparation?.Cancel(); preparing = false;
            standby = deck; deck = incoming;
            standby.TransportEnabled = false; standby.Stop();
            RemoteDeviceId = RemoteDeviceName = ""; RemotePlaying = false;
            queueSnapshot = null; queue.Clear(); queue.AddRange(tracks); order = tracks.ToList(); manualQueue.Clear();
            index = at; Current = track; sourceReady = true; PlaybackRequested = play;
            resumePosition = null; resumeStartPending = false; queueSource = eventSource = "other";
            eventStarted = null; eventFinalized = false; listenRecorded = false; listenedSeconds = 0; lastListeningPosition = incoming.Position;
            deck.TransportEnabled = true; ApplyVolumes();
            session.PinPlayback(track.Id); session.PinPreparingPlayback(null); ControlRevision++;
            return true;
        }
        finally
        {
            ReportingHandoff = null; receivingHandoff = false;
            if (ReferenceEquals(standby, incoming)) incoming.Stop();
            session.PinUpcomingPlayback(null);
            Changed?.Invoke(); if (Playing) WarmNext();
        }
    }

    public Task<bool> ApplyPlaybackCommandAsync(PlaybackHandover command, IEnumerable<MusicTrack> available,
        Func<Task<bool>> confirm, CancellationToken token = default) => MainThread.InvokeOnMainThreadAsync(async () =>
    {
        if (FollowingHost) return false;
        if (command.Action == "pause" && command.DeviceId.Length == 32 && command.DeviceId != session.DeviceId)
        {
            if (RemoteDeviceId != command.DeviceId) EnterRemote(command.DeviceId, command.FromName, command.Position ?? 0, command.Playing);
            ApplyRemoteState(command.Track?.Id ?? "", command.Status is null ? command.Playing : command.Status == "playing", command.Position, duration: command.Duration);
            return RemoteDeviceId == command.DeviceId;
        }
        return command is { Action: "play", Resume.IsValid: true }
            && await TakeOverAsync(command.Resume, available, command.Playing, confirm, token);
    });
    public Task ApplyRemoteControlAsync(PlaybackControl control) => MainThread.InvokeOnMainThreadAsync(async () =>
    {
        if (FollowingHost || RemoteActive || Current is null) return;
        switch (control.Action)
        {
            case "play" when !PlaybackRequested: await ToggleCoreAsync(false); break;
            case "pause" when PlaybackRequested: await ToggleCoreAsync(false); break;
            case "next": await NextCoreAsync(background: true); break;
            case "previous": await PreviousAsync(background: true); break;
            case "seek" when control.Position is { } seconds: await SeekAsync(seconds, background: true); break;
        }
    });
    public Task StopAsync() => MainThread.InvokeOnMainThreadAsync(() =>
    {
        FinishListening("stopped"); FinishIncomingListening("stopped");
        ++requestVersion; preparation?.Cancel(); preparation = null;
        preparing = false; sourceReady = false; PlaybackRequested = false; resumeStartPending = false;
        CancelUpcoming(); deck?.Stop(); session.PinPlayback(null); session.PinPreparingPlayback(null);
        resumePosition = null; Current = null; queueSnapshot = null; queue.Clear(); manualQueue.Clear(); index = -1; Changed?.Invoke();
    });
}
