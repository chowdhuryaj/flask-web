// Generates zmk-totem-default.js (the offline TOTEM preview's default
// keymap) from the firmware keymap, so the preview is never hand-written:
//   node gen-totem-default.mjs [path/to/totem.keymap]
// zmk-studio-test.mjs fails when the checked-in file is stale vs the .keymap.
// Supported bindings: &kp &trans &none &mo &to &tog &sl &lt &mt with plain
// keyboard-page keys. Anything else becomes Transparent and is listed in
// `unsupported` (the preview can't simulate custom behaviors it has no
// catalog entry for).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const KEYMAP_PATH = join(homedir(), 'Archive/ZMK-Flask/Totem-ZMK/config/totem.keymap');
export const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'zmk-totem-default.js');

// ZMK dt-bindings key name → HID keyboard-page usage id.
const ZMK_KEYS = (() => {
    const m = {};
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { m[c] = 0x04 + i; });
    for (let i = 1; i <= 9; i++) { m[`N${i}`] = 0x1D + i; m[`NUMBER_${i}`] = 0x1D + i; }
    m.N0 = m.NUMBER_0 = 0x27;
    for (let i = 1; i <= 12; i++) m[`F${i}`] = 0x39 + i;
    for (let i = 13; i <= 24; i++) m[`F${i}`] = 0x68 + (i - 13);
    const alias = {
        0x28: ['ENTER', 'RET', 'RETURN'], 0x29: ['ESC', 'ESCAPE'], 0x2A: ['BSPC', 'BACKSPACE'],
        0x2B: ['TAB'], 0x2C: ['SPACE'], 0x2D: ['MINUS'], 0x2E: ['EQUAL'],
        0x2F: ['LBKT', 'LEFT_BRACKET'], 0x30: ['RBKT', 'RIGHT_BRACKET'],
        0x31: ['BSLH', 'BACKSLASH'], 0x33: ['SEMI', 'SEMICOLON'],
        0x34: ['SQT', 'APOS', 'APOSTROPHE', 'SINGLE_QUOTE'], 0x35: ['GRAVE'],
        0x36: ['COMMA'], 0x37: ['DOT', 'PERIOD'], 0x38: ['FSLH', 'SLASH'],
        0x39: ['CAPS', 'CAPSLOCK', 'CAPS_LOCK'], 0x49: ['INS', 'INSERT'], 0x4A: ['HOME'],
        0x4B: ['PG_UP', 'PAGE_UP'], 0x4C: ['DEL', 'DELETE'], 0x4D: ['END'], 0x4E: ['PG_DN', 'PAGE_DOWN'],
        0x4F: ['RIGHT', 'RIGHT_ARROW'], 0x50: ['LEFT', 'LEFT_ARROW'],
        0x51: ['DOWN', 'DOWN_ARROW'], 0x52: ['UP', 'UP_ARROW'],
        0xE0: ['LCTRL', 'LEFT_CONTROL', 'LCTL'], 0xE1: ['LSHFT', 'LSHIFT', 'LEFT_SHIFT'],
        0xE2: ['LALT', 'LEFT_ALT'], 0xE3: ['LGUI', 'LCMD', 'LWIN', 'LEFT_GUI'],
        0xE4: ['RCTRL', 'RIGHT_CONTROL', 'RCTL'], 0xE5: ['RSHFT', 'RSHIFT', 'RIGHT_SHIFT'],
        0xE6: ['RALT', 'RIGHT_ALT'], 0xE7: ['RGUI', 'RCMD', 'RWIN', 'RIGHT_GUI'],
    };
    for (const [code, names] of Object.entries(alias)) for (const n of names) m[n] = Number(code);
    return m;
})();

/** Text of the first `{ ... }` node (brace-matched) that contains `needle`,
 * innermost-first search from the needle outward. */
function enclosingNode(text, needle) {
    const at = text.indexOf(needle);
    if (at < 0) throw new Error(`no "${needle}" node in keymap`);
    let depth = 0, start = -1;
    for (let i = at; i >= 0; i--) {
        if (text[i] === '}') depth++;
        else if (text[i] === '{') { if (depth === 0) { start = i; break; } depth--; }
    }
    let d = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') d++;
        else if (text[i] === '}' && --d === 0) return text.slice(start + 1, i);
    }
    throw new Error('unbalanced braces in keymap');
}

export function parseKeymap(src) {
    const text = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const body = enclosingNode(text, 'zmk,keymap');
    const layers = [];
    const unsupported = new Set();
    const layerRe = /(\w+)\s*\{([^{}]*?)\}\s*;/g;
    let m;
    while ((m = layerRe.exec(body))) {
        const b = /bindings\s*=\s*<([\s\S]*?)>\s*;/.exec(m[2]);
        if (!b) continue;
        const name = /display-name\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? m[1];
        const bindings = b[1].split('&').slice(1).map((tok) => {
            const [beh, ...args] = tok.trim().split(/\s+/);
            const key = (n) => {
                if (!(n in ZMK_KEYS)) throw new Error(`unknown key "${n}" in layer ${name}`);
                return ZMK_KEYS[n];
            };
            const num = (n) => {
                if (!/^\d+$/.test(n)) throw new Error(`bad layer arg "${n}" in layer ${name}`);
                return Number(n);
            };
            try {
                switch (beh) {
                    case 'trans': return ['trans'];
                    case 'none': return ['none'];
                    case 'kp': return ['kp', key(args[0])];
                    case 'mo': case 'to': case 'tog': case 'sl': return [beh, num(args[0])];
                    case 'lt': return ['lt', num(args[0]), key(args[1])];
                    case 'mt': return ['mt', key(args[0]), key(args[1])];
                    default: unsupported.add(`&${beh}`); return ['trans'];
                }
            } catch (e) {
                unsupported.add(`&${beh} ${args.join(' ')}`.trim());
                return ['trans'];
            }
        });
        layers.push({ name, bindings });
    }
    if (!layers.length) throw new Error('no layers found in keymap');
    return { layers, unsupported: [...unsupported].sort() };
}

export function generate(src, source) {
    const { layers, unsupported } = parseKeymap(src);
    const data = {
        source,
        sha256: createHash('sha256').update(src).digest('hex'),
        placeholder: false,
        layers, unsupported,
    };
    return `// GENERATED by gen-totem-default.mjs from ${source} — do not edit.\n`
        + '// Binding forms: [kp,hid] [trans] [none] [mo|to|tog|sl,layer] [lt,layer,hid] [mt,holdHid,tapHid].\n'
        + `export const TOTEM_DEFAULT = ${JSON.stringify(data, null, 1)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const path = process.argv[2] ?? KEYMAP_PATH;
    if (!existsSync(path)) { console.error(`no keymap at ${path}`); process.exit(1); }
    const out = generate(readFileSync(path, 'utf8'), 'config/totem.keymap');
    writeFileSync(OUT_PATH, out);
    console.log(`wrote ${OUT_PATH}`);
}
