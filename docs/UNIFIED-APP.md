# Unified app (branch `unify`)

One static app, three boards. Two firmware lines share the Flask raw-HID frame.

| Board | Line | Identity | Protocol |
|---|---|---|---|
| Svalboard | QMK + Vial | `303a:4044` (unique) | v27 |
| TOTEM | ZMK | `1d50:615e`, meta 0x03 = 6 | v19 |
| Cyboard Imprint | ZMK | `1d50:615e`, meta 0x03 = 4 | v19 (v16 on older configs) |

## Identity

`boards.js familyOf(vid, pid)` returns `svalboard`, a ZMK candidate
(`zmkFamilyCandidate`, `imprint` by default), or `generic`. The ZMK VID/PID is
shared, so the candidate is only a guess: `confirmZmkFamily()` (zmk.js) reads
meta 0x03 after connect and maps it through `ZMK_FAMILY_CODES`. An unreadable
family blocks keymap import, Mode apply and Studio writes until a reconnect.
`lineOf(family)` gives `'zmk' | 'qmk'`; `capabilities(family, version)` is the
only way to gate a feature. Never compare a version across families.

## Channel maps (flaskproto.js)

Channel ids overlap between lines (0x23-0x29 mean different things), so each
line has its own map. Use `CH_ZMK` / `V` for ZMK and `CH_QMK` / `V_QMK` for
the Svalboard, and only behind a capability gate.

- `CH_ZMK`: meta, accel 0x10, gestures 0x11, customShift 0x16, leader 0x19,
  autoscroll 0x1A, autoMouse 0x1B, rgbMap 0x21, keyState 0x23, combos 0x24,
  macros 0x25, scrollSnap 0x26, ballSwap 0x27, tapDance 0x28, scrollScale 0x29,
  adaptive 0x2B, autoShift 0x2C.
- `CH_QMK`: meta, dpi 0x14, dragScroll 0x15, customShift 0x16, selectWord 0x17,
  sentenceCase 0x18, leader 0x19, autoMouse 0x1B, os 0x1D, numWord 0x1E,
  diag 0x1F, comboLayers 0x20, cyclotab 0x23, altRepeat 0x25, corner 0x28,
  mouseButtons 0x29.

## Never SAVE 0x28 on the QMK line

On the Svalboard 0x28 is the corner-chord block. Its SETs persist themselves,
and a channel SAVE rewrites about 1.9 KB with XIP off, which wedged the board
(2026-08-14). `FlaskProto.save()` throws unless `line === 'zmk'` (an unset line
also refuses). Do not add a path around it.

## Adding a fourth board

1. Detection: VID/PID in `HID_IDS` (boards.js), `familyOf`, `familyLabel`;
   webhid.js filters and desktop/main.js allow-list.
2. A family confirmation read (meta 0x03 or a Vial keyboard id).
3. Capabilities table behind `capabilities()`, plus `expectedProtocol()` row.
4. Profile: `{family, name, keys[], layerNames[], decorations[], labelFor,
   hoverFor, keyName, capAdapter}`.
5. Keymap adapter implementing the `Adapter` contract in board.js (~L355:
   `surface, app, profile, layers, bindingAt, write, posOf, selOf`, optional
   `readOnly, renameLayer, layerOps, onWrite`) and a tab that owns the transport.
6. Keycode vocabulary: encode/decode/capParts/describe/legend per adapter,
   `SURFACES` entries in binding-picker.js, `CATALOG` mappings.
7. Default keymap and geometry for Unplugged (or hide Unplugged, as for the Svalboard).
8. `TAB_TABLE` rows with `when` gates; `BOARD_TABS` / `SIDE_TABS` membership.
9. Export/import payload and Modes keyed by family.
10. Per-line channel map in flaskproto.js; do not reuse `CH_ZMK` / `CH_QMK`.

Full list with file:line anchors: `.workflow/scratch/unify/webapp-audit.md`, section 2.

## Firmware push order

1. `zmk-flask-modules` `unify`
2. `Totem-ZMK` `unify` (pins the modules revision)
3. `Cyboard-ZMK` `unify`, after unarchiving the GitHub repo (it is archived,
   pushes are rejected until then)

Then flask-web `unify`. The app's expected protocol (`ZMK_EXPECTED_PROTOCOL`)
should match what step 1 serves.
