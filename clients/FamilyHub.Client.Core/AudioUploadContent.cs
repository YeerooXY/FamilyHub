using System.Net;
namespace FamilyHub.Client.Core;
internal sealed class AudioUploadContent(Stream source, long size, IProgress<DownloadProgress>? progress) : HttpContent
{
    protected override bool TryComputeLength(out long length) { length = size; return true; }
    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => SerializeToStreamAsync(stream, context, CancellationToken.None);
    protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken token)
    {
        var buffer = new byte[65536]; long written = 0; int count;
        while ((count = await source.ReadAsync(buffer, token)) != 0)
        {
            if (written + count > size) throw new InvalidDataException("The selected file changed during upload.");
            await stream.WriteAsync(buffer.AsMemory(0,count), token); written += count; progress?.Report(new(written,size));
        }
        if (written != size) throw new InvalidDataException("The selected file changed during upload.");
    }
    protected override void Dispose(bool disposing) { if (disposing) source.Dispose(); base.Dispose(disposing); }
}
