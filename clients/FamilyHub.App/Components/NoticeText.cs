using System.Text.RegularExpressions;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Components;

internal static partial class NoticeText
{
    public static string Error(Exception error, string fallback = "The action could not finish. Try again.") => error switch
    {
        OperationCanceledException => "The server did not answer in time. Check your connection and try again.",
        HttpRequestException => "Cannot reach the server. Check your connection and try again.",
        FamilyHubApiException or InvalidOperationException or ArgumentException => Detail(error.Message, fallback),
        _ => fallback,
    };

    public static string Detail(string? message, string fallback) =>
        string.IsNullOrWhiteSpace(message) || TechnicalError().IsMatch(message) ? fallback : message;

    [GeneratedRegex(@"\b(?:HTTP(?:/\d+(?:\.\d+)?)?(?: status)?|status(?: code)?)\s*[:=]?\s*[45]\d{2}\b|^\s*[45]\d{2}\b|\(Parameter '|Sequence contains", RegexOptions.IgnoreCase)]
    private static partial Regex TechnicalError();
}
