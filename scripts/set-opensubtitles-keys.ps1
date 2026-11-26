# Store the OpenSubtitles.com credentials in the server config without showing them anywhere.
# Run it yourself in a PowerShell window from the repository folder: it asks for the three values,
# sends them over SSH on standard input (never on a command line) and prints only "saved".
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Read-Secret([string]$Label) {
    $secure = Read-Host -AsSecureString $Label
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$key = Read-Secret 'OpenSubtitles API key (from your API consumer)'
$user = Read-Host 'OpenSubtitles username'
$password = Read-Secret 'OpenSubtitles password'
if (-not $key -or -not $user -or -not $password) { throw 'All three values are required.' }

$payload = @{ OPENSUBTITLES_API_KEY = $key; OPENSUBTITLES_USERNAME = $user; OPENSUBTITLES_PASSWORD = $password } | ConvertTo-Json -Compress
$remote = @'
import json, os, shutil, sys, time
path = '/etc/familyhub-music-web/config.json'
values = json.loads(sys.stdin.read())
config = json.load(open(path))
shutil.copy2(path, path + '.before-opensubtitles-' + str(int(time.time())))
config.update(values)
status = os.stat(path)
temporary = path + '.new'
with open(temporary, 'w') as handle:
    json.dump(config, handle, indent=2)
os.chmod(temporary, status.st_mode)
os.chown(temporary, status.st_uid, status.st_gid)
os.replace(temporary, path)
print('saved')
'@
$options = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=.local/vm/known_hosts_server', '-i', '.local/vm/id_ed25519')
$payload | & ssh @options familyhub@192.168.31.16 ("sudo -n python3 -c " + "'" + ($remote -replace "'", "'\''") + "'")
if ($LASTEXITCODE) { throw 'The server did not accept the values.' }
$payload = $null; $key = $null; $password = $null

$answer = Read-Host 'Restart the music server now so it reads the new values? (y/N)'
if ($answer -match '^(y|yes)$') {
    & ssh @options familyhub@192.168.31.16 'sudo -n systemctl restart familyhub-music-web.service'
    if ($LASTEXITCODE) { throw 'The restart failed.' }
    'Restarted.'
} else { 'Not restarted. The new values apply after the next server restart or release.' }
