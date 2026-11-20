"""Source checks and recoverable official recording replacements."""
import array
import cmath
import copy
import json
import logging
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from contextlib import nullcontext
from types import SimpleNamespace

from .catalogue_review import normal, seed
from .playlists import preferred_match, rank_matches, repoint_recording, source_tier
from .review_confidence import MATCH_DURATION_SECONDS, close_duration, presentation_title
from .worker_activity import WorkerActivity
from .resources import audio_command, background_command, background_request, observe

FFMPEG_LOCK = threading.Lock()
SIZE = 4096
RATE = 48000
# Before download only: silence at either end can add this much; trimmed lengths must match within 3 s.
MAX_UNTRIMMED_DIFFERENCE = 15
SCAN_BATCH = 8
SEARCH_RETRY_SECONDS = (300, 1800, 7200)
BANDS = ((1000, 8000), (14000, 15500), (16000, 17000), (17500, 19000), (19000, 20500))
OFFICIAL_CHANNEL = re.compile(r'(.+?)(?:\s*[-\u2010-\u2015]\s*Topic|\s+Official|\s*VEVO)', re.I)


def official_replacement(track, candidates, search=None):
    artist = track['artist']
    title = normal(presentation_title(track['title'], artist))
    eligible = []
    for candidate in rank_matches(track, candidates, search=search):
        official = OFFICIAL_CHANNEL.fullmatch(candidate.get('channel') or '')
        if (candidate['source_tier'] <= 2 and candidate.get('id') != track['id']
                and normal(presentation_title(candidate.get('title') or '', artist)) == title
                and (not official or normal(official[1]) == normal(artist))):
            eligible.append(candidate)
    return preferred_match(eligible)


def manual_match(track, candidate):
    proposal = official_replacement(track, [candidate]) if candidate else None
    durations = (track.get('duration'), proposal.get('duration')) if proposal else ()
    if (not durations or not all(type(d) in (int, float) and math.isfinite(d) and d > 0 for d in durations)
            or abs(durations[0] - durations[1]) > MAX_UNTRIMMED_DIFFERENCE):
        return None
    return proposal


def automatic_match(track, candidate):
    if (not candidate or not re.fullmatch(r'[A-Za-z0-9_-]{11}', track.get('id') or '')
            or not re.fullmatch(r'[A-Za-z0-9_-]{11}', candidate.get('id') or '')
            or candidate['id'] == track['id'] or not close_duration(track.get('duration'), candidate.get('duration'))):
        return None
    artist = normal(track.get('artist'))
    channel = candidate.get('channel') or ''
    official = OFFICIAL_CHANNEL.fullmatch(channel)
    if not artist or not official or normal(official[1]) != artist:
        return None

    title = normal(presentation_title(track['title'], track['artist']))
    if not title or any(normal(presentation_title(value, track['artist'])) != title
                        for value in (candidate.get('title') or '', candidate.get('track_title') or track['title'])):
        return None
    if candidate.get('artist') and normal(candidate['artist']) != artist:
        return None
    return official_replacement(track, [candidate])


class ScanPaused(Exception):
    pass


class SourceCheckError(ValueError):
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


def analyze(path, duration, idle=lambda: True, ffmpeg='ffmpeg', governor=None):
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
            command = background_command(audio_command(command))
            permit = governor.compute(True, start_offline=True) if governor else nullcontext(True)
            with FFMPEG_LOCK, permit as granted:
                if not granted or not idle():
                    raise ScanPaused()
                options = {'creationflags': subprocess.BELOW_NORMAL_PRIORITY_CLASS} if os.name == 'nt' else {}
                with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options) as process:
                    elapsed = 0
                    interval = 30 if governor else .2
                    while True:
                        try:
                            output, _ = process.communicate(timeout=interval)
                            break
                        except subprocess.TimeoutExpired:
                            elapsed += interval
                            if (governor is None and not idle()) or elapsed >= 30:
                                process.kill()
                                process.communicate()
                                if not idle():
                                    raise ScanPaused()
                                raise TimeoutError('Audio measurement timed out')
                    if process.returncode:
                        return dict(verdict='suspect', issue='decode_failed', bands_db=[])
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
    def __init__(self, workspace, intake, idle=lambda: True, review=None, limit_search=False, candidate_ready=lambda: None):
        self.workspace = Path(workspace)
        self.path = self.workspace / '.source-quality.json'
        self.intake, self.idle, self.review = intake, idle, review
        self.limit_search = limit_search
        self.candidate_ready = candidate_ready
        self.lock = threading.RLock()
        self.scan_lock = threading.Lock()
        self.replace_lock = threading.Lock()
        self.activity = WorkerActivity('source-quality', 'Source-quality scan')
        self.replacement_activity = WorkerActivity('source-replace', 'Source replacement')
        self.active_keys = None
        self.stop = threading.Event()
        try:
            self.rows = json.loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(self.rows, dict):
                self.rows = {}
        except (OSError, ValueError):
            self.rows = {}
        journal = self.replacements()
        for row in self.rows.values():
            event = journal.get(row['id'], {})
            if event.get('old_sha256') == row.get('sha256') and event.get('state') == 'undone':
                row.update(replacing=False, queued=False, replaced_by=None, automatic_skipped=True, replacement_error=None)
            if row.get('replacing') and row.get('queued'):
                row.update(replacing=False, queued=False)
            elif row.get('replacing'):
                row.update(replacing=False, automatic_skipped=True,
                           replacement_error='Replacement interrupted. Check the replacement archive before retrying.')
            if row.get('proposed_replacement') and not official_replacement(row, [row['proposed_replacement']]):
                row.update(proposed_replacement=None, replacement_checked=False)

    def replacements(self):
        journal = self.workspace / '.replacements.json'
        # Windows may block journal replacement while another thread has its file open.
        with self.review.lock if self.review else nullcontext():
            try:
                return json.loads(journal.read_text(encoding='utf-8'))
            except FileNotFoundError:
                return {}

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
            deferred = False
            work = 0
            for item in sorted(self.workspace.iterdir()):
                if not self.idle() or self.stop.is_set():
                    return
                if not self.intake.ID_RE.fullmatch(item.name) or not item.name.startswith(('yt-', 'local-')):
                    continue
                try:
                    directory, manifest = self.intake.read_manifest(str(item))
                    if not manifest.get('import') or manifest.get('edit'):
                        continue
                    stat = self.intake.regular_file(os.path.join(directory, manifest['audio']['file']), 'staged audio')
                    stamp = [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino]
                    source = manifest['source']
                    identifier = source['id'] if source['kind'] == 'youtube' else manifest['id']
                    digest = manifest['audio']['sha256']
                    key = identifier + ':' + digest
                    active_keys.add(key)
                    with self.lock:
                        row = copy.deepcopy(self.rows.get(key))
                        if self.active_keys is not None:
                            self.active_keys.add(key)
                    if row is not None and any(row.get(flag) for flag in ('dismissed', 'replaced_by', 'replacing')):
                        continue
                    if row is not None and not row.get('channel'):
                        row['channel'] = source.get('channel') or manifest['import']['artist']
                        self.save(key, row)
                    if row is None or row.get('stamp', stamp) != stamp:
                        if self.limit_search and work >= SCAN_BATCH:
                            return True
                        work += 1
                        _, checked, audio = self.intake.load_item(str(item))
                        if checked != manifest:
                            continue
                        record = manifest['import']
                        metadata = self.review.overrides(identifier, record['library_sha256']) if self.review else {}
                        track = seed(source, dict(title=metadata.get('title', record['title']), channel=metadata.get('artist', record['artist']),
                                                  duration=manifest['audio']['duration']))
                        tier = source_tier(source, track['artist']) if source['kind'] == 'youtube' else None
                        with self.activity.track(record['title']):
                            result = analyze(audio, manifest['audio']['duration'], self.idle,
                                             governor=getattr(self.intake, 'RESOURCES', None))
                        row = dict(id=identifier, sha256=digest, stamp=stamp, channel=source.get('channel', record['artist']), **track, **result, source_tier=tier,
                                   proposed_replacement=None, replacement_checked=False)
                        self.save(key, row)
                    if (row['verdict'] == 'suspect' or row['source_tier'] == 3) and not row.get('replacement_checked'):
                        if not self.idle():
                            return
                        if row.get('retry_at', 0) > time.time():
                            deferred = True
                            continue
                        if self.limit_search:
                            if work >= SCAN_BATCH:
                                return True
                            if not self.review.reserve_automatic('source search'):
                                deferred = True
                                continue
                        work += 1
                        query = (row['artist'].split(',')[0] + ' ' + row['title'])[:200]
                        with self.activity.track(row['title']):
                            def search(args):
                                args.youtube_caller = 'quality'
                                args.youtube_background = True
                                args.main_only = self.limit_search
                                return self.intake.cmd_search(args)
                            try:
                                found = search(SimpleNamespace(query=query, limit=30, offset=0))['results']
                            except (OSError, ValueError, KeyError, self.intake.IntakeError):
                                attempts = row.get('search_attempts', 0)
                                with self.lock:
                                    current = self.rows[key]
                                    retry = (dict(retry_at=time.time() + SEARCH_RETRY_SECONDS[attempts],
                                                  retry_reason='Source search unavailable') if attempts < len(SEARCH_RETRY_SECONDS)
                                             else dict(retry_at=0, retry_reason='Source search unavailable', replacement_checked=True))
                                    self.save(key, dict(current, search_attempts=attempts+1, **retry))
                                deferred |= bool(retry['retry_at'])
                                continue
                            if not self.idle():
                                return
                            if self.limit_search:
                                strict = [match for candidate in found if (match := automatic_match(row, candidate))]
                                row['proposed_replacement'] = preferred_match(strict) or official_replacement(row, found)
                            else:
                                row['proposed_replacement'] = official_replacement(row, found, search=search)
                        row['replacement_checked'] = True
                        with self.lock:
                            current = self.rows[key]
                            self.save(key, dict(current, proposed_replacement=row['proposed_replacement'], replacement_checked=True,
                                                retry_at=0, retry_reason=''))
                        if self.limit_search and strict:
                            self.candidate_ready()
                except ScanPaused:
                    return
                except (OSError, ValueError, KeyError, self.intake.IntakeError) as error:
                    logging.getLogger(__name__).warning('Source quality %s: %s', item.name, type(error).__name__)
            with self.lock:
                self.active_keys = active_keys
            return deferred
        finally:
            self.scan_lock.release()

    def snapshot(self):
        with self.lock:
            journal = self.replacements()
            rows = copy.deepcopy([row for key, row in self.rows.items()
                                  if self.active_keys is None or key in self.active_keys])
        counts = {verdict: sum(r['verdict'] == verdict for r in rows) for verdict in ('clean', 'suspect', 'unknown')}
        counts['tier_3'] = sum(r['source_tier'] == 3 for r in rows)
        counts['total'] = len(rows)
        songs = []
        retry = self.review.automatic_retry('source search') if self.limit_search else 0
        for row in rows:
            event = journal.get(row['id'], {})
            if row.get('dismissed') or row.get('replaced_by') or (
                    event.get('state') in ('done', 'undoing') and event.get('old_sha256') == row.get('sha256')):
                continue
            candidate = row.get('proposed_replacement')
            row['proposed_replacement'] = manual_match(row, candidate)
            row.pop('stamp', None)
            if not row.get('replacement_checked'):
                if retry and retry > row.get('retry_at', 0):
                    row.update(retry_at=retry, retry_reason='Hourly catalogue limit')
                elif retry is None:
                    row.update(retry_at=0, retry_reason='Automatic source search is off')
            if row['verdict'] == 'suspect' or row['source_tier'] == 3 and (row['proposed_replacement'] or row.get('replacing')):
                songs.append(row)
        counts['damaged'] = sum(row['verdict'] == 'suspect' for row in songs)
        counts['unofficial'] = len(songs) - counts['damaged']
        fixed = [dict(id=identifier, replaced_by=event['new_id'], title=event['automatic']['title'],
                      artist=event['automatic']['artist'], fixed_at=event['automatic']['fixed_at'])
                 for identifier, event in journal.items()
                 if event.get('state') in ('done', 'undoing') and event.get('automatic')]
        return dict(counts=counts, songs=songs, fixed=sorted(fixed, key=lambda row: row['fixed_at'], reverse=True))


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


def replace_saved(workspace, library, old_id, candidate, saved_source, playlists, review, stats, intake, length=None,
                  automatic=None, expected_digest=None, verified_digest=None):
    """Archive originals and retain metadata snapshots for manual undo and crash recovery."""
    workspace, library = Path(workspace), Path(library)
    old, new = saved_source(old_id), saved_source(candidate['id'])
    if not old or not new:
        raise SourceCheckError('Both recordings must be saved before replacement.')
    if expected_digest is not None and old['manifest']['audio']['sha256'] != expected_digest:
        raise SourceCheckError('The original recording changed before replacement.')
    if verified_digest is not None and new['manifest']['audio']['sha256'] != verified_digest:
        raise SourceCheckError('The replacement recording changed after verification.')
    old_record, new_record = old['manifest']['import'], new['manifest']['import']
    # Compare the lengths people hear: uploads often carry extra silence that is trimmed away.
    measure = length or (lambda saved: saved['manifest']['audio']['duration'])
    if not close_duration(measure(old), measure(new)):
        raise SourceCheckError(f'After trimming silence, the recordings differ by more than {MATCH_DURATION_SECONDS} seconds.')
    item = Path(old['item'])
    target = library.joinpath(*old_record['path'].split('/'))
    new_target = library.joinpath(*new_record['path'].split('/'))
    if (item.parent.resolve() != workspace.resolve() or not intake.inside(str(target), str(library))
            or not intake.inside(str(new_target), str(library))
            or target.resolve() == new_target.resolve()):
        raise SourceCheckError('The original recording cannot be safely archived.')
    archive = workspace / '.replaced' / old_id
    journal = workspace / '.replacements.json'
    records = json.loads(journal.read_text(encoding='utf-8')) if journal.exists() else {}
    if records.get(candidate['id'], {}).get('state') in ('done', 'pending', 'undoing') or any(
            event['new_id'] == old_id and event['state'] in ('done', 'undoing') for event in records.values()):
        raise SourceCheckError('Undo the earlier source replacement before replacing this recording.')
    if archive.exists() and records.get(old_id, {}).get('state') not in ('rolled_back', 'undone'):
        raise SourceCheckError('A previous replacement archive needs review before retrying.')
    moves = ((target, archive / 'library' / target.name), (item, archive / item.name))
    if any(os.path.lexists(destination) for _, destination in moves):
        raise SourceCheckError('The replacement archive already contains files for this recording.')
    archive.mkdir(parents=True, exist_ok=True)
    entry = dict(new_id=candidate['id'], match=dict(candidate), state='pending', item=str(item), library_file=str(target),
                 old_sha256=old['manifest']['audio']['sha256'], backups=[])
    if automatic:
        entry['automatic'] = {**automatic, 'fixed_at': int(time.time())}
    new_digest = new_record['library_sha256']
    previous_entry = review.data['overrides'].get(candidate['id'], {})
    if previous_entry.get('sha256') != new_digest:
        previous_entry = {}
    previous_values = previous_entry.get('values', {})
    transferred = {key: value for key, value in review.overrides(old_id, old_record['library_sha256']).items()
                   if key not in previous_values and (new_record.get('automatic_title') is not False or key not in new_record)}
    if automatic and transferred:
        entry['transferred_metadata'] = dict(sha256=new_digest, values=transferred)
    records[old_id] = entry

    def backup(path):
        if path.exists():
            destination = archive / ('metadata-' + str(len(entry['backups'])) + '.json')
            shutil.copy2(path, destination)
            entry['backups'].append(dict(path=str(path), backup=str(destination)))

    changes = []
    for path in playlists.root.glob('*/*.json'):
        data = json.loads(path.read_text(encoding='utf-8'))
        changed = False
        for row in data['tracks']:
            if row.get('source_id') == old_id or (row.get('match') or {}).get('id') == old_id:
                repoint_recording(row, old_id, entry)
                changed = True
        if changed:
            data['revision'] = data.get('revision', 0) + 1
            backup(path)
            changes.append((path, data))
    review.flush()
    backup(review.path)
    lyrics = workspace / '.lyrics' / (old_id + '.json')
    new_lyrics = lyrics.with_name(candidate['id'] + '.json')
    backup(new_lyrics)
    entry['lyrics_created'] = str(new_lyrics) if lyrics.exists() and not new_lyrics.exists() else None
    write_json(journal, records)
    old_review, old_devices = copy.deepcopy(review.data), copy.deepcopy(stats.devices)
    moved = []
    try:
        if transferred:
            review.data['overrides'][candidate['id']] = dict(previous_entry, sha256=new_digest,
                                                            values={**previous_values, **transferred})
            review.dirty = True
            review.flush()
        for device in stats.devices.values():
            track = device.get('track')
            if isinstance(track, dict) and track.get('id') == old_id:
                track.update(id=candidate['id'])
        # Statistics contain aggregate counters, so their persisted totals need no conversion.
        for path, data in changes:
            write_json(path, data)
        if lyrics.exists() and not new_lyrics.exists():
            shutil.copy2(lyrics, new_lyrics)
        for source, destination in moves:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
            moved.append((source, destination))
        entry['state'] = 'done'
        write_json(journal, records)
    except Exception:
        for source, destination in reversed(moved):
            shutil.move(str(destination), str(source))
        for row in entry['backups']:
            shutil.copy2(row['backup'], row['path'])
        if entry['lyrics_created']:
            Path(entry['lyrics_created']).unlink(missing_ok=True)
        review.data, stats.devices = old_review, old_devices
        review.dirty = True
        review.flush()
        entry['state'] = 'rolled_back'
        write_json(journal, records)
        raise


def undo_saved(workspace, library, old_id, records, playlists, review):
    """Resume a restore from its journal, changing only entries still using this replacement."""
    entry = records.get(old_id, {})
    if not entry.get('automatic') or entry.get('state') not in ('done', 'undoing', 'undone'):
        raise ValueError('This automatic replacement is unavailable. Refresh the review in Server work.')
    if entry['state'] == 'undone':
        return entry['old_sha256']
    root = Path(workspace)
    archive = root / '.replaced' / old_id
    item, library_file = Path(entry['item']), Path(entry['library_file'])
    if item.resolve().parent != root.resolve() or not library_file.resolve().is_relative_to(Path(library).resolve()):
        raise ValueError('The original recording cannot be restored outside the library and workspace.')
    moves = ((archive / 'library' / library_file.name, library_file), (archive / item.name, item))
    for source, destination in moves:
        if os.path.lexists(source) == os.path.lexists(destination) or entry['state'] == 'done' and not source.exists():
            raise ValueError('The original file cannot be restored safely. Check the replacement archive.')
    entry['state'] = 'undoing'
    journal = root / '.replacements.json'
    write_json(journal, records)
    for source, destination in moves:
        if source.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
    for path in playlists.root.glob('*/*.json'):
        data = json.loads(path.read_text(encoding='utf-8'))
        changed = False
        for track in data['tracks']:
            origins = track.get('replacement_origins', {})
            if old_id not in origins:
                continue
            origin = origins.pop(old_id)
            if (track.get('source_id') or (track.get('match') or {}).get('id')) == entry['new_id']:
                for field in ('source_id', 'match', 'state', 'job_id'):
                    track.pop(field, None)
                track.update(origin)
            if not origins:
                track.pop('replacement_origins', None)
            changed = True
        if changed:
            data['revision'] = data.get('revision', 0) + 1
            write_json(path, data)
    transferred = entry.get('transferred_metadata')
    if transferred:
        saved = review.data['overrides'].get(entry['new_id'], {})
        if saved.get('sha256') == transferred['sha256']:
            remaining = {key: value for key, value in saved['values'].items()
                         if key in saved.get('manual', ()) or transferred['values'].get(key) != value}
            if remaining != saved['values']:
                review.data['overrides'][entry['new_id']] = dict(saved, values=remaining)
                review.dirty = True
                review.flush()
    entry['state'] = 'undone'
    write_json(journal, records)
    return entry['old_sha256']


def register(app, workspace, intake, idle, admin, review, enabled=True, replace=None, busy=lambda identifier: False,
             automatic_user=None, undo=None):
    from flask import jsonify, request, g
    automatic_user = automatic_user if enabled and review.automatic_limit > 0 else None
    review.source_automation = bool(automatic_user)
    pending = queue.Queue()
    scanner = SourceQuality(workspace, intake, idle, review, limit_search=enabled,
                            candidate_ready=lambda: pending.put(None) if automatic_user else None)
    app.extensions['music'].source_quality = scanner

    def visible(key, row):
        return (not row.get('dismissed') and not row.get('replaced_by')
                and (scanner.active_keys is None or key in scanner.active_keys))

    def enqueue(key, row, candidate, user):
        scanner.save(key, dict(row, replacing=True, queued=True, replacement_error=None))
        pending.put((key, row['id'], candidate, user, None, row['sha256']))

    def automatic_job():
        if not automatic_user or not idle():
            return None
        with scanner.lock:
            rows = [(key, row) for key, row in scanner.rows.items() if visible(key, row) and not any(
                row.get(flag) for flag in ('replacing', 'automatic_skipped', 'replacement_error'))]
            journal = scanner.replacements()
        for key, row in rows:
            event = journal.get(row['id'], {})
            if (event.get('state') in ('done', 'undoing', 'undone', 'pending')
                    or any(entry['new_id'] == row['id'] and entry['state'] in ('done', 'undoing') for entry in journal.values())
                    or not (row['verdict'] == 'suspect' or row['source_tier'] == 3)):
                continue
            candidate = automatic_match(row, row.get('proposed_replacement'))
            if not candidate or busy(row['id']) or busy(candidate['id']) or not idle():
                continue
            with scanner.lock:
                if scanner.rows.get(key) is not row:
                    continue
                if not review.reserve_automatic('source replacement'):
                    return None
                scanner.save(key, dict(row, replacing=True, queued=True, replacement_error=None))
            details = dict(title=row['title'], artist=row['artist'], duration=row['duration'], damaged=row['verdict'] == 'suspect')
            return (key, row['id'], candidate, automatic_user, details, row['sha256'])

    def work():
        background_request.set(True)
        while not scanner.stop.is_set():
            try:
                job = pending.get(timeout=30)
            except queue.Empty:
                job = None
            if job is None:
                try:
                    job = automatic_job()
                except Exception as error:
                    app.logger.warning('Automatic source selection: %s', type(error).__name__)
                    continue
            if job is None:
                continue
            key, identifier, candidate, user, automatic, digest = job
            try:
                while not idle() or busy(identifier) or busy(candidate['id']):
                    if scanner.stop.wait(30):
                        return
                with scanner.replace_lock:
                    with scanner.lock:
                        scanner.save(key, dict(scanner.rows[key], queued=False))
                    with scanner.replacement_activity.track(candidate['title']), observe(getattr(intake, 'RESOURCES', None), 'source replacement'):
                        replace(user, identifier, candidate, automatic, digest)
                    with scanner.lock:
                        scanner.save(key, dict(scanner.rows[key], replacing=False, queued=False, replaced_by=candidate['id']))
            except ScanPaused:
                with scanner.lock:
                    scanner.save(key, dict(scanner.rows[key], replacing=not automatic, queued=not automatic))
                if not automatic:
                    pending.put(job)
            except Exception as error:
                app.logger.warning('Source replacement failed: %s', type(error).__name__)
                with scanner.lock:
                    scanner.save(key, dict(scanner.rows[key], replacing=False, queued=False,
                                           automatic_skipped=bool(automatic), replacement_error=str(error) if isinstance(error, SourceCheckError) else (
                                               'Automatic replacement stopped. Compare the recordings before trying again.' if automatic else
                                               'Replacement failed. Review the saved recording and try again.')))

    if replace is not None:
        threading.Thread(target=work, name='source-replace', daemon=True).start()

    @app.post('/api/catalogue/source-quality/replace-all')
    def source_quality_replace_all():
        if not admin():
            return jsonify(error='Only the admin can review source quality.'), 403
        data = request.get_json(silent=True)
        group = data.get('group') if isinstance(data, dict) else None
        if group not in ('damaged', 'unofficial'):
            return jsonify(error='Choose damaged or unofficial songs.'), 400
        if replace is None:
            return jsonify(error='Replacement is not available on this server.'), 409
        queued = 0
        with scanner.lock:
            for key, row in list(scanner.rows.items()):
                if not visible(key, row) or row.get('replacing') or (row.get('verdict') == 'suspect') != (group == 'damaged'):
                    continue
                candidate = manual_match(row, row.get('proposed_replacement'))
                if candidate:
                    enqueue(key, row, candidate, g.user)
                    queued += 1
        return jsonify(state='replacing', queued=queued), 202

    @app.post('/api/catalogue/source-quality/<identifier>/<action>')
    def source_quality_action(identifier, action):
        if not admin():
            return jsonify(error='Only the admin can review source quality.'), 403
        if action == 'undo':
            if undo is None or not scanner.replace_lock.acquire(blocking=False):
                return jsonify(error='Wait for the active replacement, then try Undo again.'), 409
            try:
                if busy(identifier):
                    return jsonify(error='This recording is being prepared. Try Undo again when it finishes.'), 409
                digest = undo(identifier, scanner.replacements())
                with scanner.lock:
                    key = identifier + ':' + digest
                    if key in scanner.rows:
                        scanner.save(key, dict(scanner.rows[key], replaced_by=None, replacing=False, queued=False,
                                               automatic_skipped=True, replacement_error=None))
                        if scanner.active_keys is not None:
                            scanner.active_keys.add(key)
            except ValueError as error:
                return jsonify(error=str(error)), 409
            except OSError:
                return jsonify(error='The recording could not be restored. Try Undo again.'), 409
            finally:
                scanner.replace_lock.release()
            return jsonify(state='undone')
        if action not in ('replace', 'dismiss'):
            return jsonify(error='Unknown source quality action.'), 404
        with scanner.lock:
            found = next(((key, row) for key, row in scanner.rows.items() if row['id'] == identifier and visible(key, row)), None)
            if not found:
                return jsonify(error='Song review not found.'), 404
            key, row = found
            if row.get('replacing'):
                return jsonify(error='This song is being replaced.'), 409
            if action == 'dismiss':
                scanner.save(key, dict(row, dismissed=True))
                return jsonify(state='done')
            data = request.get_json(silent=True)
            candidate = row.get('proposed_replacement')
            if not isinstance(data, dict) or not candidate or data.get('candidate_id') != candidate['id']:
                return jsonify(error='Choose the proposed official recording.'), 400
            candidate = manual_match(row, candidate)
            if not candidate:
                return jsonify(error='Choose an official recording with a matching title, artist and duration, within 15 seconds of this song.'), 400
            if replace is None:
                return jsonify(error='Replacement is not available on this server.'), 409
            enqueue(key, row, candidate, g.user)
        return jsonify(state='replacing'), 202

    @app.get('/api/catalogue/source-quality')
    def source_quality():
        if not admin():
            return jsonify(error='Only the admin can review source quality.'), 403
        return jsonify(scanner.snapshot())

    def scan():
        background_request.set(True)
        while not scanner.stop.wait(30):
            deferred = False
            try:
                deferred = scanner.scan_once()
            except Exception as error:
                app.logger.warning('Source quality: %s', type(error).__name__)
            if scanner.stop.wait(90 if deferred else 1800 if idle() else 0):
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
