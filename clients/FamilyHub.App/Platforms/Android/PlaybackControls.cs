using Android.App;
using Android.Content;
using Android.Graphics;
using Android.Graphics.Drawables;
using Android.Media;
using Android.Media.Session;
using Android.OS;
using FamilyHub.App.Services;
using FamilyHub.Client.Core;

namespace FamilyHub.App;

/// <summary>
/// FamilyHub's own media session: lock screen, notification shade, headset and car
/// controls with Previous, Play/Pause, Next, seeking and the song's artwork. The player
/// hands MediaElement one song at a time, so the toolkit's session could not offer Next.
/// </summary>
internal sealed class PlaybackControls
{
    internal const string Channel = "playback";
    internal const int NotificationId = 4101;
    internal const string ActionMix = "org.familyhub.music.mix", ActionPrevious = "org.familyhub.music.previous", ActionToggle = "org.familyhub.music.toggle", ActionNext = "org.familyhub.music.next";
    internal const string ActionPlay = "org.familyhub.music.play", ActionPause = "org.familyhub.music.pause";
    private const PlaybackStateCode Unknown = PlaybackStateCode.None;

    internal static PlaybackControls? Current { get; private set; }

    private readonly Context context;
    private readonly MusicPlayer player;
    private readonly MusicSession session;
    private readonly MediaSession media;
    private (string Account, string Id)? artworkFor;
    private CancellationTokenSource? artworkLoad;
    private Bitmap? artwork;
    private PlaybackStateCode lastState = Unknown;
    private PublishedMetadata? lastMetadata;
    private long lastActions, lastControlRevision = -1, lastSeekRevision = -1;
    private long publicationVersion, trackVersion;
    private bool lastShuffle;

    private sealed record PublishedMetadata(string Account, string Id, string Title, string Artist, string? Album, long Duration, Bitmap? Artwork);

    private PlaybackControls(Context context, MusicPlayer player, MusicSession session)
    {
        this.context = context; this.player = player; this.session = session;
        media = new MediaSession(context, "FamilyHub");
        media.SetCallback(new Callbacks(this));
        var open = context.PackageManager?.GetLaunchIntentForPackage(context.PackageName!);
        if (open is not null) media.SetSessionActivity(PendingIntent.GetActivity(context, 0, open, PendingIntentFlags.Immutable));
        using var channel = new NotificationChannel(Channel, "Playback", NotificationImportance.Low) { Description = "Playing song and controls" };
        channel.SetShowBadge(false);
        (context.GetSystemService(Context.NotificationService) as NotificationManager)?.CreateNotificationChannel(channel);
        player.Changed += Update;
        Update();
    }

    internal static void Start(Context context, MusicPlayer player, MusicSession session) => Current ??= new PlaybackControls(context, player, session);

    private void Update()
    {
        if (!MainThread.IsMainThread) { MainThread.BeginInvokeOnMainThread(Update); return; }
        var playback = player.NotificationPlayback;
        var track = playback.Track;
        if (track is null)
        {
            if (lastMetadata is null) return;
            media.Active = false;
            media.SetMetadata(null);
            PlaybackService.Clear(context);
            publicationVersion++; trackVersion++;
            lastState = Unknown; lastMetadata = null;
            artworkLoad?.Cancel();
            artworkFor = null;
            artwork?.Dispose();
            artwork = null;
            return;
        }
        var state = playback.Playing ? PlaybackStateCode.Playing
            : playback.Preparing ? PlaybackStateCode.Buffering : PlaybackStateCode.Paused;
        var actions = PlaybackState.ActionPlay | PlaybackState.ActionPause | PlaybackState.ActionPlayPause | PlaybackState.ActionStop;
        // A Listen Together guest follows the host and cannot skip or seek.
        if (!player.FollowingHost) actions |= PlaybackState.ActionSkipToNext | PlaybackState.ActionSkipToPrevious | (playback.CanSeek ? PlaybackState.ActionSeekTo : 0);
        var mixIcon = player.Shuffle ? Resource.Drawable.shuffle_on : Resource.Drawable.shuffle_off;
        var duration = (long)(Math.Max(playback.Duration, track.Duration) * 1000);
        var identity = (Account: session.ArtworkScope, track.Id);
        var current = new PublishedMetadata(identity.Account, track.Id, track.Title, track.Channel, track.LibraryAlbum, duration,
            artworkFor == identity ? artwork : null);
        var trackChanged = current.Id != lastMetadata?.Id || current.Account != lastMetadata?.Account;
        var metadataChanged = current != lastMetadata;
        var artworkChanged = current.Artwork is not null && current.Artwork != lastMetadata?.Artwork;

        if (metadataChanged)
        {
            PublishMetadata(current);
            lastMetadata = current;
        }
        if ((!player.Seeking || trackChanged) && (state != lastState || actions != lastActions || trackChanged
            || player.ControlRevision != lastControlRevision || player.SeekRevision != lastSeekRevision || player.Shuffle != lastShuffle))
        {
            using var playbackState = new PlaybackState.Builder();
            playbackState.SetActions(actions);
            playbackState.AddCustomAction(ActionMix, player.Shuffle ? "Mix on" : "Mix off", mixIcon);
            playbackState.SetState(state, (long)(playback.Position * 1000), playback.Playing ? 1f : 0f, SystemClock.ElapsedRealtime());
            media.SetPlaybackState(playbackState.Build());
            lastActions = actions; lastControlRevision = player.ControlRevision; lastSeekRevision = player.SeekRevision;
        }
        media.Active = true;
        if (state != lastState || metadataChanged || player.Shuffle != lastShuffle)
        {
            var reason = !trackChanged && artworkChanged ? "Artwork updated" :
                state switch { PlaybackStateCode.Playing => "Playing", PlaybackStateCode.Buffering => "Preparing", _ => "Paused" };
            lastState = state;
            lastShuffle = player.Shuffle;
            PublishNotification(current, track, state, playback.Position, reason, ++publicationVersion, retry: true);
        }
        if (trackChanged)
        {
            _ = VerifyNotificationAsync(track, identity.Account, ++trackVersion);
            artworkLoad?.Cancel();
            if (artworkFor != identity)
            {
                var pending = new CancellationTokenSource();
                artworkLoad = pending;
                _ = LoadArtwork(track, identity, pending);
            }
        }
    }

    private async Task LoadArtwork(MusicTrack track, (string Account, string Id) identity, CancellationTokenSource pending)
    {
        try
        {
            var uri = await session.GetArtworkAsync(track, pending.Token);
            var comma = uri?.IndexOf(',') ?? -1;
            if (comma < 0 || pending.IsCancellationRequested) return;
            var bytes = Convert.FromBase64String(uri![(comma + 1)..]);
            var bitmap = await Task.Run(() => DecodeArtwork(bytes), pending.Token);
            if (bitmap is null) return;
            await MainThread.InvokeOnMainThreadAsync(() =>
            {
                if (pending.IsCancellationRequested || player.NotificationPlayback.Track?.Id != identity.Id || session.ArtworkScope != identity.Account)
                { bitmap.Dispose(); return; }
                var previous = artwork;
                artwork = bitmap; artworkFor = identity;
                Update();
                previous?.Dispose();
            });
        }
        catch (Exception error) when (error is System.OperationCanceledException or FormatException or IOException or HttpRequestException
            or FamilyHubApiException or UnauthorizedAccessException or Java.Lang.RuntimeException) { }
        finally
        {
            if (ReferenceEquals(artworkLoad, pending)) artworkLoad = null;
            pending.Dispose();
        }
    }

    private static Bitmap? DecodeArtwork(byte[] bytes)
    {
        using var options = new BitmapFactory.Options { InJustDecodeBounds = true };
        BitmapFactory.DecodeByteArray(bytes, 0, bytes.Length, options)?.Dispose();
        var size = Math.Max(options.OutWidth, options.OutHeight);
        if (size <= 0) return null;
        // The lock screen needs a small bitmap. Bound the pixels sent with session metadata and notifications.
        options.InSampleSize = 1;
        while (size / options.InSampleSize > 384) options.InSampleSize *= 2;
        options.InJustDecodeBounds = false;
        return BitmapFactory.DecodeByteArray(bytes, 0, bytes.Length, options);
    }

    private Notification.Action Action(int icon, string title, string action) =>
        new Notification.Action.Builder(Icon.CreateWithResource(context, icon), title,
            PendingIntent.GetService(context, action.GetHashCode(), new Intent(context, typeof(PlaybackService)).SetAction(action), PendingIntentFlags.Immutable)).Build();

    private void PublishNotification(PublishedMetadata metadata, MusicTrack track, PlaybackStateCode state,
        double position, string reason, long version, bool retry)
    {
        if (version != publicationVersion || player.NotificationPlayback.Track?.Id != track.Id || session.ArtworkScope != metadata.Account)
            return;
        void Report(bool published)
        {
            if (version != publicationVersion || player.NotificationPlayback.Track?.Id != track.Id || session.ArtworkScope != metadata.Account)
                return;
            player.TraceNotification(published ? "notification_published" : "notification_failed", track, position,
                published ? reason : "Android could not post the notification" + (PlaybackService.LastError is { } why ? $" ({why})" : ""));
            if (!published && retry) _ = RetryNotificationAsync(metadata, track, state, position, reason, version);
            if (!published) WarnIfNotificationsBlocked();
        }
        try { ShowNotification(metadata, state, Report); }
        catch (Java.Lang.RuntimeException error) { PlaybackService.Remember(error); Report(false); }
    }

    private static bool warnedAboutNotifications;

    // The phone only keeps music alive with the screen off when it can show the media notification.
    private void WarnIfNotificationsBlocked()
    {
        if (warnedAboutNotifications) return;
        var manager = (NotificationManager?)context.GetSystemService(Context.NotificationService);
        if (manager is null || manager.AreNotificationsEnabled()) return;
        warnedAboutNotifications = true;
        session.SetMessage("Allow notifications for FamilyHub in the phone's app settings. Without them the music can stop when the screen turns off.", "error", playback: true);
    }

    private async Task RetryNotificationAsync(PublishedMetadata metadata, MusicTrack track, PlaybackStateCode state,
        double position, string reason, long version)
    {
        await Task.Delay(750);
        await MainThread.InvokeOnMainThreadAsync(() => PublishNotification(metadata, track, state, position, reason, version, retry: false));
    }

    private void PublishMetadata(PublishedMetadata current)
    {
        using var metadata = new MediaMetadata.Builder();
        metadata.PutString(MediaMetadata.MetadataKeyMediaId, current.Id);
        metadata.PutString(MediaMetadata.MetadataKeyTitle, current.Title);
        metadata.PutString(MediaMetadata.MetadataKeyDisplayTitle, current.Title);
        metadata.PutString(MediaMetadata.MetadataKeyArtist, current.Artist);
        metadata.PutString(MediaMetadata.MetadataKeyDisplaySubtitle, current.Artist);
        metadata.PutString(MediaMetadata.MetadataKeyAlbum, current.Album);
        metadata.PutLong(MediaMetadata.MetadataKeyDuration, current.Duration);
        if (current.Artwork is { } image) metadata.PutBitmap(MediaMetadata.MetadataKeyAlbumArt, image);
        media.SetMetadata(metadata.Build());
    }

    private async Task VerifyNotificationAsync(MusicTrack track, string account, long version, bool repair = true)
    {
        await Task.Delay(1250);
        await MainThread.InvokeOnMainThreadAsync(() =>
        {
            var playback = player.NotificationPlayback;
            if (version != trackVersion || playback.Track?.Id != track.Id || session.ArtworkScope != account) return;
            string? failure;
            try
            {
                using var metadata = media.Controller.Metadata;
                if (metadata?.GetString(MediaMetadata.MetadataKeyMediaId) != track.Id ||
                    metadata?.GetString(MediaMetadata.MetadataKeyTitle) != playback.Track.Title)
                    failure = "Android media session title or song did not match";
                else
                {
                    var manager = (NotificationManager?)context.GetSystemService(Context.NotificationService);
                    var active = manager?.GetActiveNotifications()?.FirstOrDefault(item => item.Id == NotificationId);
                    var title = active?.Notification?.Extras?.GetCharSequence(Notification.ExtraTitle)?.ToString();
                    failure = active is null ? "Android had no active media notification"
                        : title != playback.Track.Title ? "Android notification title did not match" : null;
                }
            }
            catch (Java.Lang.RuntimeException)
            {
                player.TraceNotification("notification_unavailable", track, playback.Position);
                return;
            }
            player.TraceNotification(failure is null ? "notification_verified" : "notification_mismatch", track, playback.Position,
                failure);
            if (failure is not null && repair && playback.Playing && lastMetadata is { } current)
            {
                try
                {
                    PublishMetadata(current);
                    PublishNotification(current, track, lastState, playback.Position, "Retried title update", ++publicationVersion, retry: false);
                    _ = VerifyNotificationAsync(track, account, version, repair: false);
                }
                catch (Java.Lang.RuntimeException) { player.TraceNotification("notification_failed", track, playback.Position); }
            }
        });
    }

    private void ShowNotification(PublishedMetadata track, PlaybackStateCode state, Action<bool> published)
    {
        var playing = state is PlaybackStateCode.Playing or PlaybackStateCode.Buffering;
        using var builder = new Notification.Builder(context, Channel);
        builder.SetSmallIcon(Resource.Drawable.ic_stat_music)
            .SetContentTitle(track.Title)
            .SetContentText(track.Artist)
            .SetVisibility(NotificationVisibility.Public)
            .SetShowWhen(false)
            .SetOngoing(playing)
            .SetContentIntent(media.Controller.SessionActivity)
            .AddAction(Action(Android.Resource.Drawable.IcMediaPrevious, "Previous", ActionPrevious))
            .AddAction(Action(playing ? Android.Resource.Drawable.IcMediaPause : Android.Resource.Drawable.IcMediaPlay, playing ? "Pause" : "Play", playing ? ActionPause : ActionPlay))
            .AddAction(Action(Android.Resource.Drawable.IcMediaNext, "Next", ActionNext))
            .AddAction(Action(player.Shuffle ? Resource.Drawable.shuffle_on : Resource.Drawable.shuffle_off, "Mix", ActionMix));
        using var style = new Notification.MediaStyle();
        style.SetMediaSession(media.SessionToken);
        style.SetShowActionsInCompactView(0, 1, 2);
        builder.SetStyle(style);
        if (track.Artwork is { } image) builder.SetLargeIcon(image);
        if (OperatingSystem.IsAndroidVersionAtLeast(31))
            builder.SetForegroundServiceBehavior((int)NotificationForegroundService.Immediate);
        PlaybackService.Show(context, builder.Build(), playing, published);
    }

    internal void Handle(string? action)
    {
        if (action == ActionMix) { if (!player.FollowingHost && !player.RemoteActive) { player.ToggleShuffle(); _ = session.SavePreferencesAsync(player.Volume, player.Shuffle); } return; }
        _ = action switch
        {
            ActionPrevious => Run(player.PreviousAsync),
            ActionNext => Run(player.NextAsync),
            ActionToggle => Run(player.ToggleAsync),
            ActionPlay => Run(() => player.SetTransportPlayingAsync(true)),
            ActionPause => Run(() => player.SetTransportPlayingAsync(false)),
            _ => Task.CompletedTask,
        };
    }

    private static async Task Run(Func<Task> action)
    {
        try { await action(); }
        catch (Exception) { /* Following a host or nothing queued: the control does nothing. */ }
    }

    private sealed class Callbacks(PlaybackControls owner) : MediaSession.Callback
    {
        public override void OnCustomAction(string? action, Bundle? extras) => owner.Handle(action);
        public override void OnPlay() => owner.Handle(ActionPlay);
        public override void OnPause() => owner.Handle(ActionPause);
        public override void OnSkipToNext() => owner.Handle(ActionNext);
        public override void OnSkipToPrevious() => owner.Handle(ActionPrevious);
        public override void OnStop() => owner.Handle(ActionPause);
        public override void OnSeekTo(long pos) => _ = Run(() => owner.player.SeekAsync(pos / 1000.0));
    }
}

/// <summary>Keeps playback alive in the background and shows the media notification.</summary>
[Service(Exported = false, ForegroundServiceType = Android.Content.PM.ForegroundService.TypeMediaPlayback)]
internal sealed class PlaybackService : Service
{
    private sealed record Publication(Notification Notification, bool Playing, Action<bool> Report);
    private static Publication? latest;
    private static bool starting;
    private static PlaybackService? running;
    private Publication? published;
    private bool foreground;
    internal static bool IsStarted => starting || running is not null;
    /// <summary>Why Android refused the last notification or foreground start, for the playback attempt list.</summary>
    internal static string? LastError { get; private set; }
    internal static void Remember(Java.Lang.RuntimeException error) => Describe(error);
    private static string Describe(Java.Lang.RuntimeException error)
    {
        var text = $"{error.GetType().Name}: {error.Message}";
        return LastError = text.Length > 140 ? text[..140] : text;
    }

    internal static void Show(Context context, Notification notification, bool playing, Action<bool> report)
    {
        var pending = new Publication(notification, playing, report);
        latest = pending;
        pendingStop?.Cancel();
        pendingStop = null;
        // Android only lets a service enter the foreground right after a StartForegroundService call made while the
        // app is in use. Calling StartForeground again inside a service that already left the foreground is refused
        // ("mAllowStartForeground false"), so a service that is not in the foreground is started again instead.
        if (running is { } service && (service.InForeground || !playing)) service.Refresh(pending);
        else if (!starting)
        {
            try
            {
                starting = true;
                context.StartForegroundService(new Intent(context, typeof(PlaybackService)));
            }
            catch (Java.Lang.RuntimeException error)
            {
                starting = false;
                Android.Util.Log.Warn("FamilyHub", $"Playback service could not start: {Describe(error)}");
                report(false);
            }
        }
    }

    private static CancellationTokenSource? pendingStop;
    internal bool InForeground => foreground;

    // Between songs the queue is empty for a moment. Stopping and starting the service for every gap is what Android
    // punishes, so the service stays for a short grace period and only stops if nothing plays again.
    internal static void Clear(Context context)
    {
        if (latest is null && !IsStarted) return;
        latest = null;
        pendingStop?.Cancel();
        var stop = pendingStop = new CancellationTokenSource();
        _ = Task.Delay(TimeSpan.FromSeconds(20)).ContinueWith(_ =>
            MainThread.BeginInvokeOnMainThread(() =>
            {
                if (stop.IsCancellationRequested || latest is not null) return;
                pendingStop = null;
                starting = false;
                running = null;
                context.StopService(new Intent(context, typeof(PlaybackService)));
                (context.GetSystemService(NotificationService) as NotificationManager)?.Cancel(PlaybackControls.NotificationId);
            }));
    }

    public override IBinder? OnBind(Intent? intent) => null;

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        var enterForeground = starting;
        starting = false;
        if (latest is { } pending)
        {
            running = this;
            if (!Refresh(pending, enterForeground) && enterForeground) StopSelf(startId);
            PlaybackControls.Current?.Handle(intent?.Action);
        }
        else StopSelf(startId);
        return StartCommandResult.NotSticky;
    }

    // The service stays in the foreground while paused, so resuming never has to start it again.
    private bool Refresh(Publication pending, bool enterForeground = false)
    {
        if (!enterForeground && ReferenceEquals(pending, published)) return true;
        try
        {
            if (enterForeground || pending.Playing && !foreground)
            {
                EnterForeground(pending.Notification);
                foreground = true;
                if (pending.Playing)
                {
                    published = pending;
                    pending.Report(true);
                    return true;
                }
            }
            var notifications = (NotificationManager?)GetSystemService(NotificationService);
            if (notifications is null) { pending.Report(false); return false; }
            notifications.Notify(PlaybackControls.NotificationId, pending.Notification);
            published = pending;
            pending.Report(true);
            return true;
        }
        catch (Java.Lang.RuntimeException error)
        {
            Android.Util.Log.Warn("FamilyHub", $"Playback notification could not be published: {Describe(error)}");
            if (error is Android.App.ForegroundServiceStartNotAllowedException)
            {
                foreground = false;
                try { (GetSystemService(NotificationService) as NotificationManager)?.Notify(PlaybackControls.NotificationId, pending.Notification); }
                catch (Java.Lang.RuntimeException) { }
            }
            pending.Report(false);
            return false;
        }
    }

    private void EnterForeground(Notification notification)
    {
        if (OperatingSystem.IsAndroidVersionAtLeast(29))
            StartForeground(PlaybackControls.NotificationId, notification, Android.Content.PM.ForegroundService.TypeMediaPlayback);
        else StartForeground(PlaybackControls.NotificationId, notification);
    }

    public override void OnDestroy()
    {
        if (ReferenceEquals(running, this)) running = null;
        base.OnDestroy();
    }
}
