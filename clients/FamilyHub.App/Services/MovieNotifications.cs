namespace FamilyHub.App.Services;

internal static class MovieNotifications
{
    internal static bool Supported => OperatingSystem.IsAndroid() || OperatingSystem.IsIOS() || OperatingSystem.IsWindows();

    internal static Task RequestPermissionAsync() =>
#if IOS
        MainThread.InvokeOnMainThreadAsync(async () =>
        {
            var center = UserNotifications.UNUserNotificationCenter.Current;
            center.Delegate = presentation;
            var settings = await center.GetNotificationSettingsAsync();
            if (settings.AuthorizationStatus == UserNotifications.UNAuthorizationStatus.NotDetermined)
                await center.RequestAuthorizationAsync(UserNotifications.UNAuthorizationOptions.Alert | UserNotifications.UNAuthorizationOptions.Sound);
        });
#else
        Task.CompletedTask;
#endif

#if IOS
    private static readonly Presentation presentation = new();

    private sealed class Presentation : UserNotifications.UNUserNotificationCenterDelegate
    {
        public override void WillPresentNotification(UserNotifications.UNUserNotificationCenter center,
            UserNotifications.UNNotification notification, Action<UserNotifications.UNNotificationPresentationOptions> completionHandler)
        {
            completionHandler(UserNotifications.UNNotificationPresentationOptions.Banner |
                UserNotifications.UNNotificationPresentationOptions.List | UserNotifications.UNNotificationPresentationOptions.Sound);
        }
    }
#endif
#if WINDOWS
    private static bool registered;
    private static void ActivateWindows(Microsoft.Windows.AppNotifications.AppNotificationManager sender,
        Microsoft.Windows.AppNotifications.AppNotificationActivatedEventArgs args) =>
        MainThread.BeginInvokeOnMainThread(WinUI.App.ActivateWindow);

    internal static void CloseWindows()
    {
        if (!registered) return;
        var manager = Microsoft.Windows.AppNotifications.AppNotificationManager.Default;
        manager.NotificationInvoked -= ActivateWindows;
        manager.Unregister();
        registered = false;
    }
#endif

    internal static Task<bool> ShowAsync(string title, string message, Func<bool> current) =>
#if ANDROID || IOS || WINDOWS
        MainThread.InvokeOnMainThreadAsync(async () =>
        {
            if (!current()) return false;
#if ANDROID
            var context = Android.App.Application.Context;
            if (context.GetSystemService(Android.Content.Context.NotificationService) is not Android.App.NotificationManager manager ||
                !manager.AreNotificationsEnabled()) return false;
            const string channelId = "movies";
            using var channel = new Android.App.NotificationChannel(channelId, "Movies & TV", Android.App.NotificationImportance.Default);
            manager.CreateNotificationChannel(channel);
            if (manager.GetNotificationChannel(channelId)?.Importance == Android.App.NotificationImportance.None) return false;
            using var builder = new Android.App.Notification.Builder(context, channelId);
            builder.SetContentTitle(title).SetContentText(message).SetSmallIcon(Android.Resource.Drawable.IcDialogInfo).SetAutoCancel(true);
            using var launch = context.PackageManager?.GetLaunchIntentForPackage(context.PackageName!);
            if (launch is not null)
            {
                using var intent = Android.App.PendingIntent.GetActivity(context, 0, launch,
                    Android.App.PendingIntentFlags.Immutable | Android.App.PendingIntentFlags.UpdateCurrent);
                builder.SetContentIntent(intent);
            }
            using var notification = builder.Build();
            manager.Notify(title, 4120, notification);
#elif IOS
            var center = UserNotifications.UNUserNotificationCenter.Current;
            center.Delegate = presentation;
            var authorization = (await center.GetNotificationSettingsAsync()).AuthorizationStatus;
            if (authorization is not (UserNotifications.UNAuthorizationStatus.Authorized or UserNotifications.UNAuthorizationStatus.Provisional) ||
                !current()) return false;
            using var content = new UserNotifications.UNMutableNotificationContent { Title = title, Body = message };
            using var request = UserNotifications.UNNotificationRequest.FromIdentifier(Guid.NewGuid().ToString("N"), content, null);
            await center.AddNotificationRequestAsync(request);
#elif WINDOWS
            var manager = Microsoft.Windows.AppNotifications.AppNotificationManager.Default;
            if (!registered)
            {
                manager.NotificationInvoked += ActivateWindows;
                try { manager.Register(); }
                catch { manager.NotificationInvoked -= ActivateWindows; throw; }
                registered = true;
            }
            if (manager.Setting != Microsoft.Windows.AppNotifications.AppNotificationSetting.Enabled) return false;
            var toast = new Microsoft.Windows.AppNotifications.Builder.AppNotificationBuilder()
                .AddText(title).AddText(message).BuildNotification();
            manager.Show(toast);
#endif
#if !IOS
            await Task.CompletedTask;
#endif
            return true;
        });
#else
        Task.FromResult(false);
#endif
}
