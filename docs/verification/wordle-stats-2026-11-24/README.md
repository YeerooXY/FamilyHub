# Wordle statistics page, hub tile and yesterday's results, 24 November 2026

`node tests/daily_wordle.cjs` (set `WORDLE_CAPTURE` to this folder for the captures). It covers the statistics page below the puzzle (the Statistics button scrolls to it and focuses its heading; Back to puzzle returns focus to the board), the family streak, rounds won, per-player averages, and yesterday's results, which open once per day. Grade icons and guess times keep one column each in the guess list. The day text is no longer drawn.

Round rules (`music_web/wordle.py`, `round_key`): fewest guesses wins; a tie goes to the game that followed Hard Mode rules, then to the faster active time. A round counts after its day ends and only with two or more players.

Captures: `hub-desktop.png`, `hub-iphone.png`, `hub-tv.png` (the live Wordle tile), `*-stats.png`, `*-member.png`, `*-review.png`. Mac and iPhone are WebKit emulation; physical devices are not checked.
