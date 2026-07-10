// flask typed-output codecs (ZMK line, proto v10) — pure functions, no
// imports, node-testable. The shared output shape both flask_leader and
// flask_gestures fire:
//
//   action 0 = none · 1 = tap an encoded usage (ZMK keymap encoding, mods
//   bits 24-31) · 2 = play flask_macros slot <param>
//
// Leader slot frame (channel 0x19, value 0x50, payload-addressed):
//   [seq, pos0 … pos(K-1) (0xFF = empty), action, param u32 BE]
// Gesture slot frame (channel 0x11, value 0x50, payload-addressed):
//   [set, dir (0-7, E..NE clockwise), action, param u32 BE]

export const OUTPUT_ACTION = { none: 0, usage: 1, macro: 2 };
export const LEADER_POS_NONE = 0xFF;
export const GESTURE_DIR_LABELS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

const u32be = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
const rdU32be = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);

/** { positions:[…], action, param } → SET payload for sequence seq. */
export function encodeLeaderSlot(seq, { positions = [], action = 0, param = 0 }, maxKeys) {
    const pos = Array.from({ length: maxKeys }, (_, k) => positions[k] ?? LEADER_POS_NONE);
    return [seq & 0xFF, ...pos, action & 0xFF, ...u32be(param >>> 0)];
}

/** Reply payload → { seq, positions (order-preserving prefix), action, param }. */
export function decodeLeaderSlot(bytes, maxKeys) {
    const positions = [];
    for (let k = 0; k < maxKeys; k++) {
        const p = bytes[1 + k];
        if (p === LEADER_POS_NONE || p == null) break;   // sequence = leading prefix
        positions.push(p);
    }
    const a = 1 + maxKeys;
    return { seq: bytes[0], positions, action: bytes[a] ?? 0, param: rdU32be(bytes, a + 1) };
}

export function leaderSlotIsEmpty({ positions = [], action = 0 }) {
    return action === OUTPUT_ACTION.none || positions.length < 1;
}

/** { action, param } → SET payload for (set, dir). */
export function encodeGestureSlot(set, dir, { action = 0, param = 0 }) {
    return [set & 0xFF, dir & 0xFF, action & 0xFF, ...u32be(param >>> 0)];
}

/** Reply payload → { set, dir, action, param }. */
export function decodeGestureSlot(bytes) {
    return { set: bytes[0], dir: bytes[1], action: bytes[2] ?? 0, param: rdU32be(bytes, 3) };
}
