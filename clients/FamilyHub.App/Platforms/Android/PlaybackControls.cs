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
    private const PlaybackStateCode Unknown = PlaybackStateCode.None;

    internal static PlaybackControls? Current { get; private set; }

    private readonly Context context;
    private readonly MusicPlayer player;
    private readonly MusicSession session;
    private readonly MediaSession media;
    private string? artworkFor;
    private Bitmap? artwork;
    private PlaybackStateCode lastState = Unknown;
    private PublishedMetadata? lastMetadata;
    private long lastActions, lastControlRevision = -1, lastSeekRevision = -1;
    private bool lastShuffle;

    private sealed record PublishedMetadata(string Id, string Title, string Artist, string? Album, long Duration, Bitmap? Artwork);

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
        var track = player.RemoteActive ? null : player.Current;
        if (track is null)
        {
            media.Active = false;
            PlaybackService.Clear(context);
            lastState = Unknown; lastMetadata = null;
            return;
        }
        var state = player.Playing ? PlaybackStateCode.Playing
            : player.PlaybackRequested && player.Preparing ? PlaybackStateCode.Buffering : PlaybackStateCode.Paused;
        var actions = PlaybackState.ActionPlay | PlaybackState.ActionPause | PlaybackState.ActionPlayPause | PlaybackState.ActionStop;
        // A Listen Together guest follows the host and cannot skip or seek.
        if (!player.FollowingHost) actions |= PlaybackState.ActionSkipToNext | PlaybackState.ActionSkipToPrevious | (player.CanSeek ? PlaybackState.ActionSeekTo : 0);
        var mixIcon = player.Shuffle ? Resource.Drawable.shuffle_on : Resource.Drawable.shuffle_off;
        var duration = (long)(Math.Max(player.Duration, track.Duration) * 1000);
        var current = new PublishedMetadata(track.Id, track.Title, track.Channel, track.LibraryAlbum, duration,
            artworkFor == track.Id ? artwork : null);
        var trackChanged = current.Id != lastMetadata?.Id;
        var metadataChanged = current != lastMetadata;

        if (metadataChanged)
        {
            using var metadata = new MediaMetadata.Builder();
            metadata.PutString(MediaMetadata.MetadataKeyMediaId, current.Id);
            metadata.PutString(MediaMetadata.MetadataKeyTitle, current.Title);
            metadata.PutString(MediaMetadata.MetadataKeyArtist, current.Artist);
            metadata.PutString(MediaMetadata.MetadataKeyAlbum, current.Album);
            metadata.PutLong(MediaMetadata.MetadataKeyDuration, current.Duration);
            if (current.Artwork is { } image) metadata.PutBitmap(MediaMetadata.MetadataKeyAlbumArt, image);
            media.SetMetadata(metadata.Build());
            lastMetadata = current;
        }
        if ((!player.Seeking || trackChanged) && (state != lastState || actions != lastActions || trackChanged
            || player.ControlRevision != lastControlRevision || player.SeekRevision != lastSeekRevision || player.Shuffle != lastShuffle))
        {
            using var playback = new PlaybackState.Builder();
            playback.SetActions(actions);
            playback.AddCustomAction(ActionMix, player.Shuffle ? "Mix on" : "Mix off", mixIcon);
            playback.SetState(state, (long)(player.Position * 1000), player.Playing ? 1f : 0f, SystemClock.ElapsedRealtime());
            media.SetPlaybackState(playback.Build());
            lastActions = actions; lastControlRevision = player.ControlRevision; lastSeekRevision = player.SeekRevision;
        }
        media.Active = true;
        if (state != lastState || metadataChanged || player.Shuffle != lastShuffle || !PlaybackService.IsStarted)
        { lastState = state; lastShuffle = player.Shuffle; ShowNotification(current, state); }
        if (trackChanged) _ = LoadArtwork(track);
    }

    private async Task LoadArtwork(MusicTrack track)
    {
        try
        {
            var uri = await session.GetArtworkAsync(track);
            var comma = uri?.IndexOf(',') ?? -1;
            if (comma < 0 || player.Current?.Id != track.Id) return;
            var bytes = Convert.FromBase64String(uri![(comma + 1)..]);
            var bitmap = await BitmapFactory.DecodeByteArrayAsync(bytes, 0, bytes.Length);
            if (bitmap is null) return;
            if (player.RemoteActive || player.Current?.Id != track.Id) { bitmap.Dispose(); return; }
            artwork?.Dispose();
            artwork = bitmap; artworkFor = track.Id;
            MainThread.BeginInvokeOnMainThread(Update);
        }
        catch (Exception) { /* The song plays without lock-screen artwork. */ }
    }

    private Notification.Action Action(int icon, string title, string action) =>
        new Notification.Action.Builder(Icon.CreateWithResource(context, icon), title,
            PendingIntent.GetService(context, action.GetHashCode(), new Intent(context, typeof(PlaybackService)).SetAction(action), PendingIntentFlags.Immutable)).Build();

    private void ShowNotification(PublishedMetadata track, PlaybackStateCode state)
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
            .AddAction(Action(playing ? Android.Resource.Drawable.IcMediaPause : Android.Resource.Drawable.IcMediaPlay, playing ? "Pause" : "Play", ActionToggle))
            .AddAction(Action(Android.Resource.Drawable.IcMediaNext, "Next", ActionNext))
            .AddAction(Action(player.Shuffle ? Resource.Drawable.shuffle_on : Resource.Drawable.shuffle_off, "Mix", ActionMix))
            .SetStyle(new Notification.MediaStyle().SetMediaSession(media.SessionToken).SetShowActionsInCompactView(0, 1, 2));
        if (track.Artwork is { } image) builder.SetLargeIcon(image);
        PlaybackService.Show(context, builder.Build(), playing);
    }

    internal void Handle(string? action)
    {
        if (action == ActionMix) { if (!player.FollowingHost && !player.RemoteActive) { player.ToggleShuffle(); _ = session.SavePreferencesAsync(player.Volume, player.Shuffle); } return; }
        _ = action switch
        {
            ActionPrevious => Run(player.PreviousAsync),
            ActionNext => Run(player.NextAsync),
            ActionToggle => Run(player.ToggleAsync),
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
        public override void OnPlay() { if (!owner.player.PlaybackRequested) owner.Handle(ActionToggle); }
        public override void OnPause() { if (owner.player.PlaybackRequested) owner.Handle(ActionToggle); }
        public override void OnSkipToNext() => owner.Handle(ActionNext);
        public override void OnSkipToPrevious() => owner.Handle(ActionPrevious);
        public override void OnStop() { if (owner.player.PlaybackRequested) owner.Handle(ActionToggle); }
        public override void OnSeekTo(long pos) => _ = Run(() => owner.player.SeekAsync(pos / 1000.0));
    }
}

/// <summary>Keeps playback alive in the background and shows the media notification.</summary>
[Service(Exported = false, ForegroundServiceType = Android.Content.PM.ForegroundService.TypeMediaPlayback)]
internal sealed class PlaybackService : Service
{
    private static (Notification Notification, bool Playing)? latest;
    private static bool starting;
    private static PlaybackService? running;
    internal static bool IsStarted => starting || running is not null;

    internal static void Show(Context context, Notification notification, bool playing)
    {
        latest = (notification, playing);
        if (running is { } service) service.Refresh(notification, playing);
        else if (!starting)
        {
            try
            {
                context.StartForegroundService(new Intent(context, typeof(PlaybackService)));
                starting = true;
            }
            catch (Java.Lang.IllegalStateException error)
            {
                Android.Util.Log.Warn("FamilyHub", $"Playback service could not start: {error.GetType().Name}");
            }
        }
    }

    internal static void Clear(Context context)
    {
        if (latest is null && !IsStarted) return;
        latest = null;
        starting = false;
        running = null;
        context.StopService(new Intent(context, typeof(PlaybackService)));
        (context.GetSystemService(NotificationService) as NotificationManager)?.Cancel(PlaybackControls.NotificationId);
    }

    public override IBinder? OnBind(Intent? intent) => null;

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        starting = false;
        if (latest is { } pending)
        {
            running = this;
            EnterForeground(pending.Notification);
            if (!pending.Playing) Refresh(pending.Notification, false);
            PlaybackControls.Current?.Handle(intent?.Action);
        }
        else StopSelf(startId);
        return StartCommandResult.NotSticky;
    }

    // Paused: the notification stays but can be swiped away; playing: it stays in the foreground.
    private void Refresh(Notification notification, bool playing)
    {
        if (playing) EnterForeground(notification);
        else
        {
            StopForeground(StopForegroundFlags.Detach);
            (GetSystemService(NotificationService) as NotificationManager)?.Notify(PlaybackControls.NotificationId, notification);
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
