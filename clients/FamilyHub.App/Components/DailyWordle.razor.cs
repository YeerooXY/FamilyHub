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

    private sealed record SavedGuesses(string Date, string[] Words, long?[]? Times = null);
    private sealed record SavedClock(string Date, int Row, long Milliseconds);
    private string SaveKey => $"wordle.pending:{Session.Server}:{Session.User}";
    private string ClockKey => SaveKey + ":clock";
    private SavedClock? clock;
    private long? clockStarted;
    private int confirmed;
    private bool syncing, syncFailed;

    private sealed record Activity(string Date, int? Row, int DraftCount);
    private readonly string activityView = Guid.NewGuid().ToString("N");
    private Activity? lastActivity, pendingActivity;
    private Task activityTask = Task.CompletedTask;
    private long nextHeartbeat;
    private bool liveVisible = true;
    private const int RevealMilliseconds = 1700;
    private const int WinReviewMilliseconds = 3000;
    private long resultRevealUntil;
    private int reviewRequest;

    private void WordleVisibilityChanged() => _ = InvokeAsync(PublishActivity);

    private void PauseClock()
    {
        if (clock is null || clockStarted is not { } start) return;
        clock = clock with { Milliseconds = clock.Milliseconds + Environment.TickCount64 - start };
        clockStarted = null;
        Preferences.Default.Set(ClockKey, JsonSerializer.Serialize(clock));
    }

    private void UpdateClock()
    {
        if (puzzle is not { Status: "playing", LocalSolution: not null } active || !liveVisible || !Session.UiActive)
        {
            PauseClock();
            return;
        }
        if (clock?.Date != active.Date || clock.Row != active.Guesses.Length)
        {
            PauseClock();
            SavedClock? saved = null;
            try { saved = JsonSerializer.Deserialize<SavedClock>(Preferences.Default.Get(ClockKey, "null")); }
            catch (JsonException) { }
            clock = saved?.Date == active.Date && saved.Row == active.Guesses.Length
                ? saved : new SavedClock(active.Date, active.Guesses.Length, 0);
        }
        clockStarted ??= Environment.TickCount64;
    }

    private void PublishActivity()
    {
        if (disposed || puzzle is null) return;
        UpdateClock();
        var playing = liveVisible && Session.UiActive && puzzle.Status == "playing";
        if (!playing && lastActivity?.Row is null) return;
        var activity = new Activity(puzzle.Date, playing ? puzzle.Guesses.Length : null, playing ? draft.Length : 0);
        var now = Environment.TickCount64;
        if (activity == lastActivity && now < nextHeartbeat) return;
        lastActivity = pendingActivity = activity;
        nextHeartbeat = now + 4000;
        if (activityTask.IsCompleted) activityTask = SendActivity();
    }

    private object ActivityPayload(Activity activity) => new
    {
        view = activityView, date = activity.Date, row = activity.Row, draft_count = activity.DraftCount
    };

    private async Task SendActivity()
    {
        while (!disposed && pendingActivity is { } activity)
        {
            pendingActivity = null;
            try { await Request<JsonElement>(HttpMethod.Put, "activity", ActivityPayload(activity)); }
            catch (Exception error) when (IsRequestError(error)) { }
        }
    }

    private async Task ClearActivity(FamilyHubApi? api)
    {
        if (api is null || lastActivity is not { } activity) return;
        await activityTask;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await api.RequestJsonAsync<JsonElement>(HttpMethod.Put, "/api/wordle/activity",
                ActivityPayload(new Activity(activity.Date, null, 0)), timeout.Token, background: true);
        }
        catch (Exception error) when (IsRequestError(error)) { }
    }

    private async Task ShowReviewAfterReveal(string date, long remaining, bool won)
    {
        var request = ++reviewRequest;
        try
        {
            if (module is null || !await module.InvokeAsync<bool>("afterReveal", lifetime.Token, surface, remaining, won) ||
                disposed || request != reviewRequest || showMemberBoard || !Session.UiActive || puzzle?.Date != date ||
                puzzle.Status != (won ? "won" : "lost")) return;

            OpenFamilyBoard(Session.User, automatic: true);
            StateHasChanged();
        }
        catch (Exception error) when (error is JSDisconnectedException or OperationCanceledException or ObjectDisposedException) { }
    }

    private static Puzzle AddGuess(Puzzle active, string word, string solution, long? time = null)
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
        Guess[] guesses = [.. active.Guesses, new Guess(word, marks, time)];
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
        UpdateClock();
        PauseClock();
        var updated = AddGuess(active, word, solution,
            clock?.Date == active.Date && clock.Row == active.Guesses.Length ? clock.Milliseconds : null);
        var saved = new SavedGuesses(active.Date, updated.Guesses.Select(g => g.Word).ToArray(),
            updated.Guesses.Select(g => g.ActiveMs).ToArray());
        Preferences.Default.Set(SaveKey, JsonSerializer.Serialize(saved));
        Preferences.Default.Remove(ClockKey);
        clock = null;
        LoadPuzzle(updated);
        if (Finished) resultRevealUntil = Environment.TickCount64 +
            (updated.Status == "won" ? WinReviewMilliseconds : RevealMilliseconds);
        revealRow = updated.Guesses.Length - 1;
        announcement = RowLabel(revealRow, draft, updated.Guesses[^1]);
        draft = "";
        PublishActivity();
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
            for (var index = confirmed; index < words.Length; index++)
            {
                if (server.Status != "playing") break;
                var word = words[index];
                if (!server.Guesses.Any(g => g.Word == word))
                    server = AddGuess(server, word, solution, saved.Times?.ElementAtOrDefault(index));
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
                    date = active.Date, word = active.Guesses[confirmed].Word, guess_count = confirmed,
                    guess_active_ms = active.Guesses[confirmed].ActiveMs
                });
                if (disposed) return;
                if (updated.Date != active.Date || updated.Guesses.Length <= confirmed ||
                    !updated.Guesses.Select(g => g.Word).SequenceEqual(puzzle.Guesses.Take(updated.Guesses.Length).Select(g => g.Word)))
                {
                    await ResolveSyncConflict();
                    return;
                }
                confirmed = updated.Guesses.Length;
                if (updated.Status != "playing")
                    LoadPuzzle(updated with { LocalSolution = active.LocalSolution, Family = null });
            }
            if (!disposed)
            {
                Preferences.Default.Remove(SaveKey);
                if (stats is not null) await Task.WhenAll(RefreshFamily(), LoadStats());
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
        PublishActivity();
        message = "The server’s board has changed. Your saved guesses are shown.";
        focusResult = Finished;
        focusBoard = !Finished;
    }
}
