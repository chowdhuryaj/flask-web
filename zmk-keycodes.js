// ZMK binding vocabulary — naming + params for ZMK Studio bindings.
// ZMK-line module (nothing here may be imported by a QMK module; importing
// keycodes.js DATA is legal — dependency direction ZMK → shared data).
//
// A ZMK "keycode" is a binding {behaviorId, param1, param2}: behavior ids
// are device-assigned at runtime (fetched over Studio RPC), params are
// interpreted per the behavior's metadata descriptors. The only stable
// vocabulary is HID usages: param = (page << 16) | id, with implicit
// modifier bits at >= bit 24 (ZMK LS(x) etc).

import { basicKeys, navKeys, fKeys, numpadKeys, intlKeys } from './keycodes.js?v=9';

export const HID_PAGE_KEYBOARD = 0x07;
export const HID_PAGE_CONSUMER = 0x0C;

// The QMK basic/nav/f/numpad/intl tables ARE HID keyboard-page usage ids
// (0x04..0xE7) — reuse their names/caps verbatim. (QMK media/mouse/quantum
// tables are QMK-internal codes, NOT usages — never seed from those.)
export const keyboardUsages = [...basicKeys, ...navKeys, ...fKeys, ...numpadKeys, ...intlKeys]
    .map(({ code, label, cap }) => ({ code, label, cap }));

// Consumer-page usages (HUT 1.5 ids), mirroring ZMK's common C_* defines.
const C = (code, label, cap) => ({ code, label, cap });
export const consumerUsages = [
    C(0xCD, 'Play/Pause', '⏯'), C(0xB5, 'Next Track', '⏭'),
    C(0xB6, 'Previous Track', '⏮'), C(0xB7, 'Stop', '⏹'),
    C(0xB3, 'Fast Forward', '⏩'), C(0xB4, 'Rewind', '⏪'),
    C(0xE2, 'Mute', 'Mute'), C(0xE9, 'Volume Up', 'Vol+'), C(0xEA, 'Volume Down', 'Vol−'),
    C(0x6F, 'Brightness Up', 'Brt+'), C(0x70, 'Brightness Down', 'Brt−'),
    C(0x30, 'Power', 'Power'), C(0x32, 'Sleep', 'Sleep'), C(0xB8, 'Eject', 'Eject'),
    C(0x192, 'Calculator', 'Calc'), C(0x18A, 'Email', 'Mail'),
    C(0x221, 'Browser Search', 'Srch'), C(0x223, 'Browser Home', 'Home'),
    C(0x224, 'Browser Back', 'Back'), C(0x225, 'Browser Forward', 'Fwd'),
    C(0x226, 'Browser Stop', 'BStop'), C(0x227, 'Browser Refresh', 'Refr'),
    C(0x22A, 'Browser Bookmarks', 'Bkmk'),
    C(0x82, 'Mode Step', 'Mode'), C(0x9C, 'Channel Up', 'Ch+'), C(0x9D, 'Channel Down', 'Ch−'),
];

const kbByUsage = new Map(keyboardUsages.map((k) => [k.code, k]));
const consByUsage = new Map(consumerUsages.map((k) => [k.code, k]));

export const kpParam = (id) => ((HID_PAGE_KEYBOARD << 16) | id) >>> 0;
export const cpParam = (id) => ((HID_PAGE_CONSUMER << 16) | id) >>> 0;

/** Split a usage param: implicit-mod bits live at >= bit 24 (ZMK LS() etc). */
export function usageParts(param) {
    param = param >>> 0;
    return { mods: param >>> 24, page: (param >>> 16) & 0xFF, id: param & 0xFFFF };
}

// ZMK modifier bits (dt-bindings/zmk/modifiers.h): L CTL/SFT/ALT/GUI = 0x01/
// 0x02/0x04/0x08, right-hand versions <<4.
function modGlyphs(mods) {
    let s = '';
    if (mods & 0x01) s += '⌃';
    if (mods & 0x02) s += '⇧';
    if (mods & 0x04) s += '⌥';
    if (mods & 0x08) s += '⌘';
    if (mods & 0x10) s += 'R⌃';
    if (mods & 0x20) s += 'R⇧';
    if (mods & 0x40) s += 'R⌥';
    if (mods & 0x80) s += 'R⌘';
    return s;
}

const hexU = (v, w = 4) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// KeyboardEvent.code → HID keyboard-page usage id (HUT 1.5 §10), for the
// keymap editor's type-to-assign capture. Physical-position codes, layout
// independent — exactly what a keymap wants.
const EVENT_CODE_TO_USAGE = (() => {
    const m = new Map();
    for (let i = 0; i < 26; i++) m.set(`Key${String.fromCharCode(65 + i)}`, 0x04 + i);
    for (let i = 1; i <= 9; i++) m.set(`Digit${i}`, 0x1D + i);
    m.set('Digit0', 0x27);
    const rest = {
        Enter: 0x28, Escape: 0x29, Backspace: 0x2A, Tab: 0x2B, Space: 0x2C,
        Minus: 0x2D, Equal: 0x2E, BracketLeft: 0x2F, BracketRight: 0x30,
        Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
        Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
        PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
        Insert: 0x49, Home: 0x4A, PageUp: 0x4B, Delete: 0x4C, End: 0x4D, PageDown: 0x4E,
        ArrowRight: 0x4F, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
        NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
        NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58, NumpadDecimal: 0x63,
        IntlBackslash: 0x64, ContextMenu: 0x65, IntlRo: 0x87, IntlYen: 0x89,
        ControlLeft: 0xE0, ShiftLeft: 0xE1, AltLeft: 0xE2, MetaLeft: 0xE3,
        ControlRight: 0xE4, ShiftRight: 0xE5, AltRight: 0xE6, MetaRight: 0xE7,
    };
    for (const [k, v] of Object.entries(rest)) m.set(k, v);
    for (let i = 1; i <= 12; i++) m.set(`F${i}`, 0x39 + i);
    for (let i = 13; i <= 24; i++) m.set(`F${i}`, 0x68 + (i - 13));
    for (let i = 1; i <= 9; i++) m.set(`Numpad${i}`, 0x58 + i);
    m.set('Numpad0', 0x62);
    return m;
})();

/** KeyboardEvent → usage param for type-to-assign, or null when the physical
 * key has no HID equivalent. Held modifiers ride the implicit-mod bits UNLESS
 * the captured key is itself a modifier (assign the bare mod key then). */
export function eventToUsageParam(e) {
    const id = EVENT_CODE_TO_USAGE.get(e.code);
    if (id == null) return null;
    if (id >= 0xE0) return kpParam(id); // bare modifier key
    let mods = 0;
    if (e.ctrlKey) mods |= 0x01;
    if (e.shiftKey) mods |= 0x02;
    if (e.altKey) mods |= 0x04;
    if (e.metaKey) mods |= 0x08;
    return ((mods << 24) | kpParam(id)) >>> 0;
}

/** Short keycap text for a usage param. Unknowns render as page:id hex —
 * readable, never a crash. */
export function usageCap(param) {
    const { mods, page, id } = usageParts(param);
    const base = page === HID_PAGE_KEYBOARD ? kbByUsage.get(id)?.cap
        : page === HID_PAGE_CONSUMER ? consByUsage.get(id)?.cap
        : null;
    return modGlyphs(mods) + (base ?? `${page.toString(16).padStart(2, '0')}:${hexU(id)}`);
}

/** Long name for a usage param (hovers/toasts). */
export function usageLabel(param) {
    const { mods, page, id } = usageParts(param);
    const base = page === HID_PAGE_KEYBOARD ? kbByUsage.get(id)?.label
        : page === HID_PAGE_CONSUMER ? consByUsage.get(id)?.label
        : null;
    const modPart = mods ? modGlyphs(mods) + ' + ' : '';
    return modPart + (base ?? `usage ${page.toString(16)}:${hexU(id)}`);
}

/** Resolve a typed key name to a usage param (picker composer inputs).
 * Matches label or cap, keyboard page first. Returns null if unknown. */
export function usageFromName(name) {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    for (const [table, toParam] of [[keyboardUsages, kpParam], [consumerUsages, cpParam]]) {
        const hit = table.find((k) => k.label.toLowerCase() === q || k.cap.toLowerCase() === q)
            ?? table.find((k) => k.label.toLowerCase().startsWith(q));
        if (hit) return toParam(hit.code);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Device context registry — behaviors + layers arrive over Studio RPC after
// connect (same pattern as keycodes.js setDeviceCustomKeys).

let ctx = { behaviors: new Map(), layers: [] };

export function setZmkContext({ behaviors, layers }) {
    ctx = { behaviors, layers };
}

export function zmkBehaviors() { return ctx.behaviors; }
export function zmkLayers() { return ctx.layers; }

/** Layer display name by STABLE layer id (not index). */
export function layerName(layerId) {
    return ctx.layers.find((l) => l.id === layerId)?.name ?? `Layer#${layerId}`;
}

// Cosmetic short names for well-known ZMK behavior display names — Vial
// parity on the keycaps. Semantics NEVER key off these (params are always
// interpreted via metadata descriptors); unknown names get a generic
// abbreviation, everything still works.
const BEHAVIOR_ABBREV = new Map([
    ['Key Press', ''],
    ['Momentary Layer', 'MO'],
    ['Toggle Layer', 'TG'],
    ['To Layer', 'TO'],
    ['Layer Tap', 'LT'],
    ['Sticky Layer', 'SL'],
    ['Sticky Key', 'SK'],
    // Core ZMK spells these hyphenated (app/dts/behaviors/*.dtsi display-name
    // strings at pin 484a0547) — keep the space variants too, they cost nothing.
    ['Mod-Tap', 'MT'],
    ['Layer-Tap', 'LT'],
    ['Mouse Key Press', 'MB'],
    ['Mod Tap', 'MT'],
    ['Hold Tap', 'HT'],
    ['Key Toggle', 'KT'],
    ['Caps Word', 'CapsW'],
    ['Key Repeat', 'Rep'],
    ['Mouse Button Press', 'MB'],
    ['Mouse Move', 'Ms'],
    ['Mouse Scroll', 'Sc'],
    ['Transparent', '▽'],
    ['None', ''],
    ['Reset', 'Reset'],
    ['Bootloader', 'Boot'],
    ['Studio Unlock', 'Unlock'],
    ['Bluetooth', 'BT'],
    ['Output Selection', 'Out'],
    ['External Power', 'Pwr'],
    ['Soft Off', 'Off'],
    ['RGB Underglow', 'RGB'],
    ['Backlight', 'BL'],
    // Imprint smart one-shot/hold round (2026-07-10). Explicit entries:
    // the initials fallback would give Smart Layer 'SL' — colliding with
    // Sticky Layer — and 'Sticky Mod (smart)' the unreadable 'SM('.
    ['Smart Mod', 'SM'],
    ['Smart Layer', 'SmL'],
    ['Sticky Mod (smart)', 'SkM'],
]);

function abbrevName(displayName) {
    const known = BEHAVIOR_ABBREV.get(displayName);
    if (known !== undefined) return known;
    const words = displayName.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return words.map((w) => w[0].toUpperCase()).join('');
    return displayName.slice(0, 5);
}

/** First metadata set's descriptors for one param (usually the only set). */
function paramDescs(details, which) {
    return details?.metadata?.[0]?.[which] ?? [];
}

function paramUsed(descs) {
    return descs.length > 0 && descs.some((d) => d.kind !== 'nil');
}

/** Short text for one param value given its descriptors. */
function paramCap(descs, value) {
    const constant = descs.find((d) => d.kind === 'constant' && d.constant === (value >>> 0));
    if (constant) return constant.name || String(value);
    if (descs.some((d) => d.kind === 'hid_usage')) return usageCap(value);
    if (descs.some((d) => d.kind === 'layer_id')) return layerName(value);
    return String(value | 0);
}

function paramLabel(descs, value) {
    const constant = descs.find((d) => d.kind === 'constant' && d.constant === (value >>> 0));
    if (constant) return constant.name || String(value);
    if (descs.some((d) => d.kind === 'hid_usage')) return usageLabel(value);
    if (descs.some((d) => d.kind === 'layer_id')) return layerName(value);
    return String(value | 0);
}

/** Short keycap text for a binding. Metadata-driven; never throws. */
export function bindingCap(binding) {
    if (!binding) return ' ';
    const details = ctx.behaviors.get(binding.behaviorId);
    if (!details) return `#${binding.behaviorId}`;
    const abbrev = abbrevName(details.displayName);
    const p1 = paramDescs(details, 'param1');
    const p2 = paramDescs(details, 'param2');
    const parts = [];
    if (abbrev) parts.push(abbrev);
    if (paramUsed(p1)) parts.push(paramCap(p1, binding.param1));
    if (paramUsed(p2)) parts.push(paramCap(p2, binding.param2));
    if (!parts.length) return abbrev || details.displayName.slice(0, 5) || ' ';
    return parts.join('·');
}

/** Multi-line tooltip for a binding. */
export function bindingHover(binding) {
    if (!binding) return '';
    const details = ctx.behaviors.get(binding.behaviorId);
    const raw = `behavior #${binding.behaviorId} · p1 ${hexU(binding.param1, 8)} · p2 ${hexU(binding.param2, 8)}`;
    if (!details) return `Unknown behavior\n${raw}`;
    const p1 = paramDescs(details, 'param1');
    const p2 = paramDescs(details, 'param2');
    const args = [];
    if (paramUsed(p1)) args.push(paramLabel(p1, binding.param1));
    if (paramUsed(p2)) args.push(paramLabel(p2, binding.param2));
    const head = args.length ? `${details.displayName}(${args.join(', ')})` : details.displayName;
    return `${head}\n${raw}`;
}

/** One-line description (toasts). */
export function bindingDescribe(binding) {
    return bindingHover(binding).split('\n')[0];
}
