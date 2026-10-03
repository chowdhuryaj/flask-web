// Regression checks for the Unplugged / connect-lifecycle sweep fixes:
// WC-02 layer ops refused + drift review, WC-03 dialog choice covers the ZMK
// queue, WC-04 SAVE is the commit point, WC-06 stale family flag,
// WC-07 unplug while the dialog is open, WB-08 combo frame version.
import assert from 'node:assert/strict';

// ---- tiny DOM: enough for el() / modal() / toast() ----
class E {
    constructor(tag) { this.tag = tag; this.kids = []; this.l = {}; this.style = {}; this.nodeType = 1; this.removed = false; }
    set className(v) { this._c = v; }
    setAttribute() {}
    addEventListener(t, f) { (this.l[t] ??= []).push(f); }
    removeEventListener() {}
    append(...k) { this.kids.push(...k); }
    remove() { this.removed = true; }
    querySelector() { return null; }
    set textContent(v) { this.text = v; }
    get textContent() { return this.text ?? this.kids.map((k) => k.textContent ?? '').join(''); }
    find(pred) {
        if (pred(this)) return this;
        for (const k of this.kids) { const r = k.find?.(pred); if (r) return r; }
        return null;
    }
    async click() { for (const f of this.l.click ?? []) await f({ target: this }); }
}
globalThis.document = {
    body: new E('body'),
    createElement: (t) => new E(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    querySelector: () => null,
};
const mem = new Map();
globalThis.localStorage ??= {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
};

const { syncWorkspace, maybeSyncOffline, pendingCount, saveWorkspace, loadWorkspace } = await import('../offline.js?v=65');
const { CH, V } = await import('../flaskproto.js?v=65');
const { createZmkTemplate, ZmkOfflineFlask, zmkSyncExtras, zmkPendingCount, zmkDescribeChanges, dropJournals,
        seedWorkspaceFromDevice, OfflineStudioClient, attachZmkOffline } = await import('../zmk-offline.js?v=65');
const { zmkCapabilities } = await import('../zmk.js?v=65');
const { encodeComboSlotV3, decodeComboSlotV3, COMBO_ACTION } = await import('../zmk-combos-codec.js?v=65');
const { encodeMacroStep, MACRO_ACTION } = await import('../zmk-macros-codec.js?v=65');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// ---- WC-04: SAVE is the commit point (tunables) ----
{
    const ws = createZmkTemplate('imprint');
    const f = new ZmkOfflineFlask(ws);
    await f.setU16(CH.scrollSnap, V.snapThreshold, 80);
    let saveErr = new Error('timeout');
    const app = { flask: { setU16: async (_c, _i, v) => v, setI16: async (_c, _i, v) => v,
        save: async () => { if (saveErr) throw saveErr; }, setBytes: async () => [] } };
    const r = await syncWorkspace(app, ws);
    eq(r.applied, 0, 'SAVE timed out: nothing counted applied');
    eq(pendingCount(ws), 1, 'entry stays queued'); eq(r.failures.length, 1);
    ok(/SAVE failed/.test(r.failures[0]));
    ok(ws.dirty.saves.includes(CH.scrollSnap), 'the SAVE is retried next connect');
    saveErr = new Error('unhandled');
    const r2 = await syncWorkspace(app, ws);
    eq(r2.applied, 1); eq(pendingCount(ws), 0, 'channel without persistence: nothing to lose, drains');
    eq(ws.dirty.saves, []);
}

// ---- WC-04 + WB-08: ZMK slot replay ----
{
    const ws = createZmkTemplate('imprint');
    const f = new ZmkOfflineFlask(ws);
    const combo = { positions: [1, 2], action: COMBO_ACTION.usage, behaviorId: 0, param1: 0x70004, param2: 0,
        timeoutMs: 120, priorIdleMs: 90, layer: 2 };
    await f.setBytes(CH.combos, V.combosSlotV3, encodeComboSlotV3(5, combo, 8), 1);
    await f.setBytes(CH.macros, V.macrosStep, encodeMacroStep(0, 0, { action: MACRO_ACTION.tap, param: 0x70004 }), 2);
    eq(zmkPendingCount(ws), 2);
    const writes = [];
    let failSave = true;
    const dev = (caps) => ({ caps, flask: {
        getU16: async () => 8,
        setBytes: async (c, i, p) => { writes.push([c, i, [...p]]); return p; },
        save: async (c) => { if (failSave && c === CH.macros) throw new Error('timeout'); },
    } });
    const r = await zmkSyncExtras(dev(zmkCapabilities('imprint', 14)), ws);
    const cw = writes.find((w) => w[0] === CH.combos);
    eq(cw[1], V.combosSlotV3, 'v14 firmware gets the timed combo frame');
    const back = decodeComboSlotV3(cw[2], 8);
    eq([back.timeoutMs, back.priorIdleMs, back.layer], [120, 90, 2], 'window/idle/layer survive the replay');
    eq(Object.keys(ws.zmkDirty.combo), [], 'combo committed after its SAVE');
    eq(Object.keys(ws.zmkDirty.macroStep), ['0,0'], 'macro SAVE failed: stays queued');
    eq(r.applied, 1); eq(r.failures.length, 1);
    failSave = false;
    const r2 = await zmkSyncExtras(dev(zmkCapabilities('imprint', 14)), ws);
    eq(r2.applied, 1); eq(zmkPendingCount(ws), 0);
    // v12 firmware keeps the typed frame.
    await f.setBytes(CH.combos, V.combosSlotV3, encodeComboSlotV3(6, combo, 8), 1);
    writes.length = 0;
    await zmkSyncExtras(dev(zmkCapabilities('imprint', 12)), ws);
    eq(writes.find((w) => w[0] === CH.combos)[1], V.combosSlotV2);
}

// ---- WC-02: device-seeded workspace refuses layer structure ops ----
{
    const N = 38;
    const behaviors = new Map([[7, { id: 7, displayName: 'Key Press', metadata: [{ param1: [{ name: 'Key', kind: 'hid_usage' }], param2: [] }] }]]);
    const mk = (id, name) => ({ id, name, bindings: Array.from({ length: N }, () => ({ behaviorId: 7, param1: 458756, param2: 0 })) });
    mem.clear();
    const ws = seedWorkspaceFromDevice('totem', { layers: [mk(0, 'a'), mk(1, 'b'), mk(2, 'c')], behaviors, availableLayers: 2 });
    const c = new OfflineStudioClient(ws);
    const msg = 'Adding, removing or reordering layers needs the keyboard connected';
    for (const op of [() => c.addLayer(), () => c.removeLayer(1), () => c.moveLayer(0, 1), () => c.restoreLayer(1, 0)]) {
        await assert.rejects(op, { message: msg }); checks++;
    }
    eq(ws.zmk.keymap.layers.map((l) => l.id), [0, 1, 2], 'nothing changed');
    await c.setLayerProps(1, 'renamed');
    eq(ws.zmk.keymap.layers[1].name, 'renamed', 'rename stays allowed');
    await c.saveChanges();
    ok(ws.zmk.pendingKeymap, 'rename queued');
    // A stored workspace whose layer ids drifted from the seed: do not auto-apply.
    const app = {};
    await zmkSyncExtras(app, ws);
    ok(app.zmkQueuedWs === ws, 'unchanged layer list still queues the keymap');
    ws.zmk.keymapSaved.layers.splice(0, 1);
    const app2 = {};
    const r = await zmkSyncExtras(app2, ws);
    eq(r.keymapReview, true); eq(app2.zmkQueuedWs, null, 'not handed to the keymap tab');
    ok(ws.zmk.pendingKeymap, 'still queued'); eq(zmkPendingCount(ws), 1);
    // Templates keep layer ops (nothing of theirs ever replays).
    const t = new OfflineStudioClient(createZmkTemplate('totem'));
    await t.moveLayer(0, 1); checks++;
}

// ---- WC-06: attaching Unplugged clears a stale family flag ----
{
    mem.clear();
    const app = { familyUnresolved: true };
    attachZmkOffline(app, createZmkTemplate('totem'));
    eq(app.familyUnresolved, false);
}

// ---- WC-03 / WC-07: the dialog choice covers the ZMK queue ----
{
    const mkWs = async () => {
        mem.clear();
        const ws = createZmkTemplate('imprint');
        const f = new ZmkOfflineFlask(ws);
        await f.setU16(CH.scrollSnap, V.snapThreshold, 80);
        await f.setBytes(CH.macros, V.macrosStep, encodeMacroStep(0, 0, { action: MACRO_ACTION.tap, param: 0x70004 }), 2);
        saveWorkspace(ws);
        return ws;
    };
    const sent = [];
    const mkApp = () => {
        const app = { family: 'imprint', hid: new EventTarget(), caps: zmkCapabilities('imprint', 14), flask: {
            setU16: async (...a) => { sent.push(['u16', a]); return a[2]; }, setI16: async (...a) => a[2],
            setBytes: async (...a) => { sent.push(['bytes', a]); return a[2]; }, getU16: async () => 8,
            save: async () => {} } };
        return app;
    };
    const ext = { count: zmkPendingCount, describe: zmkDescribeChanges, clear: dropJournals,
        apply: (a, w) => zmkSyncExtras(a, w) };
    const lastModal = () => document.body.kids.filter((k) => !k.removed).at(-1);
    const button = (label) => lastModal().find((e) => e.tag === 'button' && e.textContent === label);
    const open = async (app) => {
        document.body.kids.length = 0;
        const p = maybeSyncOffline(app, null, ext);
        await new Promise((r) => setTimeout(r, 0));
        return p;
    };

    // Dialog lists and counts the slot edit too.
    let ws = await mkWs(); sent.length = 0;
    let app = mkApp(); let p = open(app); await new Promise((r) => setTimeout(r, 0));
    ok(/Apply 2 offline changes/.test(lastModal().textContent), 'count includes the macro step');
    ok(/macro step 0 \/ 0/.test(lastModal().textContent));
    await button('Discard').click();
    eq(await p, 'discarded'); eq(sent, [], 'Discard sends nothing, including slot edits');
    eq(zmkPendingCount(loadWorkspace('imprint')), 0); eq(pendingCount(loadWorkspace('imprint')), 0);

    // Later keeps both queued and sends nothing.
    ws = await mkWs(); sent.length = 0;
    app = mkApp(); p = open(app); await new Promise((r) => setTimeout(r, 0));
    await button('Later').click();
    eq(await p, 'later'); eq(sent, []);
    eq(zmkPendingCount(loadWorkspace('imprint')), 1); eq(pendingCount(loadWorkspace('imprint')), 1);

    // Apply now replays both.
    ws = await mkWs(); sent.length = 0;
    app = mkApp(); p = open(app); await new Promise((r) => setTimeout(r, 0));
    await button('Apply now').click();
    eq(await p, 'applied');
    ok(sent.some((s) => s[0] === 'u16') && sent.some((s) => s[0] === 'bytes' && s[1][0] === CH.macros));
    eq(zmkPendingCount(loadWorkspace('imprint')), 0);

    // Unplug while the dialog is open: dialog closes, nothing sent, queue kept.
    ws = await mkWs(); sent.length = 0;
    app = mkApp(); p = open(app); await new Promise((r) => setTimeout(r, 0));
    const dlg = lastModal();
    app.hid.dispatchEvent(new Event('disconnect'));
    eq(await p, 'aborted'); ok(dlg.removed, 'dialog closed'); eq(sent, []);
    eq(zmkPendingCount(loadWorkspace('imprint')), 1);
}

console.log(`offline-fixes-test: ${checks} checks OK`);
process.exit(0);   // toast() leaves a timer behind
