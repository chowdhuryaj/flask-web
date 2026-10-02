// HID keyboard-page key tables: names + keycap text for the letters,
// numbers, editing, modifier, navigation, function, numpad and international
// keys. `code` is the HID usage id (0x04..0xE7); the shifted-symbol aliases
// carry the usage in the low byte with Shift (0x02) in the high byte.
// Consumers: behavior-catalog.js (Keys grid sections) and zmk-keycodes.js.

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
