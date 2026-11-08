#!/usr/bin/env bash
# Create only acquisition apps' private appdata children; downloads stay under storage bootstrap.
set -euo pipefail

APPDATA=${FAMILYHUB_APPDATA:-/srv/familyhub/appdata}
WRITER_ID=${FAMILYHUB_WRITER_ID:-2000}
die() { echo "bootstrap-acquisition: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[[ $WRITER_ID =~ ^[0-9]+$ ]] || die "bad writer ID"
getent passwd "$WRITER_ID" >/dev/null || die "UID $WRITER_ID does not exist (run bootstrap-storage.sh first)"
getent group "$WRITER_ID" >/dev/null || die "GID $WRITER_ID does not exist"
[[ $APPDATA == /* ]] || die "appdata path must be absolute"

# Check every existing ancestor before any filesystem change; never follow symlinks.
p=""
IFS=/ read -ra parts <<<"${APPDATA#/}"
for c in "${parts[@]}"; do
  p="$p/$c"
  [ ! -L "$p" ] || die "symlink in path: $p"
  [ -d "$p" ] || die "missing or non-directory path component: $p"
done
[ "$(stat -c %u "$APPDATA")" = 0 ] || die "appdata parent must be root-owned"
[ "$(stat -c %a "$APPDATA")" = 700 ] || die "appdata parent must have mode 0700"

dirs=("$APPDATA/qbittorrent" "$APPDATA/prowlarr")
for d in "${dirs[@]}"; do
  [ ! -L "$d" ] || die "$d is a symlink"
  if [ -e "$d" ]; then
    [ -d "$d" ] || die "$d exists and is not a directory"
    owner=$(stat -c %u "$d")
    [ "$owner" = 0 ] || [ "$owner" = "$WRITER_ID" ] || die "$d has unexpected owner $owner"
  fi
done

# All validation precedes changes; reruns preserve contents and remove nothing.
for d in "${dirs[@]}"; do
  [ -d "$d" ] || mkdir -m 0700 "$d"
  chown -h "$WRITER_ID:$WRITER_ID" "$d"
  chmod 0700 "$d"
done
echo "OK: $(stat -c '%n %U:%G %a' "$APPDATA" "${dirs[@]}")"
