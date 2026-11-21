param(
    [Parameter(Mandatory)][string]$CurrentTitle,
    [Parameter(Mandatory)][string]$NextTitle,
    [string]$Adb = 'adb',
    [string]$Serial
)

# With two tracks queued on a test device, start the first track and run this check.
# Android submits Next and Previous through the same media session as the lock screen.
$ErrorActionPreference = 'Stop'
$device = if ($Serial) { @('-s', $Serial) } else { @() }
$package = 'org.familyhub.music'

function Read-Adb {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Command)
    $output = & $Adb @device @Command
    if ($LASTEXITCODE) { throw "adb $($Command -join ' ') failed." }
    return $output
}

function Wait-ForTrack {
    param([string]$Title)
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $sessions = @(Read-Adb shell cmd media_session list-sessions | Where-Object { $_ -match "package=$([regex]::Escape($package))\s*$" })
        if ($sessions.Count -gt 1) { throw 'FamilyHub published multiple Android media sessions.' }
        if ($sessions.Count -eq 1 -and $sessions[0] -match 'tag=FamilyHub,') {
            $details = (Read-Adb shell dumpsys media_session) -join "`n"
            $record = [regex]::Match($details, '(?m)^ +FamilyHub org\.familyhub\.music/FamilyHub[^\n]*\n(?<indent> +)ownerPid=[^\n]*(?:\n\k<indent>[^\n]*)*')
            $playing = $record.Success -and $record.Value -match 'state=PlaybackState \{state=3,'
            if ($playing -and $record.Value -match "(?m)metadata: size=\d+, description=$([regex]::Escape($Title))(?:,|$)") { return }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Expected the FamilyHub media session to play $Title."
}

if ($CurrentTitle -eq $NextTitle) { throw 'Choose two songs with different titles.' }
Wait-ForTrack $CurrentTitle
Read-Adb shell cmd media_session dispatch next | Out-Null
Wait-ForTrack $NextTitle
Read-Adb shell cmd media_session dispatch previous | Out-Null
Wait-ForTrack $CurrentTitle
Write-Output 'PASS: a single Android media session published both tracks.'
