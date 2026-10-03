// WP3 surfaces (§4.7): what each picker surface shows, per device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SURFACES, surfaceEntries } from '../binding-picker.js?v=73';
import { setZmkContext } from '../zmk-keycodes.js?v=73';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const groups = (s, app) => [...new Set(surfaceEntries(s, app).map((e) => e.group))];
const ids = (s, app) => surfaceEntries(s, app).map((e) => e.id);
const fx = JSON.parse(readFileSync(new URL('./fixtures/imprint-behaviors.json', import.meta.url)));
setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: [{ id: 0, name: 'base' }, { id: 1, name: 'nav' }] });

// Every surface: no hidden group or entry leaks through.
for (const [id, s] of Object.entries(SURFACES)) {
    for (const e of surfaceEntries(id, {})) {
        assert.ok(!s.hide.includes(e.group) && !s.hide.includes(e.id), `${id} shows ${e.id}`);
        checks++;
    }
}
const ZMK = ['keys', 'modifiers', 'layers', 'mouse', 'media', 'run'];
eq(groups('zmk.key'), ZMK, 'zmk.key: all groups (Imprint has no leftovers, so no Advanced)');
eq(groups('zmk.comboOutput'), ZMK);
eq(ids('zmk.comboOutput').includes('leader'), false, 'combo output: no Leader');
eq(ids('zmk.tapDanceStep').filter((i) => ['leader', 'tap-dance'].includes(i)), [], 'TD step: no recursion');
eq(groups('zmk.typedOutput'), ['keys', 'media', 'run'], 'leader / gesture output');
eq(ids('zmk.typedOutput'), ['key', 'none', 'media-key', 'macro']);
eq(ids('zmk.macroKey'), ['key', 'none', 'media-key']);
eq(ids('zmk.cskBase'), ['key', 'none']);
eq(ids('zmk.key').includes('trans'), true, 'keymap shows pass-through');
eq(ids('zmk.comboOutput').includes('trans'), false, 'slots never show pass-through');
eq(surfaceEntries('zmk.typedOutput').reason.length > 0, true, 'slot explains missing groups');
eq(surfaceEntries('zmk.comboOutput').find((e) => e.id === 'mod-tap').params.some((p) => p.key === 'live'), false,
    'live timing is per key position: keymap only');

// flask_adaptive: &fak is a catalog entry only when the device lists "Adaptive Key"; the
// step surface (a rule's output) hides it, the trigger surface stores usage + mods only.
{
    const akFx = [...fx.behaviors, { id: 900, displayName: 'Adaptive Key',
        metadata: [{ param1: [{ name: 'Adaptive set', kind: 'range', min: 0, max: 3 }], param2: [] }] }];
    setZmkContext({ behaviors: new Map(akFx.map((d) => [d.id, d])), layers: [{ id: 0, name: 'base' }, { id: 1, name: 'nav' }] });
    eq(ids('zmk.key').includes('adaptive'), true, 'keymap picker offers Adaptive key');
    eq(ids('zmk.comboOutput').includes('adaptive'), true, 'combo output may fire an adaptive set');
    eq(ids('zmk.adaptiveStep').includes('adaptive'), false, 'adaptive step: no recursion');
    eq(ids('zmk.tapDanceStep').filter((i) => ['tap-dance', 'adaptive'].includes(i)), [], 'F01: tap-dance step offers neither Tap Dance nor Adaptive Key');
    eq(ids('zmk.adaptiveStep').filter((i) => ['leader', 'tap-dance'].includes(i)), [], 'adaptive step: no leader / tap dance');
    eq(ids('zmk.adaptiveStep').includes('macro'), true, 'adaptive step: macro slot allowed');
    eq(SURFACES['zmk.adaptiveTrigger'].stores, 'usage + mods', 'trigger stores usage + mods');
    eq(ids('zmk.adaptiveTrigger'), ['key', 'none', 'media-key'].filter((i) => ids('zmk.cskShifted').includes(i)), 'trigger: keys only, like the shifted side');
    eq(groups('zmk.adaptiveTrigger'), groups('zmk.cskShifted'));
    const slot = surfaceEntries('zmk.key', {}).find((e) => e.id === 'adaptive').params[0];
    eq([slot.kind, slot.min, slot.max], ['slot', 0, 3], 'set picker range comes from the firmware metadata');
    setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: [{ id: 0, name: 'base' }, { id: 1, name: 'nav' }] });
}

// Behaviors without get_parameter_metadata (switch-layout: swapper, sw_layout, slk_*) are
// refused by Studio (-ENODEV) yet look identical on the wire to assignable sets_len 0
// behaviors (Super Delete tap-dance, key repeat): zero metadata sets. Hidden from the
// picker, still shown as existing bindings.
{
    const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=73');
    const { describeBinding } = await import('../behavior-catalog.js?v=73');
    // decodeBehaviorDetails yields metadata: [] for sets_len 0 AND for -ENODEV, flagged or not.
    const dev = TOTEM_DEFAULT.behaviors.map((d) => ({ id: d.id, displayName: d.displayName,
        metadata: d.metadata.every((m) => !m.param1.length && !m.param2.length) ? [] : d.metadata }));
    setZmkContext({ behaviors: new Map(dev.map((d) => [d.id, d])), layers: [{ id: 0, name: 'base' }] });
    const bad = TOTEM_DEFAULT.behaviors.filter((d) => d.unassignable && d.displayName);
    eq(bad.length >= 14, true, 'generator flags the named switch-layout behaviors');
    const offered = JSON.stringify(surfaceEntries('zmk.key', {}));
    for (const d of bad) eq(offered.includes(JSON.stringify(d.displayName)), false, `${d.displayName} is not offered`);
    for (const n of ['Super Delete', 'Key Repeat', 'Caps Word']) {
        eq(offered.includes(JSON.stringify(n)) || surfaceEntries('zmk.key', {}).some((e) => e.name === n || e.label === n), true, `${n} (empty metadata, assignable) stays`);
    }
    for (const d of bad) eq(describeBinding({ behaviorId: d.id, param1: 0, param2: 0 }, 'zmk-studio'), d.displayName, `${d.displayName} still displays on a key`);
    setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: [{ id: 0, name: 'base' }, { id: 1, name: 'nav' }] });
}

console.log(`picker-test: ${checks} checks OK`);
