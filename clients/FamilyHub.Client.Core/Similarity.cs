using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public static class Similarity
{
    public static bool IsSimilar(MusicTrack seed, MusicTrack candidate)
    {
        var a = Artist(seed);
        var b = Artist(candidate);
        var x = Normalize(seed.Genre);
        var y = Normalize(candidate.Genre);
        if (x == "unsorted") x = "";
        if (y == "unsorted") y = "";
        if (x.Length > 0 && y.Length > 0 && x != y) return false;
        return a.Length > 0 && b.Length > 0 && (a == b || x.Length > 0 && x == y);
    }

    public static bool IsRecommendation(MusicTrack seed, MusicTrack candidate) =>
        IsSimilar(seed, candidate) && Artist(seed) == Artist(candidate) && SongKey(seed) != SongKey(candidate)
        && !Regex.IsMatch(candidate.Title, @"\b(first|second) half\b|\bpart [12]\b", RegexOptions.IgnoreCase);

    public static string SongKey(MusicTrack track)
    {
        var title = TitleWithoutArtist(Regex.Replace(track.Title ?? "", @"^\[[^\]]+\]\s*[-:]?\s*", ""));
        title = Regex.Replace(title, @"[\[(][^\])]*(?:official|audio|video|lyrics|release|first half|second half|hq)[^\])]*[\])]", "", RegexOptions.IgnoreCase);
        title = Regex.Replace(title, @"\b(hq|hd|official|audio|video|lyrics)\b", "", RegexOptions.IgnoreCase);
        return Normalize(title);
    }

    public static string RadioTitle(MusicTrack track)
    {
        var title = TitleWithoutArtist(track.Title ?? "").Trim();
        const string noise = @"(?:official (?:music |lyric )?(?:audio|video)|lyrics?|lyric video|hd|hq|4k|original(?: [^()[\]]+ inspired)? song)";
        var cleaned = Regex.Replace(title, $@"(?:\s*(?:\(\s*{noise}\s*\)|\[\s*{noise}\s*\]))+\z", "", RegexOptions.IgnoreCase).TrimEnd();
        return cleaned.Length > 0 ? cleaned : title;
    }

    private static string TitleWithoutArtist(string title)
    {
        var separator = Regex.Match(title, @"\s+[-\u2013\u2014]\s+");
        if (separator.Success)
            return title[(separator.Index + separator.Length)..];
        return title;
    }

    public static string Artist(MusicTrack track)
    {
        var title = Regex.Replace(track.Title ?? "", @"^\[[^\]]+\]\s*[-:]?\s*", "");
        var artist = track.Channel ?? "";
        var reversedNightcore = Regex.IsMatch(title, "^nightcore", RegexOptions.IgnoreCase);
        title = Regex.Replace(title, "^(?:nightcore|8d audio|lyrics)\\s*[-–—:]\\s*", "", RegexOptions.IgnoreCase);
        var parts = Regex.Split(title, "\\s+[-–—]\\s+");
        if (parts.Length > 1)
            artist = reversedNightcore && Regex.IsMatch(parts[1], "\\b(?:ft|feat)\\.?", RegexOptions.IgnoreCase) ? parts[1] : parts[0];
        artist = Regex.Replace(artist, "\\s*-?\\s*Topic$|VEVO$", "", RegexOptions.IgnoreCase);
        artist = Regex.Replace(artist, "\\s+(?:ft\\.?|feat\\.?)\\s+.*", "", RegexOptions.IgnoreCase);
        var normalized = Normalize(artist);
        return normalized == "muzzy" ? "muzz" : normalized;
    }

    private static string Normalize(string? value)
    {
        var chars = (value ?? "").Normalize(NormalizationForm.FormD)
            .Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark).ToArray();
        return Regex.Replace(new string(chars).ToLowerInvariant(), "[^\\p{L}\\p{N}]+", " ").Trim();
    }
}
