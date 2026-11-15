"""Package current native builds, checksums and matching source without device data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--windows', type=Path, default=ROOT / '.local/artifacts/native/windows')
    parser.add_argument('--android', type=Path, default=ROOT / '.local/artifacts/native/android/FamilyHub-Music.apk')
    args = parser.parse_args()
    version = ET.parse(ROOT / 'clients/FamilyHub.App/FamilyHub.App.csproj').findtext('.//ApplicationDisplayVersion')
    output = ROOT / '.local/artifacts/releases' / ('v' + version)
    output.mkdir(parents=True, exist_ok=True)
    windows = output / f'FamilyHub-Music-Windows-{version}.zip'
    with zipfile.ZipFile(windows, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(args.windows.rglob('*')):
            relative = path.relative_to(args.windows)
            if any(p.endswith('.WebView2') or p in ('EBWebView', 'User Data') for p in relative.parts):
                continue
            if path.is_file():
                archive.write(path, Path('FamilyHub-Music') / relative)
        archive.writestr('FamilyHub-Music/Install.cmd', '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Windows.ps1"\r\nif errorlevel 1 pause\r\n')
    with zipfile.ZipFile(windows) as archive:
        assert archive.testzip() is None
        assert 'FamilyHub-Music/Apply-Update.ps1' in archive.namelist()
        assert 'FamilyHub-Music/FamilyHub.App.exe' in archive.namelist()
    android = output / f'FamilyHub-Music-Android-{version}.apk'
    shutil.copy2(args.android, android)
    source = output / f'FamilyHub-Music-Source-{version}.zip'
    with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for folder in ('clients', 'packages/paddock-effects', 'music_web', 'scripts', 'tests'):
            for path in sorted((ROOT / folder).rglob('*')):
                relative = path.relative_to(ROOT)
                if any(p in ('bin', 'obj', '__pycache__', 'node_modules', '.vs', '.idea') for p in relative.parts):
                    continue
                if path.is_file() and path.suffix not in ('.pyc', '.user', '.pfx', '.keystore'):
                    archive.write(path, relative)
        for path in ROOT.glob('requirements*.txt'):
            archive.write(path, path.name)
    checksums = []
    for platform, package in (('windows-x64', windows), ('android', android), ('source', source)):
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        checksums.append(f'{digest}  {package.name}')
        if platform != 'source':
            manifest = {'version': version, 'sha256': digest, 'size': package.stat().st_size, 'file': package.name}
            (output / f'{platform}.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (output / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', encoding='utf-8')
    print(output)


if __name__ == '__main__':
    main()
