using System.Net;
using System.Net.Http.Headers;

namespace FamilyHub.Client.Core;

// A request body that streams a file with its length known up front (the server needs Content-Length) and reports
// how many bytes have gone out, without holding the file in memory.
internal sealed class ProgressContent : HttpContent
{
    private readonly Stream source;
    private readonly long length;
    private readonly Action<long> progress;

    public ProgressContent(Stream source, long length, Action<long> progress)
    {
        this.source = source; this.length = length; this.progress = progress;
        Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
    }

    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => Copy(stream, CancellationToken.None);
    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken cancellationToken) => Copy(stream, cancellationToken);

    private async Task Copy(Stream target, CancellationToken token)
    {
        var buffer = new byte[81920];
        long sent = 0;
        int read;
        while ((read = await source.ReadAsync(buffer.AsMemory(), token)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read), token);
            sent += read;
            progress(sent);
        }
    }

    protected override bool TryComputeLength(out long contentLength) { contentLength = length; return true; }
}
