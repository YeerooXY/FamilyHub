using Foundation;

namespace FamilyHub.App.Services;

public static class DownloadStorage
{
    public static void Configure(string directory)
    {
        Directory.CreateDirectory(directory);
        using var url = NSUrl.FromFilename(directory);
        using var excluded = NSNumber.FromBoolean(true);
        if (!url.SetResource(NSUrl.IsExcludedFromBackupKey, excluded, out var error))
        {
            using (error)
                throw new IOException($"Could not exclude downloaded music from backup: {error?.LocalizedDescription}");
        }
    }
}
