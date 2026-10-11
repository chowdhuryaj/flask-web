// WP3b Tap/Hold composer: encode/decode, hand-side live variant, home-row
// preset, hold/tap labels.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../behavior-catalog.js?v=79';
import { setZmkContext } from '../zmk-keycodes.js?v=79';

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}-behaviors.json`, import.meta.url)));
const LAYERS = [0, 1, 2].map((id) => ({ id, name: ['base', 'nav', 'sym'][id] }));
const useZmk = (f) => { const fx = fixture(f); setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: LAYERS }); return fx; };
const F = 0x09, SHIFT = 0x02;

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
    // left four on &fht_l with left mods, right four on &fht_r with right mods
    const fx = useZmk('totem');
    const id = (n) => fx.behaviors.find((d) => d.displayName === n).id;
    const kp = id('Key Press');
    const z = C.homeRowPlan(row([0x04, 0x16, 0x07, 0x09, 0x0D, 0x0E, 0x0F, 0x33].map((k) => ({ behaviorId: kp, param1: 0x70000 | k, param2: 0 }))), 'GACS', 'zmk-studio');
    eq(z.ok, true);
    eq(z.plan.map((p) => p.value.behaviorId), [...Array(4).fill(id('Hold-Tap L (live)')), ...Array(4).fill(id('Hold-Tap R (live)'))]);
    eq(z.plan.map((p) => C.holdTapParts(p.value).hold), ['⌘', '⌥', '⌃', '⇧', 'R⌘', 'R⌥', 'R⌃', 'R⇧']);
    eq(z.plan.map((p) => p.hand), [...Array(4).fill('left'), ...Array(4).fill('right')]);
    // order is by x, not by click order
    const zrow = row([0x04, 0x16, 0x07, 0x09, 0x0D, 0x0E, 0x0F, 0x33].map((k) => ({ behaviorId: kp, param1: 0x70000 | k, param2: 0 })));
    eq(C.homeRowPlan([...zrow].reverse(), 'GACS', 'zmk-studio').plan.map((p) => p.value.behaviorId).sort(),
        z.plan.map((p) => p.value.behaviorId).sort());
    ok(/8 home keys/.test(C.homeRowPlan(zrow.slice(0, 7), 'GACS', 'zmk-studio').message));
    const noKey = zrow.map((k, i) => (i === 0 ? { ...k, binding: { behaviorId: id('Momentary Layer'), param1: 1, param2: 0 } } : k));
    ok(/no plain key/.test(C.homeRowPlan(noKey, 'GACS', 'zmk-studio').message));
}

// ---- adaptive tap: &fhta_l/_r/(none) <mods> <set>, &ht_fak <layer> <set>, &fak <set> ----
{
    const fx = fixture('totem');
    let n = 900;
    const add = (displayName) => { const d = { id: n++, displayName, metadata: [{ param1: [], param2: [] }] }; fx.behaviors.push(d); return d.id; };
    const A = { l: add('Hold-Tap L / Adaptive'), r: add('Hold-Tap R / Adaptive'), n: add('Hold-Tap / Adaptive') };
    const FAK = add('Adaptive Key'), HTFAK = add('Adaptive Key / Layer');
    setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: LAYERS });
    const CAG = 0x01 | 0x04 | 0x08;   // Ctrl+Alt+Gui
    const spec = (tap, hold, hand) => ({ tap, hold, hand });
    const mods = (m, right) => ({ kind: 'mods', mods: right ? m << 4 : m });

    // compose: AK8 + Ctrl+Alt+Gui on a right-hand key -> &fhta_r (hold = kp usages, tap param = the set)
    const r = C.composeTapHold(spec({ adaptive: 8 }, mods(CAG, true), 'right'), 'zmk-studio');
    eq(r.ok, true);
    eq(r.value, { behaviorId: A.r, param1: C.encode('mod-tap', { hold: CAG << 4, tap: 4, live: 'right' }, 'zmk-studio').param1, param2: 8 }, '&fhta_r (Ctrl Alt Gui) 8');
    eq(r.via, 'Hold-Tap R / Adaptive');
    eq(C.composeTapHold(spec({ adaptive: 3 }, mods(CAG), 'left'), 'zmk-studio').value.behaviorId, A.l, 'left hand -> fhta_l');
    eq(C.composeTapHold(spec({ adaptive: 3 }, mods(CAG), null), 'zmk-studio').value.behaviorId, A.n, 'no hand -> fhta');
    eq(C.composeTapHold(spec({ adaptive: 15 }, mods(CAG, true), 'right'), 'zmk-studio').value.param2, 15, 'set 15');

    // decode back: Tap = AK8, Hold = the modifiers, editable as any hold-tap
    eq(C.tapHoldSpecOf(r.value, 'zmk-studio'), { tap: { adaptive: 8 }, hold: { kind: 'mods', mods: CAG << 4 }, timing: 200 });
    eq(C.holdTapParts(r.value, 'zmk-studio'), { entryId: 'mod-tap', hold: C.modsText(CAG << 4), tag: 'live', tap: 'AK8' });
    eq(C.capParts(r.value, 'zmk-studio').main, 'AK8');
    eq(C.decode(r.value, 'zmk-studio').params.live, 'right');
    const again = C.composeTapHold({ ...C.tapHoldSpecOf(r.value, 'zmk-studio'), hand: 'right' }, 'zmk-studio');
    eq(again.value, r.value, 'decode -> compose round trip');
    // the existing live nodes and the compiled list never absorb the adaptive nodes
    eq(C.liveSides().sort(), ['any', 'left', 'right']);

    // change the tap to a letter -> back to &fht_r with the same hold
    const spec2 = C.tapHoldSpecOf(r.value, 'zmk-studio');
    const toKey = C.composeTapHold({ tap: { key: 0x36 }, hold: spec2.hold, hand: 'right' }, 'zmk-studio');
    eq(toKey.via, 'Hold-Tap R (live)');
    eq(C.tapHoldSpecOf(toKey.value, 'zmk-studio').tap, { key: 0x36, mods: 0 });
    eq(C.tapHoldSpecOf(toKey.value, 'zmk-studio').hold, spec2.hold, 'hold kept');

    // drop the hold -> &fak 8
    const bare = C.composeTapHold({ tap: { adaptive: 8 }, hold: null }, 'zmk-studio');
    eq(bare.value, { behaviorId: FAK, param1: 8, param2: 0 });
    eq(C.tapHoldSpecOf(bare.value, 'zmk-studio'), { tap: { adaptive: 8 }, hold: null });
    // and a hold can be added back from the plain AK key
    eq(C.composeTapHold({ ...C.tapHoldSpecOf(bare.value, 'zmk-studio'), hold: mods(CAG, true), hand: 'right' }, 'zmk-studio').value, r.value);

    // layer hold -> the existing &ht_fak <layer> <set>
    const lay = C.composeTapHold(spec({ adaptive: 8 }, { kind: 'layer', layer: 2 }, 'right'), 'zmk-studio');
    eq(lay.value, { behaviorId: HTFAK, param1: 2, param2: 8 });
    eq(C.tapHoldSpecOf(lay.value, 'zmk-studio'), { tap: { adaptive: 8 }, hold: { kind: 'layer', layer: 2 } });
    eq(C.composeTapHold({ tap: { key: 0x2C }, hold: { kind: 'layer', layer: 2 }, hand: 'right' }, 'zmk-studio').via, 'Layer-Tap', 'letter tap on layer hold -> Layer-Tap');

    // hold on a key (any key can hold) keeps working with an adaptive tap
    const hk = C.composeTapHold(spec({ adaptive: 1 }, { kind: 'key', key: 0x3A }, 'left'), 'zmk-studio');
    eq(hk.value.behaviorId, A.l); eq(C.tapHoldSpecOf(hk.value, 'zmk-studio').hold, { kind: 'key', key: 0x3A, mods: 0 });

    // not offered where the firmware cannot do it
    ok(!C.composeTapHold(spec({ adaptive: 1 }, mods(CAG), null), 'zmk-typed').ok, 'no adaptive hold-tap in typed slots');
    ok(!C.composeTapHold(spec({ adaptive: 1 }, mods(CAG), null), 'qmk').ok, 'no adaptive hold-tap on QMK');
    eq(C.isRecursiveOutput({ action: 3, behaviorId: A.r, param1: r.value.param1, param2: 8 }), true, 'hold-tap with an adaptive tap recurses like &fak');
    eq(C.isRecursiveOutput({ action: 3, ...toKey.value }), false);

    // inspector model: Tap box reads AK8, Hold box the modifiers
    const { inspectorModel } = await import('../keymap-inspector.js?v=79').catch(() => ({}));
    if (inspectorModel) {
        const m = inspectorModel(r.value, 'zmk-studio');
        eq([m.tap, m.hasHold, m.kind, m.right, m.mods], [{ adaptive: 8 }, true, 'mods', true, CAG]);
        eq(inspectorModel(lay.value, 'zmk-studio').layer, 2);
    }

    // a device without the adaptive hold-tap nodes says so
    useZmk('totem');
    const none = C.composeTapHold(spec({ adaptive: 8 }, mods(CAG, true), 'right'), 'zmk-studio');
    ok(!none.ok && /Adaptive/.test(none.message), none.message);
}
console.log(`taphold-test: ${checks} checks OK`);
