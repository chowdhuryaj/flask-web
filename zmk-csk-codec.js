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
//
// OS-aware shortcuts (oskeys-contract.md) use more flags bits:
//   bit1-2 OS condition (0 any, 1 Mac, 2 Windows/PC), bit3 wildcard (base is
//   ignored: any key matches; only the replacement's MOD bits are used),
//   bit4 count keymap mods (&kp ⌘C style implicit mods count as held).
// OSK_CAPS (RO u16 0x05) = 1 on firmware that takes them; OS_MODE (RO u16
// 0x04) = the board's current OS (0 PC, 1 Mac, 0xFFFF no switch-layout module).

import { CH, V } from './flaskproto.js?v=68';

export const MOD_CTL = 1, MOD_SFT = 2, MOD_ALT = 4, MOD_GUI = 8;
export const MOD_SHIFT_ONLY = MOD_SFT;
export const FLAG_KEEP = 1;
export const OS_ANY = 0, OS_MAC = 1, OS_PC = 2;     // condition field (bits 1-2)
export const FLAG_WILD = 8, FLAG_COUNT = 16;
export const OS_NAMES = ['Any OS', 'Mac', 'Windows'];
/** Wildcard slots ignore the base and the replacement's key; the firmware
 * still wants nonzero usages for a "live" slot, so both carry this key (A). */
export const WILD_KEY = 0x70004;
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
    const fl = bytes.length > 10 ? bytes[10] : 0;
    const out = {
        slot: bytes[0], base: u32(1), shifted: u32(5),
        mods: mods || MOD_SHIFT_ONLY,                   // 0 / absent = Shift
        keep: !!(fl & FLAG_KEEP),
    };
    // OS fields only when set, so plain slots keep their old shape.
    const os = (fl >> 1) & 3;
    if (os === OS_MAC || os === OS_PC) out.os = os;
    if (fl & FLAG_WILD) out.wild = true;
    if (fl & FLAG_COUNT) out.count = true;
    return out;
}

/** `extended` forces the 11-byte frame. Default: only when the slot needs it
 * (a non-Shift trigger or keep) — a plain Shift slot goes out as the legacy
 * 9-byte frame, which old firmware accepts and new firmware reads as
 * Shift / no keep. Throws on a trigger set outside the 4 modifier bits. */
export function encodeCskSlot(slot, { base = 0, shifted = 0, mods, keep = false, os = 0, wild = false, count = false }, extended) {
    base = base >>> 0;
    shifted = shifted >>> 0;
    if (mods != null && (mods & ~0x0F)) throw new RangeError(`trigger mods 0x${mods.toString(16)} outside ⌃⇧⌥⌘`);
    if (os !== OS_ANY && os !== OS_MAC && os !== OS_PC) throw new RangeError(`OS condition ${os} is not any/Mac/Windows`);
    const flags = (keep ? FLAG_KEEP : 0) | (os << 1) | (wild ? FLAG_WILD : 0) | (count ? FLAG_COUNT : 0);
    const m = mods || MOD_SHIFT_ONLY;
    const out = [slot & 0xFF,
        (base >>> 24) & 0xFF, (base >>> 16) & 0xFF, (base >>> 8) & 0xFF, base & 0xFF,
        (shifted >>> 24) & 0xFF, (shifted >>> 16) & 0xFF, (shifted >>> 8) & 0xFF, shifted & 0xFF];
    if (extended ?? (m !== MOD_SHIFT_ONLY || flags)) out.push(m, flags);
    return out;
}

export function cskSlotIsEmpty({ base = 0, shifted = 0 }) {
    return base === 0 && shifted === 0;
}

/** "⌃⇧" for a trigger set. */
export function trigText(mods) {
    return TRIGGER_MODS.filter((t) => (mods || MOD_SHIFT_ONLY) & t.bit).map((t) => t.glyph).join('');
}

/** "⌃⇧ , → ;" (+ " (keep ⌃⇧)" when keep). `label(usage)` names a key.
 * OS rows read "Windows: ⌘Q → ⌥F4"; wildcard rows "Windows: ⌘ + any key → ⌃ + same key"
 * (a wildcard replacement is only its mods; `label` should include mods, e.g. usageCap). */
export function cskSummary(s, label) {
    const keep = s.keep ? ` (keep ${trigText(s.mods)})` : '';
    const pre = s.os ? `${OS_NAMES[s.os]}: ` : '';
    if (s.wild) {
        const rm = TRIGGER_MODS.filter((t) => (s.shifted >>> 24) & t.bit).map((t) => t.glyph).join('');   // not trigText: 0 would read as Shift
        return `${pre}${trigText(s.mods)} + any key → ${rm ? `${rm} + ` : ''}same key${keep}`;
    }
    if (pre) return `${pre}${trigText(s.mods)}${label(s.base)} → ${label(s.shifted)}${keep}`;
    return `${trigText(s.mods)} ${label(s.base)} → ${label(s.shifted)}${keep}`;
}

/** Could both slots catch the same press (so one shadows the other)? Same
 * wildcard-ness, same trigger set, OS conditions that can hold together, and
 * for specific slots the same base key (page+id). Wildcards never clash with
 * specific slots: a specific slot wins by design. */
export function cskClash(a, b) {
    if (!!a.wild !== !!b.wild) return false;
    if ((a.mods || MOD_SHIFT_ONLY) !== (b.mods || MOD_SHIFT_ONLY)) return false;
    const oa = a.os || 0, ob = b.os || 0;
    if (oa && ob && oa !== ob) return false;
    return a.wild || (a.base & 0xFFFFFF) === (b.base & 0xFFFFFF);
}

/** Index of another live slot that clashes with slot i (see cskClash), or -1.
 * Empty/incomplete slots never clash; a wildcard's base is not compared. */
export function cskDuplicateOf(slots, i) {
    const s = slots[i];
    const live = (x) => x && x.shifted && (x.wild || (x.base & 0xFFFFFF));
    if (!live(s)) return -1;   // incomplete slot (no replacement) never clashes
    return slots.findIndex((o, oi) => oi !== i && !cskSlotIsEmpty(o) && live(o) && cskClash(s, o));
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

/** true when the slot needs OS-aware firmware (OS condition, wildcard, count-keymap-mods). */
export function cskNeedsOs(s) {
    return !!(s.os || s.wild || s.count);
}

/** true when the firmware takes flags bits 1-4 (OSK_CAPS == 1). Same error rule as cskMorphCaps. */
export async function cskOskCaps(flask) {
    try { return (await flask.getU16(CH.customShift, V.cskOskCaps)) === 1; }
    catch (e) {
        if (e?.message === 'unhandled') return false;
        throw e;
    }
}

/** The board's OS mode: OS_PC (2) / OS_MAC (1) as a slot condition, or null when
 * the firmware has no switch-layout module or doesn't report it. */
export async function cskOsMode(flask) {
    try {
        const v = await flask.getU16(CH.customShift, V.cskOsMode);
        return v === 0 ? OS_PC : v === 1 ? OS_MAC : null;
    } catch (e) {
        if (e?.message === 'unhandled') return null;
        throw e;
    }
}
