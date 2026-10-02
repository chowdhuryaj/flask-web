// "Hold timing" card (AJ-Q4): one row per flask_holdtap slot (channel 0x2A,
// proto >= 17). Key slots link to their board key; virtual slots (combo and
// autoshift hold-taps) are labelled from 0x52 SLOT_INFO. Each row: 50-1000 ms
// slider, flavor, quick-tap, prior-idle, reset. Edits are live; the status
// bar's Save writes flash (saveState source 0x2A).
//
// holdTimingCard(app) resolves to the card, or null when the board has no
// flask_holdtap (proto < 17, or 0x2A answers 0xFF).

import { el, card, toast, reloadBar } from './ui.js?v=60';
import { attachHoldtap, HOLDTAP, describeBinding } from './behavior-catalog.js?v=60';
import { saveState } from './save-state.js?v=60';
import { board } from './board.js?v=60';
import {
    HOLDTAP_FLAVORS, HOLDTAP_TERM, decodeHoldtapSlot, encodeHoldtapSlot, clampTerm,
} from './zmk-holdtap-codec.js?v=60';

const FLAVOR_LABELS = ['Hold-preferred', 'Balanced', 'Tap-preferred', 'Tap unless interrupted'];
const ch = HOLDTAP.channel;

export async function holdTimingCard(app) {
    const dirty = (be) => saveState.markDirty(ch, 'Hold-tap timing', () => be.save(), { line: 'zmk' });
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
        const next = { ...row.s, ...patch };
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
        const flavor = el('select', { 'aria-label': 'flavor' },
            ...FLAVOR_LABELS.map((t, i) => el('option', { value: i, text: t })));
        flavor.value = String(row.s.flavor);
        flavor.addEventListener('change', async () => {
            try { await putSlot(row, { flavor: Number(flavor.value) }); announce(flavor); }
            catch (e) { toast(`Hold timing write failed: ${e.message}`, true); }
        });
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
        reloadBar(ch, { label: 'Hold-tap timing', line: 'zmk', save: () => be.save(), reload }));
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
