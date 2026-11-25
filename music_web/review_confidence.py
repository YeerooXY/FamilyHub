"""Thresholds shared by automatic catalogue review decisions."""
import math
import re
import unicodedata

MATCH_DURATION_SECONDS = 3
MUSICBRAINZ_MIN_SCORE = 90
DEFAULT_AUTO_RESOLUTIONS_PER_HOUR = 130

_PRESENTATION = r'(?:(?:official\s+)?(?:(?:music )?(?:audio|video)|visualizer|lyrics?(?: video)?)|hq|hd|4k)'
_TITLE_SUFFIX = re.compile(r'(?:\s*(?:\[\s*'+_PRESENTATION+r'\s*\]|\(\s*'+_PRESENTATION+r'\s*\)|\s+-\s+'+_PRESENTATION+r'))+\s*$', re.I)
_EQUIVALENT_SUFFIX = re.compile(r'\(([^()]*)\)\s*$|\[([^\[\]]*)\]\s*$')
_EDITION_WORDS = re.compile(r'\b(?:mix|remix|live|acoustic|instrumental|extended|sped(?:up)?|'
                            r'slowed|cover|karaoke|8\s*d|nightcore|edit|version|mashup|rework|demo)\b')


def normal(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', value or '') if not unicodedata.combining(c))
    return re.sub(r'[^\w]+', ' ', value.casefold()).strip()


def presentation_title(title, artist=''):
    """Remove upload labels and a matching artist prefix, retaining the recording edition."""
    parts = re.split(r'\s+[-\u2013\u2014]\s+', title, maxsplit=1)
    if len(parts) == 2 and normal(artist) and normal(parts[0]) == normal(artist):
        title = parts[1]
    return _TITLE_SUFFIX.sub('', title).strip() or title.strip()


def recording_labels(source, record=None):
    """Choose display labels without changing imported files or explicit edits."""
    record = record or {}
    upload = source.get('title') or ''
    tagged = source.get('track_title') or ''
    credited = source.get('artist') or ''
    channel = source.get('channel') or ''
    title = record.get('title') or tagged or upload
    artist = record.get('artist') or credited or channel
    if (source.get('kind') != 'youtube' or record.get('automatic_title') is False
            or title not in (tagged, upload, tagged[:120], upload[:120])):
        return title, artist

    clean = presentation_title(upload)
    parts = re.split(r'\s+[-\u2013\u2014]\s+', clean, maxsplit=1)
    inferred = ''
    if len(parts) == 2 and all(parts):
        prefix, song = parts
        credits = [normal(name) for name in prefix.split(',')]
        known = normal(re.sub(r'\s*-\s*Topic$|VEVO$', '', credited or channel, flags=re.I))
        prefix_matches = known and (known == normal(prefix) or known in credits)
        saved_credit_matches = bool(record.get('artist')) and normal(record['artist']) == normal(prefix)
        upload_label = clean != upload.strip() and (not credited or normal(credited) == normal(channel))
        if prefix_matches or saved_credit_matches or upload_label:
            inferred = prefix
            clean = song
    if artist in (credited, channel, channel.removesuffix(' - Topic'), 'YouTube'):
        artist = inferred or credited or artist
    title = presentation_title(tagged, inferred or artist) if tagged and tagged != upload else clean
    return title, artist


def close_duration(expected, actual):
    return (all(type(value) in (int, float) and math.isfinite(value) and value > 0
                for value in (expected, actual))
            and abs(expected - actual) <= MATCH_DURATION_SECONDS)


def _equivalent_title(title, artist):
    title = presentation_title(title, artist)
    while suffix := _EQUIVALENT_SUFFIX.search(title):
        label = normal(suffix[1] or suffix[2])
        if not label.startswith(('from ', 'feat ', 'ft ', 'featuring ')) or _EDITION_WORDS.search(label):
            break
        title = presentation_title(title[:suffix.start()].rstrip(), artist)
    return normal(title)


def pick_equivalent(track, candidates):
    """Choose a trusted title and length match when all plausible lengths agree."""
    artist = track.get('artist') or ''
    title = track.get('title') or ''
    wanted = _equivalent_title(title, artist)
    if not wanted:
        return None
    credits = {normal(artist), normal(artist.split(',')[0])} - {''}
    exact_titles = {normal(title), wanted}
    expected = track.get('duration')
    plausible = []
    for row in candidates:
        channel = normal(row.get('channel'))
        artist_channel = channel.removesuffix(' topic') in credits
        topic = row.get('kind') == 'topic'
        actual = row.get('duration')
        raw_title = row.get('title') or ''
        if ((topic or artist_channel) and close_duration(expected, actual)
                and abs(expected - actual) <= 2 and _equivalent_title(raw_title, artist) == wanted):
            exact = normal(raw_title) in exact_titles
            priority = (not (exact and (channel == 'release topic' or artist_channel)),
                        not exact, not topic, row.get('id') or '', raw_title, channel)
            plausible.append((priority, row))
    if len({row['duration'] for _, row in plausible}) != 1:
        return None
    return min(plausible, key=lambda option: option[0])[1]
