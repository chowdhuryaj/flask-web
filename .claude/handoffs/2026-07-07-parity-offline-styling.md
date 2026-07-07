# Session Handoff: flask-web parity + offline workspaces + desktop restyle

**Date:** 2026-07-07 (evening session; follows the morning "flask-web v0.1" handoff)
**Projects:** ~/flask-web (main), ~/AdeptCompanion (restyle + protocol bump)
**Session Duration:** ~1 long session

## Current State

**Task:** Parallel web+desktop development, apps tracking 1:1 (user decision this session).
**Phase:** Implementation complete, browser-verified; **hardware verification is the entire remaining gate** (user away from all 3 devices).
**Progress:** Web ≈ desktop feature parity done. Desktop wears web styling. Nothing hardware-tested yet.

## What We Did

1. **Fixed the mod/mod-tap picker bug** (user report): `buildPicker()` ran `renderCodes()` before `root.append(...)` — `codes.after(composer)` is a spec no-op on a parentless node, so the LT/MT/Mods+key/OSM composer never rendered on a fresh picker. Plus silent guards → toasts, auto-advance after assign, device-custom cap fallbacks. flask-web `de38308`.
2. **Built offline workspaces** (user was away from devices): per-family localStorage journal, `OfflineFlask`/`OfflineVial` mirror the live client surfaces so every tab runs device-less; dirty entries replay on next connect (confirm modal or auto-apply). Snapshots captured on every real connect. flask-web `e1136ef`.
3. **Ported the remaining desktop tabs to web** (parity round): Macros, Tap Dance, Combos (+layer masks), Key Overrides, Gestures, Mouse Chords, RGB painter + VialRGB, Display, .vil save/load. Offline journal extended to cover all of it. flask-web `c5733a9`.
4. **Restyled the desktop app to the web look**: PipetteTheme.swift transcribes styles.css/main.js THEMES token-for-token; web theme list (Classic auto/Light/Dark/Nord/Dracula/Solarized), pinned themes ignore macOS scheme; web chrome (12px bordered cards, pill chips, accent-bg selection). AdeptCompanion `353d620`; also committed the stray NLKB16 v8/LAYERNAME bump as `c8ca265`. Flask.app rebuilt + /Applications refreshed.

All pushed. Pages live at https://chowdhuryaj.github.io/flask-web/ (cache-bust `?v=4`).

## Decisions Made

- **Parallel development, not web-primary** — user likes both apps; web is now the **styling source of truth** (they prefer its look), desktop mirrors it. Any styling change lands in flask-web first, then PipetteTheme.swift.
- **Offline sync = dirty-journal replay, never full-snapshot writes** — a blank template can't wipe a real keymap. Last-write-wins per address (keymap cell / encoder slot / (ch,id) tunable / entry index / whole macro list / (layer,led) / display line).
- **Auto-apply is opt-in** (`flask-offline-autoapply` after first confirm modal) — satisfies "auto-update when plugged in" without blind first writes.
- **Gesture/chord picker vetoes non-`tap_code16` keycodes** (> 0x1FFF) — mirrors firmware limitation instead of letting dead slots be configured.
- **Desktop keeps `Pipette` namespace/component names** — value+chrome swap only, zero churn across ~20 view files.
- **Old desktop theme names (Grape/Forest/…) fall back to Classic** — no migration UI.

## Code Changes

**~/flask-web (3 commits, all pushed):**
- `picker.js` — init-order fix, `need()` guard toasts, `kcCell` + `makePickerHost` shared helpers (restrict/veto support)
- `keymap-tab.js` — auto-advance selection after assign
- `offline.js` — NEW: workspaces, OfflineFlask/OfflineVial (now incl. dynamic entries, macros, RGB bytes, display text), sync engine + confirm modal, snapshot capture, `normalize()` append-only schema
- `macros-tab.js`, `entries-tab.js`, `gestures-tab.js` (Gestures+Chords), `rgb-tab.js`, `display-tab.js` — NEW tabs
- `vil.js` — NEW: .vil export/import, `dumpSpec()` mirrors AppModel.tuningDumpSpec, `flask_tunings` + `flask_rgbmap` extensions
- `main.js` — tab registry (12 tabs, caps-gated), offline landing chips/banner/start-exit, sync hook in loadDevice, .vil header buttons, viaVersion/vialVersion capture
- `index.html`, `styles.css`, `keycodes.js`, `README.md` — supporting edits

**~/AdeptCompanion (2 commits, pushed):**
- `Sources/AdeptCompanion/PipetteTheme.swift` — full rewrite to web tokens/chrome (see decision above)
- `Sources/AdeptCore/AdeptProtocol.swift` — NLKB16 expected protocol 7→8, "Layer name" widget id 14 (was uncommitted from the morning firmware round)

**Key code context:**
- `JSON.stringify(data, replacerArray)` filters keys at EVERY depth — emptied `key_override`/`flask_tunings` in .vil export until fixed (vil.js). Never pass a key-list replacer to nested data.
- Offline live-state ids never journal: drag 0x15/04, autoscroll 0x1A/05, diag 0x1F/01, numword 0x1E/03, gesture latch 0x11/02, display raw/reinit 0x22/07-08.
- Macro sync is unlock-gated: firmware silently drops locked writes; sync verifies by re-read and keeps the journal entry with a "locked — unlock, then replug" failure.

## TO-DO: Flash

- [ ] **Adept → protocol v11 firmware** (`make ploopyco/madromys/rev1_001:vial`, uf2 drag-drop, hold Bottom-Left on plug). v11 (OS_TABP/OS_TABN/OS_LNCH + autoscroll stop-on-key) has NEVER reached hardware — both apps expect v11 and will show a proto-warn against the currently-flashed older build.
- [ ] **Svalboard → v11-line firmware** (~/svalboard-vial-qmk branch flask-port; build /left and /right SEPARATELY). Same not-reflashed state.
- [ ] **NLKB16 — nothing to flash** (v8 flashed + verified 2026-07-07). Reflash only if firmware changes; remember the Maple bootloader mass-erases EEPROM → restore via web/desktop .vil afterward.

## TO-DO: Test on hardware (web app, per device)

Adept → Sval → NLKB16, at https://chowdhuryaj.github.io/flask-web/ (Chromium):

- [ ] Connect via chooser; XZ definition decode; keymap read renders
- [ ] Reassign a key online + type it; clamp-echo on a tuning slider (set out-of-range, watch it snap back)
- [ ] **Offline sync replay**: queue edits in the workspace first, then plug in → confirm modal lists them → Apply → verify on device; tick auto-apply and repeat once silently
- [ ] **Dynamic entries**: create a tap dance + combo + key override from web; confirm firing. Frame risk: `[0xFE,0x0D,op,idx,entry…]` — entry at byte 4, NO pad byte
- [ ] **Macros**: locked write → tab warns; unlock → save → verified toast; macro fires
- [ ] **Gestures/chords (trackballs)**: slot write, latch a set via keycode + via active-set select, ratchet feel
- [ ] **RGB (NLKB16)**: paint a led, fill, save, power-cycle persist; VialRGB effect switch
- [ ] **Display (NLKB16)**: widget per line, custom text, push test, re-init button; **OLED mirror offsets in HUD** (`0x22/0x0C` → `[line, invert, 5 chars, panel_on]` slice — known-risk)
- [ ] **Sval matrix-state byte order** (unlock → press keys in HUD — least-certain codec)
- [ ] Sval auto-mouse timeout INDEX write; raw CPI 0 = re-arm table mode
- [ ] `.vil` from web opens in Vial GUI and in desktop Flask; NLKB16 bootloader-erase → web .vil restore round-trip
- [ ] Replug silent reconnect; HUD layer-follow; unlock flow (no-abort — replug recovers)

## TO-DO: Test (desktop app)

- [ ] Visual pass over all 21 tabs with a device connected — new styling (12px bordered cards, pill chips) on every tab; flag anything washed-out (chips are quieter than the old solid-blue)
- [ ] All 6 new themes incl. pinned-dark under macOS light mode; theme picker swatches
- [ ] HUD window styling; NLKB16 tabs expect protocol v8 (should be clean — flashed)
- [ ] /Applications/Flask.app is the fresh copy (already replaced; verify no stale process)

## TO-DO: Assess (decisions for the user)

- [ ] Desktop chip/selection contrast after real use — tune or keep?
- [ ] Does desktop need offline workspaces for symmetry, or is web the travel app? (current asymmetry: web-only)
- [ ] `VIAL_INSECURE` in firmwares to kill the unlock dance on personal boards?
- [ ] Brainstorm backlog priorities: type-to-assign + keyboard nav (gated capture mode), .vil auto-snapshots to IndexedDB (version history), HUD layer-change flash, momentary DPI-boost keycode for multi-monitor, vertical-rail nav now that web has 12 tabs
- [ ] make-app.sh version string still says 1.2.0 — bump on next release round

## Blockers / Issues

- None software-side. Everything gated on physical device access.

## Context to Remember

- Endianness triple-mix: Flask u16 BE bytes[3][4]; keymap buffer BE; Vial dynamic entries/definition size/QSIDs LE. Commented per codec — don't "fix".
- Don't run flask-web + Vial GUI + desktop Flask against one board simultaneously.
- Pages CDN caches hard — bump `?v=N` on every import (currently v=4).
- Offline template tuning sliders start at zero (journal-on-touch staging, not a mirror); snapshot workspaces show real values after first connect. Device keycode category empty in templates until a snapshot exists.
- git identity on this machine is `aj@MacBook-Pro-85.local` (no global user.email) — `git config --global user.email chowd198@umn.edu` if attribution matters.

## Files to Review on Resume

- `~/flask-web/offline.js` — journal/sync semantics; read before touching any offline behavior
- `~/flask-web/vil.js` — dump spec + .vil schema (bootloader-erase restore path)
- `~/flask-web/main.js` — tab registry + connect/offline flow
- `~/AdeptCompanion/Sources/AdeptCompanion/PipetteTheme.swift` — the styling contract (web = source of truth)
- `~/.claude/projects/-Users-aj-vial-qmk/memory/flask-web-configurator.md` — persisted project memory
