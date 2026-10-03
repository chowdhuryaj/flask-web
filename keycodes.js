// HID keyboard-page key tables: names + keycap text for the letters,
// numbers, editing, modifier, navigation, function, numpad and international
// keys. `code` is the HID usage id (0x04..0xE7); the shifted-symbol aliases
// carry the usage in the low byte with Shift (0x02) in the high byte.
// Consumers: behavior-catalog.js (Keys grid sections) and zmk-keycodes.js.
//
// Below them, the QMK keycode space for the Svalboard (u16 keycodes, the
// 'qmk' adapter): ranges, media / mouse / quantum / RGB tables, the Vial
// custom keycodes from svalboard-layout.js, and describe / capLabel /
// hoverText. Ranges mirror the svalboard-vial-qmk fork's quantum/keycodes.h
// (mouse keys sit at 0x00CD-0x00DF there).

import { SVALBOARD_LAYOUT } from './svalboard-layout.js?v=76';

const K = (code, label, cap, detail) => ({ code, label, cap, detail: detail || null });

export const basicKeys = (() => {
    const keys = [];
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch, i) => keys.push(K(0x04 + i, ch, ch)));
    '1234567890'.split('').forEach((ch, i) => keys.push(K(0x1E + i, ch, ch)));
    keys.push(
        K(0x28, 'Enter', '⏎'), K(0x29, 'Escape', 'Esc'),
        K(0x2A, 'Backspace', '⌫'), K(0x2B, 'Tab', 'Tab'),
        K(0x2C, 'Space', 'Spc'), K(0x2D, 'Minus', '-'),
        K(0x2E, 'Equal', '='), K(0x2F, 'Left Bracket', '['),
        K(0x30, 'Right Bracket', ']'), K(0x31, 'Backslash', '\\'),
        K(0x33, 'Semicolon', ';'), K(0x34, 'Quote', "'"),
        K(0x35, 'Grave', '`'), K(0x36, 'Comma', ','),
        K(0x37, 'Dot', '.'), K(0x38, 'Slash', '/'),
        K(0x39, 'Caps Lock', 'Caps'),
        K(0xE0, 'Left Ctrl', 'L⌃'), K(0xE1, 'Left Shift', 'L⇧'),
        K(0xE2, 'Left Alt', 'L⌥'), K(0xE3, 'Left GUI', 'L⌘'),
        K(0xE4, 'Right Ctrl', 'R⌃'), K(0xE5, 'Right Shift', 'R⇧'),
        K(0xE6, 'Right Alt', 'R⌥'), K(0xE7, 'Right GUI', 'R⌘'),
    );
    return keys;
})();

export const navKeys = [
    K(0x46, 'Print Screen', 'PrtSc'), K(0x47, 'Scroll Lock', 'ScrLk'),
    K(0x48, 'Pause', 'Pause'), K(0x49, 'Insert', 'Ins'),
    K(0x4A, 'Home', 'Home'), K(0x4B, 'Page Up', 'PgUp'),
    K(0x4C, 'Delete', 'Del'), K(0x4D, 'End', 'End'),
    K(0x4E, 'Page Down', 'PgDn'),
    K(0x4F, 'Right Arrow', '→'), K(0x50, 'Left Arrow', '←'),
    K(0x51, 'Down Arrow', '↓'), K(0x52, 'Up Arrow', '↑'),
    K(0x65, 'Menu/App', 'App'),
];

export const fKeys = (() => {
    const keys = [];
    for (let i = 1; i <= 12; i++) keys.push(K(0x3A + i - 1, `F${i}`, `F${i}`));
    for (let i = 13; i <= 24; i++) keys.push(K(0x68 + i - 13, `F${i}`, `F${i}`));
    return keys;
})();

export const numpadKeys = (() => {
    const keys = [
        K(0x53, 'Num Lock', 'NumLk'), K(0x54, 'Keypad /', 'KP/'),
        K(0x55, 'Keypad *', 'KP*'), K(0x56, 'Keypad -', 'KP-'),
        K(0x57, 'Keypad +', 'KP+'), K(0x58, 'Keypad Enter', 'KP⏎'),
    ];
    for (let i = 1; i <= 9; i++) keys.push(K(0x59 + i - 1, `Keypad ${i}`, `KP${i}`));
    keys.push(K(0x62, 'Keypad 0', 'KP0'), K(0x63, 'Keypad .', 'KP.'),
              K(0x67, 'Keypad =', 'KP='), K(0x85, 'Keypad ,', 'KP,'));
    return keys;
})();

export const intlKeys = [
    K(0x87, "Int'l 1 (Ro)", 'Int1'), K(0x88, "Int'l 2 (Kana)", 'Int2'),
    K(0x89, "Int'l 3 (Yen)", 'Int3'), K(0x8A, "Int'l 4 (Henkan)", 'Int4'),
    K(0x8B, "Int'l 5 (Muhenkan)", 'Int5'), K(0x8C, "Int'l 6", 'Int6'),
    K(0x90, 'Lang 1 (Hangul)', 'Lng1'), K(0x91, 'Lang 2 (Hanja)', 'Lng2'),
    K(0x92, 'Lang 3', 'Lng3'), K(0x93, 'Lang 4', 'Lng4'),
    K(0x64, 'Non-US \\', 'NU\\'), K(0x32, 'Non-US #', 'NU#'),
];

// Shift-wrapped symbol aliases (0x02XX). Displayed as
// the symbol.
export const shiftedSymbols = [
    K(0x021E, '! Exclaim', '!'), K(0x021F, '@ At', '@'),
    K(0x0220, '# Hash', '#'), K(0x0221, '$ Dollar', '$'),
    K(0x0222, '% Percent', '%'), K(0x0223, '^ Caret', '^'),
    K(0x0224, '& Ampersand', '&'), K(0x0225, '* Asterisk', '*'),
    K(0x0226, '( Left Paren', '('), K(0x0227, ') Right Paren', ')'),
    K(0x022D, '_ Underscore', '_'), K(0x022E, '+ Plus', '+'),
    K(0x022F, '{ Left Brace', '{'), K(0x0230, '} Right Brace', '}'),
    K(0x0231, '| Pipe', '|'), K(0x0233, ': Colon', ':'),
    K(0x0234, '" Quote', '"'), K(0x0235, '~ Tilde', '~'),
    K(0x0236, '< Less Than', '<'), K(0x0237, '> Greater Than', '>'),
    K(0x0238, '? Question', '?'),
];

// ---------------------------------------------------------------- QMK

export const R = {
    modsBase: 0x0100, modsMax: 0x1FFF,          // QK_MODS
    modTapBase: 0x2000, modTapMax: 0x3FFF,      // QK_MOD_TAP
    layerTapBase: 0x4000, layerTapMax: 0x4FFF,  // QK_LAYER_TAP
    toBase: 0x5200,          // QK_TO
    momentaryBase: 0x5220,   // QK_MOMENTARY
    defLayerBase: 0x5240,    // QK_DEF_LAYER
    toggleLayerBase: 0x5260,
    oneShotLayerBase: 0x5280,
    oneShotModBase: 0x52A0,
    layerTapToggleBase: 0x52C0,
    tapDanceBase: 0x5700,    // QK_TAP_DANCE (TD(n))
    macroBase: 0x7700, macroMax: 0x777F, // QK_MACRO (Vial MC_n / M n)
    boot: 0x7C00,            // QK_BOOT
    debugToggle: 0x7C02,     // DB_TOGG
    kbBase: 0x7E00,          // QK_KB_0 (Vial customKeycodes)
};

export const specialKeys = [
    K(0x0000, 'None', ''),
    K(0x0001, 'Transparent', '▽'),
    K(R.boot, 'Bootloader', 'Boot', 'Reboots into the bootloader for flashing. The device disappears until re-plugged or flashed.'),
    K(R.debugToggle, 'Debug Toggle', 'DbTog'),
];

export const mediaKeys = [
    K(0xA8, 'Mute', 'Mute'), K(0xA9, 'Volume Up', 'Vol+'),
    K(0xAA, 'Volume Down', 'Vol−'), K(0xAB, 'Next Track', '⏭'),
    K(0xAC, 'Previous Track', '⏮'), K(0xAD, 'Media Stop', '⏹'),
    K(0xAE, 'Play/Pause', '⏯'), K(0xAF, 'Media Select', 'MSel'),
    K(0xB0, 'Eject', 'Eject'),
    K(0xBB, 'Fast Forward', '⏩'), K(0xBC, 'Rewind', '⏪'),
    K(0xBD, 'Brightness Up', 'Brt+'), K(0xBE, 'Brightness Down', 'Brt−'),
    K(0xA5, 'System Power', 'Power'), K(0xA6, 'System Sleep', 'Sleep'),
    K(0xA7, 'System Wake', 'Wake'),
];

export const mouseKeys = [
    K(0xD1, 'Mouse Button 1', 'BTN1'), K(0xD2, 'Mouse Button 2', 'BTN2'),
    K(0xD3, 'Mouse Button 3', 'BTN3'), K(0xD4, 'Mouse Button 4', 'BTN4'),
    K(0xD5, 'Mouse Button 5', 'BTN5'), K(0xD6, 'Mouse Button 6', 'BTN6'),
    K(0xD7, 'Mouse Button 7', 'BTN7'), K(0xD8, 'Mouse Button 8', 'BTN8'),
    K(0xD9, 'Wheel Up', 'WhU', 'Scroll wheel up one detent.'),
    K(0xDA, 'Wheel Down', 'WhD', 'Scroll wheel down one detent.'),
    K(0xDB, 'Wheel Left', 'WhL'), K(0xDC, 'Wheel Right', 'WhR'),
    K(0xCD, 'Cursor Up', 'Ms↑'), K(0xCE, 'Cursor Down', 'Ms↓'),
    K(0xCF, 'Cursor Left', 'Ms←'), K(0xD0, 'Cursor Right', 'Ms→'),
    K(0xDD, 'Mouse Accel 0', 'Acl0'), K(0xDE, 'Mouse Accel 1', 'Acl1'),
    K(0xDF, 'Mouse Accel 2', 'Acl2'),
];

export const quantumKeys = [
    K(0x7C79, 'Repeat Key', 'Rep', 'Presses whatever key was pressed last, again, mods included.'),
    K(0x7C7A, 'Alt Repeat', 'ARep', 'Presses the reverse companion of the last key (→ after ←, PgDn after PgUp).'),
    K(0x7C7B, 'Layer Lock', 'LLck', 'Locks the currently active momentary layer(s) so they stay on after release.'),
    K(0x7C73, 'Caps Word', 'CapsW', 'Caps-locks letters until you type a non-word key.'),
    K(0x7C58, 'Leader Key', 'Lead', 'Starts a Super Leader sequence (Behaviours › Leader).'),
    K(0x7C16, 'Grave Escape', 'Esc/`', 'Esc, or ` with Shift or GUI held.'),
    K(0x7C01, 'Reboot', 'Rbt', 'Restarts the keyboard.'),
];

export const rgbKeys = [
    K(0x7820, 'RGB Toggle', 'RGBTog'), K(0x7821, 'RGB Next Effect', 'RGB▶'),
    K(0x7822, 'RGB Prev Effect', 'RGB◀'), K(0x7823, 'RGB Hue +', 'Hue+'),
    K(0x7824, 'RGB Hue −', 'Hue−'), K(0x7825, 'RGB Sat +', 'Sat+'),
    K(0x7826, 'RGB Sat −', 'Sat−'), K(0x7827, 'RGB Bright +', 'Bri+'),
    K(0x7828, 'RGB Bright −', 'Bri−'), K(0x7829, 'RGB Speed +', 'Spd+'),
    K(0x782A, 'RGB Speed −', 'Spd−'),
];

// The Svalboard's Vial custom keycodes (QK_KB_0 + index), baked from
// vial.json. ponytail: one QMK board, so the table is static; a second QMK
// family would pass its own list here.
const CUSTOMS = SVALBOARD_LAYOUT.customKeycodes.map((c) => ({ ...K(R.kbBase + c.index, c.short, c.short, c.title), name: c.name }));
export const deviceCustoms = () => CUSTOMS;

/** Vial macro keycodes M0..M(count-1). The picker needs a count, not the
 * 128-code range: a board serves 16 or so. */
export const macroKeys = (count = 0) => Array.from({ length: Math.max(0, Math.min(count | 0, R.macroMax - R.macroBase + 1)) }, (_, i) =>
    K(R.macroBase + i, `Macro ${i}`, `M${i}`, 'Plays this Vial macro (Behaviours › Macros).'));

const QMK_LOOKUP = new Map();
for (const key of [...specialKeys, ...basicKeys, ...navKeys, ...fKeys, ...mediaKeys, ...mouseKeys,
    ...numpadKeys, ...intlKeys, ...shiftedSymbols, ...quantumKeys, ...rgbKeys, ...CUSTOMS]) {
    if (!QMK_LOOKUP.has(key.code)) QMK_LOOKUP.set(key.code, key);
}
/** The named QMK keycode, or null. */
export const lookup = (kc) => QMK_LOOKUP.get(kc) ?? null;

function modPrefix(bits) {
    let s = '';
    if (bits & 0x01) s += '⌃';
    if (bits & 0x02) s += '⇧';
    if (bits & 0x04) s += '⌥';
    if (bits & 0x08) s += '⌘';
    return bits & 0x10 ? 'R' + s : s;
}

export const hex = (kc) => '0x' + (kc >>> 0).toString(16).toUpperCase().padStart(4, '0');

/** Full name for any 16-bit keycode. Never fails: unknowns are hex. */
export function describe(kc) {
    const key = lookup(kc);
    if (key) return key.label;
    const base = (b) => QMK_LOOKUP.get(b)?.label ?? hex(b);
    if (kc >= R.modsBase && kc <= R.modsMax) return modPrefix((kc >> 8) & 0x1F) + base(kc & 0xFF);
    if (kc >= R.modTapBase && kc <= R.modTapMax) return `MT(${modPrefix((kc >> 8) & 0x1F)}, ${base(kc & 0xFF)})`;
    if (kc >= R.layerTapBase && kc <= R.layerTapMax) return `LT(${(kc >> 8) & 0xF}, ${base(kc & 0xFF)})`;
    if (kc >= R.toBase && kc < R.momentaryBase) return `TO(${kc & 0x1F})`;
    if (kc >= R.momentaryBase && kc < R.defLayerBase) return `MO(${kc & 0x1F})`;
    if (kc >= R.defLayerBase && kc < R.toggleLayerBase) return `DF(${kc & 0x1F})`;
    if (kc >= R.toggleLayerBase && kc < R.oneShotLayerBase) return `TG(${kc & 0x1F})`;
    if (kc >= R.oneShotLayerBase && kc < R.oneShotModBase) return `OSL(${kc & 0x1F})`;
    if (kc >= R.oneShotModBase && kc < R.layerTapToggleBase) return `OSM(${modPrefix(kc & 0x1F)})`;
    if (kc >= R.layerTapToggleBase && kc < R.layerTapToggleBase + 0x20) return `TT(${kc & 0x1F})`;
    if (kc >= R.tapDanceBase && kc <= R.tapDanceBase + 0xFF) return `TD(${kc & 0xFF})`;
    if (kc >= R.macroBase && kc <= R.macroMax) return `Macro ${kc - R.macroBase}`;
    return hex(kc);
}

/** Short keycap text. */
export function capLabel(kc) {
    const key = lookup(kc);
    if (key) return key.cap || ' ';
    const base = (b) => QMK_LOOKUP.get(b)?.cap ?? '?';
    if (kc >= R.modsBase && kc <= R.modsMax) return modPrefix((kc >> 8) & 0x1F) + base(kc & 0xFF);
    if (kc >= R.modTapBase && kc <= R.modTapMax) return `MT·${base(kc & 0xFF)}`;
    if (kc >= R.layerTapBase && kc <= R.layerTapMax) return `LT${(kc >> 8) & 0xF}·${base(kc & 0xFF)}`;
    if (kc >= R.toBase && kc < R.momentaryBase) return `TO${kc & 0x1F}`;
    if (kc >= R.momentaryBase && kc < R.defLayerBase) return `MO${kc & 0x1F}`;
    if (kc >= R.defLayerBase && kc < R.toggleLayerBase) return `DF${kc & 0x1F}`;
    if (kc >= R.toggleLayerBase && kc < R.oneShotLayerBase) return `TG${kc & 0x1F}`;
    if (kc >= R.oneShotLayerBase && kc < R.oneShotModBase) return `OSL${kc & 0x1F}`;
    if (kc >= R.oneShotModBase && kc < R.layerTapToggleBase) return 'OSM';
    if (kc >= R.layerTapToggleBase && kc < R.layerTapToggleBase + 0x20) return `TT${kc & 0x1F}`;
    if (kc >= R.tapDanceBase && kc <= R.tapDanceBase + 0xFF) return `TD${kc & 0xFF}`;
    if (kc >= R.macroBase && kc <= R.macroMax) return `M${kc - R.macroBase}`;
    return hex(kc).slice(2);
}

/** Tooltip: name, hex, and the explanation when there is one. */
export function hoverText(kc) {
    const text = `${describe(kc)} (${hex(kc)})`;
    const key = lookup(kc);
    if (key?.detail) return text + '\n' + key.detail;
    if (kc >= R.modTapBase && kc <= R.modTapMax) return text + '\nMod-tap: tap for the key, hold for the modifier.';
    if (kc >= R.layerTapBase && kc <= R.layerTapMax) return text + '\nLayer-tap: tap for the key, hold for the layer.';
    if (kc >= R.tapDanceBase && kc <= R.tapDanceBase + 0xFF) return text + '\nTap dance: Behaviours › Tap Dance.';
    if (kc >= R.macroBase && kc <= R.macroMax) return text + '\nVial macro: Behaviours › Macros.';
    return text;
}
