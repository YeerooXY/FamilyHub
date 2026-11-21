using System.Runtime.CompilerServices;
using AndroidX.Media3.Session;
using CommunityToolkit.Maui.Core.Handlers;
using CommunityToolkit.Maui.Core.Views;

namespace FamilyHub.App;

internal sealed class LocalAudioHandler : MediaElementHandler
{
    protected override MauiMediaElement CreatePlatformView()
    {
        var view = base.CreatePlatformView();
        if (MediaManager is not { } manager) return view;
        try
        {
            // Toolkit 11 creates a platform media session even with its service disabled.
            // Publish only FamilyHub's queue-aware session, for both playback decks.
            ref var session = ref ToolkitSession(manager);
            session?.Release();
            session?.Dispose();
            session = null;
        }
        catch (MissingFieldException)
        {
            Android.Util.Log.Warn("FamilyHub", "Could not disable the deck media session.");
        }
        return view;
    }

    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "session")]
    private static extern ref MediaSession? ToolkitSession(MediaManager manager);
}
