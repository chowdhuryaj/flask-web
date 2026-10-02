// Offline journal replay (offline.js syncWorkspace) on the ZMK line: tunables
// journal on the sim, replay saves every touched channel (0x28 = tap dance
// saves like any other), unhandled ids are dropped, failures stay queued.
import assert from 'node:assert/strict';
import { syncWorkspace, pendingCount, listWorkspaces, saveWorkspace } from '../offline.js?v=62';
import { FlaskProto, CH, V, CMD } from '../flaskproto.js?v=62';
import { ZmkOfflineFlask, createZmkTemplate } from '../zmk-offline.js?v=62';

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

console.log(`offline-replay-test: ${checks} checks OK`);
