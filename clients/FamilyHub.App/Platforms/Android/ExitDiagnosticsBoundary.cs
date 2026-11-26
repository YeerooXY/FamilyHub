using System.Runtime.ExceptionServices;
using FamilyHub.App.Components;
using FamilyHub.App.Services;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

namespace FamilyHub.App;

public sealed class ExitDiagnosticsBoundary : ErrorBoundaryBase
{
    [Inject] private MusicSession Session { get; set; } = null!;

    protected override void OnInitialized()
    {
        // Restart app reloads the WebView and can leave the Android process alive.
        AndroidExitDiagnostics.PrepareManagedFailure();
        Session.ReportPreviousExit();
    }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        builder.OpenComponent<Routes>(0);
        builder.CloseComponent();
    }

    protected override Task OnErrorAsync(Exception exception)
    {
        AndroidExitDiagnostics.Capture(exception);
        // Escalate to WebViewRenderer so the existing fatal error UI still appears.
        ExceptionDispatchInfo.Throw(exception);
        return Task.CompletedTask;
    }
}
