// Behaviour › Shift Keys on the QMK line (spec 3.8, AJ-Q3): getreuer custom
// shift keys, moved out of Typing so both firmware lines name and place it
// the same way. Channel CH.customShift: an enable flag plus CSK_SLOTS
// (base, shifted) pairs.

import { el, card, toast, toggleRow, reloadBar } from './ui.js?v=49';
import { CH, V, slot, CSK_SLOTS } from './flaskproto.js?v=49';
import { kcCell } from './picker.js?v=49';
import { openPicker } from './binding-picker.js?v=1';
import { announceEdit } from './tiles.js?v=1';

// Spec 3.8 presets: base → what Shift+base types.
const PRESETS = [
    ['⌫ → ⌦', 0x002A, 0x004C],      // KC_BSPC → KC_DEL
    [', → ;', 0x0036, 0x0033],      // KC_COMM → KC_SCLN
    ['. → :', 0x0037, 0x0233],      // KC_DOT → S(KC_SCLN)
];

export class QmkShiftTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { flask } = this.app;
        const g = (id) => flask.getU16(CH.customShift, id);
        this.enabled = await g(V.cskEnabled);
        this.keys = [];
        this.shifted = [];
        for (let i = 0; i < CSK_SLOTS; i++) {
            this.keys.push(await g(slot.cskKey(i)));
            this.shifted.push(await g(slot.cskShift(i)));
        }
        this.bar ??= reloadBar(CH.customShift, {
            reload: () => this.load(), save: () => this.app.flask.save(CH.customShift),
            label: 'Shift keys', line: 'qmk',
        });
        this.render();
    }

    async _write(i, key, shifted) {
        const { flask } = this.app;
        try {
            await flask.setU16(CH.customShift, slot.cskKey(i), key);
            await flask.setU16(CH.customShift, slot.cskShift(i), shifted);
            this.keys[i] = key;
            this.shifted[i] = shifted;
            return true;
        } catch (e) { toast(`Write failed: ${e.message}`, true); return false; }
    }

    /** Compact after a removal so the "first empty slot" add-cell logic holds. */
    async _remove(i) {
        for (let n = i; n < CSK_SLOTS; n++) {
            const [k, s] = n + 1 < CSK_SLOTS ? [this.keys[n + 1], this.shifted[n + 1]] : [0, 0];
            if (k !== this.keys[n] || s !== this.shifted[n]) if (!(await this._write(n, k, s))) break;
        }
        this.bar.markEdited();
        this.render();
    }

    _pick(i, which) {
        const isBase = which === 'base';
        const value = isBase ? this.keys[i] : this.shifted[i];
        openPicker({
            surface: isBase ? 'qmk.cskBase' : 'qmk.cskShifted', value, host: 'sheet', app: this.app,
            title: isBase ? `Shift pair ${i + 1}: key` : `Shift pair ${i + 1}: types when shifted`,
            onPick: async (kc) => {
                // A new pair needs both halves; keep the other half as it is.
                if (await this._write(i, isBase ? kc : this.keys[i], isBase ? this.shifted[i] : kc)) {
                    this.bar.markEdited();
                    this.render();
                }
            },
        });
    }

    async _preset([, base, shifted]) {
        const i = this.keys.findIndex((k, n) => !k && !this.shifted[n]);
        if (i < 0) { toast('All shift-key slots are used', true); return; }
        if (await this._write(i, base, shifted)) { this.bar.markEdited(); this.render(); }
    }

    render() {
        const { flask } = this.app;
        const c = card('Shift keys', 'Shift + key types something else',
            toggleRow({
                label: 'Enabled', value: this.enabled,
                onChange: (v) => flask.setU16(CH.customShift, V.cskEnabled, v ? 1 : 0),
            }));
        const grid = el('div', { class: 'codes' });
        for (let i = 0; i < CSK_SLOTS; i++) {
            if (!this.keys[i] && i > 0) {
                // First empty slot is the "add" affordance; the rest stay hidden.
                grid.append(kcCell(0, () => this._pick(i, 'base'), 'Add a shift pair'));
                break;
            }
            grid.append(el('div', { class: 'csk-pair', 'data-csk': i, style: 'display:flex; gap:2px; align-items:center' },
                kcCell(this.keys[i], () => this._pick(i, 'base')),
                '⇧→',
                kcCell(this.shifted[i], () => this._pick(i, 'shifted')),
                this.keys[i] ? el('button', { class: 'btn small', text: '✕', title: 'Remove this pair', onclick: () => this._remove(i) }) : null));
        }
        c.append(grid,
            el('div', { class: 'row', style: 'gap:4px' },
                el('span', { class: 'hint', text: 'Presets' }),
                ...PRESETS.map((p) => el('button', { class: 'btn small', text: p[0], onclick: () => this._preset(p) }))),
            this.bar);
        this.root.replaceChildren(c);
    }
}
