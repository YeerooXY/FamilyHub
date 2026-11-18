using Android.Media;
using Android.Runtime;
using AndroidX.Media3.ExoPlayer;
using AndroidX.Media3.UI;
using CommunityToolkit.Maui.Views;

namespace FamilyHub.App;

/// <summary>Earbuds or headphones connected while the app is open take over its sound.
/// Some phones keep an already open stream on the phone speaker when a Bluetooth device connects,
/// so a newly connected personal output becomes the players' preferred output until it disconnects.</summary>
internal sealed class AudioRouting : AudioDeviceCallback
{
    private static AudioRouting? current;
    private readonly MediaElement[] players;
    private AudioDeviceInfo? preferred;
    private bool listed;

    private AudioRouting(MediaElement[] players) => this.players = players;

    public static void Start(params MediaElement[] players)
    {
        if (current is not null) return;
        if (Platform.AppContext.GetSystemService(Android.Content.Context.AudioService) is not AudioManager audio) return;
        current = new AudioRouting(players);
        audio.RegisterAudioDeviceCallback(current, new Android.OS.Handler(Android.OS.Looper.MainLooper!));
    }

    /// <summary>The system output chooser decides again, e.g. to move sound back to the phone.</summary>
    public static void Clear() => current?.Prefer(null);

    /// <summary>A player that opens a new song keeps the current preference.</summary>
    public static void Apply(MediaElement player)
    {
        if (current?.preferred is { } device) SetPreferred(player, device);
    }

    private static bool Personal(AudioDeviceInfo device) => device.IsSink && (device.Type is AudioDeviceType.BluetoothA2dp
        or AudioDeviceType.WiredHeadset or AudioDeviceType.WiredHeadphones or AudioDeviceType.UsbHeadset
        || OperatingSystem.IsAndroidVersionAtLeast(31) && device.Type is AudioDeviceType.BleHeadset or AudioDeviceType.BleSpeaker);

    public override void OnAudioDevicesAdded(AudioDeviceInfo[]? addedDevices)
    {
        // Registration first reports the devices already connected; the system already routes to those.
        if (!listed) { listed = true; return; }
        if (addedDevices?.LastOrDefault(Personal) is { } device) Prefer(device);
    }

    public override void OnAudioDevicesRemoved(AudioDeviceInfo[]? removedDevices)
    {
        if (preferred is { } device && removedDevices?.Any(d => d.Id == device.Id) == true) Prefer(null);
    }

    private void Prefer(AudioDeviceInfo? device)
    {
        preferred = device;
        foreach (var player in players) SetPreferred(player, device);
    }

    private static void SetPreferred(MediaElement player, AudioDeviceInfo? device)
    {
        try
        {
            if (player.Handler?.PlatformView is Android.Views.View view && Find(view)?.Player is { } exo)
                exo.JavaCast<IExoPlayer>()?.SetPreferredAudioDevice(device);
        }
        catch (Exception) { /* Routing stays with the system when the player is not ready. */ }
    }

    private static PlayerView? Find(Android.Views.View view)
    {
        if (view is PlayerView found) return found;
        if (view is not Android.Views.ViewGroup group) return null;
        for (var i = 0; i < group.ChildCount; i++)
            if (group.GetChildAt(i) is { } child && Find(child) is { } inner) return inner;
        return null;
    }
}
