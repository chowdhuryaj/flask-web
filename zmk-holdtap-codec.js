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
