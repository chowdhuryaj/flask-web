// WP6: save ordering, stop-on-first-failure, discard, the baseline gate,
// and old-file round trips.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.localStorage ??= {
    _m: new Map(),
    getItem(k) { return this._m.get(k) ?? null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};

const { SaveState } = await import('../save-state.js?v=61');
const { writeBaseline, isModePayload, addMode, emptyStore, setBaseline, modeSummary } = await import('../zmk-modes.js?v=61');

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

// ---- save ordering and stop on first failure ----
{
    const s = new SaveState();
    const ran = [];
    const fn = (id, fail) => async () => { ran.push(id); if (fail) throw new Error(`${id} failed`); };
    s.markDirty(0x1A, 'Autoscroll', fn(0x1A));
    s.markDirty(0x05, 'DPI', fn(0x05));
    s.markDirty('studio-keymap', 'Keymap', fn('studio-keymap'));
    s.markDirty(0x10, 'Accel', fn(0x10));
    s.markDirty('zzz', 'Other', fn('zzz'));
    eq(s.dirty().map((d) => d.source), ['studio-keymap', 0x05, 0x10, 0x1A, 'zzz'], 'Studio, channels ascending, strings last');
    eq(s.summary(), 'Save 5 unsaved');
    eq((await s.saveAll()).failed, null);
    eq(ran, ['studio-keymap', 0x05, 0x10, 0x1A, 'zzz'], 'run order');
    eq(s.dirty(), [], 'all clean after success');
    eq(s.summary(), '');

    // Failure in the middle: earlier ones are clean, the failed one and the rest stay dirty and do not run.
    ran.length = 0;
    s.markDirty('studio-keymap', 'Keymap', fn('studio-keymap'));
    s.markDirty(0x05, 'DPI', fn(0x05, true));
    s.markDirty(0x10, 'Accel', fn(0x10));
    const r = await s.saveAll();
    eq(ran, ['studio-keymap', 0x05], 'nothing runs after the failure');
    eq(r.saved, ['studio-keymap']);
    eq(r.failed.source, 0x05);
    eq(r.failed.error.message, '5 failed');
    eq(s.dirty().map((d) => d.source), [0x05, 0x10], 'failed + later stay dirty');
    eq(s.summary(), 'Save 2 unsaved');
    // Retry after the cause is fixed picks up where it stopped.
    ran.length = 0;
    s.markDirty(0x05, 'DPI', fn(0x05));
    eq((await s.saveAll()).saved, [0x05, 0x10]);
    eq(ran, [0x05, 0x10]);
}

// ---- first failure when the keymap itself fails: no channel is written ----
{
    const s = new SaveState();
    const ran = [];
    s.markDirty('studio-keymap', 'Keymap', async () => { throw new Error('locked'); });
    s.markDirty(0x05, 'DPI', async () => { ran.push(5); });
    const r = await s.saveAll();
    eq(r.failed.source, 'studio-keymap');
    eq(ran, [], 'channels never saved when the keymap save fails');
    eq(s.dirty().length, 2);
}

// ---- discard ----
{
    const s = new SaveState();
    const log = [];
    s.markDirty('studio-keymap', 'Keymap', async () => {}, { discard: async () => { log.push('discard-km'); } });
    s.markDirty(0x05, 'DPI', async () => {});
    ok(s.canDiscard());
    eq(s.dirty().map((d) => d.canDiscard), [true, false]);
    eq((await s.discard()).discarded, ['studio-keymap']);
    eq(log, ['discard-km']);
    eq(s.dirty().map((d) => d.source), [0x05], 'channels (no discard fn) stay dirty');
    ok(!s.canDiscard());
    // A failing discard leaves the source dirty.
    s.markDirty('studio-keymap', 'Keymap', async () => {}, { discard: async () => { throw new Error('x'); } });
    const r = await s.discard();
    eq(r.failed.source, 'studio-keymap');
    ok(s.dirty().some((d) => d.source === 'studio-keymap'));
    s.reset();
    eq(s.dirty(), [], 'reset drops everything');
}

// ---- Make baseline gate (fake keymap tab) ----
{
    const mk = (apply, save) => {
        const calls = [];
        return {
            calls,
            applyKeymapData: async () => { calls.push('apply'); return apply; },
            saveChanges: async () => { calls.push('save'); return save; },
        };
    };
    let kt = mk(null, true);
    eq(await writeBaseline(kt, {}), false, 'refused import -> no baseline');
    eq(kt.calls, ['apply'], 'refused import never saves');
    kt = mk({ stopped: true, wrote: 3 }, true);
    eq(await writeBaseline(kt, {}), false, 'stopped import -> no baseline');
    eq(kt.calls, ['apply'], 'stopped import never saves');
    kt = mk({ wrote: 3 }, false);
    eq(await writeBaseline(kt, {}), false, 'failed save -> no baseline');
    eq(kt.calls, ['apply', 'save']);
    kt = mk({ wrote: 3 }, true);
    let after = 0;
    eq(await writeBaseline(kt, {}, async () => { after++; return false; }), false, 'module sections failed -> no save, no baseline');
    eq(kt.calls, ['apply'], 'module failure stops before the save');
    kt = mk({ wrote: 3 }, true);
    eq(await writeBaseline(kt, {}, async () => { after++; }), true, 'clean import + save -> baseline');
    eq(kt.calls, ['apply', 'save']);
    // F2: Studio saves first; module channels save only after it, and a
    // failed Studio save never reaches the channel saves.
    kt = mk({ wrote: 3 }, true);
    const order = [];
    eq(await writeBaseline(kt, {}, async () => { order.push('modules-live'); },
        async () => { order.push('channels'); kt.calls.push('channels'); }), true);
    eq(kt.calls, ['apply', 'save', 'channels'], 'Studio save before channel saves');
    kt = mk({ wrote: 3 }, false);
    eq(await writeBaseline(kt, {}, async () => {}, async () => { kt.calls.push('channels'); }), false);
    eq(kt.calls, ['apply', 'save'], 'failed Studio save never saves channels');
    kt = mk({ wrote: 3 }, true);
    eq(await writeBaseline(kt, {}, async () => {}, async () => false), false, 'failed channel save -> no baseline');
    // saveChanges resolving undefined (older tab build) is not a success.
    kt = mk({ wrote: 1 }, undefined);
    eq(await writeBaseline(kt, {}), false, 'only an explicit true counts');
    // setBaseline is the caller's job and only runs on true: store unchanged here.
    const { store, mode } = addMode(emptyStore(), 'Radiology', { kind: 'flask-zmk-keymap', layers: [] });
    eq(store.baselineId, null);
    eq(setBaseline(store, mode.id).baselineId, mode.id);
}

// ---- old ZMK export (v2 JSON with `family`) still imports and round-trips ----
{
    const { createZmkTemplate, attachZmkOffline } = await import('../zmk-offline.js?v=61');
    const { applyFlaskState, exportFlaskState } = await import('../zmk-export.js?v=61');
    const old = JSON.parse(fixture('zmk-export-v2.json'));
    eq([old.kind, old.version, old.family], ['flask-zmk-keymap', 2, 'imprint'], 'fixture has the v2 header with family');
    ok(isModePayload(old), 'old file is a valid mode payload');
    ok(modeSummary({ data: old }).includes('RGB'), 'mode summary reads the old file');

    const ws = createZmkTemplate('imprint');
    const app = { hid: { pause() {}, resume() {} } };
    attachZmkOffline(app, ws);
    const res = await applyFlaskState(app, old.flask);
    eq(res.failures, [], 'old export applies with no failed sections');
    ok(res.applied > 0, 'writes happened');
    const again = await exportFlaskState(app);
    eq(Object.keys(again).sort(), Object.keys(old.flask).sort(), 'same sections');
    eq(old.flask.accel.takeoff, 321, 'fixture carries a non-default value');
    eq(again, old.flask, 'export after import equals the old file byte for byte (as JSON)');
    eq(JSON.stringify(again), JSON.stringify(old.flask), 'serialises identically');

    // F2: save:false applies live with zero saves and reports the channels.
    const saved = [];
    const realSave = app.flask.save.bind(app.flask);
    app.flask.save = async (ch) => { saved.push(ch); return realSave(ch); };
    const live = await applyFlaskState(app, old.flask, { save: false });
    eq(saved, [], 'save:false never saves');
    ok(live.channels.length > 1, 'channels to save reported');
    const { saveFlaskChannels } = await import('../zmk-export.js?v=61');
    let n = 0;
    app.flask.save = async (ch) => { n++; if (ch === live.channels[1]) throw new Error('nope'); };
    const sr = await saveFlaskChannels(app, live.channels);
    eq([sr.ok, n], [false, 2], 'channel saves stop at the first failure');
    ok(sr.failure.includes('nope'));
}

// ---- offline queue count feeds the status bar ----
{
    const { createZmkTemplate, ZmkOfflineFlask, offlineQueued, discardOfflineQueued } = await import('../zmk-offline.js?v=61');
    const { CH, V } = await import('../flaskproto.js?v=61');
    const ws = createZmkTemplate('imprint');
    eq(offlineQueued(ws), 0);
    await new ZmkOfflineFlask(ws).setU16(CH.scrollSnap, V.snapThreshold, 80);
    eq(offlineQueued(ws), 1);
    eq(discardOfflineQueued(ws), 1);
    eq(offlineQueued(ws), 0);
    eq(discardOfflineQueued(ws), 0, 'nothing queued, nothing touched');
}

console.log(`save-test: ${checks} checks OK`);
