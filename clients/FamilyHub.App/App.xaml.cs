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
        var window = new Window(mainPage) { Title = "FamilyHub Music" };
        window.Activated += (_, _) => mainPage.SetActive(true);
        window.Deactivated += (_, _) => mainPage.SetActive(false);
        window.Stopped += (_, _) => mainPage.SetActive(false);
        window.Destroying += (_, _) => mainPage.SetActive(false);
#if WINDOWS
        // The native caption buttons remain; MainPage hides MAUI's title row
        // after its handler exists and supplies the web header's hit regions.
        window.TitleBar = new TitleBar();
        window.Created += (_, _) =>
        {
            if (window.Handler?.PlatformView is Microsoft.UI.Xaml.Window nativeWindow)
                nativeWindow.AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "FamilyHub.ico"));
        };
#endif
        return window;
	}
}
