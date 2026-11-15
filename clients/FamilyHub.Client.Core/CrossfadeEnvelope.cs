namespace FamilyHub.Client.Core;

// Port of music_web/mixing.py and static/app.js: linear media-time ramp, 15 ms smoothing.
public static class CrossfadeEnvelope
{
    public const double Seconds = 6;
    public const int TickMilliseconds = 40;
    public static double Duration(double outgoingDuration) => Math.Min(Seconds, Math.Max(0, outgoingDuration) / 3);
    public static double Fraction(double incomingPosition, double start, double duration) =>
        Math.Clamp((incomingPosition - start) / Math.Max(.05, duration), 0, 1);
    public static double Smooth(double previous, double target, double elapsedSeconds) =>
        target + (previous - target) * Math.Exp(-Math.Max(0, elapsedSeconds) / .015);
}
