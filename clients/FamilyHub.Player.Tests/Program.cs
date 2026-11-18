using FamilyHub.App.Services;
using FamilyHub.Client.Core;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static (MusicSession Session, MusicPlayer Player) Setup()
{
    var session = new MusicSession(); var player = new MusicPlayer(session); player.Attach(new()); return (session, player);
}
var tracks = Enumerable.Range(0, 8).Select(i => new MusicTrack(i % 2 == 0 ? "duplicate" : $"id{i}", $"Occurrence {i}", "Artist")).ToList();
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
    var next = player.NextAsync(); WindowsAudioPlayer.Last!.RaiseEnded();
    Check(player.QueueIndex == 1, "Old ended event advanced during preparation");
    session.Complete(0); await next;
    await player.ToggleAsync(); WindowsAudioPlayer.Last!.RaiseEnded();
    Check(player.QueueIndex == 1 && !player.PlaybackRequested, "Ended event advanced paused selection");
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
    await player.StopAsync(); session.Complete(0); await Task.Delay(10);
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
    await Task.Delay(50); var pausedCount = gains.Count; await Task.Delay(60);
    Check(!fade.IsCompleted && gains.Count == pausedCount, "Paused crossfade continued its ramp");
    requested = true; outgoing.SetPlaying(true); incoming.SetPlaying(true); await fade;
    Check(gains[^1] == 1 && gains.All(g => g is >= 0 and <= 1), "Crossfade did not complete its media-time gain ramp");
    cancellation.Cancel(); await ticker; outgoing.Stop(); incoming.Stop();
}
{
    var (session, player) = Setup();
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -8, TruePeak = -1 }, "normal") == -6, "Loud master target incorrect");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -30, TruePeak = -20 }, "normal") == 6, "Quiet gain exceeded +6 dB");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -24, TruePeak = -3 }, "normal") == 2, "Quiet gain exceeded peak limit");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -14, TruePeak = -8 }, "quiet") == -5, "Quiet target incorrect");
    Check(MusicPlayer.NormalizationGainDb(tracks[0] with { Lufs = -14, TruePeak = -8 }, "loud") == 3, "Loud target incorrect");
    var loud = tracks[0] with { Lufs = -8, TruePeak = -1 };
    await player.PlayAsync(loud, tracks.Prepend(loud));
    Check(Math.Abs(WindowsAudioPlayer.Last!.Volume - Math.Pow(10, -.3)) < .00001, "Measured loudness attenuation missing");
    var current = player.Current;
    Check(player.ReplaceUpcoming(current!.Id, [tracks[3], tracks[5]]), "Recommendations not queued");
    Check(player.Current == current && player.Playing && player.Queue.Skip(player.QueueIndex + 1).SequenceEqual(new[] { tracks[3], tracks[5] }), "Recommendations changed current playback or retained old queue");
    Check(!player.ReplaceUpcoming("old seed", [tracks[7]]), "Stale recommendation replaced queue");
    await player.NextAsync(); Check(WindowsAudioPlayer.Last.Volume == 1, "Loudness gain leaked between songs");
    await player.PlayAsync(tracks[0] with { PlaybackGainDb = 12 }); Check(WindowsAudioPlayer.Last.Volume == 1, "Native gain exceeded unity");
    await player.PlayAsync(tracks[0] with { Lufs = -30, TruePeak = -20 });
    await player.SetVolumeAsync(.5);
    Check(WindowsAudioPlayer.Last.Volume == .5, "Native player boosted a quiet track");
    session.PlaybackPreferences = new() { VolumeLevel = "quiet" };
    var quiet = tracks[1] with { Lufs = -14, TruePeak = -8 };
    await player.PlayAsync(quiet, [quiet, tracks[3]]);
    Check(Math.Abs(WindowsAudioPlayer.Last.Volume - .5 * Math.Pow(10, -.25)) < .00001, "Volume level ignored");
    await player.NextAsync();
    Check(WindowsAudioPlayer.Last.Volume == .5, "Measured gain leaked between songs");
    await player.SetVolumeAsync(0); Check(WindowsAudioPlayer.Last.Volume == 0, "Normalization overrode mute");
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    var a = tracks[1] with { PlaybackGainDb = -13.24 }; var b = tracks[3] with { PlaybackGainDb = -2.06 };
    await player.PlayAsync(a, [a, b]); primary.Tick(24); secondary.Tick(.1); await Task.Delay(90);
    secondary.Tick(3); await Task.Delay(90);
    var left = Math.Pow(10, -13.24 / 20); var right = Math.Pow(10, -2.06 / 20);
    Check(primary.Volume < left && secondary.Volume > 0 && secondary.Volume <= right, "Crossfade ignored each song's normalization");
    Check(Math.Abs(primary.Volume / left + secondary.Volume / right - 1) < .00001, "Normalization changed linear fade envelope");
    secondary.Tick(4); await Task.Delay(90);
    Check(player.Current?.Id == b.Id && Math.Abs(secondary.Volume - right) < .00001, "Normalization lost at deck handoff");
    await player.StopAsync();
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
    var sequence = new[] { tracks[1], tracks[3] };
    await player.SynchronizeHostAsync(sequence, 0, 12, true, false, false);
    Check(!player.Playing, "Guest started before receiving a fresh position after preparation");
    await player.SynchronizeHostAsync(sequence, 0, 14, true, false, false);
    Check(player.Position == 14 && player.Playing && !player.AutoDj, "Guest did not synchronize position or Auto DJ");
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
    var (session, player) = Setup();
    player.RestoreResume(new() { TrackIds = [tracks[1].Id], Index = 0, Position = 7 }, tracks);
    Check(session.LocalPlays == 0 && !player.Playing, "Restoring startup state activated playback");
    await player.ToggleAsync();
    Check(session.LocalPlays == 1 && player.Playing, "Local resume did not activate playback");
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel", Playing = true, Position = 12,
        Track = new() { Id = tracks[1].Id } }, tracks);
    Check(!player.Playing && !player.PlaybackRequested && player.RemoteActive && player.RemoteDeviceName == "Pixel" && player.RemotePlaying,
        "Automatic pause did not enter remote mode");
    Check(player.Queue.Count == 1 && player.Current?.Id == tracks[1].Id && player.Position >= 12 && session.LocalPlays == 1,
        "Remote handover changed queue, lost position or echoed activation");
    await player.ToggleAsync();
    Check(player.RemoteActive && !player.RemotePlaying && !player.Playing && session.LocalPlays == 1,
        "Pausing the remote player took playback back or echoed a local activation");
    player.RemoteTick(); player.ApplyRemoteState(tracks[1].Id, false, 14);
    Check(session.LocalPlays == 1, "Following remote state activated local playback");
    await player.ToggleAsync();
    Check(!player.RemoteActive && player.Playing && Math.Abs(player.Position - 14) < .01 && session.LocalPlays == 2,
        "Pressing play did not take playback back locally");
    await player.ApplyRemoteControlAsync(new() { Action = "pause" });
    await player.ApplyRemoteControlAsync(new() { Action = "play" });
    Check(player.Playing && session.LocalPlays == 2, "Remote play echoed a local activation");
    await player.PauseLocallyAsync(); WindowsAudioPlayer.Last!.SetPlaying(true);
    Check(player.PlaybackRequested && session.LocalPlays == 3, "Native transport play did not activate playback");
    await player.ApplyPlaybackCommandAsync(new() { Action = "play", Resume = new() { TrackIds = [tracks[3].Id], Index = 0, Position = 8 }, Playing = true }, tracks);
    Check(player.Current == tracks[3] && player.Playing && player.Position == 8 && session.LocalPlays == 3,
        "Manual transfer echoed a local activation or lost its checkpoint");
    player.EnterRemote(new string('b', 32), "Pixel", 9, true);
    await player.PlayAsync(tracks[5], tracks);
    Check(!player.RemoteActive && player.Playing && session.LocalPlays == 4, "Choosing a song did not take playback back");
    var activations = session.LocalPlays;
    WindowsAudioPlayer.Last!.RaiseEnded(); await Task.Yield();
    Check(session.LocalPlays == activations, "Automatic queue advancement activated playback");
}
{
    var (session, player) = Setup(); session.Delay = true;
    var loading = player.PlayAsync(tracks[1], tracks);
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel", Playing = true }, tracks);
    session.Complete(0); await loading;
    Check(player.RemoteActive && !player.Playing && !player.PlaybackRequested && !player.Preparing && session.LocalPlays == 1,
        "Preparation restarted local playback after an automatic pause");
}
{
    var session = new MusicSession(); var primary = new WindowsAudioPlayer(); var secondary = new WindowsAudioPlayer();
    var player = new MusicPlayer(session); player.AttachDecks(primary, secondary);
    await player.PlayAsync(tracks[1], [tracks[1], tracks[3]]); primary.Tick(26); await Task.Delay(60);
    Check(player.Crossfading && secondary.Playing, "Fixture did not start its crossfade");
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel", Playing = true }, tracks);
    Check(!primary.Playing && !secondary.Playing && !player.Crossfading && player.RemoteActive,
        "Automatic pause left a crossfade deck playing");
}
{
    var (session, player) = Setup(); player.FollowingHost = true;
    await player.SynchronizeHostAsync([tracks[1]], 0, 2, true, false, false);
    await player.SynchronizeHostAsync([tracks[1]], 0, 3, true, false, false);
    await player.ApplyPlaybackCommandAsync(new() { Action = "pause", DeviceId = new string('b', 32), FromName = "Pixel" }, tracks);
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
    public static void BeginInvokeOnMainThread(Action action) => action();
}
namespace CommunityToolkit.Maui.Views { public sealed class MediaElement { } }
namespace FamilyHub.Client.Core
{
    public sealed record MusicTrack(string Id, string Title, string Channel) { public double? PlaybackGainDb { get; init; } public double? Lufs { get; init; } public double? TruePeak { get; init; } public string PlaybackVersion { get; init; } = ""; public double Duration { get; init; } = 30; }
    public sealed record ListenerPreferences { public string VolumeLevel { get; init; } = "normal"; public bool ListeningHistoryPaused { get; init; } }
    public sealed record PlaybackResume
    {
        public List<string> TrackIds { get; init; } = []; public int Index { get; init; } public double Position { get; init; }
        public bool IsValid => TrackIds.Count > 0 && Index >= 0 && Index < TrackIds.Count && double.IsFinite(Position);
    }
    public sealed class FamilyHubApiException : Exception { }
    public sealed record PlaybackDeviceTrack { public string Id { get; init; } = ""; }
    public sealed record PlaybackHandover
    {
        public string Action { get; init; } = ""; public string DeviceId { get; init; } = ""; public string FromName { get; init; } = "";
        public bool Playing { get; init; } public double? Position { get; init; } public PlaybackResume? Resume { get; init; }
        public PlaybackDeviceTrack? Track { get; init; }
    }
    public sealed record PlaybackControl { public string Action { get; init; } = ""; public double? Position { get; init; } }
}
namespace FamilyHub.App.Services
{
    public sealed class MusicSession
    {
        public ListenerPreferences PlaybackPreferences { get; set; } = new();
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
        public string? LocalPath(MusicTrack track) => Delay ? null : FailPlayback ? "fail" : "fixture";
        public Task<string?> GetCachedPlaybackPathAsync(MusicTrack track, CancellationToken token) => Task.FromResult<string?>(null);
        public Task<MusicTrack> EnsureServerRecordingAsync(MusicTrack track, CancellationToken token, bool allowPreview = false, bool background = false) => Task.FromResult(track);
        public bool CanStream => false;
        public void StreamingFailed() { }
        public static bool IsStream(string source) => source.StartsWith("https://", StringComparison.Ordinal);
        public Task<string> StreamPlaybackAsync(MusicTrack track, double lead, CancellationToken token, bool background = false) => throw new InvalidOperationException("Streaming is off in tests.");
        public Task<string> CachePlaybackAsync(MusicTrack track, CancellationToken token, double lead = 0, bool background = false)
        { var request = new TaskCompletionSource<string>(); requests.Add(request); return request.Task; }
        public void Complete(int i) => requests[i].SetResult("fixture");
        public void Fail(int i) => requests[i].SetException(new IOException("Old request failed"));
        public void SetMessage(string value) => Messages.Add(value);
        public void PinPlayback(string? id) { }
        public void PinPreparingPlayback(string? id) { }
        public void PinUpcomingPlayback(string? id) { }
        public void PinPreparingNextPlayback(string? id) { }
        // Connect to a device: the player tests run without a server.
        public string DeviceId => "0123456789abcdef0123456789abcdef";
        public RemoteApi? Api => null;
        public sealed class RemoteApi { public Task ControlPlaybackAsync(string from, string to, string action, double? position = null) => Task.CompletedTask; }
    }
    public sealed class WindowsAudioPlayer : IAudioDeck
    {
        public static WindowsAudioPlayer? Last;
        public WindowsAudioPlayer() => Last = this;
        public event Action? Changed;
        public event Action? Ended;
        public event Action<string>? Failed;
        public bool Playing => PlaybackRequested;
        public bool Opening => false;
        public bool PlaybackRequested { get; private set; }
        public string? Title { get; private set; }
        public double Position { get; private set; }
        public double Duration => Title is null ? 0 : 30;
        public double Volume { get; set; }
        public bool SupportsPlaybackRate => true;
        public double PlaybackRate { get; set; } = 1;
        public int Seeks { get; private set; }
        public bool TransportEnabled { private get; set; }
        public Task SeekAsync(double seconds) { Seek(seconds); return Task.CompletedTask; }
        public void RefreshPosition() { }
        public void PlayFile(string path, string title, string artist, bool play = true, bool background = false)
        { if (path == "fail") throw new IOException(); Position = 0; Title = title; PlaybackRequested = play; Changed?.Invoke(); }
        public void SetPlaying(bool play) { PlaybackRequested = play; Changed?.Invoke(); }
        public void RaiseEnded() => Ended?.Invoke();
        public void Seek(double seconds) { Position = seconds; Seeks++; Changed?.Invoke(); }
        public void Tick(double seconds) { Position += seconds * PlaybackRate; Changed?.Invoke(); }
        public void Stop() { Title = null; PlaybackRequested = false; Changed?.Invoke(); }
    }
}
