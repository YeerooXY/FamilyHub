"""Optional playback metadata fetched through the Movies library gateway."""
from html.parser import HTMLParser
import json
import logging
import re
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from .catalog_search import NoRedirect


log = logging.getLogger(__name__)
SECOND = 10_000_000
MAX_TICKS = 2**53 - 1
INTRODB = 'https://api.introdb.app/segments'
IMDB = 'https://www.imdb.com/title/{}/parentalguide/'
IMDB_ID = re.compile(r'tt[0-9]{7,12}')
TYPES = ('Intro', 'Recap', 'Outro', 'Preview', 'Commercial')
CHAPTER_TYPES = {'op': 'Intro', 'opening': 'Intro', 'intro': 'Intro', 'recap': 'Recap', 'previously': 'Recap',
                 'ed': 'Outro', 'ending': 'Outro', 'credits': 'Outro', 'end credits': 'Outro'}
GUIDE_CATEGORIES = {'violence & gore': 'violence', 'profanity': 'language',
                    'frightening & intense scenes': 'frightening', 'sex & nudity': 'nudity'}
GUIDE_RATING = re.compile(r'\b(' + '|'.join(map(re.escape, GUIDE_CATEGORIES)) +
                          r')\s*:\s*(none|mild|moderate|severe)\b', re.I)


def imdb_id(item):
    providers = item.get('ProviderIds')
    if isinstance(providers, dict):
        return next((value for key, value in providers.items() if key.casefold() == 'imdb'
                     and isinstance(value, str) and IMDB_ID.fullmatch(value)), None)


def segment(kind, start, end, runtime=MAX_TICKS):
    if kind in TYPES and type(start) is int and type(end) is int and 0 <= start < end <= min(runtime, MAX_TICKS):
        return {'Type': kind, 'StartTicks': start, 'EndTicks': end}


def chapter_segments(chapters, runtime):
    starts = {row['StartPositionTicks']: row.get('Name') for row in chapters if isinstance(row, dict)
              and type(row.get('StartPositionTicks')) is int and 0 <= row['StartPositionTicks'] < runtime}
    cuts = sorted(starts) + [runtime]
    for start, end in zip(cuts, cuts[1:]):
        name = starts[start]
        if isinstance(name, str) and 5 * SECOND <= end - start <= 240 * SECOND:
            match = segment(CHAPTER_TYPES.get(name.strip().casefold()), start, end, runtime)
            if match:
                yield match


def merge_segments(*sources):
    merged = []
    for name, rows in sources:
        higher = tuple(merged)
        for row in rows:
            if not any(prior['Type'] == row['Type'] or
                       (prior['Type'] in TYPES[:3] and row['Type'] in TYPES[:3] and
                        row['StartTicks'] < prior['EndTicks'] and prior['StartTicks'] < row['EndTicks']) for prior in higher):
                if row not in merged:
                    merged.append(row)
        if name and len(merged) > len(higher):
            log.info('movie segments source=%s', name)
    return sorted(merged, key=lambda row: row['StartTicks'])


class GuideText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.ignored = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.ignored = True

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.ignored = False

    def handle_data(self, data):
        if not self.ignored and data.strip():
            self.parts.append(data.strip())


def parse_guide(html):
    parser = GuideText()
    parser.feed(html)
    text = ' '.join(' '.join(parser.parts).split())
    summary = re.search(r'\bContent rating\b', text, re.I)
    if not summary:
        if re.search(r'\bParents guide\b', text, re.I):
            return {}
        raise ValueError('Unrecognized IMDb guide page')
    result = {}
    for category, level in GUIDE_RATING.findall(text[summary.end():summary.end() + 1500]):
        result.setdefault(GUIDE_CATEGORIES[category.lower()], level.lower())
    return result


def external(url, source, parse, limit, opener=None):
    try:
        opener = opener or build_opener(NoRedirect)
        request = Request(url, headers={'User-Agent': 'FamilyHub/2.0', 'Accept-Language': 'en-US'})
        with opener.open(request, timeout=2.5) as reply:
            raw = reply.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('Playback metadata response exceeded its limit')
        return parse(raw)
    except HTTPError as error:
        error.close()
        if error.code == 404:
            return {}
        log.warning('movie metadata failed source=%s cause=http_%s', source, error.code)
    except (OSError, ValueError, RecursionError) as error:
        log.warning('movie metadata failed source=%s cause=%s', source, type(error).__name__)


def introdb_segments(cached, ident, season, episode, opener=None):
    params = urlencode({'imdb_id': ident, 'season': season, 'episode': episode})

    def parse(raw):
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('Invalid IntroDB response')
        rows = []
        for key in ('intro', 'recap', 'outro'):
            entry = value.get(key)
            if not isinstance(entry, dict) or value.get('no_' + key) is True:
                continue
            start, end = entry.get('start_sec'), entry.get('end_sec')
            if key == 'outro' and isinstance(value.get('post_credits'), dict):
                post = value['post_credits'].get('start_sec')
                if type(post) in (int, float) and type(start) in (int, float) and type(end) in (int, float) and start < post < end:
                    end = post
            if all(type(at) in (int, float) and 0 <= at <= MAX_TICKS / SECOND for at in (start, end)):
                row = segment(key.title(), round(start * SECOND), round(end * SECOND))
                if row:
                    rows.append(row)
        return rows

    return cached(('IntroDB', ident, season, episode), 86400,
                  lambda: external(INTRODB + '?' + params, 'IntroDB', parse, 65536, opener)) or []


def media_segments(library, item_id, item, cached, series):
    runtime = item.get('RunTimeTicks')
    runtime = runtime if type(runtime) is int and 0 < runtime <= MAX_TICKS else MAX_TICKS
    jellyfin = []
    try:
        response = library('MediaSegments/' + item_id, timeout=2.5)
        if response is None:
            response = {}
        items = response.get('Items', []) if isinstance(response, dict) else None
        if not isinstance(items, list):
            raise ValueError('Invalid Jellyfin segment response')
        for row in items:
            if isinstance(row, dict):
                match = segment(row.get('Type'), row.get('StartTicks'), row.get('EndTicks'), runtime)
                if match:
                    jellyfin.append(match)
    except HTTPError as error:
        error.close()
        if error.code not in (404, 204):
            log.warning('movie metadata failed source=Jellyfin cause=http_%s', error.code)
    except (OSError, ValueError, RecursionError) as error:
        log.warning('movie metadata failed source=Jellyfin cause=%s', type(error).__name__)
    chapters = item.get('Chapters')
    local = merge_segments(('Jellyfin', jellyfin), ('MKV chapters', chapter_segments(chapters, runtime)
                                                   if isinstance(chapters, list) else ()))
    season, episode = item.get('ParentIndexNumber'), item.get('IndexNumber')
    available = {row['Type'] for row in local}
    if (item.get('Type') == 'Episode' and type(season) is int and type(episode) is int
            and 0 <= season <= 999 and 1 <= episode <= 9999 and not available.issuperset(TYPES[:3])):
        ident = imdb_id(series()) or imdb_id(item)
        if ident:
            remote = introdb_segments(cached, ident, season, episode)
            return merge_segments((None, local), ('IntroDB', (row for row in remote if row['EndTicks'] <= runtime)))
    return local


def parental_guide(item, cached, opener=None):
    ident = imdb_id(item)
    if not ident:
        return {}
    return cached(('IMDb parental guide', ident), 30 * 86400,
                  lambda: external(IMDB.format(ident), 'IMDb', lambda raw: parse_guide(raw.decode('utf-8')), 2 << 20, opener)) or {}
