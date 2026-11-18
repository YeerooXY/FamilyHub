namespace FamilyHub.App.Services;

public interface IAudioDeck
{
    event Action? Changed;
    event Action? Ended;
    event Action<string>? Failed;
    bool Opening { get; }
    bool PlaybackRequested { get; }
    bool Playing { get; }
    double Position { get; }
    double Duration { get; }
    double Volume { get; set; }
    bool TransportEnabled { set; }
    bool SupportsPlaybackRate => false;
    double PlaybackRate { get => 1; set { } }
    void PlayFile(string path, string title, string artist, bool play = true, bool background = false);
    void SetPlaying(bool play);
    void RefreshPosition();
    Task SeekAsync(double seconds);
    Task SetOutputAsync(string id) => Task.CompletedTask;
    void Stop();
}
