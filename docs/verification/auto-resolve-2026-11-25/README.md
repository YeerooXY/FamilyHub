# Equivalent playlist recordings

The matcher compares titles after normalizing punctuation and accents and removing upload labels, artist prefixes, and bracketed album and featured-artist credits. The retained title must match, the upload must be a Topic result or come from the artist's channel, and its duration must be within two seconds of the playlist entry. Plausible uploads must agree on duration. An exact title from Release - Topic or the artist's channel takes precedence, with the source ID used to settle ties. Existing match ranking still handles other new searches.

At server startup and when preparation starts or resumes, the server checks stored candidates for unclaimed entries in review. A selected source enters the existing preparation flow, which honors the playlist's download settings. Each saved decision logs the playlist ID prefix and a running count for that recheck.

## Offline cases

- The Deezer album examples cover Sexy Magic, Sandunguea, TRDWFE, All Again, Overtown Lights, Burn This Shit Down, Interesting, RCKSTRL!VING, Cookin, 50 Bands (feat. Flo Milli), Don't Play Around, and Mutual Death Warrant. The reported 196-second length is used for Sexy Magic and as a fixture value for the other songs.
- Edition labels such as Remix, Extended Mix, Original Mix, Live, and Radio Edit keep a different recording out of the recheck. The fixtures also cover a five-second duration gap, two plausible uploads of different lengths, a fan channel, an empty candidate list, and distinct Hungarian titles. Accents in equivalent Hungarian titles still normalize.
- Workflow tests cover a new Deezer import, a startup recheck without a search, a paused download with a resolved entry before its cursor, a repeated recheck, and preservation of human selections.
- On resume, a review resolved before the cursor returns to the preparation queue. As the cursor advances across already completed tracks, the queue skips those tracks even after their indexes leave `completed_after`. The three-track regression cases cover a resolved review between two saved tracks and a resolved review at the end beyond the cursor. Both expect three found, saved and processed tracks, zero reviews or failures, and a cursor of three.

## Test results

Paddock runs `python -m unittest test_playlist_preparation test_music_web test_play_on_demand` and `python -m unittest test_security_review` after the worker finishes. Results are pending.

## Real playlist verification

Use a copy of the family playlist data to check how many of the 28 reported close candidates meet the stricter two-second rule. Confirm that the other 45 reported review entries and the two with no candidates remain in review after the recheck. On a fresh copy, exercise both startup and resume. Verify the chosen source by listening, confirm that eligible downloads progress through the normal queue, and check that each decision produces one INFO line without song or profile names.
