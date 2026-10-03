// Mod Morph (flask_csk extended slot frame): encode/decode, 8-byte back-compat,
// MORPH_CAPS detect, duplicate detection, summary text, sim round trip.
import assert from 'node:assert/strict';
import { encodeCskSlot, decodeCskSlot, cskMorphCaps, cskNeedsMorph, cskDuplicateOf, cskSummary, trigText,
    MOD_CTL, MOD_SFT, MOD_ALT, MOD_GUI } from '../zmk-csk-codec.js?v=67';
import { CH, V } from '../flaskproto.js?v=67';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok_ = (c, m = '') => { assert.ok(c, m); checks++; };
const throws = (f, m = '') => { assert.throws(f, m); checks++; };

const COMMA = 0x70036, SEMI = 0x70033, BSP = 0x7002A, DEL = 0x7004C;

// ---- encode / decode ----
eq(encodeCskSlot(4, { base: COMMA, shifted: SEMI, mods: MOD_CTL | MOD_SFT, keep: true }),
    [4, 0, 7, 0, 0x36, 0, 7, 0, 0x33, 0x03, 0x01], 'extended frame: trigger [9], flags [10]');
eq(decodeCskSlot([4, 0, 7, 0, 0x36, 0, 7, 0, 0x33, 0x0C, 0x00]),
    { slot: 4, base: COMMA, shifted: SEMI, mods: MOD_ALT | MOD_GUI, keep: false }, 'decode alt+gui, keep clear');
for (const mods of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
    for (const keep of [false, true]) {
        const s = { slot: 9, base: BSP, shifted: (MOD_ALT << 24 | DEL) >>> 0, mods, keep };
        eq(decodeCskSlot(encodeCskSlot(9, s, true)), s, `round trip mods ${mods} keep ${keep}`);
    }
}
throws(() => encodeCskSlot(0, { base: 1, shifted: 2, mods: 0x10 }), 'high trigger bits rejected');

// ---- back-compat: plain Shift is the legacy 9-byte frame ----
eq(encodeCskSlot(1, { base: COMMA, shifted: SEMI }).length, 9, 'no mods -> 9 bytes');
eq(encodeCskSlot(1, { base: COMMA, shifted: SEMI, mods: MOD_SFT }).length, 9, 'Shift only, no keep -> 9 bytes');
eq(encodeCskSlot(1, { base: COMMA, shifted: SEMI, mods: MOD_SFT, keep: true }).length, 11, 'Shift + keep needs the flags byte');
eq(encodeCskSlot(1, { base: COMMA, shifted: SEMI, mods: 0 }).length, 9, 'mods 0 means Shift');
eq(decodeCskSlot([1, 0, 7, 0, 0x36, 0, 7, 0, 0x33]),
    { slot: 1, base: COMMA, shifted: SEMI, mods: MOD_SFT, keep: false }, 'old 9-byte reply = Shift, no keep');
eq(decodeCskSlot([1, 0, 7, 0, 0x36, 0, 7, 0, 0x33, 0, 0]).mods, MOD_SFT, 'stored 0 reads as Shift');
eq(encodeCskSlot(1, { base: COMMA, shifted: SEMI }, true).length, 11, 'extended forced');

// ---- MORPH_CAPS detect ----
const flaskWith = (fn) => ({ getU16: async (ch, id) => { assert.equal(ch, CH.customShift); assert.equal(id, V.cskMorphCaps); return fn(); } });
eq(V.cskMorphCaps, 0x03, 'MORPH_CAPS id');
eq(await cskMorphCaps(flaskWith(() => 1)), true, 'caps 1 -> morph UI');
eq(await cskMorphCaps(flaskWith(() => { throw new Error('unhandled'); })), false, 'old firmware echoes 0xFF -> Shift-only');
eq(await cskMorphCaps(flaskWith(() => 0)), false, 'caps 0 -> Shift-only');
await assert.rejects(cskMorphCaps(flaskWith(() => { throw new Error('timeout'); })), /timeout/);
checks++;   // a flaky link is not "old firmware": the error propagates
eq([cskNeedsMorph({ base: 1, shifted: 2 }), cskNeedsMorph({ mods: MOD_SFT }), cskNeedsMorph({ mods: MOD_CTL | MOD_SFT }),
    cskNeedsMorph({ mods: MOD_SFT, keep: true })], [false, false, true, true], 'needs-morph predicate');

// ---- duplicate detection: same base (page+id) AND same trigger set ----
const S = (base, mods, shifted = SEMI) => ({ base, shifted, mods, keep: false });
const slots = [S(COMMA, MOD_SFT), S(COMMA, MOD_CTL | MOD_SFT), S(COMMA, MOD_SFT), S(0, MOD_SFT, 0), S(BSP, MOD_SFT)];
eq(cskDuplicateOf(slots, 0), 2, 'same base + trigger flagged');
eq(cskDuplicateOf(slots, 2), 0, 'and symmetric');
eq(cskDuplicateOf(slots, 1), -1, '⌃⇧, and ⇧, are different slots');
eq(cskDuplicateOf(slots, 3), -1, 'empty base never clashes');
eq(cskDuplicateOf(slots, 4), -1, 'different base');
eq(cskDuplicateOf([S(COMMA, MOD_SFT, 0), S(COMMA, MOD_SFT)], 1), -1, 'incomplete slot (no replacement) is not a duplicate');
eq(cskDuplicateOf([S(COMMA, MOD_SFT, 0), S(COMMA, MOD_SFT)], 0), -1, 'and does not flag itself');
eq(cskDuplicateOf([S((MOD_SFT << 24 | COMMA) >>> 0, MOD_SFT), S(COMMA, MOD_SFT)], 1), 0, 'base mod bits ignored');
eq(cskDuplicateOf([S(COMMA, undefined), S(COMMA, MOD_SFT)], 1), 0, 'missing mods means Shift');

// ---- summary text ----
const name = (u) => ({ [COMMA]: ',', [SEMI]: ';', [BSP]: '⌫', [DEL]: '⌦' })[u];
eq(trigText(MOD_CTL | MOD_SFT), '⌃⇧', 'trigger glyphs');
eq(trigText(MOD_CTL | MOD_SFT | MOD_ALT | MOD_GUI), '⌃⇧⌥⌘', 'all four, fixed order');
eq(cskSummary(S(COMMA, MOD_CTL | MOD_SFT), name), '⌃⇧ , → ;', 'summary');
eq(cskSummary({ base: BSP, shifted: DEL, mods: MOD_ALT, keep: true }, name), '⌥ ⌫ → ⌦ (keep ⌥)', 'summary with keep');
eq(cskSummary({ base: BSP, shifted: DEL }, name), '⇧ ⌫ → ⌦', 'summary defaults to Shift');

// ---- offline sim speaks the extended frame ----
{
    globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; },
        setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
    const { createZmkTemplate, ZmkOfflineFlask } = await import('../zmk-offline.js?v=67');
    const ws = createZmkTemplate('totem'); ws.key = 'mm-test';
    const g = new ZmkOfflineFlask(ws);
    eq(await cskMorphCaps(g), true, 'sim reports MORPH_CAPS');
    const echo = decodeCskSlot(await g.setBytes(CH.customShift, V.cskSlot,
        encodeCskSlot(2, { base: BSP, shifted: DEL, mods: MOD_ALT, keep: true }), 1));
    eq(echo, { slot: 2, base: BSP, shifted: DEL, mods: MOD_ALT, keep: true }, 'sim echo carries trigger + keep');
    eq(decodeCskSlot(await g.getBytes(CH.customShift, V.cskSlot, [2], 1)).mods, MOD_ALT, 'sim GET returns stored trigger');
    eq(decodeCskSlot(await g.getBytes(CH.customShift, V.cskSlot, [3], 1)).mods, MOD_SFT, 'empty slot reads Shift');

    // ---- offline replay onto Shift-only firmware keeps morph slots queued ----
    const { zmkSyncExtras } = await import('../zmk-offline.js?v=67');
    eq(ws.zmk.csk.length, 32, 'template has 32 mod-morph slots');
    const ws2 = createZmkTemplate('totem'); ws2.key = 'mm-test2';
    ws2.zmk.csk[1] = { base: COMMA, shifted: SEMI };                              // plain Shift
    ws2.zmk.csk[2] = { base: COMMA, shifted: SEMI, mods: MOD_CTL | MOD_SFT };    // needs morph
    ws2.zmk.csk[3] = { base: BSP, shifted: DEL, mods: MOD_SFT, keep: true };     // needs morph
    ws2.zmkDirty.cskSlot = { 1: true, 2: true, 3: true };
    const mkApp = (morphFn) => { const sent = [];
        return { sent, flask: {
            getU16: async () => morphFn(),
            setBytes: async (c, i, p) => { sent.push(p[0]); return p; },
            save: async () => {} } }; };
    const old = mkApp(() => { throw new Error('unhandled'); });
    const r = await zmkSyncExtras(old, ws2);
    eq(old.sent, [1], 'only the Shift slot is written to Shift-only firmware');
    eq(Object.keys(ws2.zmkDirty.cskSlot).sort(), ['2', '3'], 'morph slots stay queued');
    eq(r.failures.length, 2, 'one failure per morph slot');
    ok_(r.failures.every((f) => /needs mod-morph firmware/.test(f)), 'failure names the cause');
    const flaky = mkApp(() => { throw new Error('timeout'); });
    const r2 = await zmkSyncExtras(flaky, ws2);
    eq([flaky.sent, Object.keys(ws2.zmkDirty.cskSlot).length, r2.failures.length], [[], 2, 2], 'probe error: nothing written, still queued');
    const modern = mkApp(() => 1);
    await zmkSyncExtras(modern, ws2);
    eq([modern.sent, Object.keys(ws2.zmkDirty.cskSlot).length], [[2, 3], 0], 'mod-morph firmware takes them and drains the journal');

    // ---- applyFlaskState reports slots past the target's count ----
    const { applyFlaskState } = await import('../zmk-export.js?v=67');
    const slotsFile = Array.from({ length: 20 }, (_, i) => (i === 1 || i === 18 ? { base: COMMA, shifted: SEMI } : { base: 0, shifted: 0 }));
    const tgt = { sent: [], flask: {
        getU16: async (c, id) => { if (id === V.cskSlotCount) return 16; if (id === V.cskMorphCaps) return 1; return 0; },
        setU16: async () => {}, save: async () => {},
        setBytes: async (c, i, p) => { tgt.sent.push(p[0]); return p; } },
        caps: { customShift: true } };
    tgt.flask = { ...tgt.flask }; const app3 = { flask: tgt.flask, caps: tgt.caps };
    const res = await applyFlaskState(app3, { customShift: { slots: slotsFile } });
    eq(tgt.sent.length, 16, 'writes only the slots the target has');
    ok_(res.failures.some((f) => /1 slot\(s\) past this board's 16/.test(f)), `past-count failure: ${res.failures}`);
    delete globalThis.localStorage;
}

console.log(`modmorph-test: ${checks} checks OK`);
