# Shared effects package

`packages/paddock-effects` is the editable source for the palettes, canvas renderer and RGB animation. Change it once, then have both applications consume that version. Its assets were initially extracted from Paddock; the SHA-256 comments record that initial snapshot, not current package hashes. There is no ongoing import or scan of the Paddock application.

FamilyHub's Windows/Android and iOS build scripts copy the package assets into `wwwroot/paddock-theme.css` and `.js` before building. This uses native file copying, with no Python, Node or package-manager dependency in those build scripts. Direct app project builds also sync through the `SyncSharedEffects` MSBuild target. For manual validation:

```powershell
python scripts/sync-shared-effects.py
python scripts/sync-shared-effects.py --check
```

Paddock now consumes the shared renderer through `src/console-sky.js`. Its existing per-panel mounting, density and motion controls remain intact. `mountSky`, `refreshSky` and `setSkyLevel` expose that API; FamilyHub continues using `apply` for its outer backdrop.

Paddock's `prebuild` and `prestart` refresh a vendored snapshot from this package, then regenerate desktop/mobile theme data from the shared `manifest.json`. The snapshot keeps standalone clones and Docker builds self-contained. Set `PADDOCK_EFFECTS_SOURCE` to use another location. Commit the refreshed snapshot with consumer updates; it is generated, not a second editable source. No separate repository or registry publication has been created.

Edit palette colors and metadata in `manifest.json`, run `node packages/paddock-effects/build.cjs`, then build either application. Paddock also runs this generation during synchronization. Edit surface hues and RGB keyframes in `effects.css`, and the particle renderer in `effects.js`. Paddock retains its application-specific surface CSS, console-opening bursts, reactive lighting, terminal geometry and textures.

Use `PaddockEffects.themes` for the available `{id,label}` menu entries. `--frame-bg` controls the outer background; `--panel-hue` is the opaque tinted header; `--accent`/`--accent-2` and `--frame-a`/`--frame-b` expose palette colors. FamilyHub keeps its own opaque grey content panels. The package honors reduced motion and pauses hidden-window animation. Its effects toggle also pauses RGB cycling.
