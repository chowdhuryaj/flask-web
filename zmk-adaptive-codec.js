// flask_adaptive frame codecs (ZMK line, channel 0x2B, proto v18) — pure
// functions, no imports, vector-importable. Three payload-addressed frames:
//
//   rule     0x50: [rule, set, trigger u32 BE, maxIdleMs u16 BE, flags]    (9 B)
//   step     0x51: [rule, step, action, behavior u16 BE, p1 u32, p2 u32]   (13 B,
//                   the tap-dance step frame)
//   fallback 0x52: [set, action, behavior u16 BE, p1 u32, p2 u32]          (12 B)
//
// trigger = encoded usage (id bits 0-15, page 16-23 with 0 meaning 7, mods
// 24-31); trigger 0 deletes the rule. flags bit0 = exact mods. A rule's
// output is the contiguous prefix of its steps up to the first NONE; it is
// live when trigger != 0 and step 0 is not NONE. Step action vocabulary =
// tap dance / combos v2: 0 none / 1 usage / 2 flask_macros slot / 3
// behavior by Studio local id.

export const AK_ACTION = { none: 0, usage: 1, macro: 2, behavior: 3 };

const u32at = (b, o) =>
    (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const putU32 = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];

export function decodeAkRule(b) {
    return {
        rule: b[0], set: b[1] ?? 0, trigger: u32at(b, 2),
        maxIdleMs: (((b[6] ?? 0) << 8) | (b[7] ?? 0)) >>> 0,
        strict: ((b[8] ?? 0) & 1) === 1,
    };
}

export function encodeAkRule(rule, { set = 0, trigger = 0, maxIdleMs = 0, strict = false }) {
    const idle = maxIdleMs & 0xFFFF;
    return [rule & 0xFF, set & 0xFF, ...putU32(trigger >>> 0),
        (idle >>> 8) & 0xFF, idle & 0xFF, strict ? 1 : 0];
}

export function decodeAkStep(b) {
    return {
        rule: b[0], step: b[1], action: b[2] ?? 0,
        behaviorId: (((b[3] ?? 0) << 8) | (b[4] ?? 0)) >>> 0,
        param1: u32at(b, 5), param2: u32at(b, 9),
    };
}

export function encodeAkStep(rule, step,
    { action = 0, behaviorId = 0, param1 = 0, param2 = 0 }) {
    return [rule & 0xFF, step & 0xFF, action & 0xFF,
        (behaviorId >>> 8) & 0xFF, behaviorId & 0xFF,
        ...putU32(param1 >>> 0), ...putU32(param2 >>> 0)];
}

export function decodeAkFallback(b) {
    return {
        set: b[0], action: b[1] ?? 0,
        behaviorId: (((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0,
        param1: u32at(b, 4), param2: u32at(b, 8),
    };
}

export function encodeAkFallback(set,
    { action = 0, behaviorId = 0, param1 = 0, param2 = 0 }) {
    return [set & 0xFF, action & 0xFF, (behaviorId >>> 8) & 0xFF, behaviorId & 0xFF,
        ...putU32(param1 >>> 0), ...putU32(param2 >>> 0)];
}

/** A rule is free for reuse when it has no trigger. */
export const akRuleIsEmpty = (r) => !r || (r.trigger >>> 0) === 0;

/** Length of the contiguous configured prefix of `steps`. */
export function akSeqLength(steps) {
    let n = 0;
    while (n < steps.length && steps[n].action !== AK_ACTION.none) n++;
    return n;
}

export const akRuleIsLive = (r) => !akRuleIsEmpty(r) && r.steps?.[0]?.action !== AK_ACTION.none
    && !!r.steps?.length;

// ---- text <-> usages (US layout) -------------------------------------------
// Each char becomes one encoded keyboard-page usage; upper case and shifted
// symbols carry the LSHFT mod bit (0x02 in bits 24-31).

const PAGE = 0x07 << 16;
const SHIFT = 0x02 << 24;
const PLAIN = {};   // char -> usage id (no shift)
const SHIFTED = {}; // char -> usage id (with shift)
for (let i = 0; i < 26; i++) {
    PLAIN[String.fromCharCode(97 + i)] = 0x04 + i;
    SHIFTED[String.fromCharCode(65 + i)] = 0x04 + i;
}
'1234567890'.split('').forEach((c, i) => { PLAIN[c] = 0x1E + i; });
'!@#$%^&*()'.split('').forEach((c, i) => { SHIFTED[c] = 0x1E + i; });
Object.assign(PLAIN, { ' ': 0x2C, '-': 0x2D, '=': 0x2E, '[': 0x2F, ']': 0x30, '\\': 0x31,
    ';': 0x33, "'": 0x34, '`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38 });
Object.assign(SHIFTED, { '_': 0x2D, '+': 0x2E, '{': 0x2F, '}': 0x30, '|': 0x31,
    ':': 0x33, '"': 0x34, '~': 0x35, '<': 0x36, '>': 0x37, '?': 0x38 });

const BY_USAGE = new Map();
for (const [c, id] of Object.entries(PLAIN)) BY_USAGE.set((PAGE | id) >>> 0, c);
for (const [c, id] of Object.entries(SHIFTED)) BY_USAGE.set((PAGE | id | SHIFT) >>> 0, c);

/** 'Hi!' -> [H with shift, i, LS(1)] as encoded usages; null when any char is
 * not printable ASCII on a US layout. */
export function textToUsages(text) {
    const out = [];
    for (const c of text) {
        if (c in PLAIN) out.push((PAGE | PLAIN[c]) >>> 0);
        else if (c in SHIFTED) out.push((PAGE | SHIFTED[c] | SHIFT) >>> 0);
        else return null;
    }
    return out;
}

/** Inverse for labels. `steps` are {action, param1} (or bare usages); null
 * unless every step is a plain/shifted printable key. Right shift counts as
 * shift. */
export function usagesToText(steps) {
    let s = '';
    for (const st of steps) {
        if (typeof st === 'object' && st.action !== AK_ACTION.usage) return null;
        let u = (typeof st === 'object' ? st.param1 : st) >>> 0;
        if (u >>> 24 === 0x20) u = ((u & 0x00FFFFFF) | SHIFT) >>> 0;
        const c = BY_USAGE.get(u);
        if (c == null) return null;
        s += c;
    }
    return s;
}
