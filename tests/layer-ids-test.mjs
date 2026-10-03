// Layer labels: binding params carry layer IDs (stable), the rail / HUD /
// combo dropdown number layers by INDEX. After a reorder (Studio move_layer,
// CONFIG_ZMK_KEYMAP_LAYER_REORDERING) the two differ, and every view must still
// name the same layer. Also guards the Totem default (fn = 2, sym = 3).
import assert from 'node:assert/strict';

const node = () => ({ setAttribute() {}, addEventListener() {}, append() {}, remove() {} });
globalThis.document = { createElement: node, createTextNode: (t) => ({ t }), querySelector: () => null, body: { append() {} } };
const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=65');
const { setZmkContext, bindingCap, layerName } = await import('../zmk-keycodes.js?v=65');
const { encode, decode, capParts } = await import('../behavior-catalog.js?v=65');
const { surfaceEntries } = await import('../binding-picker.js?v=65');
const { ZmkKeymapTab } = await import('../zmk-keymap-tab.js?v=65');

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const behaviors = new Map(TOTEM_DEFAULT.behaviors.map((d) => [d.id, d]));
const idOf = (n) => TOTEM_DEFAULT.behaviors.find((d) => d.displayName === n).id;
const MO = idOf('Momentary Layer');
const mo = (layerId) => ({ behaviorId: MO, param1: layerId, param2: 0 });

// 1. Totem default: index == id, fn = 2, sym = 3 (a swap fails here).
const names = TOTEM_DEFAULT.layers.map((l) => l.name);
eq(names.slice(0, 5), ['base', 'control', 'fn', 'sym', 'num']);
setZmkContext({ behaviors, layers: names.map((name, id) => ({ id, name })) });
eq([bindingCap(mo(2)), bindingCap(mo(3))].map((s) => s.replace(/^\S+ /, '')), ['fn', 'sym'], 'mo legend by id, default order');
const combo = (n) => TOTEM_DEFAULT.combos.find((c) => c.name === n);
eq([combo('z'), combo('x'), combo('sym')].map((c) => layerName(c.param1)), ['control', 'fn', 'sym'],
    'firmware combos 32+33 / 33+34 / 35+36 name control / fn / sym');

// 2. Reordered device: index order base, control, sym(id 3), fn(id 2), num.
const reordered = (nm) => [
    { id: 0, name: nm.base }, { id: 1, name: nm.control }, { id: 3, name: nm.sym }, { id: 2, name: nm.fn }, { id: 4, name: nm.num },
];
const named = { base: 'base', control: 'control', fn: 'fn', sym: 'sym', num: 'num' };
const unnamed = { base: '', control: '', fn: '', sym: '', num: '' };

setZmkContext({ behaviors, layers: reordered(named) });
eq([layerName(2), layerName(3)], ['fn', 'sym'], 'named: params resolve by id, not index');

// Unnamed layers (firmware without display-name): the label number is the
// INDEX, the same one the rail and HUD show. id 2 now sits at index 3.
setZmkContext({ behaviors, layers: reordered(unnamed) });
eq([layerName(2), layerName(3)], ['Layer 3', 'Layer 2'], 'unnamed legend uses the index');
eq(capParts(mo(2)).main, 'Layer 3', 'keycap legend for &mo id 2');
const layerParam = surfaceEntries('zmk.key', {}).find((e) => e.id === 'layer-tap').params.find((p) => p.kind === 'layer');
eq(layerParam.options, [0, 1, 3, 2, 4], 'picker offers ids in index order');
eq(layerParam.labels, { 0: 'Layer 0', 1: 'Layer 1', 3: 'Layer 2', 2: 'Layer 3', 4: 'Layer 4' }, 'picker labels match the rail numbers');

// 3. Writing a layer param from a picker writes the ID.
eq(encode('hold-layer', { layer: 2 }, 'zmk-studio').param1, 2, 'encode keeps the id');
eq(decode(mo(3), 'zmk-studio').params.layer, 3, 'decode returns the id');

// 4. HUD strip: names by index; the firmware's active-layer value is an index.
for (const [nm, want] of [[named, ['base', 'control', 'sym', 'fn', 'num']], [unnamed, ['Layer 0', 'Layer 1', 'Layer 2', 'Layer 3', 'Layer 4']]]) {
    const t = Object.create(ZmkKeymapTab.prototype);
    t.app = { profile: {} };
    t.geomKeys = [];
    t.keymap = { layers: reordered(nm).map((l) => ({ ...l, bindings: [] })) };
    t._publishToApp();
    eq(t.app.profile.layerNames, want, 'HUD layerNames in index order');
    eq(t.app.layerCount, 5);
}
// Holding fn (id 2) makes the firmware report its index (3); the HUD must show fn.
{
    const t = Object.create(ZmkKeymapTab.prototype);
    t.app = { profile: {} };
    t.geomKeys = [];
    t.keymap = { layers: reordered(named).map((l) => ({ ...l, bindings: [] })) };
    t._publishToApp();
    eq(t.app.profile.layerNames[3], 'fn', 'active-layer index 3 is fn after the swap');
}

console.log(`layer-ids-test: ${checks} checks OK`);
