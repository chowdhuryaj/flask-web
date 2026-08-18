// Capability gating: (family, version) → visible features.
//
// QMK families ONLY below — ZMK families are a different firmware language
// and answer from zmk.js's own table (zmkCapabilities); the dispatcher at
// the top is the single place the two worlds meet. Never thread a ZMK
// exception through a QMK expression again (that's how this file drifted
// once already).
//
// Port of AdeptCompanion AppModel.swift has* props — that file is the
// QMK gating source of truth. Each QMK firmware family versions its OWN
// Flask protocol line, and they no longer even run in step: the Svalboard's
// left the Adept's at v12 and is at v19 today, while the Adept stays at v11 and
// the NLKB16-02 at v8 (the desktop app dropped both those devices 2026-08-14, so
// nothing advances their numbers). A raw `version >= N` compare across families
// is WRONG — always gate here, and for anything past v11 gate on
// `family === 'svalboard'` explicitly rather than on `trackball`.

import { isZmkFamily, zmkCapabilities } from './zmk.js?v=38';
import { isNapeFamily, napeCapabilities } from './nape.js?v=38';

export function capabilities(family, version) {
    if (isZmkFamily(family)) return zmkCapabilities(family, version);
    // Nape Pro: VIA wire protocol, no Vial surface and no Flask channel —
    // its own table, same dispatch-at-the-top rule as the ZMK line.
    if (isNapeFamily(family)) return napeCapabilities();

    const v = version ?? 0;
    const flask = version != null && family !== 'generic';
    const trackball = family === 'adept' || family === 'svalboard';
    const nlkb = family === 'nlkb16';
    // Everything from protocol v12 up is Svalboard-only by construction — the
    // other two QMK families are frozen below it. `sval(n)` keeps that from
    // being restated (and mis-restated) at every gate.
    const sval = (n) => flask && family === 'svalboard' && v >= n;
    return {
        flask,
        // Vial surface (keymap/macros/tap-dance/combos/overrides/QMK
        // settings): every QMK device has it.
        vial: true,
        // Mouse/pointing tuning.
        mouse: flask && trackball,
        // Acceleration (0x10) and smoothing (0x13) were REMOVED from the
        // Svalboard at v18 — they had shipped disabled and were still disabled
        // on the board, so they were pipeline stages that changed nothing. The
        // Adept keeps both, which is why these are per-family rather than gone.
        accel: flask && (family === 'adept' || (family === 'svalboard' && v < 18)),
        smoothing: flask && (family === 'adept' || (family === 'svalboard' && v < 18)),
        dpi: flask && trackball,
        // Drag scroll (0x15): trackballs. Knob shapes: per-axis divisors
        // (Adept), emit-window tuning (Sval).
        drag: flask && trackball,
        dragPerAxis: flask && family === 'adept',
        dragWindow: flask && family === 'svalboard',
        dragInvertX: false, // no QMK family exposes it (it was a ZMK value)
        dragRescue: flask && trackball,
        // Latched gesture SETS (0x11). Removed from the Svalboard at v15, where
        // gestures became hold-a-button-and-roll only — so this is a window,
        // not a floor. The Adept keeps them for as long as it exists.
        gestures: flask && (family === 'adept' || (family === 'svalboard' && v >= 10 && v < 15)),
        wiggle: flask && trackball,
        autoMouse: flask && trackball && v >= 6,
        // Svalboard's threshold is a speed gate measured in cursor-ball counts
        // per ~50-100 ms, so it needs a far wider range than the Adept's
        // per-burst accumulator (which stays 0-60).
        autoMouseWideThreshold: sval(10),
        wheelChords: flask && trackball && v >= 6,
        // A second, independent ball-gesture table for the right/cursor ball
        // (0x27). The Adept has one ball and only ever serves 0x1C.
        rightBallGestures: sval(15),
        // Gesture slots fire through vial_keycode_tap from v16 — before that
        // tap_code16 mangled everything above the basic+mods range, so the
        // picker has to keep restricting on older firmware.
        gestureAnyKeycode: sval(16),
        // Deferred click on gesture-configured buttons (0x1C/0x27 value 0x04).
        deferredClick: sval(16),
        // Typing modules (0x16-0x19): trackballs v4+, NLKB16 always.
        typing: flask && (nlkb || v >= 4),
        osShortcuts: flask && (nlkb || v >= 7),
        numWord: flask && (nlkb ? true : (family === 'svalboard' ? v >= 7 : v >= 10)),
        leaderTimeout: flask && nlkb && v >= 5,
        // Super Leader replaces the dynamic leader ON THE SAME CHANNEL (0x19)
        // at Svalboard v12: 16 sequences, and slot 5 carries an output KIND
        // with the output at slot 6. The editor has to branch on this, not
        // merely reveal extra controls — reading the old shape off a v12+ board
        // returns kinds where it expects keycodes.
        superLeader: sval(12),
        // Text snippet pool (0x24) — REMOVED at v18. The board held no snippet
        // text and none of its 16 keycodes were bound anywhere in the layout.
        // Super Leader survives with keycode-only outputs.
        snippets: sval(12) && v < 18,
        // Cyclotab (0x23), the Alt-Tab / Cmd-Tab modifier swapper.
        cyclotab: sval(12),
        // Cursor teleport (0x26) — REMOVED at v18, along with the HID digitizer
        // it needed and the 0xFB event frame. None of its six keycodes had ever
        // been bound, so it was unreachable, while the digitizer stayed
        // enumerated and competed with the trackball for the cursor.
        teleport: sval(12) && v < 18,
        teleportHostMode: sval(15) && v < 18,
        // Alt-repeat chaining + stale-input default (0x25), layered on Vial's
        // own dynamic alt-repeat table.
        altRepeatBehaviour: sval(13),
        // Positional corner combos (0x28): matched on (row, col) rather than on
        // keycodes, unlike Vial's own combos.
        cornerCombos: sval(17),
        // v19 made those outputs UNIVERSAL — one keycode per chord on every
        // layer, no per-layer entries and no inheritance. Removing the layer
        // dimension is also what fixed a chord bound to a layer switch leaking
        // its own member keys. Below v19 the editor still needs its layer
        // selector and its inherited-vs-owned rendering.
        cornerPerLayer: sval(17) && v < 19,
        // Mouse-button behaviours (0x29): double click + click lock (v20).
        mouseButtons: sval(20),
        // Hi-res scroll mode (0x15/0x08, v21). The board advertised the HID
        // Resolution Multiplier long before this, but nothing multiplied by it
        // — which is why Windows scrolling was unusable while macOS was fine.
        hiresScroll: sval(21),
        // Autoscroll (0x1A): trackballs v5+; NLKB16 v4+ (stepped only, no jog).
        autoscroll: flask && (nlkb ? v >= 4 : v >= 5),
        autoscrollJog: flask && trackball && v >= 5,
        autoscrollStopOnKey: flask && (nlkb ? v >= 4 : v >= 11),
        comboLayerMasks: flask && (nlkb || v >= 9),
        rgbMap: flask && nlkb,
        display: flask && nlkb,
        displayWidgets: flask && nlkb && v >= 3,
        bigDisplay: flask && nlkb && v >= 5,
        displayMirror: flask && nlkb && v >= 6,
        vialRGB: flask && nlkb,
        diag: flask && v >= (nlkb ? 1 : 7),
        // HUD live layer follow (meta 0x02): trackballs v10+, NLKB16 always.
        hudLayer: flask && (nlkb || v >= 10),
        // Raw CPI (0x14 cpi ids): v10+ trackballs.
        rawCpi: flask && trackball && v >= 10,
    };
}
