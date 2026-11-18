using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public static class GenreNames
{
    public static string Label(string? value) => string.IsNullOrWhiteSpace(value) ? "Unsorted" : value.Trim();

    public static string Key(string? value)
    {
        var words = Regex.Replace(Label(value).ToLowerInvariant(), @"\band\b", "&");
        var key = Regex.Replace(words, @"[\s\p{Pd}&]+", "");
        return key switch
        {
            "rnb" or "rnb/soul" or "rb/soul" or "rhythmblues" => "rb",
            "db" or "dnb" or "drumnbass" or "drum'n'bass" or "drum’n’bass" => "drumbass",
            _ => key
        };
    }

    public static string MostCommon(IEnumerable<string> labels) => labels.GroupBy(label => label, StringComparer.Ordinal)
        .OrderByDescending(group => group.Count())
        .ThenByDescending(group => char.IsUpper(group.Key[0]))
        .ThenBy(group => group.Key, StringComparer.Ordinal).First().Key;
}
