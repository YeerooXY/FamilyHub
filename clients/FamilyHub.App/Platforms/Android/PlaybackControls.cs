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
    private bool serviceRunning;
    private PlaybackStateCode lastState = Unknown;
    private string? lastTrack;
    private long lastDuration = -1, lastActions, lastControlRevision = -1;
    private Bitmap? publishedArtwork;
    private bool lastShuffle;


    private PlaybackControls(Context context, MusicPlayer player, MusicSession session)
    {
        this.context = context; this.player = player; this.session = session;
        media = new MediaSession(context, "FamilyHub");
        media.SetCallback(new Callbacks(this));
        var open = context.PackageManager?.GetLaunchIntentForPackage(context.PackageName!);
        if (open is not null) media.SetSessionActivity(PendingIntent.GetActivity(context, 0, open, PendingIntentFlags.Immutable));
        if (Build.VERSION.SdkInt >= BuildVersionCodes.O)
        {
            var channel = new NotificationChannel(Channel, "Playback", NotificationImportance.Low) { Description = "Playing song and controls" };
            channel.SetShowBadge(false);
            ((NotificationManager)context.GetSystemService(Context.NotificationService)!).CreateNotificationChannel(channel);
        }
        player.Changed += Update;
    }

    internal static void Start(Context context, MusicPlayer player, MusicSession session) => Current ??= new PlaybackControls(context, player, session);

    private void Update()
    {
        if (!MainThread.IsMainThread) { MainThread.BeginInvokeOnMainThread(Update); return; }
        var track = player.Current;
        if (track is null)
        {
            media.Active = false;
            StopService();
            lastState = Unknown; lastTrack = null;
            return;
        }
        var state = player.Preparing ? PlaybackStateCode.Buffering : player.Playing ? PlaybackStateCode.Playing : PlaybackStateCode.Paused;
        var actions = PlaybackState.ActionPlay | PlaybackState.ActionPause | PlaybackState.ActionPlayPause | PlaybackState.ActionStop;
        // A Listen Together guest follows the host and cannot skip or seek.
        if (!player.FollowingHost) actions |= PlaybackState.ActionSkipToNext | PlaybackState.ActionSkipToPrevious | (player.CanSeek ? PlaybackState.ActionSeekTo : 0);
        var mixIcon = player.Shuffle ? Resource.Drawable.shuffle_on : Resource.Drawable.shuffle_off;
        var duration = (long)(Math.Max(player.Duration, track.Duration) * 1000);
        var currentArtwork = artworkFor == track.Id ? artwork : null;
        var metadataChanged = track.Id != lastTrack || duration != lastDuration || currentArtwork != publishedArtwork;

        if (!player.Seeking && (state != lastState || actions != lastActions || track.Id != lastTrack || player.ControlRevision != lastControlRevision || player.Shuffle != lastShuffle))
        {
            media.SetPlaybackState(new PlaybackState.Builder()
            .SetActions(actions)
            .AddCustomAction(ActionMix, player.Shuffle ? "Mix on" : "Mix off", mixIcon)
            .SetState(state, (long)(player.Position * 1000), player.Playing ? 1f : 0f, SystemClock.ElapsedRealtime())
            .Build());
            lastActions = actions; lastControlRevision = player.ControlRevision;
        }
        if (metadataChanged)
        {
            var metadata = new MediaMetadata.Builder()
                .PutString(MediaMetadata.MetadataKeyTitle, track.Title)
                .PutString(MediaMetadata.MetadataKeyArtist, track.Channel)
                .PutString(MediaMetadata.MetadataKeyAlbum, track.LibraryAlbum)
                .PutLong(MediaMetadata.MetadataKeyDuration, (long)(Math.Max(player.Duration, track.Duration) * 1000));
            if (artworkFor == track.Id && artwork is not null) metadata.PutBitmap(MediaMetadata.MetadataKeyAlbumArt, artwork);
            media.SetMetadata(metadata.Build());
            lastDuration = duration; publishedArtwork = currentArtwork;
            if (track.Id != lastTrack) { lastTrack = track.Id; _ = LoadArtwork(track); }
        }
        media.Active = true;
        if (state != lastState || metadataChanged || player.Shuffle != lastShuffle || !serviceRunning) { lastState = state; lastShuffle = player.Shuffle; ShowNotification(track, state); }
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
            if (bitmap is null || player.Current?.Id != track.Id) return;
            artwork?.Dispose();
            artwork = bitmap; artworkFor = track.Id;
            MainThread.BeginInvokeOnMainThread(Update);
        }
        catch (Exception) { /* The song plays without lock-screen artwork. */ }
    }

    private Notification.Action Action(int icon, string title, string action) =>
        new Notification.Action.Builder(Icon.CreateWithResource(context, icon), title,
            PendingIntent.GetService(context, action.GetHashCode(), new Intent(context, typeof(PlaybackService)).SetAction(action), PendingIntentFlags.Immutable)).Build();

    private void ShowNotification(MusicTrack track, PlaybackStateCode state)
    {
        var playing = state is PlaybackStateCode.Playing or PlaybackStateCode.Buffering;
        var builder = Build.VERSION.SdkInt >= BuildVersionCodes.O ? new Notification.Builder(context, Channel) : new Notification.Builder(context);
        builder.SetSmallIcon(Resource.Mipmap.familyhub)
            .SetContentTitle(track.Title)
            .SetContentText(track.Channel)
            .SetVisibility(NotificationVisibility.Public)
            .SetShowWhen(false)
            .SetOngoing(playing)
            .SetContentIntent(media.Controller.SessionActivity)
            .AddAction(Action(Android.Resource.Drawable.IcMediaPrevious, "Previous", ActionPrevious))
            .AddAction(Action(playing ? Android.Resource.Drawable.IcMediaPause : Android.Resource.Drawable.IcMediaPlay, playing ? "Pause" : "Play", ActionToggle))
            .AddAction(Action(Android.Resource.Drawable.IcMediaNext, "Next", ActionNext))
            .AddAction(Action(player.Shuffle ? Resource.Drawable.shuffle_on : Resource.Drawable.shuffle_off, "Mix", ActionMix))
            .SetStyle(new Notification.MediaStyle().SetMediaSession(media.SessionToken).SetShowActionsInCompactView(0, 1, 2));
        if (artworkFor == track.Id && artwork is not null) builder.SetLargeIcon(artwork);
        PlaybackService.Latest = builder.Build();
        if (!serviceRunning)
        {
            serviceRunning = true;
            var intent = new Intent(context, typeof(PlaybackService));
            if (Build.VERSION.SdkInt >= BuildVersionCodes.O) context.StartForegroundService(intent); else context.StartService(intent);
        }
        else PlaybackService.Refresh(playing);
    }

    private void StopService()
    {
        if (!serviceRunning) return;
        serviceRunning = false;
        context.StopService(new Intent(context, typeof(PlaybackService)));
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
        public override void OnPlay() { if (!owner.player.Playing) owner.Handle(ActionToggle); }
        public override void OnPause() { if (owner.player.Playing) owner.Handle(ActionToggle); }
        public override void OnSkipToNext() => owner.Handle(ActionNext);
        public override void OnSkipToPrevious() => owner.Handle(ActionPrevious);
        public override void OnStop() { if (owner.player.Playing) owner.Handle(ActionToggle); }
        public override void OnSeekTo(long pos) => _ = Run(() => owner.player.SeekAsync(pos / 1000.0));
    }
}

/// <summary>Keeps playback alive in the background and shows the media notification.</summary>
[Service(Exported = false, ForegroundServiceType = Android.Content.PM.ForegroundService.TypeMediaPlayback)]
internal sealed class PlaybackService : Service
{
    internal static Notification? Latest;
    private static PlaybackService? running;

    public override IBinder? OnBind(Intent? intent) => null;

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        running = this;
        if (Latest is { } notification)
        {
            if (Build.VERSION.SdkInt >= BuildVersionCodes.Q)
                StartForeground(PlaybackControls.NotificationId, notification, Android.Content.PM.ForegroundService.TypeMediaPlayback);
            else StartForeground(PlaybackControls.NotificationId, notification);
        }
        PlaybackControls.Current?.Handle(intent?.Action);
        return StartCommandResult.NotSticky;
    }

    // Paused: the notification stays but can be swiped away; playing: it stays in the foreground.
    internal static void Refresh(bool playing)
    {
        if (running is not { } service || Latest is not { } notification) return;
        var manager = (NotificationManager)service.GetSystemService(NotificationService)!;
        if (playing)
        {
            if (Build.VERSION.SdkInt >= BuildVersionCodes.Q)
                service.StartForeground(PlaybackControls.NotificationId, notification, Android.Content.PM.ForegroundService.TypeMediaPlayback);
            else service.StartForeground(PlaybackControls.NotificationId, notification);
        }
        else
        {
            if (Build.VERSION.SdkInt >= BuildVersionCodes.N) service.StopForeground(StopForegroundFlags.Detach);
            else service.StopForeground(false);
            manager.Notify(PlaybackControls.NotificationId, notification);
        }
    }

    public override void OnDestroy()
    {
        if (ReferenceEquals(running, this)) running = null;
        base.OnDestroy();
    }
}
