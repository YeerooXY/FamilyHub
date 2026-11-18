using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FamilyHub.Client.Core;

public sealed record ListeningCounter(
    [property: JsonPropertyName("day")] string Day,
    [property: JsonPropertyName("seconds")] double Seconds,
    [property: JsonPropertyName("plays")] int Plays);

public sealed record ActivityReceipt
{
    [JsonPropertyName("counters_accepted")] public bool CountersAccepted { get; init; }
    /// <summary>A playback transfer or pause when another device of this profile becomes active.</summary>
    [JsonPropertyName("command")] public PlaybackHandover? Command { get; init; }
    /// <summary>Play, pause, next, previous or seek sent by the device that handed playback here.</summary>
    [JsonPropertyName("controls")] public List<PlaybackControl> Controls { get; init; } = [];
}
public sealed record PlaybackControl
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("action")] public string Action { get; init; } = "";
    [JsonPropertyName("position")] public double? Position { get; init; }
}
public sealed record PlaybackHandover
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("action")] public string Action { get; init; } = "";
    [JsonPropertyName("from_name")] public string FromName { get; init; } = "";
    [JsonPropertyName("resume")] public PlaybackResume? Resume { get; init; }
    [JsonPropertyName("playing")] public bool Playing { get; init; }
    [JsonPropertyName("device_id")] public string DeviceId { get; init; } = "";
    [JsonPropertyName("activation")] public long Activation { get; init; }
    [JsonPropertyName("position")] public double? Position { get; init; }
    [JsonPropertyName("track")] public PlaybackDeviceTrack? Track { get; init; }
}
public sealed record PlaybackDevice
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("kind")] public string Kind { get; init; } = "";
    [JsonPropertyName("playing")] public bool Playing { get; init; }
    [JsonPropertyName("track")] public PlaybackDeviceTrack? Track { get; init; }
    [JsonPropertyName("position")] public double? Position { get; init; }
    /// <summary>Seconds since the device last checked in.</summary>
    [JsonPropertyName("age")] public double Age { get; init; }
    [JsonPropertyName("this")] public bool This { get; init; }
}
public sealed record PlaybackDeviceTrack
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("title")] public string Title { get; init; } = "";
    [JsonPropertyName("channel")] public string Channel { get; init; } = "";
}
public sealed record PlaybackDevicesResponse { [JsonPropertyName("devices")] public List<PlaybackDevice> Devices { get; init; } = []; }
public sealed record PlaybackTransferReceipt { [JsonPropertyName("target")] public string Target { get; init; } = ""; }

// Daily counters survive closing the app; the server credits only their growth.
public sealed class ListeningJournal
{
    private readonly string path;
    private readonly Func<DateTimeOffset> utc;
    private readonly Func<double> clock;
    private readonly object gate = new();
    private Journal state;
    private double? lastAt;
    private bool wasPlaying, dirty;
    private double lastWrite;
    public string DeviceId => state.DeviceId;

    public ListeningJournal(string directory, Func<DateTimeOffset>? utc = null, Func<double>? clock = null)
    {
        path = Path.Combine(directory, "listening.json");
        this.utc = utc ?? (() => DateTimeOffset.UtcNow);
        this.clock = clock ?? (() => (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency);
        try { state = File.Exists(path) ? JsonSerializer.Deserialize<Journal>(File.ReadAllText(path)) ?? new() : new(); }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        { state = new(); }
    }

    public void InvalidateBaseline() { lock (gate) { lastAt = null; wasPlaying = false; } }

    public void Observe(string? track, int index, double position, bool playing)
    {
        lock (gate)
        {
            var now = clock();
            if (track is null || !double.IsFinite(position) || position < 0)
            { lastAt = null; wasPlaying = false; return; }
            var changed = state.Track != track || state.Index != index || position < 5 && position + 2 < state.Position;
            if (changed) { state.Track = track; state.Index = index; state.Listened = 0; state.Credited = false; }
            // Duplicate notifications must not reset the wall-clock baseline between playhead ticks.
            if (!changed && wasPlaying && playing && position == state.Position) return;
            if (!changed && wasPlaying && lastAt is { } previous)
            {
                var elapsed = Math.Max(0, now - previous);
                var moved = position - state.Position;
                // A seek or stalled/buffering playhead contributes no elapsed listening.
                if (elapsed > 0 && moved > 0 && moved <= elapsed + 2)
                {
                    var listened = Math.Min(elapsed, moved);
                    AddSeconds(utc().ToUniversalTime(), listened);
                    state.Listened += listened;
                    if (!state.Credited && state.Listened >= 30)
                    { Today(utc().ToUniversalTime()).Plays++; state.Credited = true; }
                    dirty = true;
                }
            }
            state.Position = position; lastAt = now; wasPlaying = playing;
            if (dirty && (now - lastWrite >= 30 || !playing || changed)) Flush();
        }
    }

    private Day Today(DateTimeOffset when)
    {
        var day = when.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        if (!state.Days.TryGetValue(day, out var value)) state.Days[day] = value = new();
        return value;
    }

    private void AddSeconds(DateTimeOffset end, double seconds)
    {
        // Split long background intervals at UTC midnight, retaining their actual listening date.
        var start = end.AddSeconds(-Math.Min(seconds, 86400));
        while (start < end)
        {
            var next = new DateTimeOffset(start.UtcDateTime.Date.AddDays(1), TimeSpan.Zero);
            var until = next < end ? next : end;
            var day = Today(start);
            day.Seconds = Math.Min(86400, day.Seconds + (until - start).TotalSeconds);
            start = until;
        }
    }

    public List<ListeningCounter> Pending()
    {
        lock (gate) return state.Days.Where(p => p.Value.Seconds > p.Value.AckSeconds || p.Value.Plays > p.Value.AckPlays)
            .OrderBy(p => p.Key).Take(400).Select(p => new ListeningCounter(p.Key, p.Value.Seconds, p.Value.Plays)).ToList();
    }

    public void Acknowledge(IEnumerable<ListeningCounter> sent)
    {
        lock (gate)
        {
            foreach (var row in sent)
                if (state.Days.TryGetValue(row.Day, out var day))
                { day.AckSeconds = Math.Max(day.AckSeconds, row.Seconds); day.AckPlays = Math.Max(day.AckPlays, row.Plays); }
            dirty = true; if (clock() - lastWrite >= 30) Flush();
        }
    }

    public void Flush()
    {
        lock (gate)
        {
            if (!dirty) return;
            var temporary = path + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(temporary, JsonSerializer.Serialize(state));
                File.Move(temporary, path, true);
                dirty = false; lastWrite = clock();
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            finally { try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
        }
    }

    public sealed class Journal
    {
        public string DeviceId { get; set; } = Guid.NewGuid().ToString("N");
        public Dictionary<string, Day> Days { get; set; } = [];
        public string? Track { get; set; }
        public int Index { get; set; }
        public double Position { get; set; }
        public double Listened { get; set; }
        public bool Credited { get; set; }
    }
    public sealed class Day
    {
        public double Seconds { get; set; }
        public int Plays { get; set; }
        public double AckSeconds { get; set; }
        public int AckPlays { get; set; }
    }
}
