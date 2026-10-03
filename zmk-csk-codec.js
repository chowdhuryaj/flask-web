// flask_csk slot-frame codec (ZMK line, channel 0x16 = QMK customShift, now a
// full mod-morph table) — pure functions so zmk-studio-test.mjs exercises the
// exact bytes the Mod Morph tab writes. ZMK slot frame at 0x50
// (payload-addressed; QMK's u16 pair tables at 0x10+/0x30+ cannot carry
// 32-bit ZMK usages):
//
//   [slot, base_b3..b0, repl_b3..b0]               legacy, 9 bytes (Shift only)
//   [slot, base_b3..b0, repl_b3..b0, mods, flags]  morph,  11 bytes
//
// base/replacement are ZMK keymap encodings (usage id bits 0-15, page 16-23,
// modifier bits 24-31), big-endian. The firmware matches base by PAGE+ID (its
// modifier bits are ignored); the replacement's modifiers apply to the output.
// mods = side-agnostic TRIGGER set, bit0 Ctrl, bit1 Shift, bit2 Alt, bit3 GUI;
// a slot fires only when the held set equals it exactly. 0 on SET means Shift.
// flags bit0 = keep (trigger mods stay in the report). A slot is live when
// base and replacement are both nonzero. The field stays named `shifted`
// (= the replacement) so older exports and callers keep working.
// MORPH_CAPS (RO u16 0x03) = 1 on firmware with the two extra bytes; older
// firmware answers 0xFF (the client throws 'unhandled').

import { CH, V } from './flaskproto.js?v=66';

export const MOD_CTL = 1, MOD_SFT = 2, MOD_ALT = 4, MOD_GUI = 8;
export const MOD_SHIFT_ONLY = MOD_SFT;
export const FLAG_KEEP = 1;
/** Chip order in the UI and in summaries. */
export const TRIGGER_MODS = [
    { bit: MOD_CTL, glyph: '⌃', name: 'Ctrl' },
    { bit: MOD_SFT, glyph: '⇧', name: 'Shift' },
    { bit: MOD_ALT, glyph: '⌥', name: 'Alt' },
    { bit: MOD_GUI, glyph: '⌘', name: 'GUI' },
];

export function decodeCskSlot(bytes) {
    const u32 = (o) =>
        (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    const mods = bytes.length > 9 ? bytes[9] & 0x0F : 0;
    return {
        slot: bytes[0], base: u32(1), shifted: u32(5),
        mods: mods || MOD_SHIFT_ONLY,                   // 0 / absent = Shift
        keep: bytes.length > 10 ? !!(bytes[10] & FLAG_KEEP) : false,
    };
}

/** `extended` forces the 11-byte frame. Default: only when the slot needs it
 * (a non-Shift trigger or keep) — a plain Shift slot goes out as the legacy
 * 9-byte frame, which old firmware accepts and new firmware reads as
 * Shift / no keep. Throws on a trigger set outside the 4 modifier bits. */
export function encodeCskSlot(slot, { base = 0, shifted = 0, mods, keep = false }, extended) {
    base = base >>> 0;
    shifted = shifted >>> 0;
    if (mods != null && (mods & ~0x0F)) throw new RangeError(`trigger mods 0x${mods.toString(16)} outside ⌃⇧⌥⌘`);
    const m = mods || MOD_SHIFT_ONLY;
    const out = [slot & 0xFF,
        (base >>> 24) & 0xFF, (base >>> 16) & 0xFF, (base >>> 8) & 0xFF, base & 0xFF,
        (shifted >>> 24) & 0xFF, (shifted >>> 16) & 0xFF, (shifted >>> 8) & 0xFF, shifted & 0xFF];
    if (extended ?? (m !== MOD_SHIFT_ONLY || keep)) out.push(m, keep ? FLAG_KEEP : 0);
    return out;
}

export function cskSlotIsEmpty({ base = 0, shifted = 0 }) {
    return base === 0 && shifted === 0;
}

/** "⌃⇧" for a trigger set. */
export function trigText(mods) {
    return TRIGGER_MODS.filter((t) => (mods || MOD_SHIFT_ONLY) & t.bit).map((t) => t.glyph).join('');
}

/** "⌃⇧ , → ;" (+ " (keep ⌃⇧)" when keep). `label(usage)` names a key. */
export function cskSummary(s, label) {
    return `${trigText(s.mods)} ${label(s.base)} → ${label(s.shifted)}${s.keep ? ` (keep ${trigText(s.mods)})` : ''}`;
}

/** Index of another live slot with the same base key (page+id) and the same
 * trigger set — it would shadow or be shadowed — or -1. Empty bases never clash. */
export function cskDuplicateOf(slots, i) {
    const s = slots[i];
    if (!s || !(s.base & 0xFFFFFF) || !s.shifted) return -1;   // incomplete slot (no replacement) never clashes
    return slots.findIndex((o, oi) => oi !== i && !cskSlotIsEmpty(o) && o.base && o.shifted
        && (o.base & 0xFFFFFF) === (s.base & 0xFFFFFF)
        && (o.mods || MOD_SHIFT_ONLY) === (s.mods || MOD_SHIFT_ONLY));
}

/** true when the firmware has the trigger/flags bytes (MORPH_CAPS == 1).
 * false only for the definitive 'unhandled' answer (old Shift-only firmware);
 * any other error (timeout, disconnect) is rethrown so callers don't mistake a
 * flaky link for old firmware. */
export async function cskMorphCaps(flask) {
    try { return (await flask.getU16(CH.customShift, V.cskMorphCaps)) === 1; }
    catch (e) {
        if (e?.message === 'unhandled') return false;
        throw e;
    }
}

/** true when the slot needs mod-morph firmware (trigger other than Shift, or keep). */
export function cskNeedsMorph(s) {
    return (s.mods || MOD_SHIFT_ONLY) !== MOD_SHIFT_ONLY || !!s.keep;
}
