using System.Globalization;
using System.Text.Json;

namespace FamilyHub.App.Services;

internal sealed class MovieDataUsage
{
    private const string Key = "movie-cellular-bytes";
    private static readonly object Gate = new();
    private string month = "";
    private long received;

    private static string CurrentMonth => DateTime.UtcNow.ToString("yyyy-MM", CultureInfo.InvariantCulture);

    public static long ThisMonth
    {
        get { lock (Gate) return Read(CurrentMonth); }
    }

    private static long Read(string currentMonth)
    {
        var value = Preferences.Default.Get(Key, "");
        return value.StartsWith(currentMonth + ":", StringComparison.Ordinal) &&
            long.TryParse(value.AsSpan(currentMonth.Length + 1), NumberStyles.None, CultureInfo.InvariantCulture, out var bytes)
            ? bytes : 0;
    }

    public void Record(JsonElement snapshot)
    {
        if (snapshot.ValueKind != JsonValueKind.Object ||
            !snapshot.TryGetProperty("month", out var period) || period.ValueKind != JsonValueKind.String ||
            !snapshot.TryGetProperty("cellularBytes", out var size) || size.ValueKind != JsonValueKind.Number ||
            !size.TryGetInt64(out var bytes) || bytes < 0) return;
        lock (Gate)
        {
            var currentMonth = CurrentMonth;
            if (period.GetString() != currentMonth) return;
            var previous = month == currentMonth ? received : 0;
            if (bytes <= previous) return;
            var total = Read(currentMonth);
            total += Math.Min(long.MaxValue - total, bytes - previous);
            Preferences.Default.Set(Key, currentMonth + ":" + total.ToString(CultureInfo.InvariantCulture));
            month = currentMonth;
            received = bytes;
        }
    }
}
