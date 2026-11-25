#!/usr/bin/env python3
"""Measure the library index using local, manifest-only catalogues."""

import argparse
import json
from pathlib import Path
import re
from statistics import median
import sys
from tempfile import TemporaryDirectory
from time import perf_counter


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from music_web.library_index import LibraryIndex, library_folders, search_words
from music_web.resources import lower_background_priority


ITEM = re.compile(r'local-[0-9a-f]{16}')
SIZES = (2_000, 12_000, 50_000)
REPORT = ROOT / 'docs/verification/library-index-2026-11-24/README.md'
METHOD = ('The benchmark uses local temporary workspaces with small manifests and no audio. '
          'The scan reads every manifest using the same folder enumeration as the fallback route. '
          'Audio hashing, HTTP serialization and compression, and operating-system cache flushing '
          'are outside this measurement. Startup opens a fresh index instance and reads its marker. '
          'Startup and query times are medians of 31 runs. Scan and build are timed once per size.')


def track_id(number):
    return f'local-{number:016x}'


def timed(action, runs=1):
    durations = []
    for _ in range(runs):
        start = perf_counter()
        action()
        durations.append((perf_counter() - start) * 1000)
    return median(durations)


def benchmark(size):
    with TemporaryDirectory(prefix='familyhub-library-') as temp:
        workspace = Path(temp)
        for number in range(size):
            folder = workspace / track_id(number)
            folder.mkdir()
            row = dict(id=folder.name, title=f'Árvíz {number:05d}', channel=f'Müller {number % 127}',
                       library_album=f'Őszi esték {number % 251}', genre=('Rock', 'Jazz')[number % 2],
                       duration=180, saved=True)
            (folder / 'manifest.json').write_text(json.dumps(row), encoding='utf-8')

        def project(identifier, folders):
            row = json.loads((workspace / folders[0] / 'manifest.json').read_text(encoding='utf-8'))
            return row, '2026-11-24', 'a' * 64, 'local', ()

        def scan():
            return [project(identifier, folders)[0]
                    for identifier, folders in sorted(library_folders(workspace, ITEM).items())]

        def open_index():
            return LibraryIndex(workspace / 'catalogue.sqlite3', workspace, ITEM, str(workspace),
                                lambda folders: [], lambda identifier, deps: None, project)

        scan_time = timed(scan)
        index = open_index()
        build_time = timed(index.reconcile)
        words, broad = search_words('arviz 00123'), search_words('arviz')
        assert len(index.query()) == size
        assert index.get(track_id(size // 2))['id'] == track_id(size // 2)
        assert index.query(words=words)[0]['id'] == track_id(123)
        return (scan_time, build_time, timed(open_index, 31), timed(lambda: index.get(track_id(size // 2)), 31),
                timed(lambda: index.query(words=words, limit=51), 31),
                timed(lambda: index.query(words=broad, limit=51), 31), timed(lambda: index.query(limit=51), 31))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-results', action='store_true', help='Record the table in the verification README.')
    args = parser.parse_args()
    lower_background_priority()
    table = ['| Songs | Scan (ms) | Build (ms) | Startup (ms) | ID lookup (ms) | Selective search (ms) | Broad search (ms) | First page (ms) |',
             '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    results = [benchmark(size) for size in SIZES]
    for size, row in zip(SIZES, results):
        table.append(f'| {size:,} | ' + ' | '.join(f'{value:,.3f}' for value in row) + ' |')
    labels = ('ID lookup', 'Selective search', 'Broad search', 'First page')
    ratios = ', '.join(f'{label} {large / small:.2f}×'
                       for label, small, large in zip(labels, results[0][3:], results[-1][3:]))
    output = '\n'.join(table) + f'\n\n50,000 versus 2,000 songs. {ratios}.\n'
    print(output)
    if args.write_results:
        REPORT.write_text(f'# Library index benchmark\n\n{METHOD}\n\n{output}', encoding='utf-8')


if __name__ == '__main__':
    main()
