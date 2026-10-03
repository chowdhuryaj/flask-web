// flask_holdtap SLOT frame (ZMK line, channel 0x2A value 0x50) and SLOT_INFO
// (0x52). Pure functions, node-testable. Contract:
// .workflow/scratch/flask-holdtap-contract.md. Payload (after the 3 header
// bytes): [slot, term u16, quick u16, idle u16, flavor, flags] BE.

export const HOLDTAP_FLAVORS = ['hold-preferred', 'balanced', 'tap-preferred', 'tap-unless-interrupted'];
export const HOLDTAP_TERM = { min: 50, max: 1000 };

export function decodeHoldtapSlot(b) {
    return { slot: b[0], term: (b[1] << 8) | b[2], quick: (b[3] << 8) | b[4],
        idle: (b[5] << 8) | b[6], flavor: b[7], custom: !!(b[8] & 1) };
}

/** term 0 = reset the slot to its compiled default (other fields ignored). */
export function encodeHoldtapSlot({ slot, term, quick = 0, idle = 0, flavor = 1 }) {
    return [slot, term >> 8, term & 0xFF, quick >> 8, quick & 0xFF, idle >> 8, idle & 0xFF, flavor, 0];
}

/** SLOT_INFO → {slot, kind, keyPos, name}. */
export function decodeHoldtapInfo(b) {
    const name = String.fromCharCode(...b.slice(3, 29).filter((c) => c)).trim();
    return { slot: b[0], kind: b[1] === 1 ? 'virtual' : 'key', keyPos: b[1] === 1 ? null : b[2], name };
}

export const clampTerm = (ms) =>
    Math.max(HOLDTAP_TERM.min, Math.min(HOLDTAP_TERM.max, Math.round(ms)));

// ---- 0x53 POSITIONAL / 0x54 LOG (.workflow/scratch/ht-positional-contract.md) ----

export const HT_POSITIONAL = 0x53;
export const HT_LOG = 0x54;
/** 0x53 mode byte. 0 = what the firmware compiled (boot default; AJ 2026-10-02:
 * same-hand = tap on press on fht_l/fht_r). */
export const POSITIONAL_MODES = [
    { mode: 0, label: 'Firmware default' },
    { mode: 1, label: 'Off' },
    { mode: 2, label: 'Same hand = tap (on press, recommended)' },
    { mode: 3, label: 'Same hand = tap (on release)' },
];
export const POSITIONAL_BYTES = 26;   // trigger bitmap: positions 0..207

/** Payload [slot, mode, bitmap26] (28 bytes). `positions` = trigger key positions. */
export function encodePositional({ slot, mode, positions = [] }) {
    const bm = new Array(POSITIONAL_BYTES).fill(0);
    for (const p of positions) if (p >= 0 && p < POSITIONAL_BYTES * 8) bm[p >> 3] |= 1 << (p & 7);
    return [slot, mode, ...bm];
}

/** Reply payload → {slot, mode, positions (sorted)}. `count` drops bits at/after the key count. */
export function decodePositional(b, count = POSITIONAL_BYTES * 8) {
    const positions = [];
    for (let p = 0; p < Math.min(count, POSITIONAL_BYTES * 8); p++) if (b[2 + (p >> 3)] & (1 << (p & 7))) positions.push(p);
    return { slot: b[0], mode: b[1], positions };
}

/** Hand per key by x midpoint: keys = [{pos, x}] → Map pos → 'left'|'right'. */
export function handsOf(keys) {
    const xs = keys.map((k) => k.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    return new Map(keys.map((k) => [k.pos, k.x < mid ? 'left' : 'right']));
}

/** Trigger preset for a key on `hand`: the opposite half, plus (withThumbs)
 * that hand's own thumb keys. Thumbs = keys within 0.5 u of the lowest row
 * (keys = [{pos, x, y?}]). */
export function triggerPreset(keys, hand, withThumbs = false) {
    const hands = handsOf(keys);
    const ys = keys.map((k) => k.y).filter((y) => y != null);
    const low = ys.length ? Math.max(...ys) - 0.5 : Infinity;
    return keys.filter((k) => hands.get(k.pos) !== hand || (withThumbs && k.y != null && k.y >= low))
        .map((k) => k.pos).sort((a, b) => a - b);
}

/** 0x54 reply payload → {firstSeq, next, entries:[{seq, slot, hold, reason, otherPos (null = none),
 * heldMs, otherMs (null = none), priorGapMs}]}. seq wraps at u16. */
export function decodeHoldtapLog(b) {
    const firstSeq = (b[0] << 8) | b[1], n = Math.min(3, b[2]);
    const entries = [];
    for (let i = 0; i < n; i++) {
        const o = 3 + i * 8;
        const held = (b[o + 3] << 8) | b[o + 4], other = (b[o + 5] << 8) | b[o + 6];
        entries.push({ seq: (firstSeq + i) & 0xFFFF, slot: b[o], hold: !!(b[o + 1] & 1), reason: (b[o + 1] >> 1) & 7,
            otherPos: b[o + 2] === 0xFF ? null : b[o + 2], heldMs: held, otherMs: other === 0xFFFF ? null : other,
            priorGapMs: b[o + 7] * 4 });
    }
    return { firstSeq, next: (b[27] << 8) | b[28], entries };
}
export const LOG_REASONS = ['flavor decided on another key', 'timer expired', 'same-hand key forced tap',
    'prior-idle instant tap', 'quick-tap repeat', 'released before any decision'];
