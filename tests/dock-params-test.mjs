// Palette dock: firmware behaviors with parameters (layer holds, Mouse Layer,
// Neru Menu + Key) get tiles under Behaviours > Other, and search finds them.
// Names and kinds are the Totem's live behavior list (Totem-ZMK keymap-after.json).
import assert from 'node:assert/strict';
import { setZmkContext } from '../zmk-keycodes.js?v=69';
import { surfaceEntries } from '../binding-picker.js?v=69';
import { dockModel, searchTiles } from '../keymap-dock.js?v=69';
import { tapHoldSpecOf } from '../behavior-catalog.js?v=69';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m = '') => { assert.ok(c, m); checks++; };

const K = { l: 'layer_id', u: 'hid_usage', n: 'range' };
const set = (k) => (k ? [{ kind: K[k], name: k === 'n' ? 'Adaptive set' : 'x', min: 0, max: 7 }] : []);
const LIVE = [
    [4, 'Momentary Layer', 'l', null], [80, 'Super Delete', null, null], [57, 'Key Repeat', null, null], [93, 'Neru Menu', null, null],
    [85, 'Adaptive Key / Layer', 'l', 'n'], [86, 'Mouse Layer', 'l', 'l'], [87, 'Repeat / Layer', 'l', null],
    [88, 'Super Delete / Layer', 'l', null], [92, 'Neru Menu + Key (to base)', 'u', null], [94, 'Neru Menu + Key (stay)', 'u', null],
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

// Neru + Key: a build(tap) tile, default key A, usage page 7.
const neru = other.filter((t) => t.build);
eq(neru.map((t) => t.label.split(':')[0]), ['Neru Menu + Key (to base)', 'Neru Menu + Key (stay)']);
eq(neru[0].binding, { behaviorId: 92, param2: 0, param1: 0x070004 });
eq(neru[1].build({ key: 0x09, mods: 0x02 }).param1, 0x02070009 >>> 0, 'takes the selected key and its mods');
eq(tapHoldSpecOf(neru[0].binding, 'zmk-studio'), null);

// Plain leftovers keep their one tile; nothing else is dropped or doubled.
ok(other.some((t) => t.id === 'adv:93'), 'Neru Menu keeps its one tile');
eq(new Set(other.map((t) => t.id)).size, other.length, 'tile ids are unique');

// Search.
eq(searchTiles(model, 'super delete').filter((t) => t.id.startsWith('adv:88:')).length, NAMES.length, '"super delete" finds the layered tiles');
ok(searchTiles(model, 'super delete / layer: nav').some((t) => t.id === 'adv:88:2'));
ok(searchTiles(model, 'mouse layer').length >= NAMES.length);
ok(searchTiles(model, 'neru menu + key').length === 2);
ok(searchTiles(model, 'advanced').length >= other.length, 'advanced / other reach every tile');

console.log(`dock-params-test: ${checks} checks OK`);
