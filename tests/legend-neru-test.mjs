// Mouse layer legends: Neru menu letters, mouse move/scroll directions, mouse buttons.
// Behavior ids come from a name lookup on the Totem's live list (Totem-ZMK keymap-after.json),
// never hard-coded numbers; pointing params follow ZMK pointing.h (x high 16, y low 16).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setZmkContext } from '../zmk-keycodes.js?v=72';
import { legendOf } from '../legend.js?v=72';

const eq = (a, b, m = '') => assert.deepEqual(a, b, m);
const NAMES = ['mouse_move', 'mouse_scroll', 'Neru Hints', 'Neru Menu', 'Neru Menu + Key (to base)', 'Neru Menu + Key (stay)',
    'Mouse Layer', 'Mouse Key Press', 'Momentary Layer'];
const KINDS = { 'Neru Menu + Key (to base)': ['u'], 'Neru Menu + Key (stay)': ['u'], 'Mouse Layer': ['l', 'l'],
    'Mouse Key Press': ['n'], 'Momentary Layer': ['l'] };
const K = { l: 'layer_id', u: 'hid_usage', n: 'range' };
// Ids are shuffled on purpose: lookup is by name.
const live = NAMES.map((displayName, i) => ({ id: 200 - i * 3, displayName,
    metadata: [{ param1: (KINDS[displayName] ?? []).slice(0, 1).map((k) => ({ kind: K[k], name: 'x', min: 0, max: 31 })),
        param2: (KINDS[displayName] ?? []).slice(1).map((k) => ({ kind: K[k], name: 'x', min: 0, max: 31 })) }] }));
const layers = ['Base', 'Mouse', 'Scroll Slow', 'Scroll Fast', 'Mouse Slow', 'Speed Up x5', 'Speed Down /5'].map((name, id) => ({ id, name }));
setZmkContext({ behaviors: new Map(live.map((d) => [d.id, d])), layers });
const id = (n) => live.find((d) => d.displayName === n).id;
const lg = (n, param1 = 0, param2 = 0) => { const l = legendOf({ behaviorId: id(n), param1, param2 }); return [l.main, l.sub]; };

// pointing.h: MOVE_X(h) = (h & 0xFFFF) << 16, MOVE_Y(v) = v & 0xFFFF; MOVE_UP = Y(-v), SCRL_UP = Y(+v).
const X = (h) => ((h & 0xFFFF) << 16) >>> 0, Y = (v) => v & 0xFFFF;
for (const v of [600, 1800, 7]) {   // scales with MOVE_VAL, only the sign matters
    eq(lg('mouse_move', Y(-v)), ['Mouse ↑', ''], `up ${v}`);
    eq(lg('mouse_move', Y(v)), ['Mouse ↓', '']);
    eq(lg('mouse_move', X(-v)), ['Mouse ←', '']);
    eq(lg('mouse_move', X(v)), ['Mouse →', '']);
    eq(lg('mouse_scroll', Y(v)), ['Scroll ↑', '']);
    eq(lg('mouse_scroll', Y(-v)), ['Scroll ↓', '']);
    eq(lg('mouse_scroll', X(-v)), ['Scroll ←', '']);
    eq(lg('mouse_scroll', X(v)), ['Scroll →', '']);
}
eq(lg('mouse_move', (X(-5) + Y(-5)) >>> 0), ['Mouse ↖', ''], 'diagonal');
eq(lg('mouse_move', (X(5) + Y(5)) >>> 0), ['Mouse ↘', '']);
eq(lg('mouse_move', 0), ['Mouse', ''], 'no direction');

eq(lg('Neru Hints'), ['Hints', 'Neru']);
eq(lg('Neru Menu'), ['Neru menu', 'Neru']);
const HID = { G: 0x0A, R: 0x15, S: 0x16, B: 0x05, D: 0x07, 2: 0x1F, C: 0x06, M: 0x10, N: 0x11, P: 0x13, X: 0x1B, Z: 0x1D, W: 0x1A, V: 0x19, Q: 0x14 };
const WANT = { G: 'Grid', R: 'R-grid', S: 'Scroll mode', B: 'Bisect', D: 'Drag', 2: 'Double', C: 'Right-click hint', M: 'Monitor pick',
    N: 'Next mon', P: 'Prev mon', X: 'Save pos', Z: 'Restore pos', W: 'Screen hints', V: 'Vision hints', Q: 'Neru Q' };
for (const [k, u] of Object.entries(HID)) for (const n of ['Neru Menu + Key (to base)', 'Neru Menu + Key (stay)']) eq(lg(n, 0x070000 | u), [WANT[k], 'Neru'], `${n} ${k}`);

eq(lg('Mouse Key Press', 1)[0], 'Click');
eq(lg('Mouse Key Press', 2)[0], 'Right click');
eq(lg('Mouse Key Press', 4)[0], 'Middle click');
eq(lg('Mouse Key Press', 8)[0], 'Back');
eq(lg('Mouse Key Press', 16)[0], 'Forward');
for (const { id: l, name } of layers) if (l > 1) eq(lg("Momentary Layer", l), [name, "mo"], `mo ${name}`);
eq(lg('Mouse Layer', 1, 1), ['Mouse', 'tog/hold']);
console.log('legend-neru-test ok');
