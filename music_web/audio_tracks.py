"""Add external movie audio from files already present on the server."""
from contextlib import contextmanager
from copy import deepcopy
from functools import lru_cache
from itertools import accumulate
from mmap import ACCESS_READ, mmap
from statistics import median
from hashlib import sha256
import cmath
import json
import logging
import math
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
from tempfile import TemporaryDirectory
from threading import Lock, Thread
from time import monotonic

from flask import abort, g, jsonify, request

from .movie_media import ITEM
from .resources import lower_background_priority
from .state import state_path, write_json


log = logging.getLogger(__name__)
DATA = Path('/srv/familyhub/data')
SOURCES = (DATA / 'downloads/complete', DATA / 'imports')
LIBRARIES = {kind: DATA / 'media' / kind for kind in ('movies', 'tv')}
FORMATS = {
    '.mkv': 'matroska', '.webm': 'matroska', '.mka': 'matroska',
    '.mp4': 'mov', '.m4v': 'mov', '.mov': 'mov', '.m4a': 'mov',
    '.avi': 'avi', '.ts': 'mpegts', '.m2ts': 'mpegts', '.mpg': 'mpeg', '.mpeg': 'mpeg',
    '.aac': 'aac', '.ac3': 'ac3', '.eac3': 'eac3', '.mp3': 'mp3',
    '.flac': 'flac', '.wav': 'wav', '.ogg': 'ogg', '.opus': 'ogg',
}
VIDEO = {ext for ext in FORMATS if ext in {
    '.mkv', '.webm', '.mp4', '.m4v', '.mov', '.avi', '.ts', '.m2ts', '.mpg', '.mpeg'}}
LANGUAGES = {
    'hu': ('hun', 'Hungarian'), 'en': ('eng', 'English'), 'de': ('deu', 'German'),
    'fr': ('fra', 'French'), 'it': ('ita', 'Italian'), 'es': ('spa', 'Spanish'),
    'pt': ('por', 'Portuguese'), 'ja': ('jpn', 'Japanese'), 'pl': ('pol', 'Polish'),
    'cs': ('ces', 'Czech'), 'sk': ('slk', 'Slovak'), 'ro': ('ron', 'Romanian'),
    'uk': ('ukr', 'Ukrainian'), 'ru': ('rus', 'Russian'), 'zh': ('zho', 'Chinese'),
}
EPISODE = re.compile(r'(?<![a-z0-9])s(\d{1,2})e(\d{1,3})(?!\d|e\d)', re.I)
MAX_SECONDS = 6 * 3600
PAGE = 4
HISTORY = 32


@lru_cache(maxsize=8)
def fft_plan(size):
    bits = size.bit_length() - 1
    order = [0] * size
    for i in range(1, size):
        order[i] = (order[i >> 1] >> 1) | ((i & 1) << (bits - 1))
    roots = [cmath.exp(-2j * math.pi * i / size) for i in range(size // 2)]
    return order, roots


def fft(values, size, inverse=False):
    order, roots = fft_plan(size)
    result = [values[i] if i < len(values) else 0j for i in order]
    width = 2
    while width <= size:
        half = width // 2
        weights = roots[::size // width]
        if inverse:
            weights = [weight.conjugate() for weight in weights]
        for start in range(0, size, width):
            for index, weight in enumerate(weights, start):
                left, right = result[index], result[index + half] * weight
                result[index], result[index + half] = left + right, left - right
        width <<= 1
    return result


def convolution(signal, template):
    size = 1 << (len(signal) + len(template) - 2).bit_length()
    try:
        import numpy as np
    except ImportError:
        signal_fft, template_fft = fft(signal, size), fft(template, size)
        products = [a * b for a, b in zip(signal_fft, template_fft)]
        result = fft(products, size, inverse=True)
        return [value.real / size for value in result[len(template) - 1:len(signal)]]
    result = np.fft.irfft(np.fft.rfft(signal, size) * np.fft.rfft(template, size), size)
    return result[len(template) - 1:len(signal)]


def audio_features(samples, smooth):
    frames = zip(*[iter(samples)] * 80)
    levels = [math.log1p(math.sqrt(sum(value * value for value in frame) / 80) / 32) for frame in frames]
    if smooth and len(levels) >= 11:
        sums = list(accumulate(levels, initial=0.))
        return [(sums[min(len(levels), i + 6)] - sums[max(0, i - 5)]) / 11 for i in range(len(levels))]
    return levels


def estimate_sync(target_pcm, source_pcm, less_certain=False):
    """Estimate source time = target time * speed + intercept, using five local FFT matches."""
    return match_features(audio_features(target_pcm, less_certain),
                          audio_features(source_pcm, less_certain), less_certain)


def match_features(target, source, less_certain):
    rate = 100
    if min(len(target), len(source)) < 8 * rate:
        raise ValueError('The audio is too short to match.')
    window = min(20 * rate, len(target) // 7)
    span = min(len(target), int(len(source) / 1.05))
    points = [round(window / 2 + i * (span - window) / 6) for i in range(1, 6)]
    threshold = .32 if less_certain else .40

    def match(point, speed, radius):
        start = point - window // 2
        original = target[start:start + window]
        stretched = []
        for index in range(round(window * speed)):
            sample = min(index / speed, len(original) - 1)
            lower, upper = int(sample), min(int(sample) + 1, len(original) - 1)
            stretched.append(original[lower] + (sample - lower) * (original[upper] - original[lower]))
        mean = sum(stretched) / len(stretched)
        stretched = [value - mean for value in stretched]
        predicted = round(start * speed)
        size = len(stretched)
        lo, hi = max(0, predicted - radius), min(len(source), predicted + radius + size)
        segment = source[lo:hi]
        norm = math.sqrt(sum(value * value for value in stretched))
        if len(segment) < size or norm < .015 * math.sqrt(size):
            return 0., 0.
        numerator = convolution(segment, stretched[::-1])
        sums = list(accumulate(segment, initial=0.))
        squares = list(accumulate((value ** 2 for value in segment), initial=0.))
        best, lag = 0., 0.
        for index, dot in enumerate(numerator):
            power = squares[index + size] - squares[index] - (sums[index + size] - sums[index]) ** 2 / size
            score = dot / (math.sqrt(max(power, 1e-8)) * norm)
            if score > best:
                best, lag = min(1., float(score)), lo + index - start * speed
        return lag, best

    pal = 25 * 1001 / 24000
    standard = (1., pal, 1 / pal, 1000 / 1001, 1001 / 1000)
    radius = min(90 * rate, max(4 * rate, span // 8))
    def assess(speed):
        matches = [match(point, speed, radius) for point in points]
        return median(score for _, score in matches), speed, matches

    candidates = [assess(speed) for speed in standard]
    score, speed, matches = max(candidates)
    if score < .60:
        score, speed, matches = max([*candidates, *(assess(1 + step / 200) for step in range(-10, 11) if step)])
    good = [(point, lag) for point, (lag, score) in zip(points, matches) if score >= threshold]
    if len(good) >= 3:
        slopes = [(lag_b - lag_a) / (point_b - point_a)
                  for index, (point_a, lag_a) in enumerate(good) for point_b, lag_b in good[index + 1:]]
        inferred = speed + median(slopes)
        if .94 <= inferred <= 1.06:
            refined = next((known for known in standard if abs(inferred - known) < .00025), inferred)
            # A cut can resemble gradual drift. Keep the original candidate unless the fit improves.
            refined_matches = assess(refined) if refined != speed else (score, speed, matches)
            if refined_matches[0] >= score - .03:
                score, speed, matches = refined_matches
    lags = [lag for lag, peak in matches if peak >= threshold]
    confidence = 'low'
    if len(lags) < 3:
        return dict(offset_ms=0, speed_ratio=1., confidence=confidence, less_certain=less_certain,
                    deviation_ms=None, cut_warning=False, matched=False)
    intercept = median(lags)
    deviation = max(abs(lag - intercept) for lag in lags)
    cut_warning = deviation > rate * .3
    if not cut_warning and (not less_certain or score >= .45):
        confidence = 'high' if len(lags) == 5 and score >= .74 and not less_certain else 'medium'
    offset = round(-1000 * intercept / rate / speed)
    return dict(offset_ms=offset if abs(offset) >= 20 else 0, speed_ratio=round(speed, 7),
                confidence=confidence, less_certain=less_certain, deviation_ms=round(deviation * 1000 / rate / speed),
                cut_warning=cut_warning, matched=True)


def safe_name(name):
    return name not in ('', '.', '..') and not name.startswith('-') and not any(ord(c) < 32 for c in name)


@contextmanager
def opened(path, directory=False):
    """Walk from the root with no-follow directory descriptors, then pin the requested inode."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    # Folders on the way are only passed through (O_PATH needs search permission, not read permission): the service
    # may cross /srv/familyhub without being allowed to list it. The last component is opened for reading.
    walk = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_DIRECTORY
    handle = os.open(path.anchor, walk)
    try:
        for index, part in enumerate(path.parts[1:], 2):
            if not safe_name(part):
                raise ValueError('Invalid media name.')
            last = index == len(path.parts)
            if last:
                child = os.open(part, flags | (os.O_DIRECTORY if directory else os.O_NONBLOCK), dir_fd=handle)
            else:
                child = os.open(part, walk, dir_fd=handle)
            os.close(handle)
            handle = child
        if not directory and not stat.S_ISREG(os.fstat(handle).st_mode):
            raise ValueError('Select a regular media file.')
        yield handle
    finally:
        os.close(handle)


def fingerprint(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def candidates():
    count = 0
    for root in SOURCES:
        try:
            with opened(root, directory=True) as root_fd:
                for parent, dirs, files, fd in os.fwalk('.', dir_fd=root_fd):
                    relative = Path(parent)
                    directory = root / relative
                    dirs[:] = sorted(name for name in dirs if safe_name(name))
                    if len(relative.parts) >= 6:
                        dirs.clear()
                    count += len(files) + len(dirs) + 1
                    if count > 8000:
                        return
                    episodes = 0
                    for name in sorted(files):
                        path = directory / name
                        if not safe_name(name) or path.suffix.lower() not in FORMATS:
                            continue
                        try:
                            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        except FileNotFoundError:
                            continue
                        if stat.S_ISREG(info.st_mode):
                            yield root, path, False
                            episodes += bool(EPISODE.search(path.stem))
                    if episodes > 1:
                        yield root, directory, True
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            continue


def source_id(path):
    return sha256(os.fsencode(path)).hexdigest()


def target_path(item):
    raw = item.get('Path')
    if not isinstance(raw, str):
        raise ValueError('The library item has no video file.')
    path = Path(raw)
    for kind, root in LIBRARIES.items():
        mount = Path('/data') / kind
        for prefix in (mount, root):
            if path.is_relative_to(prefix) and path.suffix.lower() in VIDEO:
                return root / path.relative_to(prefix)
    raise ValueError('The library video is outside the movie and TV folders.')


def media_command(tool, path, args, timeout, probe=False, expected=None):
    with opened(path) as fd:
        if expected is not None and fingerprint(os.fstat(fd)) != expected:
            raise ValueError('The media file changed while matching.')
        command = [tool, '-v', 'error']
        if probe:
            command += ['-max_alloc', '67108864', '-probesize', '5000000', '-analyzeduration', '3000000']
        else:
            command += ['-nostdin', '-y', '-filter_threads', '1', '-threads', '1', '-max_alloc', '67108864']
        command += ['-protocol_whitelist', 'file', '-f', FORMATS[path.suffix.lower()]]
        if not probe:
            command += ['-i']
        return subprocess.run([*command, f'/proc/self/fd/{fd}', *args], pass_fds=(fd,), timeout=timeout,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if probe else subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, check=True).stdout


def duration(value):
    try:
        seconds = float(value)
        return round(seconds, 2) if math.isfinite(seconds) and seconds > 0 else None
    except (TypeError, ValueError):
        return None


def probe_audio(tool, path, expected=None):
    raw = media_command(tool, path, ['-select_streams', 'a', '-show_entries',
                         'stream=index,codec_name,channels,duration:stream_tags=language:format=duration',
                         '-of', 'json'], timeout=4, probe=True, expected=expected)
    result = json.loads(raw)
    total = duration(result.get('format', {}).get('duration'))
    return [dict(index=s['index'], codec=s.get('codec_name'), channels=s.get('channels'),
                 language=str(s.get('tags', {}).get('language', 'und'))[:16].lower(),
                 duration=duration(s.get('duration')) or total) for s in result.get('streams', [])[:64]]


def english(streams):
    return next((s['index'] for s in streams if s['language'].split('-')[0] in ('en', 'eng')), None)


def read_features(ffmpeg, path, index, output, smooth, expected):
    media_command(ffmpeg, path, ['-map', f'0:{index}', '-vn', '-sn', '-dn', '-t', str(MAX_SECONDS),
                                '-ac', '1', '-ar', '8000', '-f', 's16le', str(output)], timeout=1800, expected=expected)
    with output.open('rb') as file, mmap(file.fileno(), 0, access=ACCESS_READ) as raw:
        with memoryview(raw).cast('h') as pcm:
            features = audio_features(pcm, smooth)
    output.unlink()
    return features


def write_sidecar(ffmpeg, ffprobe, source, video, stream, language, title, report, source_stamp=None, video_stamp=None):
    with opened(video.parent, directory=True) as folder, opened(video) as video_fd:
        owner = os.fstat(video_fd)
        if video_stamp is None:
            video_stamp = fingerprint(owner)
        name = f'{video.stem}.{language}.mka'
        # Keep the output tied to the opened library directory even if a parent is renamed.
        parent = Path(f'/proc/{os.getpid()}/fd/{folder}')
        with TemporaryDirectory(prefix='.audio-', dir=parent) as temporary:
            output = Path(temporary) / name
            speed, offset = report['speed_ratio'], report['offset_ms']
            filters = []
            if speed != 1:
                filters.append(f'atempo={speed}')
            if offset > 0:
                filters.append(f'adelay={offset}:all=1')
            elif offset < 0:
                filters.extend((f'atrim=start={-offset / 1000}', 'asetpts=PTS-STARTPTS'))
            args = ['-map', f"0:{stream['index']}", '-map_metadata', '-1', '-map_chapters', '-1',
                    '-metadata:s:a:0', 'language=' + LANGUAGES.get(language, (language, title))[0],
                    '-metadata:s:a:0', 'title=' + title, '-disposition:a:0', '0']
            if filters:
                channels = 6 if (stream['channels'] or 2) >= 6 else max(1, min(stream['channels'] or 2, 2))
                args += ['-af', ','.join(filters), '-c:a', 'eac3', '-ac', str(channels),
                         '-b:a', '448k' if channels == 6 else '192k']
            else:
                args += ['-c:a', 'copy']
            media_command(ffmpeg, source, [*args, '-t', str(MAX_SECONDS), '-fs', str(2 << 30),
                                           '-f', 'matroska', str(output)], timeout=3600, expected=source_stamp)
            # The staging directory is private and anchored by the open directory descriptor.
            with output.open('rb+') as out:
                info = os.fstat(out.fileno())
                if info.st_size >= (2 << 30) - (1 << 20):
                    raise ValueError('The audio track is too large.')
                # Probe via the pinned fd path since the staging path itself traverses /proc.
                verified = subprocess.run([ffprobe, '-v', 'error', '-protocol_whitelist', 'file', '-f', 'matroska',
                                           '-select_streams', 'a', '-show_entries', 'stream=index',
                                           '-of', 'csv=p=0', f'/proc/self/fd/{out.fileno()}'],
                                          pass_fds=(out.fileno(),), timeout=4, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, check=True)
                if not verified.stdout.strip():
                    raise ValueError('The written audio could not be read.')
                if (info.st_uid, info.st_gid) != (owner.st_uid, owner.st_gid):
                    os.fchown(out.fileno(), owner.st_uid, owner.st_gid)
                os.fchmod(out.fileno(), 0o660)
                os.fsync(out.fileno())
                if fingerprint(os.stat(video.name, dir_fd=folder, follow_symlinks=False)) != video_stamp:
                    raise ValueError('The library video changed while matching.')
                # Publish atomically with exclusive creation so two writers cannot replace an existing track.
                os.link(output, name, dst_dir_fd=folder, follow_symlinks=False)
                os.fsync(folder)
                return video.with_name(name), fingerprint(os.fstat(out.fileno()))


def episode_pairs(library, item, choice, rows):
    root, path, folder = choice
    if not folder:
        return [(item, root, path)]
    if item.get('Type') == 'Season':
        series, season = item.get('SeriesId'), item.get('IndexNumber')
    else:
        series, season = item.get('SeriesId'), item.get('ParentIndexNumber')
    if not isinstance(series, str) or not re.fullmatch(ITEM, series, re.I) or type(season) is not int:
        raise ValueError('Choose a season folder for an episode or season.')
    episodes = library(f'Shows/{series}/Episodes', dict(season=season, fields='Path', limit=101)).get('Items', [])
    if len(episodes) > 100:
        raise ValueError('This season has too many episodes for one batch.')
    matched = {}
    for _, file, group in rows:
        key = EPISODE.search(file.stem)
        if not group and file.parent == path and key and int(key[1]) == season:
            number = int(key[2])
            if number in matched:
                raise ValueError('The source folder contains duplicate episode numbers.')
            matched[number] = file
    return [(episode, root, matched[episode['IndexNumber']]) for episode in episodes
            if episode.get('ParentIndexNumber') == season and episode.get('IndexNumber') in matched]


def register(app, cfg, body, allow, access, audio_library):
    lock, listing = Lock(), Lock()
    state = state_path(cfg, '.movie-audio-jobs.json') if cfg.get('STATE_DIR') else None
    jobs = {}
    busy = False
    catalogue = []
    catalogue_until = 0.
    probe_cache = {}

    def save():
        write_json(state, list(jobs.values()))

    if state and state.exists():
        for job in json.loads(state.read_bytes())[-HISTORY:]:
            if job['state'] in ('Waiting', 'Matching audio', 'Writing audio'):
                job['state'] = 'Interrupted'
                for result in job['results']:
                    if result['state'] in ('Waiting', 'Matching audio', 'Writing audio'):
                        result['state'] = 'Interrupted'
            jobs[job['id']] = job

    def require(operation, count):
        if not access():
            abort(403)
        if not allow('movie-audio-' + operation + ':' + g.user, count, 60):
            abort(429)

    def tools():
        try:
            return app.intake.tool('ffmpeg'), app.intake.tool('ffprobe')
        except app.intake.IntakeError:
            abort(503, 'FFmpeg and FFprobe are required.')

    def list_sources():
        nonlocal catalogue, catalogue_until
        if monotonic() >= catalogue_until:
            catalogue = list(candidates())
            probe_cache.clear()
            catalogue_until = monotonic() + 30
        return catalogue

    def safe_streams(ffprobe, path):
        try:
            return probe_audio(ffprobe, path)
        except (OSError, ValueError, subprocess.SubprocessError):
            return []

    @app.get('/api/movies/audio-sources')
    def movie_audio_sources():
        require('sources', 18)
        item = request.args.get('item', '')
        offset = request.args.get('offset', '0')
        if not re.fullmatch(ITEM, item, re.I) or not re.fullmatch(r'\d{1,4}', offset):
            abort(400)
        _, ffprobe = tools()
        if not listing.acquire(blocking=False):
            return jsonify(error='Wait for the current source check to finish.'), 409
        try:
            rows = list_sources()
            start = int(offset)
            results = []
            for root, path, folder in rows[start:start + PAGE]:
                if path not in probe_cache:
                    sample = next((file for _, file, group in rows
                                   if folder and not group and file.parent == path and EPISODE.search(file.stem)), path)
                    probe_cache[path] = safe_streams(ffprobe, sample)
                streams = probe_cache[path]
                if streams:
                    results.append(dict(id=source_id(path), name=str(path.relative_to(root)) if path != root else root.name,
                                        location='Imports' if root == SOURCES[-1] else 'Completed downloads',
                                        folder=folder, streams=streams))
            return jsonify(sources=results, next=start + PAGE if start + PAGE < len(rows) else None)
        finally:
            listing.release()

    def summary(job):
        keys = ('id', 'item', 'name', 'state', 'progress', 'results', 'error')
        return deepcopy({key: job[key] for key in keys if key in job})

    def items(user):
        with lock:
            return [summary(job) for job in reversed(list(jobs.values())) if job['profile'] == user]

    def set_job(job, episode_index=None, **changes):
        with lock:
            job.update(changes)
            if episode_index is not None:
                job['results'][episode_index]['state'] = changes['state']
            save()

    def run(job, library, ident, choice, rows, stream_index, language, title, ffmpeg, ffprobe):
        nonlocal busy
        lower_background_priority()
        try:
            item = library('Items/' + ident, {'fields': 'Path'})
            if item.get('Type') not in ('Movie', 'Episode', 'Season'):
                raise ValueError('Choose a movie, episode or season.')
            pairs = episode_pairs(library, item, choice, rows)
            if not pairs:
                raise ValueError('No episodes matched the source folder.')
            set_job(job, name=f"Adding {title} audio to {item['Name']}" +
                    (f' ({len(pairs)} episodes)' if choice[2] else ''))
            stream_language = None
            if choice[2]:
                folder_sample = next(file for _, file, group in rows
                                     if not group and file.parent == choice[1] and EPISODE.search(file.stem))
                selected = next((s for s in probe_audio(ffprobe, folder_sample) if s['index'] == stream_index), None)
                if not selected:
                    raise ValueError('The selected audio stream is unavailable.')
                stream_language = selected['language']
            set_job(job, results=[dict(id=secrets.token_hex(16), title=episode['Name'], state='Waiting')
                                  for episode, _, _ in pairs])
            for index, (episode, root, source) in enumerate(pairs):
                result = dict(job['results'][index], state='Failed')
                private = None
                try:
                    video = target_path(episode)
                    sidecar_name = f'{video.stem}.{language}.mka'
                    if os.path.lexists(video.with_name(sidecar_name)):
                        raise ValueError('An added track already exists for this language.')
                    with opened(video) as video_fd, opened(source) as source_fd:
                        original = fingerprint(os.fstat(source_fd))
                        video_stamp = fingerprint(os.fstat(video_fd))
                        if original[:2] == video_stamp[:2]:
                            raise ValueError('Choose a different source from the library video.')
                    source_tracks = probe_audio(ffprobe, source, original)
                    target_tracks = probe_audio(ffprobe, video, video_stamp)
                    selected = next((s for s in source_tracks if s['index'] == stream_index and
                                     (stream_language is None or s['language'] == stream_language)), None)
                    if not selected and stream_language not in (None, 'und'):
                        selected = next((s for s in source_tracks if s['language'] == stream_language), None)
                    target_index = english(target_tracks)
                    if target_index is None and len(target_tracks) == 1 and target_tracks[0]['language'] == 'und':
                        target_index = target_tracks[0]['index']
                    if not selected or target_index is None:
                        raise ValueError('The selected audio or the library English track is unavailable.')
                    if max(selected['duration'] or 0, *(s['duration'] or 0 for s in target_tracks)) > MAX_SECONDS:
                        raise ValueError('Choose audio shorter than six hours.')
                    reference = english(source_tracks)
                    set_job(job, index, state='Matching audio', progress=index / len(pairs))
                    with opened(video.parent, directory=True) as folder, TemporaryDirectory(
                            prefix='.audio-match-', dir=f'/proc/{os.getpid()}/fd/{folder}') as temp:
                        temp = Path(temp)
                        smooth = reference is None
                        target_features = read_features(ffmpeg, video, target_index, temp / 'target.pcm',
                                                        smooth, video_stamp)
                        source_features = read_features(ffmpeg, source, selected['index'], temp / 'source.pcm',
                                                        smooth, original)
                        if reference is not None and reference != selected['index']:
                            source_features = read_features(ffmpeg, source, reference, temp / 'english.pcm',
                                                            False, original)
                        report = match_features(target_features, source_features, smooth)
                    result['report'] = report
                    set_job(job, index, state='Writing audio', progress=(index + .6) / len(pairs))
                    output, stamp = write_sidecar(ffmpeg, ffprobe, source, video, selected, language,
                                                  title, report, original, video_stamp)
                    result.update(state='Added', refresh_pending=False)
                    private = dict(source=str(source), root=str(root), source_stamp=original,
                                   sidecar=str(output), sidecar_stamp=stamp)
                    try:
                        item_id = episode['Id']
                        if not re.fullmatch(ITEM, item_id, re.I):
                            raise ValueError('Invalid library item.')
                        library(f'Items/{item_id}/Refresh', {'MetadataRefreshMode': 'FullRefresh'}, refresh=True)
                    except (OSError, ValueError):
                        result['refresh_pending'] = True
                except FileExistsError:
                    result['error'] = 'An added track already exists for this language.'
                except ValueError as error:
                    result['error'] = str(error) if type(error) is ValueError else 'Could not read the audio file.'
                except (OSError, subprocess.SubprocessError, ImportError):
                    log.warning('Could not add audio for job %s', job['id'])
                    result['error'] = 'Could not read or write the audio. Check the media and folder permissions.'
                with lock:
                    job['results'][index] = dict(result, can_delete=private is not None)
                    if private is not None:
                        job['files'][result['id']] = private
                    save()
            states = [result['state'] for result in job['results']]
            set_job(job, state='Added' if all(s == 'Added' for s in states) else
                    'Some tracks added' if 'Added' in states else 'Failed', progress=1.)
        except ValueError as error:
            set_job(job, state='Failed', error=str(error) if type(error) is ValueError else 'Could not read the library.')
        except Exception:
            log.exception('Audio job %s failed', job['id'])
            set_job(job, state='Failed', error='Could not finish adding audio.')
        finally:
            with lock:
                busy = False

    @app.post('/api/movies/audio-track')
    def movie_audio_track():
        nonlocal busy
        require('start', 6)
        data = body(2048)
        ident, source, index = (data.get(key) for key in ('item', 'source', 'stream_index'))
        language = data.get('language', 'hu')
        title = data.get('title', LANGUAGES.get(language, ('', language))[1] if isinstance(language, str) else '')
        if (not isinstance(ident, str) or not re.fullmatch(ITEM, ident, re.I)
                or not isinstance(source, str) or not re.fullmatch(r'[a-f0-9]{64}', source)
                or type(index) is not int or not 0 <= index <= 1023
                or not isinstance(language, str) or not (language in LANGUAGES or re.fullmatch(r'[a-z]{3}', language))
                or not isinstance(title, str) or not 0 < len(title.strip()) <= 60 or not safe_name(title.strip())):
            abort(400)
        if state is None:
            return jsonify(error='Audio jobs need a configured server state directory.'), 503
        library = audio_library(data.get('ticket'))
        ffmpeg, ffprobe = tools()
        with lock:
            if busy:
                return jsonify(error='Wait for the current audio job to finish.'), 409
            busy = True
        try:
            if not listing.acquire(blocking=False):
                return jsonify(error='Wait for the current source check to finish.'), 409
            try:
                rows = list_sources()
                choice = next((row for row in rows if source_id(row[1]) == source), None)
            finally:
                listing.release()
            if not choice:
                return jsonify(error='The source is unavailable. Check the source list again.'), 404
            job = dict(id=secrets.token_hex(16), profile=g.user, item=ident,
                       name=f'Adding {title.strip()} audio', state='Waiting', progress=0., results=[], files={})
            with lock:
                jobs[job['id']] = job
                while len(jobs) > HISTORY:
                    del jobs[next(iter(jobs))]
                save()
                reply = summary(job)
            worker = Thread(target=run, args=(job, library, ident, choice, rows, index, language, title.strip(), ffmpeg, ffprobe),
                            name='movie-audio-track', daemon=True)
            worker.start()
        finally:
            if 'worker' not in locals() or worker.ident is None:
                with lock:
                    busy = False
        return jsonify(reply), 202

    @app.post('/api/movies/audio-track/<job_id>/delete-source')
    def movie_audio_delete(job_id):
        require('delete', 12)
        data = body(1024)
        result_id = data.get('result')
        _, ffprobe = tools()
        with lock:
            job = jobs.get(job_id)
            if not job or job['profile'] != g.user:
                abort(404)
            if job['state'] in ('Waiting', 'Matching audio', 'Writing audio'):
                return jsonify(error='Wait for the audio job to finish.'), 409
            if result_id is None and len(job['files']) == 1:
                result_id = next(iter(job['files']))
            files = job['files'].get(result_id) if isinstance(result_id, str) else None
            if not files:
                return jsonify(error='This source is already removed or unavailable.'), 409
            source, sidecar = Path(files['source']), Path(files['sidecar'])
            root = Path(files['root'])
            if root not in SOURCES or not source.is_relative_to(root) or not any(sidecar.is_relative_to(p) for p in LIBRARIES.values()):
                abort(409)
            try:
                with opened(sidecar) as added, opened(source.parent, directory=True) as folder:
                    if fingerprint(os.fstat(added)) != files['sidecar_stamp'] or not probe_audio(ffprobe, sidecar, files['sidecar_stamp']):
                        return jsonify(error='The added track could not be verified. The source was kept.'), 409
                    observed = os.stat(source.name, dir_fd=folder, follow_symlinks=False)
                    if fingerprint(observed) != files['source_stamp'] or not stat.S_ISREG(observed.st_mode):
                        return jsonify(error='The source file changed. It was kept.'), 409
                    os.unlink(source.name, dir_fd=folder)
            except (OSError, ValueError, subprocess.SubprocessError):
                return jsonify(error='Could not verify the track or remove the source.'), 409
            del job['files'][result_id]
            next(result for result in job['results'] if result['id'] == result_id)['can_delete'] = False
            save()
            return jsonify(summary(job))

    return items
