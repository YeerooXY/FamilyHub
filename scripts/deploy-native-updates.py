"""Mirror a packaged native release onto the configured private development server."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', type=Path)
    parser.add_argument('--platforms', default='windows-x64,android', help='comma-separated: windows-x64, android, ios')
    parser.add_argument('--assets-only', action='store_true', help='Mirror native packages without updating server code')
    args = parser.parse_args()
    platforms = [p for p in args.platforms.split(',') if p]
    if not platforms or any(p not in ('windows-x64', 'android', 'ios') for p in platforms):
        parser.error('Choose platforms from windows-x64, android and ios.')
    release = args.release.resolve()
    options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'HostKeyAlias=familyhub-dev',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=.local/vm/known_hosts',
               '-i', '.local/vm/id_ed25519']
    host = 'familyhub@familyhub-dev.mshome.net'
    ssh = ['ssh', *options, host]
    incoming = '/tmp/familyhub-update-' + uuid.uuid4().hex
    subprocess.run([*ssh, 'mkdir -m 700 ' + incoming], check=True, cwd=ROOT)
    web_files = ('__init__.py', 'app_updates.py', 'playlist_artwork.py', 'playlists.py', 'finished_audio.py', 'audio_profile.py', 'mobile_audio.py', 'playlist_preparation.py', 'profile_artwork.py', 'profiles.py', 'public_playlists.py', 'listening_rooms.py', 'listening_versions.py', 'listening_history.py', 'listening_stats.py', 'catalogue_review.py', 'source_quality.py', 'analysis.py', 'song_analysis.py', 'worker_activity.py', 'musicbrainz.py', 'catalog_search.py', 'genres.py', 'lyrics.py', '__main__.py', 'link_playlists.py', 'playback_devices.py', 'radio.py', 'http_dispatch.py', 'playback_diagnostics.py', 'review_confidence.py', 'snapshots.py', 'resources.py', 'discovery.py') + (
        'movies.py', 'movie_search.py', 'files.py', 'wordle.py', 'wordle_source.py', 'feedback.py',
        'wordle_data/answers.txt', 'wordle_data/guesses.txt', 'wordle_data/SOURCES.txt',
        'wordle_data/SCOWL-en-US.txt', 'wordle_data/SCOWL-en-GB.txt',
        'static/app.js', 'static/playlists.js', 'static/prefix-cache.js', 'static/share.css', 'templates/index.html',
    )
    files = []
    if not args.assets_only:
        files.extend(ROOT / 'music_web' / name for name in web_files)
        files.append(ROOT / 'scripts' / 'music-intake.py')
    for platform in platforms:
        manifest = release / (platform + '.json')
        data = json.loads(manifest.read_text(encoding='utf-8'))
        files.extend((manifest, release / data['file']))
    subprocess.run(['scp', *options, *map(str, files), host + ':' + incoming + '/'], check=True, cwd=ROOT)
    remote = (
        f'incoming = {incoming!r}\nplatforms = {platforms!r}\n'
        f'web_files = {web_files!r}\nassets_only = {args.assets_only!r}\n' + r'''
import hashlib,json,os,pathlib,shutil,subprocess,time,urllib.request
incoming=pathlib.Path(incoming)
config=json.loads(pathlib.Path('/etc/familyhub-music-web/config.json').read_text())
root=pathlib.Path(config['WORKSPACE'])/'.app-updates'
base=pathlib.Path('/usr/local/lib/familyhub/mobile/music_web')
service='familyhub-music-web.service'
intake=pathlib.Path('/usr/local/lib/familyhub/music-intake.py')
code_changed=False
if not assets_only:
    code_targets=[(incoming/pathlib.Path(name).name,base/name) for name in web_files]
    code_targets.append((incoming/'music-intake.py',intake))
    code_changed=any(not target.exists() or hashlib.sha256(source.read_bytes()).digest()!=hashlib.sha256(target.read_bytes()).digest() for source,target in code_targets)
    if code_changed:
        pid=subprocess.check_output(['systemctl','show',service,'-p','MainPID','--value'],text=True).strip()
        if pid!='0' and subprocess.run(['pgrep','-P',pid],capture_output=True).returncode==0:
            raise RuntimeError('An acquisition or analysis is active. Retry deployment after it finishes.')
backup=pathlib.Path('/usr/local/lib/familyhub')/('before-native-updates-'+str(time.time_ns()))
backup.mkdir(mode=0o700)
originals={}
if not assets_only:
    intake_stat=intake.stat()
    shutil.copy2(intake,backup/'music-intake.py')
    for name in web_files:
        original=base/name
        originals[name]=original.exists()
        if original.exists():
            (backup/name).parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(original,backup/name)
for platform in platforms:
    data=json.loads((incoming/(platform+'.json')).read_text())
    source=incoming/data['file']
    if source.stat().st_size!=data['size'] or hashlib.sha256(source.read_bytes()).hexdigest()!=data['sha256']:
        raise RuntimeError('Uploaded package failed verification')
    directory=root/platform
    directory.mkdir(parents=True,exist_ok=True)
    shutil.chown(root,user='familyhub-writer',group='familyhub-writer')
    shutil.chown(directory,user='familyhub-writer',group='familyhub-writer')
    target=directory/data['file']
    shutil.copy2(source,target)
    shutil.chown(target,user='familyhub-writer',group='familyhub-writer')
    active=directory/'latest.json'
    if active.exists():shutil.copy2(active,backup/(platform+'.json'))
    temporary=directory/'latest.json.new'
    temporary.write_text(json.dumps(data)+'\n')
    shutil.chown(temporary,user='familyhub-writer',group='familyhub-writer')
    os.replace(temporary,active)
if not code_changed:
    shutil.rmtree(incoming)
    print(json.dumps({'version':data['version'],'backup':str(backup),'server_restarted':False}))
    raise SystemExit(0)
subprocess.run(['systemctl','stop',service],check=True)
try:
    shutil.copyfile(incoming/'music-intake.py',intake)
    os.chmod(intake,intake_stat.st_mode)
    os.chown(intake,intake_stat.st_uid,intake_stat.st_gid)
    for name in originals:
        target=base/name
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(incoming/pathlib.Path(name).name,target)
    subprocess.run(['systemctl','start',service],check=True)
    for attempt in range(30):
        try:
            headers={'Host':config['PUBLIC_ORIGIN'].split('://',1)[1].rstrip('/')}
            with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765/api/app-updates/windows-x64',headers=headers),timeout=2) as response:
                data=json.load(response)
            break
        except Exception:
            if attempt==29:raise
            time.sleep(.3)
except Exception:
    subprocess.run(['systemctl','stop',service],check=True)
    shutil.copy2(backup/'music-intake.py',intake)
    os.chown(intake,intake_stat.st_uid,intake_stat.st_gid)
    for name,existed in originals.items():
        if existed:shutil.copy2(backup/name,base/name)
        else:(base/name).unlink(missing_ok=True)
    subprocess.run(['systemctl','start',service],check=True)
    raise
shutil.rmtree(incoming)
print(json.dumps({'version':data['version'],'backup':str(backup),'sha256':data['sha256']}))
''')
    result = subprocess.run([*ssh, 'sudo -n python3 -'], input=remote, text=True,
                            encoding='utf-8', capture_output=True, timeout=120, cwd=ROOT)
    if result.returncode:
        raise RuntimeError(result.stderr)
    print(result.stdout.strip())


if __name__ == '__main__':
    main()
