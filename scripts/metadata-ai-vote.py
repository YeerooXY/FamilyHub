"""Fill missing album and genre tags with three Claude Haiku votes, run on this PC's subscription.

Reads the server's metadata review rows over SSH, asks `claude -p` (Claude Code, signed in with the
owner's plan, so no API credits) three times per batch, and sends back what the votes agreed on.
Albums must come from the Deezer/iTunes matches the server saved; an empty answer is allowed.
A field is filled when all three votes agree; a 2-of-3 answer is shown as a suggestion in review.

    python scripts/metadata-ai-vote.py [--wait] [--limit N] [--dry-run]
"""
import argparse
import collections
import concurrent.futures
import json
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'HostKeyAlias=familyhub-dev',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=.local/vm/known_hosts',
       '-i', '.local/vm/id_ed25519', 'familyhub@familyhub-dev.mshome.net']
VOTES, BATCH, PARALLEL = 3, 25, 3
LABEL = 'AI vote (Claude Haiku, 3 runs)'

EXPORT = r'''
import collections,json,pathlib
c=json.loads(pathlib.Path('/etc/familyhub-music-web/config.json').read_text())
d=json.loads((pathlib.Path(c['WORKSPACE'])/'.catalogue-review.json').read_text())
rows=d['metadata'].values()
genres=collections.Counter(r['current'].get('genre','') for r in rows if r['state']=='done')
genres.update(v['values']['genre'] for v in d['overrides'].values() if v.get('values',{}).get('genre'))
print(json.dumps(dict(
  pending=sum(r['state'] in ('queued','processing') for r in rows),
  genres=[g for g,_ in genres.most_common(60) if g],
  rows=[dict(id=r['id'],sha256=r['sha256'],seed=r['seed'],current=r['current'],missing=r['missing'],candidates=r.get('candidates',[]))
        for r in rows if r['state']=='review' and not r.get('ai_vote') and set(r['missing'])&{'album','genre'}]),ensure_ascii=False))
'''
INSTALL = r'''
import json,os,pathlib
c=json.loads(pathlib.Path('/etc/familyhub-music-web/config.json').read_text())
target=pathlib.Path(c['WORKSPACE'])/'.metadata-votes.json'
json.loads(data)
temporary=target.with_suffix('.incoming');temporary.write_text(data,encoding='utf-8')
review=target.with_name('.catalogue-review.json');st=review.stat()
os.chown(temporary,st.st_uid,st.st_gid);os.chmod(temporary,0o660);temporary.replace(target)
print('installed',target)
'''

SYSTEM = ('You tag songs for a family music library. For each song, give the album it was released on and one genre. '
          'Album: copy one album name from that song\'s store matches exactly, without " - Single" or " - EP"; '
          'if there are no matches or they look like a different song, answer "". Never invent an album. '
          'Genre: a specific style (for example "drum and bass", "liquid drum and bass", "hardstyle", "pop", "hip hop"). '
          'Reuse a name from the library genre list when one fits. Answer "" when you do not know the artist. '
          'Only fill the fields listed as missing; answer "" for the others. Reply with the JSON only.')
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['songs'], 'properties': {'songs': {'type': 'array', 'items': {
    'type': 'object', 'additionalProperties': False, 'required': ['id', 'album', 'genre'],
    'properties': {'id': {'type': 'string'}, 'album': {'type': 'string'}, 'genre': {'type': 'string'}}}}}}

def normal(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', value or '') if not unicodedata.combining(c))
    return re.sub(r'[^\w]+', ' ', value.casefold()).strip()

def album_key(title):
    title = re.sub(r'\s*[\[(][^\])]*(?:deluxe|remaster|expanded|edition|bonus)[^\])]*[\])]', '', title or '', flags=re.I)
    return normal(re.sub(r'\s*(?:-\s*(?:single|ep)|\((?:single|ep)\))$', '', title, flags=re.I))

def remote(script):
    result = subprocess.run([*SSH, 'sudo -n python3 -'], input=script, cwd=ROOT,
                            capture_output=True, text=True, encoding='utf-8', timeout=120)
    if result.returncode: raise SystemExit('Server command failed: ' + result.stderr.strip()[-400:])
    return result.stdout

def ask(batch, genres):
    songs = [dict(id=r['id'], title=r['seed']['title'], artist=r['seed']['artist'], seconds=round(r['seed']['duration']),
                  missing=[k for k in r['missing'] if k in ('album', 'genre')],
                  store_matches=[dict(store=c['source'], artist=c['artist'], album=c['album'], album_type=c['album_type'], store_genre=c['genre'])
                                 for c in r['candidates']]) for r in batch]
    prompt = 'Library genre list: ' + json.dumps(genres, ensure_ascii=False) + '\n\nSongs:\n' + json.dumps(songs, ensure_ascii=False)
    command = ['claude', '-p', '--model', 'haiku', '--output-format', 'json', '--tools', '', '--strict-mcp-config',
               '--no-session-persistence', '--system-prompt', SYSTEM, '--json-schema', json.dumps(SCHEMA)]
    for attempt in range(3):
        result = subprocess.run(command, input=prompt, capture_output=True, text=True, encoding='utf-8', timeout=600, cwd=ROOT / '.local')
        try:
            envelope = json.loads(result.stdout)
            answer = envelope.get('structured_output') or json.loads(re.search(r'\{.*\}', envelope.get('result', ''), re.S).group(0))
            return {s['id']: s for s in answer['songs'] if isinstance(s, dict) and isinstance(s.get('id'), str)}
        except (ValueError, AttributeError, KeyError, TypeError):
            print('  retrying a batch:', (result.stderr or result.stdout).strip()[-200:], file=sys.stderr)
            time.sleep(20 * (attempt + 1))
    return {}

def decide(row, answers):
    albums = {album_key(c['album']): re.sub(r'\s+-\s+(?:Single|EP)$', '', c['album']) for c in row['candidates'] if c['album']}
    values, suggested = {}, {}
    for key in ('album', 'genre'):
        if key not in row['missing']: continue
        given = [str(a.get(key, '')).strip() for a in answers]
        if key == 'album': given = [albums.get(album_key(g), '') for g in given]
        counts = collections.Counter(normal(g) for g in given if g)
        if not counts: continue
        best, votes = counts.most_common(1)[0]
        text = next(g for g in given if g and normal(g) == best)[:80 if key == 'genre' else 120]
        if votes == VOTES == len(answers): values[key] = text
        elif votes >= 2: suggested[key] = text
    return values, suggested

def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--wait', action='store_true', help='wait until the server has finished its own lookups')
    parser.add_argument('--limit', type=int, default=0, help='only vote on this many songs')
    parser.add_argument('--dry-run', action='store_true', help='print the result instead of sending it')
    args = parser.parse_args()
    while True:
        data = json.loads(remote(EXPORT))
        if not args.wait or not data['pending']: break
        print('server still looking up', data['pending'], 'songs; checking again in 5 minutes', flush=True)
        time.sleep(300)
    rows = data['rows'][:args.limit or None]
    print(len(rows), 'songs to vote on;', data['pending'], 'still queued on the server', flush=True)
    batches = [rows[i:i + BATCH] for i in range(0, len(rows), BATCH)]
    answers = collections.defaultdict(list)
    with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
        jobs = {pool.submit(ask, batch, data['genres']): batch for batch in batches for _ in range(VOTES)}
        for done, job in enumerate(concurrent.futures.as_completed(jobs), 1):
            reply = job.result()
            for row in jobs[job]:
                if row['id'] in reply: answers[row['id']].append(reply[row['id']])
            print(f'  {done}/{len(jobs)} calls', flush=True)
    votes = []
    for row in rows:
        values, suggested = decide(row, answers[row['id']])
        if values or suggested: votes.append(dict(id=row['id'], sha256=row['sha256'], values=values, suggested=suggested))
    filled = collections.Counter(k for v in votes for k in v['values'])
    hinted = collections.Counter(k for v in votes for k in v['suggested'])
    print('agreed:', dict(filled), 'suggested only:', dict(hinted))
    payload = json.dumps(dict(label=LABEL, votes=votes), ensure_ascii=False)
    if args.dry_run:
        out = ROOT / '.local' / 'metadata-votes-dry-run.json'
        out.write_text(payload, encoding='utf-8'); print('wrote', out)
    else:
        print(remote('data = ' + repr(payload) + '\n' + INSTALL).strip())

if __name__ == '__main__':
    main()
