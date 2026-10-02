# flask-web (Totem-Flask)

Browser-based configurator for the **ZMK Flask boards** only: the **TOTEM**
38-key split (family 6) and the **Cyboard Imprint** (family 4). It talks to
the board two ways: ZMK Studio RPC over WebSerial for the keymap, and the
Flask raw-HID frame (zmk-flask-modules) over WebHID for everything else.
Nothing else is supported; QMK, Vial, Svalboard, GMK70, Nape and other
keyboards were removed on 2026-10-02.

**Use it:** https://chowdhuryaj.github.io/flask-web/ — Chrome/Edge/any
Chromium browser (WebHID; Firefox and Safari don't have it). Plug in the
keyboard, click Connect. Close any other Flask app first — two editors
talking to one keyboard interleave HID responses.

**Or install it:** `desktop/` packages the same code as an Electron app
(macOS DMG, Windows portable zip) that bundles its own Chromium, so WebHID
and WebSerial work with no Chrome install. See [desktop/README.md](desktop/README.md).

## Boards

| Board | Family code (meta 0x03) | Protocol today | Has |
|---|---|---|---|
| TOTEM (ZMK) | 6 | **v17** | keys only; flask_holdtap (0x2A) |
| Cyboard Imprint (ZMK) | 4 | **v16** | two trackballs, RGB strip |

Both share the stock ZMK USB identity `1d50:615e`, so a VID/PID match is only
a candidate: `confirmZmkFamily()` reads meta 0x03 after connect, and an
unreadable family blocks keymap import, Mode apply and Studio writes until a
reconnect. Gate features in `zmk.js` (`zmkCapabilities`), never on a raw
`version >= N`.

## Features

The keymap lives in the firmware repo + ZMK Studio, so the tabs are Studio
RPC or Flask-channel editors.

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
- **Shift Keys** (0x16, v14+) — `flask_csk` custom shift keys.
- **Leader** (0x19, v10+) — `&fled` sequences with typed outputs,
  F-key preset.
- **Hold timing** (0x2A, Totem v17) — per-key and virtual-slot hold-tap timing.
- **Gestures** (0x11, v10+, Imprint) — hold the gesture key, stroke a ball;
  8 sets × 8 directions, typed outputs.
- **Mouse** (Imprint) — acceleration (0x10, v9), scroll snap (0x26, v9),
  scroll speed as a percent of the compiled divisors (0x29, v15), ball swap
  (0x27, v11), auto-mouse (0x1B, v13), autoscroll (0x1A, v2).
- **RGB** (0x21, v6+, Imprint) — per-layer per-key HSV painter on the real
  board geometry, an inline colour picker with presets + saved palette,
  global brightness (v14), and an idle blank timeout (v16). *If paints look
  like they "don't apply", it's the idle blank: the write lands, but a
  blanked strip only renders it on the next keypress.*
- **Modes** — named app-side snapshots of the whole device (keymap + every
  module section). **Apply** writes through live and persists nothing;
  **Make baseline** also saves, and that is what the board boots into with
  no app attached.
- **Test** — browser-event testers: typing tester (per-key hold times,
  rollover), tap-hold calibrator (emits a keymap snippet — ZMK hold-tap
  timing is compile-time), combo calibrator (writes the global timeout in
  one click), mouse + scroll tester, and a **device self-test** that probes
  every channel round-trip.
- **Save layout / Load** — the keymap JSON is a full-device backup (v2
  payload: layers + every module section).
- **Offline preview** — a device-less Totem or Imprint workspace so the whole
  surface can be driven with no hardware. Tunables, RGB paints, combo slots
  and macro steps journal to localStorage and replay on the next connect
  (`offline.js` is the shared journal, `zmk-offline.js` the ZMK sim).
- **HUD** — floating always-on-top overlay (Document Picture-in-Picture)
  with live layer follow, the active layer's keymap and pressed-key
  highlights (key-state bitmap 0x23). Falls back to an in-page draggable
  overlay where PiP isn't available; under Electron it's a real always-on-top
  window.
- **Diagnostics** — a timestamped black-box ring of transport + Studio
  events, exportable as a text report, so a board death is reconstructable
  from the app alone.
- **Preflight** — "Connect did nothing" has three distinct causes (no
  WebHID / WebHID blocked by enterprise policy / no device enumerating).
  The check names which one happened.
- **Typing trainer** — an adaptive trainer in the shape of
  [keybr.com](https://keybr.com): it starts you on six letters, measures your
  speed *per key*, and unlocks the next letter only once every letter already
  in play has been typed at the target speed. Lesson types: Guided, Word list,
  Numbers, Custom text. Runs on browser key events with nothing connected.
- **Themes** — Classic (auto light/dark), Light, Dark, Nord, Dracula,
  Solarized; zoom 80–150%.

## Architecture

Zero build step — static ES modules served as-is; push = deploy (GitHub
Pages). No framework, no npm dependencies.

| File | Responsibility |
|---|---|
| `main.js` | Boot, connect/load sequence, tab registry wiring, offline mode, HUD wiring |
| `webhid.js` | WebHID transport (ZMK VID/PID only): single-in-flight queue, response matching, timeout/retry/drain |
| `flaskproto.js` | Flask tuning protocol (u16 BE frames, clamp-echo): channels `CH`, value ids `V` |
| `zmk.js` | Family table, VID/PID, `zmkCapabilities`, expected protocol, key-state read, profiles |
| `tab-registry.js`, `app-shell.js`, `caption.js`, `command-palette.js`, `themes.js` | Tab table, frame + Device › Keyboard, caption bar, ⌘K, themes |
| `board.js`, `binding-picker.js`, `behavior-catalog.js`, `keycodes.js` | Board + SVG renderer, the one picker, behavior catalog, HID usage name tables |
| `save-state.js`, `ui.js`, `colorpicker.js`, `hud.js`, `diag.js`, `preflight.js` | One Save, widgets, HSV picker, HUD, diagnostics, preflight |
| `offline.js` | Shared offline journal: workspace storage, tunable/RGB replay |
| `zmk-studio.js` | ZMK Studio RPC: WebSerial transport, framing, hand-rolled proto3 codec |
| `zmk-keycodes.js`, `zmk-capture.js` | Binding vocabulary; window keyboard capture → usage params (press-to-pick) |
| `zmk-export.js`, `zmk-modes.js`, `zmk-keymap-sync.js` | Full-device export payload; modes store; keymap snapshot/diff |
| `zmk-offline.js`, `zmk-totem-layout.js`, `zmk-totem-default.js` | Device-less workspaces; Totem geometry + shipped keymap |
| `zmk-*-codec.js` | Pure slot/step frame codecs (combos, macros, csk, tapdance, holdtap, typed outputs) |
| `zmk-keymap-tab.js`, `zmk-combos-tab.js`, `zmk-macros-tab.js`, `zmk-tapdance-tab.js`, `zmk-shift-tab.js`, `zmk-leader-tab.js`, `zmk-gestures-tab.js`, `zmk-holdtiming-card.js`, `zmk-rgb-tab.js`, `zmk-modes-tab.js`, `zmk-test-tab.js`, `mouse-tab.js` | Tabs |
| `trainer-*.js` | Typing trainer: model, stats, lesson, text input, words, UI |
| `zmk-studio-test.mjs`, `tests/` | Offline vector suite (node) and headless browser checks |

ZMK channel semantics come from
[`zmk-flask-modules`](https://github.com/chowdhuryaj/zmk-flask-modules).

## Dev

```
python3 serve.py           # http://localhost:8137, cache disabled
node tests/run.mjs         # every node suite, non-zero exit on drift
PORT=8139 python3 serve.py # then python3 tests/browser/<name>.py (headless Chrome via playwright)
```

The vector suite pins today's wire format for the ZMK codecs (framing,
varints, bindings, slot frames, keymap diff, capture helpers). The pure
codec files import nothing and never touch `window`/`localStorage` at module
scope, precisely so node can import them — keep it that way.

Every module is imported with one `?v=N` stamp everywhere (`tests/stamps-test.mjs`
enforces it; "x.js" and "x.js?v=N" are two module instances). When releasing,
bump the stamp across the tree — GitHub Pages' CDN caches hard. Currently `?v=62`.

## Hard-won rules (do not "simplify" these away)

- **Clamp-echo:** firmware setters clamp and echo the applied value; every
  control adopts the echo, never its own value.
- **Endianness:** Flask u16 frames are big-endian at bytes 3-4.
- **Payload-addressed frames** (RGB map 0x21, the slot frames at 0x50) never
  route through the u16 helpers.
- **Per-family protocol lines** — never compare a version across families;
  gate in `zmkCapabilities`.
- **`hid.pause()` is advisory** — it gates the HUD poll tick; it must not
  block the request queue.
- **Colour is the firmware's space** — h/s/v are 0–255 end to end (hue
  0–255 maps onto 0–360°), so nothing converts at a call site.
- **Don't run two editors against one board** — flask-web and the desktop
  app interleave responses and corrupt the matcher.
