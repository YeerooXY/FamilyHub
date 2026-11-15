using Microsoft.Maui.Dispatching;
using Windows.Foundation;
using Windows.Media;
using Windows.Media.Core;
using Windows.Media.Playback;

namespace FamilyHub.App.Services;

public sealed class WindowsAudioPlayer : IAudioDeck, IDisposable
{
    private MediaPlayer? player;
    private Windows.Devices.Enumeration.DeviceInformation? outputDevice;
    public async Task SetOutputAsync(string id)
    {
        var output = string.IsNullOrEmpty(id) ? null : await Windows.Devices.Enumeration.DeviceInformation.CreateFromIdAsync(id);
        if (!string.IsNullOrEmpty(id) && output is null) throw new InvalidOperationException("This audio output is no longer connected.");
        outputDevice = output; if (player is not null) player.AudioDevice = output;
    }
    private SystemMediaTransportControls? controls;
    private readonly IDispatcherTimer timer;
    private TypedEventHandler<MediaPlaybackSession, object>? stateHandler;
    private TypedEventHandler<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>? buttonHandler;
    private Stream? stream;
    private MediaSource? source;
    private bool disposed;
    private double volume = 1;
    private bool transportEnabled = true;
    public bool TransportEnabled
    {
        set { transportEnabled = value; if (controls is not null) controls.IsEnabled = value; }
    }

    public event Action? Changed;
    public event Action? Ended;
    public event Action<string>? Failed;
    private bool opening, seeking;
    private double? pausedPosition;
    public bool Opening => opening || seeking;
    public bool PlaybackRequested { get; private set; }
    public bool Playing => player?.PlaybackSession.PlaybackState == MediaPlaybackState.Playing;
    public double Volume
    {
        get => volume;
        set
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!double.IsFinite(value)) throw new ArgumentOutOfRangeException(nameof(value));
            volume = Math.Clamp(value, 0, 1);
            if (player is not null) player.Volume = volume;
        }
    }
    public double Position => !PlaybackRequested && pausedPosition is { } paused ? paused : player?.PlaybackSession.Position.TotalSeconds ?? 0;
    public bool SupportsPlaybackRate => true;
    public double PlaybackRate
    {
        get => player?.PlaybackSession.PlaybackRate ?? 1;
        set { if (player is not null) player.PlaybackSession.PlaybackRate = Math.Clamp(value, .985, 1.015); }
    }
    public double Duration => player is null || player.PlaybackSession.NaturalDuration == TimeSpan.MaxValue
        ? 0 : player.PlaybackSession.NaturalDuration.TotalSeconds;

    public WindowsAudioPlayer()
    {
        timer = (Dispatcher.GetForCurrentThread() ?? throw new InvalidOperationException("The app dispatcher is unavailable.")).CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(250);
        timer.Tick += OnTick;
    }

    public void PlayFile(string path, string title, string artist, bool play = true)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var nextStream = File.OpenRead(path);
        MediaSource? nextSource = null;
        try
        {
            nextSource = MediaSource.CreateFromStream(nextStream.AsRandomAccessStream(), MimeType(path));
            ReleaseSource();
            stream = nextStream; source = nextSource;
            // Each source gets its own native player. Events from a replaced source cannot
            // masquerade as events for the latest selection, even when already queued.
            var nextPlayer = player = new MediaPlayer { Volume = volume, AutoPlay = false, AudioDevice = outputDevice };
            nextPlayer.MediaOpened += OnOpened;
            nextPlayer.MediaEnded += OnEnded;
            nextPlayer.MediaFailed += OnFailed;
            controls = nextPlayer.SystemMediaTransportControls;
            controls.IsPlayEnabled = true; controls.IsPauseEnabled = true;
            controls.DisplayUpdater.Type = MediaPlaybackType.Music;
            controls.DisplayUpdater.MusicProperties.Title = title;
            controls.DisplayUpdater.MusicProperties.Artist = artist;
            controls.DisplayUpdater.Update(); controls.IsEnabled = transportEnabled;
            stateHandler = (_, _) => Notify(nextPlayer, () =>
            {
                controls!.PlaybackStatus = nextPlayer.PlaybackSession.PlaybackState switch
                {
                    MediaPlaybackState.Playing => MediaPlaybackStatus.Playing,
                    MediaPlaybackState.Paused => MediaPlaybackStatus.Paused,
                    _ => MediaPlaybackStatus.Stopped
                };
                Changed?.Invoke();
            });
            buttonHandler = (_, args) => Notify(nextPlayer, () =>
            {
                if (args.Button == SystemMediaTransportControlsButton.Play) SetPlaying(true);
                else if (args.Button == SystemMediaTransportControlsButton.Pause) SetPlaying(false);
            });
            nextPlayer.PlaybackSession.PlaybackStateChanged += stateHandler;
            controls.ButtonPressed += buttonHandler;
            opening = true; PlaybackRequested = play; pausedPosition = play ? null : 0;
            nextPlayer.Source = source;
            if (play) nextPlayer.Play();
            timer.Start(); Changed?.Invoke();
        }
        catch
        {
            if (ReferenceEquals(stream, nextStream)) ReleaseSource();
            else { nextSource?.Dispose(); nextStream.Dispose(); }
            throw;
        }
    }

    public void Toggle() => SetPlaying(!PlaybackRequested);
    public void RefreshPosition() { }
    public async Task SeekAsync(double seconds)
    {
        if (disposed || player is null || Opening || Duration <= 0 || !player.PlaybackSession.CanSeek) return;
        var current = player;
        var playback = current.PlaybackSession;
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        TypedEventHandler<MediaPlaybackSession, object> finished = (_, _) => completed.TrySetResult();
        playback.SeekCompleted += finished;
        var target = Math.Clamp(seconds, 0, Duration);
        seeking = true; Changed?.Invoke();
        try
        {
            playback.Position = TimeSpan.FromSeconds(target);
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(4));
        }
        catch (TimeoutException) { }
        finally
        {
            playback.SeekCompleted -= finished;
            if (ReferenceEquals(player, current))
            {
                seeking = false; pausedPosition = PlaybackRequested ? null : target;
                if (PlaybackRequested) current.Play(); else current.Pause();
                Changed?.Invoke();
            }
        }
    }
    public void SetPlaying(bool play)
    {
        if (disposed || player is null || source is null) return;
        var position = Position;
        PlaybackRequested = play; pausedPosition = play ? null : position;
        if (!seeking) { if (play) player.Play(); else player.Pause(); }
        Changed?.Invoke();
    }

    public void Seek(double seconds) => _ = SeekAsync(seconds);

    public void Stop()
    {
        if (disposed) return;
        timer.Stop(); ReleaseSource(); Changed?.Invoke();
    }

    private void ReleaseSource()
    {
        var previous = player;
        player = null; opening = false; seeking = false; pausedPosition = null; PlaybackRequested = false;
        if (previous is not null)
        {
            previous.MediaOpened -= OnOpened;
            previous.MediaEnded -= OnEnded;
            previous.MediaFailed -= OnFailed;
            if (stateHandler is not null) previous.PlaybackSession.PlaybackStateChanged -= stateHandler;
            if (controls is not null)
            {
                if (buttonHandler is not null) controls.ButtonPressed -= buttonHandler;
                controls.IsEnabled = false;
            }
            previous.Source = null;
            previous.Dispose();
        }
        stateHandler = null; buttonHandler = null; controls = null;
        source?.Dispose(); source = null;
        stream?.Dispose(); stream = null;
    }

    private void OnTick(object? sender, EventArgs args) => Changed?.Invoke();
    private void OnOpened(MediaPlayer sender, object args) => Notify(sender, () =>
    {
        opening = false;
        if (!PlaybackRequested) sender.Pause();
        Changed?.Invoke();
    });
    private void OnEnded(MediaPlayer sender, object args) => Notify(sender, () =>
    {
        if (!PlaybackRequested) return;
        Ended?.Invoke();
        if (ReferenceEquals(player, sender)) { PlaybackRequested = false; Changed?.Invoke(); }
    });
    private void OnFailed(MediaPlayer sender, MediaPlayerFailedEventArgs args) => Notify(sender, () =>
    {
        opening = false; PlaybackRequested = false; timer.Stop();
        Failed?.Invoke(string.IsNullOrWhiteSpace(args.ErrorMessage) ? "Windows could not play this recording." : args.ErrorMessage);
        Changed?.Invoke();
    });
    private void Notify(MediaPlayer owner, Action action) => MainThread.BeginInvokeOnMainThread(() =>
    {
        if (!disposed && ReferenceEquals(player, owner)) action();
    });

    private static string MimeType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".wav" => "audio/wav", ".mp3" => "audio/mpeg", ".m4a" or ".mp4" => "audio/mp4",
        ".flac" => "audio/flac", ".ogg" or ".opus" => "audio/ogg", ".aac" => "audio/aac",
        ".webm" => "audio/webm", _ => "application/octet-stream"
    };

    public void Dispose()
    {
        if (disposed) return;
        Stop(); disposed = true; timer.Tick -= OnTick;
    }
}
