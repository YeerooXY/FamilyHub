"""Live metadata-only acceptance: compare every entry across two page sizes."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from music_web.public_playlists import fetch_public_playlist
from music_web.playlists import PlaylistError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--expected-count', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        first = fetch_public_playlist(args.url)
        second = fetch_public_playlist(args.url, page_size=37)
        if len(first['tracks']) != args.expected_count:
            raise PlaylistError(f"Expected {args.expected_count} entries; received {len(first['tracks'])}.")
        if first['source']['revision'] != second['source']['revision'] or first['tracks'] != second['tracks']:
            raise PlaylistError('The two reads differ in revision, track metadata, or order.')
        digest = hashlib.sha256('\n'.join(t['spotify_uri'] for t in first['tracks']).encode()).hexdigest()
        report = {'playlist': first, 'order_sha256': digest,
                  'verification_pages': second['source']['pages'], 'result': 'passed'}
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"PASS: {len(first['tracks'])} entries match in order at page sizes 100 and 37. SHA-256: {digest}")
    except PlaylistError as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
