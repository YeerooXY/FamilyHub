"""Dry run: how many library songs find lyrics on LRCLIB. Usage: python scripts/lyrics_dry_run.py library.json out.json"""
import json
import sys

import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location('lyrics', pathlib.Path(__file__).parents[1] / 'music_web' / 'lyrics.py')
lyrics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lyrics)

songs = json.load(open(sys.argv[1], encoding='utf-8'))
results = {}
counts = {'synced': 0, 'plain': 0, 'instrumental': 0, 'none': 0, 'error': 0}
for index, song in enumerate(songs, 1):
    try:
        hit = lyrics.find(song['title'], song.get('channel', ''), float(song.get('duration') or 0))
        kind = 'none' if not hit else 'instrumental' if hit['instrumental'] else 'synced' if hit['synced'] else 'plain'
        results[song['id']] = {'title': song['title'], 'kind': kind, 'match': hit and f"{hit['artist']} - {hit['track']}"}
    except Exception as error:
        kind = 'error'
        results[song['id']] = {'title': song['title'], 'kind': kind, 'error': str(error)[:200]}
    counts[kind] += 1
    if index % 50 == 0: print(index, counts, flush=True)
print('done', len(songs), counts, flush=True)
json.dump(results, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
