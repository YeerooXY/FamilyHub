using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.Maui.Platform;
using Microsoft.UI.Xaml;
using Microsoft.Extensions.DependencyInjection;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Runtime.InteropServices;
using Windows.Graphics;
using NativeColor = Windows.UI.Color;

namespace FamilyHub.App.Services;

/// <summary>Maps the web header to native non-client hit testing, keeping OS caption controls.</summary>
internal static class WindowsWindowChrome
{
    private const int DwmwaBorderColor = 34;

    [DllImport("dwmapi.dll", ExactSpelling = true)]
    private static extern int DwmSetWindowAttribute(nint window, int attribute, in uint value, int size);

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPlacement
    {
        public uint Length, Flags, ShowCommand;
        public int MinX, MinY, MaxX, MaxY, Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowPlacement(nint window, ref WindowPlacement placement);

    [DllImport("user32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPlacement(nint window, in WindowPlacement placement);

    private static (Microsoft.UI.Xaml.Window Window, nint Handle, AppWindowPresenter Presenter, WindowPlacement Placement)? movieWindow;

    public static bool SetMovieFullscreen(bool on)
    {
        if (on)
        {
            if (Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()?.Handler?.PlatformView
                is not Microsoft.UI.Xaml.Window window) return false;
            var appWindow = window.AppWindow;
            if (appWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen) return true;
            var handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
            var placement = new WindowPlacement { Length = (uint)Marshal.SizeOf<WindowPlacement>() };
            if (!GetWindowPlacement(handle, ref placement)) return false;
            var presenter = appWindow.Presenter;
            appWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
            movieWindow = (window, handle, presenter, placement);
            return true;
        }
        if (movieWindow is { } previous)
        {
            movieWindow = null;
            if (previous.Window.AppWindow.Presenter.Kind != AppWindowPresenterKind.FullScreen) return false;
            previous.Window.AppWindow.SetPresenter(previous.Presenter);
            SetWindowPlacement(previous.Handle, previous.Placement);
            if (AppWindowTitleBar.IsCustomizationSupported())
                ConfigureTitleBar(previous.Window);
        }
        return false;
    }

    // MAUI's WindowRootView draws its own title row (window title text, 32 px) above the page whenever the
    // window has a caption style, and pushes the page down by that height. The web header replaces it, so
    // the row is hidden through MAUI's own visibility path, which it also uses when a window loses its caption.
    private const BindingFlags Internal = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly MethodInfo? ManagerTitleVisibility =
        typeof(NavigationRootManager).GetMethod("SetTitleBarVisibility", Internal, [typeof(bool)]);
    private static readonly MethodInfo? RootTitleVisibility =
        typeof(WindowRootView).GetMethod("SetTitleBarVisibility", Internal, [typeof(Microsoft.UI.Xaml.Visibility)]);
    private static readonly PropertyInfo? RootTitleContainer =
        typeof(WindowRootView).GetProperty("AppTitleBarContainer", Internal);
    private const uint WmStyleChanged = 0x007C;
    private const nint GwlStyle = -16;
    private static Action<bool>? refresh;

    [DynamicDependency("SetTitleBarVisibility(System.Boolean)", typeof(NavigationRootManager))]
    [DynamicDependency("SetTitleBarVisibility(Microsoft.UI.Xaml.Visibility)", typeof(WindowRootView))]
    [DynamicDependency("AppTitleBarContainer", typeof(WindowRootView))]
    public static void Initialize(Microsoft.UI.Xaml.Window window, Action<bool> refreshChrome)
    {
        refresh = refreshChrome;
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
            DwmSetWindowAttribute(WinRT.Interop.WindowNative.GetWindowHandle(window), DwmwaBorderColor, 0, sizeof(uint));
        if (AppWindowTitleBar.IsCustomizationSupported())
            ConfigureTitleBar(window);
        HideMauiTitleRow(window, force: true);

        window.AppWindow.Changed += (appWindow, args) =>
        {
            if (!args.DidPresenterChange) return;
            window.DispatcherQueue.TryEnqueue(() =>
            {
                var fullscreen = appWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;
                if (!fullscreen)
                {
                    if (movieWindow?.Window == window) movieWindow = null;
                    if (AppWindowTitleBar.IsCustomizationSupported()) ConfigureTitleBar(window);
                }
                HideMauiTitleRow(window, force: true);
                refreshChrome(fullscreen);
            });
        };
    }

    /// <summary>Runs after MAUI's own handling of the same window message.</summary>
    public static void OnPlatformMessage(Microsoft.UI.Xaml.Window window, uint messageId, nint wParam)
    {
        if (messageId != WmStyleChanged || wParam != GwlStyle) return;
        // MAUI has just restored its title row inset; hide it before the next layout pass.
        HideMauiTitleRow(window, force: true);
        window.DispatcherQueue.TryEnqueue(() => refresh?.Invoke(window.AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen));
    }

    /// <summary>Collapses MAUI's title row and its content inset; idempotent unless forced.</summary>
    internal static void HideMauiTitleRow(Microsoft.UI.Xaml.Window window, bool force = false)
    {
        var context = Microsoft.Maui.Controls.Application.Current?.Windows
            .FirstOrDefault(candidate => ReferenceEquals(candidate.Handler?.PlatformView, window))?.Handler?.MauiContext;
        if (context is null || ManagerTitleVisibility is null || RootTitleVisibility is null) return;
        var manager = context.Services.GetRequiredService<NavigationRootManager>();
        if (manager.RootView is not WindowRootView root) return;
        if (!force && RootTitleContainer?.GetValue(root) is FrameworkElement { Visibility: Microsoft.UI.Xaml.Visibility.Collapsed }) return;
        ManagerTitleVisibility.Invoke(manager, [false]);
        RootTitleVisibility.Invoke(root, [Microsoft.UI.Xaml.Visibility.Collapsed]);
    }

    public static WindowChromeMetrics Update(MainPage page, FrameworkElement? webView,
        WindowChromeRect[] interactiveRects, double devicePixelRatio)
    {
        if (!AppWindowTitleBar.IsCustomizationSupported() ||
            page.Window?.Handler?.PlatformView is not Microsoft.UI.Xaml.Window window ||
            webView?.XamlRoot is null)
            return WindowChromeMetrics.Unsupported;

        if (window.AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen)
            return WindowChromeMetrics.Unsupported;

        var titleBar = window.AppWindow.TitleBar;
        if (!window.ExtendsContentIntoTitleBar || !titleBar.ExtendsContentIntoTitleBar)
            ConfigureTitleBar(window);
        HideMauiTitleRow(window);

        var height = titleBar.Height;
        if (height <= 0) return WindowChromeMetrics.Unsupported;

        var scale = webView.XamlRoot.RasterizationScale;
        var cssScale = double.IsFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : scale;
        var offset = webView.TransformToVisual(null).TransformPoint(new Windows.Foundation.Point());
        var left = Math.Max(0, titleBar.LeftInset);
        var right = Math.Max(0, titleBar.RightInset);
        var width = window.AppWindow.ClientSize.Width;
        var source = InputNonClientPointerSource.GetForWindowId(window.AppWindow.Id);
        var regions = new List<RectInt32>();
        foreach (var rect in interactiveRects ?? [])
        {
            if (!double.IsFinite(rect.X) || !double.IsFinite(rect.Y) || !double.IsFinite(rect.Width) ||
                !double.IsFinite(rect.Height) || rect.Width <= 0 || rect.Height <= 0)
                continue;
            var x = Math.Clamp((int)Math.Floor(offset.X * scale + rect.X * cssScale), left, Math.Max(left, width - right));
            var y = Math.Max(0, (int)Math.Floor(offset.Y * scale + rect.Y * cssScale));
            var endX = Math.Clamp((int)Math.Ceiling(offset.X * scale + (rect.X + rect.Width) * cssScale), x, Math.Max(x, width - right));
            var endY = Math.Min(height, (int)Math.Ceiling(offset.Y * scale + (rect.Y + rect.Height) * cssScale));
            if (endX > x && endY > y)
                regions.Add(new RectInt32(x, y, endX - x, endY - y));
        }
        // Caption and interactive regions must not overlap: native title-bar hit
        // testing can otherwise treat a WebView input as a window drag target.
        var captions = new List<RectInt32> { new(left, 0, Math.Max(0, width - left - right), height) };
        foreach (var region in regions)
            captions = captions.SelectMany(caption => Subtract(caption, region)).ToList();
        titleBar.SetDragRectangles(captions.Where(rect => rect.Width > 0 && rect.Height > 0).ToArray());
        source.SetRegionRects(NonClientRegionKind.Passthrough, regions.ToArray());
        return new(true, left / cssScale, right / cssScale, height / cssScale);
    }

    private static void ConfigureTitleBar(Microsoft.UI.Xaml.Window window)
    {
        window.ExtendsContentIntoTitleBar = true;
        var titleBar = window.AppWindow.TitleBar;
        if (!titleBar.ExtendsContentIntoTitleBar) titleBar.ExtendsContentIntoTitleBar = true;
        titleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        titleBar.BackgroundColor = titleBar.InactiveBackgroundColor = Microsoft.UI.Colors.Black;
        titleBar.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
        titleBar.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
        titleBar.ButtonForegroundColor = NativeColor.FromArgb(255, 223, 232, 240);
        titleBar.ButtonInactiveForegroundColor = NativeColor.FromArgb(255, 140, 155, 170);
    }

    private static IEnumerable<RectInt32> Subtract(RectInt32 area, RectInt32 hole)
    {
        var left = Math.Max(area.X, hole.X);
        var top = Math.Max(area.Y, hole.Y);
        var right = Math.Min(area.X + area.Width, hole.X + hole.Width);
        var bottom = Math.Min(area.Y + area.Height, hole.Y + hole.Height);
        if (left >= right || top >= bottom)
        {
            yield return area;
            yield break;
        }
        if (top > area.Y)
            yield return new(area.X, area.Y, area.Width, top - area.Y);
        if (bottom < area.Y + area.Height)
            yield return new(area.X, bottom, area.Width, area.Y + area.Height - bottom);
        if (left > area.X)
            yield return new(area.X, top, left - area.X, bottom - top);
        if (right < area.X + area.Width)
            yield return new(right, top, area.X + area.Width - right, bottom - top);
    }
}
