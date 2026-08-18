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
| **QMK / Vial** | Ploopy Adept, Svalboard, NLKB16-02, any Vial board | Vial over raw HID (0xFF60) | Flask channels | Adept **v11**, Svalboard **v21**, NLKB16 **v8** |
| **ZMK** | Cyboard Imprint | ZMK Studio RPC over WebSerial | Flask channels (zmk-flask-modules) | Imprint **v16** |

Each family versions its **own** protocol line — a raw `version >= N`
compare across families is wrong. Gate in `caps.js` / `zmkCapabilities`.
The Svalboard's line **left the Adept's at v12** and the two are no longer
comparable; the Adept and NLKB16 are frozen where they are, because the desktop
app dropped both devices on 2026-08-14. In `caps.js` anything past v11 gates on
`family === 'svalboard'` (the `sval(n)` helper), never on `trackball`.

⚠ **Channels 0x23–0x28 are double-booked across the two lines** — the QMK line
(Cyclotab, snippets, alt-repeat, teleport, right-ball gestures, corner combos)
and the ZMK line (key state, combos, macros, scroll snap, ball swap, tap dance)
allocated them independently. Both name sets live in `flaskproto.js`'s `CH`
because they never coexist on one device. Name the constant from the line you
are on, keep every call behind a caps gate, and build anything that enumerates
channels generically (`vil.js` `dumpSpec`, `offline.js` `LIVE_SET`) per-family.

## QMK line

- **Keymap editor** — layers, per-key assignment, LT/MT/layer-op composer,
  encoder rotation slots, custom device keycodes read live from the board.
- **Mouse tab** (Adept/Svalboard) — DPI (table + raw CPI), drag scroll,
  shake-to-toggle, auto-mouse, autoscroll, freeze diagnostic. **Acceleration and
  smoothing are Adept-only from Svalboard v18** — both had shipped disabled and
  were still disabled on the board, so the firmware dropped them.
- **Typing tab** — custom shift keys, select word, sentence case, leader
  sequences, OS-aware shortcuts, num word. On a Svalboard v12+ the leader
  section becomes **Super Leader** (16 sequences) and the tab gains **Cyclotab**
  and **alt-repeat behaviour** (chaining + stale-input default). A **snippet
  pool** (16 × 63 chars) and per-sequence Key/Text outputs exist on v12–v17
  only; v18 removed them, so on a current board a sequence outputs a keycode.
- **Corner Combos** (Svalboard v17+) — positional chords matched on (row, col),
  laid out cluster × chord, the same order the firmware and `.vil` files use.
  **From v19 outputs are universal**: one keycode per chord on every layer, so
  the editor drops its layer selector. On v17–v18 it keeps the selector and the
  inherited-vs-owned rendering. This channel has **no Save** — its SETs persist
  themselves, and a channel save wedges the board.
- **QMK Settings** — tapping/auto-shift/combo/mouse-keys QSIDs.
- **Macros** — action-chip editor (text/tap/down/up/delay), whole-buffer
  save with unlock gate + verify re-read (locked writes are silently
  ignored by firmware — the tab tells you).
- **Tap Dance / Combos / Key Overrides** — Vial dynamic entries; combos
  include per-combo layer masks (Flask channel 0x20) where supported.
  Entry writes need no unlock (unlike macros).
- **Gestures & Mouse Chords** (trackballs) — 8×8 slot grids. Latched gesture
  **sets** (0x11) are an Adept/pre-v15 feature; the Svalboard dropped them at
  v15, when Mouse Chords grew a **second independent ball table** (0x27) and,
  at v16, a shared deferred-click flag. Before Svalboard v16 the picker vetoes
  anything `tap_code16` can't fire (basic + mod combos); from v16 slots go
  through `vial_keycode_tap` and the whole range is allowed.
- **Cursor teleport** (Svalboard v12–v17 only, in the Mouse tab) — 8 absolute
  targets in per-mille of the **virtual desktop**. Removed from the firmware at
  v18; the card is gated off there. Host mode was always shown read-only: a
  browser can't warp the OS cursor, so this app never heartbeats or acks.
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
- **The Flask macOS app** (Swift, `AdeptCompanion`) — a separate codebase and
  the source of truth the QMK protocol layer was ported from. It is **QMK-only,
  and since 2026-08-14 Svalboard-only**: it dropped the Adept and the NLKB16-02.
  So parity means *Svalboard feature coverage*, not "the same app" — this app
  keeps all three QMK families plus the whole ZMK line, which has no desktop
  counterpart. Styling flows web → desktop (`PipetteTheme.swift` transcribes
  `styles.css`). That app is not in this repo — verify current parity against
  its own tree.

  **Sync state (2026-08-17).** The desktop ran the Svalboard line 11 → 17 while
  this app sat at 11, so it was mis-driving a v17 board. That gap is closed, and
  the firmware then went further the same day:

  - **v18** removed four channels — acceleration `0x10`, smoothing `0x13`, text
    snippets `0x24`, cursor teleport `0x26` — and fixed a Windows-only scroll
    bug (an axis lock that latched on the first scroll after boot and never
    released, because the only code path that cleared it ran solely while
    scrolling).
  - **v19** made corner-combo outputs **universal**: one keycode per chord on
    every layer, no per-layer entries and no inheritance. That also fixed a
    chord bound to a layer switch leaking its own member keys.
  - **v20** added mouse-button behaviours on `0x29`: double click, and click
    lock (latch a button held like a layer toggle, so a drag needs no held
    switch), plus a release-everything rescue key.
  - **v21** finally **honoured high-resolution scroll**. The board had
    advertised the HID Resolution Multiplier for a long time while emitting
    whole detents, so a host that enabled hi-res was told a detent is 120 units
    and then sent 3 — Windows enables it, macOS does not, which is what made
    scrolling unusable on one and fine on the other. The Mouse tab gets a
    three-way mode (off / on / follow the OS) because the firmware cannot see
    the host's choice.

  Both are reflected here: those cards no longer render on a v18+ Svalboard, and
  the corner editor drops its layer selector on v19+. The gates are per-family
  and per-version, not deletions — the **Adept keeps acceleration and
  smoothing**, and a Svalboard still on v17 still gets the full old surface.
  **Firmware built and validated, not yet flashed.**

  Still desktop-only: the Build tab (compile + flash needs local disk), the Bench
  tab, and the app-side `MouseTeleporter` (which needs the real NSScreen layout).
  Still missing on both: a Vial **alt-repeat entry** editor here — the rules the
  0x25 knobs modify are readable/writable (`vialclient.js`, `.vil`) but have no
  UI, so they can only be edited via a `.vil` round trip today.

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
| `corner-tab.js` | Corner combos (0x28) — positional chords, per-layer outputs with inheritance |
| `zmk-studio-test.mjs` | Offline vector suite (node) |
| `dev-sval-harness.html` | Renders the Svalboard v12–v17 tabs against a fake device |

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

`/dev-sval-harness.html` renders the Svalboard v12–v17 tabs against a fake
device, no hardware and no WebHID. The offline templates cover `adept` and
`nlkb16` only, so those tabs otherwise had no way to be rendered before
flashing a board. It proves they **build** and read the channels they claim; it
proves nothing about the wire format, which still needs hardware.

When releasing, bump the `?v=N` stamps on module imports and the stylesheet
link — GitHub Pages' CDN caches hard. `main.js` carries its own counter in
`index.html` (currently imports `?v=37`, entry `main.js?v=37`).

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
