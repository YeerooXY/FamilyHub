# Profile password card, 24 Nov 2026

Sign-in and first-password creation, rendered from the Windows client in the popup fixture (`password-signin`, `password-create`) with `node tests/profile_password_card.cjs`.

| Profile | Engine | Width |
| --- | --- | --- |
| Windows desktop | Chromium | 1280 |
| Mac desktop (emulated) | WebKit | 850 |
| Android (Pixel 7 profile, emulated) | Chromium | 390 |
| iPhone (iPhone 13 profile, emulated) | WebKit | 390 |

Checked: card inside the window with no horizontal scroll; eye toggles the field type and `aria-pressed`; create stays disabled until both fields match and have 8 characters, with a live mismatch hint; buttons 44 px or larger; Tab from the field reaches the eye; focus is on the password field when the card opens; Cancel returns focus to the profile that opened it (this failed before the fix, focus fell to the page).

Emulated only: the real macOS and iOS font rendering and the on-screen keyboard overlap were not checked on a physical Mac or iPhone. Still to check on a real phone: the card scrolls above the keyboard.
