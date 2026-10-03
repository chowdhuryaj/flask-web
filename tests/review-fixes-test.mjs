// Verifier follow-ups: queued-keymap layer drift guard, per-connection fresh flask client,
// macroInUse gestures, restoreBase without a base snapshot, F01 check on the resolved output.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
};
class Node {
    constructor(tag) { this.tag = tag; this.kids = []; this.dataset = {}; this.style = {}; this.nodeType = 1; this.isConnected = true; this.attrs = {}; this.text = ''; }
    set textContent(t) { this.text = t; }
    get textContent() { return this.text + this.kids.map((k) => k.textContent ?? '').join(''); }
    append(...k) { this.kids.push(...k); }
    replaceChildren(...k) { this.kids = k; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener() {} removeEventListener() {} remove() {} focus() {} blur() {} closest() { return null; }
    querySelector() { return null; } querySelectorAll() { return []; }
    get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
}
const doc = new EventTarget();
Object.assign(doc, { createElement: (t) => new Node(t), createTextNode: (t) => ({ nodeType: 3, textContent: t }), querySelector: () => null, body: new Node('body') });
globalThis.document = doc;

const { CH, V } = await import('../flaskproto.js?v=69');
const { zmkCapabilities } = await import('../zmk.js?v=69');
const off = await import('../zmk-offline.js?v=69');
const { createZmkTemplate, ZmkOfflineFlask, queuedLayersMatch, dropJournals } = off;
const { setZmkContext } = await import('../zmk-keycodes.js?v=69');
const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=69');
const { encodeGestureSlot } = await import('../zmk-output-codec.js?v=69');
const { decodeTdStep } = await import('../zmk-tapdance-codec.js?v=69');
const common = await import('../zmk-behaviour-common.js?v=69');
const { exportFlaskState, applyFlaskState } = await import('../zmk-export.js?v=69');

const behaviors = new Map(TOTEM_DEFAULT.behaviors.map((d) => [d.id, d]));
setZmkContext({ behaviors, layers: [{ id: 0, name: 'base' }] });
const mkApp = () => {
    const ws = createZmkTemplate('totem');
    return { ws, flask: new ZmkOfflineFlask(ws), profile: { family: 'totem' }, hid: { pause() {}, resume() {} },
        caps: { ...zmkCapabilities('totem', 18), adaptive: true }, protocolVersion: 18 };
};

// 1. Layer drift guard: ids and count must match the seed.
{
    const ws = createZmkTemplate('totem');
    ws.zmk.seedBase = structuredClone(ws.zmk.keymap);
    const live = structuredClone(ws.zmk.seedBase.layers);
    ok(queuedLayersMatch(ws, live), 'same layers: replay allowed');
    ok(!queuedLayersMatch(ws, [live[1], live[0], ...live.slice(2)]), 'reordered layer ids: blocked');
    ok(!queuedLayersMatch(ws, live.slice(0, -1)), 'layer count changed: blocked');
    ok(!queuedLayersMatch({ zmk: {} }, live), 'no seed: blocked');
}

// 2. Fresh flask client per connection (dim() and holdtap probes are memoized per client).
{
    const src = readFileSync(new URL('../' + 'main.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async function loadZmkDevice'));
    ok(body.indexOf('app.flask = new FlaskProto(app.hid)') > 0
        && body.indexOf('app.flask = new FlaskProto(app.hid)') < body.indexOf('app.flask.handshake()'),
    'loadZmkDevice builds a new FlaskProto before the handshake');
    const a = mkApp(), b = mkApp();
    await a.flask.setU16(CH.macros, V.macrosSlotCount, 8).catch(() => {});
    const n1 = await common.dim(a, CH.macros, V.macrosSlotCount);
    b.flask = { getU16: async () => 16 };
    eq(await common.dim(b, CH.macros, V.macrosSlotCount), 16, 'a new client gets fresh counts');
    ok(n1 !== undefined);
}

// 3. macroInUse sees gesture slots.
{
    const app = mkApp();
    app.caps.gestures = true;
    ok(app.caps.gestures, 'gestures cap on');
    const r = (keymap) => common.macroInUse(app, 5, { keymap });
    eq(await r([]), false, 'unused slot');
    await app.flask.setBytes(CH.gestures, V.gesturesSlot, encodeGestureSlot(0, 2, { action: 2, param: 5 }), 2);
    eq(await r([]), true, 'gesture macro action 2 slot 5 counts as in use');
}

// 4. restoreBase: seed keymap comes back even without a base snapshot.
{
    const ws = createZmkTemplate('totem');
    ws.zmk.seedBase = structuredClone(ws.zmk.keymap);
    ws.zmk.keymap.layers[0].bindings[0] = { behaviorId: 1, param1: 0x7001D, param2: 0 };
    ws.zmk.pendingKeymap = { kind: 'flask-zmk-keymap', layers: [] };
    ok(dropJournals(ws) > 0, 'queue dropped');
    eq(ws.zmk.keymap, ws.zmk.seedBase, 'keymap restored to the seed with no base snapshot');
    ok(!ws.zmk.unsaved);
}

// 5. F01 check runs on the resolved output (by display name), not the raw file id.
{
    const app = mkApp();
    const st = await exportFlaskState(app);
    const rec = { action: 3, behavior: 'Tap Dance', behaviorId: 9999, param1: 1, param2: 0 };
    st.tapDance.slots[0].taps = [rec];
    await applyFlaskState(app, st);
    const d = decodeTdStep(await app.flask.getBytes(CH.tapDance, V.tdStep, [0, 0], 2));
    ok(!d.action, 'name-resolved &ftd step was not written to the device');
}

console.log(`review-fixes-test: ${checks} checks OK`);
process.exit(0);
