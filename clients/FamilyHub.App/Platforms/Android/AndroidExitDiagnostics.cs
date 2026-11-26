using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.RegularExpressions;
using Android.App;
using Android.Content;
using Android.OS;
using FamilyHub.Client.Core;

namespace FamilyHub.App;

internal static class AndroidExitDiagnostics
{
    private const string PendingExit = "pending-exit";
    private const string LastReported = "last-reported-exit";
    private const string ExceptionKey = "managed-exception";
    private const string LastReason = "last-exit-reason";
    private const string StartTime = "process-start";
    private const string ProcessId = "process-id";
    private const string ScreenOff = "screen-off";
    private static readonly object exceptionLock = new();
    private static ISharedPreferences? preferences;
    private static ScreenOffReceiver? screenReceiver;
    private static string? availableException;
    private static int sending;

    private sealed record Exit(int Pid, long Timestamp, string Reason, string Importance, int? Age, int? SinceScreenOff);
    private sealed record Failure(int Pid, long Timestamp, string Type, string[] Frames);

    internal static string? LastExitReason
    {
        get
        {
            try { return preferences?.GetString(LastReason, null); }
            catch (Exception) { return null; }
        }
    }

    internal static void Start(Context context)
    {
        try { preferences = context.GetSharedPreferences("exit-diagnostics", FileCreationMode.Private); }
        catch (Exception) { return; }
        if (preferences is not { } store) return;

        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (args.ExceptionObject is Exception error) Capture(error);
        };
        TaskScheduler.UnobservedTaskException += (_, args) => Capture(args.Exception);
        PrepareManagedFailure();

        if (OperatingSystem.IsAndroidVersionAtLeast(30))
        {
            try { ReadExit(context, store); }
            catch (Exception) { } // The system can withhold exit history.
        }

        try
        {
            var started = Now() - (SystemClock.ElapsedRealtime() - Android.OS.Process.StartElapsedRealtime);
            using var edit = store.Edit();
            edit?.PutLong(StartTime, started)?.PutInt(ProcessId, Android.OS.Process.MyPid())?.Remove(ScreenOff)?.Commit();

            // The playback service's screen receiver only exists while the service is running.
            screenReceiver = new ScreenOffReceiver();
            using var filter = new IntentFilter(Intent.ActionScreenOff);
            if (OperatingSystem.IsAndroidVersionAtLeast(33))
                context.RegisterReceiver(screenReceiver, filter, ReceiverFlags.NotExported);
            else
                context.RegisterReceiver(screenReceiver, filter);
        }
        catch (Exception) { } // Diagnostics must never prevent app startup.
    }

    [SupportedOSPlatform("android30.0")]
    private static void ReadExit(Context context, ISharedPreferences store)
    {
        if (context.GetSystemService(Context.ActivityService) is not ActivityManager manager) return;
        var after = Math.Max(store.GetLong(LastReported, 0), Read<Exit>(store.GetString(PendingExit, null))?.Timestamp ?? 0);
        var exit = manager.GetHistoricalProcessExitReasons(context.PackageName, 0, 5)
            .Where(entry => entry.Timestamp > after && entry.ProcessName == context.PackageName)
            .MaxBy(entry => entry.Timestamp);
        if (exit is null) return;

        var reason = (int)exit.Reason switch
        {
            (int)ApplicationExitInfo.ReasonFreezer => "freezer",
            (int)ApplicationExitInfo.ReasonLowMemory => "low_memory",
            (int)ApplicationExitInfo.ReasonExcessiveResourceUsage => "excessive_resource_usage",
            (int)ApplicationExitInfo.ReasonSignaled => "signaled",
            (int)ApplicationExitInfo.ReasonCrash => "crash",
            (int)ApplicationExitInfo.ReasonCrashNative => "crash_native",
            (int)ApplicationExitInfo.ReasonAnr => "anr",
            (int)ApplicationExitInfo.ReasonUserRequested => "user_requested",
            (int)ApplicationExitInfo.ReasonUserStopped => "user_stopped",
            (int)ApplicationExitInfo.ReasonDependencyDied => "dependency_died",
            (int)ApplicationExitInfo.ReasonPermissionChange => "permission_change",
            (int)ApplicationExitInfo.ReasonInitializationFailure => "initialization_failure",
            _ => "other"
        };
        var importance = ((Importance)exit.Importance) switch
        {
            Importance.Foreground => "foreground",
            Importance.ForegroundService => "foreground_service",
            Importance.Visible => "visible",
            Importance.Perceptible => "perceptible",
            Importance.Service => "service",
            Importance.TopSleeping => "top_sleeping",
            Importance.CantSaveState => "cant_save_state",
            Importance.Cached => "cached",
            Importance.Gone => "gone",
            _ => "unknown"
        };
        var started = store.GetLong(StartTime, 0);
        var screenOff = store.GetLong(ScreenOff, 0);
        var age = exit.Pid == store.GetInt(ProcessId, 0) ? SecondsBetween(started, exit.Timestamp) : null;
        var sinceOff = age.HasValue && screenOff >= started ? SecondsBetween(screenOff, exit.Timestamp) : null;
        var snapshot = new Exit(exit.Pid, exit.Timestamp, reason, importance, age, sinceOff);
        using var edit = store.Edit();
        edit?.PutString(LastReason, reason)?.PutString(PendingExit, JsonSerializer.Serialize(snapshot))?.Commit();
    }

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static int? SecondsBetween(long start, long end) =>
        start > 0 && end >= start && (end - start) / 1000 <= int.MaxValue ? (int)((end - start) / 1000) : null;

    private sealed class ScreenOffReceiver : BroadcastReceiver
    {
        public override void OnReceive(Context? context, Intent? intent)
        {
            if (intent?.Action != Intent.ActionScreenOff) return;
            try
            {
                using var edit = preferences?.Edit();
                edit?.PutLong(ScreenOff, Now())?.Commit();
            }
            catch (Exception) { }
        }
    }

    internal static void Capture(Exception error)
    {
        try
        {
            if (error is AggregateException) error = error.GetBaseException();
            var type = error.GetType().Name;
            if (!Regex.IsMatch(type, @"\A[A-Za-z_][A-Za-z0-9_`]{0,95}\z")) type = "Exception";
            var frames = (new StackTrace(error, fNeedFileInfo: false).GetFrames() ?? []).Take(3)
                .Select(frame => frame.GetMethod())
                .Select(method => method?.DeclaringType is { } declaringType ? $"{declaringType.Name}.{method.Name}" : method?.Name)
                .Where(name => name is not null && Regex.IsMatch(name, @"\A[A-Za-z_.<>][A-Za-z0-9_.<>`|]{0,95}\z"))
                .Select(name => name!).ToArray();
            var failure = new Failure(Android.OS.Process.MyPid(), Now(), type, frames);
            lock (exceptionLock)
            {
                using var edit = preferences?.Edit();
                // Flush before a fatal exception can terminate the runtime.
                edit?.PutString(ExceptionKey, JsonSerializer.Serialize(failure))?.Commit();
            }
        }
        catch (Exception) { }
    }

    internal static void PrepareManagedFailure()
    {
        try
        {
            lock (exceptionLock) availableException = preferences?.GetString(ExceptionKey, null);
        }
        catch (Exception) { }
    }

    internal static async Task SendAsync(FamilyHubApi api, string path)
    {
        if (preferences is not { } store || Interlocked.Exchange(ref sending, 1) != 0) return;
        try
        {
            var exit = Read<Exit>(store.GetString(PendingExit, null));
            string? storedException;
            lock (exceptionLock) storedException = availableException;
            var failure = Read<Failure>(storedException);
            if (exit is not null)
            {
                var matching = failure is not null && failure.Pid == exit.Pid && failure.Timestamp <= exit.Timestamp
                    && (exit.Age is not int age || SecondsBetween(failure.Timestamp, exit.Timestamp) <= age);
                await SendReportAsync(api, path, exit, matching ? failure : null);
                Acknowledge(store, exit, matching ? storedException : null);
                if (matching) return;
            }
            if (failure is not null)
            {
                await SendReportAsync(api, path, null, failure);
                Acknowledge(store, null, storedException);
            }
        }
        catch (Exception) { } // Retain the report for the next authenticated connection.
        finally { Volatile.Write(ref sending, 0); }
    }

    private static async Task SendReportAsync(FamilyHubApi api, string path, Exit? exit, Failure? failure)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await api.RequestJsonAsync<JsonElement>(HttpMethod.Post, path, new
        {
            stage = "client_exit",
            reason = exit?.Reason ?? "other",
            importance = exit?.Importance ?? "unknown",
            age_s = exit?.Age,
            screen_off_s = exit?.SinceScreenOff,
            exception = failure?.Type,
            frames = failure?.Frames ?? []
        }, timeout.Token, background: true);
    }

    private static void Acknowledge(ISharedPreferences store, Exit? exit, string? reportedException)
    {
        lock (exceptionLock)
        {
            using var edit = store.Edit();
            if (exit is not null) edit?.PutLong(LastReported, exit.Timestamp)?.Remove(PendingExit);
            if (reportedException is not null && store.GetString(ExceptionKey, null) == reportedException)
                edit?.Remove(ExceptionKey);
            if (edit?.Commit() == true && availableException == reportedException) availableException = null;
        }
    }

    private static T? Read<T>(string? json) where T : class
    {
        try { return json is null ? null : JsonSerializer.Deserialize<T>(json); }
        catch (JsonException) { return null; }
    }
}
