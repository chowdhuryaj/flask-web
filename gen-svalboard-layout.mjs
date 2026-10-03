// Generates svalboard-layout.js (the Svalboard's static key geometry, key
// names and Vial custom keycodes) from the firmware's vial.json, so the
// board is never hand-drawn and the app needs no XZ decoder:
//   node gen-svalboard-layout.mjs [path/to/vial.json]
// Geometry is the KLE walk Vial itself does (b2e1680 vialdef.js parseKLE,
// hard-won rules kept). The file's sha256 is recorded; qmk-keymap-test.mjs
// regenerates from the same vial.json and fails if the output differs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const VIAL_JSON = join(homedir(), 'dev/Input/Flask-Svalboard/svalboard-vial-qmk/keyboards/svalboard/keymaps/flask/vial.json');
const REL = 'svalboard-vial-qmk/keyboards/svalboard/keymaps/flask/vial.json';
export const OUT = join(dirname(fileURLToPath(import.meta.url)), 'svalboard-layout.js');

/**
 * Minimal KLE walk: rows of items; a string is a key whose FIRST legend line
 * is "row,col", a dict adjusts position/size (and the decal flag) for the
 * NEXT key. Rules from the Swift app, hardware-debugged:
 * - the legend split keeps empty lines: the layout-option decal "\n\n\n1,0"
 *   must NOT collapse to "1,0" (that minted a phantom key at matrix 1,0).
 * - d:true is a decal, never a key.
 * - legend line 9 === 'e' is an encoder cap, not a matrix key.
 */
export function parseKLE(rows) {
    const keys = [];
    let y = 0;
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        let x = 0, w = 1, h = 1, decal = false;
        for (const item of row) {
            if (typeof item === 'object' && item !== null) {
                if (typeof item.x === 'number') x += item.x;
                if (typeof item.y === 'number') y += item.y;
                if (typeof item.w === 'number') w = item.w;
                if (typeof item.h === 'number') h = item.h;
                if (typeof item.d === 'boolean') decal = item.d;
                continue;
            }
            if (typeof item !== 'string') continue;
            const lines = item.split('\n');
            const parts = (lines[0] || '').split(',');
            const encoder = lines.length > 9 && lines[9] === 'e';
            if (!decal && !encoder && parts.length === 2) {
                const r = parseInt(parts[0], 10), c = parseInt(parts[1], 10);
                if (Number.isInteger(r) && Number.isInteger(c)) keys.push({ row: r, col: c, x, y, w, h });
            }
            x += w;
            w = 1; h = 1; decal = false;
        }
        y += 1;
    }
    return keys;
}

// Matrix meaning (keyboards/svalboard/config.h, info.json labels): rows 1-4
// left index..pinky, 6-9 right index..pinky, 0 / 5 the thumbs.
const CLUSTER = { 0: ['Left thumb', 'lt'], 1: ['Left index', 'l1'], 2: ['Left middle', 'l2'], 3: ['Left ring', 'l3'], 4: ['Left pinky', 'l4'],
    5: ['Right thumb', 'rt'], 6: ['Right index', 'r1'], 7: ['Right middle', 'r2'], 8: ['Right ring', 'r3'], 9: ['Right pinky', 'r4'] };
const FINGER = [['South', 's'], ['East', 'e'], ['Centre', 'c'], ['North', 'n'], ['West', 'w'], ['Double South', 'ss']];
const THUMB = [['Knuckle', 'lo'], ['Nail', 'uo'], ['Down', 'd'], ['Pad', 'i'], ['Up', 'u'], ['Double Down', 'dd']];
// Board order (auto-advance, pos): left pinky to index, the thumbs, right
// index to pinky; inside a cluster centre first (gen_keymap.py order).
const ROW_ORDER = [4, 3, 2, 1, 0, 5, 6, 7, 8, 9];
const COL_ORDER = { finger: [2, 3, 1, 0, 4, 5], thumb: [2, 3, 4, 1, 0, 5] };
const isThumb = (row) => row === 0 || row === 5;

export function buildLayout(text) {
    const def = JSON.parse(text);
    const keys = parseKLE(def.layouts.keymap).map((k) => {
        const [cname, cshort] = CLUSTER[k.row];
        const [dname, dshort] = (isThumb(k.row) ? THUMB : FINGER)[k.col];
        return { ...k, label: `${cname} · ${dname}`, short: `${cshort}${dshort}` };
    });
    const rank = (k) => ROW_ORDER.indexOf(k.row) * 8 + COL_ORDER[isThumb(k.row) ? 'thumb' : 'finger'].indexOf(k.col);
    keys.sort((a, b) => rank(a) - rank(b));
    const minX = Math.min(...keys.map((k) => k.x)), minY = Math.min(...keys.map((k) => k.y));
    for (const k of keys) { k.x = +(k.x - minX).toFixed(4); k.y = +(k.y - minY).toFixed(4); }
    return {
        source: REL,
        sha256: createHash('sha256').update(text).digest('hex'),
        name: def.name,
        vendorId: def.vendorId, productId: def.productId,
        matrix: def.matrix,
        keys,
        customKeycodes: (def.customKeycodes ?? []).map((c, index) => ({
            index, name: c.name, short: String(c.shortName ?? c.name).replace(/\s*\n\s*/g, ' '), title: c.title ?? '',
        })),
    };
}

export function renderModule(layout) {
    const line = (o) => `  ${JSON.stringify(o)}`;
    const { keys, customKeycodes, ...head } = layout;
    const headJson = JSON.stringify(head, null, 1).slice(0, -2);   // drop the closing brace
    return `// GENERATED by gen-svalboard-layout.mjs from ${REL} — do not edit.
// Static Svalboard geometry (key units, Vial's KLE walk), key names, and the
// Vial custom keycodes (QK_KB_0 + index). Regenerate when vial.json changes.
export const SVALBOARD_LAYOUT = ${headJson},
 "keys": [
${keys.map(line).join(',\n')}
 ],
 "customKeycodes": [
${customKeycodes.map(line).join(',\n')}
 ]
};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const src = process.argv[2] ?? VIAL_JSON;
    if (!existsSync(src)) { console.error(`no vial.json at ${src}`); process.exit(1); }
    const layout = buildLayout(readFileSync(src, 'utf8'));
    writeFileSync(OUT, renderModule(layout));
    console.log(`wrote ${OUT}: ${layout.keys.length} keys, ${layout.customKeycodes.length} custom keycodes, vial.json sha256 ${layout.sha256.slice(0, 12)}`);
}
