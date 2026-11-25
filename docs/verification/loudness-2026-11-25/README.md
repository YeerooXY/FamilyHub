# Music playback loudness

## Automated coverage

- `tests/test_library_loudness.py` uses canned FFmpeg EBU R128 output to check integrated LUFS, positive true peak, silence, malformed output, checksum reuse, and a file change during measurement.
- `tests/test_library_index.py` checks that a new sidecar refreshes the indexed track and that playback info carries the same loudness and peak flag.
- `FamilyHub.Player.Tests` checks loud, quiet, peak-limited, unknown and disabled gain, native volume headroom, mute, the crossfade envelope and a Listen Together guest's device setting.
- `FamilyHub.Client.Core.Tests` checks loudness and the peak flag through track JSON serialization, including older records with missing fields.

The coordinating agent runs these checks.

## Playback and settings checks

1. With the server idle, let the library index worker scan a known original. Check that the library recording is byte-for-byte identical after scanning and that another scan reuses its checksum sidecar. A hot original should expose `over_peak: true` even when the selected playback copy has a lower true peak.
2. In Music Settings, confirm **Even out song volume** starts enabled. Turn it off, restart the app and confirm the device saved the choice. Check Tab, Space and the checkbox name at phone, tablet and desktop widths. Confirm that Volume level becomes available when the toggle is enabled.
3. At the Normal volume level, compare a quiet song, a loud song and a hot master. For a measured -14 LUFS song with a +4 dBFS peak, the gain is -5 dB. Quiet-track gain uses available native volume headroom up to +6 dB. At unity, the native decks can only attenuate. Audible clipping that is already encoded in a master can remain after attenuation.
4. Toggle the setting during a crossfade and while following a Listen Together host. Check that the local decks update and that room playback stays in sync. The gain uses existing song and fade events.

The Settings wording and checkbox association were checked in source. Rendered layout, visual styling, motion, keyboard focus, accessibility and on/off states are pending, including physical-device playback and screen-reader speech.
