using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;

// To learn more about WinUI, the WinUI project structure,
// and more about our project templates, see: http://aka.ms/winui-project-info.

namespace FamilyHub.App.WinUI;

/// <summary>
/// Provides application-specific behavior to supplement the default Application class.
/// </summary>
public partial class App : MauiWinUIApplication
{
	[STAThread]
	private static void Main()
	{
		using var activation = new EventWaitHandle(false, EventResetMode.AutoReset, "FamilyHub.Music.Activate");
		using var instance = new Mutex(false, "FamilyHub.Music.Instance", out var firstInstance);
		if (!firstInstance)
		{
			activation.Set();
			return;
		}

		WinRT.ComWrappersSupport.InitializeComWrappers();
		RegisteredWaitHandle? activationWait = null;
		try
		{
			Microsoft.UI.Xaml.Application.Start(_ =>
			{
				var dispatcher = DispatcherQueue.GetForCurrentThread();
				SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(dispatcher));
				new App();
				activationWait = ThreadPool.RegisterWaitForSingleObject(activation, (_, _) =>
					dispatcher.TryEnqueue(ActivateWindow), null, Timeout.Infinite, false);
			});
		}
		finally
		{
			activationWait?.Unregister(null);
			try { global::FamilyHub.App.Services.MovieNotifications.CloseWindows(); } catch (Exception) { }
		}
	}

	internal static void ActivateWindow()
	{
		if (Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()?.Handler?.PlatformView
			is Microsoft.UI.Xaml.Window window)
		{
			if (window.AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter)
				presenter.Restore();
			window.AppWindow.MoveInZOrderAtTop();
			window.Activate();
		}
	}

	/// <summary>
	/// Initializes the WinUI application for the primary instance.
	/// </summary>
	public App()
	{
		this.InitializeComponent();
	}

	protected override MauiApp CreateMauiApp() => MauiProgram.CreateMauiApp();
}

