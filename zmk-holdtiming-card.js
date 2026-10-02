// "Hold timing" card (AJ-Q4): one row per flask_holdtap slot (channel 0x2A,
// proto >= 17). Key slots link to their board key; virtual slots (combo and
// autoshift hold-taps) are labelled from 0x52 SLOT_INFO. Each row: 50-1000 ms
// slider, flavor, quick-tap, prior-idle, reset. Edits are live; the top
// bar's Save writes flash (saveState source 0x2A).
//
// holdTimingCard(app) resolves to the card, or null when the board has no
// flask_holdtap (proto < 17, or 0x2A answers 0xFF).

import { el, card, toast, reloadBar } from './ui.js?v=63';
import { attachHoldtap, HOLDTAP, describeBinding } from './behavior-catalog.js?v=63';
import { saveState } from './save-state.js?v=63';
import { board } from './board.js?v=63';
import {
    HOLDTAP_FLAVORS, HOLDTAP_TERM, decodeHoldtapSlot, encodeHoldtapSlot, clampTerm,
} from './zmk-holdtap-codec.js?v=63';

const ch = HOLDTAP.channel;

/** The four hold-tap flavours, in wire order (HOLDTAP_FLAVORS), each with the
 * one line a person needs to choose between them. */
export const FLAVOR_INFO = [
    { label: 'Hold-preferred', info: 'Pressing any other key while this is down makes it a hold at once. Fast, but rolls can misfire.' },
    { label: 'Balanced', info: 'Holds if another key is pressed and released first, or when the term runs out. A good default.' },
    { label: 'Tap-preferred', info: 'Only a long press counts as a hold. Pressing another key first still gives the tap.' },
    { label: 'Tap unless interrupted', info: 'Holds only if another key is pressed meanwhile. Pressed alone it taps, even after a long press.' },
];

/** Four flavour buttons. `compact` drops the sentence (it becomes the tooltip). */
export function flavorPicker(value, onChange, { compact = false } = {}) {
    const wrap = el('div', { class: 'ht-flavors' + (compact ? ' compact' : ''), role: 'radiogroup', 'aria-label': 'Flavour' });
    const paint = (v) => wrap.querySelectorAll('button').forEach((b) => {
        const on = Number(b.dataset.flavor) === v;
        b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    });
    FLAVOR_INFO.forEach((f, i) => wrap.append(el('button', {
        class: 'flavor', type: 'button', role: 'radio', 'data-flavor': i, title: f.info, 'data-caption': f.info,
        onclick: () => { paint(i); onChange(i); },
    }, el('b', { text: f.label }), compact ? null : el('span', { text: f.info }))));
    paint(value);
    wrap.set = paint;
    return wrap;
}

/**
 * The per-key timing card for the Keymap inspector: tapping term with a
 * tap | hold bar, the four flavours with their explanations, and the advanced
 * quick-tap / prior-idle numbers. Edits are live; the top bar's Save writes
 * flash (saveState source 0x2A). Resolves to null when the board has no
 * flask_holdtap (so the caller can say "compiled timing").
 */
export async function keyTimingCard(app, pos) {
    const dirty = (be) => saveState.markDirty(ch, 'Hold-tap timing', () => be.save());
    let be = null;
    be = await attachHoldtap(app, { onDirty: () => be && dirty(be) });
    if (!be || pos == null) return null;
    let s;
    try { s = await be.readSlot(pos); } catch { return null; }
    const flask = app.flask;
    const termVal = el('output', { class: 'ht-term mono', text: `${s.term} ms` });
    const bar = el('div', { class: 'ht-bar', 'aria-hidden': 'true' }, el('i', { class: 'ht-bar-tap' }), el('i', { class: 'ht-bar-hold' }));
    const paintBar = (ms) => {
        const f = Math.min(1, ms / 500);
        bar.firstChild.style.flexBasis = `${f * 100}%`;
        bar.firstChild.textContent = f > 0.18 ? 'tap' : '';
        bar.lastChild.textContent = f < 0.8 ? 'hold' : '';
    };
    const slider = el('input', { type: 'range', min: HOLDTAP_TERM.min, max: HOLDTAP_TERM.max, step: 10, value: s.term,
        'aria-label': `Tapping term for key ${pos}`,
        'data-caption': 'How long the key may stay down and still count as a tap. Past this it is a hold. Live; Save keeps it.' });
    paintBar(s.term);
    slider.addEventListener('input', () => { termVal.textContent = `${slider.value} ms`; paintBar(Number(slider.value)); });
    const fail = (e) => toast(`Hold timing write failed: ${e.message}`, true);
    slider.addEventListener('change', async () => {
        try { s.term = await be.write(pos, clampTerm(Number(slider.value))); slider.value = s.term; termVal.textContent = `${s.term} ms`; paintBar(s.term); }
        catch (e) { fail(e); }
    });
    // Full-slot write (flavour / quick / idle); re-read so the backend cache
    // matches and the slider's next write cannot revert them.
    const put = async (patch) => {
        const next = { ...(await be.readSlot(pos)), ...patch };
        const echo = decodeHoldtapSlot(await flask.setBytes(ch, HOLDTAP.slot, encodeHoldtapSlot(next), 1));
        s = await be.readSlot(echo.slot);
        dirty(be);
    };
    const flavors = flavorPicker(s.flavor, async (v) => { try { await put({ flavor: v }); } catch (e) { fail(e); flavors.set(s.flavor); } });
    const num = (field, label, hint) => {
        const input = el('input', { type: 'number', min: 0, max: 1000, value: s[field], 'aria-label': label });
        input.addEventListener('change', async () => {
            try { await put({ [field]: Math.max(0, Math.min(1000, Number(input.value) || 0)) }); input.value = s[field]; }
            catch (e) { fail(e); }
        });
        return el('label', { class: 'ht-num', 'data-caption': hint }, el('span', { text: label }), input, el('em', { text: 'ms' }));
    };
    const reset = el('button', { class: 'btn small ghost', type: 'button', text: 'Reset to default', 'data-caption': 'Back to the compiled timing for this key.',
        onclick: async () => {
            try { await be.reset(pos); s = await be.readSlot(pos); slider.value = s.term; termVal.textContent = `${s.term} ms`; paintBar(s.term); flavors.set(s.flavor); }
            catch (e) { toast(`Reset failed: ${e.message}`, true); }
        } });
    return el('section', { class: 'ht-card', 'data-card': 'key-timing' },
        el('h4', { text: 'Timing' }),
        el('div', { class: 'ht-term-row' }, slider, termVal),
        bar,
        el('h5', { text: 'Flavour' }), flavors,
        el('details', { class: 'ht-adv' }, el('summary', { text: 'Advanced' }),
            num('quick', 'Quick-tap', 'Pressing again within this time of a tap repeats the tap, never a hold. 0 = off. Good for key repeat.'),
            num('idle', 'Prior idle', 'A hold only counts if no other key was typed in the last this-many ms. 0 = off. Good for home-row mods.')),
        el('div', { class: 'ht-foot' }, reset));
}

export async function holdTimingCard(app) {
    const dirty = (be) => saveState.markDirty(ch, 'Hold-tap timing', () => be.save());
    let be = null;
    be = await attachHoldtap(app, { onDirty: () => be && dirty(be) });
    if (!be) return null;

    const flask = app.flask;
    const list = el('div', { class: 'ht-list', style: 'max-height:460px; overflow:auto' });
    const body = card('Hold timing',
        'how long each hold-tap waits before it counts as a hold, per key');
    body.dataset.card = 'hold-timing';

    const readAll = async () => {
        app.hid?.pause?.();
        try {
            const infos = await be.slots();
            const rows = [];
            for (const info of infos) rows.push({ info, s: await be.readSlot(info.slot) });
            return rows;
        } finally { app.hid?.resume?.(); }
    };

    // The card's reload bar owns "Reload from device" and the unsaved state;
    // announceEdit('flask-edit') below tells it a row changed.
    const announce = (node) => node.dispatchEvent(new CustomEvent('flask-edit', { bubbles: true }));

    /** Full-slot write for quick / idle / flavor (term has be.write). Then
     * re-read through the backend so ITS cache matches: the picker's slider
     * writes term from that cache and must not revert these fields. */
    const putSlot = async (row, patch) => {
        // Read the slot first: the picker may have changed term since this
        // row rendered, and a stale row.s would write the old term back.
        const next = { ...(await be.readSlot(row.info.slot)), ...patch };
        const echo = decodeHoldtapSlot(await flask.setBytes(ch, HOLDTAP.slot, encodeHoldtapSlot(next), 1));
        row.s = await be.readSlot(echo.slot);
        dirty(be);
        return row.s;
    };

    const keyLabel = (info) => {
        let name = `Key ${info.keyPos}`;
        try {
            const sel = { kind: 'key', row: 0, col: info.keyPos };
            const b = board.adapter?.bindingAt(0, sel);
            if (b) name += ` · ${describeBinding(b, 'zmk-studio')}`;
        } catch { /* binding not readable yet */ }
        return name;
    };

    const rowEl = (row) => {
        const { info } = row;
        const termVal = el('span', { class: 'val', style: 'min-width:56px', text: `${row.s.term} ms` });
        const slider = el('input', {
            type: 'range', min: HOLDTAP_TERM.min, max: HOLDTAP_TERM.max, step: 10,
            value: row.s.term, 'aria-label': 'tapping term', style: 'width:160px',
        });
        slider.addEventListener('input', () => { termVal.textContent = `${slider.value} ms`; });
        slider.addEventListener('change', async () => {
            try {
                row.s.term = await be.write(info.slot, clampTerm(Number(slider.value)));
                slider.value = row.s.term;
                termVal.textContent = `${row.s.term} ms`;
                announce(slider);
            } catch (e) { toast(`Hold timing write failed: ${e.message}`, true); }
        });
        const flavor = flavorPicker(row.s.flavor, async (v) => {
            try { await putSlot(row, { flavor: v }); announce(flavor); }
            catch (e) { toast(`Hold timing write failed: ${e.message}`, true); flavor.set(row.s.flavor); }
        }, { compact: true });
        const num = (field, title) => {
            const input = el('input', { type: 'number', min: 0, max: 1000, value: row.s[field],
                title, 'aria-label': title, style: 'width:64px' });
            input.addEventListener('change', async () => {
                try {
                    await putSlot(row, { [field]: Math.max(0, Math.min(1000, Number(input.value) || 0)) });
                    input.value = row.s[field];
                    announce(input);
                } catch (e) { toast(`Hold timing write failed: ${e.message}`, true); }
            });
            return input;
        };
        const reset = el('button', {
            class: 'btn small', text: 'Reset', title: 'back to the compiled default',
            onclick: async () => {
                try {
                    await be.reset(info.slot);
                    row.s = await be.readSlot(info.slot);
                    announce(reset);
                    fill();
                } catch (e) { toast(`Reset failed: ${e.message}`, true); }
            },
        });
        const label = info.kind === 'virtual'
            ? el('span', { class: 'lbl', text: info.name || `Slot ${info.slot}` })
            : el('button', {
                class: 'btn small', text: keyLabel(info), title: 'show this key on the board',
                onclick: () => {
                    if (!board.adapter) return;
                    board.setLayer(0, { keepSelection: true });
                    board.select({ kind: 'key', row: 0, col: info.keyPos });
                },
            });
        return el('div', {
            class: 'row', 'data-slot': info.slot,
            style: 'gap:8px; flex-wrap:wrap; align-items:center',
        },
            el('span', { style: 'min-width:190px; display:inline-block' }, label),
            slider, termVal, flavor,
            el('label', { class: 'note faint', text: 'quick-tap' }), num('quick', 'quick-tap ms (0 = off)'),
            el('label', { class: 'note faint', text: 'prior idle' }), num('idle', 'require-prior-idle ms (0 = off)'),
            row.s.custom ? el('span', { class: 'note', text: 'edited', title: 'differs from the compiled default' }) : null,
            reset);
    };

    let rows = [];
    const fill = () => {
        const virt = rows.filter((r) => r.info.kind === 'virtual');
        const keys = rows.filter((r) => r.info.kind === 'key');
        list.replaceChildren(
            virt.length ? el('h4', { text: 'Combos and autoshift' }) : null,
            ...virt.map(rowEl),
            el('h4', { text: 'Keys' }),
            ...keys.map(rowEl));
    };
    const reload = async () => { rows = await readAll(); fill(); };
    await reload();

    body.append(
        el('div', { class: 'note faint', text: 'Slot = key position. Values apply from the next press. Compiled per key and not editable here: hold/tap behaviors, retro-tap, hold-trigger positions.' }),
        list,
        reloadBar(ch, { label: 'Hold-tap timing', save: () => be.save(), reload }));
    return body;
}

/** Behaviour › Hold timing (registry row 'zmk-holdtiming', gated on
 * caps.holdtap: proto >= 17 and 0x2A answering). */
export class ZmkHoldTimingTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const c = await holdTimingCard(this.app);
        this.root.replaceChildren(c ?? el('p', { class: 'muted', text: 'This keyboard has no live hold-tap timing (flask_holdtap, channel 0x2A).' }));
    }
}
