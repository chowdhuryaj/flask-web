// What the trainer knows about the keyboard in front of you.
//
// keybr.com asks you to pick a layout from a list. This app does not have to
// ask: the keymap is right there over raw HID, so the trainer reads the letters
// off the device the user actually flashed. A Svalboard with a Colemak-ish
// layer, a swapped pinky column, or one letter moved to a thumb is described
// correctly with no configuration.
//
// Two things come out of this: the ALPHABET (which letters exist at all, so a
// lesson never asks for a character the board cannot produce), and a per-letter
// POSITION WEIGHT that lets "keyboard order" unlock the keys your fingers rest
// on before the ones they have to reach for.

/** QMK basic keycode → the character it produces unshifted. */
const KEYCODE_CHAR = new Map();
{
    for (let i = 0; i < 26; i++) KEYCODE_CHAR.set(0x04 + i, String.fromCharCode(97 + i));
    '1234567890'.split('').forEach((ch, i) => KEYCODE_CHAR.set(0x1e + i, ch));
    const punct = {
        0x2c: ' ', 0x2d: '-', 0x2e: '=', 0x2f: '[', 0x30: ']', 0x31: '\\',
        0x33: ';', 0x34: "'", 0x35: '`', 0x36: ',', 0x37: '.', 0x38: '/',
    };
    for (const [kc, ch] of Object.entries(punct)) KEYCODE_CHAR.set(Number(kc), ch);
}

/**
 * Unwrap the keycode a key really emits when tapped.
 *
 * Layer-taps and mod-taps carry a basic keycode in their low byte, and on this
 * board a letter living under `LT(3, KC_E)` is still the E key — refusing to
 * see it would hide half the alphabet on a layered layout.
 */
function tappedKeycode(kc) {
    if (kc <= 0xff) return kc;
    const low = kc & 0xff;
    // 0x4000–0x7FFF covers QMK's LT()/MT() space; the low byte is the tap code.
    if (kc >= 0x4000 && kc <= 0x7fff && low >= 0x04 && low <= 0x38) return low;
    // Plain mod-wrapped basics (LSFT(KC_A) and friends) are shifted characters,
    // not the base letter, so they are deliberately not unwrapped here.
    return kc;
}

/**
 * Describe the connected keyboard for the lesson generator.
 *
 * @param profile the device profile (geometry + matrix), or null
 * @param keymap  [layer][row][col] keycodes, or null
 * @param layers  which layers count as "typing" layers
 */
export function keyboardFromKeymap(profile, keymap, layers = [0, 1]) {
    if (profile?.keys == null || keymap == null) return null;

    /** codepoint → the first matrix position that produces it. */
    const position = new Map();
    for (const layer of layers) {
        const grid = keymap[layer];
        if (grid == null) continue;
        for (const key of profile.keys) {
            const kc = tappedKeycode(grid[key.row]?.[key.col] ?? 0);
            const ch = KEYCODE_CHAR.get(kc);
            if (ch == null || ch === ' ') continue;
            const cp = ch.codePointAt(0);
            if (!position.has(cp)) position.set(cp, key);
        }
    }
    if (position.size === 0) return null;

    // Position weight, from geometry rather than a per-device table.
    //
    // Keys are grouped by matrix row and weighted by distance from the group's
    // centre. On the Svalboard a matrix row IS one finger cluster, so the centre
    // key of each cluster — the one the finger rests on — comes out heaviest,
    // and the up/down/side directions fall away behind it. On a row-staggered
    // board the same rule favours the middle of each physical row, which is
    // the right answer there too.
    const groups = new Map();
    for (const key of profile.keys) {
        let g = groups.get(key.row);
        if (g == null) groups.set(key.row, (g = []));
        g.push(key);
    }
    const centres = new Map();
    for (const [row, keys] of groups) {
        let sx = 0;
        let sy = 0;
        for (const k of keys) { sx += k.x + (k.w ?? 1) / 2; sy += k.y + (k.h ?? 1) / 2; }
        centres.set(row, { x: sx / keys.length, y: sy / keys.length });
    }
    const weights = new Map();
    for (const [cp, key] of position) {
        const c = centres.get(key.row);
        const dx = key.x + (key.w ?? 1) / 2 - c.x;
        const dy = key.y + (key.h ?? 1) / 2 - c.y;
        weights.set(cp, 1 / (1 + Math.hypot(dx, dy)));
    }

    return {
        codePoints: new Set(position.keys()),
        positionOf: (cp) => position.get(cp) ?? null,
        weightOf: (cp) => weights.get(cp) ?? 0,
        /** Reverse lookup for the heatmap: "row,col" → codepoint. */
        charAt: (row, col) => {
            for (const [cp, key] of position) {
                if (key.row === row && key.col === col) return cp;
            }
            return null;
        },
    };
}
