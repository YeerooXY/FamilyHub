using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

public sealed class PlaybackConnection(MusicSession session, MusicPlayer player)
{
    private const string Failure = "Playback could not move. Check that FamilyHub is open on both devices and try again.";
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(18);
    public string? ConnectingTo { get; private set; }
    public event Action? Changed;
    private string? receiving;
    private CancellationTokenSource? receiverLifetime;
    private readonly SemaphoreSlim receiverGate = new(1, 1);
    private TaskCompletionSource<(string Id, Task<bool> Ready)>? localStatus;
    private TaskCompletionSource<(string Id, bool Applied)>? localResult;

    private void UpdatePending()
    {
        session.HandoffPending = ConnectingTo is not null || receiving is not null;
        Changed?.Invoke();
    }

    public async Task<string?> ChooseAsync(string from, string to, PlaybackDevice? source = null, bool startPlaying = false)
    {
        if (ConnectingTo is not null || receiving is not null) return "A device is already connecting.";
        if (player.FollowingHost) return "Leave Listen Together first, then choose a device.";
        if (session.Api is not { } api || !session.Connected) return Failure;
        var activation = session.PlaybackActivation;
        ConnectingTo = to;
        if (to == session.DeviceId)
        {
            localResult = new(TaskCreationOptions.RunContinuationsAsynchronously);
            localStatus = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        UpdatePending();
        try
        {
            using var deadline = new CancellationTokenSource(Deadline);
            var token = deadline.Token;
            await session.RequestPlaybackCheckInAsync().WaitAsync(token);
            if (!ReferenceEquals(api, session.Api) || session.PlaybackActivation != activation) return Failure;
            var localSource = from == session.DeviceId;
            var resume = localSource ? player.CaptureResume() : null;
            if (localSource && resume is null) return "Play a song first, then choose a device.";
            var playing = localSource ? player.PlaybackRequested : source?.IsPlaying ?? player.RemotePlaying;
            var position = resume?.Position ?? source?.PositionAt(0) ?? player.Position;
            var receipt = localSource
                ? await api.TransferPlaybackAsync(from, to, resume!, playing, token)
                : await api.TakeOverPlaybackAsync(from, to, token, startPlaying);
            deadline.CancelAfter(Deadline);
            if (localResult is { } result)
            {
                var ready = api.WaitForHandoffAsync(receipt.Id, to, token);
                localStatus!.TrySetResult((receipt.Id, ready));
                await session.RequestPlaybackCheckInAsync().WaitAsync(token);
                if (!await ready) return Failure;
                var completed = await result.Task.WaitAsync(token);
                if (!completed.Applied || completed.Id != receipt.Id) return Failure;
            }
            else
            {
                if (!await api.WaitForHandoffAsync(receipt.Id, to, token) || !ReferenceEquals(api, session.Api)
                    || session.PlaybackActivation != activation || player.FollowingHost) return Failure;
                if (player.RemoteDeviceId != to) player.EnterRemote(to, receipt.Target, position, playing);
            }
            if (receipt.SourcePaused == false) session.SetMessage("Playback moved. Check whether the previous device paused.", "warning");
            return null;
        }
        catch (Exception e) when (ConnectionError(e)) { return Failure; }
        finally { localStatus?.TrySetCanceled(); localStatus = null; localResult = null; ConnectingTo = null; UpdatePending(); }
    }

    public async Task ReceiveAsync(PlaybackHandover command, FamilyHubApi api, long activation)
    {
        bool Current() => ReferenceEquals(api, session.Api) && activation == session.PlaybackActivation
            && session.IsCurrentPlaybackCommand(command) && !player.FollowingHost;
        var pause = command.Action == "pause";
        var applied = false;
        using var deadline = new CancellationTokenSource(Deadline);
        var token = deadline.Token;
        var entered = false;
        try
        {
            if (!Current()) return;
            // The source switches in ChooseAsync when its status request returns ready.
            if (pause && command.DeviceId == ConnectingTo) return;
            receiverLifetime?.Cancel();
            if (!pause)
            {
                receiverLifetime = deadline; receiving = command.Id; UpdatePending();
                await receiverGate.WaitAsync(token);
                entered = true;
            }
            if (command.Resume is { IsValid: true } resume)
            {
                var known = session.Library.Concat(session.Downloads).Select(track => track.Id).ToHashSet();
                if (!known.Contains(resume.TrackIds[resume.Index])
                    || resume.TrackIds.Any(id => id.StartsWith("local-", StringComparison.Ordinal) && !known.Contains(id)))
                    await session.RefreshAsync(background: true).WaitAsync(token);
            }
            if (!Current()) return;
            async Task<bool> ConfirmAsync()
            {
                if (!Current()) return false;
                session.AcknowledgePlaybackCommand(command.Id);
                bool ready;
                if (localStatus is { } status)
                {
                    var requested = await status.Task.WaitAsync(token);
                    ready = requested.Id == command.Id && await requested.Ready.WaitAsync(token);
                }
                else ready = await api.WaitForHandoffAsync(command.Id, session.DeviceId, token);
                return ready && ReferenceEquals(api, session.Api) && activation == session.PlaybackActivation;
            }
            applied = await player.ApplyPlaybackCommandAsync(command, session.Library.Concat(session.Downloads), ConfirmAsync, token);
            if (pause && applied && ReferenceEquals(api, session.Api)) session.AcknowledgePlaybackCommand(command.Id);
        }
        catch (Exception e) when (ConnectionError(e)) { }
        finally
        {
            if (entered) receiverGate.Release();
            if (pause && !applied && ReferenceEquals(api, session.Api)) session.RetryPauseCommand(command.Id);
            if (!pause && receiving == command.Id)
            {
                localResult?.TrySetResult((command.Id, applied));
                receiverLifetime = null; receiving = null; UpdatePending();
                if (!applied && ConnectingTo is null && ReferenceEquals(api, session.Api)) session.SetMessage(Failure, "error");
            }
        }
    }

    private static bool ConnectionError(Exception e) => e is HttpRequestException or FamilyHubApiException
        or OperationCanceledException or TimeoutException or IOException or InvalidDataException or InvalidOperationException or System.Text.Json.JsonException;
}
