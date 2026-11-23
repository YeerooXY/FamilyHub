using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
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

    public static async Task<AppRelease?> CheckAsync(FamilyHubApi? api, PublicAppReleases publicReleases)
    {
        var platform = Platform ?? throw new InvalidOperationException("Updates are unavailable on this platform.");
        // GitHub and the configured server can each hold a different latest build; offer the newer one.
        AppRelease? published = null;
        using var publicTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        try { published = await publicReleases.CheckAsync(platform, publicTimeout.Token); }
        catch (Exception error) when (api is not null && error is (HttpRequestException or OperationCanceledException or InvalidDataException or System.Text.Json.JsonException))
        {
            // The configured server mirrors release packages.
        }
        if (api is null) return published;
        AppRelease? mirrored = null;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var release = await api.GetAppReleaseAsync(platform, timeout.Token);
            if (!Version.TryParse(release.Version, out _) ||
                !PublicAppReleases.ValidPackage(release.Sha256, release.Size) ||
                release.DownloadUrl != $"/api/app-updates/{platform}/{release.Sha256}")
                throw new InvalidDataException("The server returned invalid update information.");
            mirrored = release;
        }
        catch (FamilyHubApiException error) when (error.StatusCode == 404 && published is not null) { }
        catch (Exception error) when (published is not null && error is (HttpRequestException or OperationCanceledException or InvalidDataException or System.Text.Json.JsonException)) { }
        if (published is null || mirrored is null) return published ?? mirrored;
        return Version.Parse(mirrored.Version) > Version.Parse(published.Version) ? mirrored : published;
    }

    public static int CompareToInstalled(AppRelease release) => Version.Parse(release.Version).CompareTo(Version.Parse(CurrentVersion));

    public static async Task InstallAsync(FamilyHubApi? api, PublicAppReleases publicReleases, AppRelease release, Action<int> progress)
    {
        var platform = Platform ?? throw new InvalidOperationException("Updates are unavailable on this platform.");
        var fromGitHub = PublicAppReleases.IsPublic(release, platform);
#if WINDOWS
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
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength is long size && size != release.Size)
                throw new InvalidDataException("The update download has an unexpected size. Check for updates again.");
            var archive = Path.Combine(stage, "update.zip");
            await using (var output = File.Create(archive))
            await using (var input = await response.Content.ReadAsStreamAsync(timeout.Token))
            {
                var buffer = new byte[81920];
                long received = 0;
                var lastPercent = -1;
                int count;
                while ((count = await input.ReadAsync(buffer, timeout.Token)) != 0)
                {
                    received += count;
                    if (received > release.Size) throw new InvalidDataException("The update exceeds its published size.");
                    await output.WriteAsync(buffer.AsMemory(0, count), timeout.Token);
                    var percent = (int)(100 * received / release.Size);
                    if (percent != lastPercent) { progress(percent); lastPercent = percent; }
                }
                if (received != release.Size) throw new InvalidDataException("The update download was interrupted. Try again.");
            }
            await using (var input = File.OpenRead(archive))
            {
                var digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(input, timeout.Token));
                if (digest != release.Sha256) throw new InvalidDataException("The update failed its integrity check. Try downloading it again.");
            }
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
#else
        if (UpdatesInSideStore)
        {
            if (!await Launcher.Default.TryOpenAsync(new Uri("sidestore://")))
                throw new InvalidOperationException("Open SideStore, then tap Update next to FamilyHub Music in My Apps.");
            return;
        }
        // Android keeps installation under the operating system's package installer.
        var download = fromGitHub ? new Uri(release.DownloadUrl)
            : (api ?? throw new InvalidOperationException("Connect to your FamilyHub server or open Release history.")).ResolveUri(release.DownloadUrl);
        if (!await Launcher.Default.OpenAsync(download))
            throw new InvalidOperationException("Open Release history in a browser to download the update.");
#endif
    }
}
