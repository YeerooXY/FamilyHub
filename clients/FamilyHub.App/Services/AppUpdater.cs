using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public static class AppUpdater
{
    public static string CurrentVersion => typeof(App).Assembly.GetName().Version!.ToString(3);
    public static string? Platform => DeviceInfo.Platform == DevicePlatform.WinUI ? "windows-x64"
        : DeviceInfo.Platform == DevicePlatform.Android ? "android"
        : DeviceInfo.Platform == DevicePlatform.iOS ? "ios" : null;
    // iPhone builds are installed and re-signed by SideStore; the app only opens it.
    public static bool UpdatesInSideStore => Platform == "ios";

    public static async Task<AppRelease?> CheckAsync(FamilyHubApi api)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var release = await api.GetAppReleaseAsync(Platform ?? throw new InvalidOperationException("Updates are unavailable on this platform."), timeout.Token);
        if (!Version.TryParse(release.Version, out var version) ||
            !Regex.IsMatch(release.Sha256 ?? "", "^[0-9a-f]{64}$") || release.Size is <= 0 or > 262144000 ||
            release.DownloadUrl != $"/api/app-updates/{Platform}/{release.Sha256}")
            throw new InvalidDataException("The server returned invalid update information.");
        return version > Version.Parse(CurrentVersion) ? release : null;
    }

    public static async Task InstallAsync(FamilyHubApi api, AppRelease release, Action<int> progress)
    {
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
            using var response = await api.OpenAppUpdateAsync(release, timeout.Token);
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
        if (!await Launcher.Default.OpenAsync(api.ResolveUri(release.DownloadUrl)))
            throw new InvalidOperationException("Open your FamilyHub server in a browser to download the update.");
#endif
    }
}
