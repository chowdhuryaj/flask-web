// WP3b Tap/Hold composer: encode/decode per firmware line, hand-side live
// variant, QMK fallback message, home-row preset, hold/tap labels.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../behavior-catalog.js?v=1';
import { setZmkContext } from '../zmk-keycodes.js?v=49';

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}-behaviors.json`, import.meta.url)));
const LAYERS = [0, 1, 2].map((id) => ({ id, name: ['base', 'nav', 'sym'][id] }));
const useZmk = (f) => { const fx = fixture(f); setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: LAYERS }); return fx; };
const F = 0x09, SHIFT = 0x02;

// ---- QMK u16 ----
{
    const r = C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT } }, 'qmk');
    eq(r.ok, true);
    eq(r.value, 0x2209, 'MT(MOD_LSFT, KC_F)');
    eq(C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT << 4 } }, 'qmk').value, 0x3209, 'MT(MOD_RSFT, KC_F)');
    eq(C.composeTapHold({ tap: { key: 0x2C }, hold: { kind: 'layer', layer: 2 } }, 'qmk').value, 0x422C, 'LT(2, KC_SPC)');
    eq(C.tapHoldSpecOf(0x2209, 'qmk'), { tap: { key: F, mods: 0 }, hold: { kind: 'mods', mods: SHIFT }, timing: undefined });
    eq(C.tapHoldSpecOf(0x422C, 'qmk').hold, { kind: 'layer', layer: 2 });
    eq(C.tapHoldSpecOf(0x0009, 'qmk'), { tap: { key: F, mods: 0 }, hold: null });
    for (const v of [0x2209, 0x3209, 0x2F04, 0x422C, 0x4F1E]) {
        eq(C.composeTapHold(C.tapHoldSpecOf(v, 'qmk'), 'qmk').value, v, `qmk round trip ${v.toString(16)}`);
    }
    // fallbacks: shifted tap, held key, layer > 15, mixed sides, missing slots
    const bang = C.composeTapHold({ tap: { key: 0x1E, mods: SHIFT }, hold: { kind: 'mods', mods: 0x01 } }, 'qmk');
    eq(bang.ok, false); eq(bang.fallback, 'tap-dance');
    ok(/can only tap a plain key/.test(bang.message) && bang.message.includes('"!"') && /tap dance/.test(bang.message), bang.message);
    eq(C.composeTapHold({ tap: { key: F }, hold: { kind: 'key', key: 0x04 } }, 'qmk').fallback, 'tap-dance');
    ok(/layers 0–15/.test(C.composeTapHold({ tap: { key: F }, hold: { kind: 'layer', layer: 20 } }, 'qmk').message));
    ok(/not both/.test(C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: 0x12 } }, 'qmk').message));
    ok(/TAP key/.test(C.composeTapHold({ tap: null, hold: { kind: 'mods', mods: 2 } }, 'qmk').message));
    ok(/modifier/.test(C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: 0 } }, 'qmk').message));
    // Nape: same keycode space
    eq(C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT } }, 'nape').value, 0x2209);
    eq(C.holdTapParts(0x2209, 'qmk'), { entryId: 'mod-tap', hold: '⇧', tag: '', tap: 'F' });
    eq(C.holdTapParts(0x422C, 'qmk').hold, 'L2');
    eq(C.holdTapParts(0x0009, 'qmk'), null);
}

// ---- ZMK Studio: live hold-tap per hand (Totem has &fht_l / &fht_r / &fht) ----
{
    const fx = useZmk('totem');
    const id = (n) => fx.behaviors.find((d) => d.displayName === n).id;
    eq(C.liveSides().sort(), ['any', 'left', 'right']);
    eq(C.liveSideFor('left'), 'left'); eq(C.liveSideFor('right'), 'right'); eq(C.liveSideFor(null), 'any');
    eq(C.liveSideFor('left', []), 'off');
    const l = C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT }, hand: 'left' }, 'zmk-studio');
    eq(l.value, { behaviorId: id('Hold-Tap L (live)'), param1: 0x700E1, param2: 0x70009 }, '&fht_l LSHFT F');
    eq(l.via, 'Hold-Tap L (live)');
    eq(C.composeTapHold({ tap: { key: 0x0D }, hold: { kind: 'mods', mods: SHIFT << 4 }, hand: 'right' }, 'zmk-studio').value,
        { behaviorId: id('Hold-Tap R (live)'), param1: 0x700E5, param2: 0x7000D }, '&fht_r RSHFT J');
    eq(C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: 0x08 } }, 'zmk-studio').value.behaviorId, id('Hold-Tap (live)'), 'no hand → &fht');
    // ZMK allows a shifted tap and any held key
    const bang = C.composeTapHold({ tap: { key: 0x1E, mods: SHIFT }, hold: { kind: 'mods', mods: 1 }, hand: 'left' }, 'zmk-studio');
    eq(bang.ok, true); eq(bang.value.param2, ((0x02 << 24) | 0x7001E) >>> 0);
    const hk = C.composeTapHold({ tap: { key: F }, hold: { kind: 'key', key: 0x3A }, hand: 'left' }, 'zmk-studio');
    eq(hk.ok, true); eq(hk.value.param1, 0x7003A, 'hold F1');
    eq(C.tapHoldSpecOf(hk.value, 'zmk-studio').hold, { kind: 'key', key: 0x3A, mods: 0 });
    // layer hold → compiled Layer-Tap (no live layer-tap node)
    const lt = C.composeTapHold({ tap: { key: 0x2C }, hold: { kind: 'layer', layer: 1 }, hand: 'right' }, 'zmk-studio');
    eq(lt.value, { behaviorId: id('Layer-Tap'), param1: 1, param2: 0x7002C });
    eq(C.composeTapHold({ tap: { key: 0x2C }, hold: { kind: 'layer', layer: 1 }, timing: 150 }, 'zmk-studio').value.behaviorId, id('Layer-Tap (fast 150)'));
    for (const [v, hand] of [[l.value, 'left'], [lt.value, 'right'], [hk.value, 'left']]) {
        eq(C.composeTapHold({ ...C.tapHoldSpecOf(v, 'zmk-studio'), hand }, 'zmk-studio').value, v, 'studio round trip');
    }
    // typed slots (combo / TD output): compiled Mod-Tap, never live
    const ty = C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT }, hand: 'left' }, 'zmk-typed');
    eq(ty.value, { action: 3, behaviorId: id('Mod-Tap'), param1: 0x700E1, param2: 0x70009 });
    eq(C.holdTapParts(l.value), { entryId: 'mod-tap', hold: '⇧', tag: 'live', tap: 'F' });
    eq(C.holdTapParts(lt.value).hold, 'nav');
    eq(C.holdTapParts(ty.value, 'zmk-typed').tap, 'F');
}

// ---- Imprint: no live nodes → compiled Mod-Tap ----
{
    useZmk('imprint');
    eq(C.liveSides(), []);
    const r = C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT }, hand: 'left' }, 'zmk-studio');
    eq(r.ok, true);
    ok(!/live/.test(r.via), `imprint via compiled: ${r.via}`);
    eq(C.decode(r.value).params.live, 'off');
}

// ---- home-row preset ----
{
    const row = (keys) => keys.map((k, i) => ({ pos: i, x: i < 4 ? i : i + 2, binding: k }));
    const qmkRow = row([0x04, 0x16, 0x07, 0x09, 0x0D, 0x0E, 0x0F, 0x33]);   // A S D F J K L ;
    const g = C.homeRowPlan(qmkRow, 'GACS', 'qmk');
    eq(g.ok, true);
    eq(g.plan.map((p) => p.value), [0x2804, 0x2416, 0x2107, 0x2209, 0x3833, 0x340F, 0x310E, 0x320D], 'GACS, pinky first: A⌘ S⌥ D⌃ F⇧ | ;⌘ L⌥ K⌃ J⇧');
    eq(C.homeRowPlan(qmkRow, 'CAGS', 'qmk').plan[0].value, 0x2104, 'CAGS: pinky ⌃');
    // order is by x, not by click order; an existing mod-tap keeps its tap
    const shuffled = [...qmkRow].reverse().map((k, i) => (i === 0 ? { ...k, binding: 0x2833 } : k));
    eq(C.homeRowPlan(shuffled, 'GACS', 'qmk').plan.map((p) => p.value).sort(), g.plan.map((p) => p.value).sort());
    ok(/8 home keys/.test(C.homeRowPlan(qmkRow.slice(0, 7), 'GACS', 'qmk').message));
    ok(/no plain key/.test(C.homeRowPlan(row([0x5221, 0x16, 0x07, 0x09, 0x0D, 0x0E, 0x0F, 0x33]), 'GACS', 'qmk').message));
    // ZMK: left four on &fht_l with left mods, right four on &fht_r with right mods
    const fx = useZmk('totem');
    const id = (n) => fx.behaviors.find((d) => d.displayName === n).id;
    const kp = id('Key Press');
    const z = C.homeRowPlan(row([0x04, 0x16, 0x07, 0x09, 0x0D, 0x0E, 0x0F, 0x33].map((k) => ({ behaviorId: kp, param1: 0x70000 | k, param2: 0 }))), 'GACS', 'zmk-studio');
    eq(z.ok, true);
    eq(z.plan.map((p) => p.value.behaviorId), [...Array(4).fill(id('Hold-Tap L (live)')), ...Array(4).fill(id('Hold-Tap R (live)'))]);
    eq(z.plan.map((p) => C.holdTapParts(p.value).hold), ['⌘', '⌥', '⌃', '⇧', 'R⌘', 'R⌥', 'R⌃', 'R⇧']);
    eq(z.plan.map((p) => p.hand), [...Array(4).fill('left'), ...Array(4).fill('right')]);
}
console.log(`taphold-test: ${checks} checks OK`);
