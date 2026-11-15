using System.Text.Json.Serialization;

namespace FamilyHub.Client.Core;

public sealed record ListeningRoom
{
    public bool Resumed { get; init; }
    public string Id { get; init; } = "";
    [JsonPropertyName("host_name")] public string HostName { get; init; } = "";
    [JsonPropertyName("host_user")] public string HostUser { get; init; } = "";
    [JsonPropertyName("is_host")] public bool IsHost { get; init; }
    public int Listeners { get; init; }
    public string Title { get; init; } = "";
    public long Revision { get; init; }
    [JsonPropertyName("control_revision")] public long ControlRevision { get; init; }
    [JsonPropertyName("queue_revision")] public long QueueRevision { get; init; }
    public List<MusicTrack>? Queue { get; init; }
    public int Index { get; init; }
    public double Position { get; init; }
    public bool Playing { get; init; }
    [JsonPropertyName("auto_dj")] public bool AutoDj { get; init; } = true;
    public bool Crossfading { get; init; }
    [JsonPropertyName("fade_position")] public double FadePosition { get; init; }
    [JsonPropertyName("fade_elapsed")] public double FadeElapsed { get; init; }
    [JsonPropertyName("fade_duration")] public double FadeDuration { get; init; } = 6;
}

public sealed record ListeningRoomResponse(ListeningRoom Room);
public sealed record ListeningRoomsResponse(List<ListeningRoom> Rooms);

public sealed record ListeningPoke(string Id, string Sender, string Name, string Kind = "poke", [property: JsonPropertyName("room_id")] string? RoomId = null);
public sealed record ListeningPokes(List<ListeningPoke> Requests);

public sealed record PendingSessionPoke(string TargetUser, string Identity, DateTimeOffset Expires)
{
    public bool IsCurrent(string identity, bool inSession, DateTimeOffset now) => !inSession && identity == Identity && now < Expires;
    public ListeningRoom? Find(IEnumerable<ListeningRoom> rooms) => rooms.FirstOrDefault(room => room.HostUser == TargetUser);
}
