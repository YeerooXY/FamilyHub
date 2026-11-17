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
