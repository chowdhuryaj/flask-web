# flask-web

Browser-based configurator for **Flask**-firmware keyboards — a WebHID port
of the [Flask macOS app](https://github.com/chowdhuryaj) serving the
Ploopy Adept trackball, the Svalboard, and the NLOFIN NLKB16-02 macro pad,
plus a second **ZMK line** (Cyboard Imprint) over ZMK Studio + the Flask
frame, plus plain-Vial editing for any Vial keyboard.

**Use it:** https://chowdhuryaj.github.io/flask-web/ — Chrome/Edge/any
Chromium browser (WebHID; Firefox and Safari don't have it). Plug in the
keyboard, click Connect. Close the Vial desktop GUI and the Flask macOS app
first — two editors talking to one keyboard interleave HID responses.

**Or install it:** `desktop/` packages the same code as an Electron app
(macOS DMG, Windows portable zip) that bundles its own Chromium, so WebHID
and WebSerial work with no Chrome install. See [desktop/README.md](desktop/README.md).

## Two firmware lines

The app serves two different firmwares, and they share almost nothing but
the Flask frame vocabulary. Nothing in the QMK modules may special-case a
ZMK family, and vice versa — `caps.js` dispatches to `zmk.js` at the top and
that is the only place the worlds meet.

| Line | Devices | Keymap surface | Tuning | Protocol today |
|---|---|---|---|---|
| **QMK / Vial** | Ploopy Adept, Svalboard, NLKB16-02, any Vial board | Vial over raw HID (0xFF60) | Flask channels | Adept **v11**, Svalboard **v11**, NLKB16 **v8** |
| **ZMK** | Cyboard Imprint | ZMK Studio RPC over WebSerial | Flask channels (zmk-flask-modules) | Imprint **v16** |

Each family versions its **own** protocol line — a raw `version >= N`
compare across families is wrong. Gate in `caps.js` / `zmkCapabilities`.

## QMK line

- **Keymap editor** — layers, per-key assignment, LT/MT/layer-op composer,
  encoder rotation slots, custom device keycodes read live from the board.
- **Mouse tab** (Adept/Svalboard) — acceleration, DPI (table + raw CPI),
  smoothing, drag scroll, shake-to-toggle, auto-mouse, autoscroll, freeze
  diagnostic.
- **Typing tab** — custom shift keys, select word, sentence case, leader
  sequences, OS-aware shortcuts, num word.
- **QMK Settings** — tapping/auto-shift/combo/mouse-keys QSIDs.
- **Macros** — action-chip editor (text/tap/down/up/delay), whole-buffer
  save with unlock gate + verify re-read (locked writes are silently
  ignored by firmware — the tab tells you).
- **Tap Dance / Combos / Key Overrides** — Vial dynamic entries; combos
  include per-combo layer masks (Flask channel 0x20) where supported.
  Entry writes need no unlock (unlike macros).
- **Gestures & Mouse Chords** (trackballs) — 8×8 slot grids; the picker
  vetoes anything tap_code16 can't fire (basic + mod combos only).
- **RGB painter + effect engine** (NLKB16) — per-layer HSV map (channel
  0x21, payload-addressed) plus stock VialRGB modes via raw frames.
- **Display tab** (NLKB16) — widgets per big line, custom text, idle
  sleep, overlays, push test, panel health + re-init.
- **Unlock** — full Vial unlock flow (hold-keys + progress).
- **.vil save/load** — Vial-GUI-compatible (int keycodes) with the
  `flask_tunings` + `flask_rgbmap` extension keys; works offline (import
  queues, export dumps the workspace). The NLKB16 bootloader-erase
  restore path.
- **Offline workspaces** — edit with no keyboard attached (`offline.js`).
  Pick a device on the landing page (curated Adept/NLKB16 templates, or a
  snapshot captured automatically on every real connect — Svalboard and
  generic boards get one after their first connect). Edits journal to
  localStorage (last-write-wins per key/value) and apply on the next
  connect: confirm modal with a change list, or fully automatic after
  ticking "apply automatically". Only touched entries are written — a
  blank template can never wipe a real keymap. Works in browsers without
  WebHID too (queue from Firefox/phone, apply later from Chromium).
  Entries, macros, RGB paints, and display text all journal and replay.

## ZMK line (Cyboard Imprint)

The keymap lives in git + ZMK Studio, not in a Vial surface, so the ZMK
tabs are a different app wearing the same chrome.

- **Keymap editor** — live editing over ZMK Studio RPC (WebSerial):
  bindings, layer add/remove/move/restore, rename, save/discard, JSON
  export/import. Firmware needs `CONFIG_ZMK_STUDIO=y` + the
  `studio-rpc-usb-uart` snippet (the tab feature-probes and explains if
  absent). **Keymap auto-restore**: every successful save snapshots the
  layers; a device that comes back different (settings_reset, fresh board)
  is restored through the same apply path.
- **Combos** (0x24, v7+) — runtime combos with typed outputs (v12),
  device-sized slots (v9), and per-combo timeout/prior-idle/layer (v14 —
  the keymap's devicetree combos imported as editable compiled defaults).
- **Macros** (0x25, v8+) — ordered step list (tap/press/release/wait),
  plus a recorder.
- **Tap Dance** (0x28, v14+) — runtime `&ftd` dances with a wizard.
- **Shift** (0x16, v14+) — `flask_csk` custom shift keys.
- **Leader** (0x19, v10+) — `&fled` sequences with typed outputs,
  F-key preset.
- **Gestures** (0x11, v10+) — hold the gesture key, stroke a ball; 8 sets ×
  8 directions, typed outputs.
- **Mouse** — acceleration (0x10, v9), scroll snap (0x26, v9), scroll speed
  as a percent of the compiled divisors (0x29, v15), ball swap (0x27, v11),
  auto-mouse (0x1B, v13), autoscroll (0x1A, v2).
- **RGB** (0x21, v6+) — per-layer per-key HSV painter on the real board
  geometry, an inline colour picker with presets + saved palette, global
  brightness (v14), and an idle blank timeout (v16). *If paints look like
  they "don't apply", it's the idle blank: the write lands, but a blanked
  strip only renders it on the next keypress.*
- **Modes** — named app-side snapshots of the whole device (keymap + every
  module section). **Apply** writes through live and persists nothing;
  **Make baseline** also saves, and that is what the board boots into with
  no app attached. App-side because the Imprint's settings partition is
  32 KB total and holds BLE bonds plus every flask blob.
- **Test** — browser-event testers: typing tester (per-key hold times,
  rollover), tap-hold calibrator (emits a keymap snippet — ZMK hold-tap
  timing is compile-time), combo calibrator (writes the global timeout in
  one click), mouse + scroll tester, and a **device self-test** that probes
  every channel round-trip.
- **Export/import** — the keymap JSON is a full-device backup (v2 payload:
  layers + every module section), the ZMK equivalent of the QMK `.vil`.
- **Offline preview** — a device-less Imprint workspace so the whole ZMK
  surface can be driven with no hardware; edits replay on the next connect.

## Everywhere

- **HUD** — floating always-on-top overlay (Document Picture-in-Picture)
  with live layer follow, the active layer's keymap, pressed-key highlights
  (after unlock on QMK; key-state bitmap 0x23 on ZMK), and the NLKB16 OLED
  mirror. Falls back to an in-page draggable overlay where PiP isn't
  available; under Electron it's a real always-on-top window.
- **Diagnostics** (🐞) — a timestamped black-box ring of transport + Studio
  events, exportable as a text report, so a board death is reconstructable
  from the app alone. Sees what the host sees (frames, echoes, timeouts,
  re-enumerations, boot reset-cause), not firmware log lines. The ~15 Hz HUD
  poll is counted, not listed.
- **Preflight** — "Connect did nothing" has three distinct causes (no
  WebHID / WebHID blocked by enterprise policy / no device enumerating).
  The check names which one happened; the active probe separates a policy
  block from a missing device by timing, since a blocked `requestDevice`
  returns empty without ever painting a chooser.
- **Themes** — Classic (auto light/dark), Light, Dark, Nord, Dracula,
  Solarized; zoom 80–150%.

## Relationship to the desktop apps

Two different things are called "desktop" here:

- **`desktop/`** — an Electron wrapper around *this* code. Parity is
  structural: it serves the same files, so it can't drift. A packaged build
  carries a snapshot (`Resources/web`), so rebuild to pick up changes.
- **The Flask macOS app** (Swift, `AdeptCompanion`) — a separate codebase
  and the source of truth the QMK protocol layer was ported from. It is
  **QMK-only**; the whole ZMK line above has no desktop counterpart. As of
  the last recorded sync (2026-07-07) the web app covered everything in it
  except the Build tab (compile + flash needs local disk) and the matrix
  tester, and added offline workspaces, preflight, and diagnostics on top.
  Styling flows web → desktop (`PipetteTheme.swift` transcribes
  `styles.css`). That app is not in this repo — verify current parity
  against its own tree.

## Architecture

Zero build step — static ES modules served as-is; push = deploy (GitHub
Pages). No framework, no npm dependencies; the one vendored file is
`vendor/xz-decompress.js` (WASM XZ decoder for the compressed vial.json the
firmware serves over HID).

**Shared core**

| File | Responsibility |
|---|---|
| `main.js` | Boot, connect/load sequence, tab registry, themes, HUD wiring |
| `webhid.js` | WebHID transport: single-in-flight queue, response matching, timeout/retry/drain |
| `flaskproto.js` | Flask tuning protocol (u16 BE frames, clamp-echo) — both firmwares implement it |
| `caps.js` | QMK (family × protocol version) → feature gating; dispatches ZMK families to `zmk.js` |
| `profiles.js` | Curated Adept/NLKB16 geometry + generic from-definition profiles |
| `keycodes.js` | Keycode DB: naming, composition, categories, device-custom overlay |
| `ui.js`, `colorpicker.js`, `picker.js`, `hud.js` | Shared UI: widgets, HSV picker, keycode picker, HUD |
| `diag.js`, `preflight.js` | Black-box diagnostics ring; environment preflight |

**QMK / Vial line**

| File | Responsibility |
|---|---|
| `vialproto.js` | VIA/Vial command ids, dynamic-entry codecs (LE), macro codec, QMK settings catalog |
| `vialclient.js` | Vial operations: definition fetch, keymap r/w, encoders, unlock, matrix, QSIDs |
| `vialdef.js` | XZ decode + vial.json/KLE parse |
| `vil.js` | `.vil` export/import + the Flask extension keys |
| `offline.js` | Offline workspaces: journal, sync engine, snapshot capture |
| `unlock.js` | Vial unlock flow |
| `keymap-tab.js`, `macros-tab.js`, `entries-tab.js`, `gestures-tab.js`, `mouse-tab.js`, `typing-tab.js`, `rgb-tab.js`, `display-tab.js`, `settings-tab.js` | Tabs |

**ZMK line** (nothing here may be imported by a QMK module)

| File | Responsibility |
|---|---|
| `zmk.js` | Family table, VID/PID, `zmkCapabilities`, expected protocol, key-state read |
| `zmk-studio.js` | ZMK Studio RPC: WebSerial transport, framing, hand-rolled proto3 codec |
| `zmk-keycodes.js`, `zmk-capture.js` | Binding vocabulary; window keyboard capture → usage params (press-to-pick) |
| `zmk-export.js`, `zmk-modes.js`, `zmk-keymap-sync.js` | Full-device export payload; modes store; keymap snapshot/diff |
| `zmk-offline.js` | Device-less Imprint workspace (Flask frames + a Studio client stand-in) |
| `zmk-*-codec.js` | Pure slot/step frame codecs (combos, macros, csk, tapdance, typed outputs) |
| `zmk-keymap-tab.js`, `zmk-combos-tab.js`, `zmk-macros-tab.js`, `zmk-tapdance-tab.js`, `zmk-shift-tab.js`, `zmk-leader-tab.js`, `zmk-gestures-tab.js`, `zmk-rgb-tab.js`, `zmk-modes-tab.js`, `zmk-test-tab.js` | Tabs |
| `zmk-studio-test.mjs` | Offline vector suite (node) |

QMK protocol semantics are ported from the Swift app's `AdeptCore`
(HIDClient/AdeptProtocol/VialProtocol/VialClient/VialDefinition/KeycodeDB) —
comments cite the firmware sources (`quantum/via.c`, `quantum/vial.c`, the
keymaps' `raw_hid_receive_kb`). ZMK channel semantics come from
[`zmk-flask-modules`](https://github.com/chowdhuryaj/zmk-flask-modules).

## Dev

```
python3 serve.py        # http://localhost:8137, cache disabled
node zmk-studio-test.mjs   # offline vector suite — non-zero exit on drift
```

The vector suite pins today's wire format for the ZMK codecs (framing,
varints, bindings, slot frames, keymap diff, capture helpers). The pure
codec files import nothing and never touch `window`/`localStorage` at module
scope, precisely so node can import them — keep it that way.

When releasing, bump the `?v=N` stamps on module imports and the stylesheet
link — GitHub Pages' CDN caches hard. `main.js` carries its own counter in
`index.html` (currently imports `?v=18`, entry `main.js?v=20`).

## Hard-won rules (do not "simplify" these away)

- **Clamp-echo:** firmware setters clamp and echo the applied value; every
  control adopts the echo, never its own value.
- **Endianness triple-mix:** Flask u16 frames are big-endian at bytes 3-4;
  the keymap buffer is big-endian; Vial dynamic entries, definition size,
  and QSID queries are little-endian.
- **Payload-addressed frames** (RGB map 0x21, display 0x22 push/mirror, the
  ZMK slot frames at 0x50) never route through the u16 helpers.
- **Per-family protocol lines** — never compare a version across families,
  and never thread a ZMK exception through a QMK expression (that is how
  `caps.js` drifted once already).
- **Unlock has no abort** — once started, the device answers only unlock
  commands until the combo completes; replug recovers.
- **KLE parsing:** keep empty legend lines, skip `d:true` decals, legend
  line 9 `"e"` = encoder cap (all three minted phantom keys once).
- **Matrix state while locked** echoes zeros — that's "locked", not an error.
- **`hid.pause()` is advisory** — it gates the HUD poll tick; it must not
  block the request queue, or the unlock transaction deadlocks.
- **Colour is the firmware's space** — h/s/v are 0–255 end to end (hue
  0–255 maps onto 0–360°), so nothing converts at a call site.
- **`JSON.stringify(data, replacerArray)` filters keys at every depth** —
  never pass a key-list replacer to nested data (it emptied `key_override`
  and `flask_tunings` in `.vil` export once).
- **Don't run two editors against one board** — flask-web, the Vial GUI and
  the desktop app interleave responses and corrupt the matcher.
