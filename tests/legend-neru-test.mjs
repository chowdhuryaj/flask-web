// Mouse layer legends: Neru menu letters, mouse move/scroll directions, mouse buttons.
// Behavior ids come from a name lookup on the Totem's live list (Totem-ZMK keymap-after.json),
// never hard-coded numbers; pointing params follow ZMK pointing.h (x high 16, y low 16).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setZmkContext } from '../zmk-keycodes.js?v=78';
import { legendOf } from '../legend.js?v=78';

const eq = (a, b, m = '') => assert.deepEqual(a, b, m);
const NAMES = ['mouse_move', 'mouse_scroll', 'Neru Hints', 'Neru Menu', 'Neru Menu + Key (to base)', 'Neru Menu + Key (stay)',
    'Mouse Layer', 'Mouse Key Press', 'Momentary Layer', 'Super Delete / Layer', 'Repeat / Layer', 'Adaptive Key / Layer',
    'Mouse Hold / Super Delete', 'Mouse Layer-Tap', 'Leader / Shift', 'Mod / Neru Hints', 'Mod / Neru Menu Key'];
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


// mm_*/sc_* macros (Totem-ZMK 6ec01aa): same glyph and label as the raw key, "(macro)" in the description.
{
    const { MOUSE_MACROS, describeBinding } = await import('../behavior-catalog.js?v=78');
    const macros = MOUSE_MACROS.map((m, i) => ({ id: 300 + i, displayName: m.name, metadata: [{ param1: [], param2: [] }] }));
    const nodeOnly = { id: 400, displayName: 'sc_left', metadata: [{ param1: [], param2: [] }] };   // no display-name: the device reports the node
    setZmkContext({ behaviors: new Map([...live, ...macros, nodeOnly].map((d) => [d.id, d])), layers });
    const m = (id) => { const l = legendOf({ behaviorId: id, param1: 0, param2: 0 }); return [l.main, l.sub, l.kind]; };
    eq(m(300), ['Mouse ↑', '', 'plain']);
    eq(m(307), ['Mouse ↘', '', 'plain']);
    eq(m(311), ['Scroll →', '', 'plain']);
    eq(m(400), ['Scroll ←', '', 'plain'], 'node-name fallback');
    const raw = legendOf({ behaviorId: id('mouse_move'), param1: (-1800) & 0xFFFF, param2: 0 });
    eq([raw.main, raw.sub, raw.kind], m(300), 'macro key reads exactly like the raw &mmv MOVE_UP key');
    eq(describeBinding({ behaviorId: 300, param1: 0, param2: 0 }, 'zmk-studio'), 'Mouse ↑ (macro)');
    eq(describeBinding({ behaviorId: 400, param1: 0, param2: 0 }, 'zmk-studio'), 'Scroll ← (macro)');
    setZmkContext({ behaviors: new Map(live.map((d) => [d.id, d])), layers });
}

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

// Firmware hold-taps: tap big, hold as a sub-label: layer blue, modifier amber.
const full = (n, p1, p2 = 0) => { const l = legendOf({ behaviorId: id(n), param1: p1, param2: p2 }); return [l.main, l.sub, l.kind, l.subKind]; };
const KP = (u) => 0x070000 | u;
eq(full('Super Delete / Layer', 2), ['Super Del', 'Scroll Slow', 'hold', 'layer']);
eq(full('Repeat / Layer', 3), ['Repeat', 'Scroll Fast', 'hold', 'layer']);
eq(full('Adaptive Key / Layer', 4), ['Adaptive', 'Mouse Slow', 'hold', 'layer']);
eq(full('Mouse Hold / Super Delete', 5), ['Super Del', 'Speed Up x5', 'hold', 'layer']);
eq(full('Mouse Layer-Tap', 4, KP(0x2C)), ['Spc', 'Mouse Slow', 'hold', 'layer']);
eq(full('Leader / Shift', KP(0xE1)), ['Leader', '⇧ Shift', 'hold', 'hold']);
eq(full('Mod / Neru Hints', KP(0xE0)), ['Neru Hints', '⌃ Ctrl', 'hold', 'hold']);
eq(full('Mod / Neru Menu Key', KP(0xE2), KP(0x0A)), ['Neru Grid', '⌥ Opt', 'hold', 'hold']);
eq(full('Mod / Neru Menu Key', KP(0xE3), KP(0x15)), ['Neru R-grid', '⌘ Cmd', 'hold', 'hold']);
eq(full('Mod / Neru Menu Key', KP(0xE1), KP(0x16)), ['Neru Scroll mode', '⇧ Shift', 'hold', 'hold']);
console.log('legend-neru-test ok');
