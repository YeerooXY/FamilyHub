# API playback check

`scripts/verify-playback.py` checks the sample players through their native APIs. Python 3 stdlib only. Run as root in the Debian VM with both Compose services up.

```
sudo python3 scripts/verify-playback.py                 # setup + verify
sudo python3 scripts/verify-playback.py --verify-only   # read-only; run again after a Compose restart
```

Options: `--state-dir` (default `/srv/familyhub/appdata/playback-check`), `--media-root` (default `/srv/familyhub/data/media`), `--scan-timeout` (seconds, default 240).

## State

The state dir is `0700` and holds `credentials.json` (`0600`) with generated dev passwords for `fh-admin`, `sample-a` and `sample-b`, separate per service. Reruns reuse them. Symlinks are rejected. If a server is already configured and the credentials are missing, the script stops and does not reset it. Passwords and tokens are never printed.

## Checks

Output is JSON with one entry per check; exit code is 0 only if all pass.

- **Jellyfin:** wizard and admin setup if needed; users A/B (non-admin); Movie/TV libraries; login of all three users with `IsAdministrator` as expected; 2 movies (1080p, 2160p) and 1 episode indexed; movie favorite/played set for A and absent for B; ordinary user denied `/System/Configuration/MetadataOptions/Default` (HTTP 403; admin HTTP 200); `Range` request to `/Videos/{id}/stream?static=true` returns 206 and the first 4096 bytes equal the original file for both the 1080p movie and its hardlinked sample episode. This detects stale indexed paths as well as missing media.
- **Navidrome:** admin created on first run, users A/B (non-admin); login `isAdmin` flags; scan; 2 albums and 4 songs; song starred for A and not B; each of the 4 FLACs streamed with `format=raw` and SHA256-compared with the original under `<media-root>/music`.

`--verify-only` creates nothing and sets no favorites or stars; it re-checks the earlier state.

## Limits

- This proves API access and byte-identical original delivery. It does not prove decoding; browser, TV and phone playback remain separate checks.
- The Navidrome `/api/user` denial check passes only on HTTP 401/403; other statuses fail as unproven, and the `isAdmin=false` login result is then the evidence.
- Executed successfully on 8 November 2026, including `--verify-only` after a Compose restart. See [the verification record](PLAYBACK_VERIFICATION.md). Regular authenticated Jellyfin users can read `/System/Configuration`; the elevated metadata-defaults endpoint is the privilege boundary tested here.
