using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FamilyHub.Music;

internal record MusicLogin(string Username, string Password);

internal static class Program
{
    // The server address is set per install (FAMILYHUB_ORIGIN), so the public source holds no private address.
    internal static readonly Uri Origin = new(Environment.GetEnvironmentVariable("FAMILYHUB_ORIGIN") is { Length: > 0 } origin ? origin : "https://familyhub.example.ts.net:8444/");
    internal static readonly string StateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FamilyHub", "Music");
    private static string LoginPath => Path.Combine(StateDirectory, "login.dpapi");

    internal static bool IsAppUri(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.Host == Origin.Host && uri.Port == Origin.Port && uri.UserInfo.Length == 0;

    internal static bool IsPlayerUri(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.Host == Origin.Host && uri.Port == 8443 && uri.UserInfo.Length == 0;

    internal static void SaveLogin(MusicLogin login)
    {
        if (string.IsNullOrWhiteSpace(login.Username) || login.Username.Length > 64 || string.IsNullOrEmpty(login.Password) || login.Password.Length > 256)
            throw new ArgumentException("Enter a music username and password.");
        Directory.CreateDirectory(StateDirectory);
        var plain = JsonSerializer.SerializeToUtf8Bytes(login);
        try
        {
            var encrypted = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);
            var temp = LoginPath + ".tmp";
            File.WriteAllBytes(temp, encrypted);
            File.Move(temp, LoginPath, overwrite: true);
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }

    internal static MusicLogin? ReadLogin()
    {
        if (!File.Exists(LoginPath)) return null;
        byte[]? plain = null;
        try
        {
            plain = ProtectedData.Unprotect(File.ReadAllBytes(LoginPath), null, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<MusicLogin>(plain);
        }
        catch (Exception e) when (e is CryptographicException or IOException or JsonException) { return null; }
        finally { if (plain != null) CryptographicOperations.ZeroMemory(plain); }
    }

    internal static void ForgetLogin() { if (File.Exists(LoginPath)) File.Delete(LoginPath); }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--provision" }))
        {
            try { SaveLogin(JsonSerializer.Deserialize<MusicLogin>(Console.In.ReadToEnd()) ?? throw new ArgumentException()); }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (args.SequenceEqual(new[] { "--self-test" }))
        {
            var safe = IsAppUri(Origin + "login") && !IsAppUri("http://" + Origin.Authority)
                && !IsAppUri("https://" + Origin.Host + ".example:8444/") && !IsAppUri("https://" + Origin.Host + ":8443/")
                && !IsAppUri("file:///C:/Windows/") && !IsAppUri("https://user@" + Origin.Authority)
                && IsPlayerUri("https://" + Origin.Host + ":8443/") && !IsPlayerUri("https://example.com/");
            var original = Encoding.UTF8.GetBytes("credential self-check");
            var encrypted = ProtectedData.Protect(original, null, DataProtectionScope.CurrentUser);
            safe &= ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser).SequenceEqual(original);
            Environment.ExitCode = safe ? 0 : 1;
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MusicWindow(args.Length == 2 && args[0] == "--smoke-test" ? args[1] : null));
    }
}

internal sealed class MusicWindow : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(17, 17, 23) };
    private readonly Label notice = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White,
        Text = "Connecting to FamilyHub…", Font = new Font("Segoe UI", 14) };
    private readonly string? smokeOutput;
    private bool initialized;

    internal MusicWindow(string? smokeOutput)
    {
        this.smokeOutput = smokeOutput;
        Text = "FamilyHub Music";
        BackColor = Color.FromArgb(7, 16, 31);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(1360, 880);
        MinimumSize = new Size(850, 640);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;
        var menu = new ContextMenuStrip { BackColor = Color.FromArgb(24, 28, 36), ForeColor = Color.White };
        menu.Items.Add("Reconnect", null, async (_, _) => await Connect());
        menu.Items.Add("Sign-in details", null, async (_, _) => await EditLogin());
        menu.Items.Add("Open full library player", null, (_, _) => OpenPlayer(Program.Origin.GetLeftPart(UriPartial.Authority).Replace(":8444", ":8443") + "/"));
        menu.Items.Add("Forget sign-in", null, (_, _) => {
            Program.ForgetLogin();
            browser.CoreWebView2?.CookieManager.DeleteAllCookies();
            browser.CoreWebView2?.Navigate(new Uri(Program.Origin, "login").ToString());
        });
        var caption = new Panel { Dock = DockStyle.Top, Height = 32, BackColor = Color.FromArgb(7, 16, 31) };
        Button CaptionButton(string text, string name, DockStyle dock, EventHandler action) {
            var button = new Button { Text = text, AccessibleName = name, Dock = dock, Width = 46,
                FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = caption.BackColor, Font = new Font("Segoe UI", 12) };
            button.FlatAppearance.BorderSize = 0; button.Click += action; caption.Controls.Add(button); return button;
        }
        CaptionButton("−", "Minimize", DockStyle.Right, (_, _) => WindowState = FormWindowState.Minimized);
        CaptionButton("□", "Maximize or restore", DockStyle.Right, (_, _) => ToggleMaximize());
        CaptionButton("×", "Close", DockStyle.Right, (_, _) => Close());
        var menuButton = CaptionButton("···", "Window menu", DockStyle.Left, (_, _) => { });
        menuButton.Click += (_, _) => menu.Show(menuButton, new Point(0, menuButton.Height));
        caption.DoubleClick += (_, _) => ToggleMaximize();
        caption.MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(Handle, 0xA1, 2, 0); } };
        Controls.Add(browser); Controls.Add(notice); Controls.Add(caption);
        Padding = new Padding(5);
        MaximizedBounds = Screen.FromControl(this).WorkingArea;
        Shown += async (_, _) => await Initialize();
        RestoreWindow();
        FormClosing += (_, _) => SaveWindow();
        FormClosed += (_, _) => browser.Dispose();
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, int message, int wparam, int lparam);
    private void ToggleMaximize() {
        MaximizedBounds = Screen.FromControl(this).WorkingArea;
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
    }
    protected override void WndProc(ref Message message) {
        base.WndProc(ref message);
        if (message.Msg != 0x84 || WindowState != FormWindowState.Normal) return;
        var raw = message.LParam.ToInt64();
        var point = PointToClient(new Point((short)(raw & 0xffff), (short)((raw >> 16) & 0xffff)));
        bool left = point.X < 5, right = point.X >= ClientSize.Width - 5, top = point.Y < 5, bottom = point.Y >= ClientSize.Height - 5;
        if (left || right || top || bottom) message.Result = (IntPtr)(top ? (left ? 13 : right ? 14 : 12) : bottom ? (left ? 16 : right ? 17 : 15) : left ? 10 : 11);
    }

    private void RestoreWindow()
    {
        try
        {
            var path = Path.Combine(Program.StateDirectory, "window.json");
            if (!File.Exists(path)) return;
            var saved = JsonSerializer.Deserialize<int[]>(File.ReadAllText(path));
            if (saved is not { Length: 5 }) return;
            var bounds = new Rectangle(saved[0], saved[1], Math.Max(850, saved[2]), Math.Max(640, saved[3]));
            if (!Screen.AllScreens.Any(screen => Rectangle.Intersect(screen.WorkingArea, bounds) is { Width: >= 200, Height: >= 100 })) return;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            if (saved[4] == 1) WindowState = FormWindowState.Maximized;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { }
    }

    private void SaveWindow()
    {
        try
        {
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            Directory.CreateDirectory(Program.StateDirectory);
            File.WriteAllText(Path.Combine(Program.StateDirectory, "window.json"), JsonSerializer.Serialize(new[] {
                bounds.X, bounds.Y, bounds.Width, bounds.Height, WindowState == FormWindowState.Maximized ? 1 : 0 }));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    private async Task Initialize()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.StateDirectory, "WebView2"));
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsPinchZoomEnabled = false;
            browser.ZoomFactor = 1;
            core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Dark;
            core.NavigationStarting += (_, e) => {
                if (Program.IsAppUri(e.Uri)) return;
                e.Cancel = true;
                if (Program.IsPlayerUri(e.Uri)) OpenPlayer(e.Uri);
            };
            core.NewWindowRequested += (_, e) => { e.Handled = true; if (Program.IsPlayerUri(e.Uri)) OpenPlayer(e.Uri); };
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.NavigationCompleted += async (_, e) => {
                notice.Visible = !e.IsSuccess;
                if (!e.IsSuccess) notice.Text = "Cannot reach FamilyHub. Check Tailscale, then choose Reconnect in the window menu.";
                if (smokeOutput != null) await SaveSmokeResult(e.IsSuccess);
            };
            initialized = true;
            await Connect();
        }
        catch (Exception e) when (e is WebView2RuntimeNotFoundException or InvalidOperationException or IOException or System.Runtime.InteropServices.COMException)
        {
            notice.Text = "FamilyHub could not start its browser engine. Install Microsoft Edge WebView2 Runtime, then reopen the app.";
            if (smokeOutput != null) { File.WriteAllText(smokeOutput, JsonSerializer.Serialize(new { success = false, error = e.GetType().Name })); Close(); }
        }
    }

    private async Task Connect()
    {
        if (!initialized) return;
        notice.Text = "Connecting to FamilyHub…"; notice.Visible = true;
        var login = Program.ReadLogin();
        if (login != null)
        {
            try { await SignIn(login); }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or InvalidOperationException) {
                notice.Text = "Automatic sign-in failed. Use your music login or Account → Sign-in details.";
            }
        }
        browser.CoreWebView2.Navigate(Program.Origin.ToString());
    }

    private async Task SignIn(MusicLogin login)
    {
        var jar = new CookieContainer();
        foreach (var stored in await browser.CoreWebView2.CookieManager.GetCookiesAsync(Program.Origin.ToString()))
        {
            var cookie = new Cookie(stored.Name, stored.Value, stored.Path, Program.Origin.Host) { Secure = true, HttpOnly = stored.IsHttpOnly };
            if (!stored.IsSession) cookie.Expires = stored.Expires;
            jar.Add(Program.Origin, cookie);
        }
        using var handler = new HttpClientHandler { CookieContainer = jar, AllowAutoRedirect = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
        using var existing = await client.GetAsync(Program.Origin);
        if (existing.StatusCode == HttpStatusCode.OK) return;
        using var page = await client.GetAsync(new Uri(Program.Origin, "login"));
        page.EnsureSuccessStatusCode();
        var html = await page.Content.ReadAsStringAsync();
        var match = Regex.Match(html, "name=\"csrf_token\" value=\"([^\"]+)\"");
        if (!match.Success) throw new InvalidOperationException("Login unavailable");
        using var message = new HttpRequestMessage(HttpMethod.Post, new Uri(Program.Origin, "login"));
        message.Headers.Add("Origin", Program.Origin.GetLeftPart(UriPartial.Authority));
        message.Headers.Referrer = new Uri(Program.Origin, "login");
        message.Content = new FormUrlEncodedContent(new Dictionary<string, string> {
            ["username"] = login.Username, ["password"] = login.Password,
            ["csrf_token"] = WebUtility.HtmlDecode(match.Groups[1].Value), ["remember"] = "1" });
        using var result = await client.SendAsync(message);
        if (result.StatusCode != HttpStatusCode.Found || result.Headers.Location?.ToString() != "/")
            throw new InvalidOperationException("Login rejected");
        foreach (Cookie cookie in jar.GetCookies(Program.Origin))
        {
            var item = browser.CoreWebView2.CookieManager.CreateCookie(cookie.Name, cookie.Value, Program.Origin.Host, cookie.Path);
            item.IsHttpOnly = cookie.HttpOnly; item.IsSecure = true; item.SameSite = CoreWebView2CookieSameSiteKind.Lax;
            if (cookie.Expires != DateTime.MinValue) item.Expires = cookie.Expires.ToUniversalTime();
            browser.CoreWebView2.CookieManager.AddOrUpdateCookie(item);
        }
    }

    private async Task EditLogin()
    {
        using var dialog = new LoginDialog(Program.ReadLogin());
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        try { Program.SaveLogin(dialog.Login); await Connect(); }
        catch (Exception e) when (e is IOException or CryptographicException or ArgumentException) {
            MessageBox.Show(this, "The sign-in details could not be saved. Try again.", "FamilyHub Music", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void OpenPlayer(string uri) { if (Program.IsPlayerUri(uri)) Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); }

    private async Task SaveSmokeResult(bool success)
    {
        try
        {
            await Task.Delay(1800);
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#library-list article button')?.click()");
            string playback = "null";
            for (var attempt = 0; attempt < 30; attempt++)
            {
                await Task.Delay(600);
                playback = await browser.CoreWebView2.ExecuteScriptAsync("(() => { if (typeof decks === 'undefined') return null; const player=decks[deckIndex]; return {time:player.currentTime,paused:player.paused,state:document.getElementById('playback-state').textContent,title:document.getElementById('now-title').textContent,ready:player.readyState}; })()");
                using var parsed = JsonDocument.Parse(playback);
                if (parsed.RootElement.ValueKind == JsonValueKind.Object && parsed.RootElement.GetProperty("time").GetDouble() > .6) break;
            }
            var state = await browser.CoreWebView2.ExecuteScriptAsync("({title:document.title,library:!!document.getElementById('library-view'),error:document.getElementById('library-error')?.textContent})");
            using var screenshot = File.Create(smokeOutput + ".png");
            await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, screenshot);
            File.WriteAllText(smokeOutput!, JsonSerializer.Serialize(new { success, source = browser.Source.ToString(), state, playback,
                zoomFactor = browser.ZoomFactor, zoomEnabled = browser.CoreWebView2.Settings.IsZoomControlEnabled, pinchZoomEnabled = browser.CoreWebView2.Settings.IsPinchZoomEnabled,
                webMessagesEnabled = browser.CoreWebView2.Settings.IsWebMessageEnabled, hostObjectsAllowed = browser.CoreWebView2.Settings.AreHostObjectsAllowed }));
        }
        finally { Close(); }
    }
}

internal sealed class LoginDialog : Form
{
    private readonly TextBox username = new() { Dock = DockStyle.Fill, MaxLength = 64 };
    private readonly TextBox password = new() { Dock = DockStyle.Fill, MaxLength = 256, UseSystemPasswordChar = true };
    internal MusicLogin Login => new(username.Text.Trim(), password.Text);

    internal LoginDialog(MusicLogin? login)
    {
        Text = "Music sign-in details";
        ClientSize = new Size(460, 285); FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 10);
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 7 };
        panel.Controls.Add(new Label { Text = "Use this login on your phone too.", AutoSize = true });
        panel.Controls.Add(new Label { Text = "Username", AutoSize = true }); panel.Controls.Add(username);
        panel.Controls.Add(new Label { Text = "Passphrase", AutoSize = true }); panel.Controls.Add(password);
        var reveal = new CheckBox { Text = "Show passphrase", AutoSize = true };
        reveal.CheckedChanged += (_, _) => password.UseSystemPasswordChar = !reveal.Checked;
        panel.Controls.Add(reveal);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, AutoSize = true };
        var save = new Button { Text = "Save and sign in", AutoSize = true };
        save.Click += (_, _) => {
            if (string.IsNullOrWhiteSpace(username.Text)) { username.Focus(); return; }
            if (string.IsNullOrEmpty(password.Text)) { password.Focus(); return; }
            DialogResult = DialogResult.OK;
        };
        var cancel = new Button { Text = "Close", AutoSize = true, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(save); buttons.Controls.Add(cancel); panel.Controls.Add(buttons);
        Controls.Add(panel); AcceptButton = save; CancelButton = cancel;
        username.Text = login?.Username ?? "yeeroo"; password.Text = login?.Password ?? "";
    }
}
