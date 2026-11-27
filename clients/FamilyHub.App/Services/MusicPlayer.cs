using CommunityToolkit.Maui.Views;
using FamilyHub.Client.Core;
using System.Diagnostics;

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
    private bool downloadingUpcoming;
    private MusicTrack? failedNext, attemptedCacheNext;
    private int warmupFailures;
    private double warmupRetryPosition;
    private string? standbyWarmupAction;
    private long? streamRecoveryVersion;
    private static readonly int[] streamRetryDelays = [1000, 3000, 8000];
    private static readonly int[] playbackOpenRetryDelays = [500, 1500, 3000];
    private readonly Dictionary<IAudioDeck, PlayAction> playActions = [];
    private sealed class PlayAction(long started)
    {
        public readonly string Id = Guid.NewGuid().ToString("N");
        public readonly long Started = started;
        public readonly HashSet<string> Stages = [];
        public bool Fallback;
        public bool Progressed;
        public bool Audible;
        public bool Identified;
        public double? Position;
        public long PositionAt;
        public long LastCheckpointAt;
        public bool WasBuffering;
        public bool UnexpectedPause;
        public int StreamRetries;
    }
    public static long PlaybackTimestamp() => Stopwatch.GetTimestamp();
    private void Report(PlayAction? action, string stage)
    {
        if (action is not null && action.Stages.Add(stage))
            session.ReportPlaybackStage(action.Id, stage, stage == "play" ? 0 : (long)Stopwatch.GetElapsedTime(action.Started).TotalMilliseconds);
    }
    private PlayAction BeginPlayback(long? requestedAt = null)
    {
        var action = new PlayAction(requestedAt ?? PlaybackTimestamp());
        Report(action, "play");
        return action;
    }
    private void RememberPlaybackAttempt(PlayAction? action, MusicTrack? track)
    {
        if (action is null || action.Identified || track is null) return;
        action.Identified = true;
        session.RememberPlaybackAttempt(action.Id, track, DateTimeOffset.UtcNow - Stopwatch.GetElapsedTime(action.Started));
    }
    private void ObservePlayback(IAudioDeck owner, bool audible)
    {
        if (!playActions.TryGetValue(owner, out var action)) return;
        if (!owner.Opening && owner.Duration > 0) Report(action, action.Fallback ? "fallback_ready" : "ready");
        if (!owner.PlaybackRequested || !owner.Playing || owner.Opening || Seeking || resumeStartPending)
        {
            action.Position = null;
            return;
        }
        Report(action, action.Fallback ? "fallback_playing" : "playing");
        var position = owner.Position;
        if (!double.IsFinite(position)) { action.Position = null; return; }
        audible &= owner.Volume > 0;
        var sampledAt = PlaybackTimestamp();
        var delta = position - (action.Position ?? position);
        // Stream opening and decoder resets can jump the media clock by a segment.
        if (delta is > .05 and < 3 && delta <= Stopwatch.GetElapsedTime(action.PositionAt, sampledAt).TotalSeconds + .5)
        {
            action.Progressed = true;
            if (audible && action.Audible)
                Report(action, action.Fallback ? "fallback_position_advanced" : "position_advanced");
        }
        if (action.Position is null || delta < 0 || delta > .05 || audible != action.Audible)
        {
            action.Position = position;
            action.PositionAt = sampledAt;
        }
        action.Audible = audible;
    }
    private double volume = 1, blendGain, listenedSeconds, lastListeningPosition;
    private double outgoingVolume, incomingVolume;
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
    private bool waitingForNext;
    private long upcomingReplacementRevision;
    public long ControlRevision { get; private set; }
    public long SeekRevision { get; private set; }
    private int syncSeeks;
    private bool uiActive = true;
    public bool UiActive
    {
        get => uiActive;
        set
        {
            if (uiActive == value) return;
            uiActive = value;
            if (deck is { } owner && !RemoteActive && (PlaybackRequested || owner.Playing))
                TracePlayback(owner, value ? "foreground" : "background", TracePosition(owner), PlaybackStateLabel(owner));
        }
    }
    public event Action? Changed;
    public MusicTrack? Current { get; private set; }
    public IReadOnlyList<MusicTrack> Queue => queue;
    private MusicTrack[]? queueSnapshot;
    public IReadOnlyList<MusicTrack> QueueSnapshot => queueSnapshot ??= queue.ToArray();
    public int QueueIndex => index;
    public double Volume => volume;
    public bool Shuffle { get; private set; }
    public bool Autoplay { get; private set; } = true;
    private bool preserveHandoffOrder;
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
    private bool ShowingIncoming => blending && blendGain >= .5 && preparedTrack is not null && standby is not null;
    internal (MusicTrack? Track, double Position, double Duration, bool Playing, bool Preparing, bool CanSeek) NotificationPlayback =>
        RemoteActive ? default : ShowingIncoming && standby is { } incoming
            ? (preparedTrack, incoming.Position, incoming.Duration, incoming.Playing, PlaybackRequested && incoming.Opening, false)
            : (Current, Position, Duration, Playing, PlaybackRequested && Preparing, CanSeek);
#if ANDROID
    private (long Version, PlayAction? Action) openingAttempt;

    internal bool KeepPlaybackAwake => !RemoteActive && PlaybackRequested &&
        (Playing || Preparing || warming || Seeking || resumeStartPending || blending && standby?.Playing == true
            || sourceReady && deck is MauiAudioDeck { ReachedEnd: true });

    internal void TraceScreen(bool screenOn)
    {
        if (RemoteActive || !PlaybackRequested) return;
        var stage = screenOn ? "screen_on" : "screen_off";
        var owner = ShowingIncoming ? standby : deck;
        if (preparing && openingAttempt.Version == requestVersion && openingAttempt.Action is { } action)
            session.RecordPlaybackObservation(action.Id, stage, Position, null);
        else if (owner is not null)
            TracePlayback(owner, stage, owner.Position);
    }
#endif
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
    private long? remotePauseRequestedAt;
    private double remoteValidFor = PlaybackDevice.OnlineSeconds, remoteDuration;

    // Remote mode: this device's copy of the queue follows the other device; resumePosition holds
    // its position, and the transport buttons send actions there instead of playing here.
    public void EnterRemote(string deviceId, string name, double position, bool playing)
    {
        if (FollowingHost) return;
        FinishListening("stopped");
        RemoteDeviceId = deviceId; RemoteDeviceName = name; RemotePlaying = playing; remoteAt = System.Diagnostics.Stopwatch.GetTimestamp();
        remotePauseRequestedAt = null;
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
        // The first poll can still report playback from before the phone handles its queued pause.
        if (playing && remotePauseRequestedAt is { } pausedAt &&
            System.Diagnostics.Stopwatch.GetElapsedTime(pausedAt).TotalSeconds < PlaybackDevice.OnlineSeconds)
            return;
        remotePauseRequestedAt = null;
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
    internal Func<string, Task<string?>>? ResumeRemoteHere { get; set; }
    private bool remoteTogglePending;
    private async Task RemoteToggleAsync()
    {
        if (remoteTogglePending || session.Api is not { } api) return;
        remoteTogglePending = true;
        var target = RemoteDeviceId;
        try
        {
            if (!RemotePlaying)
            {
                if (ResumeRemoteHere is { } resume && await resume(target) is { } error)
                    session.SetMessage(error, "error");
                return;
            }
            await api.ControlPlaybackAsync(session.DeviceId, target, "pause");
            if (RemoteDeviceId != target) return;
            remotePauseRequestedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            resumePosition = Position; RemotePlaying = false; Changed?.Invoke();
        }
        catch (Exception error) when (error is HttpRequestException or FamilyHubApiException or OperationCanceledException)
        { session.SetMessage("Playback could not pause. Check that the other device is online and try again.", "error"); }
        finally { remoteTogglePending = false; }
    }
    public Task PauseLocallyAsync(bool background = true) => MainThread.InvokeOnMainThreadAsync(() =>
    {
        if (!background) UserPlaybackRevision++;
        PlaybackRequested = false; deck?.SetPlaying(false); standby?.SetPlaying(false);
        if (blending || downloadingUpcoming) CancelUpcoming();
        Changed?.Invoke();
    });
    private void RequirePlaybackControl()
    {
        if (FollowingHost) throw new InvalidOperationException("The host controls playback. Leave Listen Together to choose your own music.");
    }
    public bool PlaybackRequested { get; private set; }
    public bool Preparing => preparing || streamRecoveryVersion == requestVersion || sourceReady && deck?.Opening == true;
    public bool Playing => deck?.Playing ?? false;
    internal bool PlaybackInterrupted => PlaybackRequested && sourceReady && !Playing && !Preparing && !Seeking
        && !resumeStartPending && lastListeningPosition > 0 && deck is { } owner && !AtTrackEnd(owner, TracePosition(owner));
    public double Position => (!sourceReady || resumeStartPending) && resumePosition is { } saved
        ? RemoteActive && RemotePlaying ? Math.Min(saved + Math.Min(remoteValidFor, System.Diagnostics.Stopwatch.GetElapsedTime(remoteAt).TotalSeconds),
            remoteDuration > 0 ? remoteDuration : Current?.Duration is > 0 and var length ? length : double.MaxValue) : saved
        : sourceReady ? deck?.Position ?? 0 : 0;
    public double Duration => preparing || !sourceReady || deck?.Opening == true ? Current?.Duration ?? 0 : deck?.Duration ?? 0;
    private long? seekingVersion;
    public bool Seeking => seekingVersion == requestVersion;
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

    public PlaybackResume? CaptureResume() => Current is { IsDeezerSuggestion: false } && !RemoteActive && !FollowingHost && !Preparing && index >= 0 && queue.Count <= 1000
        ? new() { TrackIds = queue.Where(t => !t.IsDeezerSuggestion).Select(t => t.Id).ToList(),
            Index = queue.Take(index).Count(t => !t.IsDeezerSuggestion), Position = Math.Max(0, Position),
            Shuffle = Shuffle, RepeatMode = RepeatMode, Autoplay = Autoplay } : null;
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
        if (resumePosition is not { } position || !sourceReady || preparing || Seeking
            || deck is not { } owner || owner.Opening || owner.Duration <= 0) return;
        var version = requestVersion;
        TracePlayback(owner, "resume_seek", position);
        try
        {
            if (position > owner.Duration + .5) throw new InvalidOperationException("The saved position is outside this audio source.");
            await SeekDeckAsync(Math.Clamp(position, 0, Math.Max(0, owner.Duration - .25)), confirm: true);
            if (version != requestVersion || !ReferenceEquals(deck, owner) || !sourceReady) return;
            TracePlayback(owner, "resume_applied", owner.SeekPosition);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or OperationCanceledException or TimeoutException)
        {
            if (version != requestVersion || !ReferenceEquals(deck, owner) || !sourceReady) return;
            lastListeningPosition = 0;
            lastListeningPosition = TracePosition(owner);
            TracePlayback(owner, "resume_failed", position);
        }
        resumePosition = null;
        if (resumeStartPending)
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
#if !WINDOWS
        if (owner is MauiAudioDeck diagnostics)
            diagnostics.DiagnosticObserved += (stage, position, reason) =>
            {
                if (!ReferenceEquals(deck, owner) || RemoteActive || stage == "native_paused" && !PlaybackRequested) return;
                // MediaElement can reset its position before raising Failed.
                if (stage == "native_error" && sourceReady && double.IsFinite(position))
                    lastListeningPosition = Math.Max(lastListeningPosition, position);
                TracePlayback(owner, stage, position, reason);
            };
#endif
        owner.Changed += () =>
        {
            if (ReferenceEquals(deck, owner))
            {
                if (RemoteActive) return;
                if (!preparing && sourceReady && !blending && !resumeStartPending)
                {
                    // Native transport play changes the deck directly; app and remote actions set intent first.
                    if (!PlaybackRequested && owner.PlaybackRequested && !FollowingHost)
                    {
                        session.MarkLocalPlayback();
                        var action = BeginPlayback();
                        RememberPlaybackAttempt(action, Current);
                        playActions[owner] = action;
                        _ = WatchPlaybackStartAsync(owner, action, requestVersion);
                    }
                    if (PlaybackRequested && !owner.PlaybackRequested && downloadingUpcoming) CancelUpcoming(preserveChoice: true);
                    PlaybackRequested = owner.PlaybackRequested;
                }
                if (sourceReady)
                {
                    TraceTransport(owner);
                    ObservePlayback(owner, audible: !blending || blendGain < 1);
                }
                _ = ApplyResumePositionAsync();
                RecordListening();
#if !WINDOWS
                if (owner is MauiAudioDeck mobile) mobile.FastPositionWindow = Autoplay && AutoDj && PlaybackRequested && !FollowingHost && RepeatMode != "one"
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
                if (!warming && !owner.Opening) FinishWarmup();
                if (blending) ObservePlayback(owner, audible: blendGain > 0);
                if (blending && owner.Playing && incomingStarted is null && !FollowingHost && !session.PlaybackPreferences.ListeningHistoryPaused)
                { incomingStarted = DateTimeOffset.UtcNow; incomingOwner = session.HistoryOwner; }
                TryBlend();
            }
        };
        owner.Ended += () =>
        {
            if (ReferenceEquals(ReportingHandoff?.Deck, owner)) { handoffTrackEnded = true; return; }
            if (!ReferenceEquals(deck, owner) || preparing || blending || !sourceReady || !PlaybackRequested) return;
            if (streamedDecks.ContainsKey(owner) && Current?.Duration is > 0 and var expectedDuration
                && TracePosition(owner) < expectedDuration - Math.Clamp(expectedDuration * .05, 3, 10))
            {
                TracePlayback(owner, "early_end", TracePosition(owner));
                HandleDeckFailure(owner);
                return;
            }
            _ = AdvanceAfterEndAsync();
        };
        owner.Failed += _ =>
        {
            if (ReferenceEquals(deck, owner) && !RemoteActive)
                TracePlayback(owner, "player_error", TracePosition(owner));
            HandleDeckFailure(owner);
        };
    }

    private double TracePosition(IAudioDeck owner)
    {
        var nativePosition = owner.SeekPosition;
        return Math.Max(Math.Max(double.IsFinite(nativePosition) ? nativePosition : 0, owner.Position), lastListeningPosition);
    }

    private bool AtTrackEnd(IAudioDeck owner, double position)
    {
        var duration = Math.Max(owner.Duration, Current?.Duration ?? 0);
        return duration > 0 && position >= duration - Math.Min(.5, duration * .05);
    }

    private static string PlaybackStateLabel(IAudioDeck owner) => owner.Opening ? "Buffering" : owner.Playing ? "Playing" : "Paused";

    private void TracePlayback(IAudioDeck owner, string stage, double position, string? reason = null)
    {
        if (playActions.TryGetValue(owner, out var action))
            session.RecordPlaybackObservation(action.Id, stage, position, reason);
    }
    internal void TraceNotification(string stage, MusicTrack track, double position, string? reason = null)
    {
        var owner = ShowingIncoming ? standby : deck;
        if (owner is not null && track.Id == NotificationPlayback.Track?.Id)
            TracePlayback(owner, stage, position, reason);
    }

    private void TraceTransport(IAudioDeck owner)
    {
        if (!PlaybackRequested || Seeking || resumeStartPending || !playActions.TryGetValue(owner, out var action)) return;
        var position = TracePosition(owner);
        if (owner.Opening && !action.WasBuffering)
            TracePlayback(owner, "buffering", position);
        if (!owner.Opening && action.WasBuffering && owner.Playing)
            TracePlayback(owner, "buffer_recovered", position);
        action.WasBuffering = owner.Opening;
        var started = action.Stages.Contains("position_advanced") || action.Stages.Contains("fallback_position_advanced");
        var interrupted = started && !owner.Opening && !owner.Playing && !AtTrackEnd(owner, position);
        if (interrupted && !action.UnexpectedPause)
            TracePlayback(owner, "unexpected_pause", position);
        action.UnexpectedPause = interrupted;
        var now = Environment.TickCount64;
        if (owner.Playing && now - action.LastCheckpointAt >= 5000)
        {
            action.LastCheckpointAt = now;
            TracePlayback(owner, "checkpoint", position, uiActive ? "Playing in app" : "Playing in background");
        }
    }

    private void HandleDeckFailure(IAudioDeck owner)
    {
        var streamed = streamedDecks.Remove(owner, out var streamSource);
        var action = playActions.GetValueOrDefault(owner);
        if (ReferenceEquals(deck, owner))
        {
            if (!sourceReady || RemoteActive) return;
            TracePlayback(owner, "interrupted", TracePosition(owner));
            if (streamed) Report(action, "stream_failed");
            SaveInterruptedPosition();
            if (PlaybackRequested && !FollowingHost && Current is { } interrupted &&
                streamed && streamSource is not null && (resumePosition is > 0 || action is { StreamRetries: > 0 }))
            {
                action ??= BeginPlayback();
                RememberPlaybackAttempt(action, interrupted);
                sourceReady = false; resumeStartPending = false;
                _ = RecoverStreamAsync(owner, interrupted, action, streamSource);
                return;
            }
            if (PlaybackRequested && Current is { } current && action?.Fallback != true
                && (streamed || current.Saved && session.Connected))
            {
                sourceReady = false;
                _ = RecoverPlaybackAsync(current, action);
                return;
            }
            StopAfterFailure(owner, action);
        }
        else if (ReferenceEquals(standby, owner))
        {
            if (!receivingHandoff && preparedTrack is { } next)
            {
                RecordWarmupFailure(next);
                if (streamed && deck is not null) Report(playActions.GetValueOrDefault(deck), "next_stream_failed");
            }
            Report(action, "failed");
            FinishIncomingListening("stopped"); incomingFailed = true; preparedTrack = null;
            session.PinUpcomingPlayback(null);
            if (!blending && !receivingHandoff) owner.Stop();
        }
    }

    private void SaveInterruptedPosition()
    {
        var position = sourceReady && deck is { } owner ? TracePosition(owner) : Position;
        var checkpoint = Math.Max(position, resumePosition ?? 0);
        resumePosition = checkpoint > 0 ? checkpoint : null;
    }

    private void StopAfterFailure(IAudioDeck owner, PlayAction? action)
    {
        Report(action, "failed");
        FinishListening("stopped"); sourceReady = false; resumeStartPending = false; PlaybackRequested = false;
        if (downloadingUpcoming) CancelUpcoming();
        owner.Stop(); session.PinPlayback(null);
        session.SetMessage("Playback stopped. Retry the song or play a downloaded copy.", "error", playback: true);
        Changed?.Invoke();
    }

    private async Task RecoverStreamAsync(IAudioDeck owner, MusicTrack track, PlayAction action, string source)
    {
        var version = requestVersion;
        streamRecoveryVersion = version;
        if (blending) CancelUpcoming();
        owner.Stop();
        session.PinPlayback(null);
        Changed?.Invoke();
        try
        {
            while (action.StreamRetries < streamRetryDelays.Length)
            {
                await Task.Delay(streamRetryDelays[action.StreamRetries]);
                if (version != requestVersion || !ReferenceEquals(deck, owner) || !PlaybackRequested || FollowingHost) return;
                action.StreamRetries++;
                session.RecordPlaybackObservation(action.Id, "stream_retry", resumePosition ?? 0, null);
                streamRecoveryVersion = null;
                var attemptVersion = version + 1;
                try
                {
                    await PlayCoreAsync(track, queue, index, true, advance: true, retry: true, background: true,
                        action: action, retrySource: source);
                    return;
                }
                catch (Exception error) when (IsPlaybackOpenFailure(error))
                {
                    if (requestVersion != attemptVersion || !PlaybackRequested || FollowingHost) return;
                    version = attemptVersion;
                    streamRecoveryVersion = version;
                    Changed?.Invoke();
                }
            }
            if (Autoplay && (index + 1 < queue.Count || RepeatMode == "all" && queue.Count > 1))
            {
                FinishListening("stopped");
                Report(action, "failed");
                var checkpoint = resumePosition;
                resumePosition = null;
                try
                {
                    await NextCoreAsync(background: true, directStream: true);
                    if (requestVersion == version + 1)
                        session.RecordPlaybackObservation(action.Id, "stream_skipped", checkpoint ?? 0, null);
                }
                catch (Exception error) when (IsPlaybackOpenFailure(error))
                {
                    if (requestVersion == version + 1)
                    {
                        resumePosition = checkpoint;
                        session.SetMessage("The next song could not start. Choose a song from the queue.", "error", playback: true);
                        Changed?.Invoke();
                    }
                }
            }
            else StopAfterFailure(owner, action);
        }
        finally
        {
            if (streamRecoveryVersion == version)
            {
                streamRecoveryVersion = null;
                if (version == requestVersion) Changed?.Invoke();
            }
        }
    }

    private static bool IsPlaybackOpenFailure(Exception error) =>
        error is IOException or InvalidOperationException or HttpRequestException or FamilyHubApiException
            or InvalidDataException or OperationCanceledException or UnauthorizedAccessException or TimeoutException;

    private async Task RecoverPlaybackAsync(MusicTrack track, PlayAction? action)
    {
        var version = requestVersion + 1;
        try { await PlayCoreAsync(track, queue, index, !FollowingHost, true, retry: true, background: true, action: action); }
        catch (Exception error) when (IsPlaybackOpenFailure(error))
        {
            if (requestVersion == version)
                session.SetMessage("Playback stopped. Retry the song or play a downloaded copy.", "error", playback: true);
        }
    }
    private async Task AdvanceAfterEndAsync()
    {
        try
        {
            FinishListening("completed");
            if (Autoplay && RepeatMode == "one" && !FollowingHost && Current is { } repeated)
                await PlayCoreAsync(repeated, queue, index, true, true, background: true);
            else if (Autoplay && (index + 1 < queue.Count || RepeatMode == "all" && !FollowingHost))
                await NextCoreAsync(background: true);
            else { waitingForNext = Autoplay && !FollowingHost; PlaybackRequested = false; deck?.SetPlaying(false); Changed?.Invoke(); }
        }
        catch (Exception) { session.SetMessage("The next song could not start. Choose a song from the queue.", "error"); }
    }

    private readonly Dictionary<IAudioDeck, string> streamedDecks = [];
    private void MarkStream(IAudioDeck target, string source) { if (MusicSession.IsStream(source)) streamedDecks[target] = source; else streamedDecks.Remove(target); }
    private void RecordListening()
    {
        var position = Position;
        var elapsed = position - lastListeningPosition;
        // A native source can reset its position before reporting that it stopped.
        if (sourceReady && position > 0) lastListeningPosition = position;
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
    public Task PlayAsync(MusicTrack track, IEnumerable<MusicTrack>? sequence = null, int? sequenceStartIndex = null,
        string source = "library", long? requestedAt = null)
    {
        var started = requestedAt ?? PlaybackTimestamp();
        RequirePlaybackControl();
        return MainThread.InvokeOnMainThreadAsync(() =>
        {
            UserPlaybackRevision++;
            session.MarkLocalPlayback();
            LeaveRemote();
            Autoplay = true; preserveHandoffOrder = false;
            FinishListening("skipped"); queueSource = source;
            return PlayCoreAsync(track, sequence, sequenceStartIndex, true, requestedAt: started);
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

    private async Task PlayCoreAsync(MusicTrack track, IEnumerable<MusicTrack>? sequence, int? sequenceStartIndex, bool play,
        bool advance = false, bool retry = false, bool background = false, PlayAction? action = null,
        long? requestedAt = null, string? retrySource = null, bool directStream = false)
    {
        var started = requestedAt ?? PlaybackTimestamp();
        if (deck is null) throw new InvalidOperationException("Player is starting. Try again.");
        var selected = sequence?.ToList() ?? [track];
        var selectedIndex = sequenceStartIndex ?? selected.FindIndex(t => t.Id == track.Id);
        if (selectedIndex < 0 || selectedIndex >= selected.Count || selected[selectedIndex].Id != track.Id)
            throw new ArgumentException("Choose a recording in this queue.");
        action ??= play ? BeginPlayback(started) : null;
        RememberPlaybackAttempt(action, track);
        var useFallback = retry || advance && ReferenceEquals(track, failedNext) && !directStream;
        var openedNext = !useFallback && !blending && IncomingReady && ReferenceEquals(preparedTrack, track) ? standby : null;
        failedNext = null;
        if (useFallback && action is not null)
        {
            action.Fallback = true; action.Position = null; action.Progressed = false;
            Report(action, "fallback");
        }
        if (!retry)
        {
            FinishListening("skipped");
            eventSource = manualQueue.Contains(track) ? "queue" : advance && queueSource == "search" ? "auto_dj" : queueSource;
            eventFinalized = false; eventStarted = null;
        }
        if (Current?.Id != track.Id) resumePosition = null;
        var previousQueue = queue.ToList(); var previousIndex = index; var previousTrack = Current; var previousOrder = order;
        var previousManual = manualQueue.ToArray();
        var replacementRevision = upcomingReplacementRevision;
        var version = ++requestVersion;
        ControlRevision++; lastHostControl = -1; filteredDrift = 0; largeDriftSamples = 0;
        CancelUpcoming(keepReady: openedNext is not null); preparation?.Cancel();
        using var cancellation = new CancellationTokenSource(retrySource is null ? TimeSpan.FromMinutes(10) : TimeSpan.FromSeconds(12));
        preparation = cancellation;
        preparing = true; waitingForNext = false; PlaybackRequested = play; sourceReady = false; resumeStartPending = false;
        if (!ReferenceEquals(sequence, queue)) queueSnapshot = null;
        queue.Clear(); queue.AddRange(selected); index = selectedIndex;
        if (!advance) order = selected.ToList();
        if (!advance) manualQueue.Clear(); else manualQueue.Remove(selected[selectedIndex]);
        track = session.CurrentRecording(track);
        Current = track;
        if (!retry) { listenRecorded = false; listenedSeconds = 0; }
        lastListeningPosition = 0;
        streamedDecks.Remove(deck);
        if (playActions.Remove(deck, out var replaced) && replaced != action
            && !replaced.Stages.Contains("playing") && !replaced.Stages.Contains("fallback_playing") && !replaced.Stages.Contains("failed"))
            Report(replaced, "cancelled");
        deck.Stop(); session.PinPlayback(null); session.PinPreparingPlayback(track.Id);
#if ANDROID
        openingAttempt = (version, action);
#endif
        Changed?.Invoke();
        void Restore()
        {
            var replacedUpcoming = replacementRevision != upcomingReplacementRevision;
            var additions = queue.Skip(replacedUpcoming ? index + 1 : selected.Count).ToList();
            queueSnapshot = null; queue.Clear();
            queue.AddRange(replacedUpcoming ? previousQueue.Take(previousIndex + 1) : previousQueue);
            queue.AddRange(additions);
            manualQueue.Clear();
            if (!replacedUpcoming) foreach (var entry in previousManual) manualQueue.Add(entry);
            index = previousIndex; Current = previousTrack;
            order = replacedUpcoming ? queue.ToList() : previousOrder;
            if (retrySource is null) PlaybackRequested = false;
            session.PinPlayback(null);
        }
        try
        {
            if (openedNext is not null)
            {
                deck.TransportEnabled = false;
                standby = deck; deck = openedNext;
                preparedTrack = null; session.PinUpcomingPlayback(null);
                Current = queue[index] = selected[selectedIndex];
                session.PinPlayback(Current.Id);
                if (action is not null) playActions[deck] = action;
                sourceReady = true; deck.TransportEnabled = !FollowingHost; ApplyVolumes();
                deck.SetPlaying(PlaybackRequested);
                if (PlaybackRequested && action is not null) _ = WatchPlaybackStartAsync(deck, action, version);
                return;
            }
            var path = await PrepareFile(track, cancellation.Token, background: background, action: action,
                fallback: useFallback, retrySource: retrySource, directStream: directStream);
            cancellation.Token.ThrowIfCancellationRequested();
            if (version != requestVersion) return;
            track = path == retrySource && previousTrack is not null
                ? previousTrack : session.PlaybackRecording(session.CurrentRecording(track), path);
            if (selected[selectedIndex].IsDeezerSuggestion && !track.IsDeezerSuggestion)
            {
                var original = order.FindIndex(entry => entry.Id == selected[selectedIndex].Id);
                if (original >= 0) order[original] = track;
            }
            Current = track; queue[index] = track; session.PinPlayback(track.Id);
            sourceReady = true; deck.TransportEnabled = !FollowingHost; ApplyVolumes();
            MarkStream(deck, path);
            if (action is not null) playActions[deck] = action;
            resumeStartPending = PlaybackRequested && resumePosition is > 0;
            deck.PlayFile(path, track.Title, track.Channel, PlaybackRequested && !resumeStartPending, background);
            if (PlaybackRequested && action is not null) _ = WatchPlaybackStartAsync(deck, action, version);
        }
        catch (OperationCanceledException error)
        {
            if (version != requestVersion) { Report(action, "cancelled"); return; }
            if (retrySource is null) Report(action, "failed");
            sourceReady = false; Restore();
            throw new InvalidOperationException("The server took too long to prepare this song. Try playing it again.", error);
        }
        catch
        {
            if (version != requestVersion) return;
            if (retrySource is null) Report(action, "failed");
            sourceReady = false; Restore(); throw;
        }
        finally
        {
            if (version == requestVersion)
            {
#if ANDROID
                openingAttempt = default;
#endif
                preparation = null; preparing = false; session.PinPreparingPlayback(null); Changed?.Invoke();
                await ApplyResumePositionAsync();
                if (Playing) WarmNext();
            }
        }
    }
    private async Task WatchPlaybackStartAsync(IAudioDeck owner, PlayAction action, long version)
    {
        await Task.Delay(TimeSpan.FromSeconds(12));
        if (requestVersion == version && playActions.GetValueOrDefault(owner) == action && PlaybackRequested
            && ReferenceEquals(deck, owner) && !action.Progressed)
            HandleDeckFailure(owner);
    }

    private async Task<string> PrepareFile(MusicTrack track, CancellationToken token, bool background = false,
        PlayAction? action = null, bool fallback = false, string? retrySource = null, bool directStream = false)
    {
        var path = session.LocalPath(track);
        if (path is not null) { Report(action, "kept_download"); return path; }
        // Reopen the same stream edition so the native seek still uses the same timeline.
        if (retrySource is not null) return retrySource;
        if (!directStream || !session.Connected || !session.CanStream)
        {
            if (!fallback || !session.Connected)
            {
                path = await session.GetCachedPlaybackPathAsync(track, token);
                if (path is not null) { Report(action, "cache_hit"); return path; }
                Report(action, "cache_miss");
            }
        }
        if (!session.Connected) throw new InvalidOperationException("This song is not downloaded on this device. Connect to play it.");
        var saved = await session.EnsureServerRecordingAsync(track, token, session.CanStream, background, action: action?.Id, fallback: fallback);
        async Task<string> OpenWithRetry(Func<MusicTrack, Task<string>> open)
        {
            var refresh = false;
            for (var attempt = 0; ; attempt++)
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    if (refresh)
                    {
                        saved = await session.EnsureServerRecordingAsync(saved, token, allowPreview: session.CanStream,
                            background: background, action: action?.Id, fallback: true);
                        refresh = false;
                    }
                    return await open(saved);
                }
                catch (FamilyHubApiException error) when (error.StatusCode is 503 or 409 && attempt < playbackOpenRetryDelays.Length)
                {
                    refresh |= error.StatusCode == 409;
                    var delay = Math.Max(playbackOpenRetryDelays[attempt], error.RetryAfter?.TotalMilliseconds ?? 0);
                    await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(delay, TimeSpan.FromDays(1).TotalMilliseconds)), token);
                }
            }
        }
        Task<string> OpenStream(MusicTrack recording) => session.StreamPlaybackAsync(recording, 0, token, background, action?.Id);
        if (session.CanStream && (!fallback || !ReferenceEquals(saved, track)))
        {
            try { return await OpenWithRetry(OpenStream); }
            catch (Exception error) when (!fallback && !directStream && error is (InvalidDataException or HttpRequestException
                or FamilyHubApiException { StatusCode: not (503 or 409) }))
            {
                Report(action, "stream_failed");
                if (action is not null) action.Fallback = true;
                Report(action, "fallback");
                saved = await session.EnsureServerRecordingAsync(saved, token, allowPreview: true, background: background,
                    action: action?.Id, fallback: true);
                return await OpenWithRetry(OpenStream);
            }
        }
        return await OpenWithRetry(recording => session.CachePlaybackAsync(recording, token, background: background));
    }
    internal void PlaybackNetworkChanged()
    {
        if (!blending && (downloadingUpcoming ? !session.CanCacheUpcoming :
            !session.CanWarmPlayback && (warming || standby is not null && streamedDecks.ContainsKey(standby))))
            CancelUpcoming(preserveChoice: true);
        else if ((session.CanWarmPlayback || session.CanCacheUpcoming) && preparedTrack is null && !warming)
        { attemptedNext = null; retryUpcomingAt = 0; }
        if (PlaybackRequested) WarmNext();
    }
    internal void UpcomingCacheSettingsChanged()
    {
        if (downloadingUpcoming) CancelUpcoming(preserveChoice: true);
        PlaybackNetworkChanged();
    }

    private bool CanDownloadUpcoming(MusicTrack track) => session.CanCacheUpcoming && session.Connected && Autoplay
        && sourceReady && !preparing && Playing && !Seeking && !FollowingHost && (track.Saved || Position >= 15);

    private void WarmNext()
    {
        if (receivingHandoff) return;
        if (RepeatMode == "one" || standby is null || blending || warming || !PlaybackRequested || index + 1 >= queue.Count) return;
        if (warmupFailures >= 2 || warmupFailures > 0 && Position < warmupRetryPosition) return;
        var next = index + 1;
        if (ReferenceEquals(preparedTrack, queue[next]) && !incomingFailed) return;
        var early = session.CanCacheUpcoming && !ReferenceEquals(attemptedCacheNext, queue[next])
            && CanDownloadUpcoming(session.CurrentRecording(queue[next]));
        if (!early && (Current?.PlaybackVersion is "preview-hls" or "preview-source"
            || Duration <= 0 || Duration - Position > Math.Max(30, FadeDuration + 15))) return;
        var key = requestVersion + ":" + next + ":" + queue[next].Id;
        if (!early && (attemptedNext == key || Environment.TickCount64 < retryUpcomingAt)) return;
        if (Shuffle && !preserveHandoffOrder && !FollowingHost && !nextChosen && !manualQueue.Contains(queue[next]))
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
        var attemptedDownload = false;
        var opened = false;
        string? warmupAction = null;
        var attempted = false;
        void StartWarmup()
        {
            if (attempted) return;
            attempted = true;
            if (deck is { } owner && playActions.TryGetValue(owner, out var action))
            {
                warmupAction = action.Id;
                session.RecordPlaybackObservation(action.Id, "next_warmup_start", Position, null);
            }
        }
        session.PinPreparingNextPlayback(original.Id);
        try
        {
            var track = session.CurrentRecording(original);
            var early = !ReferenceEquals(attemptedCacheNext, original) && CanDownloadUpcoming(track);
            if (early)
            {
                attemptedCacheNext = original;
                StartWarmup();
            }
            var path = session.LocalPath(track) ?? await session.GetCachedPlaybackPathAsync(track, token);
            token.ThrowIfCancellationRequested();
            if (path is null && early && CanDownloadUpcoming(track))
            {
                downloadingUpcoming = attemptedDownload = true;
                if (!track.Saved)
                    track = await session.EnsureServerRecordingAsync(track, token, background: true, prefetch: true);
                path = await session.CachePlaybackAsync(track, token, lead: Math.Max(0, Duration - Position),
                    background: true, upcoming: true);
            }
            if (path is null)
            {
                // On other connections only open an existing stream near the transition.
                if (!session.CanWarmPlayback || !session.CanStream || !track.Saved || !session.Connected)
                    return;
                if (warmupFailures == 0 && Duration - Position > FadeDuration + 8)
                {
                    attemptedNext = null; retryUpcomingAt = Environment.TickCount64 + 2000;
                    return;
                }
                StartWarmup();
                path = await session.StreamPlaybackAsync(track, 0, token, background: true);
            }
            token.ThrowIfCancellationRequested();
            if (version != requestVersion || next >= queue.Count || !ReferenceEquals(queue[next], original) || standby is null) return;
            track = session.PlaybackRecording(session.CurrentRecording(track), path);
            if (manualQueue.Remove(original)) { track = track with { }; manualQueue.Add(track); }
            queue[next] = track;
            incomingFailed = false;
            standby.Stop(); playActions.Remove(standby); standby.TransportEnabled = false; standby.Volume = 0;
            MarkStream(standby, path);
            StartWarmup();
            standbyWarmupAction = warmupAction;
            preparedTrack = track;
            standby.PlayFile(path, track.Title, track.Channel, false, background: true);
            if (!incomingFailed) session.PinUpcomingPlayback(track.Id);
            if (MusicSession.IsStream(path)) _ = WatchUpcomingOpenAsync(standby, track, token);
            cancellation.CancelAfter(Timeout.InfiniteTimeSpan);
            opened = !incomingFailed;
        }
        catch (Exception error)
        {
            // Every failure is recorded with its cause (Android exceptions included), so the server log explains it.
            if (ReferenceEquals(upcomingPreparation, cancellation) && version == requestVersion)
            {
                if (next < queue.Count)
                {
                    StartWarmup();
                    RecordWarmupFailure(queue[next], warmupAction,
                        FailureReason(error, cancelled: token.IsCancellationRequested));
                }
                preparedTrack = null;
                if (standby is { } owner) { streamedDecks.Remove(owner); owner.Stop(); }
            }
        }
        finally
        {
            if (ReferenceEquals(upcomingPreparation, cancellation))
            {
                warming = false; downloadingUpcoming = false; session.PinPreparingNextPlayback(null);
                if (attemptedDownload && !Playing && !opened) Changed?.Invoke();
            }
        }
        if (opened)
        {
            if (standby?.Opening == false) FinishWarmup();
            Changed?.Invoke(); TryBlend();
        }
    }

    // A short cause for a failed playback step: categories and exception type names only, never messages or URLs.
    private static string FailureReason(Exception error, bool cancelled = false) => error switch
    {
        OperationCanceledException or TimeoutException => cancelled ? "cancelled" : "timeout",
        FamilyHubApiException { StatusCode: 503 } => "server_busy",
        FamilyHubApiException { StatusCode: 404 or 410 } => "not_found",
        FamilyHubApiException { StatusCode: 401 or 403 } => "unauthorized",
        FamilyHubApiException { StatusCode: 409 } => "changed",
        FamilyHubApiException => "server_error",
        HttpRequestException => "network",
        UnauthorizedAccessException => "storage_denied",
        InvalidDataException => "invalid_data",
        IOException => "io",
        _ => "exception:" + error.GetType().Name,
    };

    private void FinishWarmup()
    {
        if (standbyWarmupAction is not { } action) return;
        standbyWarmupAction = null;
        failedNext = null;
        session.RecordPlaybackObservation(action, "next_warmup_finish", Position, null);
    }

    private void RecordWarmupFailure(MusicTrack track, string? action = null, string? reason = null)
    {
        action ??= standbyWarmupAction;
        if (action is null && deck is { } owner) action = playActions.GetValueOrDefault(owner)?.Id;
        if (action is not null) session.RecordPlaybackObservation(action, "next_warmup_failed", Position, reason ?? "player");
        standbyWarmupAction = null;
        failedNext = track;
        warmupFailures++;
        warmupRetryPosition = Position + 5;
        attemptedNext = null;
        retryUpcomingAt = 0;
        if (!track.Saved || !session.CanWarmPlayback) attemptedCacheNext = null;
    }
    private async Task WatchUpcomingOpenAsync(IAudioDeck owner, MusicTrack track, CancellationToken token)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(8), token); }
        catch (OperationCanceledException) { return; }
        if (ReferenceEquals(preparedTrack, track) && ReferenceEquals(standby, owner) && owner.Opening)
            HandleDeckFailure(owner);
    }
    private int PreparedIndex => preparedTrack is null ? -1 : queue.FindIndex(index + 1, t => ReferenceEquals(t, preparedTrack));
    private bool IncomingReady => !warming && standby is not null && preparedTrack is not null
        && !standby.Opening && !incomingFailed && PreparedIndex > index;
    private void TryBlend()
    {
        if (Current?.PlaybackVersion is "preview-hls" or "preview-source" || preparedTrack?.PlaybackVersion is "preview-hls" or "preview-source") return;
        if (!Autoplay || RepeatMode == "one" || !AutoDj || FollowingHost || blending || preparing || !sourceReady || !Playing || !PlaybackRequested || !IncomingReady || Duration <= 0) return;
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
        ApplyVolumes();
        incomingStarted = null; incomingOwner = session.HistoryOwner;
        var version = requestVersion; var outgoing = deck; var incoming = standby;
        var action = BeginPlayback();
        RememberPlaybackAttempt(action, incomingTrack);
        playActions[incoming] = action;
        ObservePlayback(incoming, audible: false);
        try
        {
            if (next != blendTarget) Changed?.Invoke();
            await DeckCrossfade.RunAsync(outgoing, incoming, duration ?? FadeDuration,
                () => PlaybackRequested, SetBlendGain, cancellation.Token, () => incomingFailed, elapsed);
            if (version != requestVersion || !blending) return;
            FinishListening(completed ? "completed" : "skipped");
            eventSource = manualQueue.Contains(incomingTrack) ? "queue" : queueSource == "search" ? "auto_dj" : queueSource;
            eventFinalized = false;
            eventStarted = incomingOwner == session.HistoryOwner && !session.PlaybackPreferences.ListeningHistoryPaused ? incomingStarted : null;
            eventOwner = incomingOwner; incomingStarted = null;
            deck = incoming; standby = outgoing;
            index = blendTarget; Current = incomingTrack; manualQueue.Remove(incomingTrack);
            preparedTrack = null; attemptedNext = null; upcomingPreparation = null;
            warmupFailures = 0; warmupRetryPosition = 0;
            blending = false; blendTarget = -1; blendGain = 0;
            listenRecorded = false; listenedSeconds = eventStarted is not null ? incoming.Position : 0; lastListeningPosition = incoming.Position;
            deck.TransportEnabled = !FollowingHost; standby.TransportEnabled = false; standby.Stop(); ApplyVolumes();
            session.PinPlayback(incomingTrack.Id); session.PinUpcomingPlayback(null); session.PinPreparingNextPlayback(null);
            Changed?.Invoke(); WarmNext();
        }
        catch (OperationCanceledException) { }
        catch (Exception)
        {
            if (version == requestVersion && ReferenceEquals(deck, outgoing))
            {
                Report(action, "failed");
                blending = false; blendTarget = -1; preparedTrack = null; incoming.Stop(); blendGain = 0; ApplyVolumes();
                session.SetMessage("The transition could not finish. Choose a song from the queue.", "error"); Changed?.Invoke();
                if (outgoing.Duration > 0 && TracePosition(outgoing) >= outgoing.Duration - .1) await NextCoreAsync(background: true);
            }
        }
        finally { if (ReferenceEquals(upcomingPreparation, cancellation)) upcomingPreparation = null; }
    }
    private void CancelUpcoming(bool keepReady = false, bool preserveChoice = false)
    {
        var cancellation = upcomingPreparation;
        upcomingPreparation = null;
        cancellation?.Cancel(); cancellation?.Dispose();
        warming = false; downloadingUpcoming = false; attemptedNext = null; attemptedCacheNext = null;
        standbyWarmupAction = null;
        if (!preserveChoice)
        {
            nextChosen = false; retryUpcomingAt = 0;
            failedNext = null;
            warmupFailures = 0; warmupRetryPosition = 0;
        }
        if (!keepReady)
        {
            FinishIncomingListening("skipped");
            blending = false; blendTarget = -1; preparedTrack = null; blendGain = 0;
            if (standby is { } owner)
            {
                streamedDecks.Remove(owner);
                playActions.Remove(owner);
                owner.Stop();
            }
            session.PinUpcomingPlayback(null);
        }
        session.PinPreparingNextPlayback(null); ApplyVolumes();
    }
    private void ApplyVolumes()
    {
        outgoingVolume = TrackVolume(Current);
        incomingVolume = blending ? TrackVolume(preparedTrack) : 0;
        ApplyFadeVolumes();
    }
    private void ApplyFadeVolumes()
    {
        if (deck is not null) deck.Volume = outgoingVolume * (blending ? 1 - blendGain : 1);
        if (standby is not null) standby.Volume = incomingVolume * blendGain;
    }
    private void SetBlendGain(double gain)
    {
        var previous = ShowingIncoming;
        blendGain = gain;
        ApplyFadeVolumes();
        if (previous != ShowingIncoming) Changed?.Invoke();
    }
    private double TrackVolume(MusicTrack? track)
    {
        var db = NormalizationGainDb(track, session.PlaybackPreferences.VolumeLevel, session.EvenSongVolume);
        // Native deck volume tops out at unity. Positive gain can use headroom below it.
        return Math.Min(1, volume * Math.Pow(10, db / 20));
    }
    public static double NormalizationGainDb(MusicTrack? track, string level, bool enabled = true)
    {
        if (!enabled || track?.Lufs is not { } lufs || !double.IsFinite(lufs)
            || track.TruePeak is not { } peak || !double.IsFinite(peak)) return 0;
        var target = level switch
        {
            "loud" => -11,
            "normal" => -14,
            "quiet" => -19,
            _ => throw new ArgumentException("Choose Loud, Normal or Quiet volume level.")
        };
        return Math.Min(6, Math.Min(target - lufs, -1 - peak));
    }
    public bool ReplaceUpcoming(string seedId, IEnumerable<MusicTrack> tracks, string source = "auto_dj")
    {
        RequirePlaybackControl();
        if (Current?.Id != seedId) return false;
        var candidates = tracks.Where(t => t.Id != seedId).DistinctBy(t => t.Id).ToList();
        if (candidates.Count == 0) return false;
        upcomingReplacementRevision++;
        var keep = blending ? blendTarget + 1 : index + 1;
        if (!blending) CancelUpcoming();
        queueSnapshot = null; queue.RemoveRange(keep, queue.Count - keep);
        manualQueue.Clear(); queueSource = source;
        var audibleNext = blending ? preparedTrack?.Id : null;
        queue.AddRange(candidates.Where(t => t.Id != audibleNext));
        order = queue.ToList();
        Changed?.Invoke(); if (Playing && !blending) WarmNext();
        return true;
    }
    public Task ToggleAsync() => RemoteActive ? RemoteToggleAsync() : ToggleCoreAsync(true);
    internal Task SetTransportPlayingAsync(bool play) => ToggleCoreAsync(true, play);
    private Task ToggleCoreAsync(bool localUserAction, bool? play = null)
    {
        var started = PlaybackTimestamp();
        return MainThread.InvokeOnMainThreadAsync(async () =>
        {
            RequirePlaybackControl();
            if (deck is null || Current is null || RemoteActive) return;
            var interrupted = PlaybackInterrupted;
            var start = play ?? (interrupted || !PlaybackRequested);
            if (play.HasValue && start == PlaybackRequested && !interrupted) return;
            if (localUserAction) UserPlaybackRevision++;
            if (localUserAction && start) session.MarkLocalPlayback();
            if (interrupted) SaveInterruptedPosition();
            if (start && (interrupted || !preparing && !sourceReady))
            {
                await PlayCoreAsync(Current, queue, index, true, advance: interrupted, retry: interrupted,
                    background: !localUserAction, requestedAt: started);
                return;
            }
            PlaybackRequested = start;
            ControlRevision++;
            if (PlaybackRequested && !preparing && !blending)
            {
                var action = BeginPlayback(started);
                RememberPlaybackAttempt(action, Current);
                playActions[deck] = action;
                _ = WatchPlaybackStartAsync(deck, action, requestVersion);
            }
            if (!PlaybackRequested && !blending) CancelUpcoming(preserveChoice: true);
            if (interrupted)
            {
                sourceReady = false;
                deck.Stop(); session.PinPlayback(null);
            }
            else if (!preparing && !resumeStartPending) { deck.SetPlaying(PlaybackRequested); if (blending) standby?.SetPlaying(PlaybackRequested); }
            if (PlaybackRequested && !blending) WarmNext();
            Changed?.Invoke();
        });
    }
    public Task SetVolumeAsync(double value) => MainThread.InvokeOnMainThreadAsync(() =>
    {
        if (!double.IsFinite(value)) throw new ArgumentOutOfRangeException(nameof(value));
        volume = Math.Clamp(value, 0, 1); ApplyVolumes(); Changed?.Invoke();
    });
    public Task SetEvenSongVolumeAsync(bool enabled) => MainThread.InvokeOnMainThreadAsync(() =>
    {
        session.SetEvenSongVolume(enabled);
        ApplyVolumes();
        Changed?.Invoke();
    });
    public void ToggleShuffle()
    {
        RequirePlaybackControl();
        Shuffle = !Shuffle;
        if (!Shuffle && !blending && !preserveHandoffOrder) RestoreOrder();
        preserveHandoffOrder = false;
        if (!blending) CancelUpcoming(true);
        Changed?.Invoke(); if (Playing) WarmNext();
    }
    private async Task SeekDeckAsync(double seconds, bool confirm = false)
    {
        if (deck is not { } owner || Seeking) return;
        var version = requestVersion;
        seekingVersion = version; lastListeningPosition = seconds; session.InvalidateListeningBaseline();
        if (playActions.TryGetValue(owner, out var action)) action.Position = null;
        try
        {
            var seek = owner.SeekAsync(seconds);
            if (confirm) await seek.WaitAsync(TimeSpan.FromSeconds(8));
            else await seek;
            if (confirm)
            {
                owner.RefreshPosition();
                var actual = owner.SeekPosition;
                if (!double.IsFinite(actual) || Math.Abs(actual - seconds) > .5)
                    throw new InvalidOperationException("The player could not restore the saved position.");
            }
        }
        finally
        {
            if (seekingVersion == version) seekingVersion = null;
            if (requestVersion == version) { SeekRevision++; session.InvalidateListeningBaseline(); Changed?.Invoke(); }
        }
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
        if (blending || downloadingUpcoming) CancelUpcoming(preserveChoice: true);
        lastListeningPosition = Math.Clamp(seconds, 0, Duration);
        var version = requestVersion;
        try { await SeekDeckAsync(lastListeningPosition); }
        catch (Exception error) when (error is TimeoutException or OperationCanceledException or InvalidOperationException)
        {
            if (version == requestVersion)
                session.SetMessage("The player could not seek to that position. Try again.", "error", playback: true);
            return;
        }
        if (version == requestVersion && Playing) WarmNext();
    });
    public Task NextAsync() { if (RemoteActive) return SendRemoteAsync("next"); RequirePlaybackControl(); return MainThread.InvokeOnMainThreadAsync(() => NextCoreAsync(background: false)); }
    private Task NextCoreAsync(bool background, bool directStream = false)
    {
        if (!background) UserPlaybackRevision++;
        var next = blending ? blendTarget + 1 : index + 1;
        if (next >= queue.Count)
        {
            if (RepeatMode == "off" || FollowingHost || queue.Count == 0) return Task.CompletedTask;
            next = 0;
        }
        if (Current?.PlaybackVersion is not ("preview-hls" or "preview-source") && preparedTrack?.PlaybackVersion is not ("preview-hls" or "preview-source")
            && AutoDj && !blending && IncomingReady && Playing && Duration - Position > .15) return BlendAsync();
        var sequence = queue;
        if (Shuffle && !preserveHandoffOrder && !FollowingHost && !manualQueue.Contains(queue[next]) && !nextChosen && !ReferenceEquals(preparedTrack, queue[next]))
        {
            var chosen = Random.Shared.Next(next, queue.Count);
            if (chosen != next)
            {
                sequence = queue.ToList();
                (sequence[next], sequence[chosen]) = (sequence[chosen], sequence[next]);
            }
        }
        var nextTrack = sequence[next];
        var warmupUnavailable = ReferenceEquals(nextTrack, failedNext)
            || !IncomingReady && next == index + 1 && (warming || ReferenceEquals(nextTrack, preparedTrack)
                || !UiActive && standby is not null && session.CanWarmPlayback);
        return PlayCoreAsync(nextTrack, sequence, next, Current is null || PlaybackRequested, true, background: background,
            directStream: directStream || background && warmupUnavailable);
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

    public Task ContinueQueueAsync(long revision) => MainThread.InvokeOnMainThreadAsync(() =>
    {
        if (!waitingForNext || UserPlaybackRevision != revision || Preparing || FollowingHost || RemoteActive || index + 1 >= queue.Count)
            return Task.CompletedTask;
        waitingForNext = false;
        PlaybackRequested = true;
        return NextCoreAsync(background: true);
    });

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
            if (!manual) order.Add(entry);
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
    internal sealed record LoadedHandoff(MusicTrack Track, IReadOnlyList<MusicTrack> Queue, int Index, IAudioDeck Deck, PlaybackResume State);
    internal LoadedHandoff? ReportingHandoff { get; private set; }
    private bool receivingHandoff, handoffTrackEnded;

    private async Task<bool> TakeOverAsync(PlaybackResume state, IEnumerable<MusicTrack> available, bool play,
        Func<Task<bool>> confirm, CancellationToken token)
    {
        if (deck is null || standby is not { } incoming || receivingHandoff) return false;
        var recordings = available.DistinctBy(t => t.Id).ToDictionary(t => t.Id);
        var tracks = new MusicTrack[state.TrackIds.Count];
        for (var i = 0; i < tracks.Length; i++)
        {
            var id = state.TrackIds[i];
            if (!recordings.TryGetValue(id, out var recording))
            {
                if (id.StartsWith("local-", StringComparison.Ordinal)) return false;
                recording = new() { Id = id, Title = id, Url = "https://www.youtube.com/watch?v=" + id };
            }
            tracks[i] = recording;
        }
        var at = state.Index;
        var track = tracks[at];
        var action = play ? BeginPlayback() : null;
        RememberPlaybackAttempt(action, track);
        var version = requestVersion;
        receivingHandoff = true; handoffTrackEnded = false;
        CancelUpcoming();
        bool CurrentRequest() => version == requestVersion && !FollowingHost && ReferenceEquals(standby, incoming);
        try
        {
            var original = track;
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var path = await PrepareFile(track, token, background: true, action: action, fallback: attempt > 0);
                if (!CurrentRequest()) return false;
                token.ThrowIfCancellationRequested();
                track = tracks[at] = session.PlaybackRecording(original, path);
                session.PinUpcomingPlayback(track.Id);
                incomingFailed = false;
                incoming.TransportEnabled = false;
                MarkStream(incoming, path);
                incoming.PlayFile(path, track.Title, track.Channel, false, background: true);
                while (CurrentRequest() && !incomingFailed && (incoming.Opening || incoming.Duration <= 0))
                    await Task.Delay(50, token);
                if (!incomingFailed || !MusicSession.IsStream(path) || attempt > 0) break;
                Report(action, "stream_failed");
                if (action is not null) action.Fallback = true;
                Report(action, "fallback");
            }
            if (!CurrentRequest() || incomingFailed) return false;
            if (action is not null) playActions[incoming] = action;
            ObservePlayback(incoming, audible: false);
            if (state.Position > 0) await incoming.SeekAsync(state.Position).WaitAsync(token);
            if (!CurrentRequest() || incomingFailed) return false;
            if (play) incoming.SetPlaying(true);
            while (CurrentRequest() && !incomingFailed && (incoming.Opening || incoming.Playing != play))
                await Task.Delay(50, token);
            if (!CurrentRequest() || incomingFailed || !double.IsFinite(incoming.Position) || Math.Abs(incoming.Position - state.Position) > 5) return false;
            ObservePlayback(incoming, audible: false);

            ReportingHandoff = new(track, tracks, at, incoming, state);
            if (!await confirm() || !CurrentRequest() || incomingFailed) return false;
            FinishListening("stopped");
            ++requestVersion; preparation?.Cancel(); preparing = false;
            standby = deck; deck = incoming;
            standby.TransportEnabled = false; standby.Stop();
            RemoteDeviceId = RemoteDeviceName = ""; RemotePlaying = false;
            queueSnapshot = null; queue.Clear(); queue.AddRange(tracks); order = tracks.ToList(); manualQueue.Clear();
            Shuffle = state.Shuffle ?? Shuffle; repeatMode = state.RepeatMode ?? repeatMode;
            Autoplay = state.Autoplay ?? true; preserveHandoffOrder = true;
            index = at; Current = track; sourceReady = true; PlaybackRequested = play;
            resumePosition = null; resumeStartPending = false; queueSource = eventSource = "other";
            eventStarted = null; eventFinalized = false; listenRecorded = false; listenedSeconds = 0; lastListeningPosition = incoming.Position;
            deck.TransportEnabled = true; ApplyVolumes();
            ObservePlayback(incoming, audible: true);
            session.PinPlayback(track.Id); session.PinPreparingPlayback(null); ControlRevision++;
            return true;
        }
        finally
        {
            ReportingHandoff = null; receivingHandoff = false;
            if (ReferenceEquals(standby, incoming))
            {
                Report(action, "failed");
                streamedDecks.Remove(incoming); playActions.Remove(incoming);
                incoming.Stop();
            }
            session.PinUpcomingPlayback(null);
            if (ReferenceEquals(deck, incoming) && handoffTrackEnded && play) _ = AdvanceAfterEndAsync();
            else { Changed?.Invoke(); if (Playing) WarmNext(); }
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
            case "play": await ToggleCoreAsync(false, true); break;
            case "pause": await ToggleCoreAsync(false, false); break;
            case "next": await NextCoreAsync(background: true); break;
            case "previous": await PreviousAsync(background: true); break;
            case "seek" when control.Position is { } seconds: await SeekAsync(seconds, background: true); break;
        }
    });
    public Task StopAsync() => MainThread.InvokeOnMainThreadAsync(() =>
    {
        UserPlaybackRevision++; waitingForNext = false;
        FinishListening("stopped"); FinishIncomingListening("stopped");
        ++requestVersion; preparation?.Cancel(); preparation = null;
        preparing = false; sourceReady = false; PlaybackRequested = false; resumeStartPending = false;
        CancelUpcoming(); deck?.Stop(); session.PinPlayback(null); session.PinPreparingPlayback(null);
        resumePosition = null; Current = null; queueSnapshot = null; queue.Clear(); manualQueue.Clear(); index = -1; Changed?.Invoke();
    });
}
