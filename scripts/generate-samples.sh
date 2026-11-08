#!/usr/bin/env bash
# Generate synthetic playback fixtures as familyhub-writer (root only; needs ffmpeg + ffprobe).
# Writes only named synthetic fixture paths; skips non-empty media targets; removes its own temporary files.
set -euo pipefail

DATA=${FAMILYHUB_DATA:-/srv/familyhub/data}
WRITER=${FAMILYHUB_WRITER_NAME:-familyhub-writer}
S="FamilyHub Samples"

die() { echo "generate-samples: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || die "ffmpeg and ffprobe are required"
id "$WRITER" >/dev/null 2>&1 || die "user $WRITER missing (run bootstrap-storage.sh first)"
check_dir() {
  local cur="" part
  local IFS=/
  [[ $1 == /* ]] || die "path must be absolute: $1"
  for part in ${1#/}; do
    cur+="/$part"
    [[ ! -L $cur && ( ! -e $cur || -d $cur ) ]] || die "unsafe directory: $cur"
  done
}
check_dir "$DATA"
for d in movies tv music; do
  [ -d "$DATA/media/$d" ] && [ ! -L "$DATA/media/$d" ] || die "$DATA/media/$d missing or a symlink"
done

# Run as the writer. Args: <output> <ffmpeg args...>. Encodes to <output>.part then renames.
# Container is Matroska for video (.mkv) and FLAC for music (.flac).
gen() {
  local out=$1; shift
  check_dir "$(dirname "$out")"
  [[ ! -L $out && ! -L $out.part ]] || die "symlink at sample output: $out"
  if [ -s "$out" ]; then echo "skip (exists): $out"; return; fi
  [[ ! -e $out && ! -e $out.part ]] || die "existing empty/partial sample requires inspection: $out"
  local fmt=matroska; [[ $out == *.flac ]] && fmt=flac
  runuser -u "$WRITER" -- mkdir -p "$(dirname "$out")"
  if ! runuser -u "$WRITER" -- ffmpeg -nostdin -hide_banner -loglevel error -y "$@" -f "$fmt" "$out.part"; then
    runuser -u "$WRITER" -- rm -f "$out.part"
    die "ffmpeg failed for $out"
  fi
  runuser -u "$WRITER" -- mv -T "$out.part" "$out"
  echo "created: $out"
}

# Subtitle text lives in a temp dir that root removes at exit.
T=$(mktemp -d); chmod 755 "$T"; trap 'rm -rf "$T"' EXIT
printf '1\n00:00:01,000 --> 00:00:05,000\nEnglish subtitle: sample one.\n\n2\n00:00:05,500 --> 00:00:09,000\nEnglish subtitle: sample two.\n' >"$T/en.srt"
printf '1\n00:00:01,000 --> 00:00:05,000\nMagyar felirat: árvíztűrő tükörfúrógép.\n\n2\n00:00:05,500 --> 00:00:09,000\nMagyar felirat: második minta, őűÖŰ.\n' >"$T/hu.srt"
chmod 644 "$T"/*.srt

# 1) Movie: 1080p H.264, two tone tracks (eng 440 Hz, hun 660 Hz), two embedded SRT.
gen "$DATA/media/movies/$S/Sample 1080p (2026)/Sample 1080p (2026).mkv" \
  -f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=10" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=10" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=10" \
  -i "$T/en.srt" -i "$T/hu.srt" \
  -map 0:v -map 1:a -map 2:a -map 3 -map 4 \
  -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -threads 2 \
  -c:a aac -b:a 96k -c:s srt \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title=English-tone \
  -metadata:s:a:1 language=hun -metadata:s:a:1 title=Hungarian-tone \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title=English \
  -metadata:s:s:1 language=hun -metadata:s:s:1 title=Magyar

# 2) Movie: short 4K HEVC, 5 fps, 4 s, bounded threads.
gen "$DATA/media/movies/$S/Sample 4K HEVC (2026)/Sample 4K HEVC (2026).mkv" \
  -f lavfi -i "testsrc2=size=3840x2160:rate=5:duration=4" \
  -f lavfi -i "sine=frequency=523:sample_rate=48000:duration=4" \
  -c:v libx265 -preset ultrafast -crf 34 -pix_fmt yuv420p -threads 2 \
  -x265-params "pools=2:frame-threads=1:log-level=error" \
  -c:a aac -b:a 64k -metadata:s:a:0 language=eng

# 3) Music: two FLAC albums, each signal generated natively at its own rate (no resampling).
flac_album() { # <album> <sample_rate> <sample_fmt> <bits> <base_hz>
  local album=$1 rate=$2 fmt=$3 bits=$4 hz=$5 n
  for n in 1 2; do
    gen "$DATA/media/music/$S/Sample Artist/$album/0$n - Tone $n.flac" \
      -f lavfi -i "aevalsrc=0.1*sin(2*PI*$(( hz * n ))*t):s=$rate:d=8" \
      -c:a flac -sample_fmt "$fmt" -bits_per_raw_sample "$bits" -ar "$rate" \
      -metadata artist="Sample Artist" -metadata album_artist="Sample Artist" \
      -metadata album="$album" -metadata title="Tone $n" -metadata track="$n/2" -metadata date=2026
  done
}
flac_album "Sample CD 16-44.1" 44100 s16 16 300
flac_album "Sample HiRes 24-96" 96000 s32 24 400

# Reuse the 1080p fixture as a series episode without duplicating its bytes.
episode="$DATA/media/tv/FamilyHub Sample Series/Season 01/FamilyHub Sample Series - S01E01.mkv"
check_dir "$(dirname "$episode")"
[[ ! -L $episode ]] || die "symlink at episode output"
if [[ ! -e $episode ]]; then
  runuser -u "$WRITER" -- mkdir -p "$(dirname "$episode")"
  runuser -u "$WRITER" -- ln "$DATA/media/movies/$S/Sample 1080p (2026)/Sample 1080p (2026).mkv" "$episode"
fi

# Local fixture titles keep synthetic media separate from catalogue matches.
for kind in '1080p' '4K HEVC'; do
  nfo="$DATA/media/movies/$S/Sample $kind (2026)/Sample $kind (2026).nfo"
  [[ ! -L $nfo ]] || die "symlink at sample metadata"
  if [[ ! -e $nfo ]]; then
    runuser -u "$WRITER" -- sh -c 'printf "%s\n" "<movie><title>FamilyHub Sample $2</title><year>2026</year><plot>Synthetic test pattern and tones.</plot><lockdata>true</lockdata></movie>" > "$1"' sh "$nfo" "$kind"
  fi
done

echo "Done. Verify with ffprobe (see docs/PLAYBACK.md)."
