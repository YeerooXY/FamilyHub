namespace FamilyHub.App.Services;

// Movie playback covers the whole window: landscape that follows the sensor in both directions, without status and
// navigation bars. Other platforms already get this from the web view or leave the window as it is.
public static class PlayerScreen
{
    public static void Set(bool playing)
    {
#if ANDROID
        var activity = Microsoft.Maui.ApplicationModel.Platform.CurrentActivity;
        if (activity?.Window is not { } window) return;
        activity.RunOnUiThread(() =>
        {
            activity.RequestedOrientation = playing ? Android.Content.PM.ScreenOrientation.SensorLandscape : Android.Content.PM.ScreenOrientation.Unspecified;
            var bars = AndroidX.Core.View.WindowCompat.GetInsetsController(window, window.DecorView);
            if (bars is null) return;
            if (playing)
            {
                bars.SystemBarsBehavior = AndroidX.Core.View.WindowInsetsControllerCompat.BehaviorShowTransientBarsBySwipe;
                bars.Hide(AndroidX.Core.View.WindowInsetsCompat.Type.SystemBars());
            }
            else bars.Show(AndroidX.Core.View.WindowInsetsCompat.Type.SystemBars());
        });
#endif
    }
}
