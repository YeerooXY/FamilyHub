# Restore one private development VM forward after Windows sign-in.
param([ValidateSet('Music','Movies')][string]$Service = 'Music')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localPort, $guestPort = if ($Service -eq 'Movies') { 18767, 8096 } else { 18765, 8765 }
$forward = '127.0.0.1:{0}:127.0.0.1:{1}' -f $localPort,$guestPort
$sshArguments = @('-N','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','HostKeyAlias=familyhub-dev','-o','StrictHostKeyChecking=yes','-o',('UserKnownHostsFile=' + (Join-Path $projectRoot '.local/vm/known_hosts')),'-i',(Join-Path $projectRoot '.local/vm/id_ed25519'),'-L',$forward,'familyhub@familyhub-dev.mshome.net')
while ($true) {
    if (Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue) { exit 0 }
    try { & ssh.exe @sshArguments 2>$null } catch { } # Retry transient SSH failures.
    Start-Sleep -Seconds 20
}
