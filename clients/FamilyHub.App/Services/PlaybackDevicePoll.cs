using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

// UI-thread subscriptions. A closed picker, inactive window or local player needs no device requests.
public sealed class PlaybackDevicePoll(MusicSession session)
{
    private readonly HashSet<Action<List<PlaybackDevice>>> watchers = [];
    private CancellationTokenSource? running;

    public static PlaybackDevice? FindRemoteSource(List<PlaybackDevice> devices)
    {
        var hasOwner = devices.Any(d => d.Active == true);
        return devices.Where(d => !d.This && (!hasOwner || d.Active == true) && d.Track is not null
                && d.QueueRevision > 0 && d.Age < PlaybackDevice.OnlineSeconds)
            .OrderByDescending(d => d.IsPlaying || d.Status == "buffering").ThenBy(d => d.Age).FirstOrDefault();
    }

    public void Watch(Action<List<PlaybackDevice>> watcher)
    {
        if (watchers.Add(watcher)) Update();
    }

    public void Unwatch(Action<List<PlaybackDevice>> watcher)
    {
        if (watchers.Remove(watcher)) Update();
    }

    public void Update()
    {
        if (session.UiActive && watchers.Count > 0)
        {
            if (running is null) _ = PollAsync(running = new());
        }
        else
        {
            running?.Cancel(); running = null;
        }
    }

    private async Task PollAsync(CancellationTokenSource lifetime)
    {
        using (lifetime)
        {
            var token = lifetime.Token;
            try
            {
                while (!token.IsCancellationRequested)
                {
                    if (session.Connected && session.Api is { } api)
                    {
                        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                        timeout.CancelAfter(TimeSpan.FromSeconds(4));
                        try
                        {
                            var response = await api.GetPlaybackDevicesAsync(session.DeviceId, timeout.Token, background: true);
                            if (!token.IsCancellationRequested && ReferenceEquals(api, session.Api))
                                foreach (var watcher in watchers.ToArray()) watcher(response.Devices);
                        }
                        catch (Exception e) when (e is HttpRequestException or FamilyHubApiException or OperationCanceledException
                            or ObjectDisposedException or InvalidDataException or System.Text.Json.JsonException) { }
                    }
                    await Task.Delay(4000, token);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        }
    }
}
