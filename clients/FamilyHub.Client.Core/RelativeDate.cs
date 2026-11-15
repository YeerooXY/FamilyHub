using System.Globalization;

namespace FamilyHub.Client.Core;

public static class RelativeDate
{
    // Returns "" for missing or unparseable input so the cell stays blank.
    public static string Describe(string? value, DateTimeOffset now) =>
        TryParse(value, out var date) ? Describe(date, now) : "";

    // Exact local date and time for the cell tooltip; null omits the attribute.
    public static string? Exact(string? value) =>
        TryParse(value, out var date) ? date.ToLocalTime().ToString("f", CultureInfo.CurrentCulture) : null;

    public static string Describe(DateTimeOffset date, DateTimeOffset now)
    {
        var elapsed = now - date;
        // Future dates (clock skew) read as Just now.
        if (elapsed < TimeSpan.FromMinutes(1)) return "Just now";
        if (elapsed.TotalMinutes < 60) return Ago((int)elapsed.TotalMinutes, "minute");
        if (elapsed.TotalHours < 24) return Ago((int)elapsed.TotalHours, "hour");
        var days = (int)elapsed.TotalDays;
        if (days < 7) return Ago(days, "day");
        if (days < 30) return Ago(days / 7, "week");
        if (days < 365) return Ago(Math.Min(days / 30, 12), "month");
        return Ago(days / 365, "year");
    }

    private static bool TryParse(string? value, out DateTimeOffset date) =>
        DateTimeOffset.TryParse(value, out date);

    private static string Ago(int count, string unit) =>
        $"{count} {unit}{(count == 1 ? "" : "s")} ago";
}
