// Tap-hold calibrator: 0x53 codec, 0x54 log decode (seq wrap, drain loop),
// analysis math, passage / prompts / diff. All pure or against a fake flask.
import assert from 'node:assert/strict';
import {
    encodePositional, decodePositional, decodeHoldtapLog, handsOf, triggerPreset,
} from '../zmk-holdtap-codec.js?v=66';
import {
    analyzeHoldtap, percentile, readLog, buildPassage, holdPrompts, diffTyped, usageChar, hasFeature, applyRecommendation,
} from '../zmk-ht-calibrate.js?v=66';
import { TOTEM_LAYOUT } from '../zmk-totem-layout.js?v=66';

let checks = 0;
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m = '') => { assert.ok(c, m); checks++; };

// ---- 0x53 codec ----
{
    const b = encodePositional({ slot: 20, mode: 2, positions: [5, 9, 15, 37] });
    eq(b.length, 28);
    eq(b.slice(0, 3), [20, 2, 0b00100000], 'pos 5 = byte 0 bit 5');
    eq(b[2 + 1], 0b10000010, 'pos 9 and 15 = byte 1 bits 1 and 7');
    eq(b[2 + 4], 0b00100000, 'pos 37 = byte 4 bit 5');
    const d = decodePositional(b);
    eq(d, { slot: 20, mode: 2, positions: [5, 9, 15, 37] });
    eq(decodePositional(b, 10).positions, [5, 9], 'bits at or past the key count are dropped');
    eq(encodePositional({ slot: 1, mode: 0, positions: [300, -1] }).slice(2).every((x) => x === 0), true, 'out-of-range ignored');
    eq(decodePositional([3, 3, ...new Array(26).fill(0)]).positions, []);
}

// ---- hands + trigger presets on the real Totem layout ----
{
    const keys = TOTEM_LAYOUT.keys.map((k, pos) => ({ pos, x: k.x + k.w / 2, y: k.y + k.h / 2 }));
    const hands = handsOf(keys);
    const range = (...r) => r.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
    const L = range([0, 4], [10, 14], [20, 25], [32, 34]), R = range([5, 9], [15, 19], [26, 31], [35, 37]);
    eq(keys.filter((k) => hands.get(k.pos) === 'left').map((k) => k.pos), L, 'left half');
    eq(keys.filter((k) => hands.get(k.pos) === 'right').map((k) => k.pos), R, 'right half');
    eq(triggerPreset(keys, 'left'), R, 'opposite of left = right half');
    eq(triggerPreset(keys, 'right'), L);
    eq(triggerPreset(keys, 'left', true), [...range([5, 9], [15, 19], [26, 31], [32, 34], [35, 37])].sort((a, b) => a - b), 'plus own thumbs 32-34');
}

// ---- 0x54 decode, seq wrap ----
const frame = (firstSeq, entries, next) => {
    const b = new Array(29).fill(0);
    b[0] = firstSeq >> 8; b[1] = firstSeq & 0xFF; b[2] = entries.length;
    entries.forEach((e, i) => {
        const o = 3 + i * 8;
        b[o] = e.slot; b[o + 1] = (e.hold ? 1 : 0) | ((e.reason ?? 0) << 1); b[o + 2] = e.otherPos ?? 0xFF;
        b[o + 3] = e.heldMs >> 8; b[o + 4] = e.heldMs & 0xFF;
        const om = e.otherMs ?? 0xFFFF; b[o + 5] = om >> 8; b[o + 6] = om & 0xFF; b[o + 7] = e.gap4 ?? 0;
    });
    b[27] = next >> 8; b[28] = next & 0xFF;
    return b;
};
{
    const d = decodeHoldtapLog(frame(0xFFFE, [
        { slot: 20, hold: false, reason: 5, heldMs: 90, gap4: 25 },
        { slot: 31, hold: true, reason: 1, otherPos: 7, heldMs: 400, otherMs: 0x0123, gap4: 255 },
        { slot: 33, hold: false, reason: 2, otherPos: 9, heldMs: 0xFFFF },
    ], 0x0001));
    eq(d.entries.map((e) => e.seq), [0xFFFE, 0xFFFF, 0], 'seq wraps at u16');
    eq(d.next, 1);
    eq(d.entries[0], { seq: 0xFFFE, slot: 20, hold: false, reason: 5, otherPos: null, heldMs: 90, otherMs: null, priorGapMs: 100 });
    eq(d.entries[1], { seq: 0xFFFF, slot: 31, hold: true, reason: 1, otherPos: 7, heldMs: 400, otherMs: 0x123, priorGapMs: 1020 });
    eq(d.entries[2].heldMs, 0xFFFF, 'held_ms saturates');
    eq(decodeHoldtapLog(frame(77, [], 77)).entries, [], 'n = 0');
}

// ---- readLog: loop until n < 3, wrap, gap ----
{
    const E = (slot) => ({ slot, hold: false, heldMs: 100 });
    const ring = [];   // seq → entry, ring starts at 0xFFFD and wraps
    for (let i = 0; i < 7; i++) ring.push({ seq: (0xFFFD + i) & 0xFFFF, ...E(i) });
    const next = (0xFFFD + 7) & 0xFFFF;
    const asked = [];
    const flask = { async getBytes(ch, id, p) {
        asked.push((p[0] << 8) | p[1]);
        const since = (p[0] << 8) | p[1];
        const idx = ring.findIndex((r) => ((r.seq - since) & 0xFFFF) < 0x8000);
        const take = idx < 0 ? [] : ring.slice(idx, idx + 3);
        return frame(take.length ? take[0].seq : next, take, next);
    } };
    const r = await readLog(flask, 0xFFFD);
    eq(r.entries.map((e) => e.slot), [0, 1, 2, 3, 4, 5, 6]);
    eq(asked, [0xFFFD, 0x0000, 0x0003], 'since = first_seq + n, repeat while n == 3 (7 entries: 3+3+1)');
    eq(r.cursor, next); eq(r.dropped, 0);
    const r2 = await readLog(flask, next);
    eq(r2.entries, []); eq(r2.cursor, next);
    const r3 = await readLog(flask, 0xFFF0);   // older than the ring
    eq(r3.dropped, 0xFFFD - 0xFFF0, 'gap visible from first_seq');
    eq(r3.entries.length, 7);
}

// ---- feature detect: 0xFF echo (getBytes throws) ----
{
    const old = { async getBytes() { throw new Error('unhandled'); } };
    const neu = { async getBytes() { return new Array(29).fill(0); } };
    eq(await hasFeature(old, 0x53), false); eq(await hasFeature(neu, 0x53), true);
}

// ---- percentile ----
eq(percentile([], 50), null);
eq(percentile([5, 1, 3, 2, 4, 9, 7, 8, 6, 10], 50), 5);
eq(percentile([5, 1, 3, 2, 4, 9, 7, 8, 6, 10], 95), 10);
eq(percentile([5, 1, 3, 2, 4, 9, 7, 8, 6, 10], 10), 1);

// ---- analysis ----
const key = (slot, hand = 'left') => ({ slot, hand, label: `key ${slot}` });
const tapE = (slot, heldMs, gap = 60) => ({ slot, hold: false, reason: 5, otherPos: null, heldMs, otherMs: null, priorGapMs: gap });
const holdE = (slot, heldMs, other = 150, gap = 600, reason = 0, otherPos = 8) => ({ slot, hold: true, reason, otherPos, heldMs, otherMs: other, priorGapMs: gap });
const hands = (p) => (p < 20 ? 'left' : 'right');
const triggersFor = (h) => (h === 'left' ? [20, 21] : [0, 1]);
{
    // 10 taps held 80..170 ms; p95 = 170 -> 170 + 40 = 210
    const typing = Array.from({ length: 10 }, (_, i) => tapE(1, 80 + i * 10, 40 + i * 8));
    const holds = Array.from({ length: 6 }, (_, i) => holdE(1, 500, 150 + i * 10, 400 + i * 40));
    const [r] = analyzeHoldtap({ typing, holds, keys: [key(1)], current: { 1: { term: 280, idle: 150, flavor: 1, mode: 0 } }, handOfPos: hands, triggersFor });
    eq(r.tap, { p50: 120, p95: 170 }); eq(r.tapSamples, 10);
    eq(r.holdOther.p10, 150);
    eq(r.gap.typingP90, 40 + 8 * 8 /* nearest rank: 9th of 10 */);
    eq(r.rec.term, 210, 'round10(p95 + 40)');
    // typing p90 gap = 104 ms; hold p10 gap - 20 = 380 -> min = 104 -> round10 = 100
    eq(r.rec.idle, 100);
    eq(r.rec.mode, null); eq(r.rec.positions, null, 'no same-hand misfire: positional untouched (mode 0 stays)');
    eq(r.rec.changed, { term: true, idle: true, positional: false });
    eq(r.misfires.typing, { count: 0, total: 10, byReason: {} });
}
{
    // clamps: very fast taps floor at 150; very slow cap at 500; idle cap 250
    const fast = Array.from({ length: 8 }, () => tapE(1, 50, 2000));
    eq(analyzeHoldtap({ typing: fast, keys: [key(1)], current: {} })[0].rec.term, 150, 'floor 150');
    eq(analyzeHoldtap({ typing: fast, keys: [key(1)], current: {} })[0].rec.idle, 250, 'idle capped at 250 (no hold drill data: typing bound only)');
    const slow = Array.from({ length: 8 }, () => tapE(1, 700, 10));
    eq(analyzeHoldtap({ typing: slow, keys: [key(1)], current: {} })[0].rec.term, 500, 'cap 500');
    eq(analyzeHoldtap({ typing: slow, keys: [key(1)], current: {} })[0].rec.idle, 10);
    // hold-drill prior gap below typing p90 pulls idle down; never negative
    const typing = Array.from({ length: 8 }, () => tapE(1, 100, 200));
    const holds = Array.from({ length: 4 }, () => holdE(1, 500, 150, 100));
    eq(analyzeHoldtap({ typing, holds, keys: [key(1)], current: {} })[0].rec.idle, 80, 'min(200, 100 - 20)');
    const holds2 = Array.from({ length: 4 }, () => holdE(1, 500, 150, 10));
    eq(analyzeHoldtap({ typing, holds: holds2, keys: [key(1)], current: {} })[0].rec.idle, 0, 'clamped at 0');
}
{
    // tap-preferred + holds that press the other key early: conflict note, tap bound wins
    const typing = Array.from({ length: 10 }, () => tapE(1, 200));
    const holds = Array.from({ length: 5 }, () => holdE(1, 600, 120));
    const [r] = analyzeHoldtap({ typing, holds, keys: [key(1)], current: { 1: { term: 280, flavor: 2 } } });
    eq(r.rec.term, 240);
    ok(r.rec.notes.some((n) => /tap-preferred/.test(n)), 'conflict is explained');
    const [r2] = analyzeHoldtap({ typing, holds, keys: [key(1)], current: { 1: { term: 280, flavor: 1 } } });
    eq(r2.rec.notes, [], 'balanced flavor: other_ms does not bound the term');
}
{
    // not enough data: < 8 tap-outcome typing entries
    const typing = [...Array.from({ length: 7 }, () => tapE(1, 100)), holdE(1, 400)];
    const [r] = analyzeHoldtap({ typing, keys: [key(1)], current: {} });
    eq(r.rec, null); eq(r.tapSamples, 7);
    eq(analyzeHoldtap({ keys: [key(1)], current: {} })[0].rec, null, 'no entries at all');
}
{
    // positional: a tap-intent misfire whose other key was on the same half
    const typing = [...Array.from({ length: 9 }, () => tapE(1, 100)),
        holdE(1, 350, 120, 80, 1, 3 /* left, same hand */), holdE(1, 380, 90, 80, 1, 25 /* right */)];
    const rows = (mode) => analyzeHoldtap({ typing, keys: [key(1, 'left')], current: { 1: { term: 280, idle: 150, flavor: 1, mode } }, handOfPos: hands, triggersFor });
    const [r] = rows(0);
    eq(r.misfires.sameHand, 1); eq(r.misfires.typing, { count: 2, total: 11, byReason: { 1: 2 } });
    eq(r.rec.mode, 2); eq(r.rec.positions, [20, 21], 'opposite half as triggers'); eq(r.rec.changed.positional, true);
    eq(rows(2)[0].rec.mode, null, 'already on press: no change');
    // misfires only on the OTHER hand: positional not recommended
    const t2 = [...Array.from({ length: 9 }, () => tapE(1, 100)), holdE(1, 350, 120, 80, 1, 25)];
    eq(analyzeHoldtap({ typing: t2, keys: [key(1, 'left')], current: { 1: { mode: 0 } }, handOfPos: hands, triggersFor })[0].rec.mode, null);
    // hold-intent misfires count by reason
    const holds = [tapE(1, 300), { ...tapE(1, 200), reason: 3 }, holdE(1, 500)];
    eq(analyzeHoldtap({ typing, holds, keys: [key(1)], current: {} })[0].misfires.holds, { count: 2, total: 3, byReason: { 5: 1, 3: 1 } });
}

// ---- apply: 0x50 keeps quick/flavor, 0x53 only when mode is recommended ----
{
    const sent = [];
    const flask = {
        async getBytes() { return [4, 0x01, 0x18, 0x00, 0xAF, 0x00, 0x96, 1, 0, ...new Array(20).fill(0)]; },
        async setBytes(ch, id, p) { sent.push([id, [...p]]); return p; },
    };
    await applyRecommendation(flask, { slot: 4, rec: { term: 210, idle: 100, mode: null, positions: null } }, 38);
    eq(sent.length, 1); eq(sent[0], [0x50, [4, 0, 210, 0, 0xAF, 0, 100, 1, 0]], 'quick 175 and flavor 1 kept');
    sent.length = 0;
    await applyRecommendation(flask, { slot: 4, rec: { term: 210, idle: 100, mode: 2, positions: [5, 6] } }, 38);
    eq(sent.map((s) => s[0]), [0x50, 0x53]); eq(sent[1][1].slice(0, 3), [4, 2, 0b01100000]);
}

// ---- drill text ----
{
    eq(usageChar(0x17), 't'); eq(usageChar(0x2C), ' '); eq(usageChar(0x2A), '⌫'); eq(usageChar(0x4C), '⌦'); eq(usageChar(0x28), null);
    const letters = 'qwertasdfgzxcvb'.split('').map((ch) => ({ ch, hand: 'left' })).concat('yuiophjklnm'.split('').map((ch) => ({ ch, hand: 'right' })));
    const keys = [{ slot: 1, ch: 't', hand: 'left' }, { slot: 2, ch: 'h', hand: 'right' }, { slot: 3, ch: ' ', hand: 'left' },
        { slot: 4, ch: '⌫', hand: 'right' }, { slot: 5, ch: '⌦', hand: 'left' }, { slot: 6, ch: null, hand: 'left' }];
    const p = buildPassage({ keys, letters, reps: 10, seed: 3 });
    eq(p.groups, 50, 'no group for non-text keys');
    eq(buildPassage({ keys, letters, reps: 10, seed: 3 }).text, p.text, 'deterministic');
    ok(p.text.split(' ').filter((g) => g.includes('t')).length >= 10, 'T exercised 10+ times');
    ok((p.text.match(/⌫/g) ?? []).length === 10 && (p.text.match(/⌦/g) ?? []).length === 10);
    ok(!/[⌫⌦]/.test(p.expected));
    eq(buildPassage({ keys: [{ slot: 4, ch: '⌫', hand: 'right' }], letters, reps: 1, seed: 1 }).expected.length, 1, 'a ⌫ b -> one char left');
    // each T group is a same-hand roll in and out (first two thirds of reps)
    const g = buildPassage({ keys: [{ slot: 1, ch: 't', hand: 'left' }], letters, reps: 3, seed: 9 }).text.split(' ');
    const isLeft = (c) => letters.find((l) => l.ch === c)?.hand === 'left';
    ok(g.filter((w) => isLeft(w[0]) && isLeft(w[2])).length >= 2);
    const pr = holdPrompts({ keys: [{ slot: 1, hand: 'left', name: 'T (Ctrl)' }, { slot: 2, hand: 'right', name: 'H (Shift)' }], letters });
    eq(pr.length, 12); eq(pr.filter((x) => x.other === null).length, 4);
    ok(pr.filter((x) => x.slot === 1 && x.other).every((x) => letters.find((l) => l.ch === x.other).hand === 'right'), 'opposite-hand letter');
    ok(/Ctrl/.test(pr[0].text));
}

// ---- typed vs expected ----
{
    eq(diffTyped('there', 'there'), { marks: ['ok', 'ok', 'ok', 'ok', 'ok'], extra: 0, errors: 0 });
    eq(diffTyped('there', 'Their').errors, 3);
    eq(diffTyped('abc', 'ab'), { marks: ['ok', 'ok', 'missing'], extra: 0, errors: 1 });
    eq(diffTyped('abc', 'abxc'), { marks: ['ok', 'ok', 'ok'], extra: 1, errors: 1 });
    eq(diffTyped('abc', 'axc').marks, ['ok', 'wrong', 'ok']);
}

console.log(`ht-calibrate-test: ${checks} checks OK`);
