namespace FamilyHub.App.Services;

// Movie playback covers the whole window. Android: landscape that follows the sensor, without status and navigation bars.
// iPhone: no status bar. Other platforms leave the window as it is.
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
#elif IOS
        // iPhone: hide the status bar (time and battery) while the film covers the window.
        Microsoft.Maui.ApplicationModel.MainThread.BeginInvokeOnMainThread(() =>
        {
            if (Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()?.Page is not { } page) return;
            var ios = page.On<Microsoft.Maui.Controls.PlatformConfiguration.iOS>();
            Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.Page.SetPrefersStatusBarHidden(ios, playing
                ? Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.StatusBarHiddenMode.True
                : Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.StatusBarHiddenMode.Default);
        });
#endif
    }
}
