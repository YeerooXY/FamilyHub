using System.Buffers.Binary;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FamilyHub.Client.Core;

public sealed record DiscordSnapshot(string Title, string Artist, string Album, string RecordingId, bool Playing, double Position, double Duration, bool RemoteActive);

public static class DiscordActivity
{
    private static string Field(string value)
    {
        value = Regex.Replace(value, @"\b(?:[a-z][a-z0-9+.-]*://|www\.)\S+", "", RegexOptions.IgnoreCase).Trim();
        return value[..Math.Min(value.Length, 128)].PadRight(2);
    }

    public static object Build(DiscordSnapshot snapshot, long nowUnixMs)
    {
        var artist = snapshot.Artist.Trim();
        if (artist.EndsWith(" - Topic", StringComparison.OrdinalIgnoreCase)) artist = artist[..^8].TrimEnd();
        var id = snapshot.RecordingId;
        var image = id.Length == 11 && id.All(c => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '-')
            ? "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" : null;
        var start = nowUnixMs - (long)(Math.Max(0, double.IsFinite(snapshot.Position) ? snapshot.Position : 0) * 1000);
        var duration = Math.Max(0, double.IsFinite(snapshot.Duration) ? snapshot.Duration : 0);
        return new
        {
            type = 2,
            details = Field(snapshot.Title),
            state = Field(snapshot.Playing ? artist : "Paused · " + artist),
            timestamps = snapshot.Playing ? new { start, end = start + (long)(duration * 1000) } : null,
            assets = new { large_image = image, large_text = Field(string.IsNullOrWhiteSpace(snapshot.Album) ? snapshot.Title : snapshot.Album) }
        };
    }
}

public static class DiscordFrame
{
    public static byte[] Encode(int opcode, object payload)
    {
        return EncodeBytes(opcode, JsonSerializer.SerializeToUtf8Bytes(payload));
    }

    public static byte[] EncodeBytes(int opcode, byte[] payload)
    {
        var frame = new byte[8 + payload.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, opcode);
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(4), payload.Length);
        payload.CopyTo(frame.AsSpan(8));
        return frame;
    }
}
