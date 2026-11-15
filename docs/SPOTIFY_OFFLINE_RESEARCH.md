# Spotify offline audio research

Recorded 10 November 2026 for FamilyHub's music-library research.

The decryption method is known for a public Spotify-compatible implementation. Compatibility with the installed Windows client's offline cache remains unverified. No Spotify recording has been decrypted, converted or imported into FamilyHub during this investigation.

## Confirmed findings

- Spotify distinguishes temporary cached portions of recordings from downloads intended for offline playback. This does not establish a one-song-to-many-files layout; that needs a real sample. [Spotify storage](https://support.spotify.com/us/article/storage-information/)
- Ordinary local audio, playlist metadata and Spotify-managed downloads are different inputs. Spotify's Local Files feature plays existing audio files on the device. A playlist entry or local-file reference does not contain the recording. [Local Files](https://support.spotify.com/us/article/local-files/)
- The public librespot implementation applies AES-128-CTR when supplied an audio key. Its player requests a key using track and file identifiers, handles format-specific metadata and initializes a decoder. This documents librespot's path, not the current Windows offline-cache format. [Decryption](https://github.com/librespot-org/librespot/blob/dev/audio/src/decrypt.rs), [key requests](https://github.com/librespot-org/librespot/blob/dev/core/src/audio_key.rs), [player](https://github.com/librespot-org/librespot/blob/dev/playback/src/player.rs)
- Spotify requires going online at least every 30 days to retain downloads and says this permits collection of play data. Its support article does not establish that audio keys rotate every 30 days. [Offline listening](https://support.spotify.com/us/article/listen-offline/)

## Key validity and license expiry

A cryptographic key has no intrinsic clock. The same encrypted bytes, matching key and cipher parameters produce the same decrypted bytes regardless of date. Playback software can enforce a license deadline, refuse access to a key or discard locally stored material.

Premium access and license renewal must therefore be distinguished from generating a new audio key. We have not established whether this desktop client's renewal changes the license, the key, or both. Knowing the algorithm alone does not provide the matching key or a working converter.

For protected audio, the conceptual stages are: identify and assemble the stored payload, decrypt it with the matching parameters, decode the audio, and encode another format if required. Reassembly alone leaves encrypted data encrypted.

## Local REA evidence and limits

The inspected Windows installation was Spotify 1.3.8.620. Static analysis of `Spotify.dll` found sample-decryption handling, a Vorbis decoder initialization path and internal offline-playback/license request wrappers. An embedded `OfflineLicenseInfo` response schema contains track and episode expiry timestamps; that particular response does not contain an audio key.

The analyzed DLL's SHA-256 was `769ac5a1a282f470b663a1c3933774f56d954f8f0dbfd156f9d799a173c79406`. Function roles inferred from decompiled code remain subject to analysis limitations. The latest native pass disabled global Stack and Decompiler Switch analysis.

A generated WAV tone was encrypted and decrypted with our own test key and recovered byte-for-byte. That verifies the synthetic test only. Playback through Spotify and compatibility with actual downloads were not tested.

Local evidence remains outside this repository under `C:\Users\you\AppData\Local\REA-Dependencies\spotify-targeted`, `spotify-audio-path` and `synthetic-audio-test`. The saved analysis snapshot contains cached observations rather than a persistent Ghidra project. Standard Spotify storage folders were absent at the last check; no real download sample was available.

## Proposed sample investigation

1. Record the Spotify version and configured storage location; inventory existing filenames, sizes and SHA-256 hashes without clearing the cache.
2. Download a playlist containing one song through the normal Spotify app, once an account capable of downloading is available.
3. Compare created and changed files. Account for reused cached data and unrelated artwork, database and log updates.
4. Inspect copies for structure, completeness and any chunk index or ordering information. File timestamps alone do not establish chunk order; a missing audio header does not prove encryption.
5. Report what the sample establishes before selecting a reconstruction or decoding approach.

This is an investigation proposal, not an implemented download or conversion workflow. No telemetry measurements establish whether any particular conversion method is detectable.

## FamilyHub implications and reuse

Spotify cache conversion is an unverified acquisition route. FamilyHub's existing music flow still needs ordinary, validated audio files before library import. Reuse the candidate directory `/srv/familyhub/data/quarantine/music`, the existing media-probing checks and the Navidrome playback checks described in [Acquisition](ACQUISITION.md), [Playback](PLAYBACK.md) and [Playback verification](PLAYBACK_VERIFICATION.md).

Keep source provenance and actual codec/bitrate findings with any candidate. Encoding lossy audio as FLAC does not restore lost information; producing an MP3 can introduce further loss. This research does not select a lossy fallback, alter the owner's quality requirements or establish original-quality delivery from Spotify.

The earlier playlist research at `C:\Users\you\Projects\free-music-research-2026-10-28\spotify-investigation-2026-10-29` reports 35 local-file references. Its CSV/JSON can help match original files supplied later; those exports contain metadata rather than recordings.
