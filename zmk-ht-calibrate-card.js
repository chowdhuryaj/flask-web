// "Calibrate tap-hold" sheet: a typing drill (tap intent) and a holds drill
// (hold intent) read the keyboard's decision log (flask_holdtap 0x54), then
// zmk-ht-calibrate.js turns the log into a term / prior-idle / same-hand
// recommendation per hold-tap key. Apply writes 0x50 (+0x53) and SAVE.
// Opened from Behaviour › Hold timing, the Keymap per-key timing card and the
// Test tab. Needs firmware with 0x54; otherwise it says so.

import { el, modal, toast } from './ui.js?v=73';
import { board } from './board.js?v=73';
import { saveState } from './save-state.js?v=73';
import { decode, tapHoldSpecOf, holdTapParts } from './behavior-catalog.js?v=73';
import { HOLDTAP_FLAVORS, handsOf, triggerPreset, POSITIONAL_MODES, LOG_REASONS, decodeHoldtapSlot, HT_LOG } from './zmk-holdtap-codec.js?v=73';
import {
    hasFeature, readPositional, startLogPoll, applyRecommendation, analyzeHoldtap, usageChar,
    buildPassage, holdPrompts, diffTyped, typedEnough, MIN_TAP_SAMPLES,
} from './zmk-ht-calibrate.js?v=73';

const CH = 0x2A;
const ADAPTER = 'zmk-studio';
export const NEEDS_LOG = 'Needs Totem firmware with the hold-tap decision log (flask_holdtap 0x54).';
const MOD_NAMES = [[0x01, 'Ctrl'], [0x02, 'Shift'], [0x04, 'Alt'], [0x08, 'Gui']];
const modName = (mask) => {
    const m = (mask & 0xF) || ((mask >> 4) & 0xF);
    return MOD_NAMES.filter(([b]) => m & b).map(([, n]) => n).join('+') || 'mod';
};

/**
 * The layer shown on the board, as the calibrator's key model.
 * keys    = keys bound to a flask hold-tap (slot = key position):
 *           {slot, pos, hand, ch (tap char or null), holdName, name}
 * letters = every plain or hold-tap key that types a letter / Space: {ch, hand, ht}
 * boardKeys = [{pos, x, y}] for the hand split and trigger presets
 */
export function readHoldtapKeys() {
    const all = board.positions();
    const hands = handsOf(all);
    const keys = [], letters = [];
    for (const p of all) {
        let d, spec;
        try { d = decode(p.binding, ADAPTER); spec = tapHoldSpecOf(p.binding, ADAPTER); } catch { continue; }
        if (!spec) continue;
        const hand = hands.get(p.pos);
        const ch = spec.tap?.mods ? null : usageChar(spec.tap?.key);
        const live = d.params?.live;
        const isHt = (d.entryId === 'mod-tap' || d.entryId === 'layer-tap') && live && live !== 'off' && live !== 'fixed';
        if (ch && ch !== '⌫' && ch !== '⌦') letters.push({ ch, hand, ht: isHt });
        if (!isHt) continue;
        const h = spec.hold;
        const holdName = h?.kind === 'mods' ? modName(h.mods) : h?.kind === 'layer' ? (holdTapParts(p.binding, ADAPTER)?.hold ?? 'layer') : 'hold';
        const tapName = ch === ' ' ? 'Space' : ch === '⌫' ? 'Backspace' : ch === '⌦' ? 'Delete' : ch ? ch.toUpperCase() : `key ${p.pos}`;
        keys.push({ slot: p.pos, pos: p.pos, hand, ch, holdName, name: `${tapName} (${holdName}, key ${p.pos})` });
    }
    return { keys, letters, boardKeys: all.map((p) => ({ pos: p.pos, x: p.x, y: p.y })) };
}

const REASON_SHORT = ['other key', 'timer', 'same-hand tap', 'prior idle', 'quick-tap', 'released early'];
const reasonText = (by) => Object.entries(by).map(([r, n]) => `${n}× ${REASON_SHORT[r] ?? r}`).join(', ');

function fmtPositional(p) {
    if (!p) return '';
    return POSITIONAL_MODES[p.mode]?.label.replace(/ \(.*\)/, '') ?? `mode ${p.mode}`;
}

export function calibratorCard(app) {
    const flask = app.flask;
    const root = el('div', { class: 'ht-cal', 'data-card': 'ht-calibrator' });
    const S = { typing: [], holds: [], retest: null, rows: null, current: {}, running: null, model: null };
    const aborts = new Set();   // per-drill cleanup, run by root.dispose()
    let prevLayer = null, disposed = false;
    // While a drill runs a held mod + letter can fire browser shortcuts: guard unload, mute the command palette.
    const unloadGuard = (e) => { e.preventDefault(); e.returnValue = ''; };
    function setRunning(kind) {
        S.running = kind;
        if (typeof document === 'undefined') return;
        if (kind) document.body.dataset.htDrill = '1'; else delete document.body.dataset.htDrill;
        window[kind ? 'addEventListener' : 'removeEventListener']('beforeunload', unloadGuard);
    }
    /** Sheet closed: stop whatever runs, give the board its layer back. */
    root.dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const f of [...aborts]) f();
        setRunning(null);
        if (prevLayer != null) { try { board.setLayer(prevLayer, { keepSelection: true }); } catch { /* board gone */ } }
    };

    if (app.offline) {
        root.append(el('p', { class: 'hint', text: 'The calibrator reads the keyboard’s live decision log. It is not simulated in the offline preview.' }));
        return root;
    }
    root.append(el('p', { class: 'hint', text: 'Reading this keyboard…' }));
    hasFeature(flask, HT_LOG).then((ok) => {
        if (!ok) { root.replaceChildren(el('p', { class: 'hint warn', text: NEEDS_LOG })); return; }
        if (disposed) return;
        try { prevLayer = board.layer; board.setLayer(0, { keepSelection: true }); } catch { /* no board yet */ }   // drills target the base layer
        S.model = readHoldtapKeys();
        if (!S.model.keys.length) { root.replaceChildren(el('p', { class: 'hint warn', text: 'No hold-tap keys (live) on the base layer.' })); return; }
        build();
    });

    // ------------------------------------------------------------- polling

    const startPolling = (onEntries, onFail) => startLogPoll(flask, {
        hid: app.hid, onEntries, alive: () => root.isConnected,
        onError: (e) => { toast(`Log read failed: ${e.message}`, true); onFail?.(); },
    });

    // ------------------------------------------------------------- sections

    const typingBox = el('div', { class: 'ht-cal-sec' });
    const holdsBox = el('div', { class: 'ht-cal-sec' });
    const resultsBox = el('div', { class: 'ht-cal-sec' });

    function build() {
        root.replaceChildren(
            el('p', { class: 'hint', text: `Two short drills, then a recommendation per hold-tap key. Needs ${MIN_TAP_SAMPLES}+ typing presses per key. Nothing is written until you press Apply.` }),
            typingBox, holdsBox, resultsBox);
        typingDrill(); holdsDrill(); renderResults();
    }

    // ---- Drill 1: typing (tap intent)

    function typingDrill({ retest = false } = {}) {
        const { keys, letters } = S.model;
        const drillKeys = keys.filter((k) => k.ch);
        const gen = buildPassage({ keys: drillKeys, letters, reps: 10, seed: retest ? 7 : 1 });
        const passage = el('div', { class: 'ht-cal-passage mono', 'aria-label': 'Passage to type', text: gen.text });
        const field = el('textarea', { class: 'ht-cal-field mono', rows: 3, spellcheck: 'false', autocomplete: 'off',
            placeholder: 'Click Start, then type the passage here at your normal speed.', 'aria-label': 'Type the passage', disabled: true });
        const prog = el('div', { class: 'note faint', text: '' });
        const live = el('div', { class: 'ht-cal-live' });
        const result = el('div', { class: 'ht-cal-result' });
        const start = el('button', { class: 'btn small primary', type: 'button', text: retest ? 'Start re-test' : 'Start typing drill' });
        const stopBtn = el('button', { class: 'btn small', type: 'button', text: 'Finish', disabled: true });
        const entries = [];
        let stopPoll = null, t0 = 0, timer = null, settle = null, finishing = false, run = 0;
        const label = (s) => keys.find((k) => k.slot === s)?.name ?? `slot ${s}`;
        const paintLive = () => {
            const miss = entries.filter((e) => e.hold);
            live.replaceChildren(...miss.slice(-5).map((e) => el('div', { class: 'note warn',
                text: `Misfire: ${label(e.slot)} became a hold (${LOG_REASONS[e.reason] ?? e.reason}, held ${e.heldMs} ms)` })));
        };
        const finish = async () => {
            if (S.running !== 'typing' || finishing) return;
            finishing = true; run++;
            clearInterval(timer); clearTimeout(settle);
            await stopPoll?.(); stopPoll = null; setRunning(null); finishing = false;
            field.disabled = true; start.disabled = false; stopBtn.disabled = true;
            const d = diffTyped(gen.expected, field.value);
            result.replaceChildren(
                el('div', { class: 'note', text: `${entries.length} hold-tap presses logged, ${entries.filter((e) => e.hold).length} became holds. Typed text: ${d.errors} character error(s).` }),
                el('div', { class: 'ht-cal-passage mono', 'aria-label': 'Typed vs expected' },
                    ...[...gen.expected].map((c, i) => el('span', { class: `ht-d-${d.marks[i]}`, text: c === ' ' ? '·' : c }))));
            if (retest) S.retest = entries.slice(); else S.typing = entries.slice();
            await analyze();
        };
        aborts.add(() => {   // sheet closed: no 60 s timer left behind, hand the poller back
            clearInterval(timer); clearTimeout(settle); run++;
            const f = stopPoll; stopPoll = null; f?.();
        });
        start.onclick = async () => {
            if (S.running || disposed) return;
            setRunning('typing');
            const mine = ++run;
            entries.length = 0; field.value = ''; result.replaceChildren(); live.replaceChildren();
            start.disabled = true; stopBtn.disabled = false; field.disabled = false;
            let stop;
            try {
                stop = await startPolling((list) => { entries.push(...list); paintLive(); }, () => finish());
            } catch (e) { toast(`Log read failed: ${e.message}`, true); if (mine === run) { setRunning(null); start.disabled = false; stopBtn.disabled = true; field.disabled = true; } return; }
            if (mine !== run) { stop(); return; }   // finished or closed while the first read was pending
            stopPoll = stop;
            field.focus();
            t0 = performance.now();
            timer = setInterval(() => {
                const s = (performance.now() - t0) / 1000;
                prog.textContent = `${Math.round(s)} s of 60 · ${field.value.length} of ${gen.expected.length} characters`;
                if (s >= 60) finish();
            }, 250);
        };
        stopBtn.onclick = finish;
        // Done when the text is complete, but wait: a trailing ⌫ / ⌦ press is still to be logged.
        field.addEventListener('input', () => {
            clearTimeout(settle);
            if (S.running === 'typing' && typedEnough(field.value, gen.expected)) settle = setTimeout(finish, 1500);
        });
        // A hold misfire sends Ctrl/Cmd/Alt chords: keep them away from the browser.
        field.addEventListener('keydown', (e) => { if (e.ctrlKey || e.metaKey || e.altKey) e.preventDefault(); });
        typingBox.replaceChildren(
            el('h4', { text: retest ? 'Re-test: typing' : '1. Typing drill (about 60 s)' }),
            el('p', { class: 'hint', text: 'Type it as you normally would. ⌫ = tap Backspace, ⌦ = tap Delete (nothing happens at the end). Every press of a hold-tap key here counts as a tap; a hold is a misfire.' }),
            passage, field, el('div', { class: 'row', style: 'gap:8px' }, start, stopBtn), prog, live, result);
    }

    // ---- Drill 2: holds (hold intent)

    function holdsDrill() {
        const { keys, letters } = S.model;
        const plain = letters.filter((l) => !l.ht);
        const prompts = holdPrompts({ keys: keys.map((k) => ({ slot: k.slot, hand: k.hand, name: k.name })), letters: plain.length ? plain : letters });
        const cue = el('div', { class: 'ht-cal-cue', 'aria-live': 'polite', text: `${prompts.length} prompts.` });
        const prog = el('div', { class: 'note faint' });
        const sink = el('input', { class: 'ht-cal-field mono', type: 'text', readonly: true, disabled: true, 'aria-label': 'Hold drill input (keys are swallowed)', placeholder: 'Keys go here and are discarded' });
        const start = el('button', { class: 'btn small primary', type: 'button', text: 'Start holds drill' });
        const stopBtn = el('button', { class: 'btn small', type: 'button', text: 'Finish', disabled: true });
        const got = [];
        let i = 0, stopPoll = null, finishing = false, run = 0;
        const show = () => {
            prog.textContent = `${Math.min(i + 1, prompts.length)} of ${prompts.length}`;
            cue.textContent = i < prompts.length ? prompts[i].text : 'Done.';
        };
        const finish = async () => {
            if (S.running !== 'holds' || finishing) return;
            finishing = true; run++;
            await stopPoll?.(); stopPoll = null; setRunning(null); finishing = false;
            sink.disabled = true; start.disabled = false; stopBtn.disabled = true;
            S.holds = got.slice();
            cue.textContent = `Done: ${got.length} holds logged.`;
            await analyze();
        };
        aborts.add(() => { run++; const f = stopPoll; stopPoll = null; f?.(); });
        start.onclick = async () => {
            if (S.running || disposed) return;
            setRunning('holds'); i = 0; got.length = 0;
            const mine = ++run;
            start.disabled = true; stopBtn.disabled = false; sink.disabled = false;
            let stop;
            try {
                stop = await startPolling((list) => {
                    if (S.running !== 'holds' || mine !== run) return;
                    for (const e of list) {   // entries from the other-hand key (or strays) are not hold intent
                        if (i < prompts.length && e.slot === prompts[i].slot) { got.push(e); i++; }
                    }
                    if (i >= prompts.length) finish(); else show();
                }, () => finish());
            } catch (e) { toast(`Log read failed: ${e.message}`, true); if (mine === run) { setRunning(null); start.disabled = false; stopBtn.disabled = true; sink.disabled = true; } return; }
            if (mine !== run) { stop(); return; }
            stopPoll = stop;
            sink.focus(); show();
        };
        stopBtn.onclick = finish;
        sink.addEventListener('keydown', (e) => { if (e.key !== 'Tab' && e.key !== 'Escape') e.preventDefault(); });
        holdsBox.replaceChildren(
            el('h4', { text: '2. Holds drill (about 1 min)' }),
            el('p', { class: 'hint', text: 'Follow the prompts. Each one counts as a hold; a tap is a misfire. Optional, but it protects your holds from the new timing.' }),
            cue, sink, el('div', { class: 'row', style: 'gap:8px' }, start, stopBtn), prog);
    }

    // ---- Analysis + results

    async function readCurrent() {
        const posOk = await hasFeature(flask, 0x53);
        const cur = {};
        for (const k of S.model.keys) {
            const s = decodeHoldtapSlot(await flask.getBytes(CH, 0x50, [k.slot], 1));
            cur[k.slot] = { ...s };
            if (posOk) { try { Object.assign(cur[k.slot], await readPositional(flask, k.slot, S.model.boardKeys.length)); } catch { /* keep timing only */ } }
        }
        return cur;
    }

    async function analyze() {
        try { S.current = await readCurrent(); } catch (e) { toast(`Could not read current timing: ${e.message}`, true); return; }
        const { keys, boardKeys } = S.model;
        const hands = handsOf(boardKeys);
        S.rows = analyzeHoldtap({
            typing: S.typing, holds: S.holds, keys: keys.map((k) => ({ ...k, label: k.name })), current: S.current,
            handOfPos: (p) => hands.get(p) ?? null,
            // opposite half + the same-hand hold-tap keys, so same-hand mod chords still hold
            triggersFor: (hand) => triggerPreset(boardKeys, hand, keys.filter((k) => k.hand === hand).map((k) => k.pos)),
        });
        renderResults();
    }

    function afterCell(slot) {
        if (!S.retest) return '';
        const n = S.retest.filter((e) => e.slot === slot);
        return `${n.filter((e) => e.hold).length}/${n.length}`;
    }

    function renderResults() {
        const hasData = S.typing.length || S.holds.length;
        if (!S.rows || !hasData) {
            resultsBox.replaceChildren(el('h4', { text: '3. Results' }), el('p', { class: 'hint', text: 'Run a drill to see recommendations.' }));
            return;
        }
        const checks = new Map();
        const head = el('tr', {}, ...['', 'Key', 'Now', 'Recommended', 'Typing misfires', 'Hold misfires', S.retest ? 'After re-test' : null]
            .filter((h) => h != null).map((h) => el('th', { text: h })));
        const body = S.rows.map((r) => {
            const c = S.current[r.slot] ?? {};
            const now = `${c.term ?? '?'} ms · idle ${c.idle ?? '?'} ms · ${HOLDTAP_FLAVORS[c.flavor] ?? '?'}${c.mode != null ? ' · ' + fmtPositional(c) : ''}`;
            const ok = !!r.rec && (r.rec.changed.term || r.rec.changed.idle || r.rec.changed.positional);
            const cb = el('input', { type: 'checkbox', checked: ok, disabled: !ok, 'aria-label': `Apply to ${r.label}` });
            checks.set(r.slot, cb);
            let rec;
            if (!r.rec) rec = el('td', { class: 'faint', text: `not enough data (${r.tapSamples} of ${MIN_TAP_SAMPLES} presses)` });
            else {
                rec = el('td', {}, el('div', { class: 'mono', text: `${r.rec.term} ms · idle ${r.rec.idle} ms${r.rec.mode != null ? ' · same hand = tap (on press, hold-tap keys excepted)' : ''}` }),
                    el('div', { class: 'note faint', text: ok ? '' : 'already right' }),
                    ...r.rec.notes.map((n) => el('div', { class: 'note warn', text: n })));
            }
            const mf = (m) => el('td', { title: reasonText(m.byReason) },
                `${m.count}/${m.total}`, m.count ? el('div', { class: 'note faint', text: reasonText(m.byReason) }) : null);
            return el('tr', { 'data-slot': r.slot },
                el('td', {}, cb), el('td', { text: r.label }), el('td', { class: 'mono', text: now }), rec,
                mf(r.misfires.typing), mf(r.misfires.holds), S.retest ? el('td', { text: afterCell(r.slot) }) : null);
        });
        const apply = el('button', { class: 'btn small primary', type: 'button', text: 'Apply checked and save' });
        apply.onclick = async () => {
            const todo = S.rows.filter((r) => checks.get(r.slot)?.checked && r.rec);
            if (!todo.length) { toast('Nothing checked'); return; }
            apply.disabled = true;
            try {
                for (const r of todo) await applyRecommendation(flask, r, S.model.boardKeys.length);
                // The channel save is wholesale: it also persists any earlier unsaved hold-tap edit.
                // Register through the shared save state, run it, then clean it, so the top bar agrees.
                const hadEdits = saveState.dirty().some((d) => d.source === CH);
                saveState.markDirty(CH, 'Hold-tap timing', () => flask.save(CH));
                await flask.save(CH);
                saveState.clean(CH);
                toast(`Applied to ${todo.length} key${todo.length === 1 ? '' : 's'} and saved${hadEdits ? ' (with your earlier unsaved hold-tap edits)' : ''}`);
                await analyze();
            } catch (e) {
                // Written live but not saved: leave it in the top bar so Save / Discard see it.
                saveState.markDirty(CH, 'Hold-tap timing', () => flask.save(CH));
                toast(`Apply failed: ${e.message}. Changes already written stay unsaved: Save is in the top bar.`, true);
            }
            apply.disabled = false;
        };
        const retest = el('button', { class: 'btn small', type: 'button', text: 'Re-test typing',
            'data-caption': 'Run the typing drill again and compare misfires before and after.',
            onclick: () => { if (!S.running) typingDrillRetest(); } });
        resultsBox.replaceChildren(el('h4', { text: '3. Results' }),
            el('div', { class: 'ht-cal-scroll' }, el('table', { class: 'ht-cal-table' }, el('thead', {}, head), el('tbody', {}, ...body))),
            el('div', { class: 'row', style: 'gap:8px' }, apply, retest),
            el('p', { class: 'hint', text: 'Quick-tap and flavour are never changed here.' }));
    }

    function typingDrillRetest() { typingDrill({ retest: true }); typingBox.scrollIntoView?.({ block: 'start' }); }

    return root;
}

/** The calibrator in a sheet. */
export function openCalibrator(app) {
    document.dispatchEvent(new CustomEvent('ht-calibrator-open'));   // Type-to-assign must not swallow the drill keys
    const card = calibratorCard(app);
    const close = el('button', { class: 'btn', type: 'button', text: 'Close' });
    const back = modal('Calibrate tap-hold', el('div', { class: 'ht-cal-wrap' }, card), [close]);
    back.dataset.sheet = 'ht-calibrate';
    close.onclick = () => back.remove();
    // The backdrop click removes the sheet too: clean up on any removal.
    const mo = new MutationObserver(() => { if (!back.isConnected) { mo.disconnect(); card.dispose?.(); } });
    mo.observe(document.body, { childList: true });
    return back;
}

/** A button that opens the calibrator (shared by the hold timing UI and the Test tab). */
export function calibrateButton(app, { primary = false } = {}) {
    return el('button', { class: 'btn small' + (primary ? ' primary' : ''), type: 'button', text: 'Calibrate tap-hold…',
        'data-act': 'ht-calibrate', 'data-caption': 'Measure your typing and holds, then get a timing recommendation for each hold-tap key.',
        onclick: () => openCalibrator(app) });
}
