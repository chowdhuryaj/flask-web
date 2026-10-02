// WP4b: tile summaries (feed the picker's slot chips) and the channel 0x28 rule.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { macroSummary } from '../macros-tab.js?v=60';
import { tdSummary } from '../entries-tab.js?v=60';
import { encode } from '../behavior-catalog.js?v=60';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

eq(macroSummary([]), '');
eq(macroSummary([{ t: 'text', s: 'hello' }]), "types 'hello'");
eq(macroSummary([{ t: 'text', s: 'hello world, long' }]), "types 'hello world,…'");
eq(macroSummary([{ t: 'tap', kc: 4 }, { t: 'delay', ms: 50 }]), '2 steps');
eq(macroSummary([{ t: 'tap', kc: 4 }]), '1 step');
eq(tdSummary({ onTap: 0x04, onHold: 0x29, onDoubleTap: 0, onTapHold: 0 }), 'A / Esc');
eq(tdSummary({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0 }), '');
// tile click pastes these keycodes (QK_TAP_DANCE 0x5700, QK_MACRO 0x7700)
eq(encode('tap-dance', { slot: 0 }, 'qmk'), 0x5700);
eq(encode('tap-dance', { slot: 3 }, 'qmk'), 0x5703);
eq(encode('macro', { slot: 2 }, 'qmk'), 0x7702);

// Channel 0x28 has no save step on the QMK line (spec 3.2): the Chords tab
// must never touch the save registry.
const corner = readFileSync(new URL('../corner-tab.js?v=60', import.meta.url), 'utf8');
assert.ok(!/reloadBar|saveState|saveBar|markDirty|flask\.save/.test(corner.replace(/\/\/.*$/gm, '')), 'corner-tab.js registers or saves a channel');
checks++;
console.log(`tiles-test: ${checks} checks OK`);
