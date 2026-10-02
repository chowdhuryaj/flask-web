// WP7: the offline Svalboard serves channel 0x28 chord geometry and outputs
// from the workspace snapshot (was all zeros: no chords offline).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OfflineFlask } from '../offline.js?v=60';
import { CH, V, CC } from '../flaskproto.js?v=60';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ws = JSON.parse(readFileSync(new URL('./fixtures/svalboard-snapshot.json', import.meta.url)));
const f = new OfflineFlask(ws);
eq(await f.getU16(CH.corner, V.ccDefCount), 60, 'def count from the snapshot');
// def 4 = L index (row 1) centre + south: (1<<3)|2, (1<<3)|0 (corner_seed.c)
eq(await f.getBytes(CH.corner, V.ccDef, [4], 1), [4, 10, 8, 0], 'seed geometry');
eq((await f.getBytes(CH.corner, V.ccDef, [50], 1)).slice(1, 3), [CC.posNone, CC.posNone], 'retired thumb def');
eq(await f.getBytes(CH.corner, V.ccOut, [4, 0], 2), [4, 0, 0x00, 0x29], 'output Esc');
eq(await f.getBytes(CH.corner, V.ccOut, [4, 3], 2), [4, 3, 0x00, 0x29], 'other layer inherits layer 0');
eq(await f.getBytes(CH.corner, V.ccLayers, [4], 1), [4, 0, 1], 'own-layer mask');
await assert.rejects(f.setBytes(CH.corner, V.ccOut, [4, 0, 0, 4], 2), /read-only offline/); checks++;
console.log(`offline-chords-test: ${checks} checks OK`);
