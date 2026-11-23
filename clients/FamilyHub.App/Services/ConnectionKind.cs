using Microsoft.Maui.Networking;

namespace FamilyHub.App.Services;

public static class ConnectionKind
{
    public static string Current => FromProfiles(Connectivity.Current.ConnectionProfiles);

    public static string FromProfiles(IEnumerable<ConnectionProfile> profiles)
    {
        var cellular = false;
        foreach (var profile in profiles)
        {
            if (profile is ConnectionProfile.WiFi or ConnectionProfile.Ethernet) return "wifi";
            cellular |= profile == ConnectionProfile.Cellular;
        }
        return cellular ? "cellular" : "unknown";
    }
}
