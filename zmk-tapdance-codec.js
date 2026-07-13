// flask_tapdance frame codecs (ZMK line, channel 0x28) — pure functions,
// no imports, vector-importable. Two payload-addressed frames:
//
//   step 0x50: [slot, tap, action, bid_hi, bid_lo, p1 u32 BE, p2 u32 BE]
//   cfg  0x51: [slot, term_hi, term_lo]   (term ms; 0 = firmware default 200)
//
// action: 0 none / 1 usage / 2 flask_macros slot / 3 behavior by Studio
// local id with two params — same vocabulary as combos slot v2. A dance's
// length is its contiguous configured prefix (the first NONE tap ends it).

export const TD_ACTION = { none: 0, usage: 1, macro: 2, behavior: 3 };

export function decodeTdStep(bytes) {
    const u32 = (o) =>
        (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    return {
        slot: bytes[0], tap: bytes[1],
        action: bytes[2] ?? 0,
        behaviorId: (((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0)) >>> 0,
        param1: u32(5), param2: u32(9),
    };
}

export function encodeTdStep(slot, tap,
    { action = 0, behaviorId = 0, param1 = 0, param2 = 0 }) {
    param1 = param1 >>> 0;
    param2 = param2 >>> 0;
    return [slot & 0xFF, tap & 0xFF, action & 0xFF,
        (behaviorId >>> 8) & 0xFF, behaviorId & 0xFF,
        (param1 >>> 24) & 0xFF, (param1 >>> 16) & 0xFF, (param1 >>> 8) & 0xFF, param1 & 0xFF,
        (param2 >>> 24) & 0xFF, (param2 >>> 16) & 0xFF, (param2 >>> 8) & 0xFF, param2 & 0xFF];
}

export function decodeTdCfg(bytes) {
    return { slot: bytes[0], termMs: (((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0)) >>> 0 };
}

export function encodeTdCfg(slot, termMs = 0) {
    termMs = termMs & 0xFFFF;
    return [slot & 0xFF, (termMs >>> 8) & 0xFF, termMs & 0xFF];
}

/** A dance fires only its contiguous configured prefix. */
export function tdDanceLength(taps) {
    let n = 0;
    while (n < taps.length && taps[n].action !== TD_ACTION.none) n++;
    return n;
}

export function tdSlotIsEmpty({ termMs = 0, taps = [] }) {
    return termMs === 0 && taps.every((t) => t.action === TD_ACTION.none);
}
