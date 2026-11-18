namespace FamilyHub.App;

public partial class MainPage : ContentPage
{
    private static WeakReference<MainPage>? current;
    private readonly Services.MusicSession session;
    private readonly Services.MusicPlayer player;
#if WINDOWS
    private readonly Services.DiscordPresence discord;
    private long? lastFocusRequest;

    private async Task ReportWindowFocusAsync()
    {
        var now = Environment.TickCount64;
        if (!session.Connected || session.Api is not { } api || lastFocusRequest is { } last && now - last < 60_000) return;
        lastFocusRequest = now;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            await api.GetPreferencesAsync(timeout.Token);
        }
        catch (Exception error) when (error is HttpRequestException or FamilyHub.Client.Core.FamilyHubApiException
            or OperationCanceledException or ObjectDisposedException or System.Text.Json.JsonException) { }
    }

    private void UpdateDiscord()
    {
        if (Dispatcher.IsDispatchRequired) { Dispatcher.Dispatch(UpdateDiscord); return; }
        var track = player.Current;
        if (!Services.DiscordPresence.Enabled || track is null) { discord.Update(null); return; }
        track = session.CurrentRecording(track);
        discord.Update(new FamilyHub.Client.Core.DiscordSnapshot(track.Title, track.Channel, track.LibraryAlbum, track.Id,
            player.Playing, player.Position, player.Duration, player.RemoteActive));
    }
    public void CloseDiscord() => discord.Close();
#endif
    private IDispatcherTimer? refreshTimer;
    private readonly IDispatcherTimer activityTimer;
    private DateTime lastRefresh;
#if DEBUG
    [Microsoft.JSInterop.JSInvokable("PlaybackState")]
    public static object? PlaybackState() => current is not null && current.TryGetTarget(out var page) ? page.player.PlaybackState() : null;
#endif

    public void SetActive(bool active)
    {
        player.UiActive = active; session.UiActive = active;
#if ANDROID
        if (blazorWebView.Handler?.PlatformView is Android.Webkit.WebView web)
            web.EvaluateJavascript("window.familyhub?.setNativeActive(" + (active ? "true" : "false") + ")", null);
#endif
        if (active) remoteTimer.Start(); else remoteTimer.Stop();
        refreshTimer ??= CreateRefreshTimer();
        if (!active) { session.FlushListening(); if (player.Playing || Math.Abs(player.Position - lastPlaybackPosition) > .25) SavePlayback(); refreshTimer.Stop(); return; }
        refreshTimer.Start();
#if WINDOWS
        _ = ReportWindowFocusAsync();
#endif
        if (DateTime.UtcNow - lastRefresh > TimeSpan.FromSeconds(15)) _ = RefreshLibrary();
    }
    private string? restoredProfile;
    private bool restoringPlayback, restoredOnline;
    private DateTime lastPlaybackSave;
    private double lastPlaybackPosition;
    private string lastPlaybackIdentity = "";
    private long lastUserPlaybackRevision;
    private void SavePlayback(bool background = true)
    {
        if (restoringPlayback || restoredProfile != session.Server + "|" + session.User) return;
        var state = player.CaptureResume();
        if (state is null) return;
        _ = session.SavePlaybackAsync(state, background);
        lastPlaybackSave = DateTime.UtcNow; lastPlaybackPosition = state.Position;
    }
    private void PlaybackChanged()
    {
        session.ObserveListening(player.Preparing || player.Seeking ? null : player.Current, player.QueueIndex, player.Position, player.Playing);
        if (player.Seeking) return;
        var background = player.UserPlaybackRevision == lastUserPlaybackRevision;
        lastUserPlaybackRevision = player.UserPlaybackRevision;
        _ = session.ReportPlaybackActivityAsync(player.Playing, player.Position, player.FollowingHost, player.RemoteDeviceId, background);
        var identity = player.Current?.Id + ":" + player.QueueIndex + ":" + player.Queue.Count + ":" + player.PlaybackRequested + ":" + player.ControlRevision + ":" + player.Shuffle;
        if (identity != lastPlaybackIdentity || !player.Playing && Math.Abs(player.Position - lastPlaybackPosition) > .25 || player.Playing && DateTime.UtcNow - lastPlaybackSave > TimeSpan.FromSeconds(15))
        { lastPlaybackIdentity = identity; SavePlayback(background); }
    }
    // While this device's music plays elsewhere, mirror that device's song, position and state.
    private int remoteMisses;
    private readonly IDispatcherTimer remoteTimer;
    private bool followingRemote;
    private async Task FollowRemoteAsync()
    {
        if (!session.UiActive || !player.RemoteActive || followingRemote || session.Api is not { } api) { remoteMisses = 0; return; }
        followingRemote = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            var target = player.RemoteDeviceId;
            var device = (await api.GetPlaybackDevicesAsync(session.DeviceId, timeout.Token, background: true)).Devices.FirstOrDefault(d => d.Id == target);
            if (!ReferenceEquals(api, session.Api) || !player.RemoteActive || player.RemoteDeviceId != target) return;
            if (device is null) { if (++remoteMisses >= 3) player.LeaveRemote(); return; }
            remoteMisses = 0;
            var position = device.Position is { } seconds ? seconds + (device.Playing ? device.Age : 0) : (double?)null;
            player.ApplyRemoteState(device.Track?.Id ?? "", device.Playing, position);
        }
        catch (Exception error) when (error is HttpRequestException or FamilyHub.Client.Core.FamilyHubApiException or OperationCanceledException) { }
        finally { followingRemote = false; }
    }
    private async void RestorePlayback()
    {
        if (Dispatcher.IsDispatchRequired) { Dispatcher.Dispatch(RestorePlayback); return; }
        var profile = session.Server + "|" + session.User;
        if (string.IsNullOrEmpty(session.User)) { restoredProfile = null; restoredOnline = false; return; }
        if (restoringPlayback || session.Library.Count + session.Downloads.Count == 0 || restoredProfile == profile && (!session.Connected || restoredOnline)) return;
        restoringPlayback = true; restoredProfile = profile; restoredOnline = session.Connected;
        try
        {
            var state = await session.GetPlaybackAsync();
            if (state is not null && profile == session.Server + "|" + session.User)
            {
                if (!session.Library.Concat(session.Downloads).Any(t => t.Id == state.TrackIds[state.Index])) restoredProfile = null;
                else player.RestoreResume(state, session.Library.Concat(session.Downloads));
                lastPlaybackPosition = player.Position; lastPlaybackSave = DateTime.UtcNow;
            }
        }
        finally { restoringPlayback = false; if (profile != session.Server + "|" + session.User || !restoredOnline && session.Connected) RestorePlayback(); }
    }
    private IDispatcherTimer CreateRefreshTimer()
    {
        var timer = Dispatcher.CreateTimer();
        timer.Interval = TimeSpan.FromMinutes(3);
        timer.Tick += async (_, _) => await RefreshLibrary();
        return timer;
    }
    private async Task RefreshLibrary()
    {
        lastRefresh = DateTime.UtcNow;
        await session.RefreshLibraryAutomaticallyAsync();
        // Offline: look for the server every 30 seconds instead of every three minutes.
        if (refreshTimer is not null) refreshTimer.Interval = session.Connected ? TimeSpan.FromMinutes(3) : TimeSpan.FromSeconds(30);
    }

	[Microsoft.JSInterop.JSInvokable("UpdateWindowChrome")]
    public static Task<WindowChromeMetrics> UpdateWindowChrome(double headerHeight, WindowChromeRect[] interactiveRects, double devicePixelRatio)
    {
#if WINDOWS
        return MainThread.InvokeOnMainThreadAsync(() =>
            current is not null && current.TryGetTarget(out var page)
                ? Services.WindowsWindowChrome.Update(page, page.blazorWebView.Handler?.PlatformView as Microsoft.UI.Xaml.FrameworkElement,
                    headerHeight, interactiveRects, devicePixelRatio)
                : WindowChromeMetrics.Unsupported);
#else
        return Task.FromResult(WindowChromeMetrics.Unsupported);
#endif
    }

    // Song and playlist covers: answered from the app's cover cache. The address carries the
    // account scope and cover version, so the web view may keep each one for a long time.
    private void ServeArtwork(object? sender, WebViewWebResourceRequestedEventArgs args)
    {
        if (!args.Uri.AbsolutePath.StartsWith("/fh-art/", StringComparison.Ordinal)) return;
        args.Handled = true;
        var image = session.OpenArtworkAsync(args.Uri);
        var notFound = new Dictionary<string, string> { ["Cache-Control"] = "no-store" };
        if (image.IsCompleted && image.Result is null) { args.SetResponse(404, "Not Found", notFound, Stream.Null); return; }
        args.SetResponse(200, "OK", new Dictionary<string, string> { ["Content-Type"] = "image/jpeg", ["Cache-Control"] = "private, max-age=2592000, immutable" },
            Task.Run<Stream>(async () => await image is { } found ? new MemoryStream(found.Data, false) : throw new FileNotFoundException()));
    }

	public MainPage(Services.MusicPlayer player, Services.MusicSession session
#if WINDOWS
        , Services.DiscordPresence discord
#endif
        )
	{
		InitializeComponent();
        this.session = session;
        this.player = player;
#if WINDOWS
        this.discord = discord;
        player.Changed += UpdateDiscord;
        session.Changed += UpdateDiscord;
        Services.DiscordPresence.SettingChanged += UpdateDiscord;
        UpdateDiscord();
#endif
        current = new(this);
        blazorWebView.WebResourceRequested += ServeArtwork;
#if WINDOWS
        blazorWebView.BlazorWebViewInitialized += (_, args) =>
        { args.WebView.CoreWebView2.Settings.IsZoomControlEnabled = false; };
        audio.IsVisible = false;
        audioNext.IsVisible = false;
        Loaded += (_, _) => Services.WindowsWindowChrome.Update(this,
            blazorWebView.Handler?.PlatformView as Microsoft.UI.Xaml.FrameworkElement, 48, [], 1);
#endif
        activityTimer = Dispatcher.CreateTimer();
        // Five-second check-ins stay within the server's 15-second device expiry.
        activityTimer.Interval = TimeSpan.FromSeconds(5);
        activityTimer.Tick += (_, _) => { if (player.Playing && DateTime.UtcNow - lastPlaybackSave >= TimeSpan.FromSeconds(15)) SavePlayback(); session.ObserveListening(player.Preparing || player.Seeking ? null : player.Current, player.QueueIndex, player.Position, player.Playing); _ = session.ReportPlaybackActivityAsync(player.Playing, player.Position, player.FollowingHost, player.RemoteDeviceId); _ = FollowRemoteAsync(); };
        activityTimer.Start();
        remoteTimer = Dispatcher.CreateTimer();
        remoteTimer.Interval = TimeSpan.FromMilliseconds(500);
        remoteTimer.Tick += (_, _) => player.RemoteTick();
        remoteTimer.Start();
        player.Attach(audio, audioNext);
#if ANDROID
        PlaybackControls.Start(Microsoft.Maui.ApplicationModel.Platform.AppContext, player, session);
        AudioRouting.Start(audio, audioNext);
#endif
        player.Changed += PlaybackChanged; session.Changed += RestorePlayback;
        session.RemoteControlReceived += control =>
        {
            var activation = session.PlaybackActivation; var api = session.Api;
            Dispatcher.Dispatch(async () =>
            {
                if (activation != session.PlaybackActivation || !ReferenceEquals(api, session.Api)) return;
                try { await player.ApplyRemoteControlAsync(control); }
                catch (Exception error) when (error is InvalidOperationException or IOException) { }
            });
        };
        session.PlaybackHandedOver += handover =>
        {
            var activation = session.PlaybackActivation; var api = session.Api;
            Dispatcher.Dispatch(async () =>
            {
                if (activation != session.PlaybackActivation || !ReferenceEquals(api, session.Api)) return;
                try { await player.ApplyPlaybackCommandAsync(handover, session.Library.Concat(session.Downloads)); }
                catch (Exception error) when (error is InvalidOperationException or IOException) { }
            });
        };
        blazorWebView.UrlLoading += (_, args) => { if (args.Url.Host != "0.0.0.1") args.UrlLoadingStrategy = Microsoft.AspNetCore.Components.WebView.UrlLoadingStrategy.CancelLoad; };
	}
    protected override bool OnBackButtonPressed()
    {
#if ANDROID
        _ = StepBack();
        return true;
#else
        return base.OnBackButtonPressed();
#endif
    }
    private static async Task StepBack()
    {
        var handled = false;
        try { handled = Services.BackNavigation.Handler is { } handler && await handler(); }
        catch { /* A closed view leaves Back to the system. */ }
#if ANDROID
        if (!handled) Microsoft.Maui.ApplicationModel.Platform.CurrentActivity?.MoveTaskToBack(true);
#endif
    }
}

public sealed record WindowChromeRect(double X, double Y, double Width, double Height);
public sealed record WindowChromeMetrics(bool Supported, double LeftInset, double RightInset, double MinHeight)
{
    public static WindowChromeMetrics Unsupported { get; } = new(false, 0, 0, 0);
}
