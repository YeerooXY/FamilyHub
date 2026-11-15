# Restore the native music API's existing SSH forward after Windows sign-in.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshArguments = @('-N','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','HostKeyAlias=familyhub-dev','-o','StrictHostKeyChecking=yes','-o',('UserKnownHostsFile=' + (Join-Path $projectRoot '.local/vm/known_hosts')),'-i',(Join-Path $projectRoot '.local/vm/id_ed25519'),'-L','127.0.0.1:18765:127.0.0.1:8765','familyhub@familyhub-dev.mshome.net')
while ($true) {
    if (Get-NetTCPConnection -LocalPort 18765 -State Listen -ErrorAction SilentlyContinue) { exit 0 }
    try { & ssh.exe @sshArguments 2>$null } catch { } # Retry transient SSH failures.
    Start-Sleep -Seconds 20
}
