#!/usr/bin/env bash
# Creates the FamilyHub storage roots and service accounts. Run as root on Debian.
# Non-recursive, no deletion, safe to rerun. Does not create a host /data.
set -euo pipefail

ROOT=/srv/familyhub
DATA=$ROOT/data
WRITER=familyhub-writer; WID=2000
READER=familyhub-reader; RID=2001

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
for t in setfacl getfacl runuser useradd groupadd getent stat; do
  command -v "$t" >/dev/null || die "missing tool: $t (install package acl/passwd/util-linux first)"
done

DATA_DIRS=(
  "$DATA" "$DATA/downloads" "$DATA/downloads/incomplete" "$DATA/downloads/complete"
  "$DATA/media" "$DATA/media/movies" "$DATA/media/tv" "$DATA/media/music"
  "$DATA/quarantine" "$DATA/quarantine/music"
)
PRIVATE_DIRS=("$ROOT/appdata" "$ROOT/databases")

# Every existing component of every target path must be a real directory.
check_path() {
  local cur="" seg
  local IFS=/
  for seg in ${1#/}; do
    cur+="/$seg"
    [[ -L $cur ]] && die "symlink in path: $cur"
    [[ ! -e $cur || -d $cur ]] || die "not a directory: $cur"
  done
}
for d in "${DATA_DIRS[@]}" "${PRIVATE_DIRS[@]}"; do check_path "$d"; done

# Accept an existing account only if it is exactly the intended role; reject any collision.
check_role() {
  local name=$1 id=$2 e
  if e=$(getent passwd "$name"); then
    IFS=: read -r _ _ u g _ home shell <<<"$e"
    [[ $u == "$id" && $g == "$id" ]] || die "user $name exists with uid/gid $u/$g"
    [[ $home == /nonexistent && $shell == */nologin ]] || die "user $name is not a no-home nologin account"
  else
    getent passwd "$id" >/dev/null && die "uid $id is taken"
  fi
  if e=$(getent group "$name"); then
    IFS=: read -r _ _ g _ <<<"$e"
    [[ $g == "$id" ]] || die "group $name exists with gid $g"
  else
    getent group "$id" >/dev/null && die "gid $id is taken"
  fi
  return 0
}
check_role "$WRITER" "$WID"
check_role "$READER" "$RID"

mkrole() {
  getent group "$1" >/dev/null || groupadd -g "$2" "$1"
  getent passwd "$1" >/dev/null || \
    useradd -M -N -u "$2" -g "$2" -d /nonexistent -s /usr/sbin/nologin -c "FamilyHub $1" "$1"
}
mkrole "$WRITER" "$WID"
mkrole "$READER" "$RID"

mkdir -p /srv
[[ -d $ROOT ]] || mkdir "$ROOT"
chown root:root "$ROOT"; chmod 0711 "$ROOT"   # traversable, not listable

for d in "${DATA_DIRS[@]}"; do
  [[ -d $d ]] || mkdir "$d"
  chown "root:$WRITER" "$d"
  setfacl -b -k "$d"
  chmod 2770 "$d"
  setfacl -m "g:$READER:r-x,m::rwx" "$d"
  setfacl -d -m "u::rwx,g::rwx,g:$READER:r-x,m::rwx,o::---" "$d"
done

for d in "${PRIVATE_DIRS[@]}"; do
  [[ -d $d ]] || mkdir "$d"
  chown root:root "$d"
  setfacl -b -k "$d"
  chmod 0700 "$d"
done

echo "storage roots ready under $ROOT (container mapping: $DATA -> /data)"
