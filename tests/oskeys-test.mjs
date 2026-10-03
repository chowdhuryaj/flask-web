// OS-aware shortcuts (flask_csk flags bits 1-4, OS_MODE, OSK_CAPS): codec bits,
// summaries, the "Mac shortcuts on Windows" pack, duplicate rules, caps gating,
// offline sim + replay guard, backup round trip.
import assert from 'node:assert/strict';
import { encodeCskSlot, decodeCskSlot, cskSummary, cskDuplicateOf, cskNeedsOs, cskOskCaps, cskOsMode,
    MOD_CTL, MOD_SFT, MOD_ALT, MOD_GUI, OS_MAC, OS_PC, WILD_KEY } from '../zmk-csk-codec.js?v=73';
import { OS_PACK } from '../zmk-os-pack.js?v=73';
import { usageFromName, usageCap } from '../zmk-keycodes.js?v=73';
import { CH, V } from '../flaskproto.js?v=73';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok_ = (c, m = '') => { assert.ok(c, m); checks++; };
const throws = (f, m = '') => { assert.throws(f, m); checks++; };
const Q = 0x70014, F4 = 0x7003D, A = 0x70004;

// ---- codec bits ----
eq([V.cskOsMode, V.cskOskCaps], [0x04, 0x05], 'OS_MODE / OSK_CAPS ids');
const flagsOf = (s) => encodeCskSlot(0, s)[10];
eq(flagsOf({ base: Q, shifted: F4, mods: MOD_GUI, os: OS_PC }), 0b00100, 'PC = condition 2 in bits 1-2');
eq(flagsOf({ base: Q, shifted: F4, mods: MOD_GUI, os: OS_MAC }), 0b00010, 'Mac = condition 1');
eq(flagsOf({ base: Q, shifted: F4, mods: MOD_GUI, wild: true }), 0b01000, 'wildcard bit 3');
eq(flagsOf({ base: Q, shifted: F4, mods: MOD_GUI, count: true }), 0b10000, 'count bit 4');
eq(flagsOf({ base: Q, shifted: F4, mods: MOD_GUI, keep: true, os: OS_PC, wild: true, count: true }), 0b11101, 'all together');
throws(() => encodeCskSlot(0, { base: 1, shifted: 2, os: 3 }), 'OS condition 3 refused');
for (const os of [0, OS_MAC, OS_PC]) for (const wild of [false, true]) for (const count of [false, true]) for (const keep of [false, true]) {
    const s = { slot: 5, base: Q, shifted: F4, mods: MOD_GUI | MOD_CTL, keep };
    if (os) s.os = os; if (wild) s.wild = true; if (count) s.count = true;
    eq(decodeCskSlot(encodeCskSlot(5, s, true)), s, `round trip os${os} wild${wild} count${count} keep${keep}`);
}
eq(encodeCskSlot(1, { base: Q, shifted: F4, os: OS_PC }).length, 11, 'Shift + OS needs the extended frame');
eq(encodeCskSlot(1, { base: Q, shifted: F4 }).length, 9, 'plain Shift slot stays legacy 9 bytes');
eq(decodeCskSlot([1, 0, 7, 0, 0x14, 0, 7, 0, 0x3D, 8, 0]), { slot: 1, base: Q, shifted: F4, mods: MOD_GUI, keep: false },
    'old frames decode with no OS fields');
eq([cskNeedsOs({}), cskNeedsOs({ keep: true }), cskNeedsOs({ os: OS_MAC }), cskNeedsOs({ wild: true }), cskNeedsOs({ count: true })],
    [false, false, true, true, true], 'needs-OS predicate');

// ---- summaries ----
const wild = { base: WILD_KEY, shifted: ((MOD_CTL << 24) | WILD_KEY) >>> 0, mods: MOD_GUI, os: OS_PC, wild: true, count: true };
eq(cskSummary(wild, usageCap), 'Windows: ⌘ + any key → ⌃ + same key', 'wildcard summary');
eq(cskSummary({ ...wild, os: 0 }, usageCap), '⌘ + any key → ⌃ + same key', 'wildcard, any OS');
eq(cskSummary({ ...wild, shifted: WILD_KEY }, usageCap), 'Windows: ⌘ + any key → same key', 'wildcard with no replacement mods');
eq(cskSummary({ base: Q, shifted: ((MOD_ALT << 24) | F4) >>> 0, mods: MOD_GUI, os: OS_PC, count: true }, usageCap), 'Windows: ⌘Q → ⌥F4', 'specific OS summary');
eq(cskSummary({ base: Q, shifted: F4, mods: MOD_GUI, os: OS_MAC }, usageCap), 'Mac: ⌘Q → F4', 'Mac prefix');
eq(cskSummary({ base: Q, shifted: F4, mods: MOD_SFT }, (u) => (u === Q ? 'Q' : 'F4')), '⇧ Q → F4', 'non-OS summary unchanged');

// ---- pack ----
const names = (await import('node:fs')).readFileSync(new URL('../zmk-os-pack' + '.js', import.meta.url), 'utf8');
for (const n of ['Home', 'End', 'F4', 'F11', 'Print Screen', 'Space', 'Tab', 'Backspace', 'Delete', 'Left Arrow', 'Right Arrow',
    'Up Arrow', 'Down Arrow', 'Escape', 'Left GUI']) ok_(usageFromName(n) != null, `key name resolves: ${n}`);
eq([usageFromName('Home'), usageFromName('End'), usageFromName('F4'), usageFromName('F11'), usageFromName('Print Screen'),
    usageFromName('Space'), usageFromName('Left Arrow'), usageFromName('Down Arrow'), usageFromName('Escape'), usageFromName('Left GUI')],
    [0x7004A, 0x7004D, 0x7003D, 0x70044, 0x70046, 0x7002C, 0x70050, 0x70051, 0x70029, 0x700E3], 'names hit the intended usage ids');
ok_(names.includes("'Print Screen'") && !names.includes("'PrintScreen'"), 'pack uses the name the table knows');
const PRESETS_EXISTING = 5;   // the starter buttons in zmk-shift-tab.js
ok_(OS_PACK.length + PRESETS_EXISTING <= 32, `pack (${OS_PACK.length}) + 5 starter presets fits 32 slots`);
eq(OS_PACK.length, 22, 'one wildcard + 21 exceptions');
ok_(!OS_PACK.some((r) => r.shifted === usageFromName('Left GUI')), 'no masked GUI-only replacement');
ok_(!OS_PACK.some((r) => r.mods === MOD_ALT && !r.wild && (r.base & 0xFFFFFF) === 0x50), 'no ⌥← rows (PC swapper owns them)');
ok_(!OS_PACK.some((r) => r.mods === MOD_GUI && (r.base & 0xFFFFFF) === 0x2A), 'no ⌘⌫ row (wildcard gives Ctrl+⌫)');
ok_(OS_PACK.every((r) => r.os === OS_PC && r.count === true && r.base && r.shifted && r.src), 'every row: Windows, count mods, live, sourced');
eq(OS_PACK.filter((r) => r.wild).length, 1, 'exactly one wildcard');
eq(OS_PACK.map((r, i) => cskDuplicateOf(OS_PACK, i)).filter((d) => d >= 0), [], 'pack has no duplicates inside itself');
const row = (mods, base, repl, rmods = 0) => OS_PACK.find((r) => !r.wild && r.mods === mods && (r.base & 0xFFFFFF) === (usageFromName(base) & 0xFFFFFF)
    && r.shifted === (((rmods << 24) | usageFromName(repl)) >>> 0));
ok_(row(MOD_GUI, 'Q', 'F4', MOD_ALT), '⌘Q → Alt+F4');
ok_(row(MOD_GUI | MOD_SFT, 'Z', 'Y', MOD_CTL), '⌘⇧Z → Ctrl+Y');
ok_(row(MOD_GUI, 'Left Arrow', 'Home'), '⌘← → Home');
ok_(row(MOD_GUI | MOD_SFT, 'Down Arrow', 'End', MOD_CTL | MOD_SFT), '⌘⇧↓ → Ctrl+Shift+End');
ok_(row(MOD_GUI, 'Space', 'Escape', MOD_CTL), '⌘Space → Ctrl+Esc');
ok_(row(MOD_CTL | MOD_GUI, 'Q', 'L', MOD_GUI), '⌃⌘Q → Win+L');
ok_(row(MOD_GUI | MOD_ALT, 'Escape', 'Escape', MOD_CTL | MOD_SFT), '⌘⌥Esc → Ctrl+Shift+Esc');
ok_(row(MOD_GUI | MOD_SFT, '4', 'S', MOD_GUI | MOD_SFT), '⌘⇧4 → Win+Shift+S');
ok_(row(MOD_CTL | MOD_GUI, 'F', 'F11'), '⌃⌘F → F11');

// ---- duplicate rules: OS condition and wildcard ----
const SP = (mods, os, base = Q) => ({ base, shifted: F4, mods, os, keep: false });
const WD = (mods, os) => ({ base: WILD_KEY, shifted: ((MOD_CTL << 24) | WILD_KEY) >>> 0, mods, os, wild: true });
eq(cskDuplicateOf([SP(MOD_GUI, OS_PC), SP(MOD_GUI, OS_PC)], 0), 1, 'same base, trigger, OS clash');
eq(cskDuplicateOf([SP(MOD_GUI, OS_PC), SP(MOD_GUI, OS_MAC)], 0), -1, 'Mac and Windows rows can coexist');
eq(cskDuplicateOf([SP(MOD_GUI, OS_PC), SP(MOD_GUI, 0)], 0), -1, 'an Any-OS row never shadows a Windows row (OS-specific is checked first)');
eq(cskDuplicateOf([SP(MOD_GUI, 0), SP(MOD_GUI, 0)], 0), 1, 'two Any-OS rows clash');
eq(cskDuplicateOf([{ base: usageFromName('Backspace'), shifted: usageFromName('Delete'), mods: MOD_ALT, keep: true },
    { ...SP(MOD_ALT, OS_PC, usageFromName('Backspace')), shifted: usageFromName('Backspace') }], 1), -1, 'starter ⌥⌫→⌦ keep does not clash with a Windows ⌥⌫ row');
eq(cskDuplicateOf([SP(MOD_GUI, OS_PC), SP(MOD_GUI, OS_PC, A)], 0), -1, 'different base is fine');
eq(cskDuplicateOf([WD(MOD_GUI, OS_PC), SP(MOD_GUI, OS_PC)], 0), -1, 'wildcard and specific never clash (specific wins)');
eq(cskDuplicateOf([WD(MOD_GUI, OS_PC), WD(MOD_GUI, OS_PC)], 1), 0, 'two wildcards on one trigger+OS clash');
eq(cskDuplicateOf([WD(MOD_GUI, OS_PC), WD(MOD_GUI, OS_MAC)], 1), -1, 'wildcards on different OS are fine');
eq(cskDuplicateOf([WD(MOD_GUI, OS_PC), WD(MOD_GUI | MOD_SFT, OS_PC)], 1), 0, 'earlier ⌘ wildcard shadows a later ⌘⇧ one');
eq(cskDuplicateOf([WD(MOD_CTL, OS_PC), WD(MOD_GUI, OS_PC)], 1), -1, 'wildcards on unrelated triggers are fine');
eq(cskDuplicateOf([{ base: Q, shifted: F4, mods: MOD_GUI, os: OS_PC, wild: true }, { base: A, shifted: F4, mods: MOD_GUI, os: OS_PC, wild: true }], 1), 0,
    'wildcard base is not compared');

// wildcards are one tier in slot order, whatever the OS
eq(cskDuplicateOf([WD(MOD_GUI, 0), WD(MOD_GUI, OS_PC)], 1), 0, 'earlier Any-OS wildcard shadows a later Windows one');
eq(cskDuplicateOf([WD(MOD_GUI, OS_PC), WD(MOD_GUI, 0)], 1), 0, 'earlier Windows wildcard overlaps a later Any-OS one');
eq(cskDuplicateOf([WD(MOD_GUI, OS_MAC), WD(MOD_GUI, OS_PC)], 1), -1, 'Mac and Windows wildcards do not overlap');
eq(cskDuplicateOf([WD(MOD_GUI, 0), WD(MOD_GUI | MOD_SFT, OS_PC)], 1), 0, 'earlier ⌘ wildcard matches whenever a later ⌘⇧ one would');
eq(cskDuplicateOf([WD(MOD_GUI | MOD_SFT, OS_PC), WD(MOD_GUI, 0)], 1), -1, 'a narrower later wildcard is not shadowed');
eq(cskDuplicateOf([SP(MOD_GUI, OS_PC), WD(MOD_GUI, OS_PC)], 1), -1, 'a specific row earlier does not shadow a wildcard');

// ---- caps probes ----
const flaskWith = (fn) => ({ getU16: async (ch, id) => { assert.equal(ch, CH.customShift); return fn(id); } });
eq(await cskOskCaps(flaskWith((id) => { assert.equal(id, V.cskOskCaps); return 1; })), true, 'OSK_CAPS 1 -> OS UI');
eq(await cskOskCaps(flaskWith(() => { throw new Error('unhandled'); })), false, 'old firmware -> controls hidden');
eq(await cskOskCaps(flaskWith(() => 0)), false, 'OSK_CAPS 0 -> hidden');
await assert.rejects(cskOskCaps(flaskWith(() => { throw new Error('timeout'); })), /timeout/); checks++;
eq([await cskOsMode(flaskWith(() => 0)), await cskOsMode(flaskWith(() => 1)), await cskOsMode(flaskWith(() => 0xFFFF)),
    await cskOsMode(flaskWith(() => { throw new Error('unhandled'); }))], [OS_PC, OS_MAC, null, null], 'OS_MODE 0 PC, 1 Mac, else unknown');

// ---- UI gating: the tab hides the new controls without OSK_CAPS ----
{
    const src = (await import('node:fs')).readFileSync(new URL('../zmk-shift-tab' + '.js', import.meta.url), 'utf8');
    ok_(/const osSel = this\.osk \?/.test(src) && /const anyKey = this\.osk \?/.test(src) && /const countMods = this\.osk \?/.test(src),
        'OS selector, any key and count toggles only render with OSK_CAPS');
    ok_(/this\.osk \? el\('button'/.test(src), 'pack button only with OSK_CAPS');
    ok_(/!this\.osk && cskNeedsOs\(s\)/.test(src), 'writeSlot refuses OS rows on firmware without OSK_CAPS');
}

// ---- offline sim, replay guard, backup ----
{
    globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; },
        setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
    const { createZmkTemplate, ZmkOfflineFlask, zmkSyncExtras } = await import('../zmk-offline.js?v=73');
    const ws = createZmkTemplate('totem'); ws.key = 'os-test';
    const g = new ZmkOfflineFlask(ws);
    eq(await cskOskCaps(g), true, 'sim reports OSK_CAPS 1');
    eq(await g.getU16(CH.customShift, V.cskOsMode), 1, 'sim reports OS_MODE 1 (Mac)');
    eq(await cskOsMode(g), OS_MAC, 'sim OS mode is Mac');
    for (const [i, r] of OS_PACK.entries()) {
        const { src, ...slot } = r;
        const echo = decodeCskSlot(await g.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(i, slot), 1));
        eq(echo, { slot: i, ...slot }, `sim echo carries OS bits for pack row ${i}`);
    }
    eq(decodeCskSlot(await g.getBytes(CH.customShift, V.cskSlot, [0], 1)).wild, true, 'sim GET returns the wildcard');

    // replay onto firmware without OSK_CAPS keeps OS slots queued
    const ws2 = createZmkTemplate('totem'); ws2.key = 'os-test2';
    ws2.zmk.csk[1] = { base: Q, shifted: F4, mods: MOD_SFT };                                  // plain Shift
    ws2.zmk.csk[2] = { base: Q, shifted: F4, mods: MOD_GUI, os: OS_PC, count: true };          // needs OS
    ws2.zmk.csk[3] = { base: WILD_KEY, shifted: WILD_KEY, mods: MOD_GUI, wild: true };         // needs OS
    ws2.zmk.csk[4] = { base: Q, shifted: F4, mods: MOD_CTL | MOD_SFT };                        // morph only
    ws2.zmkDirty.cskSlot = { 1: true, 2: true, 3: true, 4: true };
    const mkApp = (morph, osk) => { const sent = [];
        return { sent, flask: {
            getU16: async (c, id) => { const f = id === V.cskOskCaps ? osk : morph; return f(); },
            setBytes: async (c, i, p) => { sent.push(p[0]); return p; },
            save: async () => {} } }; };
    const un = () => { throw new Error('unhandled'); };
    const morphOnly = mkApp(() => 1, un);
    const r = await zmkSyncExtras(morphOnly, ws2);
    eq(morphOnly.sent, [1, 4], 'morph-only firmware takes Shift and the trigger slot, not the OS slots');
    eq(Object.keys(ws2.zmkDirty.cskSlot).sort(), ['2', '3'], 'OS slots stay queued');
    ok_(r.failures.length === 2 && r.failures.every((f) => /needs OS-aware firmware/.test(f)), `failure names the cause: ${r.failures}`);
    const flaky = mkApp(() => 1, () => { throw new Error('timeout'); });
    const r2 = await zmkSyncExtras(flaky, ws2);
    eq([flaky.sent, Object.keys(ws2.zmkDirty.cskSlot).length, r2.failures.length], [[], 2, 2], 'probe error: nothing written, still queued');
    const modern = mkApp(() => 1, () => 1);
    await zmkSyncExtras(modern, ws2);
    eq([modern.sent, Object.keys(ws2.zmkDirty.cskSlot).length], [[2, 3], 0], 'OS-aware firmware takes them and drains the journal');

    // backup: new bits round trip, plain slots stay byte-identical
    const { exportFlaskState, applyFlaskState } = await import('../zmk-export.js?v=73');
    const g2 = new ZmkOfflineFlask(createZmkTemplate('totem'));
    await g2.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(0, { base: Q, shifted: F4 }), 1);
    await g2.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(1, { base: Q, shifted: F4, mods: MOD_ALT, keep: true }), 1);
    const { src: _s, ...wsl } = OS_PACK[0];
    await g2.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(2, wsl), 1);
    const caps = { customShift: true };
    const out = await exportFlaskState({ flask: g2, caps });
    eq(out.customShift.slots[0], { base: Q, shifted: F4 }, 'plain slot exports exactly as before');
    eq(out.customShift.slots[1], { base: Q, shifted: F4, mods: MOD_ALT, keep: true }, 'morph slot exports exactly as before');
    eq(out.customShift.slots[2], { base: WILD_KEY, shifted: wsl.shifted, mods: MOD_GUI, keep: false, os: OS_PC, wild: true, count: true }, 'OS slot carries os/wild/count');
    const g3 = new ZmkOfflineFlask(createZmkTemplate('totem'));
    const res = await applyFlaskState({ flask: g3, caps }, JSON.parse(JSON.stringify(out)));
    eq(decodeCskSlot(await g3.getBytes(CH.customShift, V.cskSlot, [2], 1)), { slot: 2, ...wsl }, 'restore brings the OS bits back');
    eq(res.failures.filter((f) => /customShift/.test(f)), [], 'no customShift failures on OS-aware target');
    // restore onto firmware without OSK_CAPS skips OS rows and says why
    const sent = [];
    const oldFw = { flask: { getU16: async (c, id) => { if (id === V.cskSlotCount) return 32; if (id === V.cskMorphCaps) return 1; if (id === V.cskOskCaps) throw new Error('unhandled'); return 0; },
        setU16: async () => {}, save: async () => {}, setBytes: async (c, i, p) => { sent.push(p[0]); return p; } }, caps };
    const res2 = await applyFlaskState(oldFw, JSON.parse(JSON.stringify(out)));
    ok_(sent.includes(0) && sent.includes(1) && !sent.includes(2), 'the OS slot is skipped, the others are written');
    ok_(res2.failures.some((f) => /slot 2: needs OS-aware firmware/.test(f)), `restore failure: ${res2.failures}`);
    delete globalThis.localStorage;
}

console.log(`oskeys-test: ${checks} checks OK`);
