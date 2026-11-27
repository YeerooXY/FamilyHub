"""Mirror a packaged native release onto the configured private development server."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', type=Path)
    parser.add_argument('--platforms', default='windows-x64,android', help='comma-separated: windows-x64, android, ios')
    parser.add_argument('--assets-only', action='store_true', help='Mirror native packages without updating server code')
    parser.add_argument('--allow-busy', action='store_true', help='Restart even while downloads or analysis run; the server retries interrupted jobs')
    parser.add_argument('--allow-playing', action='store_true', help='Restart even while someone is watching a film')
    args = parser.parse_args()
    platforms = [p for p in args.platforms.split(',') if p]
    if not platforms or any(p not in ('windows-x64', 'android', 'ios') for p in platforms):
        parser.error('Choose platforms from windows-x64, android and ios.')
    release = args.release.resolve()
    # The live server is the physical machine (since 23 Nov 2026). The old VM stays available as a rollback target:
    # FAMILYHUB_DEPLOY_TARGET=vm deploys there instead.
    if os.environ.get('FAMILYHUB_DEPLOY_TARGET') == 'vm':
        options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'HostKeyAlias=familyhub-dev',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=.local/vm/known_hosts',
                   '-i', '.local/vm/id_ed25519']
        host = 'familyhub@familyhub-dev.mshome.net'
    else:
        options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'UserKnownHostsFile=.local/vm/known_hosts_server', '-i', '.local/vm/id_ed25519']
        host = 'familyhub@192.168.31.16'
    ssh = ['ssh', *options, host]
    incoming = '/tmp/familyhub-update-' + uuid.uuid4().hex
    subprocess.run([*ssh, 'mkdir -m 700 ' + incoming], check=True, cwd=ROOT)
    web_files = ('__init__.py', 'app_updates.py', 'playlist_artwork.py', 'playlists.py', 'finished_audio.py', 'audio_profile.py', 'mobile_audio.py', 'playlist_preparation.py', 'profile_artwork.py', 'profiles.py', 'public_playlists.py', 'listening_rooms.py', 'listening_versions.py', 'listening_history.py', 'listening_stats.py', 'catalogue_review.py', 'source_quality.py', 'analysis.py', 'song_analysis.py', 'worker_activity.py', 'musicbrainz.py', 'catalog_search.py', 'genres.py', 'lyrics.py', '__main__.py', 'link_playlists.py', 'playback_devices.py', 'radio.py', 'http_dispatch.py', 'playback_diagnostics.py', 'review_confidence.py', 'snapshots.py', 'resources.py', 'logs.py', 'discovery.py') + (
        'library_index.py', 'movies.py', 'movie_search.py', 'movie_youtube_downloads.py', 'movie_import.py', 'movie_subtitle_import.py', 'torrent_seeding.py', 'tmdb_stills.py', 'admin_page.py', 'movie_media.py', 'tmdb.py', 'audio_tracks.py', 'movie_subtitles.py', 'server_stats.py', 'verified_hashes.py', 'mixing.py', 'wrapped.py', 'files.py', 'wordle.py', 'wordle_source.py', 'feedback.py', 'http_limits.py', 'state.py',
        'similar_songs.py', 'home_albums.py', 'home_radio.py', 'library_loudness.py', 'subtitle_sync.py', 'wordle_data/answers.txt', 'wordle_data/guesses.txt', 'wordle_data/SOURCES.txt',
        'wordle_data/SCOWL-en-US.txt', 'wordle_data/SCOWL-en-GB.txt',
        'admin_static/admin.html', 'admin_static/admin.css', 'admin_static/admin.js', 'admin_static/service-status.js', 'admin_static/service-status.css',
        'static/app.js', 'static/playlists.js', 'static/prefix-cache.js', 'static/share.css', 'templates/index.html', 'templates/login.html',
    )
    files = []
    if not args.assets_only:
        for name in web_files:
            if name.startswith('admin_static/service-status.'):
                files.append(ROOT / 'clients' / 'FamilyHub.App' / 'wwwroot' / Path(name).name)
            else:
                files.append(ROOT / 'music_web' / name)
        files.append(ROOT / 'scripts' / 'music-intake.py')
        files.append(ROOT / 'scripts' / 'torrent-ratio-audit.py')
    for platform in platforms:
        manifest = release / (platform + '.json')
        data = json.loads(manifest.read_text(encoding='utf-8'))
        files.extend((manifest, release / data['file']))
    def cleanup():
        # A refused or failed deploy must not leave its upload in the server's small /tmp.
        subprocess.run([*ssh, 'sudo -n rm -rf ' + incoming], cwd=ROOT)
    try:
        subprocess.run(['scp', *options, *map(str, files), host + ':' + incoming + '/'], check=True, cwd=ROOT)
    except BaseException:
        cleanup()
        raise
    remote = (
        f'incoming = {incoming!r}\nplatforms = {platforms!r}\n'
        f'web_files = {web_files!r}\nassets_only = {args.assets_only!r}\nallow_busy = {args.allow_busy!r}\nallow_playing = {args.allow_playing!r}\n' + r'''
import hashlib,hmac,json,os,pathlib,secrets,shutil,subprocess,time,urllib.request
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
        if not allow_busy and pid!='0' and subprocess.run(['pgrep','-P',pid],capture_output=True).returncode==0:
            raise RuntimeError('An acquisition or analysis is active. Retry deployment after it finishes.')
        if not allow_playing and config.get('JELLYFIN_API_KEY'):
            # Films stream through this service, so a restart cuts off anyone watching.
            jellyfin=config.get('JELLYFIN_INTERNAL_URL','http://127.0.0.1:8096').rstrip('/')
            request=urllib.request.Request(jellyfin+'/Sessions?activeWithinSeconds=300',
                headers={'Authorization':'MediaBrowser Token="'+config['JELLYFIN_API_KEY']+'"'})
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response:
                    watching=[s for s in json.load(response) if s.get('NowPlayingItem')]
            except Exception:
                watching=[]
            if watching:
                raise RuntimeError(f'Playback is active on {len(watching)} device(s). Retry after it ends, or pass --allow-playing.')
        if not allow_playing:
            # Music also streams through this service. Its resource line, written every 30 s, says when someone is listening.
            lines=subprocess.run(['journalctl','-u',service,'--since','-75 s','-o','cat','--no-pager'],
                capture_output=True,text=True).stdout.splitlines()
            presence=[line for line in lines if 'resource presence=' in line]
            if presence and 'presence=listening' in presence[-1]:
                raise RuntimeError('Someone is listening to music. Retry after it ends, or pass --allow-playing.')
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
if not assets_only:
    # The torrent recorder runs from its own systemd timer, so it is swapped in place without a service restart.
    recorder=pathlib.Path('/usr/local/lib/familyhub/torrent-ratio-audit.py')
    fresh=(incoming/'torrent-ratio-audit.py').read_bytes()
    if not recorder.exists() or recorder.read_bytes()!=fresh:
        if recorder.exists():shutil.copy2(recorder,backup/'torrent-ratio-audit.py')
        staged=recorder.with_name(recorder.name+'.new')
        staged.write_bytes(fresh)
        os.chmod(staged,0o644)
        os.chown(staged,0,0)
        os.replace(staged,recorder)
if not code_changed:
    shutil.rmtree(incoming)
    print(json.dumps({'version':data['version'],'backup':str(backup),'server_restarted':False}))
    raise SystemExit(0)
deadline=time.monotonic()+8
presence=None
try:
    origin=config['PUBLIC_ORIGIN'].rstrip('/')
    secret=config.get('SECRET_KEY') or pathlib.Path(config.get('SECRET_FILE','/etc/familyhub/music-web.secret')).read_text(encoding='utf-8').strip()
    stamp,nonce=int(time.time()),secrets.token_hex(16)
    signature=hmac.new(secret.encode(),f'restart-notice|{stamp}|{nonce}|8'.encode(),hashlib.sha256).hexdigest()
    headers={'Host':origin.split('://',1)[1],'Origin':origin,'Content-Type':'application/json',
             'X-FamilyHub-Restart-Proof':f'{stamp}:{nonce}:{signature}'}
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    request=urllib.request.Request('http://127.0.0.1:8765/api/server/restart-notice',data=b'{"seconds":8}',headers=headers)
    with opener.open(request,timeout=2) as response:
        presence=json.load(response).get('presence')
except Exception:
    pass  # Older servers have no notice endpoint.
if allow_busy or presence!='offline':
    time.sleep(max(0,deadline-time.monotonic()))
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
    try:
        result = subprocess.run([*ssh, 'sudo -n python3 -'], input=remote, text=True,
                                encoding='utf-8', capture_output=True, timeout=120, cwd=ROOT)
    except BaseException:
        cleanup()
        raise
    if result.returncode:
        cleanup()
        raise RuntimeError(result.stderr)
    print(result.stdout.strip())


if __name__ == '__main__':
    main()
