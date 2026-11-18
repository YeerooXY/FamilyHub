using System.Diagnostics;
using FamilyHub.Client.Core;

namespace FamilyHub.App.Services;

internal static class DeckCrossfade
{
    public static async Task RunAsync(IAudioDeck outgoing, IAudioDeck incoming, double fade,
        Func<bool> requested, Action<double> setGain, CancellationToken token, Func<bool>? failed = null, double elapsed = 0)
    {
        incoming.SetPlaying(true);
        var cue = incoming.Position;
        var startupMilliseconds = 0;
        while (incoming.Opening || !incoming.Playing || incoming.Position < cue + .04)
        {
            await WaitForResumeAsync(outgoing, requested, token);
            incoming.RefreshPosition(); outgoing.RefreshPosition();
            if (failed?.Invoke() is true) throw new InvalidOperationException("The next song could not be opened. Use Next to retry it.");
            if (requested())
            {
                startupMilliseconds += CrossfadeEnvelope.TickMilliseconds;
                if (startupMilliseconds > 4000) throw new InvalidOperationException("The next song did not start. Use Next to retry it.");
            }
            await Task.Delay(CrossfadeEnvelope.TickMilliseconds, token);
        }
        fade = Math.Min(fade, Math.Max(.05, outgoing.Duration - outgoing.Position + elapsed));
        var start = incoming.Position - elapsed;
        var clock = Stopwatch.StartNew();
        var previousTime = clock.Elapsed.TotalSeconds;
        var gain = Math.Clamp(elapsed / Math.Max(.05, fade), 0, 1);
        setGain(gain);
        var stalledMilliseconds = 0;
        var previousPosition = start;
        while (true)
        {
            await WaitForResumeAsync(outgoing, requested, token);
            incoming.RefreshPosition(); outgoing.RefreshPosition();
            if (failed?.Invoke() is true) throw new InvalidOperationException("The next song stopped decoding. Use Next to retry it.");
            var position = incoming.Position;
            var progressing = incoming.Playing && !incoming.Opening;
            stalledMilliseconds = !progressing || position <= previousPosition ? stalledMilliseconds + CrossfadeEnvelope.TickMilliseconds : 0;
            if (stalledMilliseconds > 4000) throw new InvalidOperationException("The next song stopped progressing. Use Next to retry it.");
            previousPosition = position;
            var fraction = progressing ? CrossfadeEnvelope.Fraction(position, start, fade) : 0;
            var now = clock.Elapsed.TotalSeconds;
            gain = CrossfadeEnvelope.Smooth(gain, fraction, now - previousTime);
            previousTime = now;
            setGain(gain);
            if (fraction >= 1) { setGain(1); return; }
            await Task.Delay(CrossfadeEnvelope.TickMilliseconds, token);
        }
    }

    private static async Task WaitForResumeAsync(IAudioDeck deck, Func<bool> requested, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (requested()) return;
        var resumed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void Changed() { if (requested()) resumed.TrySetResult(); }
        deck.Changed += Changed;
        try { Changed(); await resumed.Task.WaitAsync(token); }
        finally { deck.Changed -= Changed; }
    }
}
