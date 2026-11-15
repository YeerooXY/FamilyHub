namespace FamilyHub.App.Services;

public sealed record AudioOutput(string Id, string Name);

public static class AudioOutputs
{
    public static async Task<List<AudioOutput>> ListAsync()
    {
#if WINDOWS
        var devices = await Windows.Devices.Enumeration.DeviceInformation.FindAllAsync(Windows.Media.Devices.MediaDevice.GetAudioRenderSelector());
        return [new("", "System default"), .. devices.Where(d => d.IsEnabled).Select(d => new AudioOutput(d.Id, d.Name))];
#else
        await Task.CompletedTask;
        return [];
#endif
    }

    public static Task OpenSystemPickerAsync() => MainThread.InvokeOnMainThreadAsync(async () =>
    {
#if ANDROID
        var activity = Platform.CurrentActivity ?? throw new InvalidOperationException("The audio chooser is not ready.");
        if (OperatingSystem.IsAndroidVersionAtLeast(34) && Android.Media.MediaRouter2.GetInstance(activity)?.ShowSystemOutputSwitcher() == true) return;
        var action = OperatingSystem.IsAndroidVersionAtLeast(29) ? Android.Provider.Settings.Panel.ActionVolume : Android.Provider.Settings.ActionSoundSettings;
        activity.StartActivity(new Android.Content.Intent(action));
        await Task.CompletedTask;
#elif WINDOWS
        await Launcher.Default.OpenAsync("ms-settings:sound");
#else
        await Task.CompletedTask;
#endif
    });

    public static Task OpenBluetoothAsync() => MainThread.InvokeOnMainThreadAsync(async () =>
    {
#if ANDROID
        (Platform.CurrentActivity ?? throw new InvalidOperationException("Bluetooth settings are not ready.")).StartActivity(new Android.Content.Intent(Android.Provider.Settings.ActionBluetoothSettings));
        await Task.CompletedTask;
#elif WINDOWS
        await Launcher.Default.OpenAsync("ms-settings:bluetooth");
#else
        await Task.CompletedTask;
#endif
    });
}
