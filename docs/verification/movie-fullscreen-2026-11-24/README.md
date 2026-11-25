# Movies fullscreen header

On 24 November 2026, the expanded player still showed the app header with the app switcher, history arrows, and profile avatar after the playback controls faded. The expanded Movies state now hides the shell header and its skip link and collapses the header row. Leaving playback restores the header and returns focus to the title.

Run `node tests/movies_episodes.cjs docs/verification/movie-fullscreen-2026-11-24`. The fixture loads the app shell with the browser Fullscreen API unavailable. It checks player bounds from the top-left corner to the bottom-right corner, the idle and awake controls, Back, Tab, Shift+Tab, Enter, Space and touch. The episode and Next episode checks also run.

Captures cover Windows Chromium at 1280 and 2000 px, a 768 px Chromium tablet, the 360 px Pixel 7 profile, WebKit at 1280 px for Mac Safari, and iPhone 13 with reduced motion. The Mac, Android and iPhone checks use emulation. Native WebViews, physical screen edges, screen-reader announcements and true system fullscreen remain open.
