// flask_combos slot-frame codec (ZMK line, channel 0x24) — pure functions,
// no imports, so the node offline tests (zmk-studio-test.mjs) exercise the
// exact bytes the tab writes. Wire shape (payload-addressed, like the RGB
// LED frames — NOT a u16 frame):
//
//   [slot, pos0, pos1, pos2, pos3, usage_b3, usage_b2, usage_b1, usage_b0]
//
// pos 0xFF = unused; usage is the ZMK keymap encoding (usage id bits 0-15,
// usage page bits 16-23, implicit-modifier bits 24-31), big-endian on the
// wire. A slot is live on the device when usage != 0 and >= 2 positions are
// set — anything else is treated as empty.

export const COMBO_POS_NONE = 0xFF;
export const COMBO_MAX_KEYS = 4;

/** Reply payload → { slot, positions: number[] (unused stripped), usage }. */
export function decodeComboSlot(bytes) {
    const positions = [];
    for (let k = 0; k < COMBO_MAX_KEYS; k++) {
        const p = bytes[1 + k];
        if (p !== COMBO_POS_NONE && p != null) positions.push(p);
    }
    const usage =
        (((bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]) >>> 0);
    return { slot: bytes[0], positions, usage };
}

/** { positions, usage } → SET payload for the given slot index. Missing
 * positions pad with 0xFF; extras beyond 4 are dropped. */
export function encodeComboSlot(slot, { positions = [], usage = 0 }) {
    const pos = Array.from({ length: COMBO_MAX_KEYS },
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
