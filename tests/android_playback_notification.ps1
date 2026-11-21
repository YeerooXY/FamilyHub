param(
    [Parameter(Mandatory)][string]$CurrentTitle,
    [Parameter(Mandatory)][string]$NextTitle,
    [string]$Adb = 'adb',
    [string]$Serial,
    [switch]$AutoDj
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
    param([string]$Title, [int]$State = 3, [int]$MinimumPosition = 0, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $sessions = @(Read-Adb shell cmd media_session list-sessions | Where-Object { $_ -match "package=$([regex]::Escape($package))\s*$" })
        if ($sessions.Count -gt 1) { throw 'FamilyHub published multiple Android media sessions.' }
        if ($sessions.Count -eq 1 -and $sessions[0] -match 'tag=FamilyHub,') {
            $details = (Read-Adb shell dumpsys media_session) -join "`n"
            $record = [regex]::Match($details, '(?m)^ +FamilyHub org\.familyhub\.music/FamilyHub[^\n]*\n(?<indent> +)ownerPid=[^\n]*(?:\n\k<indent>[^\n]*)*')
            if ($record.Success -and $record.Value -match "(?m)metadata: size=\d+, description=$([regex]::Escape($Title))(?:,|$)" -and
                $record.Value -match "state=PlaybackState \{state=$State,\s*position=(\d+)") {
                $position = [long]$Matches[1]
                if ($position -ge $MinimumPosition) {
                    $posted = (Read-Adb shell dumpsys notification --noredact) -join "`n"
                    $entry = [regex]::Match($posted, '(?ms)^\s*NotificationRecord\([^\n]*\bpkg=org\.familyhub\.music\s[^\n]*\bid=4101\b[^\n]*\n(?<body>.*?)(?=^\s*NotificationRecord\(|^  \S|\z)')
                    if ($entry.Success -and $entry.Groups['body'].Value -match "(?m)^\s*android\.title=String \($([regex]::Escape($Title))\)\s*$") {
                        return $position
                    }
                }
            }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Expected $Title in media session state $State at or beyond $MinimumPosition ms."
}

if ($CurrentTitle -eq $NextTitle) { throw 'Choose two songs with different titles.' }
Wait-ForTrack $CurrentTitle | Out-Null
# Android publishes the actual checkpoint on pause. Give the track time to advance.
Start-Sleep -Seconds 4
Read-Adb shell cmd media_session dispatch pause | Out-Null
$pausedAt = Wait-ForTrack $CurrentTitle -State 2 -MinimumPosition 2000
Read-Adb shell cmd media_session dispatch play | Out-Null
Wait-ForTrack $CurrentTitle -MinimumPosition ($pausedAt - 1000) | Out-Null
if ($AutoDj) {
    # Leave playback running so Auto DJ promotes the standby deck on its own.
    Wait-ForTrack $NextTitle -TimeoutSeconds 600 | Out-Null
} else {
    Read-Adb shell cmd media_session dispatch next | Out-Null
    Wait-ForTrack $NextTitle | Out-Null
}
Read-Adb shell cmd media_session dispatch previous | Out-Null
Wait-ForTrack $CurrentTitle | Out-Null
Write-Output 'PASS: Android media controls resumed at the checkpoint and published both tracks.'
