# Totem-Flask desktop

Electron wrapper for the Flask web configurator. It bundles its own Chromium,
so WebHID (Flask tuning) and WebSerial (ZMK Studio RPC) work without Chrome.

Installs as `/Applications/Totem-Flask.app` (bundle id `dev.aj.totem-flask`,
version 2.0.0) next to the native `Flask.app` (`com.aj.flask`), which stays.
Both talk to one keyboard over HID, so close one before connecting in the
other; Totem-Flask warns at launch if the native app is open.

## Run (dev) and build

```
cd desktop
npm install
npm start               # serves the checkout
npm run dist:dir        # dist/mac-arm64/Totem-Flask.app (ad-hoc signed)
npm run install-app     # AJ only: build + ditto into /Applications
```

`npm start` on the bare Electron binary has no Bluetooth usage string, and
macOS aborts it if WebSerial enumerates Bluetooth ports (crash 2026-10-01).
Smoke-test the packaged `dist` app, not `npm start`.

## Origin and storage

The app is served from `totem-flask://app/` (privileged secure scheme, no
port). That origin is fixed, so `localStorage` (offline workspaces, Modes,
theme, restore snapshots) survives updates, and `npm start` and the packaged
app share it. The userData dir is `~/Library/Application Support/Totem-Flask`.

If the scheme ever lacks WebHID/WebSerial in a new Electron, fall back to a
fixed port (spec 6.2 option a). Not needed on Electron 33.

First launch offers "Import workspaces and Modes from Flask (desktop 1.x)"
when `~/Library/Application Support/Flask` exists. It runs this binary on the
old profile (`TOTEM_LEGACY_DUMP`), reads `flask*` localStorage keys from
`http://localhost:8137`, and adds only keys Totem-Flask does not have. The
app menu keeps the item for later.

## Security settings

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, `webviewTag: false`, `will-attach-webview` blocked.
- Preload (`preload.js`) exposes `window.totemFlask` (frozen):
  `desktop: true` and `nativeFlaskRunning()`. Nothing else.
- No remote content: every request not on `totem-flask:`, `devtools:`,
  `blob:`, `data:`, `about:` is cancelled; navigation off the app origin is
  blocked; `window.open` is denied except the HUD popup; `https` links open in
  the default browser. A CSP is sent with every file (`default-src 'self'`,
  `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'none'`).
- Devices: the chooser (`select-hid-device`, `select-serial-port`) and stored
  grants (`setDevicePermissionHandler`) only see allow-listed VID:PID.
  HID: 1d50:615e (ZMK), 303a:4044 (Svalboard), 3434:0440 (Nape), 5043:5c47
  (Adept), d020:1603 (NLKB16). Serial: 1d50:615e. Permissions are limited to
  `hid`, `serial`, `clipboard-sanitized-write`, for the app origin only.
- `FLASK_NO_DEVICE=1` refuses every device grant and chooser; smoke runs imply it.
- Single-instance lock (two instances would fight over one keyboard).
- The main process still makes one outbound call: the GitHub release check.

## HUD

`hud.js` opens `window.open('about:blank', 'flask-hud')`, a same-origin popup
that shares the renderer's HID session. `main.js` turns it into a frameless,
transparent, vibrancy `hud` NSPanel (`type: 'panel'`, non-activating), always
on top across Spaces and full screen. Corner snap (32 px, 12 px margin) and
the saved frame (`hud-bounds.json` in userData) live in the main process.
`TOTEM_NO_PANEL=1` switches to the `focusable: false` fallback. Plain browsers
use Document PiP, then the in-page overlay (`css/hud.css`).

## Updates

Totem-Flask > **Check for Updates…** compares against the newest GitHub
release of `chowdhuryaj/flask-web` and opens the download page. The app is
unsigned (ad-hoc only), so there is no in-place update. On the build Mac use
`npm run install-app`. The first launch of a copy that did not come through
`install-app` needs right-click > Open, or
`xattr -dr com.apple.quarantine /Applications/Totem-Flask.app`.

## Windows (portable, for the radiology workstation)

```
npm run dist:win      # dist/Totem-Flask-2.0.0-x64.zip
```

Extract anywhere and run `Totem-Flask.exe`. Unsigned: SmartScreen will warn,
and a managed clinical box may block it. The Modes tab's "Make baseline"
writes a mode into the keyboard's flash, so the board does not depend on the app.

## Notes

- Dev runs serve the repo checkout (edits show on reload). Packaged runs
  serve their bundled copy; rebuild to pick up changes.
- `FLASK_SKIP_MENU=1` suppresses the menu.
- `FLASK_DESKTOP_SMOKE=1 dist/mac-arm64/Totem-Flask.app/Contents/MacOS/Totem-Flask`
  prints probe lines (hid/serial, HUD panel, snap, console errors) and exits.
