// Svalboard keymap stack (Phase B): the 'qmk' adapter's encode/decode over
// every u16 and per QMK range, legends for MT / LT / MO / M n / TD(n) /
// customs, the static layout (regenerates byte-for-byte from vial.json, the
// five-key hide, key names), the qmk.* picker surfaces, the keymap tab's
// adapter (Vial setKeycode), and the Totem render hashes taken before the
// QMK work (the ZMK paths must not move).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), key: () => null, length: 0 };

const cat = await import('../behavior-catalog.js?v=79');
const { legendOf } = await import('../legend.js?v=79');
const { R, describe, capLabel } = await import('../keycodes.js?v=79');
const { SURFACES, surfaceEntries } = await import('../binding-picker.js?v=79');
const { dockModel } = await import('../keymap-dock.js?v=79');
const { inspectorModel } = await import('../keymap-inspector.js?v=79');
const { svalboardKeys, qmkProfile, keyName, keySurfaceOf, svalboardLayerNames } = await import('../boards.js?v=79');
const { SVALBOARD_LAYOUT } = await import('../svalboard-layout.js?v=79');
const { totemRenderHashes } = await import('./totem-render-snapshot.mjs');

// ---- 1. encode(decode(kc)) === kc for every u16 ----
let bad = [];
for (let kc = 0; kc <= 0xFFFF; kc++) {
    const d = cat.decode(kc, 'qmk');
    let back;
    try { back = cat.encode(d.entryId, d.params, 'qmk'); } catch (e) { back = e.message; }
    if (back !== kc) bad.push(kc);
}
eq(bad.slice(0, 5), [], `round trip fails for ${bad.length} keycodes`);
ok(cat.adapterOf(0x2217) === 'qmk', 'a number is a QMK keycode');

// ---- 2. each range decodes to its entry ----
const D = (kc) => cat.decode(kc, 'qmk');
const RANGES = [
    [0x0000, 'none', {}], [0x0001, 'trans', {}],
    [0x0004, 'key', { key: 0x04, mods: 0 }], [0x00E1, 'key', { key: 0xE1, mods: 0 }],
    [0x00A9, 'media-key', { code: 0xA9 }], [0x00D1, 'mouse-key', { code: 0xD1 }],
    [0x022B, 'key', { key: 0x2B, mods: 0x02 }], [0x1104, 'key', { key: 0x04, mods: 0x10 }],     // S(Tab), RCTL(A)
    [0x2217, 'mod-tap', { hold: 0x02, tap: 0x17 }], [0x3204, 'mod-tap', { hold: 0x20, tap: 0x04 }],   // LSFT_T(T), RSFT_T(A)
    [0x4115, 'layer-tap', { layer: 1, tap: 0x15 }], [0x4F04, 'layer-tap', { layer: 15, tap: 0x04 }],
    [R.toBase + 3, 'to-layer', { layer: 3 }], [R.momentaryBase + 1, 'hold-layer', { layer: 1 }],
    [R.defLayerBase + 2, 'default-layer', { layer: 2 }], [R.toggleLayerBase + 31, 'toggle-layer', { layer: 31 }],
    [R.oneShotLayerBase + 4, 'one-shot-layer', { layer: 4 }], [R.oneShotModBase + 0x02, 'one-shot-mod', { mods: 0x02 }],
    [R.layerTapToggleBase + 5, 'tap-toggle', { layer: 5 }],
    [0x5700, 'tap-dance', { slot: 0 }], [0x57FF, 'tap-dance', { slot: 255 }],
    [0x7700, 'macro', { slot: 0 }], [0x777F, 'macro', { slot: 127 }],
    [0x7C00, 'bootloader', {}], [0x7C01, 'reset', {}], [0x7C16, 'grave-escape', {}], [0x7C58, 'leader', {}],
    [0x7C73, 'caps-word', {}], [0x7C79, 'repeat', {}], [0x7C7A, 'alt-repeat', {}], [0x7C7B, 'layer-lock', {}],
    [0x7820, 'lighting', { code: 0x7820 }], [0x7E00, 'device-key', { code: 0x7E00 }], [0x7E3F, 'device-key', { code: 0x7E3F }],
];
for (const [kc, id, params] of RANGES) eq(D(kc), { entryId: id, params }, `0x${kc.toString(16)} → ${id}`);
for (const kc of [0x0100, 0x1004, 0x2004, 0x5000, 0x52A0, 0x52E0, 0x5600, 0x7C02, 0xFFFF]) {
    eq(D(kc), { entryId: 'advanced', params: { raw: kc, adapter: 'qmk' } }, `0x${kc.toString(16)} is raw`);
}

// ---- 3. legends: MT / LT in the hold-tap tokens, MC / TD / custom ----
cat.setQmkLayerNames(svalboardLayerNames(16));
const L = (kc) => { const l = legendOf(kc, 'qmk'); return [l.main, l.sub, l.kind, l.subKind]; };
eq(L(0x2217), ['T', '⇧', 'hold', 'hold'], 'MT(LSFT, T)');
eq(L(0x3204), ['A', 'R⇧', 'hold', 'hold'], 'MT(RSFT, A)');
eq(L(0x4115), ['R', 'NavNas', 'hold', 'layer'], 'LT(1, R) shows the layer name');
eq(L(R.momentaryBase + 2), ['Func', 'mo', 'layer', 'dim'], 'MO(2)');
eq(L(R.layerTapToggleBase + 1), ['NavNas', 'tt', 'layer', 'dim'], 'TT(1)');
eq(L(0x7703), ['M3', 'macro', 'macro', 'dim'], 'MC_3 / M3');
eq(L(0x5702), ['TD2', 'tap dance', 'macro', 'dim'], 'TD(2)');
eq(L(0x7C58), ['Leader', '', 'macro', 'dim'], 'Leader');
eq(L(0x7E00), ['Left DPI +', '', 'plain', 'dim'], 'custom 0: SV_LEFT_DPI_INC');
eq(L(0x0001), ['▽', '', 'dim', ''], 'KC_TRNS');
eq(L(0x0000), ['✕', '', 'dim', ''], 'KC_NO');
eq(L(0x00E1), ['L⇧', '', 'mod', ''], 'a modifier key');
eq(L(0x021E), ['!', '', 'plain', ''], 'S(1) reads !');
eq(describe(0x2217), 'MT(⇧, T)');
eq(capLabel(0x5000), '5000', 'unknown keycodes show hex');
eq(cat.describeBinding(0x5000, 'qmk'), '0x5000');
eq(SVALBOARD_LAYOUT.customKeycodes.length, 64, '64 Svalboard custom keycodes');
for (const c of SVALBOARD_LAYOUT.customKeycodes) eq(D(R.kbBase + c.index).entryId, 'device-key', c.name);

// ---- 4. layout: regenerates from vial.json, five-key hide, names ----
const { VIAL_JSON, OUT, buildLayout, renderModule } = await import('../gen-svalboard-layout.mjs');
if (existsSync(VIAL_JSON)) {
    eq(renderModule(buildLayout(readFileSync(VIAL_JSON, 'utf8'))), readFileSync(OUT, 'utf8'),
        'svalboard-layout.js is stale: node gen-svalboard-layout.mjs');
} else console.log('qmk-keymap-test: NOTE no vial.json at', VIAL_JSON, '(regeneration check skipped)');
const all = svalboardKeys(false), five = svalboardKeys(true);
eq(all.length, 60);
eq(new Set(all.map((k) => `${k.row},${k.col}`)).size, 60, 'no duplicate matrix cells');
eq(five.length, 52, 'five-key: 8 finger Double South keys hidden');
ok(!five.some((k) => k.col === 5 && k.row !== 0 && k.row !== 5), 'no finger column 5 on a five-key board');
ok(five.some((k) => k.row === 0 && k.col === 5) && five.some((k) => k.row === 5 && k.col === 5), 'thumbs keep Double Down');
eq(qmkProfile('svalboard', 16, { fiveKey: true }).keys.length, 52, 'qmkProfile reads app.board.fiveKey');
eq(qmkProfile('svalboard', 16).keys.length, 60);
const prof = qmkProfile('svalboard', 16, { fiveKey: true });
eq(keyName(prof, 0, 3), 'Left thumb · Pad', 'unlock dialog name');
eq(keyName(prof, 1, 5), 'Left index · Double South', 'a hidden key keeps its name');
eq(keyName(prof, 7, 2), 'Right middle · Centre');
eq(prof.layerNames.slice(0, 3).concat(prof.layerNames.slice(14)), ['Normal', 'NavNas', 'Func', 'Board config', 'Mouse buttons']);
eq(prof.capAdapter, 'qmk');

// ---- 5. picker surfaces and the dock ----
const app = { family: 'svalboard', layerCount: 16, macroCount: 4, tapDanceCount: 8, profile: qmkProfile('svalboard', 16) };
eq(keySurfaceOf(app), 'qmk.key');
eq(keySurfaceOf({ family: 'totem' }), 'zmk.key');
for (const s of ['qmk.key', 'qmk.comboOutput', 'qmk.tapDanceStep', 'qmk.keyOverride', 'qmk.cornerChord', 'qmk.macroKey',
    'qmk.leaderKey', 'qmk.cskBase', 'qmk.cskShifted']) eq(SURFACES[s]?.adapter, 'qmk', s);
const keyIds = surfaceEntries('qmk.key', app).map((e) => e.id);
for (const id of ['key', 'trans', 'mod-tap', 'layer-tap', 'hold-layer', 'tap-toggle', 'macro', 'tap-dance', 'device-key', 'leader', 'advanced']) ok(keyIds.includes(id), `qmk.key has ${id}`);
ok(!keyIds.includes('smart-layer') && !keyIds.includes('bluetooth'), 'no ZMK-only entries on QMK');
eq(surfaceEntries('qmk.macroKey', app).map((e) => e.id), ['key', 'none'], 'macro steps: plain keys');
ok(!surfaceEntries('qmk.cornerChord', app).some((e) => e.id === 'leader'), 'chords cannot fire Leader');
eq(surfaceEntries('qmk.key', app).find((e) => e.id === 'macro').params[0].max, 3, 'M0..M3 from app.macroCount');
const lt = surfaceEntries('qmk.key', app).find((e) => e.id === 'layer-tap').params.find((p) => p.kind === 'layer');
eq([lt.options.length, lt.labels[1]], [16, 'NavNas'], 'LT layers named, 4-bit');
const dm = dockModel(surfaceEntries('qmk.key', app), cat.keySections(), 'qmk');
eq(dm.behaviours.find((c) => c.label === 'Device keys').tiles.length, 64, 'dock: a tile per custom keycode');
eq(dm.behaviours.find((c) => c.label === 'Macros & run').tiles.filter((t) => t.id.startsWith('macro:')).map((t) => t.binding), [0x7700, 0x7701, 0x7702, 0x7703]);
ok(dm.behaviours.find((c) => c.label === 'Layers').tiles.some((t) => t.binding === 0x4100 + 0x04), 'dock: LT(1, A) tile');

// ---- 6. tap-hold on QMK: MT / LT only ----
eq(cat.composeTapHold({ tap: { key: 0x17 }, hold: { kind: 'mods', mods: 0x02 } }, 'qmk').value, 0x2217);
eq(cat.composeTapHold({ tap: { key: 0x15 }, hold: { kind: 'layer', layer: 1 } }, 'qmk').value, 0x4115);
eq(cat.composeTapHold({ tap: { key: 0x04 }, hold: { kind: 'key', key: 0x05 } }, 'qmk').fallback, 'tap-dance', 'a held key needs a tap dance');
eq(cat.composeTapHold({ tap: { key: 0x04 }, hold: { kind: 'layer', layer: 16 } }, 'qmk').ok, false, 'LT reaches 0-15');
eq(cat.composeTapHold({ tap: { key: 0x04 }, hold: { kind: 'mods', mods: 0x21 } }, 'qmk').ok, false, 'MT: one side');
eq(inspectorModel(0x4115, 'qmk').kind, 'layer');
eq(cat.homeRowPlan([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ pos: i, x: i, binding: 0x04 + i })), 'GACS', 'qmk').plan.sort((x, y) => x.pos - y.pos).map((p) => p.value),
    [0x2804, 0x2405, 0x2106, 0x2207, 0x3208, 0x3109, 0x340A, 0x380B], 'home-row mods on QMK: GACS, right side mirrored');

// ---- 7. keymap tab adapter: Vial setKeycode, positions, names ----
const { QmkKeymapTab } = await import('../qmk-keymap-tab.js?v=79');
const writes = [];
const tapp = { ...app, layerCount: 2, vial: { setKeycode: async (...a) => { writes.push(a); } },
    keymap: [Array.from({ length: 10 }, () => Array(6).fill(0x0004)), Array.from({ length: 10 }, () => Array(6).fill(0x0001))] };
const tab = Object.create(QmkKeymapTab.prototype);
Object.assign(tab, { app: tapp, state: 'ready', _vial: tapp.vial });
tab.adapter = tab._makeAdapter();
const a = tab.adapter;
eq(a.surface, 'qmk.key');
eq(a.layers().map((l) => [l.name, l.empty]), [['Normal', false], ['NavNas', true]]);
const pos = a.posOf({ kind: 'key', row: 1, col: 2 });
eq(a.selOf(pos), { kind: 'key', row: 1, col: 2 }, 'pos ↔ sel');
eq(a.keyTitle(pos), 'Left index · Centre');
ok(a.validBinding(0x2217) && !a.validBinding({ behaviorId: 1 }) && !a.validBinding(0x10000), 'only u16 keycodes drop');
await a.write(0, { kind: 'key', row: 1, col: 2 }, 0x2217).catch(() => {});   // the toast needs a DOM; the write lands first
eq(writes, [[0, 1, 2, 0x2217]], 'Vial setKeycode(layer, row, col, kc)');
eq(tapp.keymap[0][1][2], 0x2217, 'app.keymap (HUD) follows the write');
eq(a.readOnly, false);
ok(!a.layerOps, 'no layer add / remove on Vial');

// ---- 8. ZMK (Totem) render unchanged ----
const want = JSON.parse(readFileSync(new URL('./fixtures/totem-render.json', import.meta.url), 'utf8'));
const got = totemRenderHashes();
for (const [k, h] of Object.entries(want)) eq(got[k], h, `Totem render changed: ${k}`);

console.log(`qmk-keymap-test: ${checks} checks OK`);
