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
    private bool listenRecorded;
    private string? attemptedNext;
    private bool nextChosen;
    private long retryUpcomingAt;
    private double? resumePosition;
    private MusicTrack? preparedTrack;
    private long lastProgressNotice;
    private long lastHostControl = -1, lastDriftSeek;
    private double filteredDrift;
    private int largeDriftSamples, driftDirection;
    public long ControlRevision { get; private set; }
    private int syncSeeks;
    public event Action? Changed;
    public MusicTrack? Current { get; private set; }
    public IReadOnlyList<MusicTrack> Queue => queue;
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
    public bool FollowingHost { get; set; }
    /// <summary>The device this profile's playback was sent to from here; empty while playing here.</summary>
    public string RemoteDeviceName { get; private set; } = "";
    public string RemoteDeviceId { get; private set; } = "";
    public bool RemoteActive => RemoteDeviceId.Length > 0;
    /// <summary>Whether the device this profile's music was sent to is playing (as last reported).</summary>
    public bool RemotePlaying { get; private set; }
    private DateTime remoteAt;

    // Remote mode: this device's copy of the queue follows the other device; resumePosition holds
    // its position, and the transport buttons send actions there instead of playing here.
    public void EnterRemote(string deviceId, string name, double position, bool playing)
    {
        if (FollowingHost) return;
        RemoteDeviceId = deviceId; RemoteDeviceName = name; RemotePlaying = playing; remoteAt = DateTime.UtcNow;
        ++requestVersion; preparation?.Cancel(); preparation = null;
        preparing = false; PlaybackRequested = false; sourceReady = false;
        CancelUpcoming();
        if (deck is not null) { deck.TransportEnabled = false; deck.SetPlaying(false); }
        session.PinPreparingPlayback(null);
        resumePosition = Math.Max(0, position); ControlRevision++;
        Changed?.Invoke();
    }
    public void ApplyRemoteState(string trackId, bool playing, double? position)
    {
        if (!RemoteActive) return;
        var at = trackId.Length > 0 ? queue.FindIndex(t => t.Id == trackId) : -1;
        if (at >= 0 && at != index) { index = at; Current = queue[at]; }
        if (position is { } seconds) { resumePosition = Math.Max(0, seconds); remoteAt = DateTime.UtcNow; }
        RemotePlaying = playing;
        Changed?.Invoke();
    }
    /// <summary>Redraws the position while the other device plays (MainPage calls it twice a second).</summary>
    public void RemoteTick() { if (RemoteActive && RemotePlaying) Changed?.Invoke(); }
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
        resumePosition = Position; remoteAt = DateTime.UtcNow; RemotePlaying = false; Changed?.Invoke();
        return SendRemoteAsync("pause");
    }
    public Task PauseLocallyAsync() => MainThread.InvokeOnMainThreadAsync(() =>
    {
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
    public double Position => !sourceReady && resumePosition is { } saved
        ? RemoteActive && RemotePlaying ? Math.Min(saved + (DateTime.UtcNow - remoteAt).TotalSeconds, Current?.Duration is > 0 and var length ? length : double.MaxValue) : saved
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

    public PlaybackResume? CaptureResume() => Current is not null && !FollowingHost && !Preparing && index >= 0 && queue.Count <= 1000
        ? new() { TrackIds = queue.Select(t => t.Id).ToList(), Index = index, Position = Math.Max(0, Position) } : null;
    public void RestoreResume(PlaybackResume state, IEnumerable<MusicTrack> available)
    {
        if (Current is not null && (sourceReady || preparing || PlaybackRequested) || FollowingHost || !state.IsValid) return;
        var recordings = available.DistinctBy(t => t.Id).ToDictionary(t => t.Id);
        if (!recordings.ContainsKey(state.TrackIds[state.Index])) return;
        var restored = state.TrackIds.Select((id, at) => (id, at)).Where(row => recordings.ContainsKey(row.id)).ToList();
        queue.Clear(); queue.AddRange(restored.Select(row => recordings[row.id]));
        order = queue.ToList();
        index = restored.FindIndex(row => row.at == state.Index); Current = queue[index];
        resumePosition = Math.Clamp(state.Position, 0, Math.Max(0, Current.Duration));
        sourceReady = false; PlaybackRequested = false; Changed?.Invoke();
    }
    private async Task ApplyResumePositionAsync()
    {
        if (resumePosition is not { } position || !sourceReady || preparing || deck is null || deck.Opening || deck.Duration <= 0) return;
        resumePosition = null;
        try { await SeekDeckAsync(Math.Clamp(position, 0, deck.Duration)); }
        catch (Exception error) when (error is IOException or InvalidOperationException) { }
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
                if (!preparing && sourceReady && !blending)
                {
                    // Native transport play changes the deck directly; app and remote actions set intent first.
                    if (!PlaybackRequested && owner.PlaybackRequested && !FollowingHost && !RemoteActive) session.MarkLocalPlayback();
                    PlaybackRequested = owner.PlaybackRequested;
                }
                _ = ApplyResumePositionAsync();
                RecordListening();
                if (Environment.TickCount64 - lastProgressNotice >= 200)
                { lastProgressNotice = Environment.TickCount64; Changed?.Invoke(); }
                if (!preparing && sourceReady && Playing) { WarmNext(); TryBlend(); }
            }
            else if (ReferenceEquals(standby, owner)) TryBlend();
        };
        owner.Ended += async () =>
        {
            if (!ReferenceEquals(deck, owner) || preparing || blending || !sourceReady || !PlaybackRequested) return;
            try
            {
                if (RepeatMode == "one" && !FollowingHost && Current is { } repeated)
                    await PlayCoreAsync(repeated, queue.ToList(), index, true, true);
                else if (index + 1 < queue.Count || RepeatMode == "all" && !FollowingHost) await NextCoreAsync();
                else { PlaybackRequested = false; Changed?.Invoke(); }
            }
            catch (Exception error) { session.SetMessage(error.Message); }
        };
        owner.Failed += message =>
        {
            if (ReferenceEquals(deck, owner))
            { sourceReady = false; PlaybackRequested = false; session.SetMessage(message); Changed?.Invoke(); }
            else { incomingFailed = true; preparedTrack = null; }
        };
    }
    private void RecordListening()
    {
        var elapsed = Position - lastListeningPosition; lastListeningPosition = Position;
        if (sourceReady && Playing && elapsed is > 0 and < 5) listenedSeconds += elapsed;
        if (!listenRecorded && sourceReady && Playing && Current is { } track && listenedSeconds >= Math.Min(30, Duration > 0 ? Duration / 2 : 30))
        { session.RecordListen(track); listenRecorded = true; }
    }
    public Task PlayAsync(MusicTrack track, IEnumerable<MusicTrack>? sequence = null, int? sequenceStartIndex = null)
    {
        RequirePlaybackControl();
        return MainThread.InvokeOnMainThreadAsync(() =>
        {
            session.MarkLocalPlayback();
            LeaveRemote();
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
                await PlayCoreAsync(tracks[targetIndex], tracks, targetIndex, false);
                return;
            }
            if (Preparing || !sourceReady) return;
            if (!blending && !queue.Select(t => t.Id).SequenceEqual(tracks.Select(t => t.Id)))
            {
                CancelUpcoming(); queue.Clear(); queue.AddRange(tracks); manualQueue.Clear();
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

    private async Task PlayCoreAsync(MusicTrack track, IEnumerable<MusicTrack>? sequence, int? sequenceStartIndex, bool play, bool advance = false)
    {
        if (deck is null) throw new InvalidOperationException("Player is starting. Try again.");
        var selected = sequence?.ToList() ?? [track];
        var selectedIndex = sequenceStartIndex ?? selected.FindIndex(t => t.Id == track.Id);
        if (selectedIndex < 0 || selectedIndex >= selected.Count || selected[selectedIndex].Id != track.Id)
            throw new ArgumentException("Choose a recording in this queue.");
        if (Current?.Id != track.Id) resumePosition = null;
        var previousQueue = queue.ToList(); var previousIndex = index; var previousTrack = Current;
        var previousManual = manualQueue.ToArray();
        var version = ++requestVersion;
        ControlRevision++; lastHostControl = -1; filteredDrift = 0; largeDriftSamples = 0;
        CancelUpcoming(); preparation?.Cancel();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(10));
        preparation = cancellation;
        preparing = true; PlaybackRequested = play; sourceReady = false;
        queue.Clear(); queue.AddRange(selected); index = selectedIndex;
        if (!advance) order = selected.ToList();
        if (!advance) manualQueue.Clear(); else manualQueue.Remove(selected[selectedIndex]);
        track = session.CurrentRecording(track);
        Current = track; listenRecorded = false; listenedSeconds = lastListeningPosition = 0;
        deck.Stop(); session.PinPlayback(null); session.PinPreparingPlayback(track.Id); Changed?.Invoke();
        void Restore()
        {
            var additions = queue.Skip(selected.Count).ToList();
            queue.Clear(); queue.AddRange(previousQueue); queue.AddRange(additions);
            manualQueue.Clear(); foreach (var entry in previousManual) manualQueue.Add(entry);
            index = previousIndex; Current = previousTrack; PlaybackRequested = false; session.PinPlayback(null);
        }
        try
        {
            var path = await PrepareFile(track, cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            if (version != requestVersion) return;
            track = session.PlaybackRecording(session.CurrentRecording(track), path);
            Current = track; queue[index] = track; session.PinPlayback(track.Id);
            preparing = false; sourceReady = true; deck.TransportEnabled = !FollowingHost; ApplyVolumes();
            deck.PlayFile(path, track.Title, track.Channel, PlaybackRequested);
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
    private async Task<string> PrepareFile(MusicTrack track, CancellationToken token)
    {
        var path = session.LocalPath(track) ?? await session.GetCachedPlaybackPathAsync(track, token);
        if (path is not null) return path;
        if (!session.Connected) throw new InvalidOperationException("This song is not downloaded on this device. Connect to play it.");
        var saved = await session.EnsureServerRecordingAsync(track, token);
        return await session.CachePlaybackAsync(saved, token);
    }
    private void WarmNext()
    {
        if (RepeatMode == "one" || standby is null || blending || warming || !PlaybackRequested || index + 1 >= queue.Count) return;
        var next = index + 1;
        var key = requestVersion + ":" + next + ":" + queue[next].Id;
        if (attemptedNext == key || Environment.TickCount64 < retryUpcomingAt) return;
        if (Shuffle && !FollowingHost && !nextChosen && !manualQueue.Contains(queue[next]))
        {
            var chosen = Random.Shared.Next(next, queue.Count);
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
            var path = await PrepareFile(track, token);
            token.ThrowIfCancellationRequested();
            if (version != requestVersion || next >= queue.Count || !ReferenceEquals(queue[next], original) || standby is null) return;
            track = session.PlaybackRecording(session.CurrentRecording(track), path);
            if (manualQueue.Remove(original)) { track = track with { }; manualQueue.Add(track); }
            queue[next] = track;
            preparedTrack = null; incomingFailed = false;
            standby.Stop(); standby.TransportEnabled = false; standby.Volume = 0;
            standby.PlayFile(path, track.Title, track.Channel, false);
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
        if (RepeatMode == "one" || !AutoDj || FollowingHost || blending || preparing || !sourceReady || !Playing || !PlaybackRequested || !IncomingReady || Duration <= 0) return;
        if (Position < Duration - FadeDuration || Duration - Position <= .15) return;
        _ = BlendAsync();
    }
    private async Task BlendAsync(double elapsed = 0, double? duration = null)
    {
        if (!IncomingReady || deck is null || standby is null || blending) return;
        var next = PreparedIndex;
        // A queued recording still downloading can follow the already prepared next song.
        var incomingTrack = queue[next]; queue.RemoveAt(next); queue.Insert(index + 1, incomingTrack);
        upcomingPreparation?.Cancel(); upcomingPreparation?.Dispose();
        using var cancellation = new CancellationTokenSource();
        upcomingPreparation = cancellation; warming = false;
        blending = true; blendTarget = index + 1;
        var version = requestVersion; var outgoing = deck; var incoming = standby;
        try
        {
            await DeckCrossfade.RunAsync(outgoing, incoming, duration ?? FadeDuration,
                () => PlaybackRequested, gain => { blendGain = gain; ApplyVolumes(); }, cancellation.Token, () => incomingFailed, elapsed);
            if (version != requestVersion || !blending) return;
            deck = incoming; standby = outgoing;
            index = blendTarget; Current = incomingTrack; manualQueue.Remove(incomingTrack);
            preparedTrack = null; attemptedNext = null; upcomingPreparation = null;
            blending = false; blendTarget = -1; blendGain = 0;
            listenRecorded = false; listenedSeconds = incoming.Position; lastListeningPosition = incoming.Position;
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
                if (outgoing.Duration > 0 && outgoing.Position >= outgoing.Duration - .1) await NextCoreAsync();
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
        queue.RemoveRange(keep, queue.Count - keep);
        manualQueue.Clear();
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
        if (localUserAction && (!PlaybackRequested || !preparing && !sourceReady)) session.MarkLocalPlayback();
        if (!preparing && !sourceReady) { await PlayCoreAsync(Current, queue, index, true); return; }
        PlaybackRequested = !PlaybackRequested;
        ControlRevision++;
        if (!preparing) { deck.SetPlaying(PlaybackRequested); if (blending) standby?.SetPlaying(PlaybackRequested); }
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
        Seeking = true; session.InvalidateListeningBaseline();
        try { await deck.SeekAsync(seconds); }
        finally { Seeking = false; session.InvalidateListeningBaseline(); Changed?.Invoke(); }
    }
    public Task SeekAsync(double seconds) => RemoteActive ? RemoteSeekAsync(seconds) : MainThread.InvokeOnMainThreadAsync(async () =>
    {
        RequirePlaybackControl();
        if (!CanSeek || deck is null || !double.IsFinite(seconds)) return;
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
    public Task NextAsync() { if (RemoteActive) return SendRemoteAsync("next"); RequirePlaybackControl(); return MainThread.InvokeOnMainThreadAsync(NextCoreAsync); }
    private Task NextCoreAsync()
    {
        var next = blending ? blendTarget + 1 : index + 1;
        if (next >= queue.Count)
        {
            if (RepeatMode == "off" || FollowingHost || queue.Count == 0) return Task.CompletedTask;
            next = 0;
        }
        if (AutoDj && !blending && IncomingReady && Playing && Duration - Position > .15) return BlendAsync();
        var sequence = queue.ToList();
        if (Shuffle && !FollowingHost && !manualQueue.Contains(sequence[next]) && !nextChosen)
        {
            var chosen = Random.Shared.Next(next, sequence.Count);
            (sequence[next], sequence[chosen]) = (sequence[chosen], sequence[next]);
        }
        return PlayCoreAsync(sequence[next], sequence, next, Current is null || PlaybackRequested, true);
    }
    public Task PreviousAsync() => RemoteActive ? SendRemoteAsync("previous") : MainThread.InvokeOnMainThreadAsync(() =>
    {
        RequirePlaybackControl();
        if (!Preparing && Position > 3) return SeekAsync(0);
        return index <= 0 ? Task.CompletedTask : PlayCoreAsync(queue[index - 1], queue, index - 1, PlaybackRequested);
    });
    /// <summary>Shuffle off: the songs after the current one follow the list's own order again
    /// (queued songs stay first), like Spotify.</summary>
    private void RestoreOrder()
    {
        if (FollowingHost || Current is null || index < 0 || index >= queue.Count) return;
        var at = order.FindIndex(t => t.Id == queue[index].Id);
        if (at < 0) return;
        var manual = queue.Skip(index + 1).Where(manualQueue.Contains).ToList();
        queue.RemoveRange(index + 1, queue.Count - index - 1);
        queue.AddRange(manual); queue.AddRange(order.Skip(at + 1));
    }
    public int AddToQueue(MusicTrack track)
    {
        RequirePlaybackControl();
        var duplicate = manualQueue.FirstOrDefault(t => t.Id == track.Id);
        if (duplicate is not null) return queue.IndexOf(duplicate);
        if (queue.Count == 0 && Current is not null) { queue.Add(Current); index = 0; }
        var insertion = blending ? blendTarget + 1 : index + 1;
        for (var i = insertion; i < queue.Count; i++) if (manualQueue.Contains(queue[i])) insertion = i + 1;
        var entry = track with { }; queue.Insert(insertion, entry); manualQueue.Add(entry);
        if (!blending) { CancelUpcoming(true); if (Playing) WarmNext(); }
        Changed?.Invoke(); return insertion;
    }
    public string AudioOutputId { get; private set; } = "";
    public Task SetAudioOutputAsync(string id) => MainThread.InvokeOnMainThreadAsync(async () =>
    {
        if (deck is not null) await deck.SetOutputAsync(id);
        if (standby is not null) await standby.SetOutputAsync(id);
        AudioOutputId = id; Changed?.Invoke();
    });
    /// <summary>Another device handed its playback here: this device's queue is replaced and
    /// continues at the sender's song and position. Ignored while following a Listen Together host.</summary>
    private Task RemoteSeekAsync(double seconds)
    {
        resumePosition = Math.Max(0, seconds); remoteAt = DateTime.UtcNow; Changed?.Invoke();
        return SendRemoteAsync("seek", seconds);
    }
    public async Task<bool> TakeOverAsync(PlaybackResume state, IEnumerable<MusicTrack> available, bool play)
    {
        if (FollowingHost || !state.IsValid) return false;
        LeaveRemote();
        var recordings = available.ToList();
        if (!recordings.Any(t => t.Id == state.TrackIds[state.Index])) return false;
        await StopAsync();
        await MainThread.InvokeOnMainThreadAsync(() => RestoreResume(state, recordings));
        if (play && Current is not null) await ToggleCoreAsync(false);
        return Current is not null;
    }
    public Task ApplyPlaybackCommandAsync(PlaybackHandover command, IEnumerable<MusicTrack> available) => MainThread.InvokeOnMainThreadAsync(async () =>
    {
        if (FollowingHost) return;
        if (command.Action == "pause" && command.DeviceId.Length == 32 && command.DeviceId != session.DeviceId)
        {
            EnterRemote(command.DeviceId, command.FromName, command.Position ?? 0, command.Playing);
            ApplyRemoteState(command.Track?.Id ?? "", command.Playing, command.Position);
        }
        else if (command is { Action: "play", Resume.IsValid: true }) await TakeOverAsync(command.Resume, available, command.Playing);
    });
    public Task ApplyRemoteControlAsync(PlaybackControl control) => MainThread.InvokeOnMainThreadAsync(async () =>
    {
        if (FollowingHost || RemoteActive || Current is null) return;
        switch (control.Action)
        {
            case "play" when !PlaybackRequested: await ToggleCoreAsync(false); break;
            case "pause" when PlaybackRequested: await ToggleCoreAsync(false); break;
            case "next": await NextAsync(); break;
            case "previous": await PreviousAsync(); break;
            case "seek" when control.Position is { } seconds: await SeekAsync(seconds); break;
        }
    });
    public Task StopAsync() => MainThread.InvokeOnMainThreadAsync(() =>
    {
        ++requestVersion; preparation?.Cancel(); preparation = null;
        preparing = false; sourceReady = false; PlaybackRequested = false;
        CancelUpcoming(); deck?.Stop(); session.PinPlayback(null); session.PinPreparingPlayback(null);
        resumePosition = null; Current = null; queue.Clear(); manualQueue.Clear(); index = -1; Changed?.Invoke();
    });
}
