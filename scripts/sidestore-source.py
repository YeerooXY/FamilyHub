"""Write ios.json (the server's update notice) and sidestore.json (the SideStore source) for an iPhone release.

SideStore reads the source from https://github.com/YeerooXY/FamilyHub/releases/latest/download/sidestore.json,
so each release that carries an iPhone build also carries its source file.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

REPOSITORY = 'YeerooXY/FamilyHub'
BUNDLE = 'org.familyhub.music'
MIN_IOS = '15.0'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True, help='release folder holding the IPA')
    parser.add_argument('--version', required=True)
    parser.add_argument('--ipa', required=True, help='IPA file name inside the release folder')
    args = parser.parse_args()
    ipa = args.release / args.ipa
    data = ipa.read_bytes()
    manifest = {'version': args.version, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'file': ipa.name}
    (args.release / 'ios.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

    site = f'https://github.com/{REPOSITORY}'
    download = f'{site}/releases/download/v{args.version}/{ipa.name}'
    today = datetime.date.today().isoformat()
    notes = f'FamilyHub {args.version}. Release notes: {site}/releases/tag/v{args.version}'
    app = {
        'name': 'FamilyHub',
        'bundleIdentifier': BUNDLE,
        'developerName': 'FamilyHub',
        'subtitle': 'Music from your family server',
        'localizedDescription': "Plays the music library on your family's FamilyHub server, with downloads for offline listening.",
        'iconURL': f'https://raw.githubusercontent.com/{REPOSITORY}/main/clients/FamilyHub.App/Resources/AppIcon/familyhub.png',
        'tintColor': '#07101F',
        'versions': [{'version': args.version, 'date': today, 'localizedDescription': notes,
                      'downloadURL': download, 'size': len(data), 'minOSVersion': MIN_IOS}],
        # Older SideStore builds read the newest version from these app-level fields.
        'version': args.version, 'versionDate': today, 'versionDescription': notes, 'downloadURL': download, 'size': len(data),
        'appPermissions': {'entitlements': [], 'privacy': {}},
    }
    source = {'name': 'FamilyHub', 'identifier': BUNDLE + '.source', 'website': site, 'apps': [app], 'news': []}
    (args.release / 'sidestore.json').write_text(json.dumps(source, indent=2) + '\n', encoding='utf-8')
    print(args.release / 'sidestore.json')


if __name__ == '__main__':
    main()
