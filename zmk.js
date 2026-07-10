// ZMK-line support — everything the app knows about ZMK Flask devices
// (today: the Cyboard Imprint, family "imprint") lives HERE, and nothing
// in the QMK modules (caps.js, profiles.js, vial*/keymap code) may special-
// case a ZMK family. QMK and ZMK are different firmware languages: QMK
// devices carry a Vial surface (keymap/macros/dynamic entries/QMK settings)
// and per-family raw-HID version lines; ZMK devices have NO Vial surface at
// all (the keymap lives in git + ZMK Studio) and speak only the Flask frame
// via zmk-flask-modules flask_proto. The only shared layer is that frame
// vocabulary (flaskproto.js CH/V/CMD) — both firmwares implement it.

import { CH, V } from './flaskproto.js?v=9';

// Stock ZMK USB identity — shared by EVERY default ZMK board, so a VID/PID
// match is only a CANDIDATE; confirmZmkFamily() reads meta 0x03 to be sure.
export const ZMK_VIDPID = { vid: 0x1D50, pid: 0x615E };

// meta 0x03 family codes on the ZMK line. Codes 1-3 mirror the QMK family
// names in the shared numbering but are never reported by a ZMK device.
export const ZMK_FAMILY_CODES = { 4: 'imprint' };

export const ZMK_FAMILIES = ['imprint'];

export function isZmkFamily(family) {
    return ZMK_FAMILIES.includes(family);
}

/** VID/PID candidate match (see ZMK_VIDPID caveat). Returns a family name
 * or null. */
export function zmkFamilyCandidate(vid, pid) {
    return (vid === ZMK_VIDPID.vid && pid === ZMK_VIDPID.pid) ? 'imprint' : null;
}

export const ZMK_FAMILY_LABELS = { imprint: 'Cyboard Imprint (ZMK)' };

// Per-family expected protocol versions — the ZMK lines are independent of
// every QMK line; never compare across. imprint: v2 added autoscroll
// (0x1A); v3 dropped dragscroll (0x15 answers unhandled — the Imprint runs
// the stock ZMK scroll chain); v4 removed autoscroll jog mode
// (AS_DEADZONE/AS_RANGE 0x03/0x04 answer unhandled — stepped-only); v5
// added the key-state channel 0x23 (HUD live press highlight); v6 added
// the flask_rgb map channel 0x21 (per-key per-layer HSV, NLKB16 wire
// shape — dims are device-sourced via 0x02/0x03); v7 added the
// flask_combos runtime-combo channel 0x24 (runtime slots + encoded usage
// output, global timeout); v8 added the flask_macros runtime-macro
// channel 0x25 (typed tap/press/release/wait steps, global tap/wait
// pacing, live play/stop); v9 (parity round) added flask_accel 0x10 (QMK
// wire shape), flask_scrollsnap 0x26, the rgbmap effect engine values
// 0x04-0x08, and the combos keys-per-slot RO value 0x04 (capacities are
// Kconfig now — slot/step/keys counts are always device-sourced); v10
// added flask_leader 0x19 (runtime position sequences, slot frame 0x50)
// and flask_gestures 0x11 (runtime sets, QMK-shared ratchet/active-set
// ids, slot frame 0x50) — both fire typed outputs (usage tap/macro slot).
export const ZMK_EXPECTED_PROTOCOL = { imprint: 10 };

/** Pressed-key set for the HUD, from the key-state bitmap (0x23). Keys are
 * "row,col" strings matching the published ZMK geometry (row 0, col =
 * position index). */
export async function zmkReadKeyState(flask) {
    const bytes = await flask.getBytes(CH.keyState, V.keyStateBitmap, []);
    const next = new Set();
    bytes.forEach((b, i) => {
        for (let bit = 0; bit < 8; bit++) {
            if (b & (1 << bit)) next.add(`0,${i * 8 + bit}`);
        }
    });
    return next;
}

/** Capability table for ZMK families — deliberately its OWN function, not
 * exceptions inside the QMK table. Anything not listed is absent on ZMK
 * (most QMK caps map to Vial surfaces or QMK-only channels). */
export function zmkCapabilities(family, version) {
    const v = version ?? 0;
    const flask = version != null;
    return {
        flask,
        vial: false,        // no Vial surface — ZMK keymap editing is Studio RPC
        // Live keymap editor over ZMK Studio RPC (WebSerial) — the ZMK
        // line's Vial equivalent. Firmware side needs CONFIG_ZMK_STUDIO=y +
        // the studio-rpc-usb-uart snippet (the tab feature-probes and
        // explains if absent).
        zmkStudio: true,
        mouse: flask,       // Mouse tuning tab (autoscroll + v9 accel/snap)
        // flask_accel (0x10, v9): the QMK pd_accel sigmoid ported — same
        // wire shape, so the shared Acceleration card drives it unchanged.
        accel: flask && v >= 9,
        // flask_scrollsnap (0x26, v9): runtime axis snap/lock on the
        // scroll ball (ZMK-line only channel).
        scrollSnap: flask && v >= 9,
        dpi: false,
        smoothing: false,
        drag: false,        // stock ZMK scroll chain (flask_scroll dropped, v3)
        dragPerAxis: false,
        dragWindow: false,
        dragInvertX: false,
        dragRescue: false,
        // flask_gestures runtime sets (0x11, v10) — the ZMK-line Gestures
        // tab (zmk-gestures-tab.js; QMK families' cap routes their own tab).
        gestures: flask && v >= 10,
        // flask_leader runtime sequences (0x19, v10) — ZMK-line Leader tab.
        leader: flask && v >= 10,
        wiggle: false,
        autoMouse: false,   // keymap-level (zip_temp_layer)
        wheelChords: false,
        typing: false,
        osShortcuts: false, // keymap-level (zmk-switch-layout)
        numWord: false,
        leaderTimeout: false,
        // Autoscroll (0x1A): imprint v2. Stepped-only — jog mode was
        // removed in v4 (spring-less trackball made it unusable).
        autoscroll: flask && v >= 2,
        autoscrollJog: false,
        autoscrollStopOnKey: flask && v >= 2,
        // Key-state bitmap (0x23, v5): HUD lights pressed keys without a
        // Vial matrix read. loadZmkDevice injects app.readKeyState.
        keyState: flask && v >= 5,
        comboLayerMasks: false, // ZMK combos gate layers natively
        // flask_rgb per-key per-layer map (0x21, v6) — rendered by the
        // ZMK-line painter (zmk-rgb-tab.js), not the NLKB16 RgbTab.
        rgbMap: flask && v >= 6,
        // flask_combos runtime combos (0x24, v7) — the ZMK-line Combos
        // tab (zmk-combos-tab.js). QMK devices never set this: their
        // combos are Vial dynamic entries behind caps.vial.
        combos: flask && v >= 7,
        // v9: keys-per-slot RO value (0x04) sizes the slot frame; v7/v8
        // firmware is fixed at the codec's 4-key default.
        combosKeys: flask && v >= 9,
        // flask_rgb effect engine (0x21 values 0x04-0x08, v9) — the
        // whole-strip animations under the painted map.
        rgbEffects: flask && v >= 9,
        // flask_macros runtime macros (0x25, v8) — the ZMK-line Macros
        // tab (zmk-macros-tab.js). QMK macros are Vial dynamic macros
        // behind caps.vial; this flag is ZMK-only.
        macros: flask && v >= 8,
        display: false,
        displayWidgets: false,
        bigDisplay: false,
        displayMirror: false,
        vialRGB: false,
        diag: false,
        hudLayer: flask,    // meta 0x02 active layer — always on the ZMK line
        rawCpi: false,
    };
}

/** Editor profile for a ZMK device — no Vial definition to build from, so
 * the editor renders tuning tabs only. */
export function zmkProfile(family) {
    return {
        family,
        name: ZMK_FAMILY_LABELS[family],
        matrixRows: 0,
        matrixCols: 0,
        keys: [],
        encoderKeys: [],
        // Mirrors config/imprint.keymap layer order (Cyboard-ZMK repo);
        // cosmetic only — the ZMK keymap tab republishes the device's real
        // names after its Studio load.
        layerNames: ['Base', 'Control', 'Fn', 'Mouse', 'Snipe', 'Num'],
        displayTile: null,
        encoderPushKeys: {},
        customKeycodes: [],
    };
}

/** Confirm the family from meta 0x03 — the stock ZMK VID/PID is shared by
 * every ZMK board, so the candidate from zmkFamilyCandidate() is a guess
 * until the device names itself. Pre-family firmware keeps the guess. */
export async function confirmZmkFamily(flask, candidate) {
    try {
        const code = await flask.getU16(CH.meta, V.metaFamily);
        if (ZMK_FAMILY_CODES[code]) return ZMK_FAMILY_CODES[code];
    } catch { /* keep candidate */ }
    return candidate;
}
