namespace FamilyHub.App;

public partial class MainPage : ContentPage
{
    private static WeakReference<MainPage>? current;
    private readonly Services.MusicSession session;
    private readonly Services.MusicPlayer player;
    private IDispatcherTimer? refreshTimer;
    private readonly IDispatcherTimer activityTimer;
    private DateTime lastRefresh;
#if DEBUG
    [Microsoft.JSInterop.JSInvokable("PlaybackState")]
    public static object? PlaybackState() => current is not null && current.TryGetTarget(out var page) ? page.player.PlaybackState() : null;
#endif

    public void SetActive(bool active)
    {
        refreshTimer ??= CreateRefreshTimer();
        if (!active) { session.FlushListening(); if (player.Playing || Math.Abs(player.Position - lastPlaybackPosition) > .25) SavePlayback(); refreshTimer.Stop(); return; }
        refreshTimer.Start();
        if (DateTime.UtcNow - lastRefresh > TimeSpan.FromSeconds(15)) _ = RefreshLibrary();
    }
    private string? restoredProfile;
    private bool restoringPlayback, restoredOnline;
    private DateTime lastPlaybackSave;
    private double lastPlaybackPosition;
    private string lastPlaybackIdentity = "";
    private void SavePlayback()
    {
        if (restoringPlayback || restoredProfile != session.Server + "|" + session.User) return;
        var state = player.CaptureResume();
        if (state is null) return;
        _ = session.SavePlaybackAsync(state);
        lastPlaybackSave = DateTime.UtcNow; lastPlaybackPosition = state.Position;
    }
    private void PlaybackChanged()
    {
        session.ObserveListening(player.Preparing || player.Seeking ? null : player.Current, player.QueueIndex, player.Position, player.Playing);
        _ = session.ReportPlaybackActivityAsync(player.Playing);
        var identity = player.Current?.Id + ":" + player.QueueIndex + ":" + player.Queue.Count + ":" + player.PlaybackRequested;
        if (identity != lastPlaybackIdentity || !player.Playing && Math.Abs(player.Position - lastPlaybackPosition) > .25 || player.Playing && DateTime.UtcNow - lastPlaybackSave > TimeSpan.FromSeconds(5))
        { lastPlaybackIdentity = identity; SavePlayback(); }
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

	public MainPage(Services.MusicPlayer player, Services.MusicSession session)
	{
		InitializeComponent();
        this.session = session;
        this.player = player;
        current = new(this);
#if WINDOWS
        blazorWebView.BlazorWebViewInitialized += (_, args) =>
        { args.WebView.CoreWebView2.Settings.IsZoomControlEnabled = false; };
        audio.IsVisible = false;
        audioNext.IsVisible = false;
        Loaded += (_, _) => Services.WindowsWindowChrome.Update(this,
            blazorWebView.Handler?.PlatformView as Microsoft.UI.Xaml.FrameworkElement, 48, [], 1);
#endif
        activityTimer = Dispatcher.CreateTimer();
        activityTimer.Interval = TimeSpan.FromSeconds(5);
        activityTimer.Tick += (_, _) => { session.ObserveListening(player.Preparing || player.Seeking ? null : player.Current, player.QueueIndex, player.Position, player.Playing); _ = session.ReportPlaybackActivityAsync(player.Playing); };
        activityTimer.Start();
        player.Attach(audio, audioNext);
        player.Changed += PlaybackChanged; session.Changed += RestorePlayback;
        blazorWebView.UrlLoading += (_, args) => { if (args.Url.Host != "0.0.0.1") args.UrlLoadingStrategy = Microsoft.AspNetCore.Components.WebView.UrlLoadingStrategy.CancelLoad; };
	}
}

public sealed record WindowChromeRect(double X, double Y, double Width, double Height);
public sealed record WindowChromeMetrics(bool Supported, double LeftInset, double RightInset, double MinHeight)
{
    public static WindowChromeMetrics Unsupported { get; } = new(false, 0, 0, 0);
}
