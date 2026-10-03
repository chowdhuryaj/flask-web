// Board identity for both firmware lines: which family a VID/PID is, its
// label, its capability table, its expected protocol, and its editor profile.
// The ZMK line's tables live in zmk.js; the QMK line (Svalboard) lives here.
// This file is the one place the two meet: never gate a QMK feature on a ZMK
// cap or compare protocol versions across families.
//
// Identity: Svalboard = 303a:4044 (unique, confirmed by its meta channel
// answering the handshake); ZMK = 1d50:615e (shared by every ZMK board,
// confirmed by meta 0x03 in zmk.js confirmZmkFamily).

import { VIDPID, EXPECTED_PROTOCOL, CH_QMK, V_QMK } from './flaskproto.js?v=76';
import { ZMK_VIDPID, ZMK_FAMILY_LABELS, ZMK_EXPECTED_PROTOCOL, isZmkFamily,
         zmkFamilyCandidate, zmkCapabilities } from './zmk.js?v=76';

/** Every VID/PID the app talks to (webhid filters, desktop allow-list). */
export const HID_IDS = [ZMK_VIDPID, VIDPID.svalboard];

export const QMK_FAMILIES = ['svalboard'];
export const isQmkFamily = (family) => QMK_FAMILIES.includes(family);

/** Firmware line for FlaskProto.line / saveState.setLine: 'zmk' | 'qmk' | null. */
export function lineOf(family) {
    if (isZmkFamily(family)) return 'zmk';
    if (isQmkFamily(family)) return 'qmk';
    return null;
}

/** Family for a VID/PID: 'svalboard', a ZMK candidate, else 'generic'. */
export function familyOf(vid, pid) {
    if (vid === VIDPID.svalboard.vid && pid === VIDPID.svalboard.pid) return 'svalboard';
    return zmkFamilyCandidate(vid, pid) ?? 'generic';
}

export function familyLabel(family) {
    return { svalboard: 'Svalboard', ...ZMK_FAMILY_LABELS }[family] ?? 'Keyboard';
}

export function expectedProtocol(family) {
    return isZmkFamily(family) ? ZMK_EXPECTED_PROTOCOL[family] : EXPECTED_PROTOCOL[family];
}

/** The capability dispatcher: ZMK families answer from zmk.js, the
 * Svalboard from qmkCapabilities, anything else gets the empty ZMK table. */
export function capabilities(family, version) {
    if (isQmkFamily(family)) return qmkCapabilities(family, version);
    return zmkCapabilities(family, version);
}

/** Svalboard (QMK line) capabilities. Keys are QMK-only names on purpose:
 * none of the ZMK tab rows' caps (zmkStudio, combos, macros, tapDance,
 * leader, customShift, gestures, rgbMap, autoscroll, ballSwap) appear here,
 * so a ZMK row can never light up on a Svalboard. Removed channels (accel,
 * smoothing, wiggle, autoscroll, teleport, snippets, gestures, ball
 * gestures) have no cap at all: the app expects v27. */
export function qmkCapabilities(family, version) {
    const v = version ?? 0;
    const flask = version != null && isQmkFamily(family);
    const at = (n) => flask && v >= n;
    return {
        flask,
        vial: isQmkFamily(family),   // Vial surface: settings, macros, entries, unlock
        mouse: flask,
        rawCpi: at(10),
        hiresScroll: at(21),
        autoMouse: at(6),
        autoMouseSources: at(24),    // 0x1B/0x05 ball mask
        typing: at(4),
        osShortcuts: at(7),
        numWord: at(7),
        superLeader: at(12),
        cyclotab: at(12),
        altRepeatBehaviour: at(13),
        comboLayerMasks: at(9),
        cornerCombos: at(17),
        cornerSlotDiag: at(23),
        cornerRefLayer: at(24),
        mouseButtons: at(20),
        diag: at(7),
        hudLayer: at(10),
        boardVariant: at(25),        // meta 0x04-0x06
        boardHalf: at(26),           // meta 0x07
    };
}

// Svalboard matrix (keyboards/svalboard/keymaps/flask/vial.json: 10 rows x
// 6 cols). Key geometry is Phase B (static layout baked from vial.json);
// until then the profile carries no keys and keyName falls back to (r,c).
export const SVALBOARD_MATRIX = { rows: 10, cols: 6 };

/** Editor profile for a QMK board. layerCount comes from Vial. */
export function qmkProfile(family, layerCount) {
    const profile = {
        family,
        name: familyLabel(family),
        matrixRows: SVALBOARD_MATRIX.rows,
        matrixCols: SVALBOARD_MATRIX.cols,
        keys: [],
        encoderKeys: [],
        layerNames: Array.from({ length: Math.max(layerCount, 1) }, (_, i) => `Layer ${i}`),
        decorations: [],
    };
    profile.defaultLayerNames = [...profile.layerNames];
    applyStoredLayerNames(profile);
    return profile;
}

/** Board variants (meta 0x04, v25). TOLD by the user, not detected: both
 * boards enumerate identically and an absent finger switch reads like an
 * unpressed one. Five-key boards have no DoubleSouth (column 5) on the
 * finger clusters; Phase B's static layout hides those keys from this. */
export const BOARD_VARIANTS = { 0: 'Not set', 1: 'Six-key clusters', 2: 'Five-key clusters (no DoubleSouth)' };

/** Device record from the QMK meta channel (v25 0x04-0x06, v26 0x07).
 * Missing ids (older firmware) stay null. fiveKey is what the layout reads. */
export async function readBoardMeta(flask, caps) {
    const get = (id) => flask.getU16(CH_QMK.meta, id).catch(() => null);
    const rec = { variant: null, clusterKeys: null, absentDrops: null, half: null };
    if (caps.boardVariant) {
        rec.variant = await get(V_QMK.metaBoardVariant);
        rec.clusterKeys = await get(V_QMK.metaClusterKeys);
        rec.absentDrops = await get(V_QMK.metaAbsentDrops);
    }
    if (caps.boardHalf) rec.half = await get(V_QMK.metaHalf);
    rec.fiveKey = rec.variant === 2 || rec.clusterKeys === 5;
    return rec;
}

export function keyName(profile, row, col) {
    return profile?.keys?.find((k) => k.row === row && k.col === col)?.label ?? `(${row},${col})`;
}

// QMK has no device-side layer names, so a rename lives in the app, per family.
const namesKey = (family) => `flask-layernames-${family}`;
function storedLayerNames(family) {
    try { return JSON.parse(globalThis.localStorage?.getItem(namesKey(family)) || '{}') || {}; } catch { return {}; }
}
export function applyStoredLayerNames(profile) {
    for (const [i, name] of Object.entries(storedLayerNames(profile.family))) {
        if (profile.layerNames[i] != null && typeof name === 'string' && name) profile.layerNames[i] = name;
    }
}
/** Rename layer `i` ('' restores the default). Persists and updates the profile. */
export function setLayerName(profile, i, name) {
    const saved = storedLayerNames(profile.family);
    const clean = String(name ?? '').trim().slice(0, 20);
    if (clean) saved[i] = clean; else delete saved[i];
    try { globalThis.localStorage?.setItem(namesKey(profile.family), JSON.stringify(saved)); } catch { /* private mode */ }
    profile.layerNames[i] = clean || profile.defaultLayerNames?.[i] || `Layer ${i}`;
}

const vidpidKey = (d) => `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;

/** Reconnect pick among granted devices. Candidates: the last VID:PID, or (while
 * editing offline) any device of the workspace family. Totem and Imprint share a
 * VID:PID (and the two Svalboard halves do too), so with two candidates the one
 * whose productName matches the last session wins. WebHID exposes no serial.
 * Returns { device, ambiguous }: still-ambiguous means the caller must show a
 * chooser instead of guessing. */
export function pickReconnectDevice(devices, { last, lastName, offlineFamily } = {}) {
    const matches = devices.filter((d) => last === vidpidKey(d)
        || (offlineFamily && familyOf(d.vendorId, d.productId) === offlineFamily));
    if (matches.length <= 1) return { device: matches[0] ?? null, ambiguous: false };
    const named = lastName ? matches.filter((d) => d.productName === lastName) : [];
    return named.length === 1 ? { device: named[0], ambiguous: false } : { device: null, ambiguous: true };
}
