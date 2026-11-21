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
    private readonly AudioDiagnostics diagnostics;
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
        diagnostics = new AudioDiagnostics((stage, position, reason) => DiagnosticObserved?.Invoke(stage, position, reason));
        media.HandlerChanging += (_, _) => diagnostics.Attach(null);
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
        media.MediaOpened += (_, _) => MainThread.BeginInvokeOnMainThread(() =>
        {
            if (pendingSource is null || !ReferenceEquals(media.Source, pendingSource)) return;
            pendingSource = null;
            if (!PlaybackRequested) { media.Pause(); positionTimer.Stop(); }
            Changed?.Invoke();
        });
        media.MediaEnded += (_, _) =>
        {
            var endedSource = media.Source;
            MainThread.BeginInvokeOnMainThread(() =>
            {
                if (endedSource is not null && ReferenceEquals(media.Source, endedSource) && !Opening && PlaybackRequested)
                    Ended?.Invoke();
            });
        };
        media.MediaFailed += (_, _) =>
        {
            var failedSource = media.Source;
            MainThread.BeginInvokeOnMainThread(() =>
            {
                if (failedSource is null || !ReferenceEquals(media.Source, failedSource)) return;
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
        AudioRouting.Apply(media, streaming);
#endif
        positionTimer.Start();
    }
    public void SetPlaying(bool play)
    {
        PlaybackRequested = play; media.ShouldAutoPlay = play;
        if (play) { media.Play(); positionTimer.Start(); } else { media.Pause(); positionTimer.Stop(); }
    }
    public Task SeekAsync(double seconds) => media.SeekTo(TimeSpan.FromSeconds(Math.Clamp(seconds, 0, Duration)));
    public void RefreshPosition() => media.Handler?.Invoke("StatusUpdated", null);
    public void Stop() { positionTimer.Stop(); pendingSource = null; PlaybackRequested = false; media.Stop(); media.Source = null; }
}
#endif
