// flask_adaptive (channel 0x2B, proto v18, Totem): the contract's wire vectors
// (.workflow/scratch/flask-adaptive-contract.md §2) through the codec and the
// offline sim, text <-> usages, journal replay, export/import round trip, and
// the generator's flask,adaptive-defaults parser on a fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    AK_ACTION, encodeAkRule, decodeAkRule, encodeAkStep, decodeAkStep, encodeAkFallback, decodeAkFallback,
    akRuleIsEmpty, akRuleIsLive, akSeqLength, textToUsages, usagesToText,
} from '../zmk-adaptive-codec.js?v=62';
import { CH, V } from '../flaskproto.js?v=62';
import { zmkCapabilities } from '../zmk.js?v=62';
import { createZmkTemplate, ZmkOfflineFlask, adaptiveTable, zmkSyncExtras, zmkPendingCount,
         zmkClearDirty, normalizeZmkWorkspace } from '../zmk-offline.js?v=62';
import { exportFlaskState, applyFlaskState } from '../zmk-export.js?v=62';
import { parseKeymap, generate } from '../gen-totem-default.mjs';
import { TOTEM_DEFAULT } from '../zmk-totem-default.js?v=62';
import { exportKeymapText } from '../zmk-dt-export.js?v=62';
import * as catalog from '../behavior-catalog.js?v=62';
import { setZmkContext } from '../zmk-keycodes.js?v=62';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };
const hex = (s) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));
const mem = new Map();
globalThis.localStorage ??= {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
};
const throwsUnhandled = async (fn, m) => {
    await assert.rejects(fn, (e) => e.message === 'unhandled', m); checks++;
};

// ---- fixture: the Totem keymap's ak nodes + &fak + flask,adaptive-defaults ----
const fx = parseKeymap(readFileSync(new URL('./fixtures/adaptive-keymap.dts', import.meta.url), 'utf8'));
const KR = fx.behaviors.find((b) => b.node === 'key_repeat').id;
const SK = fx.behaviors.find((b) => b.node === 'sk').id;
eq(fx.unsupported, [], 'fixture translates fully');
eq(fx.adaptive.rules.length, 35, 'section 4 table: 35 rules');
eq(fx.adaptive.rules.filter((r) => r.set === 0).length, 24, 'set 0 = ak_rti: rules 0-23');
eq(fx.adaptive.rules.slice(0, 24).every((r) => r.set === 0 && r.maxIdleMs === 500), true, 'rti rules: 500 ms');
eq(fx.adaptive.rules.slice(24).every((r) => r.set === 1 && r.maxIdleMs === 0), true, 'alt rules 24-34: set 1, no idle');
eq(fx.adaptive.fallback, [{ action: 3, behaviorId: KR, param1: 0, param2: 0 }, { action: 3, behaviorId: KR, param1: 0, param2: 0 }],
    'fallback 0 and 1 = &key_repeat');
eq(fx.adaptive.rules[19].steps, [{ action: 1, behaviorId: 0, param1: 0x7002C, param2: 0 },
    { action: 3, behaviorId: SK, param1: 0x700E1, param2: 0 }], 'rti_sentence DOT = SPACE + &sk LSHFT');
eq(fx.adaptive.rules[20].trigger, 0x02070038, 'QMARK = LS(FSLH)');
eq(fx.adaptive.rules[1].steps.length, 6, 'ECAUSE: 6 steps');
eq(fx.adaptive.rules[24].trigger, 0x00070050, 'alt_left trigger LEFT');
eq(fx.behaviors.find((b) => b.node === 'fak').metadata[0].param1[0], { name: 'Adaptive set', kind: 'range', min: 0, max: 3 },
    'zmk,behavior-flask-adaptive metadata = set range 0..3');
ok(generate(readFileSync(new URL('./fixtures/adaptive-keymap.dts', import.meta.url), 'utf8'), 'fx').includes('"adaptive":{'),
    'generate() emits the adaptive table');
// Stock ids are stable between the fixture and the committed Totem catalog (the sim uses the latter).
eq([KR, SK], [TOTEM_DEFAULT.behaviors.find((b) => b.node === 'key_repeat').id, TOTEM_DEFAULT.behaviors.find((b) => b.node === 'sk').id],
    'key_repeat / sk ids match zmk-totem-default.js');
// A keymap without the node must not grow an `adaptive` key (old firmware commits regenerate byte-identically).
eq('adaptive' in parseKeymap('/ { keymap { compatible = "zmk,keymap"; base { bindings = <&kp A>; }; }; };'), false);

// ---- 1. codec: every contract frame round-trips byte-exact -------------------
{
    // payload = frame bytes 3+ (the address prefix is the first byte(s)).
    const rule1 = hex('01 00 00 07 00 05 01 F4 00');
    eq(decodeAkRule(rule1), { rule: 1, set: 0, trigger: 0x00070005, maxIdleMs: 500, strict: false });
    eq(encodeAkRule(1, decodeAkRule(rule1)), rule1, 'rule 1 (rti_b: B within 500 ms)');
    const rule20 = hex('14 00 02 07 00 38 01 F4 00');
    eq(decodeAkRule(rule20).trigger, 0x02070038); eq(encodeAkRule(20, decodeAkRule(rule20)), rule20, 'rule 20 QMARK');
    const rule24 = hex('18 01 00 07 00 50 00 00 00');
    eq(decodeAkRule(rule24), { rule: 24, set: 1, trigger: 0x00070050, maxIdleMs: 0, strict: false });
    eq(encodeAkRule(24, decodeAkRule(rule24)), rule24, 'rule 24 (ak_alt LEFT, no idle)');
    eq(encodeAkRule(40, { set: 0, trigger: 0x0007001A, maxIdleMs: 500 }), hex('28 00 00 07 00 1A 01 F4 00'), 'SET rule 40');
    eq(encodeAkRule(40, { set: 0, trigger: 0x0007001A, maxIdleMs: 20000 }), hex('28 00 00 07 00 1A 4E 20 00'), 'idle 20000 as sent');
    eq(encodeAkRule(40, { strict: true })[8], 1, 'flags bit0 = exact mods');
    eq(encodeAkRule(40, {}), hex('28 00 00 00 00 00 00 00 00'), 'DELETE rule 40');

    const step = hex('01 00 01 00 00 00 07 00 08 00 00 00 00');
    eq(decodeAkStep(step), { rule: 1, step: 0, action: 1, behaviorId: 0, param1: 0x70008, param2: 0 });
    eq(encodeAkStep(1, 0, decodeAkStep(step)), step, 'rule 1 step 0 (&kp E)');
    const sk = hex('13 01 03 12 34 00 07 00 E1 00 00 00 00');
    eq(decodeAkStep(sk).behaviorId, 0x1234); eq(encodeAkStep(19, 1, decodeAkStep(sk)), sk, 'behavior step: id u16 BE');
    eq(encodeAkStep(40, 0, { action: 1, param1: 0x7000B }), hex('28 00 01 00 00 00 07 00 0B 00 00 00 00'), 'SET rule 40 step 0 = H');

    const fb = hex('00 03 00 0D 00 00 00 00 00 00 00 00');
    eq(decodeAkFallback(fb), { set: 0, action: 3, behaviorId: 13, param1: 0, param2: 0 });
    eq(encodeAkFallback(0, decodeAkFallback(fb)), fb, 'fallback set 0 (&key_repeat)');
    eq(encodeAkFallback(2, {}), hex('02 00 00 00 00 00 00 00 00 00 00 00'), 'fallback set 2 (none)');

    ok(akRuleIsEmpty({ trigger: 0 }) && !akRuleIsEmpty({ trigger: 5 }), 'empty = no trigger');
    const steps = [{ action: 1 }, { action: 3 }, { action: 0 }, { action: 1 }];
    eq(akSeqLength(steps), 2, 'output = contiguous prefix up to the first NONE');
    ok(akRuleIsLive({ trigger: 5, steps }) && !akRuleIsLive({ trigger: 5, steps: [{ action: 0 }] })
        && !akRuleIsLive({ trigger: 0, steps }), 'live = trigger and step 0');
}

// ---- 2. text <-> usages -----------------------------------------------------
{
    const u = textToUsages('ecause');
    eq(u.length, 6); eq(u[0], 0x70008, 'e'); eq(u[5], 0x70008, 'e again');
    eq(textToUsages('Hi!'), [0x02070000 | 0x0B, 0x70000 | 0x0C, 0x02070000 | 0x1E], 'H = LS(H), i, ! = LS(N1)');
    eq(textToUsages('é'), null, 'non-ASCII refused'); eq(textToUsages('a\nb'), null, 'newline refused');
    eq(textToUsages('a b'), [0x70004, 0x7002C, 0x70005], 'space');
    eq(textToUsages('?'), [0x02070038], '? = LS(FSLH)');
    for (const t of ['ecause', 'Hello, World! 0123456789', '~`!@#$%^&*()_+-={}[]|\\:";\'<>?,./']) {
        eq(usagesToText(textToUsages(t).map((p) => ({ action: 1, param1: p }))), t, `inverse: ${t}`);
    }
    eq(usagesToText([{ action: 1, param1: 0x700E1 }]), null, 'a bare shift key is not text');
    eq(usagesToText([{ action: 3, param1: 0 }]), null, 'a behavior step is not text');
    eq(usagesToText([{ action: 1, param1: 0x20070004 }]), 'A', 'right shift reads as shift');
    eq(usagesToText([]), '', 'empty');
}

// ---- 3. offline sim ---------------------------------------------------------
// &fak's id: the generated catalog's once it carries the node, else a fake extra.
const FAK = TOTEM_DEFAULT.behaviors.find((d) => d.displayName === 'Adaptive Key')?.id ?? 900;
const mkWs = () => {
    const ws = createZmkTemplate('totem');
    ws.zmk.adaptive = adaptiveTable(fx.adaptive);
    if (FAK === 900) ws.zmk.extraBehaviors = { 900: { id: 900, displayName: 'Adaptive Key', metadata: [], node: 'fak' } };
    return ws;
};
{
    const ws = mkWs();
    const f = new ZmkOfflineFlask(ws);
    eq(await f.getU16(CH.adaptive, V.akEnabled), 1, 'boots enabled');
    eq(await f.getU16(CH.adaptive, V.akSetCount), 4); eq(await f.getU16(CH.adaptive, V.akRuleCount), 64);
    eq(await f.getU16(CH.adaptive, V.akStepCount), 6);
    let live = 0;
    for (let i = 0; i < 64; i++) if (decodeAkRule(await f.getBytes(CH.adaptive, V.akRule, [i])).trigger) live++;
    eq(live, 35, 'totem seeds 35 rules');
    eq((await f.getBytes(CH.adaptive, V.akRule, [1])).slice(0, 9), hex('01 00 00 07 00 05 01 F4 00'), 'GET rule 1');
    eq((await f.getBytes(CH.adaptive, V.akStep, [1, 0])).slice(0, 13), hex('01 00 01 00 00 00 07 00 08 00 00 00 00'), 'GET rule 1 step 0');
    eq((await f.getBytes(CH.adaptive, V.akStep, [19, 1])).slice(0, 13),
        [19, 1, 3, 0, SK, 0, 7, 0, 0xE1, 0, 0, 0, 0], 'GET rule 19 step 1 (&sk LSHFT)');
    eq((await f.getBytes(CH.adaptive, V.akRule, [20])).slice(0, 9), hex('14 00 02 07 00 38 01 F4 00'), 'GET rule 20');
    eq((await f.getBytes(CH.adaptive, V.akRule, [24])).slice(0, 9), hex('18 01 00 07 00 50 00 00 00'), 'GET rule 24');
    eq((await f.getBytes(CH.adaptive, V.akFallback, [0])).slice(0, 12), [0, 3, 0, KR, 0, 0, 0, 0, 0, 0, 0, 0], 'GET fallback 0');
    eq((await f.getBytes(CH.adaptive, V.akFallback, [2])).slice(0, 12), hex('02 00 00 00 00 00 00 00 00 00 00 00'), 'GET fallback 2 (none)');
    await throwsUnhandled(() => f.getBytes(CH.adaptive, V.akStep, [1, 6]), 'step >= STEPS');
    await throwsUnhandled(() => f.getBytes(CH.adaptive, V.akRule, [64]), 'rule >= RULES');
    await throwsUnhandled(() => f.getBytes(CH.adaptive, V.akFallback, [4]), 'fallback set >= SETS');
    await throwsUnhandled(() => f.setU16(CH.adaptive, V.akSetCount, 9), 'counts are read-only');
    eq(await f.setU16(CH.adaptive, V.akEnabled, 0), 0); eq(await f.getU16(CH.adaptive, V.akEnabled), 0, 'enabled SET');

    // SET vectors
    eq(await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 07 00 1A 01 F4 00')), hex('28 00 00 07 00 1A 01 F4 00'), 'SET rule 40');
    eq(await f.setBytes(CH.adaptive, V.akStep, hex('28 00 01 00 00 00 07 00 0B 00 00 00 00')),
        hex('28 00 01 00 00 00 07 00 0B 00 00 00 00'), 'SET rule 40 step 0');
    eq(await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 07 00 1A 4E 20 00')), hex('28 00 00 07 00 1A 27 10 00'), 'idle 20000 clamps to 10000');
    eq((await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 00 00 1A 01 F4 02')))[3], 7, 'page 0 -> 7');
    eq((await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 07 00 1A 01 F4 03')))[8], 1, 'flags: only bit0 (exact mods) is kept');
    await throwsUnhandled(() => f.setBytes(CH.adaptive, V.akRule, hex('28 09 00 07 00 1A 01 F4 00')), 'set 9 >= SETS refused');
    await throwsUnhandled(() => f.setBytes(CH.adaptive, V.akRule, hex('40 00 00 07 00 1A 01 F4 00')), 'rule >= RULES refused');
    await throwsUnhandled(() => f.setBytes(CH.adaptive, V.akStep, hex('28 06 01 00 00 00 07 00 0B 00 00 00 00')), 'step >= STEPS refused');
    eq(await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 00 00 00 00 00 00')), hex('28 00 00 00 00 00 00 00 00'), 'DELETE echoes zeros');
    eq((await f.getBytes(CH.adaptive, V.akStep, [40, 0])).slice(0, 13), hex('28 00 00 00 00 00 00 00 00 00 00 00 00'), 'delete zeroed the steps');
    // trigger 0 with a bad set still deletes (set is only checked for a live trigger)
    eq((await f.setBytes(CH.adaptive, V.akRule, hex('05 09 00 00 00 00 00 00 00'))).slice(1), hex('00 00 00 00 00 00 00 00'), 'delete ignores set');
    eq((await f.getBytes(CH.adaptive, V.akRule, [5])).slice(1, 6), [0, 0, 0, 0, 0], 'rule 5 deleted');
    // step / fallback normalization = flask_tapdance_output_set, plus &fak itself -> NONE (no recursion)
    const norm = async (o) => decodeAkStep(await f.setBytes(CH.adaptive, V.akStep, encodeAkStep(41, 0, o)));
    const out = (action, behaviorId, param1, param2) => ({ rule: 41, step: 0, action, behaviorId, param1, param2 });
    eq(await norm({ action: 9, param1: 5 }), out(0, 0, 0, 0), 'action > 3 -> NONE');
    eq(await norm({ action: 1, param1: 0 }), out(0, 0, 0, 0), 'usage with p1 0 -> NONE');
    eq(await norm({ action: 1, behaviorId: 7, param1: 0x70004, param2: 3 }), out(1, 0, 0x70004, 0), 'usage zeroes behavior and p2');
    eq(await norm({ action: 2, behaviorId: 7, param1: 5, param2: 3 }), out(2, 0, 5, 0), 'macro zeroes behavior and p2');
    eq(await norm({ action: 3, behaviorId: 13, param1: 1, param2: 2 }), out(3, 13, 1, 2), 'other behaviors pass through');
    eq(await norm({ action: 3, behaviorId: FAK, param1: 1 }), out(0, 0, 0, 0), 'a step that is &fak itself -> NONE');
    const fbo = async (o) => decodeAkFallback(await f.setBytes(CH.adaptive, V.akFallback, encodeAkFallback(3, o)));
    eq(await fbo({ action: 3, behaviorId: FAK }), { set: 3, action: 0, behaviorId: 0, param1: 0, param2: 0 }, 'fallback &fak -> NONE');
    eq((await fbo({ action: 3, behaviorId: 13 })).behaviorId, 13, 'fallback keeps other behaviors');

    // imprint: no module, the probe answers unhandled
    const imp = new ZmkOfflineFlask(createZmkTemplate('imprint'));
    await throwsUnhandled(() => imp.getU16(CH.adaptive, V.akSetCount), 'imprint answers unhandled -> no tab');
    await throwsUnhandled(() => imp.getBytes(CH.adaptive, V.akRule, [0]));
    await throwsUnhandled(() => imp.setBytes(CH.adaptive, V.akRule, hex('00 00 00 07 00 04 00 00 00')));
    eq(createZmkTemplate('imprint').zmk.adaptive, undefined, 'no table on the imprint workspace');
    // a totem template without generated data still serves the module, empty
    const bare = new ZmkOfflineFlask(createZmkTemplate('totem'));
    eq(await bare.getU16(CH.adaptive, V.akSetCount), 4, 'totem always serves the module');
    // stored older totem workspace gains the table
    const old = createZmkTemplate('totem'); delete old.zmk.adaptive; delete old.zmkDirty.akRule;
    normalizeZmkWorkspace(old);
    eq(old.zmk.adaptive.rules.length, 64); eq(old.zmkDirty.akRule, {});
}

// ---- 4. journaled edits replay on connect ------------------------------------
{
    const ws = mkWs();
    const f = new ZmkOfflineFlask(ws);
    await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 07 00 1A 01 F4 00'));
    await f.setBytes(CH.adaptive, V.akStep, hex('28 00 01 00 00 00 07 00 0B 00 00 00 00'));
    await f.setBytes(CH.adaptive, V.akRule, hex('01 00 00 00 00 00 00 00 00'));       // delete default rule 1
    await f.setBytes(CH.adaptive, V.akFallback, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // clear fallback 1
    await f.setU16(CH.adaptive, V.akEnabled, 0);
    eq(zmkPendingCount(ws), 3, 'rule 40, rule 1 and fallback 1 queue under akRule');
    eq(Object.keys(ws.zmkDirty.akRule).sort(), ['1', '40', 'f1']);

    const sent = [], saved = [];
    const app = { flask: {
        setBytes: async (c, i, p) => { sent.push([c, i, ...p]); return p; },
        save: async (c) => { saved.push(c); },
    } };
    const r = await zmkSyncExtras(app, ws);
    eq(r.failures, [], 'no failures'); eq(zmkPendingCount(ws), 0, 'journal drained');
    const headers = sent.filter((s) => s[1] === V.akRule);
    eq(headers.map((s) => s[2]).sort((a, b) => a - b), [1, 40], 'rule headers replayed');
    eq(headers.find((s) => s[2] === 1).slice(3), [0, 0, 0, 0, 0, 0, 0, 0], 'deleted default replays as trigger 0');
    eq(sent.filter((s) => s[1] === V.akStep && s[2] === 40).length, 6, 'a live rule replays every step');
    eq(sent.filter((s) => s[1] === V.akStep && s[2] === 1).length, 0, 'a deleted rule replays no steps');
    eq(sent.filter((s) => s[1] === V.akFallback).length, 1, 'fallback replays');
    ok(saved.includes(CH.adaptive), 'channel 0x2B saved after replay');
    ok(ws.dirty.tun[`${CH.adaptive}:${V.akEnabled}`], 'the enabled switch rides the tunable journal');

    // A device without the module answers unhandled: those entries are dropped, not retried forever.
    await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 07 00 1A 01 F4 00'));
    const none = { flask: { setBytes: async () => { throw new Error('unhandled'); }, save: async () => {} } };
    const r2 = await zmkSyncExtras(none, ws);
    eq([r2.failures.length, zmkPendingCount(ws)], [0, 0], 'unhandled drops the entry');
    // A transport failure stays queued.
    await f.setBytes(CH.adaptive, V.akRule, hex('28 00 00 07 00 1A 01 F4 00'));
    const flaky = { flask: { setBytes: async () => { throw new Error('timeout'); }, save: async () => {} } };
    const r3 = await zmkSyncExtras(flaky, ws);
    eq([r3.failures.length, zmkPendingCount(ws)], [1, 1], 'timeout stays queued');
    zmkClearDirty(ws); eq(zmkPendingCount(ws), 0, 'Discard clears akRule too');
}

// ---- 5. export -> import round trip through the sim, with a deleted default ----
{
    const mkApp = () => {
        const ws = mkWs();
        return { ws, flask: new ZmkOfflineFlask(ws), profile: { family: 'totem' },
            caps: { ...zmkCapabilities('totem', 18), adaptive: true }, protocolVersion: 18 };
    };
    const a = mkApp();
    await a.flask.setBytes(CH.adaptive, V.akRule, hex('03 00 00 00 00 00 00 00 00'));      // delete default rule 3
    await a.flask.setBytes(CH.adaptive, V.akRule, hex('28 01 00 07 00 1A 00 64 01'));      // new rule 40 in set 1, exact mods
    await a.flask.setBytes(CH.adaptive, V.akStep, hex('28 00 02 00 00 00 00 00 07 00 00 00 00'));  // macro slot 7
    await a.flask.setBytes(CH.adaptive, V.akFallback, [2, 1, 0, 0, 0x00, 0x07, 0x00, 0x2C, 0, 0, 0, 0]);
    await a.flask.setU16(CH.adaptive, V.akEnabled, 0);
    const state = await exportFlaskState(a);
    eq(state.adaptive.enabled, 0);
    eq(state.adaptive.rules.length, 35, '35 live rules (one default deleted, one added)');
    ok(!state.adaptive.rules.some((r) => r.index === 3), 'deleted default is absent from the file');
    eq(state.adaptive.rules.find((r) => r.index === 40),
        { index: 40, set: 1, trigger: 0x7001A, maxIdleMs: 100, strict: true, steps: [{ action: 2, behaviorId: 0, param1: 7, param2: 0 }] });
    eq(state.adaptive.fallback[2], { action: 1, behaviorId: 0, param1: 0x7002C, param2: 0 });
    eq(JSON.parse(JSON.stringify(state.adaptive)), state.adaptive, 'JSON-safe');

    const b = mkApp();      // fresh device: still has default rule 3 and no rule 40
    const res = await applyFlaskState(b, state);
    eq(res.failures, [], 'import applies cleanly');
    ok(res.channels.includes(CH.adaptive), 'import SAVEs channel 0x2B');
    const dump = async (app) => {
        const out = [];
        for (let i = 0; i < 64; i++) {
            const h = decodeAkRule(await app.flask.getBytes(CH.adaptive, V.akRule, [i]));
            const steps = [];
            if (h.trigger) for (let s = 0; s < 6; s++) steps.push(decodeAkStep(await app.flask.getBytes(CH.adaptive, V.akStep, [i, s])));
            out.push({ ...h, steps });
        }
        return out;
    };
    eq(await dump(b), await dump(a), 'imported table equals the exported one');
    eq(await b.flask.getU16(CH.adaptive, V.akEnabled), 0, 'enabled restored');
    eq(decodeAkFallback(await b.flask.getBytes(CH.adaptive, V.akFallback, [2])).param1, 0x7002C, 'fallback restored');
    eq(decodeAkRule(await b.flask.getBytes(CH.adaptive, V.akRule, [3])).trigger, 0, 'the deleted default stays deleted');
    // a device without the module skips the section
    const noMod = mkApp(); noMod.caps = { ...noMod.caps, adaptive: false };
    eq((await exportFlaskState(noMod)).adaptive, undefined, 'no adaptive section without caps.adaptive');
}

// ---- 6. catalog + DT export -------------------------------------------------
{
    const e = catalog.entryById('adaptive');
    eq([e.group, e.name, e.params.map((p) => p.key)], ['run', 'Adaptive key', ['slot']]);
    const imp = JSON.parse(readFileSync(new URL('./fixtures/imprint-behaviors.json', import.meta.url)));
    setZmkContext({ behaviors: new Map([...imp.behaviors, { id: 900, displayName: 'Adaptive Key',
        metadata: [{ param1: [{ name: 'Adaptive set', kind: 'range', min: 0, max: 3 }], param2: [] }] }].map((d) => [d.id, d])),
    layers: [{ id: 0, name: 'base' }] });
    const b = { behaviorId: 900, param1: 2, param2: 0 };
    eq(catalog.decode(b), { entryId: 'adaptive', params: { slot: 2 } }, '&fak 2 decodes to the Adaptive entry');
    eq(catalog.encode('adaptive', { slot: 2 }, 'zmk-studio'), b, 'and encodes back');
    eq(catalog.capParts(b), { top: '', main: 'AK2' }, 'keycap AK2');
    const t = exportKeymapText({ family: 'totem', layers: [{ name: 'base', bindings: [
        { behavior: 'Adaptive Key', behaviorId: 900, param1: 1, param2: 0 }] }],
    flask: { adaptive: { enabled: 1, fallback: [], rules: [{ index: 0, set: 0, trigger: 1, steps: [] }] } } }, {});
    ok(t.text.includes('&fak 1'), '&fak N writes as the firmware node');
    ok(t.notExported.some((n) => n.startsWith('adaptive keys: 1 flask_adaptive rule')), 'live rules are listed as not exported');
}

// ---- 7. the committed Totem default (present once the generator ran on the adaptive keymap) ----
if (TOTEM_DEFAULT.adaptive) {
    eq(TOTEM_DEFAULT.adaptive.rules.length, 35, 'zmk-totem-default.js carries the 35-rule table');
    eq(TOTEM_DEFAULT.unsupported, [], 'nothing untranslated');
    eq(createZmkTemplate('totem').zmk.adaptive.rules.filter((r) => r.trigger).length, 35, 'a fresh Totem workspace seeds it');
} else {
    console.log('adaptive-test: NOTE zmk-totem-default.js has no adaptive table yet (regenerate: node gen-totem-default.mjs)');
}

console.log(`adaptive-test: ${checks} checks OK`);
