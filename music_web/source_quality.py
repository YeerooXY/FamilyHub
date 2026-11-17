"""Read-only source checks and replacement proposals for saved recordings."""
import array
import cmath
import copy
import json
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from types import SimpleNamespace

from .catalogue_review import seed
from .playlists import preferred_match, rank_matches, source_tier

FFMPEG_LOCK = threading.Lock()
SIZE = 4096
RATE = 48000
BANDS = ((1000, 8000), (14000, 15500), (16000, 17000), (17500, 19000), (19000, 20500))


class ScanPaused(Exception):
    pass


def spectrum(samples):
    """Radix-two FFT; no additional server dependency."""
    values = [complex(x * (.5 - .5 * math.cos(2 * math.pi * i / (SIZE - 1))))
              for i, x in enumerate(samples)]
    j = 0
    for i in range(1, SIZE):
        bit = SIZE >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            values[i], values[j] = values[j], values[i]
    width = 2
    while width <= SIZE:
        roots = [cmath.exp(-2j * math.pi * k / width) for k in range(width // 2)]
        for start in range(0, SIZE, width):
            for k, root in enumerate(roots):
                a, b = start + k, start + k + width // 2
                even, odd = values[a], values[b] * root
                values[a], values[b] = even + odd, even - odd
        width *= 2
    return [sum(abs(values[k]) ** 2 for k in range(math.ceil(lo * SIZE / RATE), math.ceil(hi * SIZE / RATE)))
            for lo, hi in BANDS]


def classify(energies):
    usable = [row for row in energies if row[0] > 1e-6]
    if not usable:
        return dict(verdict='unknown', bands_db=[])
    # Use the strongest high-frequency evidence across windows, avoiding quiet intros.
    ratios = [max(10 * math.log10(max(row[i], 1e-30) / row[0]) for row in usable)
              for i in range(1, len(BANDS))]
    if len(usable) >= 2 and ratios[0] > -40 and ratios[2] < -55 and ratios[3] < -60 and ratios[0] - ratios[2] > 30:
        verdict = 'suspect'
    elif ratios[3] > -45:
        verdict = 'clean'
    else:
        verdict = 'unknown'
    return dict(verdict=verdict, bands_db=[round(value, 2) for value in ratios])


def analyze(path, duration, idle=lambda: True, ffmpeg='ffmpeg'):
    """Measure three three-second windows, decoding one bounded buffer at a time."""
    if not math.isfinite(duration) or duration < 3:
        return dict(verdict='unknown', bands_db=[])
    energies = []
    try:
        for fraction in (.2, .5, .8):
            if not idle():
                raise ScanPaused()
            start = max(0, (duration - 3) * fraction)
            command = [ffmpeg, '-nostdin', '-v', 'error', '-threads', '1',
                       '-protocol_whitelist', 'file,pipe', '-ss', str(start), '-i', str(path),
                       '-map', '0:a:0', '-t', '3', '-ac', '1', '-ar', str(RATE), '-f', 'f32le', 'pipe:1']
            if os.name == 'posix' and shutil.which('nice'):
                command = ['nice', '-n', '10', *command]
            with FFMPEG_LOCK:
                if not idle():
                    raise ScanPaused()
                options = {'creationflags': subprocess.BELOW_NORMAL_PRIORITY_CLASS} if os.name == 'nt' else {}
                with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options) as process:
                    elapsed = 0
                    while True:
                        try:
                            output, _ = process.communicate(timeout=.2)
                            break
                        except subprocess.TimeoutExpired:
                            elapsed += .2
                            if not idle() or elapsed >= 30:
                                process.kill()
                                process.communicate()
                                if not idle():
                                    raise ScanPaused()
                                raise TimeoutError('Audio measurement timed out')
                    if process.returncode:
                        raise ValueError('Audio could not be decoded')
            samples = array.array('f')
            samples.frombytes(output)
            if sys.byteorder != 'little':
                samples.byteswap()
            energy = [0.] * len(BANDS)
            # Six spaced FFT frames cover each window without analysing every sample.
            for offset in range(0, max(0, len(samples) - SIZE + 1), max(SIZE, (len(samples) - SIZE) // 5)):
                if not idle():
                    raise ScanPaused()
                for i, value in enumerate(spectrum(samples[offset:offset + SIZE])):
                    energy[i] += value
            energies.append(energy)
        return classify(energies)
    except (OSError, ValueError, TimeoutError):
        return dict(verdict='unknown', bands_db=[])


class SourceQuality:
    def __init__(self, workspace, intake, idle=lambda: True, review=None):
        self.workspace = Path(workspace)
        self.path = self.workspace / '.source-quality.json'
        self.intake, self.idle, self.review = intake, idle, review
        self.lock = threading.RLock()
        self.scan_lock = threading.Lock()
        self.active_keys = None
        self.stop = threading.Event()
        try:
            self.rows = json.loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(self.rows, dict):
                self.rows = {}
        except (OSError, ValueError):
            self.rows = {}

    def save(self, key, row):
        with self.lock:
            self.rows[key] = row
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.rows, ensure_ascii=False), encoding='utf-8')
            temporary.replace(self.path)

    def scan_once(self):
        if not self.scan_lock.acquire(blocking=False):
            return
        try:
            active_keys = set()
            for item in sorted(self.workspace.iterdir()):
                if not self.idle() or self.stop.is_set():
                    return
                if not self.intake.ID_RE.fullmatch(item.name) or not item.name.startswith(('yt-', 'local-')):
                    continue
                try:
                    _, manifest, audio = self.intake.load_item(str(item))
                    if not manifest.get('import') or manifest.get('edit'):
                        continue
                    source = manifest['source']
                    identifier = source['id'] if source['kind'] == 'youtube' else manifest['id']
                    digest = manifest['audio']['sha256']
                    key = identifier + ':' + digest
                    active_keys.add(key)
                    with self.lock:
                        row = copy.deepcopy(self.rows.get(key))
                    if row is None:
                        record = manifest['import']
                        metadata = self.review.overrides(identifier, record['library_sha256']) if self.review else {}
                        track = seed(source, dict(title=record['title'], channel=metadata.get('artist', record['artist']),
                                                  duration=manifest['audio']['duration']))
                        tier = source_tier(source, track['artist']) if source['kind'] == 'youtube' else None
                        result = analyze(audio, manifest['audio']['duration'], self.idle)
                        row = dict(id=identifier, sha256=digest, **track, **result, source_tier=tier,
                                   proposed_replacement=None, replacement_checked=False)
                        self.save(key, row)
                    if (row['verdict'] == 'suspect' or row['source_tier'] == 3) and not row['replacement_checked']:
                        if not self.idle():
                            return
                        query = (row['artist'].split(',')[0] + ' ' + row['title'])[:200]
                        found = self.intake.cmd_search(SimpleNamespace(query=query, limit=30, offset=0))['results']
                        if not self.idle():
                            return
                        candidates = rank_matches(row, found, search=self.intake.cmd_search)
                        row['proposed_replacement'] = preferred_match([c for c in candidates
                            if c['source_tier'] <= 2 and c.get('id') != identifier])
                        row['replacement_checked'] = True
                        self.save(key, row)
                except ScanPaused:
                    return
                except (OSError, ValueError, KeyError, self.intake.IntakeError) as error:
                    logging.getLogger(__name__).warning('Source quality %s: %s', item.name, type(error).__name__)
            with self.lock:
                self.active_keys = active_keys
        finally:
            self.scan_lock.release()

    def snapshot(self):
        with self.lock:
            rows = copy.deepcopy([row for key, row in self.rows.items()
                                  if self.active_keys is None or key in self.active_keys])
        counts = {verdict: sum(r['verdict'] == verdict for r in rows) for verdict in ('clean', 'suspect', 'unknown')}
        counts['tier_3'] = sum(r['source_tier'] == 3 for r in rows)
        counts['total'] = len(rows)
        return dict(counts=counts, songs=[r for r in rows if r['verdict'] == 'suspect' or r['source_tier'] == 3])


def register(app, workspace, intake, idle, admin, review, enabled=True):
    from flask import jsonify
    scanner = SourceQuality(workspace, intake, idle, review)
    app.extensions['music'].source_quality = scanner

    @app.get('/api/catalogue/source-quality')
    def source_quality():
        if not admin():
            return jsonify(error='Only the admin can review source quality.'), 403
        return jsonify(scanner.snapshot())

    def scan():
        while not scanner.stop.wait(30):
            try:
                scanner.scan_once()
            except Exception as error:
                app.logger.warning('Source quality: %s', type(error).__name__)
            if scanner.stop.wait(1800 if idle() else 5):
                return

    if enabled:
        threading.Thread(target=scan, name='source-quality', daemon=True).start()


if __name__ == '__main__':
    import argparse
    from . import load_intake
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace')
    parser.add_argument('--intake', required=True)
    args = parser.parse_args()
    scanner = SourceQuality(args.workspace, load_intake(args.intake))
    scanner.scan_once()
    print(json.dumps(scanner.snapshot(), ensure_ascii=False, indent=2))
