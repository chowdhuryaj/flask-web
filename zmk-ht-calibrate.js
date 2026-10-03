// Tap-hold calibrator, DOM-free: log reading (0x54), drill text generation,
// typed-vs-expected diff and the PURE analysis that turns drill logs into
// timing / positional recommendations. UI: zmk-ht-calibrate-card.js. Wire
// contract: .workflow/scratch/ht-positional-contract.md.

import {
    HT_POSITIONAL, HT_LOG, decodeHoldtapLog, decodeHoldtapSlot, encodeHoldtapSlot,
    encodePositional, decodePositional,
} from './zmk-holdtap-codec.js?v=65';

const CH = 0x2A;
const SLOT = 0x50;
export const MIN_TAP_SAMPLES = 8;

// ---------------------------------------------------------------- device IO

const probes = new WeakMap();   // flask client → Map(id → Promise<boolean>)
/** Does the firmware answer value `id` (0x53 / 0x54)? Old firmware echoes 0xFF
 * and getBytes throws 'unhandled'. Memoized per flask client, but only the
 * definitive answers: a timeout or other transport error is "don't know" and
 * is probed again next time. */
export function hasFeature(flask, id) {
    if (!flask) return Promise.resolve(false);
    if (!probes.has(flask)) probes.set(flask, new Map());
    const m = probes.get(flask);
    if (!m.has(id)) {
        m.set(id, flask.getBytes(CH, id, id === HT_LOG ? [0, 0] : [0]).then(() => true, (e) => {
            if (e?.message !== 'unhandled') m.delete(id);
            return false;
        }));
    }
    return m.get(id);
}

/** One slot's positional rule → {slot, mode, positions}. */
export async function readPositional(flask, slot, count) {
    return decodePositional(await flask.getBytes(CH, HT_POSITIONAL, [slot], 1), count);
}

/** SET one slot's positional rule; resolves to the applied (echoed) value. */
export async function writePositional(flask, slot, mode, positions, count) {
    return decodePositional(await flask.setBytes(CH, HT_POSITIONAL, encodePositional({ slot, mode, positions }), 1), count);
}

/**
 * Drain the decision log from `since` (u16 seq): GET until a frame holds < 3
 * entries. Resolves to {entries, cursor (pass as the next `since`), dropped}.
 * dropped = entries the ring overwrote before this read (first_seq skipped
 * ahead of `since`, wrap-aware).
 */
export async function readLog(flask, since, maxFrames = 64) {
    const entries = [];
    let cur = since & 0xFFFF, dropped = 0;
    for (let i = 0; i < maxFrames; i++) {
        const d = decodeHoldtapLog(await flask.getBytes(CH, HT_LOG, [cur >> 8, cur & 0xFF]));
        if (i === 0 && d.entries.length) dropped = (d.firstSeq - cur) & 0xFFFF;
        entries.push(...d.entries);
        cur = (d.firstSeq + d.entries.length) & 0xFFFF;
        if (d.entries.length < 3) break;
    }
    return { entries, cursor: cur, dropped };
}

/**
 * Poll the log every `intervalMs` from "now" (what is in the ring already is
 * dropped). onEntries(list) per batch; onError(e) if a read fails mid-run (the
 * poll stops itself first). `hid` is paused for the run and resumed exactly
 * once, also when the very first read throws (then this rejects). `alive()`
 * false stops it (sheet gone). Resolves to stop(): waits for the in-flight
 * read, drains once more, resumes; nothing reaches onEntries after stop()
 * resolves. stop() is idempotent and safe to call from onError.
 */
export async function startLogPoll(flask, { hid, onEntries, onError, alive = () => true, intervalMs = 100 }) {
    hid?.pause?.();
    let resumed = false;
    const resume = () => { if (!resumed) { resumed = true; hid?.resume?.(); } };
    let cursor;
    try { cursor = (await readLog(flask, 0)).cursor; }
    catch (e) { resume(); throw e; }
    let inflight = null, stopP = null;
    const drain = async () => {
        const r = await readLog(flask, cursor);
        cursor = r.cursor;
        if (r.entries.length) onEntries(r.entries);
    };
    const tick = () => {
        if (inflight || stopP) return;
        inflight = drain().catch((e) => { stop(); onError?.(e); }).finally(() => { inflight = null; });
    };
    const timer = setInterval(() => { if (!alive()) stop(); else tick(); }, intervalMs);
    function stop() {
        stopP ??= (async () => {
            clearInterval(timer);
            await inflight;
            try { await drain(); } catch { /* final drain best effort */ }
            resume();
        })();
        return stopP;
    }
    return stop;
}

/** Apply a recommendation row ({slot, rec}) to the device: 0x50 term + idle
 * (quick-tap and flavor read back and kept), then 0x53 when it changes. The
 * caller sends SAVE once after all rows. */
export async function applyRecommendation(flask, row, count) {
    const { slot, rec } = row;
    if (rec.term != null || rec.idle != null) {
        const cur = decodeHoldtapSlot(await flask.getBytes(CH, SLOT, [slot], 1));
        await flask.setBytes(CH, SLOT, encodeHoldtapSlot({ ...cur, term: rec.term ?? cur.term, idle: rec.idle ?? cur.idle }), 1);
    }
    if (rec.mode != null) await writePositional(flask, slot, rec.mode, rec.positions ?? [], count);
}

// ----------------------------------------------------------------- analysis

const round10 = (v) => Math.round(v / 10) * 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Nearest-rank percentile of a numeric array (null when empty). */
export function percentile(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[clamp(Math.ceil((p / 100) * s.length) - 1, 0, s.length - 1)];
}

const countBy = (list, f) => list.reduce((m, e) => { const k = f(e); m[k] = (m[k] ?? 0) + 1; return m; }, {});

/**
 * PURE. Per hold-tap slot, from the two drills' log entries.
 *   typing   entries logged during the tap-intent drill (HOLD = misfire)
 *   holds    entries logged during the hold-intent drill (TAP = misfire)
 *   keys     [{slot, label, hand: 'left'|'right'}]
 *   current  {[slot]: {term, quick, idle, flavor, mode, positions}}
 *   handOfPos(pos) → 'left'|'right'|null   (for other_pos)
 *   triggersFor(hand) → positions of the OPPOSITE half for a key on `hand`
 * Returns one row per key: {slot, label, hand, tapSamples, tap:{p50,p95},
 * holdOther:{p10}, gap:{typingP90, holdP10}, misfires:{typing:{count,total,
 * byReason}, holds:{...}, sameHand}, rec} where rec is null ("not enough
 * data": fewer than MIN_TAP_SAMPLES tap-outcome typing entries) or
 * {term, idle, mode, positions, notes[], changed}. mode/positions are null
 * when the positional rule stays as it is.
 *
 * Rules (the brief's, with conflicts resolved here):
 *  term  = clamp(round10(tap held_ms p95 + 40), 150, 500). Taps must end
 *          before the timer. The tap-outcome held_ms are censored at the
 *          current term (a press held past it is a hold, never logged as a
 *          tap), so p95 alone could never rise past current + 40. The held_ms
 *          of HOLD-outcome typing entries (intended taps that misfired) are
 *          therefore added to the distribution; the 0xFFFF saturated value is
 *          ignored. The MIN_TAP_SAMPLES gate still counts tap outcomes only.
 *          Upper bound: when the slot's flavor is
 *          tap-preferred (2) holds are decided ONLY by the timer, so an
 *          intended hold whose other key lands at other_ms < term turns into a
 *          tap; the term must then not exceed p10 hold other_ms (- 10). With
 *          the other flavours another key's press/release decides, so other_ms
 *          does not bound the term. If the two bounds conflict the tap bound
 *          wins (accidental holds while typing are the complaint) and a note
 *          says so.
 *  idle  = clamp(round10(min(typing prior_gap p90, hold-drill prior_gap p10
 *          - 20)), 0, 250). Typing taps then fall inside the window (instant
 *          tap) while deliberate holds, which start after a pause, stay
 *          outside it. Without hold-drill data only the typing bound is used.
 *  mode  = 2 (on press) with the opposite half as triggers, only when a
 *          tap-intent misfire had other_pos on the key's own half and the slot
 *          is not already in mode 2. Mode 0 (firmware default) is never
 *          changed for any other reason. Flavor and quick-tap are not touched.
 */
export function analyzeHoldtap({ typing = [], holds = [], keys, current = {}, handOfPos = () => null, triggersFor = () => [] }) {
    return keys.map((k) => {
        const t = typing.filter((e) => e.slot === k.slot);
        const h = holds.filter((e) => e.slot === k.slot);
        const cur = current[k.slot] ?? {};
        const taps = t.filter((e) => !e.hold);
        const tHold = t.filter((e) => e.hold);              // tap-intent misfires
        const hTap = h.filter((e) => !e.hold);              // hold-intent misfires
        const heldTap = [...taps, ...tHold.filter((e) => e.heldMs < 0xFFFF)].map((e) => e.heldMs);   // uncensors the tap length
        const otherHold = h.filter((e) => e.hold && e.otherMs != null).map((e) => e.otherMs);
        const typingGap = t.map((e) => e.priorGapMs);
        const holdGap = h.map((e) => e.priorGapMs);
        const sameHand = tHold.filter((e) => e.otherPos != null && handOfPos(e.otherPos) === k.hand).length;
        const row = {
            slot: k.slot, label: k.label, hand: k.hand, tapSamples: taps.length,
            tap: { p50: percentile(heldTap, 50), p95: percentile(heldTap, 95) },
            holdOther: { p10: percentile(otherHold, 10) },
            gap: { typingP90: percentile(typingGap, 90), holdP10: percentile(holdGap, 10) },
            misfires: {
                typing: { count: tHold.length, total: t.length, byReason: countBy(tHold, (e) => e.reason) },
                holds: { count: hTap.length, total: h.length, byReason: countBy(hTap, (e) => e.reason) },
                sameHand,
            },
            rec: null,
        };
        if (taps.length < MIN_TAP_SAMPLES) return row;

        const notes = [];
        const term = clamp(round10(row.tap.p95 + 40), 150, 500);
        if (cur.flavor === 2 && row.holdOther.p10 != null && term > row.holdOther.p10 - 10) {
            notes.push(`Your holds press the second key after ${row.holdOther.p10} ms but your taps last up to ${row.tap.p95} ms. `
                + 'With tap-preferred a hold needs the timer, so one of them will misfire. Kept the tap-safe term; try Balanced flavor.');
        }
        let idle = row.gap.typingP90;
        if (row.gap.holdP10 != null) idle = Math.min(idle, row.gap.holdP10 - 20);
        idle = clamp(round10(idle), 0, 250);

        const wantPositional = sameHand > 0 && cur.mode !== 2;
        if (wantPositional) notes.push(`${sameHand} same-hand key press(es) turned this tap into a hold. Same hand = tap on press stops that.`);
        const rec = { term, idle, mode: wantPositional ? 2 : null, positions: wantPositional ? triggersFor(k.hand) : null, notes };
        rec.changed = { term: term !== cur.term, idle: idle !== cur.idle, positional: wantPositional };
        row.rec = rec;
        return row;
    });
}

// ------------------------------------------------------------- drill text

/** HID usage → the character a tap types (letters, Space), or '⌫' / '⌦'; null otherwise. */
export function usageChar(usage) {
    if (usage >= 0x04 && usage <= 0x1D) return String.fromCharCode(97 + usage - 0x04);
    if (usage === 0x2C) return ' ';
    if (usage === 0x2A) return '⌫';
    if (usage === 0x4C) return '⌦';
    return null;
}

const rng = (seed) => () => {   // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Drill 1 text. keys = hold-tap keys [{slot, ch, hand}] (ch from usageChar),
 * letters = every typable letter key [{ch, hand}] (hold-tap keys included).
 * Each key gets `reps` groups "a K b" where a and b are on the key's own hand
 * (a same-hand roll into and out of K); every third group starts on the
 * opposite hand instead. ⌫ groups are "a ⌫ b" (a is erased); ⌦ presses at the
 * end of text delete nothing. Deterministic per seed.
 * @returns {{text: string, expected: string, groups: number}}
 */
export function buildPassage({ keys, letters, reps = 10, seed = 1 }) {
    const rand = rng(seed);
    const pick = (hand, not) => {
        const pool = letters.filter((l) => l.hand === hand && l.ch !== not && l.ch !== ' ');
        const any = pool.length ? pool : letters.filter((l) => l.ch !== not && l.ch !== ' ');
        return any[Math.floor(rand() * any.length)]?.ch ?? 'e';
    };
    const opposite = (h) => (h === 'left' ? 'right' : 'left');
    const groups = [];
    for (const k of keys) {
        if (!k.ch) continue;
        for (let i = 0; i < reps; i++) {
            const a = pick(i % 3 === 2 ? opposite(k.hand) : k.hand, k.ch), b = pick(k.hand, k.ch);
            groups.push(k.ch === '⌦' ? [a, k.ch] : [a, k.ch, b]);
        }
    }
    for (let i = groups.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [groups[i], groups[j]] = [groups[j], groups[i]]; }
    const text = groups.map((g) => g.join('')).join(' ');
    let expected = '';
    for (const c of text) {
        if (c === '⌫') expected = expected.slice(0, -1);
        else if (c !== '⌦') expected += c;
    }
    return { text, expected, groups: groups.length };
}

export const BROWSER_CHORD_LETTERS = 'wtnqkr';   // Cmd/Ctrl + these closes, quits, opens, reloads or opens the palette

/**
 * Drill 2 prompts, key by key: `reps` x "hold K + tap <opposite-hand letter>"
 * then `alone` x "hold K alone". keys = [{slot, hand, name}] (name e.g.
 * "T (Ctrl)"), letters = [{ch, hand}]. Returns [{slot, other: letter|null, text}].
 * A held Ctrl/Cmd + letter must not hit a browser shortcut, so W T N Q K R
 * are never the "other" key (the pool may end up empty: only "alone" prompts).
 */
export function holdPrompts({ keys, letters, reps = 4, alone = 2 }) {
    const out = [];
    let n = 0;
    for (const k of keys) {
        const pool = letters.filter((l) => l.hand !== k.hand && l.ch !== ' ' && !BROWSER_CHORD_LETTERS.includes(l.ch));
        for (let i = 0; i < reps && pool.length; i++) {
            const o = pool[n++ % pool.length].ch;
            out.push({ slot: k.slot, other: o, text: `Hold ${k.name}, tap ${o.toUpperCase()} on the other hand, release both` });
        }
        for (let i = 0; i < alone; i++) out.push({ slot: k.slot, other: null, text: `Hold ${k.name} alone for about half a second` });
    }
    return out;
}

/** Typing drill is complete: at least the expected length and the last typed
 * character is the expected last one. The caller waits a moment before finishing
 * so trailing Backspace / Delete presses are still logged. */
export function typedEnough(typed, expected) {
    return typed.length >= expected.length && typed.slice(-1) === expected.slice(-1);
}

/** Edit-distance alignment of what was typed against the expected text.
 * @returns {{marks: ('ok'|'wrong'|'missing')[], extra: number, errors: number}}
 *   marks[i] is for expected[i]; extra = typed characters with no counterpart. */
export function diffTyped(expected, typed) {
    const n = expected.length, m = typed.length;
    const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
    for (let j = 0; j <= m; j++) d[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (expected[i - 1] === typed[j - 1] ? 0 : 1));
        }
    }
    const marks = new Array(n).fill('ok');
    let i = n, j = m, extra = 0;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (expected[i - 1] === typed[j - 1] ? 0 : 1)) {
            if (expected[i - 1] !== typed[j - 1]) marks[i - 1] = 'wrong';
            i--; j--;
        } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { marks[i - 1] = 'missing'; i--; }
        else { extra++; j--; }
    }
    return { marks, extra, errors: d[n][m] };
}
