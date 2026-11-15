using FamilyHub.Client.Core;

internal static class ListeningChecks
{
    public static int Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "familyhub-listening-" + Guid.NewGuid().ToString("N"));
        var checks = 0;
        void Check(bool result, string message) { if (!result) throw new Exception(message); checks++; }
        double clock = 0;
        var now = new DateTimeOffset(2026, 11, 15, 23, 59, 40, TimeSpan.Zero);
        ListeningJournal Open() => new(root, () => now, () => clock);
        void Advance(double seconds) { clock += seconds; now = now.AddSeconds(seconds); }
        try
        {
            var duplicateTicks = new ListeningJournal(Path.Combine(root, "duplicate-ticks"), () => now, () => clock);
            duplicateTicks.Observe("same", 0, 0, true);
            for (var tick = 1; tick <= 40; tick++)
            {
                Advance(.9); duplicateTicks.Observe("same", 0, tick - 1, true);
                Advance(.1); duplicateTicks.Observe("same", 0, tick, true);
            }
            Check(Math.Abs(duplicateTicks.Pending().Sum(r => r.Seconds) - 40) < .001, "Duplicate notifications lost listening seconds");
            now = new DateTimeOffset(2026, 11, 15, 23, 59, 40, TimeSpan.Zero); clock = 0;
            var journal = Open();
            journal.Observe("song", 0, 0, true);
            for (var n = 1; n <= 3; n++) { Advance(10); journal.Observe("song", 0, n * 10, true); }
            var batch = journal.Pending();
            Check(batch.Sum(r => r.Seconds) == 30 && batch.Sum(r => r.Plays) == 1, "Offline listening did not count one qualified play");
            Check(batch.Count == 2 && batch[0].Seconds == 20 && batch[1].Seconds == 10, "Listening crossed midnight into the wrong date");
            var loaded = Open();
            Check(loaded.DeviceId == journal.DeviceId && loaded.Pending().Sum(r => r.Seconds) == 30, "Offline listening did not survive restart");
            loaded.Observe("song", 0, 30, false);
            Advance(60); loaded.Observe("song", 0, 30, false);
            Check(loaded.Pending().Sum(r => r.Seconds) == 30, "Paused time was counted");
            loaded.Observe("song", 0, 30, true);
            Advance(1); loaded.Observe("song", 0, 100, true);
            Check(loaded.Pending().Sum(r => r.Seconds) == 30, "Seeking fabricated listening time");
            Advance(5); loaded.Observe("song", 0, 105, true);
            loaded.Acknowledge(batch);
            Check(loaded.Pending().Sum(r => r.Seconds) == 15 && loaded.Pending().Sum(r => r.Plays) == 1, "Acknowledgement lost listening recorded during the request");
            var latest = loaded.Pending(); loaded.Acknowledge(latest);
            Advance(30); loaded.InvalidateBaseline(); loaded.Observe("song", 0, 135, true);
            Check(loaded.Pending().Count == 0, "A stalled-then-seek fabricated listening or plays");
            Check(Open().Pending().Count == 0, "Acknowledged counters became pending after restart");
            Check(new ListeningJournal(root + "-other").DeviceId != loaded.DeviceId, "Journal device identity leaked across accounts");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        return checks;
    }
}
