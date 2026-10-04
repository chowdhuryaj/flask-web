// Palette dock: firmware behaviors with parameters (layer holds, Mouse Layer,
// Neru Menu + Key) get tiles under Behaviours > Other, and search finds them.
// Names and kinds are the Totem's live behavior list (Totem-ZMK keymap-after.json).
import assert from 'node:assert/strict';
import { setZmkContext } from '../zmk-keycodes.js?v=78';
import { surfaceEntries } from '../binding-picker.js?v=78';
import { dockModel, searchTiles } from '../keymap-dock.js?v=78';
import { tapHoldSpecOf } from '../behavior-catalog.js?v=78';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m = '') => { assert.ok(c, m); checks++; };

const K = { l: 'layer_id', u: 'hid_usage', n: 'range' };
const set = (k) => (k ? [{ kind: K[k], name: k === 'n' ? 'Adaptive set' : 'x', min: 0, max: 7 }] : []);
const LIVE = [
    [4, 'Momentary Layer', 'l', null], [80, 'Super Delete', null, null], [57, 'Key Repeat', null, null], [93, 'Neru Menu', null, null],
    [85, 'Adaptive Key / Layer', 'l', 'n'], [86, 'Mouse Layer', 'l', 'l'], [87, 'Repeat / Layer', 'l', null],
    [88, 'Super Delete / Layer', 'l', null], [92, 'Neru Menu + Key (to base)', 'u', null], [94, 'Neru Menu + Key (stay)', 'u', null],
    [89, 'mouse_move', null, null], [90, 'mouse_scroll', null, null],
    [96, 'Mod / Neru Hints', 'u', null], [97, 'Mod / Neru Menu Key', 'u', 'u'], [98, 'Leader / Shift', 'u', null],
    [99, 'Mouse Layer-Tap', 'l', 'u'],
].map(([id, displayName, a, b]) => ({ id, displayName, metadata: [{ param1: set(a), param2: set(b) }] }));
const NAMES = ['base', 'control', 'nav'];
setZmkContext({ behaviors: new Map(LIVE.map((d) => [d.id, d])), layers: NAMES.map((name, id) => ({ id, name })) });

const model = dockModel(surfaceEntries('zmk.key', {}), []);
const other = model.behaviours.find((c) => c.label === 'Other').tiles;
const of = (name) => other.filter((t) => t.label.startsWith(name + ':'));
for (const n of ['Super Delete / Layer', 'Repeat / Layer', 'Adaptive Key / Layer', 'Mouse Layer']) eq(of(n).length, NAMES.length, `${n}: a tile per layer`);
eq(of('Super Delete / Layer')[2].binding, { behaviorId: 88, param1: 2, param2: 0 });
eq(of('Adaptive Key / Layer')[1].binding, { behaviorId: 85, param1: 1, param2: 0 }, 'adaptive set defaults to 0');
eq(of('Mouse Layer')[2].binding, { behaviorId: 86, param1: 2, param2: 2 }, 'both params are the layer');
eq(of('Super Delete / Layer')[1].label, 'Super Delete / Layer: control');

// Neru: its own category, one described tile per menu action (never "Neru A").
const neruTiles = model.behaviours.find((c) => c.label === 'Neru').tiles;
const nt = (id) => neruTiles.find((t) => t.id === id);
const U = (u) => 0x070000 | u;
eq(nt('adv:94:G').binding, { behaviorId: 94, param1: U(0x0A), param2: 0 }, 'grid = g');
eq(nt('adv:92:2').binding.param1, U(0x1F), 'double = 2');
eq([nt('adv:94:G').cap, nt('adv:94:G').sub], ['Grid', 'Neru']);
eq(nt('adv:94:R').label, 'Neru R-grid: recursive grid: narrow by 3×3 cells, then click, stays on this layer');
ok(nt('adv:92:R').label.endsWith('then back to Base'));
ok(!nt('adv:92:N') && !nt('adv:92:P') && !nt('adv:92:X') && !nt('adv:92:Z') && nt('adv:94:N'), 'instant actions: stay tile only');
eq(neruTiles.filter((t) => t.id.startsWith('adv:94:')).length, 14, 'every menu letter');
ok(!neruTiles.some((t) => / A$|Neru A\b/.test(t.cap + ' ' + t.label)), 'no "Neru A" placeholder');
ok(nt('adv:93') && nt('adv:91') === undefined, 'Neru Menu keeps its one tile');
// Mod / Neru: tap the action, hold one of four modifiers (param1 = mod key, param2 = letter).
eq(nt(`adv:97:G:${0xE2}`).binding, { behaviorId: 97, param1: U(0xE2), param2: U(0x0A) });
eq([nt(`adv:97:G:${0xE2}`).cap, nt(`adv:97:G:${0xE2}`).sub, nt(`adv:97:G:${0xE2}`).tone], ['Neru Grid', '⌥ Opt', 'hold']);
eq(neruTiles.filter((t) => t.id.startsWith('adv:97:')).length, 14 * 4);
eq(nt(`adv:96:${0xE0}`).binding, { behaviorId: 96, param1: U(0xE0), param2: 0 });
eq([nt(`adv:96:${0xE0}`).cap, nt(`adv:96:${0xE0}`).sub], ['Neru Hints', '⌃ Ctrl']);
// Leader / Shift: four modifier tiles under Other; Mouse Layer-Tap: a build(tap) tile per layer.
eq(other.filter((t) => t.id.startsWith('adv:98:')).map((t) => t.sub), ['⌃ Ctrl', '⇧ Shift', '⌥ Opt', '⌘ Cmd']);
const mlt = other.filter((t) => t.id.startsWith('adv:99:'));
eq(mlt.length, NAMES.length);
eq(mlt[2].binding, { behaviorId: 99, param1: 2, param2: U(0x04) }, 'default tap A');
eq(mlt[2].build({ key: 0x2C, mods: 0 }), { behaviorId: 99, param1: 2, param2: U(0x2C) }, 'takes the selected key');
ok(searchTiles(model, 'neru grid').some((t) => t.id === 'adv:94:G'), '"neru grid" finds it');
ok(searchTiles(model, 'bisect').length >= 2 + 4, '"bisect" finds every variant');

// Plain leftovers keep their one tile; nothing else is dropped or doubled.
eq(new Set([...other, ...neruTiles].map((t) => t.id)).size, other.length + neruTiles.length, 'tile ids are unique');

// Mouse move / scroll: Studio rejects raw &mmv/&msc params, so this older device (no mm_*/sc_* macros)
// gets the 12 contract tiles disabled, no param-0 tile, no raw-param tile.
eq(other.some((t) => t.id === 'adv:89' || t.id === 'adv:90' || t.id.startsWith('adv:89:') || t.id.startsWith('adv:90:')), false, 'no &mmv/&msc tiles');
const mm = other.filter((t) => t.id.startsWith('mm:'));
eq(mm.map((t) => t.cap), ['Mouse ↑', 'Mouse ↓', 'Mouse ←', 'Mouse →', 'Mouse ↖', 'Mouse ↗', 'Mouse ↙', 'Mouse ↘', 'Scroll ↑', 'Scroll ↓', 'Scroll ←', 'Scroll →']);
ok(mm.every((t) => t.disabled && t.binding === null && t.label.endsWith('needs firmware with mouse macros (mm_*/sc_*)')), 'disabled with the hint');
ok(searchTiles(model, 'mouse left').some((t) => t.id === 'mm:mm_left'), '"mouse left" finds it');
ok(searchTiles(model, 'scroll up').some((t) => t.id === 'mm:sc_up'), '"scroll up" finds it');

// Firmware with the macros: each tile resolves to the macro's id (by display-name, else node name), p1 = p2 = 0.
{
    const { MOUSE_MACROS } = await import('../behavior-catalog.js?v=78');
    const macros = MOUSE_MACROS.map((m, i) => ({ id: 120 + i, displayName: i === 11 ? m.node : m.name, metadata: [{ param1: [], param2: [] }] }));
    setZmkContext({ behaviors: new Map([...LIVE, ...macros].map((d) => [d.id, d])), layers: NAMES.map((name, id) => ({ id, name })) });
    const m2 = dockModel(surfaceEntries('zmk.key', {}), []);
    const tiles = m2.behaviours.find((c) => c.label === 'Other').tiles.filter((t) => t.id.startsWith('mm:'));
    eq(tiles.map((t) => [t.cap, t.binding]), MOUSE_MACROS.map((m, i) => [m.name, { behaviorId: 120 + i, param1: 0, param2: 0 }]),
        'tile -> macro id, no params (sc_right found by node name)');
    ok(tiles.every((t) => !t.disabled), 'enabled');
    ok(!m2.behaviours.flatMap((c) => c.tiles).some((t) => /^adv:12\d|^adv:13[01]/.test(t.id)), 'macros are not doubled as plain Other tiles');
    // Guard: no tile (nor its build()) writes a pointing behaviour (&mmv/&msc) with a param, here or on the pinned default.
    const POINT = /^(mouse_move|mouse_scroll|Mouse Move|Mouse Scroll)$/;
    const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=78');
    for (const ctx of [[...LIVE, ...macros], LIVE, TOTEM_DEFAULT.behaviors]) {
        const bmap = new Map(ctx.map((d) => [d.id, d]));
        setZmkContext({ behaviors: bmap, layers: NAMES.map((name, id) => ({ id, name })) });
        const mod = dockModel(surfaceEntries('zmk.key', {}), []);
        for (const t of [...mod.pinned, ...mod.behaviours.flatMap((c) => c.tiles)]) {
            for (const b of [t.binding, t.build?.(), t.build?.({ key: 0x2C, mods: 0 })].filter(Boolean)) {
                ok(!(POINT.test(bmap.get(b.behaviorId)?.displayName ?? '') && ((b.param1 >>> 0) || (b.param2 >>> 0))), `${t.id} writes &mmv/&msc with a param`);
            }
        }
    }
    setZmkContext({ behaviors: new Map(LIVE.map((d) => [d.id, d])), layers: NAMES.map((name, id) => ({ id, name })) });
}
// Grep guard: the app sources no longer pack pointing.h params (x << 16 | y) for a write; only the legend decodes them
// and the export prints them.
{
    const { readdirSync, readFileSync } = await import('node:fs');
    const root = new URL('../', import.meta.url);
    for (const f of readdirSync(root).filter((n) => /\.js$/.test(n) && !['behavior-catalog.js', 'zmk-dt-export.js', 'zmk-totem-default.js'].includes(n))) {
        const src = readFileSync(new URL(f, root), 'utf8');
        ok(!/MOVE_VAL|SCRL_VAL|val:\s*1800|mouse_move\s*:\s*\{/.test(src), `${f} builds raw &mmv/&msc params`);
    }
}

// Search.
eq(searchTiles(model, 'super delete').filter((t) => t.id.startsWith('adv:88:')).length, NAMES.length, '"super delete" finds the layered tiles');
ok(searchTiles(model, 'super delete / layer: nav').some((t) => t.id === 'adv:88:2'));
ok(searchTiles(model, 'mouse layer').length >= NAMES.length);
ok(searchTiles(model, 'advanced').length >= other.length, 'advanced / other reach every tile');

console.log(`dock-params-test: ${checks} checks OK`);
