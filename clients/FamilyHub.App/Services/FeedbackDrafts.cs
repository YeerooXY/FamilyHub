using System.Text.Json;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public sealed class FeedbackDrafts(string directory)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task<T?> ReadAsync<T>(string owner) where T : class
    {
        var path = DraftPath(owner);
        await gate.WaitAsync();
        try
        {
            if (!File.Exists(path)) return null;
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<T>(stream, FamilyHubApi.JsonOptions);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return null; }
        finally { gate.Release(); }
    }

    public async Task SaveAsync<T>(string owner, T? draft) where T : class
    {
        var path = DraftPath(owner);
        await gate.WaitAsync();
        var temporary = path + ".new";
        try
        {
            if (draft is null) { File.Delete(path); return; }
            Directory.CreateDirectory(directory);
            await using (var stream = File.Create(temporary))
                await JsonSerializer.SerializeAsync(stream, draft, FamilyHubApi.JsonOptions);
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        finally { gate.Release(); }
    }

    private string DraftPath(string owner) => owner.Length == 64 && owner.All(Uri.IsHexDigit)
        ? Path.Combine(directory, owner + ".json") : throw new ArgumentException("Invalid feedback draft owner.", nameof(owner));
}
