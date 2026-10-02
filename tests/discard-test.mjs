// Regression: offline "Discard queued" left the status bar's "Save N unsaved"
// counter (saveState) untouched. One discardAll() now clears both.
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage ??= {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
};
const { saveState } = await import('../save-state.js?v=61');
const { createZmkTemplate, attachZmkOffline, ZmkOfflineFlask, offlineQueued, discardOfflineQueued }
    = await import('../zmk-offline.js?v=61');
const { CH, V } = await import('../flaskproto.js?v=61');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const wait = () => new Promise((r) => setTimeout(r, 0));

function setup() {
    saveState.reset();
    const ws = createZmkTemplate('totem');
    const app = { offline: true, offlineWs: ws };
    attachZmkOffline(app, ws);
    return { ws, app };
}

// 1. discardAll clears queue + unsaved marks, reverts discardable sources.
{
    const { ws, app } = setup();
    await app.flask.setU16(CH.scrollSnap, V.snapThreshold, 80);          // queued
    let reverted = 0;
    saveState.markDirty('studio-keymap', 'Keymap', async () => {}, { discard: async () => { reverted++; } });
    saveState.markDirty(CH.combos, 'Combos', async () => {});            // no discard fn
    saveState.markDirty(0x2A, 'Hold-tap timing', async () => {});
    eq(saveState.summary(), 'Save 3 unsaved');
    eq(offlineQueued(ws), 1);
    const r = await saveState.discardAll();
    eq(r.failed, null);
    eq(reverted, 1, 'keymap discard fn ran');
    eq(saveState.dirty(), [], 'counter cleared');
    eq(saveState.summary(), '');
    eq(offlineQueued(ws), 0, 'queue cleared');
}

// 2. The old button's function (main.js calls it) now clears the counter too.
{
    const { ws, app } = setup();
    await app.flask.setU16(CH.scrollSnap, V.snapThreshold, 80);
    saveState.markDirty(CH.combos, 'Combos', async () => {});
    saveState.markDirty(0x2A, 'Hold-tap timing', async () => {});
    eq(discardOfflineQueued(ws) > 0, true, 'something dropped');
    await wait();
    eq(saveState.dirty(), [], 'Save N unsaved gone after Discard queued');
    eq(offlineQueued(ws), 0);
    eq(discardOfflineQueued(ws), 0, 'nothing left is reported as 0');
}

// 3. A stale hook (workspace left) does nothing; discardAll on a clean state is a no-op.
{
    const { app } = setup();
    app.offlineWs = null;
    eq((await saveState.discardAll()).queued, 0);
}

console.log(`discard-test: ${checks} checks OK`);
