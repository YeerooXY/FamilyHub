#if !WINDOWS
using CommunityToolkit.Maui.Core;
using CommunityToolkit.Maui.Views;

namespace FamilyHub.App.Services;

internal sealed class MauiAudioDeck : IAudioDeck
{
    private readonly MediaElement media;
    private MediaSource? pendingSource;
    private readonly IDispatcherTimer positionTimer;
    public event Action? Changed;
    public event Action? Ended;
    public event Action<string>? Failed;
    public bool Opening => pendingSource is not null || media.CurrentState is MediaElementState.Opening or MediaElementState.Buffering;
    public bool PlaybackRequested { get; private set; }
    public bool Playing => media.CurrentState == MediaElementState.Playing;
    public double Position => media.Position.TotalSeconds;
    public double Duration => media.Duration.TotalSeconds;
    public double Volume { get => media.Volume; set => media.Volume = value; }
    public bool TransportEnabled { set { } }

    public MauiAudioDeck(MediaElement media)
    {
        this.media = media;
        positionTimer = media.Dispatcher.CreateTimer();
        positionTimer.Interval = TimeSpan.FromMilliseconds(FamilyHub.Client.Core.CrossfadeEnvelope.TickMilliseconds);
        positionTimer.Tick += (_, _) => RefreshPosition();
        media.PositionChanged += (_, _) => Changed?.Invoke();
        media.StateChanged += (_, _) => Changed?.Invoke();
        media.MediaOpened += (_, _) => MainThread.BeginInvokeOnMainThread(() =>
        {
            if (pendingSource is null || !ReferenceEquals(media.Source, pendingSource)) return;
            pendingSource = null;
            if (!PlaybackRequested) { media.Pause(); positionTimer.Stop(); }
            Changed?.Invoke();
        });
        media.MediaEnded += (_, _) => MainThread.BeginInvokeOnMainThread(() =>
        {
            if (!Opening && PlaybackRequested && Duration > 0 && Position >= Duration - Math.Min(.5, Duration * .05))
            { Ended?.Invoke(); }
        });
        media.MediaFailed += (_, _) => MainThread.BeginInvokeOnMainThread(() =>
        {
            pendingSource = null; PlaybackRequested = false;
            positionTimer.Stop();
            Failed?.Invoke("Playback failed. Select the song to retry, or download it and play the local copy.");
            Changed?.Invoke();
        });
    }
    public void PlayFile(string path, string title, string artist, bool play = true)
    {
        if (media.Handler is null) throw new InvalidOperationException("The audio player is not ready. Reopen the app and try again.");
        PlaybackRequested = play;
        media.MetadataTitle = title; media.MetadataArtist = artist; media.ShouldAutoPlay = play;
        pendingSource = MediaSource.FromFile(path);
        media.Source = pendingSource;
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
