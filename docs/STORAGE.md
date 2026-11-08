# Storage foundation

Status: **verified in the FamilyHub Debian development VM**, including a guest reboot. Docker Engine and Compose are installed; no playback, download, file or photo application is deployed. See [the verification record](STORAGE_VERIFICATION.md).

## Layout (Debian host)

```
/srv/familyhub/data/downloads/{incomplete,complete}
/srv/familyhub/data/media/{movies,tv,music}
/srv/familyhub/data/quarantine/music
/srv/familyhub/appdata      root-only, 0700
/srv/familyhub/databases    root-only, 0700
```

Containers will later see `/srv/familyhub/data` as `/data`. The scripts create no host `/data`. Downloads and media share one directory tree so imports can hardlink.

## Roles

| Role | Name | UID/GID | Access to data |
| --- | --- | --- | --- |
| Writer | `familyhub-writer` | 2000 | rwx via group |
| Reader | `familyhub-reader` | 2001 | r-x via named ACL |
| Others | | | none |

Both accounts are nologin with no home. Data directories are `root:familyhub-writer` mode `2770` (setgid) with default inheritable ACLs. `appdata` and `databases` have no extended ACL and no access for either role. The SSH development administrator uses `sudo` to inspect protected storage; it is not a family application account.

## Commands

On the Debian host, as root, with `acl` and `util-linux` already installed (the scripts install nothing):

```
bash scripts/bootstrap-storage.sh
bash scripts/verify-storage.sh
```

`bootstrap-storage.sh` first checks that existing path components are real directories (no symlinks) and that the names and IDs 2000/2001 are free or already match these roles; otherwise it stops before changing anything. It reapplies the intended ownership and ACLs on the listed roots. It does not recurse, delete, or change existing file contents, and it is safe to rerun.

`verify-storage.sh` makes unique `writer_test.*` directories in `downloads/complete` and `media/music`, and removes only those. It checks modes and ACLs, writer-created hardlink (same device and inode, link count 2), ACL inheritance on a writer-created subdirectory, reader read-only behavior, and denial for `nobody` and for both roles on `appdata`/`databases`.

## Development VM (Windows, Hyper-V)

Preconditions: Hyper-V enabled; an existing `Default Switch`; no VM named `FamilyHub-Dev`; a prepared Debian VHDX (convert the downloaded qcow2 first) and a cloud-init seed ISO, both under `.local\vm`.

From an elevated PowerShell:

```
.\scripts\Initialize-FamilyHubVM.ps1 -VhdxPath C:\Users\you\Projects\FamilyHub\.local\vm\<disk>.vhdx -IsoPath C:\Users\you\Projects\FamilyHub\.local\vm\<seed>.iso
```

It creates a Generation 2 VM with 6 vCPUs, 12 GB static memory, Secure Boot (Microsoft UEFI CA template), the disk as first boot device and the seed ISO attached. It does not start the VM and does not change switches, WSL, routers or host Docker. A failure leaves the partial VM for inspection. Details go to `.local\vm\created-vm.json`.

The existing development VM has been started and verified. Its disk is `.local\vm\FamilyHub-Dev-200G.vhdx`, with a 200 GiB virtual capacity. The cloud-init seed installed Debian prerequisites, official Docker Engine/Compose packages and the storage scripts. The Hyper-V key-value exchange daemon is enabled so Hyper-V can report guest networking.

Development-only SSH keys, the seed, disk images and local connection metadata are under the Git-ignored `.local\vm` directory. Never commit them. The guest administrator is `familyhub`, with key authentication and password login disabled. The last verified IP is recorded in `.local\vm\runtime-vm.json`; the Default Switch DHCP address can change after a reboot. The known-host entry `familyhub-dev` pins this VM's SSH host key independently of its IP.

From this repository on the workstation, use the current VM address:

```powershell
ssh -i .local/vm/id_ed25519 -o HostKeyAlias=familyhub-dev -o StrictHostKeyChecking=yes -o UserKnownHostsFile=.local/vm/known_hosts familyhub@<VM_IP>
```

The installed guest copies are `/usr/local/lib/familyhub/bootstrap-storage.sh` and `/usr/local/lib/familyhub/verify-storage.sh`; run them with `sudo bash`. The seed prepares the VM once. Future script changes need to be copied to the guest explicitly; editing Git does not update a running VM.

## Limits

- Hyper-V is a test environment only. Physical production Debian runs on bare metal and needs no Intel hypervisor.
- The VM's virtual disk is not the production filesystem. A passing ACL, permission or hardlink check there says nothing about the production filesystem; repeat `verify-storage.sh` on the real one.
- A hardlink shows two names for one inode. It does not show snapshot or copy-on-write behavior.
- High-quality music is a user requirement. Codecs, formats and fallback behavior are not approved.
- The Default Switch is a development NAT network. Actual LAN phone/TV access and stable naming have not been configured or tested.
- Cloud image/seed preparation is currently retained locally. This milestone delivers the storage scripts and VM creation helper, not a turnkey cross-machine installer.
