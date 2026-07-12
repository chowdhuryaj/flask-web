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

## Notes

- Local single-user tool: all web permissions are granted to the app
  origin. Don't point it at remote URLs.
- Packaging into a signed .app (electron-builder) is deliberately not set
  up yet — `npm start` covers the bench workflow.
