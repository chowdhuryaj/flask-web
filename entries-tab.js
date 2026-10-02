// Vial dynamic-entry editors: Tap Dance, Combos (+ per-combo layer masks),
// Key Overrides, as native-style tile grids with sheet editors. Port of
// AdeptCompanion TapDanceComboViews.swift + KeyOverrideView.swift over the LE
// codecs in vialproto.js. Entry writes need NO unlock (unlike macros).
//
// TD tiles paste TD(n) onto the selected key (the pencil edits). Combos and
// overrides have no keycode to paste, so their tiles open the editor.

import { el, card, toast, reloadBar } from './ui.js?v=49';
import { kcCell } from './picker.js?v=49';
import { capLabel } from './keycodes.js?v=49';
import { TapDance, Combo, KeyOverride } from './vialproto.js?v=49';
import { CH, slot } from './flaskproto.js?v=49';
import { openPicker } from './binding-picker.js?v=1';
import { encode, modsText } from './behavior-catalog.js?v=1';
import { tile, tileGrid, openSheet, pasteToKey, addSummary, reloadRow } from './tiles.js?v=1';

const pick = (app, surface, value, title, onPick) => openPicker({ surface, value, host: 'sheet', title, app, onPick });
const cap = (kc) => (kc ? capLabel(kc) : '');
const clearBtn = (onclick) => el('button', { class: 'btn small', text: '✕', title: 'Clear', onclick });

// ---------- tap dance ----------

// Spec §3.6: QMK's four fixed slots as tap-count rows; no add-row.
const TD_ROWS = [
    ['onTap', '1 tap'], ['onHold', '1 tap, held'], ['onDoubleTap', '2 taps'], ['onTapHold', '2 taps, held'],
];

/** "A / Esc": the filled slots in row order. */
export function tdSummary(e) {
    return TD_ROWS.map(([f]) => cap(e?.[f])).filter(Boolean).join(' / ');
}

export class TapDanceTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { vial } = this.app;
        this.count = (await vial.dynamicEntryCounts()).tapDance;
        this.app.tapDanceCount = this.count;   // WP3 picker: TD slot range
        this.entries = [];
        for (let i = 0; i < this.count; i++) this.entries.push(await vial.tapDanceGet(i));
        addSummary(this.app, 'tap-dance', (i) => tdSummary(this.entries?.[i]));
        this.render();
    }

    async set(i, patch) {
        const e = { ...this.entries[i], ...patch };
        try {
            await this.app.vial.tapDanceSet(i, e);
            this.entries[i] = e;
            this.render();
            return true;
        } catch (err) { toast(`Write failed: ${err.message}`, true); return false; }
    }

    edit(i) {
        openSheet(`Tap dance TD${i}`, (sh) => {
            const e = this.entries[i];
            const put = async (patch) => { if (await this.set(i, patch)) sh.refresh(); };
            const term = el('input', { type: 'number', min: 0, max: 5000, value: e.tappingTerm, style: 'width:80px' });
            term.addEventListener('change', () => put({ tappingTerm: Number(term.value) || 0 }));
            return [
                ...TD_ROWS.map(([field, label]) => el('div', { class: 'row', 'data-td-row': field },
                    el('span', { class: 'lbl', text: label }),
                    kcCell(e[field], () => pick(this.app, 'qmk.tapDanceStep', e[field], `TD${i}: ${label}`, (kc) => put({ [field]: kc }))),
                    e[field] ? clearBtn(() => put({ [field]: 0 })) : null)),
                el('div', { class: 'row' },
                    el('span', { class: 'lbl' }, 'Tapping term (ms)', el('span', { class: 'hint', text: '0 = the keyboard default' })), term),
            ];
        }, (sh) => [
            el('button', { class: 'btn', text: 'Clear tap dance', onclick: async () => { if (await this.set(i, TapDance.empty())) sh.refresh(); } }),
            el('button', { class: 'btn primary', text: 'Done', onclick: () => sh.close() }),
        ]);
    }

    render() {
        this.root.replaceChildren(card('Tap dance', `${this.count} slots`,
            el('div', { class: 'note faint', text: 'Click a tap dance to paste TD(n) onto the selected key. The pencil edits it.' }),
            tileGrid(...this.entries.map((e, i) => tile({
                name: `TD${i}`, sub: tdSummary(e) || 'empty', empty: TapDance.isEmpty(e),
                caption: `Tap dance ${i}: ${tdSummary(e) || 'empty'}. Click to paste onto the selected key.`,
                onPaste: () => pasteToKey(encode('tap-dance', { slot: i }, 'qmk')),
                onEdit: () => this.edit(i),
            }))),
            reloadRow(() => this.load(), 'Tap dance writes are saved to the keyboard at once.')));
    }
}

// ---------- combos ----------

export class ComboTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { vial, flask, caps } = this.app;
        this.count = (await vial.dynamicEntryCounts()).combo;
        this.entries = [];
        for (let i = 0; i < this.count; i++) this.entries.push(await vial.comboGet(i));
        this.masks = null;
        if (caps.comboLayerMasks) {
            this.masks = [];
            for (let i = 0; i < this.count; i++) {
                try { this.masks.push(await flask.getU16(CH.comboLayers, slot.comboMask(i))); }
                catch { this.masks.push(0); }
            }
            // One bar for the tab's life, so its dirty/saved state survives renders.
            this.bar ??= reloadBar(CH.comboLayers, {
                reload: () => this.load(), save: () => this.app.flask.save(CH.comboLayers),
                label: 'Combo layer masks', line: 'qmk', note: 'Layer masks persist after saving.',
            });
        }
        this.render();
    }

    async set(i, patch) {
        const e = { ...this.entries[i], ...patch, inputs: patch.inputs ?? [...this.entries[i].inputs] };
        try {
            await this.app.vial.comboSet(i, e);
            this.entries[i] = e;
            this.render();
            return true;
        } catch (err) { toast(`Write failed: ${err.message}`, true); return false; }
    }

    async setMask(i, mask) {
        try {
            this.masks[i] = await this.app.flask.setU16(CH.comboLayers, slot.comboMask(i), mask);
            this.render();
            this.bar?.markEdited();
            return true;
        } catch (err) { toast(`Write failed: ${err.message}`, true); return false; }
    }

    summary(e) {
        const ins = e.inputs.filter(Boolean).map(capLabel).join(' + ');
        return ins || e.output ? `${ins || '?'} → ${cap(e.output) || '?'}` : '';
    }

    edit(i) {
        openSheet(`Combo C${i}`, (sh) => {
            const e = this.entries[i];
            const put = async (patch) => { if (await this.set(i, patch)) sh.refresh(); };
            const rows = e.inputs.map((kc, n) => el('div', { class: 'row', 'data-combo-input': n },
                el('span', { class: 'lbl', text: `Key ${n + 1}` }),
                kcCell(kc, () => pick(this.app, 'qmk.key', kc, `C${i}: key ${n + 1}`, (v) => {
                    const inputs = [...this.entries[i].inputs];
                    inputs[n] = v;
                    return put({ inputs });
                })),
                kc ? clearBtn(() => { const inputs = [...this.entries[i].inputs]; inputs[n] = 0; put({ inputs }); }) : null));
            rows.push(el('div', { class: 'row' },
                el('span', { class: 'lbl', text: 'Output' }),
                kcCell(e.output, () => pick(this.app, 'qmk.comboOutput', e.output, `C${i}: output`, (v) => put({ output: v })))));
            if (this.masks) {
                const mask = this.masks[i];
                const chips = el('span', { class: 'lbl' }, 'Only on layers', el('span', { class: 'hint', text: 'none lit = every layer' }));
                const row = el('div', { class: 'row' }, chips);
                for (let l = 0; l < Math.min(this.app.layerCount, 16); l++) {
                    row.append(el('button', {
                        class: 'btn small' + ((mask >> l) & 1 ? ' primary' : ''), text: String(l), title: `Layer ${l}`,
                        onclick: async () => { if (await this.setMask(i, mask ^ (1 << l))) sh.refresh(); },
                    }));
                }
                rows.push(row);
            }
            return rows;
        }, (sh) => [
            el('button', { class: 'btn', text: 'Clear combo', onclick: async () => { if (await this.set(i, Combo.empty())) sh.refresh(); } }),
            el('button', { class: 'btn primary', text: 'Done', onclick: () => sh.close() }),
        ]);
    }

    render() {
        const c = card('Combos', `${this.count} slots, press the inputs together to get the output`,
            el('div', { class: 'note faint', text: 'Click a tile or its pencil to edit that combo.' }),
            tileGrid(...this.entries.map((e, i) => tile({
                name: `C${i}`, sub: this.summary(e) || 'empty', empty: Combo.isEmpty(e),
                caption: `Combo ${i}: ${this.summary(e) || 'empty'}. Click to edit.`,
                onPaste: () => this.edit(i), onEdit: () => this.edit(i),
            }))));
        if (this.bar) c.append(this.bar);
        else c.append(reloadRow(() => this.load(), 'Combo writes are saved to the keyboard at once.'));
        this.root.replaceChildren(c);
    }
}

// ---------- key overrides ----------

const KO_MODS = [
    ['L⌃', 0x01], ['L⇧', 0x02], ['L⌥', 0x04], ['L⌘', 0x08],
    ['R⌃', 0x10], ['R⇧', 0x20], ['R⌥', 0x40], ['R⌘', 0x80],
];

export class KeyOverrideTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { vial } = this.app;
        this.count = (await vial.dynamicEntryCounts()).keyOverride;
        this.entries = [];
        for (let i = 0; i < this.count; i++) this.entries.push(await vial.keyOverrideGet(i));
        this.render();
    }

    async set(i, patch) {
        const e = { ...this.entries[i], ...patch };
        try {
            await this.app.vial.keyOverrideSet(i, e);
            this.entries[i] = e;
            this.render();
            return true;
        } catch (err) { toast(`Write failed: ${err.message}`, true); return false; }
    }

    summary(e) {
        return KeyOverride.isEmpty(e) ? '' : `${modsText(e.triggerMods)}${cap(e.trigger) || '?'} → ${cap(e.replacement) || '?'}`;
    }

    edit(i) {
        openSheet(`Key override KO${i}`, (sh) => {
            const e = this.entries[i];
            const put = async (patch) => { if (await this.set(i, patch)) sh.refresh(); };
            const on = !!(e.options & KeyOverride.opt.enabled);
            return [
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Trigger modifiers' }),
                    ...KO_MODS.map(([label, bit]) => el('button', {
                        class: 'btn small' + (e.triggerMods & bit ? ' primary' : ''), text: label,
                        onclick: () => put({ triggerMods: e.triggerMods ^ bit }),
                    }))),
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Trigger key' }),
                    kcCell(e.trigger, () => pick(this.app, 'qmk.keyOverride', e.trigger, `KO${i}: trigger`, (v) => put({ trigger: v })))),
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Replacement' }),
                    kcCell(e.replacement, () => pick(this.app, 'qmk.keyOverride', e.replacement, `KO${i}: replacement`, (v) => put({ replacement: v })))),
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Enabled' }),
                    el('button', {
                        class: 'btn small' + (on ? ' primary' : ''), text: on ? 'on' : 'off',
                        onclick: () => put({ options: e.options ^ KeyOverride.opt.enabled }),
                    })),
                el('div', { class: 'note faint', text:
                    'New overrides use Vial\'s defaults (all layers, suppress trigger mods). '
                    + 'Suppressed and negative mod masks keep their values; edit those in the desktop app if needed.' }),
            ];
        }, (sh) => [
            el('button', { class: 'btn', text: 'Clear override', onclick: async () => { if (await this.set(i, KeyOverride.empty())) sh.refresh(); } }),
            el('button', { class: 'btn primary', text: 'Done', onclick: () => sh.close() }),
        ]);
    }

    render() {
        this.root.replaceChildren(card('Key overrides',
            `${this.count} slots, trigger mods + key → replacement (e.g. ⇧+Backspace → Delete)`,
            el('div', { class: 'note faint', text: 'Click a tile or its pencil to edit that override.' }),
            tileGrid(...this.entries.map((e, i) => tile({
                name: `KO${i}`, sub: this.summary(e) || 'empty', empty: KeyOverride.isEmpty(e),
                caption: `Key override ${i}: ${this.summary(e) || 'empty'}. Click to edit.`,
                onPaste: () => this.edit(i), onEdit: () => this.edit(i),
            }))),
            reloadRow(() => this.load(), 'Key override writes are saved to the keyboard at once.')));
    }
}
