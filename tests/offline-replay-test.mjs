// Offline journal replay (offline.js syncWorkspace) on the ZMK line: tunables
// journal on the sim, replay saves every touched channel (0x28 = tap dance
// saves like any other), unhandled ids are dropped, failures stay queued.
import assert from 'node:assert/strict';
import { syncWorkspace, pendingCount, listWorkspaces, saveWorkspace } from '../offline.js?v=63';
import { FlaskProto, CH, V, CMD } from '../flaskproto.js?v=63';
import { ZmkOfflineFlask, createZmkTemplate, zmkSyncExtras, zmkPendingCount } from '../zmk-offline.js?v=63';
import { encodeCskSlot } from '../zmk-csk-codec.js?v=63';
import { encodeTdStep, encodeTdCfg, TD_ACTION } from '../zmk-tapdance-codec.js?v=63';

let checks = 0;
const mem = new Map();
globalThis.localStorage ??= {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
};

// 1. The sim journals a tunable and replay applies + saves its channel.
const ws = createZmkTemplate('imprint');
const f = new ZmkOfflineFlask(ws);
await f.setU16(CH.scrollSnap, V.snapThreshold, 80);
await f.setU16(CH.tapDance, V.tdEnabled, 0);
await f.save(CH.tapDance);
assert.equal(pendingCount(ws), 2); checks++;
const sent = [], saved = [];
const app = {
    flask: {
        setU16: async (c, i, v) => { sent.push([c, i, v]); return v; }, setI16: async (_c, _i, v) => v,
        save: async (ch) => { saved.push(ch); }, setBytes: async () => [],
    },
};
const r = await syncWorkspace(app, ws);
assert.deepEqual(sent.map((s) => s[0]).sort(), [CH.scrollSnap, CH.tapDance].sort()); checks++;
assert.deepEqual(saved.sort(), [CH.scrollSnap, CH.tapDance].sort(), 'touched channels save, 0x28 included'); checks++;
assert.equal(r.applied, 2); assert.equal(pendingCount(ws), 0, 'journal drained'); checks++;

// 2. An id the device answers "unhandled" is dropped, a transport error stays queued.
await f.setU16(CH.scrollSnap, V.snapEnabled, 1);
await f.setU16(CH.autoscroll, V.asInverted, 1);
const bad = {
    flask: {
        setU16: async (c) => { throw new Error(c === CH.scrollSnap ? 'unhandled' : 'timeout'); },
        setI16: async () => 0, save: async () => {}, setBytes: async () => [],
    },
};
const r2 = await syncWorkspace(bad, ws);
assert.equal(r2.dropped.length, 1); assert.equal(r2.failures.length, 1); checks += 2;
assert.equal(pendingCount(ws), 1, 'only the transient failure stays queued'); checks++;

// 3. Transient live ids never journal.
const before = pendingCount(ws);
await f.setU16(CH.autoscroll, V.asState, 0);
assert.equal(pendingCount(ws), before, 'asState force-stop is not journaled'); checks++;

// 4. FlaskProto.save sends a SAVE frame for 0x28 (tap dance) on the ZMK line.
const frames = [];
const hid = { request: async (frame) => { frames.push(frame); return [CMD.save, frame[1], 0]; } };
await new FlaskProto(hid).save(CH.tapDance);
assert.deepEqual(frames.map((x) => x[1]), [CH.tapDance]); checks++;

// 5. Only ZMK workspaces are listed; stored workspaces of other families are ignored.
localStorage.setItem('flask-offline-adept', JSON.stringify({ key: 'adept', family: 'adept', dirty: {} }));
saveWorkspace(ws);
assert.deepEqual(listWorkspaces().map((w) => w.key), ['imprint']); checks++;

// 6. Shift keys + tap dance journal offline and replay with the tabs' own frames.
{
    const ws2 = createZmkTemplate('imprint');
    ws2.key = 'imprint2';
    const g = new ZmkOfflineFlask(ws2);
    await g.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(3, { base: 0x70004, shifted: 0x70005 }), 1);
    await g.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(5, { base: 0x70006, shifted: 0x70007 }), 1);
    await g.setBytes(CH.tapDance, V.tdStep,
        encodeTdStep(1, 0, { action: TD_ACTION.usage, param1: 0x70008 }), 2);
    await g.setBytes(CH.tapDance, V.tdStep,
        encodeTdStep(1, 1, { action: TD_ACTION.usage, param1: 0x70009 }), 2);
    await g.setBytes(CH.tapDance, V.tdCfg, encodeTdCfg(1, 250), 1);
    assert.equal(zmkPendingCount(ws2), 5, 'csk + td entries counted'); checks++;

    const writes = [], saves = [];
    const dev = { flask: {
        setBytes: async (c, i, p) => { writes.push([c, i, [...p]]); return p; },
        save: async (c) => { saves.push(c); },
    }, hid: null };
    const r3 = await zmkSyncExtras(dev, ws2);
    assert.equal(r3.applied, 5); assert.deepEqual(r3.failures, []); checks += 2;
    const has = (c, i, p) => writes.some((w) => w[0] === c && w[1] === i
        && JSON.stringify(w[2]) === JSON.stringify(p));
    assert.ok(has(CH.customShift, V.cskSlot, encodeCskSlot(3, { base: 0x70004, shifted: 0x70005 }))); checks++;
    assert.ok(has(CH.customShift, V.cskSlot, encodeCskSlot(5, { base: 0x70006, shifted: 0x70007 }))); checks++;
    assert.ok(has(CH.tapDance, V.tdStep, encodeTdStep(1, 0, { action: TD_ACTION.usage, param1: 0x70008 }))); checks++;
    assert.ok(has(CH.tapDance, V.tdStep, encodeTdStep(1, 1, { action: TD_ACTION.usage, param1: 0x70009 }))); checks++;
    assert.ok(has(CH.tapDance, V.tdCfg, encodeTdCfg(1, 250))); checks++;
    assert.deepEqual(saves.sort(), [CH.customShift, CH.tapDance].sort(), 'each channel saved once'); checks++;
    assert.equal(zmkPendingCount(ws2), 0, 'cleared after success'); checks++;

    // Failure stays queued, 'unhandled' is dropped.
    await g.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(3, { base: 0x70004, shifted: 0x70005 }), 1);
    await g.setBytes(CH.tapDance, V.tdCfg, encodeTdCfg(2, 300), 1);
    const flaky = { flask: {
        setBytes: async (c) => { throw new Error(c === CH.customShift ? 'timeout' : 'unhandled'); },
        save: async () => {},
    } };
    const r4 = await zmkSyncExtras(flaky, ws2);
    assert.equal(r4.failures.length, 1); assert.equal(r4.applied, 0); checks += 2;
    assert.deepEqual(Object.keys(ws2.zmkDirty.cskSlot), ['3'], 'timeout stays queued'); checks++;
    assert.deepEqual(Object.keys(ws2.zmkDirty.tdStep), [], 'unhandled dropped'); checks++;
}

console.log(`offline-replay-test: ${checks} checks OK`);
