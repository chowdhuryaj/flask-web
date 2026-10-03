// Unplugged: a workspace seeded from a (fake) device keymap serves that keymap
// through the Studio sim, resolves device-only behaviors, queues a diff-only
// pendingKeymap on save, and is never reseeded over unsynced edits.
import assert from 'node:assert/strict';
import { loadWorkspace } from '../offline.js?v=69';
import { seedWorkspaceFromDevice, seedWorkspaceFromSnapshot, zmkSyncExtras, createZmkTemplate,
         OfflineStudioClient } from '../zmk-offline.js?v=69';

const mem = new Map();
globalThis.localStorage ??= {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
};

let checks = 0;
const N = 38;
// Device ids differ from the sim catalog on purpose: 7 = Key Press, 9 = Transparent, 50 = unknown.
const behaviors = new Map([
    [7, { id: 7, displayName: 'Key Press', metadata: [{ param1: [{ name: 'Key', kind: 'hid_usage' }], param2: [] }] }],
    [9, { id: 9, displayName: 'Transparent', metadata: [{ param1: [], param2: [] }] }],
    [50, { id: 50, displayName: 'Weird Thing', metadata: [{ param1: [{ name: 'Key', kind: 'hid_usage' }], param2: [] }] }],
]);
const row = (id, p1 = 0) => Array.from({ length: N }, () => ({ behaviorId: id, param1: p1, param2: 0 }));
const layers = [{ id: 0, name: 'mine', bindings: row(7, 458756) }, { id: 1, name: 'extra', bindings: row(9) }];
layers[1].bindings[5] = { behaviorId: 50, param1: 458760, param2: 0 };

let ws = seedWorkspaceFromDevice('totem', { layers, behaviors, availableLayers: 3, deviceName: 'TOTEM' });
assert.equal(ws.source, 'device'); assert.equal(ws.label, 'Totem (unplugged)'); checks += 2;
const stored = loadWorkspace('totem');
const c = new OfflineStudioClient(stored);
const km = await c.getKeymap();
assert.equal(km.layers.length, 2); assert.equal(km.layers[0].name, 'mine'); assert.equal(km.availableLayers, 3); checks += 3;
const keyId = km.layers[0].bindings[0].behaviorId;
assert.equal((await c.getBehaviorDetails(keyId)).displayName, 'Key Press'); checks++;
assert.equal(km.layers[0].bindings[0].param1, 458756); checks++;
const weirdId = km.layers[1].bindings[5].behaviorId;
const weird = await c.getBehaviorDetails(weirdId);
assert.equal(weird.displayName, 'Weird Thing'); assert.ok((await c.listAllBehaviors()).includes(weirdId)); checks += 2;

// Real firmware refuses behaviors with no get_parameter_metadata (-ENODEV); the sim mirrors it.
{
    const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=69');
    const sw = TOTEM_DEFAULT.behaviors.find((b) => b.node === 'sw_layout');
    await assert.rejects(c.setLayerBinding(0, 3, { behaviorId: sw.id, param1: 0, param2: 0 }), /INVALID_PARAMETERS/); checks++;
}

// Edit + save: only the changed key is queued, by display name.
await c.setLayerBinding(0, 3, { behaviorId: keyId, param1: 458757, param2: 0 });
await c.saveChanges();
const pk = loadWorkspace('totem').zmk.pendingKeymap;
assert.equal(pk.layers[0].bindings[3].behavior, 'Key Press'); assert.equal(pk.layers[0].bindings[3].param1, 458757); checks += 2;
assert.equal(pk.layers[0].bindings[2].behaviorId, -1, 'untouched key is a skip placeholder'); checks++;
assert.equal(pk.layers[1].bindings[5].behavior, null, 'untouched device-only key is not rewritten'); checks++;
assert.equal(pk.layers[0].name, ''); checks++;

// Unsynced edits block a reseed.
assert.equal(seedWorkspaceFromDevice('totem', { layers, behaviors }), null); checks++;
assert.equal(loadWorkspace('totem').zmk.pendingKeymap.layers[0].bindings[3].param1, 458757); checks++;
// Device-sourced pending keymap replays on connect.
const app = {};
await zmkSyncExtras(app, loadWorkspace('totem'));
assert.ok(app.zmkQueuedWs); checks++;

// Template workspace: replay skipped, and a real connect reseeds it (edits kept aside).
mem.clear();
const t = createZmkTemplate('totem');
t.zmk.pendingKeymap = { kind: 'flask-zmk-keymap', layers: [] };
localStorage.setItem('flask-offline-totem', JSON.stringify(t));
const app2 = {};
const r = await zmkSyncExtras(app2, loadWorkspace('totem'));
assert.equal(app2.zmkQueuedWs, null); assert.equal(r.keymapSkipped, true); checks += 2;
ws = seedWorkspaceFromDevice('totem', { layers, behaviors });
assert.equal(ws.source, 'device'); assert.ok(ws.zmk.droppedTemplateKeymap); assert.equal(ws.zmk.pendingKeymap, null); checks += 3;

// Wrong binding count is refused; snapshot bootstrap picks the newest fitting entry.
assert.equal(seedWorkspaceFromDevice('totem', { layers: [{ id: 0, name: 'x', bindings: row(7).slice(1) }], behaviors }), null); checks++;
mem.clear();
const snapLayer = (name) => ({ name, bindings: Array.from({ length: N }, () => ({ behavior: 'Key Press', behaviorId: 1, param1: 458756, param2: 0 })) });
localStorage.setItem('zmk-keymap-snapshot:old', JSON.stringify({ savedAt: '2026-01-01T00:00:00Z', layers: [snapLayer('old')] }));
localStorage.setItem('zmk-keymap-snapshot:new', JSON.stringify({ savedAt: '2026-06-01T00:00:00Z', layers: [snapLayer('new')] }));
localStorage.setItem('zmk-keymap-snapshot:imprint', JSON.stringify({ savedAt: '2026-09-01T00:00:00Z', layers: [{ name: 'i', bindings: snapLayer('i').bindings.concat(snapLayer('i').bindings) }] }));
assert.equal(seedWorkspaceFromSnapshot('totem').zmk.keymap.layers[0].name, 'new'); checks++;
assert.equal(seedWorkspaceFromSnapshot('imprint'), null, 'no 70-key snapshot fits: 76 bindings'); checks++;

console.log(`unplugged-test: ${checks} checks OK`);
