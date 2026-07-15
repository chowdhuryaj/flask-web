# Flask desktop

Electron wrapper for the Flask web configurator — bundles its own Chromium,
so WebHID (Flask tuning) and WebSerial (ZMK Studio RPC) work without a
Chrome install.

## Run

```
cd desktop
npm install     # once — downloads Electron's Chromium
npm start
```

Serves the repo root on `http://localhost:8137/` with serve.py's no-cache
headers; if serve.py is already listening there it reuses that server, so
the browser tab and the app see the same code.

## Device pickers

Chrome's HID/serial chooser doesn't exist in Electron, so the wrapper
answers selection itself: one matching device connects immediately; several
bring up a native dialog. Previously connected keyboards are auto-granted —
the landing page lists them without a prompt.

## Install as a real Mac app (2026-07-12)

```
cd desktop
npm install          # once — Electron + electron-builder
npm run dist         # → dist/Flask-1.0.0-arm64.dmg (+ .zip)
```

Open the DMG, drag **Flask.app** to Applications. The packaged app carries
the whole web configurator inside (`Resources/web`) — no repo checkout, no
serve.py needed; it serves itself on localhost:8137 (or an ephemeral port
if that's taken).

The app is **unsigned** (no Apple Developer cert): first launch needs
right-click → Open (or `xattr -dr com.apple.quarantine /Applications/Flask.app`
after copying).

### Updates

Flask ▸ **Check for Updates…** compares against the newest GitHub release
of `chowdhuryaj/flask-web` and opens the download page when there's a newer
one (a quiet check also runs a few seconds after launch). Publishing an
update = bump `version` in this package.json, `npm run dist`, then:

```
gh release create v1.0.1 dist/Flask-1.0.1-arm64.dmg --title "Flask 1.0.1"
```

True in-place auto-update (electron-updater) needs the app code-signed —
macOS refuses to swap unsigned bundles. If a Developer ID cert shows up
later: set `mac.identity`, add `electron-updater`, keep the same release
flow.

## Windows (portable, for the radiology workstation)

```
npm run dist:win      # → dist/Flask-1.0.0-win.zip  (x64)
```

Extract the zip anywhere — a USB stick is the point — and run `Flask.exe`.
No installer, no admin rights, nothing written outside the folder. It builds
fine from macOS: electron-builder pulls the win32 Electron and, with no
signing cert configured, skips the signtool step (it still downloads Wine on
the way there — harmless, just slow the first time).

`zip` rather than NSIS `portable` on purpose: NSIS needs Wine to actually
*run*, and an installer is the wrong shape for a machine you can't install
software on.

**It may not run there, and that's expected.** The build is unsigned, so
SmartScreen will warn ("Windows protected your PC" → More info → Run anyway),
and a managed clinical box may block it outright via AppLocker/WDAC, or refuse
USB mass storage. **None of that blocks the keyboard.** The Modes tab's "Make
baseline" writes a mode into the keyboard's own flash, so the board boots into
it with no app attached — carry the app if it runs, but don't depend on it.

## Notes

- Local single-user tool: all web permissions are granted to the app
  origin. Don't point it at remote URLs.
- Dev runs (`npm start`) serve the repo checkout — edits show on reload.
  Packaged runs serve their bundled copy — rebuild to pick up changes.
- The app menu is built on every platform; Windows/Linux get the mac app
  menu's items under File (hide/hideOthers/unhide are macOS-only roles).
  `FLASK_SKIP_MENU=1` suppresses it for the smoke gate.
