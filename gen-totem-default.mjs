// Generates the offline TOTEM preview's firmware-derived data from the
// firmware repo at a COMMIT, so the preview is never hand-written:
//   node gen-totem-default.mjs [path/to/Totem-ZMK] [git ref, default HEAD]
//   zmk-totem-layout.js   <- zmk,physical-layout in boards/shields/totem/totem.dtsi
//                            (what Studio reports online)
//   zmk-totem-default.js  <- config/totem.keymap: behavior catalog, layers,
//                            flask,combos-defaults
// Sources are read with `git show <sha>:<path>` (never the working tree) and
// the commit is recorded as `firmwareSha`. zmk-studio-test.mjs regenerates
// from THAT sha and fails only if the output differs (generator change), and
// when anything in the keymap could not be translated (`unsupported` must be
// empty). A newer Totem-ZMK HEAD is a note, not a failure.
//
// Behavior naming follows the device: a node's Studio display name is its
// `display-name` property; nodes without one list BLANK (urob leader, slk_*
// and friends already behave this way on hardware — `label` is not used).
// Metadata: ZMK-core compatibles and the flask-* ones carry parameter
// metadata; third-party ones (adaptive-key, tri-state, switch-layout-*,
// leader-key) ship none. ASSUMPTION, not bench-verified for the hold-tap /
// mod-morph / macro nodes.

import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FIRMWARE_ROOT = join(homedir(), 'dev/Input/Flask-Svalboard/Totem-ZMK');
const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DEFAULT = join(HERE, 'zmk-totem-default.js');
export const OUT_LAYOUT = join(HERE, 'zmk-totem-layout.js');
const REL_KEYMAP = 'config/totem.keymap';
const REL_LAYOUT = 'boards/shields/totem/totem.dtsi';

// ---------------------------------------------------------------- keys ---
const KB = 7, CONSUMER = 0x0C;
const MODS = { C: 0x01, S: 0x02, A: 0x04, G: 0x08 };   // R-prefixed = <<4
const KEYS = (() => {
    const m = {};
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { m[c] = [KB, 0x04 + i]; });
    for (let i = 1; i <= 9; i++) { m[`N${i}`] = m[`NUMBER_${i}`] = [KB, 0x1D + i]; }
    m.N0 = m.NUMBER_0 = [KB, 0x27];
    for (let i = 1; i <= 12; i++) m[`F${i}`] = [KB, 0x39 + i];
    for (let i = 13; i <= 24; i++) m[`F${i}`] = [KB, 0x68 + (i - 13)];
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
    for (const [code, names] of Object.entries(alias)) for (const n of names) m[n] = [KB, Number(code)];
    // dt-bindings/zmk/keys.h shifted symbols are LS(<base>).
    const shifted = {
        EXCL: 'N1', AT: 'N2', HASH: 'N3', DLLR: 'N4', PRCNT: 'N5', CARET: 'N6', AMPS: 'N7',
        STAR: 'N8', ASTERISK: 'N8', LPAR: 'N9', RPAR: 'N0', UNDER: 'MINUS', PLUS: 'EQUAL',
        LBRC: 'LBKT', RBRC: 'RBKT', PIPE: 'BSLH', COLON: 'SEMI', DQT: 'SQT',
        TILDE: 'GRAVE', LT: 'COMMA', GT: 'DOT', QMARK: 'FSLH',
    };
    for (const [n, base] of Object.entries(shifted)) m[n] = [KB, m[base][1], MODS.S];
    // Consumer page.
    Object.assign(m, {
        C_VOL_UP: [CONSUMER, 0xE9], C_VOL_DN: [CONSUMER, 0xEA], C_MUTE: [CONSUMER, 0xE2],
        C_PP: [CONSUMER, 0xCD], C_PLAY_PAUSE: [CONSUMER, 0xCD],
        C_REWIND: [CONSUMER, 0xB4], C_FF: [CONSUMER, 0xB3], C_FAST_FORWARD: [CONSUMER, 0xB3],
        C_NEXT: [CONSUMER, 0xB5], C_PREV: [CONSUMER, 0xB6],
    });
    return m;
})();

// Named non-key arguments (dt-bindings bt.h / outputs.h, switch-layout.h).
// OS_NEXT = ZMK_SWITCH_LAYOUT_NEXT: the header lives in the zmk-switch-layout
// module (not vendored here); the value is cosmetic since &sw_layout lists
// with no metadata.
const SYMBOLS = {
    BT_CLR: 0, BT_NXT: 1, BT_PRV: 2, BT_SEL: 3, BT_CLR_ALL: 4, BT_DISC: 5,
    OUT_TOG: 0, OUT_USB: 1, OUT_BLE: 2, ZMK_SWITCH_LAYOUT_NEXT: 0xFFFF,
};

// ------------------------------------------------------- stock behaviors ---
const usage = (name) => [{ name, kind: 'hid_usage' }];
const layer = () => [{ name: 'Layer', kind: 'layer_id' }];
const range = (name, min, max) => [{ name, kind: 'range', min, max }];
const consts = (list) => list.map(([name, constant]) => ({ name, kind: 'constant', constant }));
const meta = (p1 = [], p2 = []) => [{ param1: p1, param2: p2 }];
// DT label -> [displayName, metadata]. Same names/metadata as the Studio
// stock behaviors the offline sim already used for the Imprint.
const STOCK = {
    kp: ['Key Press', meta(usage('Key'))], trans: ['Transparent', meta()], none: ['None', meta()],
    mo: ['Momentary Layer', meta(layer())], to: ['To Layer', meta(layer())],
    tog: ['Toggle Layer', meta(layer())], sl: ['Sticky Layer', meta(layer())],
    lt: ['Layer-Tap', meta(layer(), usage('Tap'))], mt: ['Mod-Tap', meta(usage('Hold'), usage('Tap'))],
    sk: ['Sticky Key', meta(usage('Key'))], kt: ['Key Toggle', meta(usage('Key'))],
    caps_word: ['Caps Word', meta()], key_repeat: ['Key Repeat', meta()],
    sys_reset: ['Reset', meta()], bootloader: ['Bootloader', meta()],
    out: ['Output Selection', meta(consts([['Toggle', 0], ['USB', 1], ['BLE', 2]]))],
    bt: ['Bluetooth', meta(consts([['Clear', 0], ['Next', 1], ['Previous', 2], ['Select', 3]]),
        range('Profile', 0, 4))],
    studio_unlock: ['Studio Unlock', meta()],
};
// Slot capacities the sim seeds for the flask-* range metadata (Kconfig on
// hardware); keep equal to zmk-offline.js IMPRINT.macroSlots/tdSlots.
const FLASK_MACRO_SLOTS = 32, FLASK_TD_SLOTS = 16;

// ------------------------------------------------------------ DT parser ---
function clean(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Minimal devicetree reader: nodes {label,name,props,children}. Property
 * values stay raw strings. */
function parseDt(text) {
    let i = 0;
    function body() {
        const node = { props: {}, children: [] };
        for (;;) {
            while (i < text.length && /\s/.test(text[i])) i++;
            if (i >= text.length || text[i] === '}') { i++; return node; }
            if (text[i] === '#' && /^#\s*(include|define|if|endif|else|undef)/.test(text.slice(i, i + 10))) {
                while (i < text.length && text[i] !== '\n') i++;
                continue;
            }
            let j = i, depthAngle = 0, inStr = false;
            for (; j < text.length; j++) {
                const c = text[j];
                if (c === '"') inStr = !inStr;
                if (inStr) continue;
                if (c === '<') depthAngle++;
                if (c === '>') depthAngle--;
                if (depthAngle === 0 && (c === '{' || c === ';' || c === '=')) break;
            }
            const header = text.slice(i, j).trim();
            const c = text[j];
            if (c === '{') {
                i = j + 1;
                const child = body();
                const m = /^(?:([\w$]+)\s*:\s*)?(\S+)$/.exec(header) ?? [];
                child.label = m[1]; child.name = m[2] ?? header;
                node.children.push(child);
                while (i < text.length && /[\s;]/.test(text[i])) i++;
            } else if (c === '=') {
                let k = j + 1, a = 0, s = false;
                for (; k < text.length; k++) {
                    const ch = text[k];
                    if (ch === '"') s = !s;
                    if (s) continue;
                    if (ch === '<') a++;
                    if (ch === '>') a--;
                    if (a === 0 && ch === ';') break;
                }
                node.props[header] = text.slice(j + 1, k).trim();
                i = k + 1;
            } else {
                node.props[header] = true;
                i = j + 1;
            }
        }
    }
    return body();
}

const find = (node, pred) => {
    if (pred(node)) return node;
    for (const c of node.children) { const r = find(c, pred); if (r) return r; }
    return null;
};
const str = (v) => (typeof v === 'string' ? (/^"(.*)"$/s.exec(v)?.[1] ?? null) : null);
const cells = (v) => (typeof v === 'string' ? [...v.matchAll(/<([^>]*)>/g)].map((m) => m[1].trim()) : []);

// ------------------------------------------------------------- layout ---
export function parseLayout(src) {
    const root = parseDt(clean(src));
    const pl = find(root, (n) => str(n.props.compatible) === 'zmk,physical-layout');
    if (!pl) throw new Error('no zmk,physical-layout node');
    const num = (t) => Number(t.replace(/[()]/g, ''));
    const keys = cells(pl.props.keys).map((c) => {
        const t = c.split(/\s+/);
        if (t[0] !== '&key_physical_attrs' || t.length !== 8) throw new Error(`bad key attrs: ${c}`);
        const [w, h, x, y, r, rx, ry] = t.slice(1).map(num).map((v) => v / 100);
        return { x, y, w, h, r, rx, ry };
    });
    return { name: str(pl.props['display-name']) ?? 'TOTEM', keys };
}

export function generateLayout(src, source, firmwareSha = null) {
    const { name, keys } = parseLayout(src);
    const data = { source, firmwareSha, sha256: sha(src), name, keys };
    return `// GENERATED by gen-totem-default.mjs from ${source} (zmk,physical-layout) — do not edit.\n`
        + '// What Studio reports online: key units (centi-units / 100), rotation in degrees.\n'
        + '// Both the connected profile (zmk.js) and the offline sim read this one module.\n'
        + `export const TOTEM_LAYOUT = ${JSON.stringify(data, null, 1)};\n`
        + 'export const TOTEM_GEOM = TOTEM_LAYOUT.keys;\n'
        + 'export const TOTEM_POSITIONS = TOTEM_GEOM.length;\n';
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------- keymap ---
export function parseKeymap(src) {
    const defines = {};
    for (const m of src.matchAll(/^#define\s+(\w+)\s+(\S+)\s*$/gm)) defines[m[1]] = m[2];
    const root = parseDt(clean(src));
    const unsupported = new Set();

    // --- catalog: stock first (fixed order), then every custom node.
    const behaviors = [];
    const byLabel = {};
    const add = (label, displayName, metadata) => {
        const id = behaviors.length + 1;
        behaviors.push({ id, displayName, metadata, node: label });
        byLabel[label] = id;
    };
    for (const [label, [name, md]] of Object.entries(STOCK)) add(label, name, md);

    const typeOf = (ref) => {      // param descriptor a wrapped &ref contributes
        const r = ref?.replace(/^&/, '');
        if (['kp', 'sk', 'skm', 'kt', 'shift'].includes(r)) return usage;
        if (['mo', 'sl', 'tog', 'to', 'skl'].includes(r)) return layer;
        return () => [];
    };
    const customs = [];
    for (const top of root.children.flatMap((r) => r.children)) {   // children of `/`
        if (top.name === 'behaviors' || top.name === 'macros') customs.push(...top.children);
    }
    for (const n of customs) {
        const compat = str(n.props.compatible) ?? '';
        const wrapped = cells(n.props.bindings).join(' ').split('&').slice(1).map((t) => `&${t.trim().split(/\s+/)[0]}`);
        let md;
        switch (compat) {
            case 'zmk,behavior-hold-tap': case 'zmk,behavior-flask-hold-tap':
                md = meta(typeOf(wrapped[0])(), typeOf(wrapped[1])()); break;
            case 'zmk,behavior-sticky-key': md = meta(typeOf(wrapped[0])()); break;
            case 'zmk,behavior-auto-layer': md = meta(layer()); break;
            case 'zmk,behavior-flask-macros': md = meta(range('Macro slot', 0, FLASK_MACRO_SLOTS - 1)); break;
            case 'zmk,behavior-flask-tapdance': md = meta(range('Tap dance slot', 0, FLASK_TD_SLOTS - 1)); break;
            case 'zmk,behavior-flask-leader': md = meta(); break;
            case 'zmk,behavior-macro-one-param': md = meta(usage('Param')); break;
            case 'zmk,behavior-macro': case 'zmk,behavior-mod-morph': md = meta(); break;
            default: md = []; // third-party (adaptive-key, tri-state, switch-layout-*, leader-key): no metadata
        }
        add(n.label ?? n.name, str(n.props['display-name']) ?? '', md);
    }

    // --- argument resolution
    const modFn = /^([LR])([CSAG])\((.+)\)$/;
    function keyParam(tok) {
        const m = modFn.exec(tok);
        if (m) {
            const inner = keyParam(m[3]);
            if (inner == null) return null;
            return (inner | ((MODS[m[2]] << (m[1] === 'R' ? 4 : 0)) << 24)) >>> 0;
        }
        const k = KEYS[tok];
        if (!k) return null;
        return (((k[0] << 16) | k[1]) | ((k[2] ?? 0) << 24)) >>> 0;
    }
    function arg(tok) {
        let t = tok;
        for (let n = 0; n < 4 && t in defines; n++) t = defines[t];
        if (/^-?\d+$/.test(t)) return Number(t);
        if (t in SYMBOLS) return SYMBOLS[t];
        const k = keyParam(t);
        if (k == null) throw new Error(`unknown argument "${tok}"`);
        return k;
    }
    function binding(text, where) {
        const [ref, ...args] = text.trim().split(/\s+/);
        const id = byLabel[ref];
        if (!id) { unsupported.add(`&${ref} (${where})`); return [byLabel.trans, 0, 0]; }
        try {
            const [p1 = 0, p2 = 0] = args.map(arg);
            return [id, p1 >>> 0, p2 >>> 0];
        } catch (e) {
            unsupported.add(`&${ref} ${args.join(' ')} (${where}): ${e.message}`);
            return [byLabel.trans, 0, 0];
        }
    }
    const bindingList = (raw, where) => raw.replace(/[<>]/g, ' ').split('&').slice(1)
        .map((t) => binding(t, where));

    // --- layers
    const km = find(root, (n) => str(n.props.compatible) === 'zmk,keymap');
    if (!km) throw new Error('no zmk,keymap node');
    const layers = km.children.filter((c) => c.props.bindings).map((c) => ({
        name: str(c.props['display-name']) ?? c.name,
        bindings: bindingList(c.props.bindings, `layer ${c.name}`),
    }));
    if (!layers.length) throw new Error('no layers found in keymap');

    // --- combos (flask,combos-defaults): one behavior binding per slot.
    const cd = find(root, (n) => str(n.props.compatible) === 'flask,combos-defaults');
    const combos = (cd?.children ?? []).map((c) => {
        const [b] = bindingList(c.props.bindings, `combo ${c.name}`);
        const lay = c.props.layers ? arg(cells(c.props.layers)[0]) : null;
        const n = (p) => (c.props[p] ? Number(cells(c.props[p])[0]) : 0);
        return {
            name: c.name,
            positions: cells(c.props['key-positions'])[0].split(/\s+/).map(Number),
            behaviorId: b[0], param1: b[1], param2: b[2],
            timeoutMs: n('timeout-ms'), priorIdleMs: n('require-prior-idle-ms'),
            layer: lay,    // null = any layer
        };
    });

    return { behaviors, layers, combos, unsupported: [...unsupported].sort() };
}

export function generate(src, source, firmwareSha = null) {
    const { behaviors, layers, combos, unsupported } = parseKeymap(src);
    const data = { source, firmwareSha, sha256: sha(src), placeholder: false, behaviors, layers, combos, unsupported };
    return `// GENERATED by gen-totem-default.mjs from ${source} — do not edit.\n`
        + '// layers[].bindings: [behaviorId, param1, param2]; ids index `behaviors`.\n'
        + `export const TOTEM_DEFAULT = ${JSON.stringify(data)};\n`;
}

/** Full sha of `ref` in the firmware repo, or null when absent. */
export function firmwareSha(root = FIRMWARE_ROOT, ref = 'HEAD') {
    if (!existsSync(join(root, '.git'))) return null;
    try { return execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
}

/** A firmware file as committed at `sha` (not the working tree). */
export const readAt = (root, sha, rel) =>
    execFileSync('git', ['-C', root, 'show', `${sha}:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 26 });

/** Both generated files for one firmware commit. */
export function generateAt(root, sha) {
    return {
        layout: generateLayout(readAt(root, sha, REL_LAYOUT), REL_LAYOUT, sha),
        keymap: generate(readAt(root, sha, REL_KEYMAP), REL_KEYMAP, sha),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = process.argv[2] ?? FIRMWARE_ROOT;
    const at = firmwareSha(root, process.argv[3] ?? 'HEAD');
    if (!at) { console.error(`no git commit ${process.argv[3] ?? 'HEAD'} in ${root}`); process.exit(1); }
    const { layout, keymap } = generateAt(root, at);
    writeFileSync(OUT_LAYOUT, layout);
    writeFileSync(OUT_DEFAULT, keymap);
    const d = parseKeymap(readAt(root, at, REL_KEYMAP));
    console.log(`Totem-ZMK ${at.slice(0, 7)}: layout ${parseLayout(readAt(root, at, REL_LAYOUT)).keys.length} keys; keymap: ${d.layers.length} layers, `
        + `${d.behaviors.length} behaviors, ${d.combos.length} combos; unsupported: ${d.unsupported.length}`);
    if (d.unsupported.length) { console.error(d.unsupported.join('\n')); process.exit(2); }
}
