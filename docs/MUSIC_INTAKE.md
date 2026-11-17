# Music intake

> **17 November 2026:** Navidrome and Lidarr have been removed. FamilyHub Music reads the same library directly, so imports appear without a scan. Passages about them describe the earlier setup.

`scripts/music-intake.py` is the administrator's command line for audio that Lidarr does not handle: a specific YouTube video, a local recording, a single track, or an edited version with the intro or a spoken section removed. It stages each file in a workspace outside the library, records what is known about it, and copies reviewed items into `Local Imports` in the music library that Navidrome reads.

Lidarr and the torrent path stay as described in [Music import](history/MUSIC_IMPORT.md). This tool does not call them and does not touch their files.

## Status

| Item | State |
| --- | --- |
| Script and tests | Current repository version: Windows 20 passed, 4 skipped; Debian 24 passed, including live metadata search |
| Audio tests | Generated-tone staging, trimming, embedded tags, unchanged encoded audio, duplicates, collisions and corrupt inputs passed |
| YouTube | Public search and a Creative Commons video audio download passed on Windows and Debian; source AAC was preserved |
| VM writer role and Navidrome | A 3.5-second trimmed tone imported with tags, appeared once after scanning and streamed as the exact library bytes; reader ACL checks passed |

Verified 10 November 2026. See [the verification record](history/MUSIC_VERIFICATION.md). The editing interface is currently a command-line tool for the administrator.

The Topic-first search update below is installed in the development VM. After Pi hit its bounded tool-call limit, the owner explicitly chose to skip that review. All 24 Debian tests passed before installation, and a live writer-role search returned Topic tracks first afterward. The existing URL-to-folder fetch, staging, trimming and import commands are unchanged.

## Requirements

- Python 3.11 or later, standard library only.
- `ffmpeg` and `ffprobe` on PATH for `fetch`, `stage` and `trim`.
- `yt-dlp` on PATH for `search` and `fetch`. Install a current release from the [yt-dlp project](https://github.com/yt-dlp/yt-dlp) and check its README for what YouTube extraction currently needs. The repository pins no yt-dlp version.

`import` needs `ffmpeg` and `ffprobe` too, to write tags.

The development VM has the script at `/usr/local/lib/familyhub/music-intake.py`, with yt-dlp 2026.10.26, yt-dlp-ejs 0.8.0 and Deno 2.9.8 under `/usr/local/lib/familyhub/music-venv`. FFmpeg/ffprobe 7.1.5 are installed by Debian. Run as the writer role with that tool directory on PATH and a writable Deno cache:

```sh
sudo runuser -u familyhub-writer -- env \
  PATH=/usr/local/lib/familyhub/music-venv/bin:/usr/local/bin:/usr/bin:/bin \
  DENO_DIR=/srv/familyhub/data/quarantine/music/deno-cache \
  python3 /usr/local/lib/familyhub/music-intake.py search "artist song"
```

Use `/srv/familyhub/data/quarantine/music/intake` as the workspace and `/srv/familyhub/data/media/music` as the library. Both were prepared in the development VM. Source changes at YouTube can require updating yt-dlp and its JavaScript dependencies; these are the tested versions, not a guarantee of future extraction.

## Commands

Every command prints JSON on success. On failure it prints one short line to standard error and exits with status 1.

```sh
python3 scripts/music-intake.py search "QUERY" [--limit N]
python3 scripts/music-intake.py fetch URL --workspace PATH
python3 scripts/music-intake.py stage FILE --workspace PATH
python3 scripts/music-intake.py trim ITEM --keep START:END [--keep START:END ...]
python3 scripts/music-intake.py import ITEM --library PATH --artist TEXT --album TEXT --title TEXT [--track N]
```

`ITEM` is the path of a staged item directory, as printed in the `item` field.

### search

Lists up to `--limit` public YouTube results (default 5, maximum 10) with id, URL, title, channel, duration and `kind`. It downloads nothing. Pick a result yourself and pass its URL to `fetch`.

Search reads metadata for up to 30 results in one yt-dlp call, drops invalid and duplicate video IDs, ranks the rest and then applies `--limit`. Ranking classes, in order, with yt-dlp's order kept inside each class:

1. `topic`: the channel or uploader name ends in `- Topic` (case and spacing around the dash ignored). YouTube generates these channels from label-supplied audio.
2. `audio`: the title says "Official Audio" or has "(Audio)" or "[Audio]".
3. `other`: everything else, including results with missing metadata.
4. `video`: the title contains "Music Video" (for example "Official Music Video").

The word "topic" in a title and the word "official" alone change nothing. These are guesses from names. They do not show that a result is the right song, good quality or free to download; check the result and your right to use it before `fetch`.

To fetch a chosen result, create the workspace directory first (`fetch` does not create it), then pass the result's `url`:

```sh
mkdir -p ./intake
python3 scripts/music-intake.py fetch "https://www.youtube.com/watch?v=VIDEO_ID" --workspace ./intake
```

The JSON `item` field is the new item directory, for example `/your/current/directory/intake/yt-VIDEOID-0123456789ab`; the audio is `audio.EXT` inside it. The source codec is retained, often Opus in `.opus` or AAC in `.m4a`, never forced to MP3. On the development VM, use the prepared workspace and writer-role command shown above.

### fetch

Accepts one video URL in the form `https://www.youtube.com/watch?v=VIDEO_ID` or `https://youtu.be/VIDEO_ID`. Playlist, channel and live URLs are refused. Extra parameters such as `list=` are dropped, so only the named video is fetched. Live or upcoming streams and videos longer than four hours are refused.

yt-dlp runs with `--ignore-config --no-playlist -f bestaudio --extract-audio --audio-format best`. It uses no cookies, no browser session and no login. The audio keeps its source codec with no re-encode; yt-dlp may move it to a matching audio container. If the video has no audio-only format, or the download fails, the command reports yt-dlp's error and stops. It tries no other format and no other site.

The file is accepted only after `ffprobe` finds exactly one audio stream and `ffmpeg` decodes the whole file without an error.

### stage

Copies a local audio file into the workspace through the same inspection and decode check. The source file is opened read-only and is never changed. Symbolic links, directories and other non-regular files are refused. Accepted extensions: `aac aif aiff flac m4a mka mp3 oga ogg opus wav webm wv`.

### trim

Keeps the listed intervals and removes everything else. Times are seconds with up to six decimals, for example `--keep 12.5:201`. Intervals must be in order, must not overlap, must be longer than zero and must end within the item's duration.

- One interval removes an intro, an outro or both.
- Several intervals remove sections in the middle; the kept parts are joined in order.

You choose the times by listening. The tool detects neither silence nor music.

The result is a new item. The parent item and its bytes stay as they were. ffmpeg decodes the parent, resets timestamps to start at zero, applies `atrim`, `asetpts` and `concat`, and writes FLAC. The cut points are sample-accurate on the decoded timeline, not on the compressed packets; the tool checks that the result lasts the kept time within 0.1 s.

FLAC is used so that the edit adds no second lossy encode. The decoder's output is converted to FLAC's integer samples, which does not make the audio lossless or restore anything lost before staging. A trimmed YouTube item is still derived from lossy audio, and its manifest says so. The FLAC file is also several times larger per minute than the Opus or AAC file it came from.

### import

Writes a tagged copy of the staged audio to:

```text
LIBRARY/Local Imports/ARTIST/ALBUM/NN - TITLE.ext
```

`NN - ` appears only with `--track`. Characters that file systems reject (`< > : " / \ | ? *` and control characters) become `_` in the path. The manifest keeps the text exactly as typed.

`LIBRARY` is the music root that Navidrome reads, `/srv/familyhub/data/media/music` on the VM. Lidarr's root folder is its subfolder `Managed`; `Local Imports` is a sibling of it, so the two never share a folder. The tool writes only under `Local Imports`.

**Tags.** ffmpeg copies the audio stream into a fresh file with `-c:a copy` and sets `title`, `artist`, `album_artist` (the artist), `album` and, with `--track`, `track`. Other tags, chapters and cover art of the staged file are not carried over. The staged file is never changed. Before publishing, the tool reads the tags back, compares a SHA-256 of the compressed audio packets of the copy with the staged file, and decodes the copy completely. A container that cannot carry the tags (raw `.aac`, for example) or an audio mismatch refuses the import; nothing is transcoded. Navidrome reads these tags. Its API returned the expected artist, album and title for the generated test track; visual display in player applications remains untested.

- Repeating the same import reports `"existing": true` and changes nothing. A repeat is recognised by the recorded artist, album, title, track, path and the library file's SHA-256, because a second tagged copy need not be byte-identical.
- If any other file has that name, including an edited copy of an earlier import, the import is refused and nothing changes. If a crash left a published file without a manifest record, delete that library file and run the import again.
- An item already imported under one name is refused under another name while the first file exists.
- The copy is written in a hidden `.import-*` directory next to the target, then published with a hard link that cannot replace an existing file. A failed import leaves no file under a playable name.

Run the import as the writer role so that new files and directories get the owner and default ACL the storage layout expects.

Navidrome finds the file at its next periodic scan. For an immediate result, sign in to the Navidrome web interface as an administrator and start a scan there. The tool creates no Navidrome credential and makes no API call.

## Workspace and manifest

A workspace is any existing directory outside the music library. Each item is one directory:

```text
WORKSPACE/
  yt-VIDEOID-0123456789ab/      fetched; suffix is the first 12 hex digits of the SHA-256
  local-0123456789abcdef/       staged local file; first 16 hex digits of the SHA-256
  edit-0123456789abcdef/        trim result; hash of the parent SHA-256 and the kept intervals
    audio.flac
    manifest.json
```

The same bytes or the same trim always give the same id, so repeating a command returns the existing item. Distinct sources and distinct trims get distinct ids. Staged audio is set read-only, and every `trim` and `import` first checks it against the manifest's SHA-256.

```json
{
 "schema": 1,
 "id": "edit-0123456789abcdef",
 "source": {"kind": "youtube", "url": "https://www.youtube.com/watch?v=VIDEOID", "id": "VIDEOID",
            "title": "...", "channel": "...", "lossy": true,
            "reported_format": {"format_id": "251", "acodec": "opus", "abr": 128.0}},
 "edit": {"parent": "yt-VIDEOID-0123456789ab", "parent_sha256": "...", "keep": [[12.5, 201.0]]},
 "audio": {"file": "audio.flac", "sha256": "...", "size": 20000000, "codec": "flac", "format": "flac",
           "sample_rate": 48000, "channels": 2, "duration": 188.5, "bit_rate": 850000},
 "import": {"path": "Local Imports/Artist/Album/01 - Title.flac", "sha256": "...", "library_sha256": "...",
            "artist": "Artist", "album": "Album", "title": "Title", "track": 1}
}
```

- `source` describes where the audio first came from. An edit carries its parent's `source` unchanged.
- `source.lossy` is `true` for YouTube and `null` for local files. `null` means unknown: a FLAC file can hold audio that was once an MP3, and the codec does not settle that.
- `reported_format` is what yt-dlp reported for the selected format. `audio` holds what ffprobe measured in the staged file.
- `edit` is `null` for fetched and staged items. `import` is `null` until the item is imported. In `import`, `sha256` is the staged audio file and `library_sha256` is the tagged file in the library; they differ.
- The manifest stores no stream URL, cookie or credential. A local item records the source file name without its directory.

The manifest is replaced atomically. An interrupted command leaves the previous manifest in place.

## Limits

- Only five tags; no cover art or MusicBrainz identity. Imported files are not Lidarr releases and lie outside Lidarr's root folder `Managed`.
- Private admin tool. It refuses links at the item, workspace, library and library-subfolder level, but does not defend against another user changing those folders while it runs.
- No removal command. To withdraw an import, delete the library file; to discard an item, delete its directory.
- An interrupted `fetch`, `stage` or `trim` can leave a `.tmp-*` directory in the workspace. It holds no finished item and can be deleted.
- Child output goes to temporary files and only the last 600 bytes of error text are read, so memory stays small. Standard output is size-checked after the child ends, not while it runs. A command that hits its time limit stops the direct child process only; a helper it started, such as ffmpeg under yt-dlp, can keep running on Windows and Linux.
- Any error message from ffmpeg during the full decode rejects the file. A file with a harmless decoder complaint is refused too.
- Download only audio you have the right to copy.

## Tests

```sh
python -m unittest discover -s tests -v
```

| Group | Needs | Covers |
| --- | --- | --- |
| Boundary tests | Python only | URL validation, interval validation, malformed manifests, changed bytes, path traversal, symbolic links, duplicate import, name collision |
| Audio tests | `ffmpeg`, `ffprobe` | Generated tones: stage, repeat stage, trim two intervals; duration, SHA-256 and unchanged original; corrupt and video-only input. Import: embedded tags, identical decoded audio and packets, unchanged staged bytes, repeat, different-bytes collision, edited library file, a container that cannot hold tags |
| Network test | `FAMILYHUB_NETWORK_TESTS=1`, `yt-dlp` | One public search with three results at most |

Groups whose tools are missing are skipped and reported as skipped. No test downloads audio; `fetch` has no automated test.
