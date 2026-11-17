using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public sealed class DiscordPresence
{
    public const string ApplicationId = "1572224883839209625";
    private const string PreferenceKey = "familyhub:discord-presence";
    public static bool Enabled => ApplicationId.Length > 0 && Preferences.Default.Get(PreferenceKey, false);
    public static event Action? SettingChanged;
    public static void SetEnabled(bool enabled)
    {
        Preferences.Default.Set(PreferenceKey, enabled);
        SettingChanged?.Invoke();
    }

#if WINDOWS
    private readonly System.Threading.Channels.Channel<(DiscordSnapshot? Snapshot, DateTime? PausedAt)> updates = System.Threading.Channels.Channel.CreateBounded<(DiscordSnapshot?, DateTime?)>(
        new System.Threading.Channels.BoundedChannelOptions(1) { FullMode = System.Threading.Channels.BoundedChannelFullMode.DropOldest, SingleReader = true });
    private readonly CancellationTokenSource stop = new();
    private DateTime? pausedSince;
    public DiscordPresence() { if (ApplicationId.Length > 0) _ = Task.Run(RunAsync); }
    public void Update(DiscordSnapshot? snapshot)
    {
        if (snapshot is { Playing: false, RemoteActive: false }) pausedSince ??= DateTime.UtcNow;
        else pausedSince = null;
        updates.Writer.TryWrite((snapshot, pausedSince));
    }
    public void Close() { Update(null); stop.CancelAfter(TimeSpan.FromSeconds(1)); }

    private async Task RunAsync()
    {
        DiscordSnapshot? latest = null;
        DateTime? pausedAt = null;
        var lastSent = DateTime.MinValue;
        while (!stop.IsCancellationRequested)
        {
            try
            {
                using var pipe = await ConnectAsync(stop.Token);
                if (pipe is null) { await Task.Delay(TimeSpan.FromSeconds(15), stop.Token); continue; }
                await pipe.WriteAsync(DiscordFrame.Encode(0, new { v = 1, client_id = ApplicationId }), stop.Token);
                using (var handshakeTimeout = CancellationTokenSource.CreateLinkedTokenSource(stop.Token))
                {
                    handshakeTimeout.CancelAfter(TimeSpan.FromSeconds(10));
                    while (true)
                    {
                        var (op, payload) = await ReadAsync(pipe, handshakeTimeout.Token);
                        if (op == 3) { await WritePongAsync(pipe, payload, handshakeTimeout.Token); continue; }
                        if (op == 2) throw new IOException("Discord closed the connection.");
                        using var json = System.Text.Json.JsonDocument.Parse(payload);
                        if (op == 1 && json.RootElement.TryGetProperty("evt", out var evt) && evt.GetString() == "READY") break;
                    }
                }
                var read = ReadAsync(pipe, stop.Token);
                var dirty = true;
                var sentClear = false;
                while (!stop.IsCancellationRequested)
                {
                    while (updates.Reader.TryRead(out var next))
                    {
                        latest = next.Snapshot; pausedAt = next.PausedAt; dirty = true;
                    }
                    var clear = latest is null || latest.RemoteActive || pausedAt is { } pause && DateTime.UtcNow - pause >= TimeSpan.FromMinutes(5);
                    if (clear && !sentClear) dirty = true;
                    if (clear && sentClear) dirty = false;
                    if (dirty && (clear || DateTime.UtcNow - lastSent >= TimeSpan.FromSeconds(2)))
                    {
                        var activity = clear ? null : DiscordActivity.Build(latest!, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                        await pipe.WriteAsync(DiscordFrame.Encode(1, new { cmd = "SET_ACTIVITY", args = new { pid = Environment.ProcessId, activity }, nonce = Guid.NewGuid().ToString() }), stop.Token);
                        lastSent = DateTime.UtcNow; dirty = false; sentClear = clear;
                    }
                    var completed = await Task.WhenAny(read, Task.Delay(250, stop.Token));
                    if (completed == read)
                    {
                        var (op, payload) = await read;
                        if (op == 2) throw new IOException("Discord closed the connection.");
                        if (op == 3) await WritePongAsync(pipe, payload, stop.Token);
                        read = ReadAsync(pipe, stop.Token);
                    }
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch { try { await Task.Delay(TimeSpan.FromSeconds(15), stop.Token); } catch (OperationCanceledException) { break; } }
        }
    }

    private static async Task<System.IO.Pipes.NamedPipeClientStream?> ConnectAsync(CancellationToken token)
    {
        for (var i = 0; i < 10; i++)
        {
            var pipe = new System.IO.Pipes.NamedPipeClientStream(".", "discord-ipc-" + i, System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous);
            try { await pipe.ConnectAsync(100, token); return pipe; }
            catch (TimeoutException) { pipe.Dispose(); }
            catch { pipe.Dispose(); throw; }
        }
        return null;
    }

    private static async Task<(int Opcode, byte[] Payload)> ReadAsync(Stream stream, CancellationToken token)
    {
        var header = new byte[8];
        await stream.ReadExactlyAsync(header, token);
        var opcode = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(header);
        var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(4));
        if (length < 0 || length > 1024 * 1024) throw new IOException("Invalid Discord frame length.");
        var payload = new byte[length];
        await stream.ReadExactlyAsync(payload, token);
        return (opcode, payload);
    }

    private static async Task WritePongAsync(Stream stream, byte[] payload, CancellationToken token)
    {
        await stream.WriteAsync(DiscordFrame.EncodeBytes(4, payload), token);
    }
#endif
}
