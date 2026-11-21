using System.Text.Json;
using FamilyHub.Client.Core;

static class PlaylistSongChecks
{
    public static int Run()
    {
        var checks = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
        var oldTrack = JsonSerializer.Deserialize<MusicTrack>("{\"id\":\"old\"}")!;
        Check(oldTrack.Bpm is null && oldTrack.Key is null && oldTrack.KeyName is null, "Old track JSON acquired invented analysis");
        var current = JsonSerializer.Deserialize<MusicTrack>("{\"id\":\"current\",\"bpm\":100,\"key\":\"12A\",\"key_name\":\"C# minor\"}")!;
        Check(current.Bpm == 100 && current.Key == "12A" && current.KeyName == "C# minor", "Analysis JSON did not deserialize");
        var original = current with { Title = "This Is My Life (Original Mix)" };
        Check(original.DisplayTitle == "This Is My Life" && original.Title.EndsWith("(Original Mix)"),
            "Compact titles must preserve the recording edition for details and matching");
        foreach (var title in new[] { "This Is My Life (Extended Mix)", "This Is My Life (Live)", "Original Mix" })
            Check(MusicTrack.CompactTitle(title) == title, "A distinctive recording title was hidden");
        foreach (var key in new[] { "12A", "12B", "11A", "1A" })
            foreach (var bpm in new[] { 94, 100, 106, 47, 50, 53, 188, 200, 212 })
                Check(PlaylistSongs.MixesWith(current with { Key = key, Bpm = bpm }, current), "Compatible Camelot/BPM rejected: " + key + "/" + bpm);
        foreach (var key in new[] { "2A", "11B", "1B", "0A", "13A", "", "8C", "garbage" })
            Check(!PlaylistSongs.MixesWith(current with { Key = key }, current), "Incompatible key accepted: " + key);
        foreach (var bpm in new int?[] { null, 0, -1, 93, 107, 54, 214 })
            Check(!PlaylistSongs.MixesWith(current with { Bpm = bpm }, current), "Incompatible BPM accepted: " + bpm);
        Check(!PlaylistSongs.MixesWith(null, current) && !PlaylistSongs.MixesWith(current, null), "Missing song matched");
        Check(!PlaylistSongs.MixesWith(current with { Key = null }, current), "Missing analysis matched");

        var library = new Dictionary<string, MusicTrack>
        {
            ["a"] = new() { Id = "a", Title = "Zulu", Channel = "Alpha", LibraryAlbum = "Third", Duration = 90, Bpm = 110, Key = "10A" },
            ["b"] = new() { Id = "b", Title = "Bravo", Channel = "Zulu", LibraryAlbum = "First", Duration = 60, Bpm = 100, Key = "1A" },
            ["c"] = new() { Id = "c", Title = "Alpha", Channel = "Bravo", LibraryAlbum = "Second", Duration = 180, Bpm = 50, Key = "12B" }
        };
        var playlist = new MusicPlaylist { Tracks = [
            new() { SourceId = "a", AddedAt = "2026-11-01T00:00:00Z" },
            new() { SourceId = "b", AddedAt = "2026-11-03T00:00:00Z" },
            new() { SourceId = "c", AddedAt = "2026-11-02T00:00:00Z" },
            new() { Title = "Missing", Artist = "Unmatched artist", Album = "Unknown album" },
            new() { SourceId = "b", AddedAt = "2026-11-03T00:00:00Z" }
        ] };
        MusicTrack? Resolve(PlaylistTrack entry) => entry.SourceId is { } id ? library.GetValueOrDefault(id) : null;
        List<int> Positions(string sort = "Custom order", string search = "", bool mixes = false) =>
            PlaylistSongs.Positions(playlist, Resolve, search, sort, mixes, current);
        Check(Positions().SequenceEqual(new[] { 0, 1, 2, 3, 4 }), "Custom order lost source indexes");
        foreach (var (sort, expected) in new (string, int[])[] {
            ("Title", [2, 1, 4, 3, 0]), ("Artist", [0, 2, 3, 1, 4]), ("Album", [3, 1, 4, 2, 0]),
            ("Date added", [1, 4, 2, 0, 3]), ("Duration", [3, 1, 4, 0, 2]),
            ("BPM", [2, 1, 4, 0, 3]), ("Key", [1, 4, 0, 2, 3]) })
            Check(Positions(sort).SequenceEqual(expected), "Incorrect playlist sort: " + sort);
        Check(Positions(search: " FIRST ").SequenceEqual(new[] { 1, 4 }), "Album search or duplicates lost");
        Check(PlaylistSongs.Positions(playlist, Resolve, "", "BPM", false, current, true).SequenceEqual(new[] { 0, 1, 4, 2, 3 }),
            "Descending tempo lost stable ties or put missing tempos first");
        Check(PlaylistSongs.Positions(playlist, Resolve, "", "Position", false, current, true).SequenceEqual(new[] { 4, 3, 2, 1, 0 }),
            "Descending playlist position did not reverse the original order");
        Check(Positions(search: "unmatched artist").SequenceEqual(new[] { 3 }), "Unmatched metadata not searchable");
        Check(Positions(search: "missing title").Count == 0, "Empty search results failed");
        Check(Positions("BPM", mixes: true).SequenceEqual(new[] { 2, 1, 4 }), "Mix filter/sort lost visible order");
        Check(Positions("BPM", mixes: true).Select(i => Resolve(playlist.Tracks[i])!.Id).SequenceEqual(new[] { "c", "b", "b" }), "Visible playback order lost duplicates");
        return checks;
    }
}
