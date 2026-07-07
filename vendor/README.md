# Vendored dependencies

## xz-decompress.js
- Version: 0.2.3
- Source: https://unpkg.com/xz-decompress@0.2.3/dist/package/xz-decompress.js
- License: MIT (xzwasm, Steve Sanderson) + public domain (xz-embedded, Lasse Collin / Igor Pavlov) + MIT (walloc, Igalia)
- Why: decodes the XZ-compressed vial.json that Vial firmware serves over HID
  (vial-qmk util/vial_generate_definition.py uses Python `lzma.compress`
  defaults = XZ container, LZMA2, CRC64). The WASM binary is embedded as a
  base64 data: URI — single static file, no build step.
- Loading: UMD build; loaded as a CLASSIC script tag in index.html (top-level
  `this` is undefined in ES modules, which breaks the UMD root detection).
  Exposes `window['xz-decompress'].XzReadableStream`.
- Verified 2026-07-07: decodes Python `lzma.compress` output in Node 18+ and
  Chromium.
