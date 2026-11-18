"""Small normalized playlist images, stored separately from song-list metadata."""
import base64
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
from contextlib import nullcontext
from .resources import audio_command


class ArtworkError(ValueError):
    pass


class PlaylistArtwork:
    def __init__(self, workspace, governor=None):
        self.root = Path(workspace) / '.playlist-artwork'
        self.governor = governor

    def path(self, owner, pid, digest):
        return self.root / hashlib.sha256(owner.encode()).hexdigest() / f'{pid}-{digest}.jpg'

    def save(self, owner, pid, image):
        if not isinstance(image, str) or len(image) > 750000 or not image.startswith(('data:image/jpeg;base64,', 'data:image/png;base64,')):
            raise ArtworkError('Choose a JPEG or PNG image.')
        try:
            data = base64.b64decode(image.split(',', 1)[1], validate=True)
        except ValueError:
            raise ArtworkError('This image could not be read.') from None
        if len(data) > 512 * 1024 or not data.startswith((b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n')):
            raise ArtworkError('Choose a JPEG or PNG image smaller than 512 KB.')
        try:
            command = ['ffmpeg', '-v', 'error', '-nostdin', '-max_alloc', '67108864',
                '-threads', '1', '-filter_threads', '1', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1',
                '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',
                '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']
            permit = self.governor.compute(False, wait=False) if self.governor else nullcontext(True)
            with permit as granted:
                if not granted:
                    raise ArtworkError('Image preparation is busy. Try again.')
                result = subprocess.run(audio_command(command), input=data, capture_output=True, timeout=10, check=True)
        except (OSError, subprocess.SubprocessError):
            raise ArtworkError('This image could not be opened. Choose another JPEG or PNG.') from None
        if not result.stdout.startswith(b'\xff\xd8\xff') or len(result.stdout) > 256 * 1024:
            raise ArtworkError('This image could not be saved. Choose another image.')
        digest = hashlib.sha256(result.stdout).hexdigest()
        target = self.path(owner, pid, digest)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.' + secrets.token_hex(8) + '.tmp')
        try:
            temporary.write_bytes(result.stdout)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return digest
