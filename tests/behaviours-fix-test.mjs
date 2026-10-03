// Behaviour-tab fixes (sweep web-beh WB-01..WB-17, F01, perf P2): tab logic against the
// offline sim with a tiny fake DOM, plus export/apply, catalog and picker surfaces.
import assert from 'node:assert/strict';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ---- fake DOM: enough for el(), card(), reloadBar() and the tabs' constructors ----
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
Object.assign(doc, {
    createElement: (t) => new Node(t), createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    querySelector: () => null, body: new Node('body'),
});
globalThis.document = doc;

const { CH, V } = await import('../flaskproto.js?v=71');
const { zmkCapabilities } = await import('../zmk.js?v=71');
const { createZmkTemplate, ZmkOfflineFlask } = await import('../zmk-offline.js?v=71');
const { saveState } = await import('../save-state.js?v=71');
const { setZmkContext } = await import('../zmk-keycodes.js?v=71');
const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=71');
const { encodeMacroStep, decodeMacroStep, MACRO_ACTION } = await import('../zmk-macros-codec.js?v=71');
const { decodeAkStep, encodeAkStep, encodeAkRule, AK_ACTION } = await import('../zmk-adaptive-codec.js?v=71');
const { decodeTdStep, encodeTdStep } = await import('../zmk-tapdance-codec.js?v=71');
const common = await import('../zmk-behaviour-common.js?v=71');
const { ZmkMacrosTab } = await import('../zmk-macros-tab.js?v=71');
const { ZmkAdaptiveTab } = await import('../zmk-adaptive-tab.js?v=71');
const { ZmkTapDanceTab } = await import('../zmk-tapdance-tab.js?v=71');
const { ZmkCombosTab } = await import('../zmk-combos-tab.js?v=71');
const { ZmkLeaderTab } = await import('../zmk-leader-tab.js?v=71');
const { exportFlaskState, applyFlaskState, namedOut, resolveOut } = await import('../zmk-export.js?v=71');
const catalog = await import('../behavior-catalog.js?v=71');
const { SURFACES, surfaceEntries } = await import('../binding-picker.js?v=71');
const { modeSummary } = await import('../zmk-modes.js?v=71');

const behaviors = new Map(TOTEM_DEFAULT.behaviors.map((d) => [d.id, d]));
setZmkContext({ behaviors, layers: [{ id: 0, name: 'base' }] });
const idOf = (name) => TOTEM_DEFAULT.behaviors.find((d) => d.displayName === name).id;
const TD = idOf('Tap Dance'), FAK = idOf('Adaptive Key'), SK = idOf('Sticky Key'), KR = idOf('Key Repeat');

const mkApp = () => {
    const ws = createZmkTemplate('totem');
    return { ws, flask: new ZmkOfflineFlask(ws), profile: { family: 'totem' }, hid: { pause() {}, resume() {} },
        caps: { ...zmkCapabilities('totem', 18), adaptive: true }, protocolVersion: 18 };
};
const reads = (app) => {   // count every read the sim serves
    const n = { get: 0 };
    for (const k of ['getBytes', 'getU16']) {
        const f = app.flask[k].bind(app.flask);
        app.flask[k] = (...a) => { n.get++; return f(...a); };
    }
    return n;
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const macroSteps = async (app, m) => {
    const out = [];
    for (let s = 0; s < 32; s++) {
        const d = decodeMacroStep(await app.flask.getBytes(CH.macros, V.macrosStep, [m, s], 2));
        if (d.action === MACRO_ACTION.empty) break;
        out.push(d);
    }
    return out;
};
const stub = (tab) => { tab.render = () => {}; return tab; };

// ---- WB-01: Adaptive's text macro reaches an open Macros tab; New macro never reuses it ----
{
    const app = mkApp();
    const macros = stub(new ZmkMacrosTab(app));
    await macros.load();
    eq(macros.steps.filter((s) => s[0].action).length, 0, 'macros tab loaded empty');
    const ak = stub(new ZmkAdaptiveTab(app));
    await ak.load();
    const { steps, created } = await ak.stepsForText('hello world');
    eq([created, steps[0].action], [0, AK_ACTION.macro], 'long text -> macro slot 0');
    await flush();
    eq(macros.steps[0][0].action, MACRO_ACTION.tap, 'open Macros tab picked the new slot up (flask:slots-changed)');
    await macros.addMacro();
    ok(macros.drafts.has(1) && !macros.drafts.has(0), 'New macro takes slot 1, not the adaptive one');
    eq((await macroSteps(app, 0)).length, 11, 'slot 0 still holds all 11 typed characters');

    // a stale cache (event missed) is caught against the device too
    await app.flask.setBytes(CH.macros, V.macrosStep, encodeMacroStep(2, 0, { action: MACRO_ACTION.tap, param: 0x70004 }), 2);
    await macros.addMacro();
    ok(macros.drafts.has(3) && !macros.drafts.has(2), 'New macro skips a slot the device holds although the cache says empty');
    eq(macros.steps[2][0].action, MACRO_ACTION.tap, 'and fixes the cache for it');

    // Adaptive never takes a slot the Macros tab has open as a draft
    eq(await ak.freeMacroSlot(32), 4, 'free slot skips the open drafts (1, 3) and the used ones (0, 2)');
}

// ---- WB-02: text macros are freed; reused slots end cleanly ----
{
    const app = mkApp();
    const ak = stub(new ZmkAdaptiveTab(app));
    ak.refsKeymap = [];   // keymap loaded, no macro binding
    await ak.load();
    const trig = 0x00070004;
    const mk = async (text) => {
        const { steps, created } = await ak.stepsForText(text);
        await ak.createRule(0, { trigger: trig + ak.rules.filter((r) => r.trigger).length, steps, maxIdleMs: 0 });
        return { created, i: ak.freeIndex() === -1 ? -1 : ak.rules.findIndex((r) => r.steps[0]?.param1 === created && r.steps[0].action === AK_ACTION.macro) };
    };
    const a = await mk('hello world');
    eq(await macroSteps(app, a.created) .then((s) => s.length), 11);
    // edit the output away from the macro: slot freed, name gone
    await ak.setOutput(a.i, { text: 'bye' });
    eq((await macroSteps(app, a.created)).length, 0, 'output edited away -> macro slot emptied');
    eq(common.draftSlots.macro.has(a.created), false);
    // an edit to another long text allocates, and frees the old one
    const b = await mk('aaaaaaaaaaaa');
    await ak.setOutput(b.i, { text: 'bbbbbbbbbbbb' });
    eq((await macroSteps(app, b.created)).length, 0, 'edited long->long: the old macro is freed');
    eq(await macroSteps(app, 1).then((s) => s.length), 0);
    // delete the rule
    const c = await mk('cccccccccccc');
    await ak.deleteRule(c.i);
    eq((await macroSteps(app, c.created)).length, 0, 'rule deleted -> macro slot emptied');
    // a rule that is still referenced elsewhere keeps its macro: a second rule uses the same slot
    const d = await mk('dddddddddddd');
    const j = ak.freeIndex();
    await ak.createRule(0, { trigger: 0x0007001B, steps: [{ action: AK_ACTION.macro, behaviorId: 0, param1: d.created, param2: 0 }], maxIdleMs: 0 });
    await ak.deleteRule(d.i);
    eq((await macroSteps(app, d.created)).length, 12, 'another rule still uses it -> left alone');
    ok(ak.rules[j].steps[0].param1 === d.created);
    // unsure (keymap not loaded) -> left alone
    ak.refsKeymap = null;
    const e = await mk('eeeeeeeeeeee');
    await ak.deleteRule(e.i);
    eq((await macroSteps(app, e.created)).length, 12, 'keymap unknown -> not freed');
    // a macro made by someone else (no "AK:" name, not made here) is never touched
    ak.refsKeymap = [];
    await app.flask.setBytes(CH.macros, V.macrosStep, encodeMacroStep(20, 0, { action: MACRO_ACTION.tap, param: 0x70004 }), 2);
    await ak.createRule(1, { trigger: 0x0007001C, steps: [{ action: AK_ACTION.macro, behaviorId: 0, param1: 20, param2: 0 }], maxIdleMs: 0 });
    const k = ak.rules.findIndex((r) => r.trigger === 0x0007001C);
    await ak.deleteRule(k);
    eq((await macroSteps(app, 20)).length, 1, 'a user macro is not freed');
    // Add fails: the freshly made macro goes back
    ak.drafts.set(0, { trigger: 0x0007001D, text: 'ffffffffffff', steps: null, idle: '0', err: '' });
    ak.refsKeymap = [];
    ak.createRule = async () => { throw new Error('boom'); };
    const free = await ak.freeMacroSlot(32);
    await ak.commitDraft(0);
    eq((await macroSteps(app, free)).length, 0, 'createRule failed -> the new macro is freed');
    eq(ak.drafts.get(0).err, 'boom');
}

// ---- WB-11 negative within ; WB-17 shadow rule ----
{
    const app = mkApp();
    const ak = stub(new ZmkAdaptiveTab(app));
    await ak.load();
    ak.drafts.set(0, { trigger: 0x0007001D, text: 'x', steps: null, idle: '-5', err: '' });
    await ak.commitDraft(0);
    eq(ak.rules.find((r) => r.trigger === 0x0007001D).maxIdleMs, 0, 'negative within -> 0 (any), not 10000');
}

// ---- Perf: Adaptive load stops at the first NONE ----
{
    const app = mkApp();
    const n = reads(app);
    const ak = stub(new ZmkAdaptiveTab(app));
    await ak.load();
    const live = ak.rules.filter((r) => r.trigger);
    const used = live.reduce((t, r) => t + r.steps.filter((s, i) => !s.unknown && (s.action || i === 0 || r.steps[i - 1].action)).length, 0);
    ok(n.get < 4 + 64 + 35 * 6 + 4, `adaptive load reads fewer than the old full scan (${n.get})`);
    ok(n.get <= 4 + 64 + 35 * 6 + 4 - 35, `adaptive stops at NONE (${n.get} reads, ${used} step reads)`);
    ok(live.filter((r) => { const k = r.steps.findIndex((s) => !s.action); return k >= 0 && k < 5; }).every((r) => r.steps[5].unknown), 'steps behind NONE are flagged unread');
    // an unread tail is overwritten (not trusted) by the next write
    const r0 = live[0];
    await app.flask.setBytes(CH.adaptive, V.akStep, encodeAkStep(r0.index, 5, { action: 1, param1: 0x70005 }), 2);   // stale tail behind NONE
    await ak.load();
    await ak.setOutput(r0.index, { steps: [{ action: 1, behaviorId: 0, param1: 0x70006, param2: 0 }] });
    eq(decodeAkStep(await app.flask.getBytes(CH.adaptive, V.akStep, [r0.index, 5], 2)).action, 0, 'stale step behind NONE cleared by the write');
}

// ---- Perf: Tap Dance load stops at NONE; writes clear the unread tail ----
{
    const app = mkApp();
    const td = stub(new ZmkTapDanceTab(app));
    const n = reads(app);
    await td.load();
    ok(n.get <= 4 + 16 + 16, `tap dance load: one tap read per empty dance (${n.get})`);
    // WB-14: a refused write leaves the cache alone
    await app.flask.setBytes(CH.tapDance, V.tdStep, encodeTdStep(3, 2, { action: 1, param1: 0x70004 }), 2);   // tail behind NONE
    await td.load();
    ok(td.slots[3].taps[2].unknown, 'tap behind NONE is unread');
    await td.writeStep(3, 0, { slot: 3, tap: 0, action: 1, behaviorId: 0, param1: 0x70005, param2: 0 });
    eq(decodeTdStep(await app.flask.getBytes(CH.tapDance, V.tdStep, [3, 2], 2)).action, 0, 'filling tap 0 clears the dead tail first');
    const real = app.flask.setBytes.bind(app.flask);
    app.flask.setBytes = async () => { throw new Error('timeout'); };
    await td.writeStep(3, 1, { slot: 3, tap: 1, action: 1, behaviorId: 0, param1: 0x70006, param2: 0 });
    eq(td.slots[3].taps[1].action, 0, 'failed write: cache still shows what the device holds');
    app.flask.setBytes = real;
    // WB-12: delete drops the custom name
    const { zmkSetSlotName, zmkSlotName } = await import('../zmk.js?v=71');
    zmkSetSlotName('totem', 'tapdance', 3, 'mine');
    await td.clearSlot(3);
    eq(zmkSlotName('totem', 'tapdance', 3), '', 'tap dance delete drops its name');
}

// ---- F01: no recursion offered, a stored one shows as empty ----
{
    ok(catalog.isRecursiveOutput({ action: 3, behaviorId: TD, param1: 0 }), '&ftd is recursive');
    ok(catalog.isRecursiveOutput({ action: 3, behaviorId: FAK, param1: 1 }), '&fak is recursive');
    ok(!catalog.isRecursiveOutput({ action: 3, behaviorId: KR }) && !catalog.isRecursiveOutput({ action: 1, param1: 4 }), 'others are fine');
    for (const surf of ['zmk.tapDanceStep', 'zmk.adaptiveStep']) {
        const ids = surfaceEntries(surf, {}).map((e) => e.id);
        ok(!ids.includes('tap-dance') && !ids.includes('adaptive'), `${surf} offers neither Tap Dance nor Adaptive Key`);
    }
    const app = mkApp();
    await app.flask.setBytes(CH.tapDance, V.tdStep, encodeTdStep(0, 0, { action: 3, behaviorId: TD, param1: 1 }), 2);
    const td = stub(new ZmkTapDanceTab(app));
    await td.load();
    eq(td.slots[0].taps[0].action, 0, 'tap-dance step that is &ftd shows as empty');
    const ak = stub(new ZmkAdaptiveTab(app));
    await app.flask.setBytes(CH.adaptive, V.akFallback, [0, 3, FAK >> 8, FAK & 255, 0, 0, 0, 1, 0, 0, 0, 0], 1).catch(() => {});
    await ak.load();
    ok(!catalog.isRecursiveOutput(ak.fallback[0]), 'adaptive fallback never shows a recursive output');
    // export drops it
    const st = await exportFlaskState(app);
    ok(!st.tapDance.slots[0].taps.some(catalog.isRecursiveOutput), 'export drops a recursive tap-dance step');
}

// ---- WB-03: no modifier, no &sk / &mt ----
{
    for (const [id, p] of [['one-shot-mod', { mods: 0 }], ['mod-tap', { hold: 0, tap: 4 }]]) {
        assert.throws(() => catalog.encode(id, p, 'zmk-studio'), /at least one modifier/, id); checks++;
        assert.throws(() => catalog.encode(id, p, 'zmk-typed'), /at least one modifier/, id); checks++;
    }
    ok(catalog.encode('one-shot-mod', { mods: 0x02 }, 'zmk-typed').param1 > 0, 'with a modifier it still encodes');
}

// ---- WB-09: gesture sets 0..7 plus 255 (Imprint catalog) ----
{
    const imp = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/imprint-behaviors.json', import.meta.url)));
    setZmkContext({ behaviors: new Map(imp.behaviors.map((d) => [d.id, d])), layers: [{ id: 0, name: 'base' }] });
    const g = surfaceEntries('zmk.key', {}).find((e) => e.id === 'gesture');
    eq([g.params[0].max, g.params[0].active], [7, 255], 'gesture picker: 8 sets and the Active set value');
    eq(catalog.capParts(catalog.encode('gesture', { slot: 255 }, 'zmk-studio'), 'zmk-studio').main, 'Active', '255 reads as Active');
    setZmkContext({ behaviors, layers: [{ id: 0, name: 'base' }] });
}

// ---- WB-10: modifier keys are not offered as an adaptive trigger ----
ok(SURFACES['zmk.adaptiveTrigger'].hide.includes('mod-keys'), 'trigger surface hides the Modifiers key section');

// ---- WB-04 / cross-tab: mode apply registers channels for Save and refreshes loaded tabs ----
{
    const app = mkApp();
    const macros = stub(new ZmkMacrosTab(app));
    await macros.load();
    saveState.reset();
    await app.flask.setBytes(CH.macros, V.macrosStep, encodeMacroStep(4, 0, { action: MACRO_ACTION.tap, param: 0x70004 }), 2);
    common.announceSlots(CH.macros);
    await flush(); await flush();
    eq(macros.steps[4][0].action, MACRO_ACTION.tap, 'a whole-table announcement reloads the Macros tab');
    const { ZmkModesTab } = await import('../zmk-modes-tab.js?v=71');
    const modes = stub(new ZmkModesTab(app));
    modes._keymapTab = () => ({ applyKeymapData: async () => ({}) });
    modes.store = { modes: [{ id: 'm1', name: 'Mode', data: { kind: 'flask-zmk-keymap', layers: [],
        flask: { macros: { slots: [[{ action: MACRO_ACTION.tap, param: 0x70005 }]] } } } }], baselineId: null };
    saveState.reset();
    modes.applyLive('m1');
    for (let k = 0; k < 20 && !saveState.dirty().length; k++) await flush();
    ok(saveState.dirty().some((d) => d.source === CH.macros), 'Apply live registers the written channel so Save persists it');
    await flush(); await flush();
    eq(macros.steps[0][0].param, 0x70005, 'and the loaded Macros tab shows the mode\'s table');
    eq(modeSummary({ data: { layers: [], flask: { adaptive: {}, customShift: {} } } }), '0 layers · shift keys, adaptive keys', 'WB-16 summary names adaptive / shift keys');
}

// ---- WB-05: behavior outputs carry names and resolve by name ----
{
    const app = mkApp();
    await app.flask.setBytes(CH.adaptive, V.akStep, encodeAkStep(40, 0, { action: 1, param1: 0x70004 }), 2);
    await app.flask.setBytes(CH.adaptive, V.akRule, encodeAkRule(40, { set: 0, trigger: 0x0007001A }), 1);
    await app.flask.setBytes(CH.adaptive, V.akStep, encodeAkStep(40, 1, { action: 3, behaviorId: SK, param1: 0x700E1 }), 2);
    const st = await exportFlaskState(app);
    const r40 = st.adaptive.rules.find((r) => r.index === 40);
    eq(r40.steps[1].behavior, 'Sticky Key', 'adaptive step carries the behavior name');
    ok(st.adaptive.fallback.some((o) => o.action === 3 && o.behavior), 'adaptive fallback carries it');
    ok(st.combos.slots.some((s) => s.action === 3 && s.behavior), 'combo outputs carry it');
    eq(namedOut({ action: 1, param1: 4 }), { action: 1, param1: 4 }, 'usage outputs stay as they were');
    // a file whose ids are stale: the name wins
    const file = JSON.parse(JSON.stringify(st));
    file.adaptive.rules.find((r) => r.index === 40).steps[1].behaviorId = KR;      // wrong id, right name
    const b = mkApp();
    const res = await applyFlaskState(b, file);
    eq(res.failures, [], 'applies cleanly');
    eq(decodeAkStep(await b.flask.getBytes(CH.adaptive, V.akStep, [40, 1], 2)).behaviorId, SK, 'resolved by name, not by the stale id');
    // no name -> the id is used; an unknown name -> the output is dropped
    eq(resolveOut({ action: 3, behaviorId: 7, param1: 1 }), { action: 3, behaviorId: 7, param1: 1 }, 'no name: id kept');
    eq(resolveOut({ action: 3, behaviorId: 7, behavior: 'Nope' }), null, 'unknown name: unresolved');
    const file2 = JSON.parse(JSON.stringify(st));
    file2.adaptive.rules.find((r) => r.index === 40).steps[1].behavior = 'No Such Behavior';
    const c = mkApp();
    const res2 = await applyFlaskState(c, file2);
    eq(res2.unresolved >= 1, true, 'counted');
    eq(decodeAkStep(await c.flask.getBytes(CH.adaptive, V.akStep, [40, 1], 2)).action, 0, 'unresolvable behavior output applied as empty');
}

// ---- WB-07 combos: timing set before the output survives the echo ----
{
    const app = mkApp();
    const combos = stub(new ZmkCombosTab(app));
    await combos.load();
    const i = combos.slots.findIndex((s) => !s.positions.length && !s.action);
    combos.slots[i] = { ...combos.emptySlot(i), positions: [40, 41], timeoutMs: 120, priorIdleMs: 50, layer: 2 };
    await combos.writeSlot(i);
    eq([combos.slots[i].timeoutMs, combos.slots[i].priorIdleMs, combos.slots[i].layer], [120, 50, 2], 'draft timing kept after an output-less write');
    Object.assign(combos.slots[i], { action: 1, param1: 0x70004 });
    await combos.writeSlot(i);
    eq([combos.slots[i].timeoutMs, combos.slots[i].layer], [120, 2], 'and written with the output');
}

// ---- WB-14 leader: a refused write restores the card ----
{
    const app = mkApp();
    const leader = stub(new ZmkLeaderTab(app));
    await leader.load();
    const real = app.flask.setBytes.bind(app.flask);
    app.flask.setBytes = async () => { throw new Error('timeout'); };
    await leader.edit(0, { positions: [1, 2, 3] });
    app.flask.setBytes = real;
    const stored = leader.slots[0].positions.join();
    ok(stored !== '1,2,3', 'refused leader edit not kept in the cache');
}

// ---- Perf: hold-tap slot info is read once per connection ----
{
    const app = mkApp();
    const be = catalog.holdtapBackend(app.flask, { slotCount: 6 });
    const n = reads(app);
    await be.slots();
    const first = n.get;
    await be.slots();
    eq([first, n.get], [6, 6], 'second slots() reads nothing');
}

// ---- Perf: slot / step counts are read once per connection ----
{
    const app = mkApp();
    const n = reads(app);
    await common.dim(app, CH.macros, V.macrosSlotCount);
    await common.dim(app, CH.macros, V.macrosSlotCount);
    eq(n.get, 1, 'dim() caches per flask client');
    const td = stub(new ZmkTapDanceTab(app));
    const before = n.get;
    await td.load();
    const second = n.get;
    await td.load();
    ok(n.get - second < second - before, 'Reload skips the count reads');
}

console.log(`behaviours-fix-test: ${checks} checks OK`);
