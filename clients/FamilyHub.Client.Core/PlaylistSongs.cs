using System.Globalization;

namespace FamilyHub.Client.Core;

public static class PlaylistSongs
{
    public static string Album(PlaylistTrack entry, MusicTrack? track) =>
        !string.IsNullOrWhiteSpace(entry.Album) && entry.Album is not ("Selected recordings" or "Unknown album")
            ? entry.Album : track?.LibraryAlbum is { Length: > 0 } album && album != "Selected recordings" ? album : "";

    public static List<int> Positions(MusicPlaylist playlist, Func<PlaylistTrack, MusicTrack?> resolve,
        string search, string sort, bool mixesOnly, MusicTrack? current, bool? descending = null,
        Func<PlaylistTrack, string>? contributor = null)
    {
        var rows = playlist.Tracks.Select((entry, position) => (Entry: entry, Track: resolve(entry), Position: position))
            .Where(row => (!mixesOnly || MixesWith(row.Track, current)) &&
                CultureInfo.CurrentCulture.CompareInfo.IndexOf(
                    (row.Track?.Title ?? row.Entry.Title) + " " + (row.Track?.Channel ?? row.Entry.Artist) + " " + Album(row.Entry, row.Track),
                    search.Trim(), CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0);
        var reverse = descending ?? (sort == "Date added");
        var names = StringComparer.CurrentCultureIgnoreCase;
        rows = sort switch
        {
            "Position" => Order(rows, row => row.Position, reverse),
            "Title" => Order(rows, row => row.Track?.DisplayTitle ?? row.Entry.Title, reverse, names),
            "Artist" => Order(rows, row => row.Track?.Channel ?? row.Entry.Artist, reverse, names),
            "Album" => Order(rows, row => Album(row.Entry, row.Track), reverse, names),
            "Added by" => Order(rows, row => contributor?.Invoke(row.Entry) ?? row.Entry.AddedBy ?? playlist.OwnerId, reverse, names),
            "Date added" => Order(rows, row => DateTimeOffset.TryParse(row.Entry.AddedAt, out var date) ? date : DateTimeOffset.MinValue, reverse),
            "Duration" => Order(rows, row => row.Track?.Duration ?? row.Entry.Duration, reverse),
            "BPM" => Order(rows, row => row.Track?.Bpm ?? (reverse ? int.MinValue : int.MaxValue), reverse),
            "Key" => Order(rows, row => CamelotIndex(row.Track?.Key) ?? (reverse ? int.MinValue : int.MaxValue), reverse),
            _ => rows
        };
        return rows.Select(row => row.Position).ToList();
    }

    private static IOrderedEnumerable<T> Order<T, TKey>(IEnumerable<T> rows, Func<T, TKey> key, bool reverse, IComparer<TKey>? comparer = null) =>
        reverse ? rows.OrderByDescending(key, comparer) : rows.OrderBy(key, comparer);

    public static bool MixesWith(MusicTrack? candidate, MusicTrack? current)
    {
        if (candidate?.Bpm is not > 0 || current?.Bpm is not > 0) return false;
        var a = CamelotIndex(candidate.Key); var b = CamelotIndex(current.Key);
        if (a is null || b is null) return false;
        var distance = Math.Abs(a.Value / 2 - b.Value / 2);
        if (a / 2 != b / 2 && !(a % 2 == b % 2 && distance is 1 or 11)) return false;
        return new[] { .5, 1, 2 }.Any(factor => Math.Abs(candidate.Bpm.Value * factor / current.Bpm.Value - 1) <= .06 + 1e-9);
    }

    private static int? CamelotIndex(string? key) => key is { Length: 2 or 3 } && key[^1] is 'A' or 'B' &&
        int.TryParse(key.AsSpan(0, key.Length - 1), NumberStyles.None, CultureInfo.InvariantCulture, out var number) && number is >= 1 and <= 12
            ? (number - 1) * 2 + (key[^1] == 'B' ? 1 : 0) : null;
}
