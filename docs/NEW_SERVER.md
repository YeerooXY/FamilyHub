# New server: first steps

The family server machine runs **Debian 13 (trixie)**, the same system as the development VM. These steps prepare it so the FamilyHub lead agent can finish the setup remotely over SSH. Do only these steps; do not install FamilyHub, Docker or Tailscale, and do not format, partition or mount any drive.

## 1. Check the system

```sh
. /etc/os-release && echo "$PRETTY_NAME"   # expect: Debian GNU/Linux 13 (trixie)
```

## 2. SSH server and sudo

Run as root (`su -`):

```sh
apt update && apt install -y openssh-server sudo curl
systemctl enable --now ssh
```

## 3. Let the lead agent in

Replace `USER` with the normal user created during installation. Run as root:

```sh
USER=youruser
install -d -m 700 -o "$USER" -g "$USER" /home/$USER/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMDw/J8uyblf9VHguDo235jN2WgAu5APZo8mQyJo+T3+ familyhub-lead' >> /home/$USER/.ssh/authorized_keys
chown "$USER:$USER" /home/$USER/.ssh/authorized_keys && chmod 600 /home/$USER/.ssh/authorized_keys
usermod -aG sudo "$USER"
echo "$USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/familyhub && chmod 440 /etc/sudoers.d/familyhub
visudo -c
```

The key above is a public key; it gives access only to the computer that holds the matching private key.

## 4. Report back

Send the owner the output of these commands. They contain no secrets.

```sh
hostname; whoami
ip -4 -brief address
lscpu | grep -E 'Model name|^CPU\(s\)'
free -h | head -2
lsblk -o NAME,SIZE,TYPE,ROTA,MODEL,FSTYPE,MOUNTPOINTS
systemctl is-active ssh
```

`ROTA` 1 means a spinning hard disk, 0 an SSD. The lead uses this to plan where the system, music and movies go.

## What happens next (lead agent, over SSH)

Fixed local address, Tailscale, Docker, the storage layout under `/srv/familyhub`, then moving FamilyHub Music (library, profiles, playlists, server) from the VM, Jellyfin, and switching the apps to the new server.

## Hardware and workload plan, 21 November 2026

The owner reports Debian 13 with GNOME, an i5-12500, a 10 TB IronWolf Pro NAS HDD and a 4K Optoma projector. Verify SSH access, disk identities, available RAM, network throughput and projector playback modes before migration. Keep the VM as a rollback copy and arrange an independent backup of private uploads and account data.

1. **Bring up the server.** Confirm SSH, inventory the disks, agree the storage layout and migrate the existing services. Verify profiles, playlists, listening history and playback from a phone with the workstation tunnel stopped.
2. **Test video with the integrated GPU.** Try Direct Play first. For conversions, expose the Intel render device to the Jellyfin container with appropriate render-group access, enable Quick Sync and verify a real hardware transcode. The current Compose file has no GPU device mapping. Test an actual family movie with the usual audio and subtitles, including HDR if used. [Intel CPU specifications](https://www.intel.com/content/www/us/en/products/sku/96144/intel-core-i512500-processor-18m-cache-up-to-4-60-ghz/specifications.html) · [Jellyfin Intel setup](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/intel/)
3. **Measure contention and electricity.** Record idle and playback watts at the wall. Compare daily kWh under representative loads. Each extra 10 W of average draw costs 87.6 kWh per year, multiplied by the household's applicable HUF/kWh rate. Consider a discrete GPU only if hardware transcoding misses the family's simultaneous playback target and the measured bottleneck is video processing.
4. **Coordinate work across services.** Music already reserves resources for listener activity and tracks handoff confirmation. The cross-service ordering below is proposed. Start with one heavy disk job and increase concurrency only when throughput improves without worsening interactive latency. [Music resource governor](../music_web/resources.py) · [Device handoff](../music_web/playback_devices.py)

| Priority | Event | Proposed behavior |
|---|---|---|
| Immediate | Play, skip, seek, pause, device switch, movie rebuffer | Reserve capacity for controls and for delivering the requested media. On repeated skips, discard obsolete preparation; only the latest selection may start. During handoff, keep the source authoritative until the destination confirms the track and position. Preserve healthy streams for other users. |
| Interactive | Wordle guess, file browsing, steady playback, explicit file transfer | Save guesses promptly. Accept resumable uploads immediately and throttle their byte rate when stream buffers run low. A large upload should make progress during a long movie. |
| Ahead of playback | Next song in a new playlist | Prepare one track ahead once the current track is flowing. Reuse completed downloads and cancel or reprioritize obsolete prefetch after a skip. |
| Background | Bulk imports, catalogue lookups, BPM/key, trimming, thumbnails | Apply cheap title fixes in batches and respect provider limits. Prefer 00:30–06:30 Europe/Budapest for heavy work, or start earlier after ten quiet minutes. Yield at a safe checkpoint when playback needs capacity. |

**Acceptance run.** Queue 10 GB of music, 300 title fixes, 200 trims, 100 metadata lookups and two new 20-song playlists. Upload a 2 GB video while the projector plays a movie. On a phone, play an uncached song, skip several times, then transfer playback to another device. Submit a Wordle guess during the upload. Compare against idle-server timings for tap/skip to audible audio, handoff confirmation and guess saving. Record movie stalls, upload progress, jobs finished per hour and wall energy. Repeat for Direct Play and hardware transcoding before setting production limits.
