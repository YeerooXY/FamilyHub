using Microsoft.Extensions.Logging;
using CommunityToolkit.Maui;
using FamilyHub.App.Services;

namespace FamilyHub.App;

public static class MauiProgram
{
	public static MauiApp CreateMauiApp()
	{
		var builder = MauiApp.CreateBuilder();
		builder
			.UseMauiApp<App>()
            // FamilyHub runs its own Android media session and playback service (PlaybackControls),
            // which offers Next and Previous; the toolkit's one-song notification stays off.
            .UseMauiCommunityToolkitMediaElement(isAndroidForegroundServiceEnabled: false)
			.ConfigureFonts(fonts =>
			{
				fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
			});

		builder.Services.AddMauiBlazorWebView();
        builder.Services.AddSingleton<MusicSession>();
        builder.Services.AddSingleton<MusicPlayer>();
        builder.Services.AddSingleton<PlaybackConnection>();
        builder.Services.AddSingleton<PlaybackDevicePoll>();
#if WINDOWS
        builder.Services.AddSingleton<DiscordPresence>();
#endif
        builder.Services.AddSingleton<ListenTogether>();
        builder.Services.AddSingleton<MainPage>();

#if DEBUG
		builder.Services.AddBlazorWebViewDeveloperTools();
		builder.Logging.AddDebug();
#endif

		return builder.Build();
	}
}
