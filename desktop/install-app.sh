#!/bin/sh
# Build Totem-Flask.app and install it next to the native Flask.app.
# Run by AJ only:  cd desktop && npm run install-app
# (Builders and agents never run this; it writes into /Applications.)
set -e
cd "$(dirname "$0")"
npm run dist:dir
APP="dist/mac-arm64/Totem-Flask.app"
[ -d "$APP" ] || { echo "build did not produce $APP" >&2; exit 1; }
if pgrep -x "Totem-Flask" >/dev/null; then echo "Quit Totem-Flask first." >&2; exit 1; fi
# Replace, don't merge: ditto over an old copy leaves stale files that break
# the code seal, and TCC (Bluetooth) checks the seal. App data lives in
# ~/Library/Application Support and is untouched.
rm -rf /Applications/Totem-Flask.app
ditto "$APP" /Applications/Totem-Flask.app
codesign --verify --deep /Applications/Totem-Flask.app
xattr -dr com.apple.quarantine /Applications/Totem-Flask.app
echo "Installed /Applications/Totem-Flask.app (native Flask.app untouched)."
