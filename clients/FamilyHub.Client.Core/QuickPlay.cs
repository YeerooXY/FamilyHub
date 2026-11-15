namespace FamilyHub.Client.Core;

public static class QuickPlay
{
    public static List<MusicTrack> Queue(IEnumerable<MusicTrack> library, IReadOnlyList<string> history, Random? random = null)
    {
        random ??= Random.Shared;
        var tracks = library.DistinctBy(t => t.Id).ToList();
        var byId = tracks.ToDictionary(t => t.Id);
        var seeds = history.Where(byId.ContainsKey).Select(id => byId[id]).TakeLast(100).ToList();
        double Weight(MusicTrack track) => 1 + seeds.Sum(seed => seed.Id == track.Id ? 4
            : Similarity.Artist(seed) is { Length: > 0 } artist && artist == Similarity.Artist(track) ? 3
            : Similarity.IsSimilar(seed, track) ? 1 : 0);
        var queue = tracks.OrderBy(track => -Math.Log(1 - random.NextDouble()) / Weight(track)).ToList();
        if (queue.Count > 1 && history.Count > 0 && queue[0].Id == history[^1])
        { var previous = queue[0]; queue.RemoveAt(0); queue.Add(previous); }
        return queue;
    }
}
