#!/usr/bin/env bash
# Root-only checks of the storage roots made by bootstrap-storage.sh. Creates unique
# scratch directories and removes only those exact paths on exit.
set -euo pipefail

ROOT=/srv/familyhub
DATA=$ROOT/data
W=familyhub-writer
R=familyhub-reader
A="" B=""

die() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }
as() { local u=$1; shift; runuser -u "$u" -- "$@"; }
allow() { "$@" >/dev/null 2>&1 || die "expected success: $*"; }
deny() { if "$@" >/dev/null 2>&1; then die "expected denial: $*"; fi; }

cleanup() {
  local p
  for p in "$A" "$B"; do
    if [[ ( $p == "$DATA/downloads/complete/"writer_test.* || $p == "$DATA/media/music/"writer_test.* ) && ! -L $p && -d $p ]]; then
      rm -rf -- "$p"
    fi
  done
  return 0
}
trap cleanup EXIT

[[ $EUID -eq 0 ]] || die "run as root"
for t in runuser getfacl stat mktemp ln sha256sum; do command -v "$t" >/dev/null || die "missing tool: $t"; done
cd /

# Layout, owners, modes, ACLs.
for d in downloads/incomplete downloads/complete media/movies media/tv media/music quarantine/music; do
  p=$DATA/$d
  [[ $(stat -c '%U:%G:%a' "$p") == "root:$W:2770" ]] || die "owner/mode of $p"
  acl=$(getfacl -cp "$p")
  grep -qx "group:$R:r-x" <<<"$acl" || die "reader ACL missing on $p"
  grep -qx "default:group:$R:r-x" <<<"$acl" || die "default reader ACL missing on $p"
  grep -qx 'other::---' <<<"$acl" || die "other access on $p"
done
for d in appdata databases; do
  p=$ROOT/$d
  [[ $(stat -c '%U:%G:%a' "$p") == "root:root:700" ]] || die "owner/mode of $p"
  [[ -z $(getfacl -cp "$p" | grep -Ev '^(user|group|other)::|^$') ]] || die "unexpected ACL on $p"
done
pass "layout, modes and ACLs"

A=$(mktemp -d -p "$DATA/downloads/complete" writer_test.XXXXXX)
B=$(mktemp -d -p "$DATA/media/music" writer_test.XXXXXX)
for p in "$A" "$B"; do chown "$W:$W" "$p"; chmod 2770 "$p"; done

# Writer creates a file and a subdirectory, then hardlinks into media.
allow as "$W" sh -c 'echo sample > "$1/sample.txt"; mkdir "$1/sub"; echo inner > "$1/sub/f"' sh "$A"
as "$W" ln "$A/sample.txt" "$B/linked.txt" || die "writer could not hardlink into media/music (different filesystem?)"
[[ $(stat -c '%d:%i' "$A/sample.txt") == "$(stat -c '%d:%i' "$B/linked.txt")" ]] || die "device/inode differ"
[[ $(stat -c '%h' "$A/sample.txt") == 2 ]] || die "link count is not 2"
pass "writer hardlink: same device and inode, link count 2"

# Inherited ACLs and group on a writer-created subdirectory.
[[ $(stat -c '%G' "$A/sub") == "$W" ]] || die "subdir did not inherit group"
getfacl -cp "$A/sub" | grep -qx "group:$R:r-x" || die "subdir missing inherited reader ACL"
allow as "$R" cat "$A/sub/f"
pass "inheritance"

# Reader: read yes; create, overwrite, delete no.
sum=$(sha256sum <"$A/sample.txt")
for s in "$A" "$B"; do
  allow as "$R" ls "$s"
  deny as "$R" touch "$s/reader_new"
  deny as "$R" sh -c 'echo x > "$1"' sh "$s/${s##*/}-nope"
  deny as "$R" mkdir "$s/reader_dir"
done
allow as "$R" cat "$A/sample.txt"
allow as "$R" cat "$B/linked.txt"
deny as "$R" sh -c 'echo x > "$1"' sh "$A/sample.txt"
deny as "$R" sh -c 'echo x > "$1"' sh "$B/linked.txt"
deny as "$R" rm -f "$A/sample.txt"
deny as "$R" rm -f "$B/linked.txt"
deny as "$R" rm -f "$A/sub/f"
[[ $(sha256sum <"$B/linked.txt") == "$sum" && -e $A/sample.txt && -e $B/linked.txt ]] || die "reader changed data"
pass "reader is read-only"

# Outsider and private roots.
deny as nobody ls "$DATA"
deny as nobody cat "$A/sample.txt"
for u in "$W" "$R"; do
  for d in appdata databases; do deny as "$u" ls "$ROOT/$d"; deny as "$u" test -x "$ROOT/$d"; done
done
pass "outsider and private roots denied"
echo "all storage checks passed"
