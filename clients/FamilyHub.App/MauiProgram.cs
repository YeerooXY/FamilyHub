using Microsoft.Extensions.Logging;
using CommunityToolkit.Maui;
using FamilyHub.App.Services;
#if WINDOWS
using Microsoft.Maui.LifecycleEvents;
#endif

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

#if ANDROID
        builder.ConfigureMauiHandlers(handlers =>
            handlers.AddHandler<CommunityToolkit.Maui.Views.MediaElement, LocalAudioHandler>());
#endif
		builder.Services.AddMauiBlazorWebView();
        builder.Services.AddSingleton(_ => new AppStrings(Preferences.Default.Get(AppStrings.PreferenceKey, ""),
            System.Globalization.CultureInfo.CurrentUICulture));
        builder.Services.AddSingleton<Microsoft.Extensions.Localization.IStringLocalizer>(services => services.GetRequiredService<AppStrings>());
        builder.Services.AddSingleton<MusicSession>();
        builder.Services.AddSingleton(_ => new FeedbackDrafts(Path.Combine(FileSystem.AppDataDirectory, "feedback-drafts")));
        builder.Services.AddSingleton(_ => new FamilyHub.Client.Core.PublicAppReleases(
            new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false }) { MaxResponseContentBufferSize = 2 << 20 }));
        builder.Services.AddSingleton<MusicPlayer>();
        builder.Services.AddSingleton<PlaybackConnection>();
        builder.Services.AddSingleton<PlaybackDevicePoll>();
#if WINDOWS
        builder.Services.AddSingleton<DiscordPresence>();
        // MAUI shows its own title row again when the window style changes; hide it in the same message.
        builder.ConfigureLifecycleEvents(events => events.AddWindows(windows =>
            windows.OnPlatformMessage((window, args) => WindowsWindowChrome.OnPlatformMessage(window, args.MessageId, args.WParam))));
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
