using System.Collections.ObjectModel;

namespace FamilyHub.App;

public sealed record LocalAudioFile(string Name, long Size, Func<CancellationToken, Task<Stream>> OpenRead);

/// <param name="Name">The chosen folder's own name, offered as a playlist name.</param>
public sealed record LocalAudioFolderSelection(IReadOnlyList<LocalAudioFile> Files, int Skipped, bool LimitReached, string Name = "");

public static class LocalAudioFolderPicker
{
    public const int MaxFiles = 500;
    public const long MaxFileBytes = 128L * 1024 * 1024;
    private const int MaxDepth = 32;
    private const int MaxVisitedItems = 5000;
    private static readonly SemaphoreSlim PickerLock = new(1, 1);
    private static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".flac", ".mp3", ".m4a", ".opus", ".ogg", ".oga", ".wav", ".aac", ".webm", ".mka", ".wv", ".aiff", ".aif"
    };

    public static bool IsSupported(string name) => AudioExtensions.Contains(Path.GetExtension(name));

    public static async Task<LocalAudioFolderSelection?> PickAsync(CancellationToken cancellationToken)
    {
        await PickerLock.WaitAsync(cancellationToken);
        try
        {
#if WINDOWS
            return await PickWindowsAsync(cancellationToken);
#elif ANDROID
            return await PickAndroidAsync(cancellationToken);
#else
            throw new NotSupportedException("Folder selection is not available on this platform.");
#endif
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (NotSupportedException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException("The folder could not be selected or read. Choose a folder that the app can access and try again.", exception);
        }
        finally
        {
            PickerLock.Release();
        }
    }

#if WINDOWS
    private static async Task<LocalAudioFolderSelection?> PickWindowsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var folder = await Microsoft.Maui.ApplicationModel.MainThread.InvokeOnMainThreadAsync(async () =>
        {
            var picker = new Windows.Storage.Pickers.FolderPicker();
            picker.FileTypeFilter.Add("*");
            var mauiWindow = Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault();
            var nativeWindow = mauiWindow?.Handler?.PlatformView as Microsoft.UI.Xaml.Window;
            if (nativeWindow is null)
                throw new InvalidOperationException("The app window is unavailable for folder selection.");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(nativeWindow));
            var operation = picker.PickSingleFolderAsync();
            using var registration = cancellationToken.Register(operation.Cancel);
            return await operation;
        });

        if (folder is null)
            return null;

        return await Task.Run(() => EnumerateWindowsAsync(folder, cancellationToken), cancellationToken);
    }

    private static bool IsReparsePoint(Windows.Storage.StorageFolder folder) =>
        !string.IsNullOrEmpty(folder.Path) && new DirectoryInfo(folder.Path).LinkTarget is not null;

    private static async Task<LocalAudioFolderSelection> EnumerateWindowsAsync(Windows.Storage.StorageFolder root, CancellationToken cancellationToken)
    {
        var files = new List<LocalAudioFile>();
        var skipped = 0;
        var visited = 0;
        var limitReached = false;

        async Task WalkAsync(Windows.Storage.StorageFolder folder, int depth)
        {
            if (depth > MaxDepth || visited >= MaxVisitedItems)
            {
                limitReached = true;
                return;
            }

            uint offset = 0;
            while (!limitReached)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var remaining = MaxVisitedItems - visited;
                var pageSize = (uint)Math.Min(128, remaining + 1);
                var items = await folder.GetItemsAsync(offset, pageSize);
                if (items.Count == 0)
                    return;

                offset += (uint)items.Count;
                foreach (var item in items)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (++visited > MaxVisitedItems)
                    {
                        limitReached = true;
                        return;
                    }

                    if (item is Windows.Storage.StorageFolder child)
                    {
                        if (IsReparsePoint(child))
                            continue;
                        if (depth == MaxDepth)
                        {
                            limitReached = true;
                            return;
                        }
                        await WalkAsync(child, depth + 1);
                        if (limitReached)
                            return;
                        continue;
                    }

                    if (item is not Windows.Storage.StorageFile file)
                        continue;
                    if (!IsSupported(file.Name))
                    {
                        skipped++;
                        continue;
                    }

                    var size = (long)(await file.GetBasicPropertiesAsync()).Size;
                    if (size < 1 || size > MaxFileBytes)
                    {
                        skipped++;
                        continue;
                    }

                    if (files.Count == MaxFiles)
                    {
                        limitReached = true;
                        return;
                    }

                    files.Add(new LocalAudioFile(file.Name, size, async token =>
                    {
                        token.ThrowIfCancellationRequested();
                        return await file.OpenStreamForReadAsync();
                    }));
                }
            }
        }

        await WalkAsync(root, 0);
        return new LocalAudioFolderSelection(new ReadOnlyCollection<LocalAudioFile>(files), skipped, limitReached, root.Name);
    }
#endif

#if ANDROID
    private static async Task<LocalAudioFolderSelection?> PickAndroidAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Task<Android.Net.Uri?> pickerTask = Task.FromResult<Android.Net.Uri?>(null);
        await Microsoft.Maui.ApplicationModel.MainThread.InvokeOnMainThreadAsync(() =>
        {
            pickerTask = MainActivity.BeginFolderPicker();
        });
        var treeUri = await pickerTask.WaitAsync(cancellationToken);
        if (treeUri is null)
            return null;
        return await Task.Run(() => EnumerateAndroid(treeUri, cancellationToken), cancellationToken);
    }

    private static LocalAudioFolderSelection EnumerateAndroid(Android.Net.Uri treeUri, CancellationToken cancellationToken)
    {
        var resolver = Android.App.Application.Context.ContentResolver
            ?? throw new InvalidOperationException("Android file access is unavailable.");
        var rootId = Android.Provider.DocumentsContract.GetTreeDocumentId(treeUri)
            ?? throw new IOException("The selected folder has no document ID.");
        var files = new List<LocalAudioFile>();
        var skipped = 0;
        var visited = 0;
        var limitReached = false;

        void Walk(string documentId, int depth)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var childrenUri = Android.Provider.DocumentsContract.BuildChildDocumentsUriUsingTree(treeUri, documentId)
                ?? throw new IOException("The selected folder address is invalid.");
            using var cursor = resolver.Query(childrenUri, [
                Android.Provider.DocumentsContract.Document.ColumnDocumentId,
                Android.Provider.DocumentsContract.Document.ColumnDisplayName,
                Android.Provider.DocumentsContract.Document.ColumnMimeType,
                Android.Provider.DocumentsContract.Document.ColumnSize
            ], null, null, null) ?? throw new InvalidOperationException("The selected folder could not be read.");

            var idColumn = cursor.GetColumnIndexOrThrow(Android.Provider.DocumentsContract.Document.ColumnDocumentId);
            var nameColumn = cursor.GetColumnIndexOrThrow(Android.Provider.DocumentsContract.Document.ColumnDisplayName);
            var mimeColumn = cursor.GetColumnIndexOrThrow(Android.Provider.DocumentsContract.Document.ColumnMimeType);
            var sizeColumn = cursor.GetColumnIndexOrThrow(Android.Provider.DocumentsContract.Document.ColumnSize);

            while (cursor.MoveToNext())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (++visited > MaxVisitedItems)
                {
                    limitReached = true;
                    return;
                }

                var childId = cursor.GetString(idColumn);
                if (string.IsNullOrEmpty(childId)) { skipped++; continue; }
                var name = cursor.GetString(nameColumn) ?? "";
                var mime = cursor.GetString(mimeColumn);
                if (mime == Android.Provider.DocumentsContract.Document.MimeTypeDir)
                {
                    if (depth == MaxDepth)
                    {
                        limitReached = true;
                        return;
                    }
                    Walk(childId, depth + 1);
                    if (limitReached)
                        return;
                    continue;
                }

                if (!IsSupported(name))
                {
                    skipped++;
                    continue;
                }

                var size = cursor.IsNull(sizeColumn) ? -1 : cursor.GetLong(sizeColumn);
                if (size < 1 || size > MaxFileBytes)
                {
                    skipped++;
                    continue;
                }

                if (files.Count == MaxFiles)
                {
                    limitReached = true;
                    return;
                }

                var fileUri = Android.Provider.DocumentsContract.BuildDocumentUriUsingTree(treeUri, childId);
                if (fileUri is null) { skipped++; continue; }
                files.Add(new LocalAudioFile(name, size, async token =>
                {
                    token.ThrowIfCancellationRequested();
                    return await Task.Run(() =>
                    {
                        token.ThrowIfCancellationRequested();
                        return (Stream?)resolver.OpenInputStream(fileUri)
                            ?? throw new IOException($"Could not open {name}.");
                    }, token);
                }));
            }
        }

        Walk(rootId, 0);
        return new LocalAudioFolderSelection(new ReadOnlyCollection<LocalAudioFile>(files), skipped, limitReached, rootId.Split(':').Last().Split('/').Last());
    }
#endif
}
