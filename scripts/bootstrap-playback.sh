#!/usr/bin/env bash
# Create the three playback appdata children (root only). Parent stays root:root 0700.
# Non-recursive; creates or re-owns only the named directories; deletes nothing.
set -euo pipefail

APPDATA=${FAMILYHUB_APPDATA:-/srv/familyhub/appdata}
READER_ID=${FAMILYHUB_READER_ID:-2001}
CHILDREN=(jellyfin jellyfin-cache navidrome)

die() { echo "bootstrap-playback: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[[ $READER_ID =~ ^[0-9]+$ ]] || die "bad reader ID"
getent passwd "$READER_ID" >/dev/null || die "UID $READER_ID does not exist (run bootstrap-storage.sh first)"
getent group "$READER_ID" >/dev/null || die "GID $READER_ID does not exist"
[[ $APPDATA == /* ]] || die "appdata path must be absolute"

# Preflight: no symlink in any component, appdata is a real directory.
p=""
IFS=/ read -ra parts <<<"${APPDATA#/}"
for c in "${parts[@]}"; do
  p="$p/$c"
  [ ! -L "$p" ] || die "symlink in path: $p"
done
[ -d "$APPDATA" ] || die "$APPDATA is not a directory"

for c in "${CHILDREN[@]}"; do
  d="$APPDATA/$c"
  [ ! -L "$d" ] || die "$d is a symlink"
  if [ -e "$d" ]; then
    [ -d "$d" ] || die "$d exists and is not a directory"
    owner=$(stat -c %u "$d")
    [ "$owner" = 0 ] || [ "$owner" = "$READER_ID" ] || die "$d has unexpected owner $owner"
  fi
done

# Changes only after every check passed.
for c in "${CHILDREN[@]}"; do
  d="$APPDATA/$c"
  [ -d "$d" ] || mkdir -m 0700 "$d"
  chown -h "$READER_ID:$READER_ID" "$d"
  chmod 0700 "$d"
done

echo "OK: $(stat -c '%n %U:%G %a' "$APPDATA" "${CHILDREN[@]/#/$APPDATA/}")"
