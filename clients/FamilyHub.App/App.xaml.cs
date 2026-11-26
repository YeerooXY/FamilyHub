namespace FamilyHub.App;

public partial class App : Application
{
	private readonly MainPage mainPage;
    public App(MainPage mainPage)
	{
		InitializeComponent();
        this.mainPage = mainPage;
	}

	protected override Window CreateWindow(IActivationState? activationState)
	{
        var window = new Window(mainPage) { Title = "FamilyHub" };
        window.Activated += (_, _) => mainPage.SetActive(true);
        window.Deactivated += (_, _) => mainPage.SetActive(false);
        window.Stopped += (_, _) => mainPage.SetActive(false);
        window.Destroying += (_, _) => {
            mainPage.SetActive(false);
#if WINDOWS
            mainPage.CloseDiscord();
#endif
        };
#if WINDOWS || MACCATALYST
        window.MinimumWidth = 850;
        window.MinimumHeight = 640;
#endif
#if WINDOWS
        window.Created += (_, _) =>
        {
            if (window.Handler?.PlatformView is Microsoft.UI.Xaml.Window nativeWindow)
            {
                nativeWindow.AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "FamilyHub.ico"));
                Services.WindowsWindowChrome.Initialize(nativeWindow);
            }
        };
#endif
        return window;
	}
}
