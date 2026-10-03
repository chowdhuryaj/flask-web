// Discard semantics: the top-bar Discard reverts unsaved sources only and never
// drops the Unplugged queue (WC-05); "Discard queued" drops queue, marks and the
// values the queue carried. Earlier regression: the status bar counter stayed.
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage ??= {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
};
const { saveState } = await import('../save-state.js?v=71');
const { createZmkTemplate, attachZmkOffline, ZmkOfflineFlask, offlineQueued, discardOfflineQueued }
    = await import('../zmk-offline.js?v=71');
const { CH, V } = await import('../flaskproto.js?v=71');
const { encodeMacroStep, MACRO_ACTION } = await import('../zmk-macros-codec.js?v=71');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

function setup() {
    saveState.reset();
    const ws = createZmkTemplate('totem');
    const app = { offline: true, offlineWs: ws };
    attachZmkOffline(app, ws);
    return { ws, app };
}

// 1. Top-bar Discard (discardAll) reverts unsaved sources only. A saved
// Unplugged edit IS the queue (WC-05): journals and pendingKeymap survive, and
// marks that cannot be reverted stay visible instead of being dropped.
{
    const { ws, app } = setup();
    await app.flask.setU16(CH.scrollSnap, V.snapThreshold, 80);          // queued
    ws.zmk.pendingKeymap = { kind: 'flask-zmk-keymap', layers: [] };      // a saved keymap edit
    let reverted = 0;
    saveState.markDirty('studio-keymap', 'Keymap', async () => {}, { discard: async () => { reverted++; } });
    saveState.markDirty(CH.combos, 'Combos', async () => {});            // no discard fn
    eq(offlineQueued(ws), 2);
    const r = await saveState.discardAll();
    eq(r.failed, null);
    eq(reverted, 1, 'keymap discard fn ran');
    eq(saveState.dirty().map((d) => d.source), [CH.combos], 'non-revertable mark stays, reported by discardMessage');
    eq(offlineQueued(ws), 2, 'queue and pendingKeymap untouched');
    eq(await app.flask.getU16(CH.scrollSnap, V.snapThreshold), 80, 'saved value still shown');
}

// 2. The explicit "Discard queued" drops the queue, the marks, AND the phantom
// values (restored to the baseline taken when nothing was queued).
{
    const { ws, app } = setup();
    const before = await app.flask.getU16(CH.scrollSnap, V.snapThreshold);
    await app.flask.setU16(CH.scrollSnap, V.snapThreshold, 80);
    await app.flask.setBytes(CH.macros, V.macrosStep, encodeMacroStep(0, 0, { action: MACRO_ACTION.tap, param: 0x70004 }), 2);
    saveState.markDirty(CH.combos, 'Combos', async () => {});
    saveState.markDirty(0x2A, 'Hold-tap timing', async () => {});
    eq(discardOfflineQueued(ws) > 0, true, 'something dropped');
    eq(saveState.dirty(), [], 'Save N unsaved gone');
    eq(offlineQueued(ws), 0);
    eq(await app.flask.getU16(CH.scrollSnap, V.snapThreshold), before, 'tunable back to baseline');
    eq(ws.zmk.macros[0][0].action, MACRO_ACTION.empty, 'macro step back to baseline');
    eq(discardOfflineQueued(ws), 0, 'nothing left is reported as 0');
}

// 3. A stale hook (workspace left) does nothing; discardAll on a clean state is a no-op.
{
    const { app } = setup();
    app.offlineWs = null;
    eq((await saveState.discardAll()).queued, 0);
}

console.log(`discard-test: ${checks} checks OK`);
