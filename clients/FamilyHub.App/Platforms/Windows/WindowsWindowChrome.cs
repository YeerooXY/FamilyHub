using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Windows.Graphics;
using NativeColor = Windows.UI.Color;

namespace FamilyHub.App.Services;

/// <summary>Maps the web header to native non-client hit testing, keeping OS caption controls.</summary>
internal static class WindowsWindowChrome
{
    public static WindowChromeMetrics Update(MainPage page, FrameworkElement? webView,
        double headerHeight, WindowChromeRect[] interactiveRects, double devicePixelRatio)
    {
        if (!AppWindowTitleBar.IsCustomizationSupported() ||
            page.Window?.Handler?.PlatformView is not Microsoft.UI.Xaml.Window window ||
            webView?.XamlRoot is null)
            return WindowChromeMetrics.Unsupported;

        var titleBar = window.AppWindow.TitleBar;
        titleBar.ExtendsContentIntoTitleBar = true;
        titleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        titleBar.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
        titleBar.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
        titleBar.ButtonForegroundColor = NativeColor.FromArgb(255, 223, 232, 240);
        titleBar.ButtonInactiveForegroundColor = NativeColor.FromArgb(255, 140, 155, 170);

        // Public MAUI visibility mapping also clears the navigation root's title inset.
        if (page.Window.TitleBar is Microsoft.Maui.Controls.TitleBar { IsVisible: true } mauiTitleBar)
            mauiTitleBar.IsVisible = false;

        var scale = webView.XamlRoot.RasterizationScale;
        var cssScale = double.IsFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : scale;
        var offset = webView.TransformToVisual(null).TransformPoint(new Windows.Foundation.Point());
        var left = Math.Max(0, titleBar.LeftInset);
        var right = Math.Max(0, titleBar.RightInset);
        var width = window.AppWindow.ClientSize.Width;
        var height = (int)Math.Ceiling(Math.Clamp(double.IsFinite(headerHeight) ? headerHeight : 48, 48, 180) * cssScale);
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
        return new(true, left / cssScale, right / cssScale, titleBar.Height / cssScale);
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
