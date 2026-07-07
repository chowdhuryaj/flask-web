# flask-web

Browser-based configurator for **Flask**-firmware keyboards — a WebHID port
of the [Flask macOS app](https://github.com/chowdhuryaj) serving the
Ploopy Adept trackball, the Svalboard, and the NLOFIN NLKB16-02 macro pad,
plus plain-Vial editing for any Vial keyboard.

**Use it:** https://chowdhuryaj.github.io/flask-web/ — Chrome/Edge/any
Chromium browser (WebHID; Firefox and Safari don't have it). Plug in the
keyboard, click Connect. Close the Vial desktop GUI and the Flask macOS app
first — two editors talking to one keyboard interleave HID responses.

## What works (v1)

- **Keymap editor** — layers, per-key assignment, LT/MT/layer-op composer,
  encoder rotation slots, custom device keycodes read live from the board.
- **Mouse tab** (Adept/Svalboard) — acceleration, DPI (table + raw CPI),
  smoothing, drag scroll, shake-to-toggle, auto-mouse, autoscroll, freeze
  diagnostic.
- **Typing tab** — custom shift keys, select word, sentence case, leader
  sequences, OS-aware shortcuts, num word.
- **QMK Settings** — tapping/auto-shift/combo/mouse-keys QSIDs.
- **HUD** — floating always-on-top overlay (Document Picture-in-Picture)
  with live layer follow, the active layer's keymap, pressed-key highlights
  (after unlock), and the NLKB16 OLED mirror. Falls back to an in-page
  draggable overlay where PiP isn't available.
- **Unlock** — full Vial unlock flow (hold-keys + progress).

Coming from the macOS app, still to port: macros, tap dance, combos, key
overrides, RGB painter, Display tab, gestures, wheel chords, .vil save/load.

## Architecture

Zero build step — static ES modules served as-is; push = deploy (GitHub
Pages). No framework, no npm dependencies; the one vendored file is
`vendor/xz-decompress.js` (WASM XZ decoder for the compressed vial.json the
firmware serves over HID).

| File | Responsibility |
|---|---|
| `webhid.js` | WebHID transport: single-in-flight queue, response matching, timeout/retry/drain |
| `flaskproto.js` | Flask tuning protocol (channels 0x00–0x22, u16 BE frames, clamp-echo) |
| `vialproto.js` | VIA/Vial command ids, dynamic-entry codecs (LE), macro codec, QMK settings catalog |
| `vialclient.js` | Vial operations: definition fetch, keymap r/w, encoders, unlock, matrix, QSIDs |
| `vialdef.js` | XZ decode + vial.json/KLE parse |
| `keycodes.js` | Keycode DB: naming, composition, categories, device-custom overlay |
| `profiles.js` | Curated Adept/NLKB16 geometry + generic from-definition profiles |
| `caps.js` | (family × protocol version) → feature gating |
| `*-tab.js`, `picker.js`, `hud.js`, `unlock.js` | UI |

Protocol semantics are ported from the Swift app's `AdeptCore`
(HIDClient/AdeptProtocol/VialProtocol/VialClient/VialDefinition/KeycodeDB) —
comments cite the firmware sources (`quantum/via.c`, `quantum/vial.c`, the
keymaps' `raw_hid_receive_kb`).

## Dev

```
python3 serve.py     # http://localhost:8137, cache disabled
```

When releasing, bump the `?v=N` stamps on module imports and the stylesheet
link — GitHub Pages' CDN caches hard.

## Hard-won rules (do not "simplify" these away)

- **Clamp-echo:** firmware setters clamp and echo the applied value; every
  control adopts the echo, never its own value.
- **Endianness triple-mix:** Flask u16 frames are big-endian at bytes 3-4;
  the keymap buffer is big-endian; Vial dynamic entries, definition size,
  and QSID queries are little-endian.
- **Payload-addressed frames** (RGB map 0x21, display 0x22 push/mirror) never
  route through the u16 helpers.
- **Unlock has no abort** — once started, the device answers only unlock
  commands until the combo completes; replug recovers.
- **KLE parsing:** keep empty legend lines, skip `d:true` decals, legend
  line 9 `"e"` = encoder cap (all three minted phantom keys once).
- **Matrix state while locked** echoes zeros — that's "locked", not an error.
