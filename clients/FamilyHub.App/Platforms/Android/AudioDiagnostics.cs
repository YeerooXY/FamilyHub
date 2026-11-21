using AndroidX.Media3.Common;
using AndroidX.Media3.ExoPlayer;

namespace FamilyHub.App;

internal sealed class AudioDiagnostics(Action<string, double, string?> report) : Java.Lang.Object, IPlayerListener
{
    private IExoPlayer? player;

    internal void Attach(IExoPlayer? next)
    {
        if (Equals(player, next)) return;
        player?.RemoveListener(this);
        player = next;
        player?.AddListener(this);
    }

    private void Record(string stage, string? reason = null) =>
        report(stage, Math.Max(0, player?.CurrentPosition ?? 0) / 1000d, reason);

    public void OnPlayerError(PlaybackException? error) => Record("native_error", error?.ErrorCodeName);

    public void OnPlaybackStateChanged(int playbackState)
    {
        switch (playbackState)
        {
            case 2: Record("native_buffering"); break;
            case 3: Record("native_ready"); break;
            case 4: Record("native_ended"); break;
        }
    }

    public void OnPlayWhenReadyChanged(bool playWhenReady, int reason)
    {
        if (!playWhenReady) Record("native_paused", reason switch
        {
            1 => "user_request", 2 => "audio_focus_loss", 3 => "audio_output_disconnected",
            4 => "remote_control", 5 => "end_of_item", 6 => "suppressed_too_long", _ => "other"
        });
    }

    public void OnPlaybackSuppressionReasonChanged(int reason)
    {
        if (reason != 0) Record("native_suppressed", reason switch
        {
            1 => "transient_audio_focus_loss", 2 or 3 => "unsuitable_audio_output", _ => "other"
        });
    }
}
