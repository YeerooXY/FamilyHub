using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public sealed class ListenTogether(MusicSession session, MusicPlayer player)
{
    public event Action? Changed;
    public ListeningRoom? Room { get; private set; }
    public List<ListeningRoom> Rooms { get; private set; } = [];
    public string Message { get; private set; } = "";
    public bool Following => Room is { IsHost: false };
    public bool LocallyPaused { get; private set; }
    public async Task ToggleLocalPauseAsync()
    {
        if (!Following) return;
        LocallyPaused = !LocallyPaused;
        if (LocallyPaused) await player.PauseLocallyAsync();
        Changed?.Invoke();
    }
    private PendingSessionPoke? pendingPoke;
    private bool joining;
    private string ProfileIdentity => session.Server + "|" + session.User;
    public async Task PokeAsync(string user)
    {
        if (Room is not null) throw new InvalidOperationException("Leave your current session before poking another listener.");
        var connection = session.Api ?? throw new InvalidOperationException("Connect to send a poke.");
        var identity = ProfileIdentity;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        await connection.RequestJsonAsync<System.Text.Json.JsonElement>(HttpMethod.Post, "/api/listening/pokes", new { target = user }, timeout.Token);
        if (ReferenceEquals(connection, session.Api) && identity == ProfileIdentity) pendingPoke = new(user, identity, DateTimeOffset.UtcNow.AddMinutes(2));
    }
    public async Task InviteAsync(string user)
    {
        if (Room is null) await StartAsync();
        if (Room is not { IsHost: true } room) throw new InvalidOperationException("Only the host can invite listeners.");
        var connection = session.Api ?? throw new InvalidOperationException("Connect to send an invitation.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        await connection.RequestJsonAsync<System.Text.Json.JsonElement>(HttpMethod.Post, "/api/listening/invites", new { target = user, room_id = room.Id }, timeout.Token);
    }
    public async Task CheckPokedSessionAsync()
    {
        var pending = pendingPoke;
        if (pending is null || joining) return;
        if (!pending.IsCurrent(ProfileIdentity, Room is not null, DateTimeOffset.UtcNow)) { pendingPoke = null; return; }
        await RefreshAsync();
        if (pendingPoke != pending || !pending.IsCurrent(ProfileIdentity, Room is not null, DateTimeOffset.UtcNow)) return;
        if (pending.Find(Rooms) is { } target) { await JoinAsync(target.Id, true); if (Room is not null) pendingPoke = null; }
    }
    private CancellationTokenSource? lifetime;
    private FamilyHubApi? api;
    private Task? synchronization;
    private string sentQueue = "", preparingKey = "";
    private long generation;
    private readonly SemaphoreSlim hostChanged = new(0, 1);
    private long observedControl;
    private int observedIndex;
    private bool observedPlaying;
    private readonly Queue<double> hostRoundTrips = new();
    private double guestBestRoundTrip = double.MaxValue;
    private double HostTransit => hostRoundTrips.Count == 0 ? 0 : Math.Min(.5, hostRoundTrips.Min() / 2);

    public async Task RefreshAsync()
    {
        if (!session.Connected) await session.RefreshLibraryAutomaticallyAsync();
        if (!session.Connected || session.Api is null) { Rooms = []; return; }
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        Rooms = (await session.Api.RequestJsonAsync<ListeningRoomsResponse>(HttpMethod.Get, "/api/listening/rooms", cancellationToken: timeout.Token)).Rooms;
        Changed?.Invoke();
    }
    private object State(bool includeQueue)
    {
        var hasSong = player.Current is not null && player.QueueIndex >= 0;
        var playing = hasSong && player.PlaybackRequested && !player.Preparing;
        var data = new Dictionary<string, object>
        {
            ["index"] = hasSong ? player.QueueIndex : -1, ["position"] = hasSong ? player.Position + (playing ? HostTransit : 0) : 0,
            ["playing"] = playing, ["auto_dj"] = player.AutoDj, ["control_revision"] = player.ControlRevision,
            ["crossfading"] = hasSong && player.Crossfading, ["fade_position"] = player.FadePosition,
            ["fade_elapsed"] = player.FadeElapsed, ["fade_duration"] = player.FadeDuration
        };
        if (includeQueue) data["queue"] = player.Queue.Select(t => new { id = t.Id, title = t.Title, channel = t.Channel }).ToArray();
        return data;
    }
    public async Task StartAsync()
    {
        pendingPoke = null;
        if (Room is not null || joining) return;
        joining = true;
        try
        {
            var connection = session.Api ?? throw new InvalidOperationException("Connect to start Listen Together.");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var identity = ProfileIdentity;
            var state = State(true);
            sentQueue = string.Join('|', player.Queue.Select(t => t.Id));
            var created = await connection.RequestJsonAsync<ListeningRoomResponse>(HttpMethod.Post, "/api/listening/rooms", state, timeout.Token);
            if (!ReferenceEquals(connection, session.Api) || identity != ProfileIdentity) return;
            api = connection; Room = created.Room;
            if (Room.Resumed && Room.Queue is { Count: 0 }) await player.StopAsync();
            if (Room.Resumed && Room.Queue is { Count: > 0 } restored)
            {
                player.FollowingHost = true;
                try { await player.SynchronizeHostAsync(restored, Room.Index, Room.Position, Room.Playing, Room.AutoDj, Room.Crossfading, Room.FadePosition, Room.FadeElapsed, Room.FadeDuration, Room.ControlRevision); }
                finally { player.FollowingHost = false; }
            }
            sentQueue = string.Join('|', player.Queue.Select(t => t.Id));
            Begin();
        }
        catch { Room = null; throw; }
        finally { joining = false; }
    }
    public async Task JoinAsync(string id, bool fromPoke = false)
    {
        if (!fromPoke) pendingPoke = null;
        if (Room is not null || joining) return;
        joining = true;
        try
        {
            var connection = session.Api ?? throw new InvalidOperationException("Connect to join Listen Together.");
            var identity = ProfileIdentity;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var result = await connection.RequestJsonAsync<ListeningRoomResponse>(HttpMethod.Post, "/api/listening/rooms/" + Uri.EscapeDataString(id) + "/join", new { }, timeout.Token);
            if (!ReferenceEquals(connection, session.Api) || identity != ProfileIdentity) return;
            api = connection; Room = result.Room;
            await player.StopAsync();
            if (player.Shuffle) player.ToggleShuffle();
            player.FollowingHost = true; Begin();
        }
        finally { joining = false; }
    }
    private void Begin()
    {
        Message = ""; preparingKey = ""; generation++;
        hostRoundTrips.Clear(); guestBestRoundTrip = double.MaxValue;
        observedControl = player.ControlRevision; observedPlaying = player.PlaybackRequested; observedIndex = player.QueueIndex;
        player.Changed += PlaybackChanged;
        lifetime = new CancellationTokenSource();
        _ = PollAsync(generation, lifetime.Token);
        Changed?.Invoke();
    }
    private void PlaybackChanged()
    {
        if (Room is not { IsHost: true } || (observedControl == player.ControlRevision && observedPlaying == player.PlaybackRequested && observedIndex == player.QueueIndex)) return;
        observedControl = player.ControlRevision; observedPlaying = player.PlaybackRequested; observedIndex = player.QueueIndex;
        if (hostChanged.CurrentCount == 0) hostChanged.Release();
    }
    public async Task LeaveAsync()
    {
        var previous = Room; var previousApi = api;
        await ClearAsync("");
        if (previous is null || previousApi is null) return;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await previousApi.RequestJsonAsync<System.Text.Json.JsonElement>(HttpMethod.Delete,
                "/api/listening/rooms/" + previous.Id, cancellationToken: timeout.Token);
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or FamilyHubApiException or ObjectDisposedException)
        { /* The server expires absent hosts and listeners automatically. */ }
    }
    private async Task ClearAsync(string message)
    {
        generation++; lifetime?.Cancel(); lifetime?.Dispose(); lifetime = null;
        player.Changed -= PlaybackChanged;
        var following = Following;
        Room = null; player.FollowingHost = false; LocallyPaused = false;
        if (following) await player.StopAsync();
        player.AutoDj = session.PlaybackPreferences.AutoDj; player.CrossfadeSeconds = session.PlaybackPreferences.CrossfadeSeconds;
        if (player.Shuffle != session.PlaybackPreferences.Shuffle) player.ToggleShuffle();
        Message = message; Changed?.Invoke();
    }
    private async Task PollAsync(long run, CancellationToken token)
    {
        var lastSuccess = Environment.TickCount64;
        while (!token.IsCancellationRequested && run == generation && Room is { } room)
        {
            try
            {
                if (!ReferenceEquals(api, session.Api)) { await ClearAsync("The server connection changed. Join the session again."); return; }
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                timeout.CancelAfter(TimeSpan.FromSeconds(8));
                var started = Environment.TickCount64;
                ListeningRoom result;
                if (room.IsHost)
                {
                    var key = string.Join('|', player.Queue.Select(t => t.Id));
                    result = (await api!.RequestJsonAsync<ListeningRoomResponse>(HttpMethod.Put, "/api/listening/rooms/" + room.Id,
                        await MainThread.InvokeOnMainThreadAsync(() => State(key != sentQueue)), timeout.Token)).Room;
                    sentQueue = key;
                    hostRoundTrips.Enqueue((Environment.TickCount64 - started) / 1000d);
                    if (hostRoundTrips.Count > 8) hostRoundTrips.Dequeue();
                }
                else
                    result = (await api!.RequestJsonAsync<ListeningRoomResponse>(HttpMethod.Get,
                        "/api/listening/rooms/" + room.Id + "?queue_revision=" + room.QueueRevision, cancellationToken: timeout.Token)).Room;
                if (run != generation) return;
                var roundTrip = (Environment.TickCount64 - started) / 1000d;
                guestBestRoundTrip = Math.Min(guestBestRoundTrip, roundTrip);
                var delayedSample = roundTrip > Math.Max(.75, guestBestRoundTrip * 4)
                    && result.Playing && player.Playing && result.ControlRevision == room.ControlRevision;
                Room = result with { Queue = room.IsHost ? player.Queue.ToList() : result.Queue ?? room.Queue };
                lastSuccess = Environment.TickCount64;
                Message = "";
                if (!room.IsHost && Room.Queue is { Count: 0 })
                {
                    preparingKey = "";
                    if (player.Current is not null || player.Preparing) await player.StopAsync();
                }
                else if (!room.IsHost && !LocallyPaused && !delayedSample && Room.Queue is { Count: > 0 } tracks)
                {
                    var key = Room.Index + ":" + tracks[Room.Index].Id;
                    if (synchronization is { IsCompleted: false } && key != preparingKey)
                        await player.StopAsync();
                    if (synchronization is null || synchronization.IsCompleted || key != preparingKey)
                    {
                        preparingKey = key;
                        var latency = Room.Playing ? Math.Min(roundTrip, guestBestRoundTrip + .15) / 2 : 0;
                        var position = Room.Position + latency;
                        synchronization = SynchronizeAsync(tracks, Room with { FadePosition = Room.FadePosition + latency, FadeElapsed = Room.FadeElapsed + latency }, position, run);
                    }
                }
                Changed?.Invoke();
            }
            catch (FamilyHubApiException error) when (error.StatusCode is 401 or 403 or 404)
            { if (run == generation) await ClearAsync("This listening session has ended."); return; }
            catch (Exception error) when (error is HttpRequestException or IOException or FamilyHubApiException or OperationCanceledException or ObjectDisposedException)
            {
                if (token.IsCancellationRequested || run != generation) return;
                Message = "Reconnecting to the listening session...";
                if (Following && Environment.TickCount64 - lastSuccess > 5000) await player.StopAsync();
                if (Environment.TickCount64 - lastSuccess > 30000)
                { await ClearAsync("Connection lost. Join Listen Together again when connected."); return; }
                Changed?.Invoke();
            }
            try
            {
                if (Room is { IsHost: true }) await hostChanged.WaitAsync(1000, token);
                else await Task.Delay(500, token);
            }
            catch (OperationCanceledException) { return; }
        }
    }
    private async Task SynchronizeAsync(List<MusicTrack> tracks, ListeningRoom room, double position, long run)
    {
        try { if (!LocallyPaused) await player.SynchronizeHostAsync(tracks, room.Index, position, room.Playing, room.AutoDj, room.Crossfading, room.FadePosition, room.FadeElapsed, room.FadeDuration, room.ControlRevision); if (LocallyPaused) await player.PauseLocallyAsync(); }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException or FamilyHubApiException or OperationCanceledException)
        { if (run == generation) { Message = error.Message; Changed?.Invoke(); } }
    }
}
