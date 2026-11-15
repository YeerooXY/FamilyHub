namespace Microsoft.Maui.Networking;
public enum ConnectionProfile { WiFi, Ethernet, Cellular }
public sealed class ConnectivityChangedEventArgs : EventArgs { }
public sealed class Connectivity
{
    public static Connectivity Current { get; } = new();
    public IEnumerable<ConnectionProfile> ConnectionProfiles { get; set; } = [ConnectionProfile.WiFi];
    public event EventHandler<ConnectivityChangedEventArgs>? ConnectivityChanged;
    public void NotifyChanged() => ConnectivityChanged?.Invoke(this, new());
}
