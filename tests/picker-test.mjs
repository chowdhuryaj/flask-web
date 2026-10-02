// WP3 surfaces (§4.7): what each picker surface shows, per device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SURFACES, surfaceEntries } from '../binding-picker.js?v=60';
import { setZmkContext } from '../zmk-keycodes.js?v=60';
import { setDeviceMacroCount } from '../keycodes.js?v=60';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const groups = (s, app) => [...new Set(surfaceEntries(s, app).map((e) => e.group))];
const ids = (s, app) => surfaceEntries(s, app).map((e) => e.id);
const fx = JSON.parse(readFileSync(new URL('./fixtures/imprint-behaviors.json', import.meta.url)));
setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: [{ id: 0, name: 'base' }, { id: 1, name: 'nav' }] });
setDeviceMacroCount(16);

// Every surface: no hidden group or entry leaks through.
for (const [id, s] of Object.entries(SURFACES)) {
    const app = s.adapter === 'nape' ? { family: 'nape' } : {};
    for (const e of surfaceEntries(id, app)) {
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

eq(groups('qmk.key', { layerCount: 4 }), ['keys', 'modifiers', 'layers', 'mouse', 'media', 'run', 'advanced']);
eq(ids('qmk.comboOutput', { layerCount: 4 }).includes('leader'), false);
eq(groups('qmk.gestureSlotTappable'), ['keys', 'media']);
eq(groups('qmk.gestureSlot'), ['keys', 'modifiers', 'mouse', 'media', 'run', 'advanced']);
eq(ids('qmk.macroKey'), ['key', 'none']);
eq(groups('nape.key', { family: 'nape' }), ['keys', 'modifiers', 'layers', 'mouse', 'run']);
console.log(`picker-test: ${checks} checks OK`);
