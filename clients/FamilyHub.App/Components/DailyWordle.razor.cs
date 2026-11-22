using System.Text.Json;
using Microsoft.JSInterop;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Components;

public partial class DailyWordle
{
    private static readonly Lazy<HashSet<string>> AllowedWords = new(() =>
    {
        using var stream = typeof(DailyWordle).Assembly.GetManifestResourceStream("FamilyHub.Wordle.Guesses")!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
    });

    private sealed record SavedGuesses(string Date, string[] Words);
    private string SaveKey => $"wordle.pending:{Session.Server}:{Session.User}";
    private int confirmed;
    private bool syncing, syncFailed;

    private static Puzzle AddGuess(Puzzle active, string word, string solution)
    {
        var remaining = solution.ToCharArray();
        string[] marks = ["absent", "absent", "absent", "absent", "absent"];
        for (var i = 0; i < word.Length; i++)
        {
            if (word[i] != solution[i]) continue;
            marks[i] = "correct";
            remaining[i] = '\0';
        }
        for (var i = 0; i < word.Length; i++)
        {
            if (marks[i] == "correct") continue;
            var match = Array.IndexOf(remaining, word[i]);
            if (match < 0) continue;
            marks[i] = "present";
            remaining[match] = '\0';
        }
        Guess[] guesses = [.. active.Guesses, new Guess(word, marks)];
        string status = word == solution ? "won" : guesses.Length == 6 ? "lost" : "playing";
        return active with { Guesses = guesses, Status = status, Answer = status == "playing" ? null : solution };
    }

    private void SubmitLocally(Puzzle active, string solution)
    {
        var word = draft.ToLowerInvariant();
        if (word != solution && !AllowedWords.Value.Contains(word))
        {
            message = "This word isn’t accepted. Try another.";
            shake = true;
            return;
        }
        var updated = AddGuess(active, word, solution);
        var saved = new SavedGuesses(active.Date, updated.Guesses.Select(g => g.Word).ToArray());
        Preferences.Default.Set(SaveKey, JsonSerializer.Serialize(saved));
        LoadPuzzle(updated);
        revealRow = updated.Guesses.Length - 1;
        announcement = RowLabel(revealRow, draft, updated.Guesses[^1]);
        draft = "";
        message = null;
        shake = false;
        focusResult = Finished;
        StateHasChanged();
        _ = SyncGuesses();
    }

    private void RestoreLocalProgress(Puzzle server)
    {
        confirmed = server.Guesses.Length;
        var json = Preferences.Default.Get(SaveKey, "");
        SavedGuesses? saved = null;
        try { if (json.Length != 0) saved = JsonSerializer.Deserialize<SavedGuesses>(json); }
        catch (JsonException) { }
        if (saved?.Date == server.Date && saved.Words is { Length: <= 6 } words &&
            words.All(IsPuzzleWord) && words.Length > confirmed && server.Status == "playing" &&
            server.LocalSolution is { } solution && IsPuzzleWord(solution) &&
            server.Guesses.Select(g => g.Word).SequenceEqual(words.Take(confirmed)))
        {
            foreach (var word in words.Skip(confirmed))
            {
                if (server.Status != "playing") break;
                if (!server.Guesses.Any(g => g.Word == word)) server = AddGuess(server, word, solution);
            }
        }
        else if (json.Length != 0)
        {
            Preferences.Default.Remove(SaveKey);
        }
        LoadPuzzle(server);
    }

    private async Task SyncGuesses()
    {
        if (disposed || syncing || puzzle == null || confirmed >= puzzle.Guesses.Length) return;
        syncing = true;
        syncFailed = false;
        try
        {
            while (!disposed && puzzle is { } active && confirmed < active.Guesses.Length)
            {
                var updated = await RequestPuzzle(HttpMethod.Post, "guess", new {
                    date = active.Date, word = active.Guesses[confirmed].Word, guess_count = confirmed
                });
                if (disposed) return;
                if (updated.Date != active.Date || updated.Guesses.Length <= confirmed ||
                    !updated.Guesses.Select(g => g.Word).SequenceEqual(puzzle.Guesses.Take(updated.Guesses.Length).Select(g => g.Word)))
                {
                    await ResolveSyncConflict();
                    return;
                }
                confirmed = updated.Guesses.Length;
            }
            if (!disposed)
            {
                Preferences.Default.Remove(SaveKey);
                if (module != null && await module.InvokeAsync<bool>("isOpen", statsDialog))
                    await Task.WhenAll(RefreshFamily(), LoadStats());
            }
        }
        catch (FamilyHubApiException error) when (error.StatusCode is 400 or 409 or 422)
        {
            try { await ResolveSyncConflict(); }
            catch (Exception failure) when (IsRequestError(failure)) { syncFailed = true; }
        }
        catch (Exception error) when (IsRequestError(error)) { syncFailed = true; }
        finally
        {
            syncing = false;
            if (!disposed) StateHasChanged();
        }
    }

    private async Task ResolveSyncConflict()
    {
        var updated = await RequestPuzzle(HttpMethod.Get, "today?local=1");
        if (disposed) return;
        Preferences.Default.Remove(SaveKey);
        confirmed = updated.Guesses.Length;
        LoadPuzzle(updated);
        revealRow = -1;
        draft = "";
        message = "The server’s board has changed. Your saved guesses are shown.";
        focusResult = Finished;
        focusBoard = !Finished;
    }
}
