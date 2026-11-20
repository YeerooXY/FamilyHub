"""Thresholds shared by automatic catalogue review decisions."""
import math
import re
import unicodedata

MATCH_DURATION_SECONDS = 3
MUSICBRAINZ_MIN_SCORE = 90
DEFAULT_AUTO_RESOLUTIONS_PER_HOUR = 30

_PRESENTATION = r'(?:official(?: music)? (?:audio|video)|lyrics?(?: video)?|audio|video|hq|hd|4k|visualizer)'
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


def close_duration(expected, actual):
    return (all(type(value) in (int, float) and math.isfinite(value) and value > 0
                for value in (expected, actual))
            and abs(expected - actual) <= MATCH_DURATION_SECONDS)
