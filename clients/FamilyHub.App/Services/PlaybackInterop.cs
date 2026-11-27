using System.Text.RegularExpressions;
using Microsoft.JSInterop;

namespace FamilyHub.App.Services;

internal static class PlaybackInterop
{
    internal static async ValueTask<bool> TryInvokeVoidAsync(IJSRuntime js, string identifier, params object?[] args)
    {
        try { await js.InvokeVoidAsync(identifier, args); return true; }
        catch (Exception error) when (IsUnavailable(error)) { Report(identifier, error); return false; }
    }

    internal static async ValueTask<T> InvokeOrAsync<T>(IJSRuntime js, string identifier, T fallback, params object?[] args)
    {
        try { return await js.InvokeAsync<T>(identifier, args); }
        catch (Exception error) when (IsUnavailable(error)) { Report(identifier, error); return fallback; }
    }

    internal static bool IsUnavailable(Exception error) => error is JSException or JSDisconnectedException or TaskCanceledException;

    internal static void Report(string identifier, Exception error)
    {
        var message = $"Playback UI {identifier}: {Describe(error)}";
#if ANDROID
        Android.Util.Log.Warn("FamilyHub", message);
#else
        System.Diagnostics.Trace.TraceWarning(message);
#endif
    }

    // Runtime errors can contain URLs and user content. Only report fixed descriptions.
    internal static string Describe(Exception error) => error switch
    {
        JSDisconnectedException => "The JavaScript runtime disconnected.",
        TaskCanceledException => "The JavaScript call was cancelled.",
        _ when error.Message.StartsWith("Could not find '", StringComparison.Ordinal) => "JavaScript function was unavailable.",
        _ when error.Message.StartsWith("TypeError:", StringComparison.Ordinal) || error.Message.Contains("\nTypeError:", StringComparison.Ordinal) => "JavaScript type error.",
        _ when error.Message.StartsWith("ReferenceError:", StringComparison.Ordinal) || error.Message.Contains("\nReferenceError:", StringComparison.Ordinal) => "JavaScript reference error.",
        _ => "JavaScript invocation failed."
    };

    internal static string? Identify(JSException error)
    {
        const string identifier = @"((?:familyhub|FamilyHub[A-Za-z]{1,24})\.[A-Za-z_][A-Za-z0-9_.]{0,55})";
        var missing = Regex.Match(error.Message, @"\ACould not find '" + identifier + "'");
        if (missing.Success) return missing.Groups[1].Value;

        // V8 can name the called FamilyHub function in the stack attached by Blazor.
        var frame = Regex.Match(error.Message, @"\n[ \t]*at (?:window\.)?" + identifier + @" \(");
        return frame.Success ? frame.Groups[1].Value : null;
    }
}
