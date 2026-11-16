namespace FamilyHub.App.Services;

/// <summary>
/// Android Back goes to the music screen first. The handler returns true when it
/// stepped back (closed a dialog or Now Playing, left a playlist, went to the
/// previous view); at Home it returns false and the app moves to the background
/// instead of closing, so music keeps playing.
/// </summary>
public static class BackNavigation
{
    public static Func<Task<bool>>? Handler { get; set; }
}
