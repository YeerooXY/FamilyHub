# Storage foundation verification

8 November 2026. First implementation step only.

## Implemented

- Created and started `FamilyHub-Dev`, a Hyper-V Generation 2 VM with 6 vCPUs, 12 GiB static RAM and a 200 GiB expandable VHDX.
- Used Debian 13.7 from the official Debian 13 generic amd64 cloud image. The downloaded image matched its published SHA-512 checksum over HTTPS.
- Installed Docker Engine 29.9.3 and Docker Compose plugin 5.7.0 from Docker's official Debian repository. The daemon starts automatically; no application containers are running.
- Established `/srv/familyhub/data` with downloads, movie, TV, music and quarantine directories. Downloads and media are on the same ext4 filesystem, `/dev/sda1`; the guest reports a roughly 197 GiB root filesystem.
- Established dedicated nonlogin writer and reader accounts with UID/GID 2000 and 2001. Kept application-state and database roots private to root.
- Stored development credentials, images and seed data in ignored local storage. Git contains examples and scripts, not private keys or family data.

## Checks

| Check | Result | Evidence |
|---|---|---|
| Bash syntax and ShellCheck warnings | Passed | Both storage scripts checked in isolated Debian |
| PowerShell syntax and actual VM creation | Passed | Parser accepted helper; Hyper-V created the configured VM through an administrator-approved process |
| Initial setup and repeat setup | Passed | Bootstrap and full verification ran repeatedly in isolated Debian and the actual VM |
| Writer create and cross-directory hardlink | Passed | Download and library names shared device/inode, with link count 2 |
| Reader read-only access | Passed | Reads succeeded; create, overwrite and delete attempts were denied |
| Inherited group and reader ACL | Passed | A writer-created subdirectory inherited the intended access; reader could read its file |
| Outsider/private-state isolation | Passed | `nobody` was denied data access; both media roles were denied appdata/database roots |
| Root, symlink and account-collision guards | Passed in isolated Debian | Deliberately invalid conditions failed before setup changes; normal verification passed after restoring the test conditions |
| Guest reboot and automatic startup | Passed | Guest boot ID changed; Docker and Hyper-V key-value exchange returned active |
| Persisted file, permissions and initialization | Passed | Sample checksum and initial setup marker stayed unchanged; full permissions verification passed after reboot |
| Temporary probe cleanup | Passed | Verification removed its unique scratch directories; the reboot probe was removed after checking |
| Cloud-init completion | Passed | Reported done with no errors or recoverable errors |

The Default Switch assigned a different IP on reboot. SSH access was verified using the previously trusted host key at the new address. This is a development networking limitation, not data loss; current connection information remains local.

## Scope and remaining checks

No media was acquired, no playback service was deployed, and no family files were imported. Music quality enforcement, actual clients, LAN access, Intel Quick Sync, storage quotas and a physically independent backup/restore remain unverified. The persistence check establishes reboot survival, not protection from disk failure.

The next step is sample playback on this storage layout. It needs its own bounded implementation and client checks.

## Sources and implementation provenance

- [Official Debian cloud images](https://cloud.debian.org/images/cloud/trixie/latest/).
- [Docker Engine installation on Debian](https://docs.docker.com/engine/install/debian/).
- [Cloud-init NoCloud seed](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html).
- [Microsoft New-VM documentation](https://learn.microsoft.com/en-us/powershell/module/hyper-v/new-vm).

Local Strata was unavailable. The initial free Pi/North Mini Code medium worker reached its tool/response limit and left incomplete drafts. The owner approved a smaller retry through the included Claude account. Claude Sonnet medium completed that retry in one pass. Lead integration checks found and corrected a bootstrap return-status bug, reset unexpected ACLs on managed directory roots and tightened scratch-path cleanup before runtime use. No additional model review loop ran.
