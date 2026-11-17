namespace FamilyHub.Client.Core;

// Port of music_web/mixing.py and static/app.js: linear media-time ramp, 15 ms smoothing.
public static class CrossfadeEnvelope
{
    /// <summary>Default length; the profile's "Crossfade songs" setting chooses 0-12 seconds.</summary>
    public const double Seconds = 6;
    public const double MaxSeconds = 12;
    public const int TickMilliseconds = 40;
    // A fade never takes more than a third of a short song.
    public static double Duration(double outgoingDuration, double seconds = Seconds) => Math.Min(Math.Clamp(seconds, 0, MaxSeconds), Math.Max(0, outgoingDuration) / 3);
    public static double Fraction(double incomingPosition, double start, double duration) =>
        Math.Clamp((incomingPosition - start) / Math.Max(.05, duration), 0, 1);
    public static double Smooth(double previous, double target, double elapsedSeconds) =>
        target + (previous - target) * Math.Exp(-Math.Max(0, elapsedSeconds) / .015);
}
