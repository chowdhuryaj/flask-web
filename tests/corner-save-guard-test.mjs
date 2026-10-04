// Channel 0x28 (QMK corner chords) is never SAVEd: the offline journal
// refuses it, reconnect replay drops its SAVE, FlaskProto refuses it unless
// the line is ZMK, and save-state never registers it on the QMK line. A 0x28
// SAVE wedged the Svalboard (2026-08-14). 0x28 is ZMK tap dance, which saves.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checks = 0;
const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), key: () => null, length: 0 };
const { OfflineFlask, syncWorkspace } = await import('../offline.js?v=77');
const { FlaskProto, CH_QMK, CH_ZMK, V_QMK, CMD } = await import('../flaskproto.js?v=77');
const { SaveState, assertRegistrable } = await import('../save-state.js?v=77');
const ws = JSON.parse(readFileSync(new URL('./fixtures/svalboard-snapshot.json', import.meta.url)));

// 1. _journal refuses setU16/setI16/setBytes on 0x28 for a Svalboard workspace.
const f = new OfflineFlask(ws);
await assert.rejects(f.setU16(CH_QMK.corner, V_QMK.ccEnabled, 1), /read-only offline/); checks++;
await assert.rejects(f.setI16(CH_QMK.corner, V_QMK.ccTerm, 40), /read-only offline/); checks++;
await assert.rejects(f.setBytes(CH_QMK.corner, V_QMK.ccOut, [0, 0, 0, 4]), /read-only offline/); checks++;
assert.equal(ws.dirty.tun[`${CH_QMK.corner}:${V_QMK.ccEnabled}`], undefined); checks++;
// Live ids are not journaled (mouse-button release).
await f.setU16(CH_QMK.mouseButtons, V_QMK.mbLockMask, 0);
assert.equal(ws.dirty.tun[`${CH_QMK.mouseButtons}:${V_QMK.mbLockMask}`], undefined); checks++;

// 2. Replay backstop: an old workspace that journaled 0x28 never SAVEs it.
ws.dirty.tun[`${CH_QMK.corner}:${V_QMK.ccTerm}`] = { op: 'u16', val: 40 };
ws.dirty.tun[`${CH_QMK.dpi}:1`] = { op: 'u16', val: 3 };
ws.dirty.saves = [CH_QMK.corner];
const saved = [];
const app = {
    flask: {
        setU16: async (_c, _i, v) => v, setI16: async (_c, _i, v) => v,
        save: async (ch) => { saved.push(ch); },
    },
};
await syncWorkspace(app, ws);
assert.ok(!saved.includes(CH_QMK.corner), `0x28 saved on replay: ${saved}`); checks++;
assert.ok(saved.includes(CH_QMK.dpi), 'other touched channels still save'); checks++;
assert.equal(ws.dirty.tun[`${CH_QMK.corner}:${V_QMK.ccTerm}`], undefined, '0x28 SET applied (persists itself), not left queued'); checks++;

// 3. Lowest layer: FlaskProto.save refuses 0x28 unless the line is ZMK.
const sent = [];
const hid = { request: async (frame) => { sent.push(frame); return [CMD.save, frame[1], 0]; } };
const p = new FlaskProto(hid);
await assert.rejects(p.save(CH_QMK.corner), /never SAVE channel 0x28/); checks++;   // unset line
p.line = 'qmk';
await assert.rejects(p.save(CH_QMK.corner), /never SAVE channel 0x28/); checks++;
assert.equal(sent.length, 0, 'no frame reached the wire'); checks++;
await p.save(CH_QMK.dpi); checks++;
p.line = 'zmk';
await p.save(CH_ZMK.tapDance); checks++;   // ZMK 0x28 = tap dance, legit
assert.deepEqual(sent.map((s) => s[1]), [CH_QMK.dpi, CH_ZMK.tapDance]); checks++;

// ZMK line keeps 0x28 (tap dance): replay still saves it there.
ws.dirty.tun[`${CH_ZMK.tapDance}:1`] = { op: 'u16', val: 1 };
saved.length = 0;
app.flask.line = 'zmk';
await syncWorkspace(app, ws);
assert.ok(saved.includes(CH_ZMK.tapDance), 'ZMK replay saves 0x28 tap dance'); checks++;
const { ZmkOfflineFlask, createZmkTemplate } = await import('../zmk-offline.js?v=77');
await new ZmkOfflineFlask(createZmkTemplate('imprint')).setU16(CH_ZMK.tapDance, 1, 1); checks++;

// 4. save-state never registers 0x28 on the QMK line; ZMK registers it.
assert.throws(() => assertRegistrable('qmk', 0x28), /never register/); checks++;
assertRegistrable('zmk', 0x28); assertRegistrable(null, 0x28); checks++;
const st = new SaveState();
st.setLine('qmk');
assert.throws(() => st.markDirty(CH_QMK.corner, 'Chords', async () => {}), /never register/); checks++;
st.markDirty(CH_QMK.dpi, 'DPI', async () => {});
assert.deepEqual(st.dirty().map((d) => d.source), [CH_QMK.dpi]); checks++;
st.setLine('zmk');
st.markDirty(CH_ZMK.tapDance, 'Tap dance', async () => {}); checks++;
console.log(`corner-save-guard-test: ${checks} checks OK`);
