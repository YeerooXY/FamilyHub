namespace FamilyHub.Client.Core;

public sealed record ServerHealthNow
{
    public long At { get; init; }
    public List<ServerMount> Mounts { get; init; } = [];
    public List<string> Networks { get; init; } = [];
    public Dictionary<string, double> Values { get; init; } = [];
    public Dictionary<string, double> Monthly { get; init; } = [];
}

public sealed record ServerMount
{
    public string Mount { get; init; } = "";
    public long? Used { get; init; }
    public long? Free { get; init; }
    public long? Total { get; init; }
    public long? Growth { get; init; }
    public List<ServerDisk> Disks { get; init; } = [];
}

public sealed record ServerDisk(string Name, string? Smart);

public sealed record ServerHealthHistory
{
    public long At { get; init; }
    public long Since { get; init; }
    public int Step { get; init; }
    public Dictionary<string, double[][]> Series { get; init; } = [];
    public Dictionary<string, long> Totals { get; init; } = [];
}
