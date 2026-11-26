# Windows title bar after movie fullscreen

`tests/update_fullscreen.cjs` exercises Escape, Back to movies, and a simulated Windows presenter restore with the existing movie fixture. It checks that the player starts at the top edge in fullscreen and that the returned header starts at the top edge, keeps the avatar clear of the caption inset, and sends the avatar's restored hit-test rectangle. The fixture supplies a 48 CSS px header and a 139.2 CSS px right inset.

The Windows build and browser checks are pending in Paddock. Native caption height and insets at 100%, 125%, and 150% scaling, restored and maximized window placement, caption-button and drag hit testing, and physical-device and screen-reader behavior require a native Windows window. No native measurements were taken in the headless worker.
