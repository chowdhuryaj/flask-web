// Keychron Nape Pro — device profile, capabilities, and connect path.
//
// VIA-side device (see nape-proto.js for why). This module owns everything
// Nape-specific that the shared files would otherwise have to special-case:
// profiles.js, caps.js and main.js each delegate here with a single line, the
// same way they delegate to zmk.js for the ZMK line.

import { NAPE_VIDPID, NAPE_KEYS, NAPE_LAYERS, NapeClient, napeKeyLabel } from './nape-proto.js?v=36';

export const NAPE_FAMILY_LABELS = { nape: 'Keychron Nape Pro' };

export function napeFamilyCandidate(vid, pid) {
    return (vid === NAPE_VIDPID.vid && pid === NAPE_VIDPID.pid) ? 'nape' : null;
}

export function isNapeFamily(family) { return family === 'nape'; }

/** Every flag the shared UI may read, off except ours. */
export function napeCapabilities() {
    const off = ['flask', 'vial', 'mouse', 'accel', 'dpi', 'smoothing', 'drag', 'dragPerAxis',
        'dragWindow', 'dragInvertX', 'dragRescue', 'gestures', 'wiggle', 'autoMouse',
        'wheelChords', 'typing', 'osShortcuts', 'rgbMap', 'combos', 'macros', 'tapDance',
        'customShift', 'leader', 'keyState', 'zmkStudio', 'zmkTest'];
    const caps = Object.fromEntries(off.map((k) => [k, false]));
    caps.nape = true;
    return caps;
}

// Physical layout: 7 switches in the matrix. The mapping from matrix column to
// the button names printed on the device (M1, M2, 01-04) is NOT yet confirmed —
// an earlier guess from a single data point was wrong. Names are stored per
// column once identified at the bench, and default to the column index until
// then. Nothing in this file may assume a column's identity.
const KEY_NAME_STORE = 'flask-nape-key-names';

// Columns the editor does not show. col3 is the ROUND button: AJ confirmed at
// the bench (2026-07-26) that it produces no output and is not configurable,
// whatever the keymap says it holds (CUSTOM(41), the tap/hold keycode). It is
// left at its stock value and simply not offered — editing never touches a
// hidden column, so the device keeps exactly what the vendor shipped.
const HIDDEN_COLS = new Set([3]);

export function napeVisibleCols() {
    return Array.from({ length: NAPE_KEYS }, (_, c) => c).filter((c) => !HIDDEN_COLS.has(c));
}

export function napeIsHidden(col) { return HIDDEN_COLS.has(col); }

// Button names, reconciled against every observation AJ reported plus the
// keycodes read off all nine layers (2026-07-26):
//   col0 CUSTOM(30) angle snap 90°  -> 03      col1 BTN3 middle -> 04
//   col2 BTN1 left                  -> 01      col3 CUSTOM(41)  -> ROUND button,
//   col4 scroll                     -> M1           not configurable, HIDDEN
//   col5 BTN2 right                 -> 02      col6 MO(11)      -> M2
// The decisive constraint: BTN2 exists ONLY at col5, so "02 is right click"
// pins col5, which in turn moves M2 to col6 and leaves col3 unlabelled.
// Still defaults — rename any cap in the picker and the correction sticks.
const DEFAULT_KEY_NAMES = { 0: '03', 1: '04', 2: '01', 4: 'M1', 5: '02', 6: 'M2' };

// Display order follows the labels printed on the device rather than matrix
// order: M1, M2, then the numbered keys, then anything unnamed.
function displayRank(name) {
    const m = /^M(\d+)$/i.exec(name);
    if (m) return [0, Number(m[1])];
    const n = /^0*(\d+)$/.exec(name);
    if (n) return [1, Number(n[1])];
    return [2, 0];
}

export function loadKeyNames() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY_NAME_STORE) || '{}'); } catch { /* fresh */ }
    return { ...DEFAULT_KEY_NAMES, ...stored };
}

export function saveKeyName(col, name) {
    const all = loadKeyNames();
    if (name) all[col] = name; else delete all[col];
    localStorage.setItem(KEY_NAME_STORE, JSON.stringify(all));
}

/** Label for a matrix column — profile.keys is filtered, so never index it. */
export function napeColLabel(col) {
    return loadKeyNames()[col] ?? `col ${col}`;
}

export function napeProfile() {
    const names = loadKeyNames();
    const keys = napeVisibleCols().map((col) => ({
        row: 0, col, y: 0, w: 1, h: 1, label: names[col] ?? `col ${col}`,
    }));
    // Lay them out in printed-label order, not matrix order.
    [...keys]
        .sort((a, b) => {
            const [ga, na] = displayRank(a.label), [gb, nb] = displayRank(b.label);
            return ga - gb || na - nb || a.col - b.col;
        })
        .forEach((k, i) => {
            // Gap between the M-keys and everything after them; caps are 1 unit
            // wide, so the offset must apply to every later group or they overlap.
            k.x = i * 1.15 + (displayRank(k.label)[0] >= 1 && i ? 0.35 : 0);
        });
    return {
        family: 'nape',
        name: 'Keychron Nape Pro',
        matrixRows: 1,
        matrixCols: NAPE_KEYS,
        keys,
        encoderKeys: [],
        displayTile: null,
        encoderPushKeys: {},
        customKeycodes: [],
        layerNames: Array.from({ length: NAPE_LAYERS }, (_, i) => `Layer ${i}`),
        labelFor: napeKeyLabel,
        hoverFor: napeKeyLabel,
        keyName: (k) => k.label,
    };
}

/**
 * Nape connect path: no Vial surface, no Flask protocol — a VIA dynamic keymap
 * plus the Keychron 0xA7 envelope. Mirrors loadZmkDevice's shape.
 */
export async function loadNapeDevice(app, device) {
    app.viaVersion = null;
    app.vialVersion = null;
    app.vial = null;      // no Vial surface; a stale client must not leak in
    app.unlocked = true;  // nothing to unlock — VIA writes are always allowed
    app.readKeyState = null;
    app.protocolVersion = null;

    const nape = new NapeClient(app.hid);
    app.nape = nape;

    // Bulk identity read as one uninterrupted block (read storms starve the FIFO).
    app.hid.pause();
    try {
        app.napeFirmware = await nape.firmwareVersion();
        app.layerCount = await nape.layerCount();
        app.napeKeymap = await nape.readKeymap();
        // [0xA3] reports the ACTIVE layer, which may be an INTERNAL layer with
        // no dynamic-keymap storage (10 = scroll, 11 = seen on every layer's
        // last column). Indexing napeKeymap with it yields undefined, so keep
        // the raw value for display and a clamped one for editing.
        app.napeLiveLayer = await nape.currentLayer();
        app.napeCurrentLayer = app.napeLiveLayer < app.layerCount ? app.napeLiveLayer : 0;
        app.napeAngleSnap = await nape.angleSnap();
        app.napeLayerAngles = await nape.layerAngleSnaps();
    } finally {
        app.hid.resume();
    }

    app.caps = napeCapabilities();
    app.profile = napeProfile();
    // HUD reads app.keymap as [layer][row][col]; republish in that shape.
    app.keymap = app.napeKeymap.map((layer) => [layer.slice()]);

    console.log(`Nape Pro ${app.napeFirmware}, ${app.layerCount} layers, `
        + `live layer ${app.napeLiveLayer}, angle snap ${app.napeAngleSnap}°`);
}
