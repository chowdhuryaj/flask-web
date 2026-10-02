// flask_autoshift (channel 0x2C, proto v19, Totem): the contract's wire vectors
// (.workflow/scratch/flask-autoshift-contract.md §3) through the codec and the
// offline sim, defaults, unhandled on imprint, journal replay, export round trip.
import assert from 'node:assert/strict';
import {
    ASH_GROUPS, ASH_DEFAULTS, clampAshTimeout, clampRetroLimit, clampAshGroups, ashEligible,
} from '../zmk-autoshift-codec.js?v=62';
import { CH, V, CMD, FlaskProto } from '../flaskproto.js?v=62';
import { zmkCapabilities } from '../zmk.js?v=62';
import { createZmkTemplate, ZmkOfflineFlask, normalizeZmkWorkspace } from '../zmk-offline.js?v=62';
import { syncWorkspace, pendingCount } from '../offline.js?v=62';
import { exportFlaskState, applyFlaskState } from '../zmk-export.js?v=62';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };
const mem = new Map();
globalThis.localStorage ??= {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
};
const throwsUnhandled = async (fn, m) => {
    await assert.rejects(fn, (e) => e.message === 'unhandled', m); checks++;
};

// ---- 1. wire constants + frames (FlaskProto against a scripted device) ----
eq([CH.autoShift, V.ashEnabled, V.ashTimeout, V.ashGroups, V.ashModifiers, V.ashRepeat, V.ashNoAutoRepeat, V.ashRetro, V.ashRetroLimit],
    [0x2C, 1, 2, 3, 4, 5, 6, 7, 8]);
{
    const sent = [];
    const reply = { // request -> device reply, rest of frame 0 (contract §3 vectors)
        '08 2C 02': [0x08, 0x2C, 0x02, 0x00, 0xAF],
        '07 2C 02 00 14': [0x07, 0x2C, 0x02, 0x00, 0x32],
        '07 2C 02 05 DC': [0x07, 0x2C, 0x02, 0x03, 0xE8],
        '07 2C 03 FF FF': [0x07, 0x2C, 0x03, 0x00, 0x1F],
        '08 2C 08': [0x08, 0x2C, 0x08, 0x01, 0xF4],
        '07 2C 08 23 28': [0x07, 0x2C, 0x08, 0x13, 0x88],
        '08 2C 09': [0xFF, 0x2C, 0x09],
    };
    const fp = new FlaskProto({ request: async (f) => {
        const key = [...f].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        sent.push(key);
        const r = reply[Object.keys(reply).find((k) => key.startsWith(k))];
        return r ?? [0xFF, f[1], f[2]];
    } });
    eq(await fp.getU16(CH.autoShift, V.ashTimeout), 175, 'GET timeout');
    eq(await fp.setU16(CH.autoShift, V.ashTimeout, 20), 50, 'SET 20 echoes 50');
    eq(await fp.setU16(CH.autoShift, V.ashTimeout, 1500), 1000, 'SET 1500 echoes 1000');
    eq(await fp.setU16(CH.autoShift, V.ashGroups, 0xFFFF), 0x1F, 'groups 0xFFFF echoes 0x1F');
    eq(await fp.getU16(CH.autoShift, V.ashRetroLimit), 500, 'GET retro limit');
    eq(await fp.setU16(CH.autoShift, V.ashRetroLimit, 9000), 5000, 'limit 9000 echoes 5000');
    await throwsUnhandled(() => fp.getU16(CH.autoShift, 9), 'unknown id -> FF -> unhandled');
    eq(sent.slice(0, 2), ['08 2C 02', '07 2C 02 00 14'], 'frames are [cmd, 0x2C, id, u16 BE]');
}

// ---- 2. codec ----
eq([clampAshTimeout(20), clampAshTimeout(1500), clampAshTimeout(175)], [50, 1000, 175]);
eq([clampRetroLimit(0), clampRetroLimit(20), clampRetroLimit(9000), clampRetroLimit(500)], [0, 50, 5000, 500]);
eq([clampRetroLimit(''), clampRetroLimit(undefined)], [0, 0], 'blank = no limit');
eq(clampAshGroups(0xFFFF), 0x1F, 'groups mask');
eq(ASH_GROUPS, { alpha: 1, numeric: 2, symbols: 4, tab: 8, enter: 16 });
{
    const g = 0x0F, A = 0x70004, N1 = 0x7001E, COMMA = 0x70036, TAB = 0x7002B, ENTER = 0x70028;
    ok(ashEligible(A, g) && ashEligible(N1, g) && ashEligible(COMMA, g) && ashEligible(TAB, g), 'A / 1 / comma / TAB at 0x0F');
    ok(!ashEligible(ENTER, g), 'ENTER not at 0x0F'); ok(ashEligible(ENTER, 0x1F), 'ENTER at 0x1F');
    ok(!ashEligible(0x02070004, g), 'LS(A) never');
    ok(!ashEligible(0x0C00E9, g), 'consumer page never');
    ok(ashEligible(0x04, g) && ashEligible(0x04, g) === ashEligible(A, g), 'page 0 = page 7');
    ok(!ashEligible(A, 0x0E), 'alpha off'); ok(!ashEligible(COMMA, 0x0B), 'symbols off');
    ok(ashEligible(0x70064, 4) && ashEligible(0x70038, 4) && !ashEligible(0x70039, 4), 'symbols range 2D-38 + 64 (CapsLock 39 is not one)');
}

// ---- 3. offline sim ----
const mkApp = (family = 'totem') => {
    const ws = createZmkTemplate(family);
    return { ws, flask: new ZmkOfflineFlask(ws), profile: { family },
        caps: { ...zmkCapabilities(family, 19), autoshift: family === 'totem' }, protocolVersion: 19 };
};
{
    const a = mkApp();
    eq(a.ws.protocolVersion, 19, 'the unplugged Totem answers v19 so the tab can be tried');
    const get = (id) => a.flask.getU16(CH.autoShift, id);
    eq([await get(1), await get(2), await get(3), await get(4), await get(5), await get(6), await get(7), await get(8)],
        [0, 175, 0x0F, 0, 0, 0, 1, 500], 'contract defaults');
    eq(await a.flask.setU16(CH.autoShift, V.ashEnabled, 5), 1, 'enabled 5 -> 1');
    eq(await a.flask.setU16(CH.autoShift, V.ashTimeout, 20), 50);
    eq(await a.flask.setU16(CH.autoShift, V.ashTimeout, 1500), 1000);
    eq(await a.flask.setU16(CH.autoShift, V.ashGroups, 0xFFFF), 0x1F);
    eq(await a.flask.setU16(CH.autoShift, V.ashRetroLimit, 0), 0, 'limit 0 = no limit');
    eq(await a.flask.setU16(CH.autoShift, V.ashRetroLimit, 20), 50);
    eq(await a.flask.setU16(CH.autoShift, V.ashRetroLimit, 9000), 5000);
    eq(await a.flask.setU16(CH.autoShift, V.ashRepeat, 3), 1);
    eq(await get(V.ashTimeout), 1000, 'GET returns the applied value');
    await throwsUnhandled(() => get(9), 'unknown id');
    await throwsUnhandled(() => a.flask.setU16(CH.autoShift, 9, 1), 'unknown id SET');

    const imp = mkApp('imprint');
    await throwsUnhandled(() => imp.flask.getU16(CH.autoShift, V.ashTimeout), 'imprint: probe false');
    await throwsUnhandled(() => imp.flask.setU16(CH.autoShift, V.ashEnabled, 1), 'imprint: SET refused');
    ok(!Object.keys(imp.ws.tunables).some((k) => k.startsWith(`${CH.autoShift}:`)), 'no autoshift tunables on imprint');
    eq(imp.ws.protocolVersion, 16, 'imprint stays at its own version');
}

// ---- 4. older stored Totem workspace picks the defaults up (append-only normalize) ----
{
    const ws = createZmkTemplate('totem');
    for (const k of Object.keys(ws.tunables)) if (k.startsWith(`${CH.autoShift}:`)) delete ws.tunables[k];
    ws.protocolVersion = 18;
    normalizeZmkWorkspace(ws);
    eq(ws.tunables[`${CH.autoShift}:${V.ashTimeout}`], { op: 'u16', val: 175 });
    eq(ws.protocolVersion, 19);
    ws.tunables[`${CH.autoShift}:${V.ashTimeout}`] = { op: 'u16', val: 300 };
    normalizeZmkWorkspace(ws);
    eq(ws.tunables[`${CH.autoShift}:${V.ashTimeout}`].val, 300, 'saved values are not clobbered');
}

// ---- 5. journal + replay ----
{
    const a = mkApp();
    eq(pendingCount(a.ws), 0, 'seeding does not journal');
    await a.flask.setU16(CH.autoShift, V.ashEnabled, 1);
    await a.flask.setU16(CH.autoShift, V.ashTimeout, 20);        // journals the clamped 50
    await a.flask.setU16(CH.autoShift, V.ashRetroLimit, 0);
    await a.flask.save(CH.autoShift);
    eq(pendingCount(a.ws), 3);
    eq(a.ws.dirty.tun[`${CH.autoShift}:${V.ashTimeout}`], { op: 'u16', val: 50 }, 'the journal holds the clamped value');
    const sent = [], saved = [];
    const dev = { flask: { setU16: async (c, i, v) => { sent.push([c, i, v]); return v; }, setI16: async (_c, _i, v) => v,
        save: async (c) => { saved.push(c); }, setBytes: async () => [] } };
    const r = await syncWorkspace(dev, a.ws);
    eq(r.applied, 3); eq(pendingCount(a.ws), 0, 'journal drained');
    eq(sent.sort((x, y) => x[1] - y[1]), [[CH.autoShift, 1, 1], [CH.autoShift, 2, 50], [CH.autoShift, 8, 0]]);
    eq(saved, [CH.autoShift], 'channel 0x2C saved once');
    // a v18 device answers unhandled: dropped, not retried forever
    await a.flask.setU16(CH.autoShift, V.ashEnabled, 0);
    const v18 = { flask: { setU16: async () => { throw new Error('unhandled'); }, setI16: async () => 0, save: async () => {}, setBytes: async () => [] } };
    const r2 = await syncWorkspace(v18, a.ws);
    eq([r2.dropped.length, pendingCount(a.ws)], [1, 0], 'unhandled dropped');
}

// ---- 6. export -> import round trip through the sim ----
{
    const a = mkApp();
    for (const [id, v] of [[V.ashEnabled, 1], [V.ashTimeout, 220], [V.ashGroups, 0x1B], [V.ashModifiers, 1],
        [V.ashRepeat, 1], [V.ashNoAutoRepeat, 1], [V.ashRetro, 0], [V.ashRetroLimit, 0]]) await a.flask.setU16(CH.autoShift, id, v);
    const state = await exportFlaskState(a);
    eq(state.autoShift, { enabled: 1, timeout: 220, groups: 0x1B, modifiers: 1, repeat: 1, noAutoRepeat: 1, retro: 0, retroLimit: 0 });
    eq(JSON.parse(JSON.stringify(state.autoShift)), state.autoShift, 'JSON-safe');
    const b = mkApp();
    const res = await applyFlaskState(b, state);
    eq(res.failures, [], 'import applies cleanly');
    ok(res.channels.includes(CH.autoShift), 'import SAVEs channel 0x2C');
    eq((await exportFlaskState(b)).autoShift, state.autoShift, 'imported settings equal the exported ones');
    // a v18 device (no caps.autoshift) neither exports nor applies the section
    const old = mkApp(); old.caps = { ...old.caps, autoshift: false };
    eq((await exportFlaskState(old)).autoShift, undefined, 'no section without caps.autoshift');
    const res2 = await applyFlaskState(old, state);
    eq(res2.failures, [], 'importing into a v18 board skips the section');
    eq(await old.flask.getU16(CH.autoShift, V.ashTimeout), 175, 'and writes nothing');
    ok(!old.ws.dirty.tun[`${CH.autoShift}:${V.ashTimeout}`], 'and journals nothing');
}

console.log(`autoshift-test: ${checks} checks OK`);
