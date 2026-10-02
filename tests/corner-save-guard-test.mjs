// Final-verify F1: channel 0x28 (QMK corner chords) is never SAVEd — offline
// journal refuses it, reconnect replay drops it, FlaskProto refuses it on the
// QMK line. A 0x28 SAVE wedges the Svalboard (2026-08-14).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OfflineFlask, syncWorkspace } from '../offline.js?v=60';
import { FlaskProto, CH, V, CMD } from '../flaskproto.js?v=60';

let checks = 0;
const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
const ws = JSON.parse(readFileSync(new URL('./fixtures/svalboard-snapshot.json', import.meta.url)));

// 1. _journal refuses setU16/setI16 on 0x28, same message as setBytes.
const f = new OfflineFlask(ws);
await assert.rejects(f.setU16(CH.corner, V.ccEnabled, 1), /read-only offline/); checks++;
await assert.rejects(f.setI16(CH.corner, V.ccTerm, 40), /read-only offline/); checks++;
assert.equal(ws.dirty.tun[`${CH.corner}:${V.ccEnabled}`], undefined); checks++;

// 2. Replay backstop: an old workspace that journaled 0x28 never SAVEs it.
ws.dirty.tun[`${CH.corner}:${V.ccTerm}`] = { op: 'u16', val: 40 };
ws.dirty.tun[`${CH.dpi}:1`] = { op: 'u16', val: 3 };
ws.dirty.saves = [CH.corner];
const saved = [];
const app = {
    flask: {
        setU16: async (_c, _i, v) => v, setI16: async (_c, _i, v) => v,
        save: async (ch) => { saved.push(ch); },
    },
    vial: {}, keymap: null,
};
await syncWorkspace(app, ws);
assert.ok(!saved.includes(CH.corner), `0x28 saved on replay: ${saved}`); checks++;
assert.ok(saved.includes(CH.dpi), 'other touched channels still save'); checks++;

// 3. Lowest layer: FlaskProto.save refuses 0x28 unless the line is ZMK.
const sent = [];
const hid = { request: async (frame) => { sent.push(frame); return [CMD.save, frame[1], 0]; } };
const p = new FlaskProto(hid);
await assert.rejects(p.save(CH.corner), /never SAVE channel 0x28/); checks++;   // unset line
p.line = 'qmk';
await assert.rejects(p.save(CH.corner), /never SAVE channel 0x28/); checks++;
assert.equal(sent.length, 0, 'no frame reached the wire'); checks++;
await p.save(CH.dpi); checks++;
p.line = 'zmk';
await p.save(CH.tapDance); checks++;   // ZMK 0x28 = tap dance, legit
assert.deepEqual(sent.map((s) => s[1]), [CH.dpi, CH.tapDance]); checks++;
console.log(`corner-save-guard-test: ${checks} checks OK`);
