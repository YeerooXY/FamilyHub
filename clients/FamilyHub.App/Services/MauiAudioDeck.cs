#if !WINDOWS
using CommunityToolkit.Maui.Core;
using CommunityToolkit.Maui.Views;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

internal sealed class MauiAudioDeck : IAudioDeck
{
    private readonly MediaElement media;
    internal event Action<string, double, string?>? DiagnosticObserved;
#if ANDROID
    private const int NativeReady = 3, NativeEnded = 4;
    private readonly AudioDiagnostics diagnostics;
    private TaskCompletionSource? nativeSeek;
#endif
    private MediaSource? pendingSource;
    private readonly IDispatcherTimer positionTimer;
    public double FastPositionWindow { get; set; }
    public event Action? Changed;
    public event Action? Ended;
    public event Action<string>? Failed;
    public bool Opening => pendingSource is not null || media.CurrentState is MediaElementState.Opening or MediaElementState.Buffering;
    public bool PlaybackRequested { get; private set; }
    public bool Playing => media.CurrentState == MediaElementState.Playing;
    public double Position => media.Position.TotalSeconds;
#if ANDROID
    internal bool ReachedEnd => AudioRouting.Player(media)?.PlaybackState == NativeEnded;
    public double SeekPosition => AudioRouting.Player(media)?.CurrentPosition is >= 0 and var milliseconds
        ? milliseconds / 1000d : Position;
#endif
    public double Duration => media.Duration.TotalSeconds;
    public double Volume { get => media.Volume; set => media.Volume = value; }
    public bool TransportEnabled { set { } }

    public MauiAudioDeck(MediaElement media)
    {
        this.media = media;
#if ANDROID
        diagnostics = new AudioDiagnostics((stage, position, reason) =>
        {
            if (stage is "native_ready" or "native_ended" or "native_error") nativeSeek?.TrySetResult();
            DiagnosticObserved?.Invoke(stage, position, reason);
        });
        media.HandlerChanging += (_, _) =>
        {
            nativeSeek?.TrySetResult();
            diagnostics.Attach(null);
        };
#endif
        positionTimer = media.Dispatcher.CreateTimer();
        positionTimer.Interval = TimeSpan.FromSeconds(1);
        positionTimer.Tick += (_, _) => {
            var fast = FastPositionWindow > 0 && Playing && Duration > 0 && Duration - Position <= FastPositionWindow;
            positionTimer.Interval = TimeSpan.FromMilliseconds(fast ? FamilyHub.Client.Core.CrossfadeEnvelope.TickMilliseconds : 1000);
            RefreshPosition();
        };
        media.PositionChanged += (_, _) => Changed?.Invoke();
        media.StateChanged += (_, _) => Changed?.Invoke();
        media.MediaOpened += (_, _) =>
        {
            var openedSource = media.Source;
            media.Dispatcher.Dispatch(() =>
            {
                if (openedSource is null || !ReferenceEquals(openedSource, pendingSource)
                    || !ReferenceEquals(media.Source, openedSource)) return;
                pendingSource = null;
                if (!PlaybackRequested) { media.Pause(); positionTimer.Stop(); }
                Changed?.Invoke();
            });
        };
        media.MediaEnded += (_, _) =>
        {
            var endedSource = media.Source;
            // Toolkit still writes its stopped state after raising MediaEnded. Advance after that callback unwinds.
            media.Dispatcher.Dispatch(() =>
            {
                if (endedSource is null || !ReferenceEquals(media.Source, endedSource) || Opening || !PlaybackRequested) return;
#if ANDROID
                if (AudioRouting.Player(media) is { PlaybackState: not NativeEnded }) return;
#endif
                Ended?.Invoke();
            });
        };
        media.MediaFailed += (_, _) =>
        {
            var failedSource = media.Source;
            media.Dispatcher.Dispatch(() =>
            {
                if (failedSource is null || !ReferenceEquals(media.Source, failedSource)
                    || media.CurrentState != MediaElementState.Failed) return;
                pendingSource = null; PlaybackRequested = false;
                positionTimer.Stop();
                Failed?.Invoke("Playback failed. Retry the song or play a downloaded copy.");
                Changed?.Invoke();
            });
        };
    }
    public void PlayFile(string path, string title, string artist, bool play = true, bool background = false)
    {
        if (media.Handler is null) throw new InvalidOperationException("The audio player is not ready. Reopen the app and try again.");
#if ANDROID
        nativeSeek?.TrySetResult();
#endif
        PlaybackRequested = play;
        media.MetadataTitle = title; media.MetadataArtist = artist; media.ShouldAutoPlay = play;
        var streaming = path.StartsWith("https://", StringComparison.Ordinal);
        if (!streaming)
            pendingSource = MediaSource.FromFile(path);
        else if (background)
            pendingSource = MediaSource.FromUri(new Uri(path), new Dictionary<string, string> { [FamilyHubApi.ActivityHeader] = FamilyHubApi.BackgroundActivity });
        else
            pendingSource = MediaSource.FromUri(path);
#if ANDROID
        diagnostics.Attach(AudioRouting.Player(media));
#endif
        media.Source = pendingSource;
#if ANDROID
        AudioRouting.Apply(media);
#endif
        positionTimer.Start();
    }
    public void SetPlaying(bool play)
    {
        PlaybackRequested = play; media.ShouldAutoPlay = play;
        if (play) { media.Play(); positionTimer.Start(); } else { media.Pause(); positionTimer.Stop(); }
    }
    public Task SeekAsync(double seconds)
    {
        var position = TimeSpan.FromSeconds(Math.Clamp(seconds, 0, Duration));
#if ANDROID
        return SeekOnAndroidAsync(position);
#else
        return media.SeekTo(position);
#endif
    }

#if ANDROID
    private async Task SeekOnAndroidAsync(TimeSpan position)
    {
        var source = media.Source;
        var handler = media.Handler;
        if (source is null) return;
        if (AudioRouting.Player(media) is not { } player)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            await media.SeekTo(position, timeout.Token);
            return;
        }
        // A seek exactly to the end can go straight from buffering to ended. Toolkit completes only on ready.
        nativeSeek?.TrySetResult();
        var seek = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        nativeSeek = seek;
        try
        {
            player.SeekTo((long)position.TotalMilliseconds);
            if (player.PlaybackState is not (NativeReady or NativeEnded) && player.PlayerError is null)
                await seek.Task.WaitAsync(TimeSpan.FromSeconds(6));
            if (!ReferenceEquals(nativeSeek, seek) || !ReferenceEquals(media.Source, source) || !ReferenceEquals(media.Handler, handler)) return;
            if (player.PlayerError is not null) throw new InvalidOperationException("The player could not seek to this position.");
            RefreshPosition();
        }
        finally
        {
            if (ReferenceEquals(nativeSeek, seek)) nativeSeek = null;
        }
    }
#endif

    public void RefreshPosition() => media.Handler?.Invoke("StatusUpdated", null);
    public void Stop()
    {
#if ANDROID
        nativeSeek?.TrySetResult();
#endif
        positionTimer.Stop(); pendingSource = null; PlaybackRequested = false; media.Stop(); media.Source = null;
    }
}
#endif
