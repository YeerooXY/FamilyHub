using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public static class FileDownload
{
    public static async Task<string> SaveNewAsync(string folder, string name, HttpContent content, CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 255 || name[0] is '.' or '-' || name[^1] is '.' or ' ' ||
            name.Any(c => char.IsControl(c) || "<>:\"/\\|?*".Contains(c)) ||
            Regex.IsMatch(name, @"^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            throw new IOException("The file name is not supported.");
        for (var number = 1; number <= 999; number++)
        {
            var candidate = number == 1 ? name : $"{Path.GetFileNameWithoutExtension(name)} ({number}){Path.GetExtension(name)}";
            var target = Path.Combine(folder, candidate);
            FileStream file;
            try { file = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true); }
            catch (IOException) when (File.Exists(target) || Directory.Exists(target)) { continue; }
            try
            {
                await using (file) await content.CopyToAsync(file, token);
                return target;
            }
            catch { File.Delete(target); throw; }
        }
        throw new IOException("Too many files have that name.");
    }
}
