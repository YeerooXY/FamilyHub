#requires -RunAsAdministrator
<#
Creates the FamilyHub-Dev Hyper-V VM from a prepared VHDX and cloud-init seed ISO
under <repo>\.local\vm. Does not start the VM or touch switches, WSL, routers or host Docker.
#>
param(
    [Parameter(Mandatory)][string]$VhdxPath,
    [Parameter(Mandatory)][string]$IsoPath
)
$ErrorActionPreference = 'Stop'

$VMName = 'FamilyHub-Dev'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vmDir = [IO.Path]::GetFullPath((Join-Path $repoRoot '.local\vm'))
$prefix = $vmDir.TrimEnd('\') + '\'

function Resolve-Input([string]$Path, [string]$Ext) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "Path must be absolute: $Path" }
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Outside ${vmDir}: $full" }
    if (-not [IO.Path]::GetExtension($full).Equals($Ext, [StringComparison]::OrdinalIgnoreCase)) { throw "Expected $Ext file: $full" }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "File not found: $full" }
    # Reject reparse points on the file and every directory up to the repo root.
    for ($p = $full; $p.Length -ge $repoRoot.Length -and $p -ne [IO.Path]::GetPathRoot($p); $p = Split-Path -Parent $p) {
        if ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point not allowed: $p" }
    }
    $full
}
$vhdx = Resolve-Input $VhdxPath '.vhdx'
$iso = Resolve-Input $IsoPath '.iso'

# Preflight before any change.
$null = Get-VMSwitch -Name 'Default Switch'
if (Get-VM -Name $VMName -ErrorAction SilentlyContinue) { throw "VM $VMName already exists" }

# A failure after this point leaves the partial VM in place for inspection.
$vm = New-VM -Name $VMName -Generation 2 -MemoryStartupBytes 12GB -VHDPath $vhdx -SwitchName 'Default Switch'
Set-VMMemory -VMName $VMName -DynamicMemoryEnabled $false -StartupBytes 12GB
Set-VMProcessor -VMName $VMName -Count 6
Set-VMFirmware -VMName $VMName -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
Add-VMDvdDrive -VMName $VMName -Path $iso
Set-VMFirmware -VMName $VMName -FirstBootDevice (Get-VMHardDiskDrive -VMName $VMName)

$ips = @(Get-VMNetworkAdapter -VMName $VMName | ForEach-Object { $_.IPAddresses } | Where-Object { $_ })
[ordered]@{
    VMName         = $VMName
    Generation     = 2
    ProcessorCount = 6
    MemoryGB       = 12
    DynamicMemory  = $false
    Switch         = 'Default Switch'
    VhdxPath       = $vhdx
    SeedIsoPath    = $iso
    CreatedUtc     = (Get-Date).ToUniversalTime().ToString('o')
    IPAddresses    = $ips
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $vmDir 'created-vm.json') -Encoding UTF8

Write-Host "Created $VMName (not started). Details: $(Join-Path $vmDir 'created-vm.json')"
