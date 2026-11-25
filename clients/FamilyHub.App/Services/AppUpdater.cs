using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public static class AppUpdater
{
    public static string CurrentVersion => typeof(App).Assembly.GetName().Version!.ToString(3);
    public static string CurrentBuild { get; } = typeof(App).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .First(metadata => metadata.Key == "FamilyHubBuild").Value!;
    public const string ReleaseHistoryUrl = PublicAppReleases.HistoryUrl;
    public static string? Platform => DeviceInfo.Platform == DevicePlatform.WinUI ? "windows-x64"
        : DeviceInfo.Platform == DevicePlatform.Android ? "android"
        : DeviceInfo.Platform == DevicePlatform.iOS ? "ios" : null;
    public static string PlatformDisplay => Platform switch
    {
        "windows-x64" => "Windows (x64)",
        "android" => "Android",
        "ios" => "iOS",
        _ => DeviceInfo.Platform.ToString()
    };
    // iPhone builds are installed and re-signed by SideStore; the app only opens it.
    public static bool UpdatesInSideStore => Platform == "ios";
    public const string ShortcutName = "Update FamilyHub";
    private const string OneTapKey = "familyhub.ios-one-tap-update";
    // True once the person has built the "Update FamilyHub" Shortcut (docs/IOS_PRIVATE_INSTALL.md).
    // iOS cannot tell whether a Shortcut exists, so this is the person's own confirmation.
    public static bool OneTapUpdate
    {
        get => Preferences.Default.Get(OneTapKey, false);
        set => Preferences.Default.Set(OneTapKey, value);
    }

    public static async Task<AppRelease?> CheckAsync(FamilyHubApi? api, PublicAppReleases publicReleases)
    {
        var platform = Platform ?? throw new InvalidOperationException("Updates are unavailable on this platform.");
        using var publicTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        var published = await publicReleases.CheckAsync(platform, publicTimeout.Token);
        if (api is null || published is null || platform != "windows-x64") return published;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var release = await api.GetAppReleaseAsync(platform, timeout.Token);
            if (PublicAppReleases.MatchesMirror(published, release, platform)) return release;
        }
        catch (Exception error) when (error is FamilyHubApiException or HttpRequestException or OperationCanceledException or InvalidDataException or System.Text.Json.JsonException) { }
        return published;
    }

    public static int CompareToInstalled(AppRelease release) => Version.Parse(release.Version).CompareTo(Version.Parse(CurrentVersion));

    public static async Task InstallAsync(FamilyHubApi? api, PublicAppReleases publicReleases, AppRelease release, Action<int> progress)
    {
        var platform = Platform ?? throw new InvalidOperationException("Updates are unavailable on this platform.");
        using var metadataTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        await publicReleases.RequireInstallableAsync(release, platform, Version.Parse(CurrentVersion), metadataTimeout.Token);
#if WINDOWS
        var fromGitHub = PublicAppReleases.IsPublic(release, platform);
        var install = AppContext.BaseDirectory;
        var probe = Path.Combine(install, ".update-write-test-" + Guid.NewGuid().ToString("N"));
        try { File.WriteAllText(probe, ""); File.Delete(probe); }
        catch (UnauthorizedAccessException) { throw new InvalidOperationException("Move FamilyHub to a folder you can write to, then try the update again."); }
        var stage = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "FamilyHub", "AppUpdates", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        var handedOff = false;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(15));
            using var response = fromGitHub
                ? await publicReleases.OpenDownloadAsync(release, platform, timeout.Token)
                : await (api ?? throw new InvalidOperationException("Connect to your FamilyHub server or open Release history."))
                    .OpenAppUpdateAsync(release, timeout.Token);
            var archive = Path.Combine(stage, "update.zip");
            await using (var output = File.Create(archive))
                await PublicAppReleases.WriteVerifiedPackageAsync(response, output, release, progress, timeout.Token);
            var extracted = Path.Combine(stage, "extracted");
            using (var zip = ZipFile.OpenRead(archive))
            {
                if (zip.Entries.Count > 3000 || zip.Entries.Sum(e => e.Length) > 1L << 30 ||
                    zip.Entries.Any(e => !e.FullName.StartsWith("FamilyHub-Music/", StringComparison.Ordinal) ||
                        e.FullName.Contains('\\') || e.FullName.Split('/').Any(p => p is "." or "..") ||
                        ((e.ExternalAttributes >> 16) & 0xF000) == 0xA000))
                    throw new InvalidDataException("The update archive contains unsupported files.");
                zip.ExtractToDirectory(extracted);
            }
            var payload = Path.Combine(extracted, "FamilyHub-Music");
            if (!File.Exists(Path.Combine(payload, "FamilyHub.App.exe")))
                throw new InvalidDataException("The update archive is missing the application.");
            var script = Path.Combine(stage, "Apply-Update.ps1");
            File.Copy(Path.Combine(install, "Apply-Update.ps1"), script);
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe")) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var arg in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
                "-StageDirectory", stage, "-InstallDirectory", Path.TrimEndingDirectorySeparator(install),
                "-ListenerProcessId", Environment.ProcessId.ToString() }) start.ArgumentList.Add(arg);
            using var updater = Process.Start(start) ?? throw new InvalidOperationException("The updater could not start.");
            handedOff = true;
            Application.Current!.Quit();
        }
        finally
        {
            if (!handedOff) Directory.Delete(stage, true);
        }
#elif ANDROID
        var folder = Path.Combine(FileSystem.CacheDirectory, "app-updates");
        Directory.CreateDirectory(folder);
        foreach (var previous in Directory.EnumerateFiles(folder, "FamilyHub-*.apk")) File.Delete(previous);
        var package = Path.Combine(folder, $"FamilyHub-{Guid.NewGuid():N}.apk");
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(15));
            using var response = await publicReleases.OpenDownloadAsync(release, platform, timeout.Token);
            await using (var output = File.Open(package, FileMode.CreateNew))
                await PublicAppReleases.WriteVerifiedPackageAsync(response, output, release, progress, timeout.Token);
            if (!await Launcher.Default.OpenAsync(new OpenFileRequest("Install FamilyHub update",
                    new ReadOnlyFile(package, "application/vnd.android.package-archive"))))
                throw new InvalidOperationException("Could not open the Android package installer.");
        }
        catch { File.Delete(package); throw; }
#elif IOS
        if (OneTapUpdate)
        {
            // The Shortcut turns LocalDevVPN on, opens SideStore's install link for this IPA, then turns it off.
            var ipa = PublicAppReleases.IsPublic(release, platform) ? release.DownloadUrl
                : (api ?? throw new InvalidOperationException("Connect to your FamilyHub server or open Release history.")).ResolveUri(release.DownloadUrl).ToString();
            var run = "shortcuts://x-callback-url/run-shortcut?name=" + Uri.EscapeDataString(ShortcutName)
                + "&input=text&text=" + Uri.EscapeDataString(ipa)
                + "&x-success=" + Uri.EscapeDataString("familyhub://update-started")
                + "&x-error=" + Uri.EscapeDataString("familyhub://update-failed");
            if (!await Launcher.Default.TryOpenAsync(new Uri(run)))
                throw new InvalidOperationException("Shortcuts could not open. Open SideStore, then tap Update next to FamilyHub in My Apps.");
            return;
        }
        if (!await Launcher.Default.TryOpenAsync(new Uri("sidestore://")))
            throw new InvalidOperationException("Open SideStore, then tap Update next to FamilyHub in My Apps.");
#endif
    }
}
