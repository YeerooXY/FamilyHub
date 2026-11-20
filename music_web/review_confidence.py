"""Thresholds shared by automatic catalogue review decisions."""
import math
import re
import unicodedata

MATCH_DURATION_SECONDS = 3
MUSICBRAINZ_MIN_SCORE = 90
DEFAULT_AUTO_RESOLUTIONS_PER_HOUR = 30

_PRESENTATION = r'(?:(?:official\s+)?(?:(?:music )?(?:audio|video)|visualizer|lyrics?(?: video)?)|hq|hd|4k)'
_TITLE_SUFFIX = re.compile(r'(?:\s*(?:\[\s*'+_PRESENTATION+r'\s*\]|\(\s*'+_PRESENTATION+r'\s*\)|\s+-\s+'+_PRESENTATION+r'))+\s*$', re.I)


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
        upload_label = clean != upload.strip() and (not credited or normal(credited) == normal(channel))
        if prefix_matches or upload_label:
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
