// Device profiles: what the editor renders and how the keymap is addressed.
// Port of AdeptCompanion Sources/AdeptCore/DeviceProfile.swift.
// Curated geometry for the QMK Flask devices; generic profile built from
// any Vial keyboard's self-served definition. ZMK devices are profiled by
// zmk.js (zmkProfile) — this file only delegates identification/labels.

import { VIDPID } from './flaskproto.js?v=18';
import { zmkFamilyCandidate, ZMK_FAMILY_LABELS } from './zmk.js?v=18';

// Adept geometry mirrors keyboards/ploopyco/madromys/info.json (key units).
const ADEPT_KEYS = [
    { row: 0, col: 1, label: 'Top Left Left', x: 0, y: 0, w: 1, h: 2 },
    { row: 0, col: 2, label: 'Top Left', x: 1.25, y: 0, w: 1, h: 1.25 },
    { row: 0, col: 3, label: 'Top Right', x: 2.5, y: 0, w: 1, h: 1.25 },
    { row: 0, col: 4, label: 'Top Right Right', x: 3.75, y: 0, w: 1, h: 2 },
    { row: 0, col: 0, label: 'Bottom Left', x: 0, y: 2.25, w: 1.75, h: 2 },
    { row: 0, col: 5, label: 'Bottom Right', x: 3, y: 2.25, w: 1.75, h: 2 },
];

export function familyOf(vid, pid) {
    if (vid === VIDPID.adept.vid && pid === VIDPID.adept.pid) return 'adept';
    if (vid === VIDPID.nlkb16.vid && pid === VIDPID.nlkb16.pid) return 'nlkb16';
    if (vid === VIDPID.svalboard.vid && pid === VIDPID.svalboard.pid) return 'svalboard';
    // ZMK candidate (stock ZMK VID/PID; loadZmkDevice confirms via meta 0x03).
    const zmk = zmkFamilyCandidate(vid, pid);
    if (zmk) return zmk;
    return 'generic';
}

export function familyLabel(family) {
    return {
        adept: 'Ploopy Adept', svalboard: 'Svalboard', nlkb16: 'NLKB16-02',
        generic: 'Vial keyboard',
        ...ZMK_FAMILY_LABELS,
    }[family];
}

/**
 * Build the profile the editor renders.
 * definition = parsed vial.json (vialdef.js), layerCount from the device.
 */
export function buildProfile(family, definition, layerCount) {
    const profile = {
        family,
        name: definition.name,
        matrixRows: definition.matrixRows,
        matrixCols: definition.matrixCols,
        keys: definition.keys.map((k) => ({ ...k, label: `${k.row},${k.col}` })),
        encoderKeys: definition.encoderKeys,
        layerNames: Array.from({ length: Math.max(layerCount, 1) }, (_, i) => `Layer ${i}`),
        displayTile: null,
        encoderPushKeys: {},
        customKeycodes: definition.customKeycodes,
    };

    if (family === 'adept') {
        profile.name = 'Ploopy Adept Trackball';
        profile.keys = ADEPT_KEYS;
        // Fixed 8-layer plan (vial-qmk repo CLAUDE.md "Layer plan").
        profile.layerNames = ['Base', 'Mouse', 'Scroll', 'Fn', 'L4', 'L5', 'L6', 'L7']
            .slice(0, Math.max(layerCount, 4));
    }

    if (family === 'nlkb16') {
        // Curated arrangement (2026-07-06): the served KLE strews encoder caps
        // along the edges. Physically: 4×4 grid, two small knobs + one big
        // knob to the right, plus the OLED. Each knob's rotation caps sit
        // above its own push key; big-knob caps above the OLED tile. The big
        // knob's push (matrix 2,4) is dropped — vendor never wired the switch.
        profile.keys = profile.keys
            .filter((k) => !(k.row === 2 && k.col === 4))
            .map((k) => {
                if (k.row === 0 && k.col === 4) return { ...k, label: 'Knob 1 push', x: 4.85, y: 1, w: 1, h: 1 };
                if (k.row === 1 && k.col === 4) return { ...k, label: 'Knob 2 push', x: 6.75, y: 1, w: 1, h: 1 };
                return k;
            });
        const cap = (index, cw, x, y) => ({ index, clockwise: cw, x, y, w: 0.7, h: 0.85 });
        profile.encoderKeys = [
            cap(0, false, 4.60, 0.05), cap(0, true, 5.40, 0.05),
            cap(1, false, 6.50, 0.05), cap(1, true, 7.30, 0.05),
            cap(2, false, 4.60, 2.05), cap(2, true, 5.40, 2.05),
        ];
        profile.displayTile = { x: 4.60, y: 3.0, w: 2.0, h: 1.0 };
        profile.encoderPushKeys = { 0: { row: 0, col: 4 }, 1: { row: 1, col: 4 } };
    }

    return profile;
}

export function keyName(profile, row, col) {
    return profile.keys.find((k) => k.row === row && k.col === col)?.label ?? `(${row},${col})`;
}

export function encoderCount(profile) {
    return profile.encoderKeys.reduce((m, e) => Math.max(m, e.index + 1), 0);
}
