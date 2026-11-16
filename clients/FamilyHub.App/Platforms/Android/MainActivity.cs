using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;

namespace FamilyHub.App;

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, ResizeableActivity = true, LaunchMode = LaunchMode.SingleTask, ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode | ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    private const int FolderPickerRequestCode = 60134;
    private static readonly object FolderPickerLock = new();
    private static TaskCompletionSource<Android.Net.Uri?>? _folderPickerCompletion;

    internal static Task<Android.Net.Uri?> BeginFolderPicker()
    {
        var activity = Microsoft.Maui.ApplicationModel.Platform.CurrentActivity
            ?? throw new InvalidOperationException("The Android activity is unavailable for folder selection.");
        var completion = new TaskCompletionSource<Android.Net.Uri?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (FolderPickerLock)
        {
            if (_folderPickerCompletion is not null)
                throw new InvalidOperationException("A folder picker is already open. Finish or cancel it before opening another.");
            _folderPickerCompletion = completion;
        }

        try
        {
            var intent = new Intent(Intent.ActionOpenDocumentTree);
            intent.AddFlags(ActivityFlags.GrantReadUriPermission | ActivityFlags.GrantPersistableUriPermission);
            activity.StartActivityForResult(intent, FolderPickerRequestCode);
        }
        catch
        {
            lock (FolderPickerLock)
                if (ReferenceEquals(_folderPickerCompletion, completion))
                    _folderPickerCompletion = null;
            throw;
        }

        return completion.Task;
    }

    internal static void HandleResult(int requestCode, Result resultCode, Intent? data)
    {
        if (requestCode != FolderPickerRequestCode)
            return;

        TaskCompletionSource<Android.Net.Uri?>? completion;
        lock (FolderPickerLock)
        {
            completion = _folderPickerCompletion;
            _folderPickerCompletion = null;
        }

        completion?.TrySetResult(resultCode == Result.Ok ? data?.Data : null);
    }

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        // Status and navigation bars use the page background with light icons, not the template purple.
        var background = Android.Graphics.Color.ParseColor("#05070C");
#pragma warning disable CA1422 // Ignored from Android 15 edge-to-edge, where the page draws behind the bars.
        Window?.SetStatusBarColor(background);
        Window?.SetNavigationBarColor(background);
#pragma warning restore CA1422
        if (Window is { } window)
        {
            var bars = AndroidX.Core.View.WindowCompat.GetInsetsController(window, window.DecorView);
            bars.AppearanceLightStatusBars = false;
            bars.AppearanceLightNavigationBars = false;
        }
    }

    protected override void OnActivityResult(int requestCode, Result resultCode, Intent? data)
    {
        base.OnActivityResult(requestCode, resultCode, data);
        HandleResult(requestCode, resultCode, data);
    }
}
