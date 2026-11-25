using FamilyHub.App.Services;
using FamilyHub.Client.Core;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static (MusicSession Session, MusicPlayer Player) Setup()
{
    var session = new MusicSession(); var player = new MusicPlayer(session); player.Attach(new()); return (session, player);
}
var tracks = Enumerable.Range(0, 8).Select(i => new MusicTrack(i % 2 == 0 ? "duplicate" : $"id{i}", $"Occurrence {i}", "Artist")).ToList();
{
    var session = new MusicSession();
    var player = new MusicPlayer(session) { AutoDj = false };
    var audio = new WindowsAudioPlayer { LocalDuration = 145 };
    player.AttachDecks(audio, null);
    var next = tracks[3] with { Duration = 138 };
    await player.PlayAsync(tracks[1], [tracks[1], next]);
    audio.PendingSeek = new();
    var oldSeek = player.SeekAsync(144.9);
    session.Delay = true;
    audio.RaiseEnded();
    Check(player.Current == next && player.Preparing && !player.Seeking && player.Position == 0 && player.Duration == 138,
        "Seeking to the end left the next song with the old seek or duration");
    session.Complete(0);
    audio.Tick(.25);
    Check(player.Playing && player.PlaybackRequested && !player.Preparing, "Next song remained stuck preparing");
    audio.PendingSeek.SetResult();
    await oldSeek;
    Check(player.Current == next && player.Playing && player.Position == .25, "A late seek completion disturbed the next song");
}
{
    var (_, player) = Setup();
    await player.PlayAsync(tracks[1], source: "radio");
    player.ToggleShuffle();
    player.AddToQueue(tracks[3], manual: false);
    player.AddToQueue(tracks[5], manual: false);
    player.ToggleShuffle();
    Check(player.Queue.Select(track => track.Id).SequenceEqual(new[] { tracks[1].Id, tracks[3].Id, tracks[5].Id }),
        "Turning shuffle off dropped asynchronously queued radio songs");
}
{
    var (session, player) = Setup();
    var requestedAt = MusicPlayer.PlaybackTimestamp() - 30 * System.Diagnostics.Stopwatch.Frequency;
    await player.PlayAsync(tracks[0], requestedAt: requestedAt);
    var native = WindowsAudioPlayer.Last!;
    var action = session.Stages.Single(entry => entry.Stage == "play").Action;
    native.Tick(0);
    Check(!session.Stages.Contains((action, "position_advanced")), "A playing state without progress was reported as startup");
    native.Tick(2);
    Check(!session.Stages.Contains((action, "position_advanced")), "An instant segment-sized jump was reported as startup");
    await player.SeekAsync(19);
    native.Tick(0);
    Check(!session.Stages.Contains((action, "position_advanced")), "A seek was reported as startup");
    await player.SetVolumeAsync(0);
    native.Tick(.25); native.Tick(.25);
    await player.SetVolumeAsync(1);
    native.Tick(0);
    Check(!session.Stages.Contains((action, "position_advanced")), "Muted progress was reported as audible startup");
    native.Tick(.25);
    Check(session.StageTimes[(action, "play")] == 0 && session.StageTimes[(action, "position_advanced")] >= 30_000,
        "Startup timing excluded time spent before the player received the track");
}
for (var run = 0; run < 30; run++)
{
    var session = new MusicSession(); var player = new MusicPlayer(session);
    player.AttachDecks(new WindowsAudioPlayer(), new WindowsAudioPlayer());
    player.AutoDj = false; await player.PlayAsync(tracks[0], tracks); player.ToggleShuffle();
    await Task.Delay(10);
    var expected = player.Queue[player.QueueIndex + 1]; var order = player.Queue.ToArray();
    await player.SeekAsync(4); await player.SeekAsync(17); await player.SeekAsync(2);
    Check(player.Queue.SequenceEqual(order), "Seeking reshuffled Up next");
    await player.NextAsync(); Check(player.Current!.Title == expected.Title, "Next did not play the displayed Up next after seeking");
}
for (var run = 0; run < 100; run++)
{
    var (session, player) = Setup();
    await player.PlayAsync(tracks[0], tracks); player.ToggleShuffle();
    var heard = new List<MusicTrack> { player.Current! };
    for (var i = 1; i < tracks.Count; i++)
    {
        await player.NextAsync();
        Check(player.QueueIndex == i, "Next did not advance exactly one occurrence");
        Check(player.Queue.Take(i).SequenceEqual(heard), "Shuffle changed played history");
        heard.Add(player.Current!);
    }
    Check(heard.Select(t => t.Title).Order().SequenceEqual(tracks.Select(t => t.Title).Order()), "Lost or repeated a queue occurrence");
    await player.NextAsync(); Check(player.QueueIndex == tracks.Count - 1, "Queue did not stop at its end");
    player.ToggleShuffle(); await player.PlayAsync(tracks[0], tracks); await player.NextAsync();
    Check(player.Current == tracks[1], "Normal order changed");
    player.ToggleShuffle(); var before = player.Queue.ToList(); session.FailPlayback = true;
    try { await player.NextAsync(); throw new Exception("Expected playback failure"); } catch (IOException) { }
    Check(player.Queue.SequenceEqual(before) && player.QueueIndex == 1, "Failed shuffle changed queue");
    await player.SetVolumeAsync(-5); Check(player.Volume == 0 && WindowsAudioPlayer.Last!.Volume == 0, "Volume minimum");
    await player.SetVolumeAsync(8); Check(player.Volume == 1 && WindowsAudioPlayer.Last!.Volume == 1, "Volume maximum");
    await player.SetVolumeAsync(.37); Check(player.Volume == .37 && WindowsAudioPlayer.Last!.Volume == .37, "Volume forwarding");
    try { await player.SetVolumeAsync(double.NaN); throw new Exception("Accepted NaN"); } catch (ArgumentOutOfRangeException) { }
}
{
    var (session, player) = Setup(); session.Delay = true;
    var first = player.PlayAsync(tracks[0], tracks);
    Check(player.Preparing && player.PlaybackRequested && player.Current == tracks[0], "Preparing selection not visible");
    await player.ToggleAsync(); Check(!player.PlaybackRequested, "Pause intent lost during preparation");
    session.Complete(0); await first;
    Check(!player.Preparing && !player.Playing && !WindowsAudioPlayer.Last!.PlaybackRequested, "Prepared song started after pause");
    var next = player.NextAsync(); session.Complete(1); await next;
    Check(player.Current == tracks[1] && !player.Playing && !player.PlaybackRequested, "Next while paused autoplayed");
    var previous = player.PreviousAsync(); session.Complete(2); await previous;
    Check(player.Current == tracks[0] && !player.PlaybackRequested, "Previous while paused autoplayed");
    var explicitPlay = player.PlayAsync(tracks[2], tracks, 2); session.Complete(3); await explicitPlay;
    Check(player.Playing && player.PlaybackRequested, "Explicit row selection did not play");
}
{
    var (session, player) = Setup(); session.Delay = true;
    var loading = player.PlayAsync(tracks[0], tracks);
    var revision = player.UserPlaybackRevision;
    Check(player.Preparing && player.ReplaceUpcoming(tracks[0].Id, [tracks[1]]),
        "A preparing seed must accept immediate local matches");
    player.AddToQueue(tracks[3], manual: false);
    Check(player.UserPlaybackRevision == revision && player.Queue.SequenceEqual([tracks[0], tracks[1], tracks[3]]),
        "Background additions must extend the queue without changing its user revision");
    session.Complete(0);
    await loading;
    Check(player.Queue.SequenceEqual([tracks[0], tracks[1], tracks[3]]), "Preparation erased the updated queue");
}
{
    var (_, player) = Setup();
    await player.PlayAsync(tracks[0]);
    var revision = player.UserPlaybackRevision;
    WindowsAudioPlayer.Last!.RaiseEnded();
    player.AddToQueue(tracks[1], manual: false);
    await player.ContinueQueueAsync(revision);
    Check(player.Current == tracks[1] && player.PlaybackRequested && player.UserPlaybackRevision == revision,
        "A completed playlist song should advance when preparation adds the next track");
    WindowsAudioPlayer.Last!.RaiseEnded();
    await player.StopAsync();
    player.AddToQueue(tracks[2], manual: false);
    await player.ContinueQueueAsync(revision);
    Check(player.Current is null && !player.PlaybackRequested, "A stopped playlist resumed from an old follower");
}
{
    var (session, player) = Setup(); await player.PlayAsync(tracks[0], tracks); session.Delay = true;
    var next1 = player.NextAsync(); var next2 = player.NextAsync(); var previous = player.PreviousAsync();
    Check(player.QueueIndex == 1 && player.Current == tracks[1], "Rapid navigation was dropped");
    session.Complete(2); await previous;
    session.Complete(1); session.Complete(0); await Task.WhenAll(next1, next2);
    Check(player.Current == tracks[1] && WindowsAudioPlayer.Last!.Title == tracks[1].Title && player.Playing, "Old preparation replaced latest selection");
    Check(session.Messages.Count == 0 && !player.Preparing, "Stale cancellation changed latest UI");
}
{
    var (session, player) = Setup(); session.Delay = true;
    var old = player.PlayAsync(tracks[0], tracks); var latest = player.PlayAsync(tracks[1], tracks);
    session.Fail(0); await old; session.Complete(1); await latest;
    Check(player.Current == tracks[1] && session.Messages.Count == 0, "Stale error escaped");
    var stopped = player.NextAsync(); await player.StopAsync(); session.Complete(2); await stopped;
    Check(player.Current is null && !player.Preparing && !player.Playing && player.Queue.Count == 0, "Stop allowed delayed playback");
}
{
    var (session, player) = Setup(); await player.PlayAsync(tracks[0], tracks); session.Delay = true;
    var timedOut = player.NextAsync();
    session.TimeOut(0);
    try { await timedOut; throw new Exception("Playback timeout was silent"); }
    catch (InvalidOperationException error) { Check(error.Message.Contains("Try playing it again"), "Missing timeout guidance"); }
    Check(!player.Preparing && player.QueueIndex == 0 && player.Queue.SequenceEqual(tracks), "Timeout lost the previous queue");
    var retry = player.PlayAsync(tracks[1], tracks);
    session.Complete(1); await retry;
    Check(player.Playing && player.QueueIndex == 1, "Playback could not recover after a timeout");
}
{
    var (session, player) = Setup(); await player.PlayAsync(tracks[0], tracks); session.Delay = true;
    var next = player.NextAsync(); WindowsAudioPlayer.Last!.RaiseEnded();
    Check(player.QueueIndex == 1, "Old ended event advanced during preparation");
    session.Complete(0); await next;
    await player.ToggleAsync(); WindowsAudioPlayer.Last!.RaiseEnded();
    Check(player.QueueIndex == 1 && !player.PlaybackRequested, "Ended event advanced paused selection");
}
{
    var session = new MusicSession { Stream = true, CanWarmPlayback = true };
    var primary = new WindowsAudioPlayer(); var standby = new WindowsAudioPlayer();
    var player = new MusicPlayer(session) { AutoDj = false };
    player.AttachDecks(primary, standby);
    var sequence = tracks.Take(3).Select(track => track with { Saved = true }).ToArray();
    await player.PlayAsync(sequence[0], sequence);
    // Advance both clocks past the player's two-second warm-up retry.
    await Task.Delay(2100);
    primary.Tick(24);
    Check(standby.Path?.StartsWith("https://") == true && !standby.Playing, "Wi-Fi did not open only the next track");
    standby.RaiseFailed();
    Check(primary.Playing && player.Current == sequence[0], "A standby stream failure stopped current playback");
    await player.NextAsync();
    Check(player.Current == sequence[1] && primary.Path == "fixture" && player.Playing, "The failed next stream did not recover from the cache");
    Check(session.Stages.Any(entry => entry.Stage == "next_stream_failed") && session.Stages.Any(entry => entry.Stage == "fallback_playing"),
        "Next-stream recovery was not logged");
    session.CanWarmPlayback = false;
    player.PlaybackNetworkChanged();
    primary.Tick(23);
    Check(standby.Path is null, "A metered connection opened a speculative stream");
    await player.NextAsync();
    Check(primary.Path?.StartsWith("https://") == true, "A later track inherited the failed next stream's fallback");
    primary.Tick(6);
    var action = session.Stages.Last(entry => entry.Stage == "play").Action;
    primary.RaiseFailed();
    Check(player.Current == sequence[2] && primary.Path == "fixture" && primary.StartedAt == 6,
        "Current stream recovery lost the track or playhead");
    Check(session.Stages.Contains((action, "stream_failed")) && session.Stages.Contains((action, "fallback_playing")),
        "Current stream recovery lost its action correlation");
    Check(!session.Stages.Contains((action, "fallback_position_advanced")), "A restored playhead was counted as fallback startup");
    primary.Tick(.25);
    Check(session.Stages.Contains((action, "fallback_position_advanced")), "Real progress after restoring the playhead was missed");
}
{
    var session = new MusicSession { Stream = true, HomeConnection = true };
    var primary = new WindowsAudioPlayer { StreamDuration = 40 };
    var standby = new WindowsAudioPlayer();
    var player = new MusicPlayer(session) { AutoDj = false };
    player.AttachDecks(primary, standby);
    var unsaved = tracks[1];
    await player.PlayAsync(tracks[0], [tracks[0], unsaved]);
    primary.Tick(14);
    Check(session.UpcomingDownloads.Count == 0, "Unsaved audio was requested before 15 seconds");
    primary.Tick(1);
    Check(session.PrefetchRequests == 1 && session.UpcomingDownloads.Single().Track.Id == unsaved.Id
        && standby.Path == "upcoming-cache" && !standby.Playing, "Home playback did not cache the unsaved next song at 15 seconds");
    Check(session.Observations.Any(row => row.Stage == "next_warmup_start")
        && session.Observations.Any(row => row.Stage == "next_warmup_finish"), "Warm-up timing was missed");
    await player.NextAsync();
    Check(player.Playing && standby.Path == "upcoming-cache" && session.StreamRequests == 1,
        "Starting the ready next song opened another stream");
}
{
    var session = new MusicSession { Stream = true, HomeConnection = true, DataSaver = true, DelayUpcoming = true };
    var primary = new WindowsAudioPlayer { StreamDuration = 120 };
    var standby = new WindowsAudioPlayer();
    var player = new MusicPlayer(session) { AutoDj = false };
    player.AttachDecks(primary, standby);
    var saved = tracks[1] with { Saved = true };
    var replacement = tracks[3] with { Saved = true };
    await player.PlayAsync(tracks[0], [tracks[0], saved]);
    primary.Tick(15);
    Check(session.UpcomingDownloads.Count == 0, "Data saver allowed a full warm-up download on Wi-Fi");
    session.DataSaver = false;
    session.HomeConnection = false;
    player.PlaybackNetworkChanged();
    primary.Tick(10);
    Check(session.UpcomingDownloads.Count == 0, "Cellular playback downloaded the next song");
    session.HomeConnection = true;
    player.PlaybackNetworkChanged();
    var old = session.UpcomingDownloads.Single();
    Check(old.Track == saved && session.PrefetchRequests == 0, "Saved audio started acquisition");
    Check(player.ReplaceUpcoming(tracks[0].Id, [replacement]), "The replacement queue was rejected");
    Check(old.Token.IsCancellationRequested && session.UpcomingDownloads.Count == 2
        && session.UpcomingDownloads[1].Track == replacement, "Changing the queue kept downloading the old song");
    var pending = session.UpcomingDownloads[1];
    await player.ToggleAsync();
    Check(pending.Token.IsCancellationRequested && standby.Path is null, "Pausing left a speculative download active");
}
{
    var session = new MusicSession { Stream = true, HomeConnection = true, CanWarmPlayback = true, CacheFreeBytes = 0 };
    var primary = new WindowsAudioPlayer { StreamDuration = 120 };
    var standby = new WindowsAudioPlayer();
    var player = new MusicPlayer(session) { AutoDj = false };
    player.AttachDecks(primary, standby);
    var saved = tracks[1] with { Saved = true };
    await player.PlayAsync(tracks[0], [tracks[0], saved]);
    Check(session.UpcomingDownloads.Single().Track == saved && standby.Path is null
        && session.Observations.Any(row => row.Stage == "next_warmup_failed"), "A saved song bypassed the cache limit");
    primary.Tick(113);
    Check(session.UpcomingDownloads.Count == 1 && standby.Path?.StartsWith("https://") == true,
        "A full cache prevented conservative stream preparation");
}
{
    var session = new MusicSession { Stream = true };
    var primary = new WindowsAudioPlayer { LocalDuration = 180 };
    var player = new MusicPlayer(session);
    player.AttachDecks(primary, null);
    var preview = tracks[0] with { Duration = 180, PlaybackVersion = "preview-hls" };
    await player.PlayAsync(preview, [preview, tracks[1]]);
    primary.Tick(30);
    player.UiActive = false;
    primary.RaiseEnded();
    Check(player.Current?.Id == preview.Id && primary.Path == "fixture" && primary.StartedAt == 30,
        "An early preview end advanced the queue or restarted at zero");
    primary.Tick(2);
    primary.RaiseFailed(resetPosition: true);
    Check(!player.PlaybackRequested && player.CaptureResume()?.Position == 32,
        "A terminal playback failure lost the last position");
    var attempt = session.Stages.First(entry => entry.Stage == "play").Action;
    Check(session.Observations.Contains((attempt, "background", 30)) &&
        session.Observations.Contains((attempt, "early_end", 30)) &&
        session.Observations.Contains((attempt, "interrupted", 32)),
        "Playback diagnostics lost the background, early end or terminal interruption position");
    session.Stream = false;
    await player.ToggleAsync();
    Check(player.Current?.Id == preview.Id && primary.StartedAt == 32,
        "Play after a terminal failure restarted the song at zero");
}
{
    var session = new MusicSession();
    var primary = new WindowsAudioPlayer { LocalDuration = 180 };
    var player = new MusicPlayer(session);
    player.AttachDecks(primary, null);
    await player.PlayAsync(tracks[0] with { Duration = 180 });
    primary.Tick(35);
    primary.SuspendWithoutFailure();
    Check(player.PlaybackInterrupted, "An unexpected native stop was mistaken for user pause");
    primary.IgnoreNextSeek = true;
    await player.SetTransportPlayingAsync(true);
    Check(!player.Playing && primary.StartedAt is null && player.CaptureResume()?.Position == 35,
        "An unconfirmed native seek started playback or discarded the checkpoint");
    var failed = session.Stages.Last(entry => entry.Stage == "play").Action;
    Check(session.Observations.Contains((failed, "resume_seek", 35)) &&
        session.Observations.Contains((failed, "resume_failed", 35)), "Resume telemetry lost the failed checkpoint");
    await player.SetTransportPlayingAsync(true);
    await player.SetTransportPlayingAsync(true);
    Check(player.Playing && primary.StartedAt == 35,
        "Play after an unconfirmed native seek restarted at zero");
    var retried = session.Stages.Last(entry => entry.Stage == "play").Action;
    Check(session.Observations.Contains((retried, "resume_applied", 35)), "Resume telemetry lost the confirmed position");
    primary.Tick(1);
    await player.SetTransportPlayingAsync(false);
    await player.SetTransportPlayingAsync(false);
    Check(!player.PlaybackRequested && player.Position == 36, "Duplicate Pause restarted playback or lost a deliberate pause");
    await player.SetTransportPlayingAsync(true);
    Check(player.Playing && player.Position == 36, "Play from deliberate pause reloaded the source");
    primary.SuspendWithoutFailure();
    await player.SetTransportPlayingAsync(false);
    Check(!player.PlaybackRequested && !player.Playing && player.CaptureResume()?.Position == 36,
        "Explicit Pause after an interruption restarted playback or lost its checkpoint");
}
{
    var (session, player) = Setup();
    await player.PlayAsync(tracks[0]);
    var primary = WindowsAudioPlayer.Last!;
    primary.Tick(.25);
    primary.Tick(29.707);
    primary.SuspendWithoutFailure();
    Check(!player.PlaybackInterrupted && !session.Observations.Any(row => row.Stage == "unexpected_pause"),
        "A position 43 ms before the natural end was reported as an unexpected pause");
}
{
    var (session, player) = Setup();
    await player.PlayAsync(tracks[0], tracks);
    var native = WindowsAudioPlayer.Last!;
    native.Seek(20);
    Check(session.Listened.Count == 0, "Seeking counted as listening history");
    for (var i = 0; i < 29; i++) native.Tick(.5);
    Check(session.Listened.Count == 0, "Short preview counted as listening history");
    native.Tick(.5);
    Check(session.Listened.SequenceEqual(new[] { tracks[0].Id }), "Meaningful listening was not recorded");
    native.Tick(.5);
    Check(session.Listened.Count == 1, "Repeated position events duplicated listening history");
    await player.NextAsync();
    for (var i = 0; i < 30; i++) native.Tick(.5);
    Check(session.Listened.Count == 2, "Listening history did not reset for the next selection");
}

{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    await player.PlayAsync(tracks[0], tracks); player.AddToQueue(tracks[5]); player.AddToQueue(tracks[7]);
    Check(player.Queue[1].Id == tracks[5].Id && player.Queue[2].Id == tracks[7].Id, "Manual queue did not take FIFO priority");
    var count = player.Queue.Count; player.AddToQueue(tracks[5]); Check(player.Queue.Count == count, "Repeated queue click duplicated a pending entry");
    player.AddToQueue([tracks[3], tracks[4]], playNext: false);
    Check(player.Queue.Skip(1).Take(4).Select(t => t.Id).SequenceEqual(new[] { tracks[5].Id, tracks[7].Id, tracks[3].Id, tracks[4].Id }),
        "Playlist append changed manual queue order");
    player.AddToQueue([tracks[4], tracks[6], tracks[1]], playNext: true);
    Check(player.Current?.Title == tracks[0].Title && player.Queue.Skip(1).Take(3).Select(t => t.Title)
        .SequenceEqual(new[] { tracks[4].Title, tracks[1].Title, tracks[5].Title }), "Play next did not insert the playlist ahead of the queue");
    await player.StopAsync();
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    await player.PlayAsync(tracks[0], tracks); session.Delay = true;
    player.AddToQueue(tracks[7]); primary.Tick(24);
    Check(player.Queue[1].Id == tracks[1].Id && player.Queue[2].Id == tracks[7].Id, "Unready queued song discarded the prepared fallback");
    Check(session.DownloadRequests == 0, "Preparing a queued song started a speculative full download");
    await player.StopAsync();
    Check(player.Current is null && !primary.Playing && !secondary.Playing, "Stopping a fade left a deck audible");
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    var preview = tracks[1] with { PlaybackVersion = "preview-hls" };
    await player.PlayAsync(preview, [preview, tracks[3]]);
    for (var tick = 0; tick < 24; tick++) primary.Tick(1);
    await Task.Delay(30);
    Check(!secondary.Playing && player.Current == preview, "Growing preview began a crossfade");
    await player.NextAsync();
    Check(player.Current?.Id == tracks[3].Id, "Preview prevented the next-track handoff");
    Check(session.Events.Count == 1, "Preview recorded duplicate listening events");
    await player.StopAsync();
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    var preview = tracks[3] with { PlaybackVersion = "preview-hls" };
    await player.PlayAsync(tracks[1], [tracks[1], preview]);
    for (var tick = 0; tick < 24; tick++) primary.Tick(1);
    await Task.Delay(30);
    Check(!secondary.Playing && player.Current?.Id == tracks[1].Id, "Player crossfaded into a growing preview");
    await player.NextAsync();
    Check(player.Current?.PlaybackVersion == "preview-hls", "Manual next failed to enter a preview");
    Check(session.Events.Count == 1, "Entering a preview duplicated listening history");
    await player.StopAsync();
}
Check(CrossfadeEnvelope.Duration(180) == 6 && CrossfadeEnvelope.Duration(12) == 4, "Old transition duration rules changed");
Check(CrossfadeEnvelope.Duration(180, 12) == 12 && CrossfadeEnvelope.Duration(180, 0) == 0 && CrossfadeEnvelope.Duration(30, 12) == 10 && CrossfadeEnvelope.Duration(180, 40) == 12, "Crossfade setting is not applied within 0-12 s and a third of the song");
Check(CrossfadeEnvelope.Fraction(3, 0, 6) == .5, "Old transition linear curve changed");
Check(Math.Abs(CrossfadeEnvelope.Smooth(0, 1, .015) - (1 - Math.Exp(-1))) < .000001, "Old transition 15 ms smoothing changed");
{
    var outgoing = new WindowsAudioPlayer(); var incoming = new WindowsAudioPlayer();
    outgoing.PlayFile("fixture", "Outgoing", "Artist"); incoming.PlayFile("fixture", "Incoming", "Artist", false);
    var gains = new List<double>(); var requested = true;
    using var cancellation = new CancellationTokenSource(3000);
    var ticker = Task.Run(async () => { while (!cancellation.IsCancellationRequested) { if (incoming.Playing) incoming.Tick(.01); if (outgoing.Playing) outgoing.Tick(.01); await Task.Delay(10); } });
    var fade = DeckCrossfade.RunAsync(outgoing, incoming, .2, () => requested, gain => gains.Add(gain), cancellation.Token);
    await Task.Delay(80); requested = false; outgoing.SetPlaying(false); incoming.SetPlaying(false);
    await Task.Delay(50); var pausedCount = gains.Count; var refreshes = incoming.Refreshes; await Task.Delay(60);
    Check(!fade.IsCompleted && gains.Count == pausedCount && incoming.Refreshes == refreshes, "Paused crossfade kept polling the decks");
    requested = true; outgoing.SetPlaying(true); incoming.SetPlaying(true); await fade;
    Check(gains[^1] == 1 && gains.All(g => g is >= 0 and <= 1), "Crossfade did not complete its media-time gain ramp");
    cancellation.Cancel(); await ticker; outgoing.Stop(); incoming.Stop();
}
{
    var (session, player) = Setup();
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -8, TruePeak = -1 }, "normal") == -6, "Loud master target incorrect");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -30, TruePeak = -20 }, "normal") == 6, "Quiet gain exceeded +6 dB");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -24, TruePeak = -3 }, "normal") == 2, "Quiet gain exceeded peak limit");
    var hot = tracks[0] with { Lufs = -14, TruePeak = 4 };
    Check(MusicPlayer.NormalizationGainDb(hot, "normal") == -5, "Hot peak must reach -1 dBFS even at target loudness");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { PlaybackGainDb = -8 }, "normal") == 0, "Unknown loudness must use unity gain");
    Check(MusicPlayer.NormalizationGainDb(hot with { TruePeak = double.NaN }, "normal") == 0, "Invalid peak must use unity gain");
    Check(MusicPlayer.NormalizationGainDb(hot, "normal", enabled: false) == 0, "Disabled normalization must use unity gain");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -14, TruePeak = -8 }, "quiet") == -5, "Quiet target incorrect");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -14, TruePeak = -8 }, "loud") == 3, "Loud target incorrect");
    var loud = tracks[0] with { Lufs = -8, TruePeak = -1 };
    await player.PlayAsync(loud, tracks.Prepend(loud));
    Check(Math.Abs(WindowsAudioPlayer.Last!.Volume - Math.Pow(10, -.3)) < .00001, "Measured loudness attenuation missing");
    var current = player.Current;
    Check(player.ReplaceUpcoming(current!.Id, [tracks[3], tracks[5]]), "Recommendations not queued");
    Check(player.Current == current && player.Playing && player.Queue.Skip(player.QueueIndex + 1).SequenceEqual(new[] { tracks[3], tracks[5] }), "Recommendations changed current playback or retained old queue");
    Check(!player.ReplaceUpcoming("old seed", [tracks[7]]), "Stale recommendation replaced queue");
    var retained = player.Queue.ToArray();
    Check(!player.ReplaceUpcoming(current.Id, []), "Empty recommendations were accepted");
    Check(!player.ReplaceUpcoming(current.Id, [current]), "Seed-only radio was accepted");
    Check(player.Queue.SequenceEqual(retained) && player.Current == current && player.Playing,
        "Empty or seed-only recommendations changed playback or cleared the queue");
    await player.NextAsync(); Check(WindowsAudioPlayer.Last.Volume == 1, "Loudness gain leaked between songs");
    await player.PlayAsync(tracks[0] with { Lufs = -30, TruePeak = -20 });
    Check(WindowsAudioPlayer.Last.Volume == 1, "Native gain exceeded unity");
    await player.SetVolumeAsync(.5);
    Check(Math.Abs(WindowsAudioPlayer.Last.Volume - .5 * Math.Pow(10, .3)) < .00001, "Quiet song did not use available gain");
    session.PlaybackPreferences = new() { VolumeLevel = "quiet" };
    var quiet = tracks[1] with { Lufs = -14, TruePeak = -8 };
    await player.PlayAsync(quiet, [quiet, tracks[3]]);
    Check(Math.Abs(WindowsAudioPlayer.Last.Volume - .5 * Math.Pow(10, -.25)) < .00001, "Volume level ignored");
    await player.SetEvenSongVolumeAsync(false);
    Check(WindowsAudioPlayer.Last.Volume == .5, "Device toggle did not restore the current deck volume");
    await player.SetEvenSongVolumeAsync(true);
    await player.NextAsync();
    Check(WindowsAudioPlayer.Last.Volume == .5, "Measured gain leaked between songs");
    await player.SetVolumeAsync(0); Check(WindowsAudioPlayer.Last.Volume == 0, "Normalization overrode mute");
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    var a = tracks[1] with { Lufs = -5, TruePeak = 4 }; var b = tracks[3] with { Lufs = -12, TruePeak = -3 };
    player.UiActive = false;
    var notifications = new List<string?>();
    player.Changed += () => notifications.Add(player.NotificationPlayback.Track?.Id);
    await player.PlayAsync(a, [a, b]); primary.Tick(24); secondary.Tick(.1); await Task.Delay(90);
    Check(player.NotificationPlayback.Track?.Id == a.Id, "Preloading published the incoming song too early");
    secondary.Tick(3.5); await Task.Delay(90);
    var shown = player.NotificationPlayback;
    Check(player.Crossfading && shown.Track?.Id == b.Id && shown.Position == secondary.Position
        && shown.Duration == secondary.Duration && shown.Playing && notifications.Last() == b.Id,
        "Background crossfade retained the outgoing notification or mixed positions across songs");
    var left = Math.Pow(10, -9.0 / 20); var right = Math.Pow(10, -2.0 / 20);
    Check(primary.Volume < left && secondary.Volume > 0 && secondary.Volume <= right, "Crossfade ignored each song's normalization");
    Check(Math.Abs(primary.Volume / left + secondary.Volume / right - 1) < .00001, "Normalization changed linear fade envelope");
    await player.SetEvenSongVolumeAsync(false);
    Check(Math.Abs(primary.Volume + secondary.Volume - 1) < .00001, "Device toggle did not update both crossfading decks");
    await player.SetEvenSongVolumeAsync(true);
    secondary.Tick(4); await Task.Delay(90);
    Check(player.Current?.Id == b.Id && Math.Abs(secondary.Volume - right) < .00001, "Normalization lost at deck handoff");
    Check(player.NotificationPlayback.Track?.Id == b.Id && player.NotificationPlayback.CanSeek,
        "Notification reverted to the outgoing deck after the crossfade");
    await player.StopAsync();
}
{
    var session = new MusicSession();
    var primary = new WindowsAudioPlayer();
    var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session) { UiActive = false };
    player.AttachDecks(primary, secondary);
    await player.PlayAsync(tracks[1], [tracks[1], tracks[3]]);
    primary.Tick(24);
    secondary.Tick(.1);
    await Task.Delay(90);
    secondary.Tick(4);
    await Task.Delay(90);
    Check(player.NotificationPlayback.Track?.Id == tracks[3].Id, "Incoming notification never appeared");
    secondary.RaiseFailed();
    await Task.Delay(90);
    Check(!player.Crossfading && player.NotificationPlayback.Track?.Id == tracks[1].Id
        && player.NotificationPlayback.Position == primary.Position, "Failed mix left the wrong song on Android controls");
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session) { AutoDj = false }; player.AttachDecks(primary, secondary);
    await player.PlayAsync(tracks[1], [tracks[1], tracks[3]]);
    await Task.Delay(20); primary.Tick(26);
    Check(!player.Crossfading && !secondary.Playing && primary.Volume == 1, "Auto DJ off still crossfades");
    primary.Tick(4); primary.RaiseEnded(); await Task.Delay(20);
    Check(player.Current?.Id == tracks[3].Id && player.Playing, "Auto DJ off stopped normal queue advancement");
}
{
    var (_, player) = Setup(); player.FollowingHost = true;
    var sequence = new[] { tracks[1] with { Lufs = -14, TruePeak = 4 }, tracks[3] with { Lufs = -8, TruePeak = -1 } };
    await player.SynchronizeHostAsync(sequence, 0, 12, true, false, false);
    Check(!player.Playing, "Guest started before receiving a fresh position after preparation");
    await player.SynchronizeHostAsync(sequence, 0, 14, true, false, false);
    Check(player.Position == 14 && player.Playing && !player.AutoDj, "Guest did not synchronize position or Auto DJ");
    Check(Math.Abs(WindowsAudioPlayer.Last!.Volume - Math.Pow(10, -.25)) < .00001, "Guest deck ignored peak protection");
    await player.SetEvenSongVolumeAsync(false);
    await player.PauseLocallyAsync();
    Check(!player.Playing && player.FollowingHost && player.Current is not null, "Local pause left or cleared the session");
    await player.SynchronizeHostAsync(sequence, 0, 15, true, false, false);
    Check(player.Playing && player.Position == 15, "Local resume did not align to host");
    await player.SynchronizeHostAsync(sequence, 0, 16, false, false, false);
    Check(player.Position == 16 && !player.Playing, "Host pause did not reach guest");
    try { await player.NextAsync(); throw new Exception("Guest controlled queue"); } catch (InvalidOperationException) { }
    try { player.AddToQueue(tracks[5]); throw new Exception("Guest edited queue"); } catch (InvalidOperationException) { }
    await player.SynchronizeHostAsync(sequence, 1, 2, true, true, false);
    await player.SynchronizeHostAsync(sequence, 1, 3, true, true, false);
    Check(player.QueueIndex == 1 && player.Position == 3 && player.AutoDj, "Host skip did not reach guest");
    Check(WindowsAudioPlayer.Last!.Volume == 1, "Guest's local toggle did not survive a host track change");
}
{
    var (_, player) = Setup(); player.FollowingHost = true;
    var sequence = new[] { tracks[1] };
    await player.SynchronizeHostAsync(sequence, 0, 1, true, false, false);
    await player.SynchronizeHostAsync(sequence, 0, 1, true, false, false);
    var audio = WindowsAudioPlayer.Last!;
    var seeks = audio.Seeks;
    await player.SynchronizeHostAsync(sequence, 0, 4, true, false, false);
    Check(audio.Seeks == seeks, "One delayed timing sample caused a hard seek");
    var hostPosition = 1.3;
    for (var i = 0; i < 100; i++)
    {
        audio.Tick(.2); hostPosition += .2;
        await player.SynchronizeHostAsync(sequence, 0, hostPosition, true, false, false);
        Check(audio.PlaybackRate is >= .985 and <= 1.015, "Drift correction exceeded the speed limit");
    }
    Check(audio.Seeks == seeks && Math.Abs(player.Position - hostPosition) < .2, "Small drift did not converge without seeking");
    await player.SynchronizeHostAsync(sequence, 0, 5, true, false, false, controlRevision: 1);
    Check(player.Position == 5 && audio.PlaybackRate == 1, "Explicit host replay did not seek immediately");
    await player.SynchronizeHostAsync(sequence, 0, 5.2, false, false, false, controlRevision: 2);
    Check(!player.Playing && player.Position == 5.2, "Pause did not align silently");
    await player.SynchronizeHostAsync(sequence, 0, 5.2, true, false, false, controlRevision: 3);
    Check(player.Playing && audio.PlaybackRate == 1, "Resume retained drift correction");
    for (var i = 0; i < 3; i++) await player.SynchronizeHostAsync(sequence, 0, 10, true, false, false, controlRevision: 3);
    Check(player.Position == 10, "Sustained large drift did not recover");
}
{
    var (_, player) = Setup();
    var savedTracks = new[] { new MusicTrack("abcdefghijk", "First", "Artist"), new MusicTrack("lmnopqrstuv", "Second", "Artist") };
    player.RestoreResume(new() { TrackIds = savedTracks.Select(t => t.Id).ToList(), Index = 1, Position = 12 }, savedTracks);
    Check(player.Current?.Id == "lmnopqrstuv" && player.QueueIndex == 1 && player.Position == 12 && !player.PlaybackRequested, "Resume lost song, queue, position or paused state");
    Check(WindowsAudioPlayer.Last!.Title is null, "Paused resume loaded audio before Play");
    player.RestoreResume(new() { TrackIds = savedTracks.Select(t => t.Id).ToList(), Index = 1, Position = 18 }, savedTracks);
    Check(player.Position == 18 && !player.PlaybackRequested, "Newer server checkpoint did not replace paused metadata");
    Check(player.CanSeek, "Paused restored track cannot be scrubbed");
    await player.SeekAsync(24);
    Check(player.Position == 24 && !player.PlaybackRequested && WindowsAudioPlayer.Last!.Title is null, "Scrubbing paused resume loaded or started audio");
    await player.ToggleAsync();
    Check(player.Playing && Math.Abs(player.Position - 24) < .01, "Play did not seek to saved position");
    var state = player.CaptureResume();
    Check(state?.Index == 1 && state.TrackIds.SequenceEqual(savedTracks.Select(t => t.Id)), "Resume capture changed queue order");
}
{
    var (session, player) = Setup(); player.AutoDj = false; player.RepeatMode = "one";
    await player.PlayAsync(tracks[0], tracks); WindowsAudioPlayer.Last!.Tick(30); WindowsAudioPlayer.Last.RaiseEnded(); await Task.Yield();
    Check(player.Current == tracks[0] && player.QueueIndex == 0 && player.Playing && player.Position == 0, "Repeat one did not restart the completed song");
    await player.NextAsync(); Check(player.Current == tracks[1], "Repeat one blocked explicit Next");
    player.RepeatMode = "all"; await player.PlayAsync(tracks[^1], tracks, tracks.Count - 1); WindowsAudioPlayer.Last!.RaiseEnded(); await Task.Yield();
    Check(player.QueueIndex == 0 && player.Playing, "Repeat all did not wrap the queue");
    player.RepeatMode = "off"; await player.PlayAsync(tracks[^1], tracks, tracks.Count - 1); WindowsAudioPlayer.Last!.RaiseEnded(); await Task.Yield();
    Check(!player.PlaybackRequested, "Repeat off did not stop at the end");
}
{
    var session = new MusicSession(); var player = new MusicPlayer(session);
    var currentDeck = new WindowsAudioPlayer(); var nextDeck = new WindowsAudioPlayer();
    player.AttachDecks(currentDeck, nextDeck); player.RepeatMode = "one";
    await player.PlayAsync(tracks[0], tracks);
    session.FailPlayback = true; player.RepeatMode = "off";
    Check(nextDeck.Title is null, "Failed preparation unexpectedly loaded the standby deck");
    session.FailPlayback = false; await Task.Delay(10200); currentDeck.Tick(1);
    Check(nextDeck.Title == tracks[1].Title, "Failed upcoming preparation was never retried");
}
{
    var session = new MusicSession(); var player = new MusicPlayer(session);
    var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer(); player.AttachDecks(primary, secondary);
    player.RestoreResume(new() { TrackIds = [tracks[1].Id], Index = 0, Position = 7 }, tracks);
    Check(session.LocalPlays == 0 && !player.Playing, "Restoring startup state activated playback");
    await player.ToggleAsync();
    Check(session.LocalPlays == 1 && player.Playing, "Local resume did not activate playback");
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel", Playing = true, Position = 12,
        Track = new() { Id = tracks[1].Id } }, tracks, () => Task.FromResult(true));
    Check(!player.Playing && !player.PlaybackRequested && player.RemoteActive && player.RemoteDeviceName == "Pixel" && player.RemotePlaying,
        "Automatic pause did not enter remote mode");
    Check(player.Queue.Count == 1 && player.Current?.Id == tracks[1].Id && player.Position >= 12 && session.LocalPlays == 1,
        "Remote handover changed queue, lost position or echoed activation");
    var renders = 0; var seekRenders = 0;
    player.Changed += () => renders++;
    player.RemotePositionChanged += () => seekRenders++;
    player.RemoteTick();
    Check(player.CaptureResume() is null && renders == 0 && seekRenders == 1,
        "Controller tick captured a checkpoint or redrew other player controls");
    await player.ToggleAsync();
    Check(player.RemoteActive && !player.RemotePlaying && !player.Playing && session.LocalPlays == 1,
        "Pausing the remote player took playback back or echoed a local activation");
    player.ApplyRemoteState(tracks[1].Id, true, 13);
    Check(!player.RemotePlaying, "An earlier device poll replaced the pending pause");
    player.RemoteTick(); player.ApplyRemoteState(tracks[1].Id, false, 14);
    Check(session.LocalPlays == 1, "Following remote state activated local playback");
    var confirmResume = new TaskCompletionSource<bool>();
    var resumeAttempts = 0;
    player.ResumeRemoteHere = async target =>
    {
        Check(target == new string('b', 32), "Play requested a move from the wrong device");
        resumeAttempts++;
        var resume = new PlaybackHandover { Action = "play", Playing = true,
            Resume = new() { TrackIds = [tracks[1].Id], Index = 0, Position = 14 } };
        return await player.ApplyPlaybackCommandAsync(resume, tracks, () => confirmResume.Task) ? null : "Move failed";
    };
    var pendingResume = player.ToggleAsync();
    await player.ToggleAsync();
    Check(player.RemoteActive && !player.Playing && session.LocalPlays == 1 && resumeAttempts == 1,
        "Resuming locally before confirmation lost remote ownership or started a duplicate handoff");
    confirmResume.SetResult(false);
    await pendingResume;
    Check(player.RemoteActive && !player.Playing, "A failed resume dropped the remote controls");
    confirmResume = new();
    pendingResume = player.ToggleAsync();
    confirmResume.SetResult(true);
    await pendingResume;
    Check(!player.RemoteActive && player.Playing && Math.Abs(player.Position - 14) < .01 && session.LocalPlays == 1,
        "Confirmed Play did not resume locally from the remote checkpoint");
    await player.ApplyRemoteControlAsync(new() { Action = "pause" });
    await player.ApplyRemoteControlAsync(new() { Action = "play" });
    Check(player.Playing && session.LocalPlays == 1, "Remote play echoed a local activation");
    await player.PauseLocallyAsync(); secondary.SetPlaying(true);
    Check(player.PlaybackRequested && session.LocalPlays == 2, "Native transport play did not activate playback");
    var takeover = new PlaybackHandover { Id = "takeover", Action = "play", Resume = new() { TrackIds = [tracks[3].Id], Index = 0, Position = 8 }, Playing = true };
    var applied = await player.ApplyPlaybackCommandAsync(takeover, tracks, () => Task.FromResult(true));
    Check(applied && player.Current == tracks[3] && player.Playing && player.Position == 8 && primary.StartedAt == 8 && session.LocalPlays == 2,
        "Manual transfer echoed a local activation or lost its checkpoint");
    player.EnterRemote(new string('b', 32), "Pixel", 9, true);
    var paused = takeover with { Id = "paused-takeover", Playing = false };
    var ready = new TaskCompletionSource<bool>();
    secondary.HoldOpening = true;
    var staged = player.ApplyPlaybackCommandAsync(paused, tracks, () => ready.Task);
    Check(!staged.IsCompleted && player.ReportingHandoff is null && player.RemoteActive, "Opening deck was reported as loaded");
    secondary.HoldOpening = false;
    for (var i = 0; i < 100 && player.ReportingHandoff is null; i++) await Task.Delay(10);
    Check(!staged.IsCompleted && player.RemoteActive && secondary.Title == tracks[3].Title && secondary.Position == 8
        && !secondary.Playing && secondary.StartedAt is null && player.ReportingHandoff?.Deck == secondary,
        "Paused receiver must load and seek silently before confirmation");
    ready.SetResult(false);
    Check(!await staged && player.RemoteActive && player.RemoteDeviceName == "Pixel" && secondary.Title is null,
        "Failed handoff changed the output or left its staged recording loaded");
    applied = await player.ApplyPlaybackCommandAsync(paused with { Id = "confirmed" }, tracks, () => Task.FromResult(true));
    Check(applied && !player.RemoteActive && !player.Playing && player.Current == tracks[3] && player.Position == 8 && secondary.StartedAt is null,
        "Confirmed paused takeover lost the checkpoint or started playback");
    player.EnterRemote(new string('b', 32), "Pixel", 9, true);
    await player.PlayAsync(tracks[5], tracks);
    Check(!player.RemoteActive && player.Playing && session.LocalPlays == 3, "Choosing a song did not take playback back");
    var activations = session.LocalPlays;
    secondary.RaiseEnded(); await Task.Yield();
    Check(session.LocalPlays == activations, "Automatic queue advancement activated playback");
}
{
    var sourceSession = new MusicSession(); var targetSession = new MusicSession { DeviceId = new string('b', 32) };
    var source = new MusicPlayer(sourceSession) { AutoDj = false };
    var target = new MusicPlayer(targetSession) { AutoDj = false };
    var sourcePrimary = new WindowsAudioPlayer(); var sourceSecondary = new WindowsAudioPlayer();
    var targetPrimary = new WindowsAudioPlayer(); var targetSecondary = new WindowsAudioPlayer();
    source.AttachDecks(sourcePrimary, sourceSecondary); target.AttachDecks(targetPrimary, targetSecondary);
    MusicTrack[] list = [new("abcdefghijk", "Previous", "Artist"), new("lmnopqrstuv", "Current", "Artist"),
        new("wxyzABCDEFG", "Next", "Artist"), new("HIJKLMNOPQR", "Last", "Artist")];
    source.ToggleShuffle(); source.RepeatMode = "all"; target.RepeatMode = "one";
    await source.PlayAsync(list[1], list, 1);
    sourcePrimary.Tick(12);
    var resume = source.CaptureResume()!;
    var ids = resume.TrackIds;
    var first = new PlaybackHandover { Id = "forward", Action = "play", Resume = resume, Playing = true };
    var ready = new TaskCompletionSource<bool>();
    var started = target.ApplyPlaybackCommandAsync(first, [list[1]], () => ready.Task);
    Check(target.ReportingHandoff?.Queue.Select(track => track.Id).SequenceEqual(ids) == true && source.Playing && !target.Playing,
        "Receiver dropped queue entries missing from its library while staging playback");
    ready.SetResult(true);
    Check(await started, "Receiver could not load the handoff");
    Check(target.Playing && target.Position == 12 && target.QueueIndex == 1 && target.Queue.Select(track => track.Id).SequenceEqual(ids)
        && target.Shuffle && target.RepeatMode == "all" && target.Autoplay,
        "Receiver lost the queue, index, playhead or playback modes");
    await source.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = targetSession.DeviceId, Playing = true }, list, () => Task.FromResult(true));
    source.UiActive = target.UiActive = false;
    (targetPrimary.Playing ? targetPrimary : targetSecondary).RaiseEnded(); await Task.Yield();
    Check(target.Playing && target.Current?.Id == ids[2] && target.QueueIndex == 2 && targetSession.LocalPlays == 0
        && target.Current.Url == "https://www.youtube.com/watch?v=" + ids[2],
        "The receiving deck did not advance locally while the sender was idle");
    Check(source.RemoteActive && !source.Playing && source.Queue.Select(track => track.Id).SequenceEqual(ids),
        "The sender lost its queue while following the receiver");
    (targetPrimary.Playing ? targetPrimary : targetSecondary).Tick(5);
    var second = first with { Id = "return", Resume = target.CaptureResume() };
    Check(await source.ApplyPlaybackCommandAsync(second, list, () => Task.FromResult(true)), "Original device could not take playback back");
    await target.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = sourceSession.DeviceId, Playing = true }, list, () => Task.FromResult(true));
    Check(source.Playing && source.Position == 5 && source.QueueIndex == 2 && source.Queue.Select(track => track.Id).SequenceEqual(ids),
        "Returning playback lost the receiver's song, position or queue");
    (sourcePrimary.Playing ? sourcePrimary : sourceSecondary).RaiseEnded(); await Task.Yield();
    Check(source.Playing && source.Current?.Id == ids[3], "Original device did not advance after taking playback back");
    (sourcePrimary.Playing ? sourcePrimary : sourceSecondary).RaiseEnded(); await Task.Yield();
    Check(source.Playing && source.Current?.Id == ids[0], "Repeat all was lost after taking playback back");

    ready = new();
    var third = first with { Id = "near-end", Resume = source.CaptureResume()! with { Position = 29 } };
    started = target.ApplyPlaybackCommandAsync(third, list, () => ready.Task);
    Check(target.ReportingHandoff is not null, "Receiver did not stage the recording returning at its end");
    ((WindowsAudioPlayer)target.ReportingHandoff!.Deck).RaiseEnded();
    ready.SetResult(true);
    Check(await started && target.Playing && target.Current?.Id == ids[1] && target.QueueIndex == 1,
        "Receiver lost the end of the song while waiting for confirmation");

    var stopped = first with { Id = "autoplay-off", Resume = third.Resume! with { Autoplay = false } };
    Check(await target.ApplyPlaybackCommandAsync(stopped, list, () => Task.FromResult(true)), "Receiver could not load the autoplay-off handoff");
    (targetPrimary.Playing ? targetPrimary : targetSecondary).RaiseEnded(); await Task.Yield();
    Check(!target.Playing && !target.Autoplay && target.Current?.Id == ids[0] && target.Queue.Count == ids.Count,
        "Receiver ignored autoplay off or discarded the queue at the end");

    var missingUpload = first with { Id = "missing-upload", Resume = resume with { TrackIds = [ids[0], ids[1], "local-0123456789abcdef"] } };
    Check(!await target.ApplyPlaybackCommandAsync(missingUpload, list, () => throw new Exception("Receiver confirmed without its next local upload")),
        "Receiver accepted a handoff that would lose a local upload");
    Check(!target.Playing && target.Current?.Id == ids[0] && target.Queue.Select(track => track.Id).SequenceEqual(ids),
        "Failed local upload handoff changed existing playback");
}
{
    var session = new MusicSession { Delay = true }; var player = new MusicPlayer(session); player.Attach(new(), new());
    var takeover = player.ApplyPlaybackCommandAsync(new() { Id = "superseded-takeover", Action = "play", Playing = true,
        Resume = new() { TrackIds = [tracks[1].Id], Index = 0, Position = 8 } }, tracks, () => Task.FromResult(true));
    Check(!takeover.IsCompleted, "Takeover reported success before playback was prepared");
    await player.StopAsync();
    session.Complete(0);
    Check(!await takeover, "Superseded takeover reported success");
}
{
    var (session, player) = Setup(); session.Delay = true;
    var loading = player.PlayAsync(tracks[1], tracks);
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel", Playing = true }, tracks, () => Task.FromResult(true));
    session.Complete(0); await loading;
    Check(player.RemoteActive && !player.Playing && !player.PlaybackRequested && !player.Preparing && session.LocalPlays == 1,
        "Preparation restarted local playback after an automatic pause");
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    await player.PlayAsync(tracks[1], [tracks[1], tracks[3]]); primary.Tick(26); await Task.Delay(60);
    Check(player.Crossfading && secondary.Playing, "Fixture did not start its crossfade");
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel", Playing = true }, tracks, () => Task.FromResult(true));
    Check(!primary.Playing && !secondary.Playing && !player.Crossfading && player.RemoteActive,
        "Automatic pause left a crossfade deck playing");
}
{
    var (session, player) = Setup(); player.FollowingHost = true;
    await player.SynchronizeHostAsync([tracks[1]], 0, 2, true, false, false);
    await player.SynchronizeHostAsync([tracks[1]], 0, 3, true, false, false);
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel" }, tracks, () => Task.FromResult(true));
    await player.ApplyRemoteControlAsync(new() { Action = "pause" });
    Check(player.Playing && !player.RemoteActive && session.LocalPlays == 0, "Profile arbitration interrupted a Listen Together follower");
}
{
    var (session, player) = Setup(); player.AutoDj = false;
    await player.PlayAsync(tracks[0], tracks, source: "search");
    var native = WindowsAudioPlayer.Last!;
    for (var i = 0; i < 8; i++) native.Tick(.5);
    await player.NextAsync();
    Check(session.Events.Count == 1 && session.Events[0] == (tracks[0].Id, "skipped", 4, "search"), "Next event seconds, outcome or source incorrect");
    for (var i = 0; i < 60; i++) native.Tick(.5);
    native.RaiseEnded(); await Task.Yield();
    Check(session.Events.Count == 2 && session.Events[1].Outcome == "completed" && session.Events[1].Source == "auto_dj", "Natural end did not finalize exactly one completed event");
    for (var i = 0; i < 6; i++) native.Tick(.5);
    await player.StopAsync(); await player.StopAsync();
    Check(session.Events.Count == 3 && session.Events[2].Outcome == "stopped" && session.Events[2].Seconds == 3, "Stop lost or duplicated an event");
    await player.PlayAsync(tracks[0], tracks); player.FollowingHost = true;
    var before = session.Events.Count;
    for (var i = 0; i < 40; i++) native.Tick(.5);
    await player.StopAsync();
    Check(session.Events.Count == before && session.Listened.Count == 1, "Following a host recorded local history");
}
Console.WriteLine("PASS: shuffle, volume, playback races, history, Auto DJ, host controls, device handover and filtered drift correction.");

public static class MainThread
{
    public static Task InvokeOnMainThreadAsync(Action action) { action(); return Task.CompletedTask; }
    public static Task InvokeOnMainThreadAsync(Func<Task> action) => action();
    public static Task<T> InvokeOnMainThreadAsync<T>(Func<Task<T>> action) => action();
    public static void BeginInvokeOnMainThread(Action action) => action();
}
namespace CommunityToolkit.Maui.Views { public sealed class MediaElement { } }
namespace FamilyHub.Client.Core
{
    public sealed record MusicTrack(string Id = "", string Title = "", string Channel = "") { public string Url { get; init; } = ""; public double? PlaybackGainDb { get; init; } public double? Lufs { get; init; } public double? TruePeak { get; init; } public string PlaybackVersion { get; init; } = ""; public double Duration { get; init; } = 30; public bool Saved { get; init; } public long DownloadSize { get; init; } = 1024; public bool IsDeezerSuggestion => Id.StartsWith("deezer:", StringComparison.Ordinal); }
    public sealed record ListenerPreferences { public string VolumeLevel { get; init; } = "normal"; public bool ListeningHistoryPaused { get; init; } }
    public sealed record PlaybackResume
    {
        public List<string> TrackIds { get; init; } = []; public int Index { get; init; } public double Position { get; init; }
        public bool? Shuffle { get; init; }
        public string? RepeatMode { get; init; }
        public bool? Autoplay { get; init; }
        public bool IsValid => TrackIds.Count > 0 && Index >= 0 && Index < TrackIds.Count && double.IsFinite(Position);
    }
    public sealed class FamilyHubApiException : Exception { }
}
namespace FamilyHub.App.Services
{
    public sealed class MusicSession
    {
        public ListenerPreferences PlaybackPreferences { get; set; } = new();
        public bool EvenSongVolume { get; private set; } = true;
        public void SetEvenSongVolume(bool enabled) => EvenSongVolume = enabled;
        public MusicTrack CurrentRecording(MusicTrack track) => track;
        public MusicTrack PlaybackRecording(MusicTrack track, string path) => track;
        public List<string> Listened { get; } = [];
        public void RecordListen(MusicTrack track) => Listened.Add(track.Id);
        public string HistoryOwner => "test";
        public List<(string Id, string Outcome, double Seconds, string Source)> Events { get; } = [];
        public void QueueListeningEvent(MusicTrack track, DateTimeOffset started, double seconds, double duration, double position, string outcome, string source, string owner)
        { if (seconds > 0) Events.Add((track.Id, outcome, seconds, source)); }
        public bool Connected => true;
        public int LocalPlays { get; private set; }
        public void MarkLocalPlayback() => LocalPlays++;
        public void InvalidateListeningBaseline() { }
        public bool FailPlayback { get; set; }
        public bool Delay { get; set; }
        public List<string> Messages { get; } = [];
        private readonly List<TaskCompletionSource<string>> requests = [];
        public int DownloadRequests => requests.Count;
        public bool Stream { get; set; }
        public bool CanWarmPlayback { get; set; }
        public bool HomeConnection { get; set; }
        public bool DataSaver { get; set; }
        public bool CanCacheUpcoming => HomeConnection && !DataSaver;
        public long CacheFreeBytes { get; set; } = long.MaxValue;
        public bool DelayUpcoming { get; set; }
        public int StreamRequests { get; private set; }
        public int PrefetchRequests { get; private set; }
        public List<(MusicTrack Track, CancellationToken Token)> UpcomingDownloads { get; } = [];
        public List<(string Action, string Stage)> Stages { get; } = [];
        public List<(string Action, string Stage, double Position)> Observations { get; } = [];
        public Dictionary<(string Action, string Stage), long> StageTimes { get; } = [];
        public void RememberPlaybackAttempt(string action, MusicTrack track, DateTimeOffset requestedAt) { }
        public void RecordPlaybackObservation(string action, string stage, double position, string? reason) =>
            Observations.Add((action, stage, position));
        public void ReportPlaybackStage(string action, string stage, long elapsed)
        {
            Stages.Add((action, stage));
            StageTimes[(action, stage)] = elapsed;
        }
        public string? LocalPath(MusicTrack track) => Delay || Stream ? null : FailPlayback ? "fail" : "fixture";
        public Task<string?> GetCachedPlaybackPathAsync(MusicTrack track, CancellationToken token) => Task.FromResult<string?>(null);
        public Task<MusicTrack> EnsureServerRecordingAsync(MusicTrack track, CancellationToken token, bool allowPreview = false,
            bool background = false, bool prefetch = false, string? action = null, bool fallback = false)
        {
            if (!prefetch) return Task.FromResult(track);
            if (!background || allowPreview) throw new Exception("Next-song acquisition must request a saved copy at low priority");
            PrefetchRequests++;
            return Task.FromResult(track with { Saved = true });
        }
        public bool CanStream => Stream;
        public static bool IsStream(string source) => source.StartsWith("https://", StringComparison.Ordinal);
        public Task<string> StreamPlaybackAsync(MusicTrack track, double lead, CancellationToken token, bool background = false, string? action = null)
        {
            StreamRequests++;
            return Task.FromResult("https://music.test/stream");
        }
        public Task<string> CachePlaybackAsync(MusicTrack track, CancellationToken token, double lead = 0, bool background = false, bool upcoming = false)
        {
            if (upcoming)
            {
                if (!background || !track.Saved) throw new Exception("Next-song downloads must be saved audio at low priority");
                UpcomingDownloads.Add((track, token));
                if (track.DownloadSize > CacheFreeBytes) throw new IOException("Fixture cache is full");
                if (DelayUpcoming) return new TaskCompletionSource<string>().Task.WaitAsync(token);
                return Task.FromResult("upcoming-cache");
            }
            if (Stream) return Task.FromResult("fixture");
            var request = new TaskCompletionSource<string>(); requests.Add(request); return request.Task;
        }
        public void Complete(int i) => requests[i].SetResult("fixture");
        public void Fail(int i) => requests[i].SetException(new IOException("Old request failed"));
        public void TimeOut(int i) => requests[i].SetCanceled();
        public void SetMessage(string value, string level = "info", bool playback = false) => Messages.Add(value);
        public void PinPlayback(string? id) { }
        public void PinPreparingPlayback(string? id) { }
        public void PinUpcomingPlayback(string? id) { }
        public void PinPreparingNextPlayback(string? id) { }
        // Connect to a device: the player tests run without a server.
        public string DeviceId { get; init; } = "0123456789abcdef0123456789abcdef";
        public RemoteApi Api { get; } = new();
        public sealed class RemoteApi { public Task ControlPlaybackAsync(string from, string to, string action, double? position = null) => Task.CompletedTask; }
    }
    public sealed class WindowsAudioPlayer : IAudioDeck
    {
        public static WindowsAudioPlayer? Last;
        public WindowsAudioPlayer() => Last = this;
        public event Action? Changed;
        public event Action? Ended;
        public event Action<string>? Failed;
        private bool suspended;
        public bool Playing => PlaybackRequested && !suspended;
        public bool HoldOpening { get; set; }
        public bool Opening => HoldOpening;
        public bool PlaybackRequested { get; private set; }
        public string? Title { get; private set; }
        public string? Path { get; private set; }
        public double Position { get; private set; }
        public double? StartedAt { get; private set; }
        public double LocalDuration { get; set; } = 30;
        public double StreamDuration { get; set; } = 30;
        public double Duration => Title is null ? 0 : Path?.StartsWith("https://") == true ? StreamDuration : LocalDuration;
        public double Volume { get; set; }
        public bool SupportsPlaybackRate => true;
        public double PlaybackRate { get; set; } = 1;
        public int Seeks { get; private set; }
        public bool TransportEnabled { private get; set; }
        public bool IgnoreNextSeek { get; set; }
        public TaskCompletionSource? PendingSeek { get; set; }
        public Task SeekAsync(double seconds)
        {
            if (IgnoreNextSeek) IgnoreNextSeek = false;
            else Seek(seconds);
            return PendingSeek?.Task ?? Task.CompletedTask;
        }
        public int Refreshes { get; private set; }
        public void RefreshPosition() => Refreshes++;
        public void PlayFile(string path, string title, string artist, bool play = true, bool background = false)
        {
            if (path == "fail") throw new IOException();
            Position = 0; StartedAt = null; Title = title; Path = path; SetPlaying(play);
        }
        public void SetPlaying(bool play)
        {
            if (play) StartedAt ??= Position;
            suspended = false;
            PlaybackRequested = play; Changed?.Invoke();
        }
        public void RaiseEnded() => Ended?.Invoke();
        public void RaiseFailed(bool resetPosition = false)
        {
            PlaybackRequested = false;
            if (resetPosition) { Position = 0; Changed?.Invoke(); }
            Failed?.Invoke("Fixture stream failed");
        }
        public void Seek(double seconds) { Position = seconds; Seeks++; Changed?.Invoke(); }
        public void Tick(double seconds) { Position += seconds * PlaybackRate; Changed?.Invoke(); }
        public void SuspendWithoutFailure()
        {
            Position = 0; Changed?.Invoke();
            suspended = true; Changed?.Invoke();
        }
        public void Stop() { Title = null; Path = null; PlaybackRequested = false; Changed?.Invoke(); }
    }
}
