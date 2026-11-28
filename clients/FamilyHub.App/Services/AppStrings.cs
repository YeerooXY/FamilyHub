using System.Globalization;
using System.Resources;
using FamilyHub.Client.Core;
using Microsoft.Extensions.Localization;

namespace FamilyHub.App.Services;

public sealed class AppStrings(string preferredLanguage = "en", CultureInfo? deviceCulture = null) : IStringLocalizer
{
    internal const string PreferenceKey = "app-language";
    private static readonly ResourceManager Resources = new("FamilyHub.App.Resources.Strings", typeof(AppStrings).Assembly);
    private readonly string deviceLanguage = deviceCulture?.TwoLetterISOLanguageName == "hu" ? "hu" : "en";

    public string Preference { get; private set; } = Normalize(preferredLanguage);
    public string Language => Preference == "" ? deviceLanguage : Preference;
    public bool Hungarian => Language == "hu";
    public CultureInfo Culture => Hungarian ? CultureInfo.GetCultureInfo("hu-HU") : CultureInfo.CurrentCulture;

    internal void Save(string? value)
    {
        var preference = Normalize(value);
        Preferences.Default.Set(PreferenceKey, preference);
        Preference = preference;
    }

    private static string Normalize(string? value) => value is "en" or "hu" ? value : "";

    internal string ServerError(FamilyHubApiException error, string fallback)
    {
        if (Hungarian && error.ErrorCode is { } code)
        {
            var entry = this["Error." + code];
            if (!entry.ResourceNotFound) return entry.Value;
        }
        return fallback;
    }

    public LocalizedString this[string name]
    {
        get
        {
            var value = Resources.GetString(name, CultureInfo.GetCultureInfo(Language));
            return new(name, value ?? name, value is null);
        }
    }

    public LocalizedString this[string name, params object[] arguments]
    {
        get
        {
            var entry = this[name];
            return new(name, string.Format(Culture, entry.Value, arguments), entry.ResourceNotFound);
        }
    }

    public IEnumerable<LocalizedString> GetAllStrings(bool includeParentCultures)
    {
        var culture = Hungarian ? CultureInfo.GetCultureInfo("hu") : CultureInfo.InvariantCulture;
        var entries = Resources.GetResourceSet(culture, true, false)?.Cast<System.Collections.DictionaryEntry>() ?? [];
        var keys = entries.Select(entry => (string)entry.Key);
        if (Hungarian && includeParentCultures && Resources.GetResourceSet(CultureInfo.InvariantCulture, true, false) is { } fallback)
            keys = keys.Union(fallback.Cast<System.Collections.DictionaryEntry>().Select(entry => (string)entry.Key));
        return keys.Select(key => this[key]);
    }
}
