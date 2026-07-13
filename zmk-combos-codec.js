// flask_combos slot-frame codec (ZMK line, channel 0x24) — pure functions,
// no imports, so the node offline tests (zmk-studio-test.mjs) exercise the
// exact bytes the tab writes. Wire shape (payload-addressed, like the RGB
// LED frames — NOT a u16 frame):
//
//   [slot, pos0 … pos(K-1), usage_b3, usage_b2, usage_b1, usage_b0]
//
// K = the device's keys-per-slot (combosKeys 0x04, RO, proto v9+; v7/v8
// firmware is fixed at 4 — the DEFAULT here). pos 0xFF = unused; usage is
// the ZMK keymap encoding (usage id bits 0-15, usage page bits 16-23,
// implicit-modifier bits 24-31), big-endian on the wire. A slot is live on
// the device when usage != 0 and >= 2 positions are set — anything else is
// treated as empty.

export const COMBO_POS_NONE = 0xFF;
export const COMBO_MAX_KEYS = 4; // v7/v8 wire default; v9+ reads combosKeys

/** Reply payload → { slot, positions: number[] (unused stripped), usage }. */
export function decodeComboSlot(bytes, maxKeys = COMBO_MAX_KEYS) {
    const positions = [];
    for (let k = 0; k < maxKeys; k++) {
        const p = bytes[1 + k];
        if (p !== COMBO_POS_NONE && p != null) positions.push(p);
    }
    const u = 1 + maxKeys;
    const usage =
        (((bytes[u] << 24) | (bytes[u + 1] << 16) | (bytes[u + 2] << 8) | bytes[u + 3]) >>> 0);
    return { slot: bytes[0], positions, usage };
}

/** { positions, usage } → SET payload for the given slot index. Missing
 * positions pad with 0xFF; extras beyond maxKeys are dropped. */
export function encodeComboSlot(slot, { positions = [], usage = 0 }, maxKeys = COMBO_MAX_KEYS) {
    const pos = Array.from({ length: maxKeys },
        (_, k) => positions[k] ?? COMBO_POS_NONE);
    usage = usage >>> 0;
    return [slot & 0xFF, ...pos,
        (usage >>> 24) & 0xFF, (usage >>> 16) & 0xFF, (usage >>> 8) & 0xFF, usage & 0xFF];
}

/** Empty = the device will never fire it (matches the firmware's live-slot
 * rule: usage set AND at least two positions). */
export function comboSlotIsEmpty({ positions = [], usage = 0 }) {
    return usage === 0 || positions.length < 2;
}

// ---------------------------------------------------------------------------
// v12 typed slots (COMBOS_SLOT_V2 0x11): the output is typed — hold a
// usage, play a flask_macros slot, or invoke any Studio-addressable
// behavior by local id with two params (tap-holds, layer keys). Wire:
//   [slot, pos0 … pos(K-1), action, bid_hi, bid_lo, p1 u32 BE, p2 u32 BE]

export const COMBO_ACTION = { none: 0, usage: 1, macro: 2, behavior: 3 };

/** Reply payload → { slot, positions, action, behaviorId, param1, param2 }. */
export function decodeComboSlotV2(bytes, maxKeys = COMBO_MAX_KEYS) {
    const positions = [];
    for (let k = 0; k < maxKeys; k++) {
        const p = bytes[1 + k];
        if (p !== COMBO_POS_NONE && p != null) positions.push(p);
    }
    const a = 1 + maxKeys;
    const u32 = (o) =>
        (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    return {
        slot: bytes[0],
        positions,
        action: bytes[a] ?? 0,
        behaviorId: (((bytes[a + 1] ?? 0) << 8) | (bytes[a + 2] ?? 0)) >>> 0,
        param1: u32(a + 3),
        param2: u32(a + 7),
    };
}

/** Typed slot → SET payload. */
export function encodeComboSlotV2(slot,
    { positions = [], action = 0, behaviorId = 0, param1 = 0, param2 = 0 },
    maxKeys = COMBO_MAX_KEYS) {
    const pos = Array.from({ length: maxKeys },
        (_, k) => positions[k] ?? COMBO_POS_NONE);
    param1 = param1 >>> 0;
    param2 = param2 >>> 0;
    return [slot & 0xFF, ...pos, action & 0xFF,
        (behaviorId >>> 8) & 0xFF, behaviorId & 0xFF,
        (param1 >>> 24) & 0xFF, (param1 >>> 16) & 0xFF, (param1 >>> 8) & 0xFF, param1 & 0xFF,
        (param2 >>> 24) & 0xFF, (param2 >>> 16) & 0xFF, (param2 >>> 8) & 0xFF, param2 & 0xFF];
}

export function comboSlotV2IsEmpty({ positions = [], action = 0 }) {
    return action === COMBO_ACTION.none || positions.length < 2;
}

// ---------------------------------------------------------------------------
// v14 timed slots (COMBOS_SLOT_V3 0x12): the v2 frame plus per-combo
// timing/layer — the imported devicetree combos' knobs. Wire:
//   [v2 frame…, timeout_hi, timeout_lo, prior_hi, prior_lo, layer]
// timeoutMs 0 = inherit the global window; priorIdleMs 0 = no typing-roll
// guard; layer = layer INDEX, 0xFF = active on all layers.

export const COMBO_LAYER_ANY = 0xFF;

/** Reply payload → typed slot + { timeoutMs, priorIdleMs, layer }. */
export function decodeComboSlotV3(bytes, maxKeys = COMBO_MAX_KEYS) {
    const s = decodeComboSlotV2(bytes, maxKeys);
    const t = 1 + maxKeys + 11;
    s.timeoutMs = (((bytes[t] ?? 0) << 8) | (bytes[t + 1] ?? 0)) >>> 0;
    s.priorIdleMs = (((bytes[t + 2] ?? 0) << 8) | (bytes[t + 3] ?? 0)) >>> 0;
    s.layer = bytes[t + 4] ?? COMBO_LAYER_ANY;
    return s;
}

/** Typed+timed slot → SET payload. */
export function encodeComboSlotV3(slot, s, maxKeys = COMBO_MAX_KEYS) {
    const timeoutMs = (s.timeoutMs ?? 0) & 0xFFFF;
    const priorIdleMs = (s.priorIdleMs ?? 0) & 0xFFFF;
    const layer = (s.layer ?? COMBO_LAYER_ANY) & 0xFF;
    return [...encodeComboSlotV2(slot, s, maxKeys),
        (timeoutMs >>> 8) & 0xFF, timeoutMs & 0xFF,
        (priorIdleMs >>> 8) & 0xFF, priorIdleMs & 0xFF, layer];
}

/** Legacy {usage} slot ↔ typed slot bridges (v11 firmware / old exports). */
export function comboSlotToTyped({ slot, positions = [], usage = 0 }) {
    return {
        slot, positions,
        action: usage ? COMBO_ACTION.usage : COMBO_ACTION.none,
        behaviorId: 0, param1: usage >>> 0, param2: 0,
    };
}

export function comboTypedToLegacy({ slot, positions = [], action = 0, param1 = 0 }) {
    return { slot, positions, usage: action === COMBO_ACTION.usage ? param1 >>> 0 : 0 };
}
