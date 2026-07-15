// Vial dynamic-entry editors: Tap Dance, Combos (+ per-combo layer masks),
// Key Overrides. Port of AdeptCompanion TapDanceComboViews.swift +
// KeyOverrideView.swift over the LE codecs in vialproto.js. Entry writes
// need NO unlock (unlike macros).

import { el, card, toast, toggleRow, saveBar } from './ui.js?v=16';
import { kcCell, makePickerHost } from './picker.js?v=16';
import { TapDance, Combo, KeyOverride } from './vialproto.js?v=16';
import { CH, slot } from './flaskproto.js?v=16';

// How many blank rows to show past the last used slot.
const SPARE_ROWS = 3;

function visibleCount(entries, isEmpty, max) {
    let last = -1;
    entries.forEach((e, i) => { if (!isEmpty(e)) last = i; });
    return Math.min(max, last + 1 + SPARE_ROWS);
}

// ---------- tap dance ----------

export class TapDanceTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { vial } = this.app;
        this.count = (await vial.dynamicEntryCounts()).tapDance;
        this.entries = [];
        for (let i = 0; i < this.count; i++) this.entries.push(await vial.tapDanceGet(i));
        this.picker = makePickerHost({ layerCount: this.app.layerCount });
        this.render();
    }

    async set(i, patch) {
        const e = { ...this.entries[i], ...patch };
        try {
            await this.app.vial.tapDanceSet(i, e);
            this.entries[i] = e;
            this.render();
        } catch (err) { toast(`Write failed: ${err.message}`, true); }
    }

    render() {
        const c = card('Tap dance', `${this.count} slots — place TD(n) from the picker's Quantum list`);
        const show = visibleCount(this.entries, TapDance.isEmpty, this.count);
        for (let i = 0; i < show; i++) {
            const e = this.entries[i];
            const pick = (field) => () => this.picker.request((kc) => this.set(i, { [field]: kc }));
            const term = el('input', {
                type: 'number', min: 0, max: 5000, value: e.tappingTerm,
                style: 'width:70px', title: 'Custom tapping term (ms)',
            });
            term.addEventListener('change', () => this.set(i, { tappingTerm: Number(term.value) || 0 }));
            c.append(el('div', { class: 'row', style: 'gap:4px; flex-wrap:wrap' },
                el('span', { class: 'faint', style: 'width:40px', text: `TD ${i}` }),
                el('span', { class: 'hint', text: 'tap' }), kcCell(e.onTap, pick('onTap')),
                el('span', { class: 'hint', text: 'hold' }), kcCell(e.onHold, pick('onHold')),
                el('span', { class: 'hint', text: '2×tap' }), kcCell(e.onDoubleTap, pick('onDoubleTap')),
                el('span', { class: 'hint', text: 'tap-hold' }), kcCell(e.onTapHold, pick('onTapHold')),
                term,
                TapDance.isEmpty(e) ? null : el('button', {
                    class: 'btn small', text: '✕', title: 'Clear this tap dance',
                    onclick: () => this.set(i, TapDance.empty()),
                })));
        }
        this.root.replaceChildren(c, this.picker.card);
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
        }
        this.picker = makePickerHost({ layerCount: this.app.layerCount });
        this.render();
    }

    async set(i, patch) {
        const e = { ...this.entries[i], ...patch, inputs: patch.inputs ?? [...this.entries[i].inputs] };
        try {
            await this.app.vial.comboSet(i, e);
            this.entries[i] = e;
            this.render();
        } catch (err) { toast(`Write failed: ${err.message}`, true); }
    }

    async setMask(i, mask) {
        try {
            this.masks[i] = await this.app.flask.setU16(CH.comboLayers, slot.comboMask(i), mask);
            this.render();
        } catch (err) { toast(`Write failed: ${err.message}`, true); }
    }

    render() {
        const c = card('Combos', `${this.count} slots — press the inputs together, get the output`);
        const show = visibleCount(this.entries, Combo.isEmpty, this.count);
        for (let i = 0; i < show; i++) {
            const e = this.entries[i];
            const row = el('div', { class: 'row', style: 'gap:4px; flex-wrap:wrap' },
                el('span', { class: 'faint', style: 'width:40px', text: `C ${i}` }));
            e.inputs.forEach((kc, slotIdx) => {
                row.append(kcCell(kc, () => this.picker.request((v) => {
                    const inputs = [...this.entries[i].inputs];
                    inputs[slotIdx] = v;
                    return this.set(i, { inputs });
                })));
            });
            row.append('→', kcCell(e.output, () => this.picker.request((v) => this.set(i, { output: v }))));
            if (!Combo.isEmpty(e)) {
                if (this.masks) {
                    const mask = this.masks[i];
                    const chips = el('span', { class: 'hint', text: 'layers:' });
                    row.append(chips);
                    for (let l = 0; l < Math.min(this.app.layerCount, 16); l++) {
                        row.append(el('button', {
                            class: 'btn small' + ((mask >> l) & 1 ? ' primary' : ''),
                            text: String(l), title: 'Layer mask — none lit = every layer',
                            onclick: () => this.setMask(i, mask ^ (1 << l)),
                        }));
                    }
                }
                row.append(el('button', {
                    class: 'btn small', text: '✕', title: 'Clear this combo',
                    onclick: () => this.set(i, Combo.empty()),
                }));
            }
            c.append(row);
        }
        if (this.masks) c.append(saveBar(() => this.app.flask.save(CH.comboLayers), 'Layer masks persist after saving.'));
        this.root.replaceChildren(c, this.picker.card);
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
        this.picker = makePickerHost({ layerCount: this.app.layerCount });
        this.render();
    }

    async set(i, patch) {
        const e = { ...this.entries[i], ...patch };
        try {
            await this.app.vial.keyOverrideSet(i, e);
            this.entries[i] = e;
            this.render();
        } catch (err) { toast(`Write failed: ${err.message}`, true); }
    }

    render() {
        const c = card('Key overrides',
            `${this.count} slots — trigger mods + key → replacement (e.g. ⇧+Backspace → Delete)`);
        const show = visibleCount(this.entries, KeyOverride.isEmpty, this.count);
        for (let i = 0; i < show; i++) {
            const e = this.entries[i];
            const row = el('div', { class: 'row', style: 'gap:4px; flex-wrap:wrap' },
                el('span', { class: 'faint', style: 'width:40px', text: `KO ${i}` }));
            for (const [label, bit] of KO_MODS) {
                row.append(el('button', {
                    class: 'btn small' + (e.triggerMods & bit ? ' primary' : ''),
                    text: label, title: 'Trigger modifier',
                    onclick: () => this.set(i, { triggerMods: e.triggerMods ^ bit }),
                }));
            }
            row.append(
                kcCell(e.trigger, () => this.picker.request((v) => this.set(i, { trigger: v }))),
                '→',
                kcCell(e.replacement, () => this.picker.request((v) => this.set(i, { replacement: v }))));
            if (!KeyOverride.isEmpty(e)) {
                const on = !!(e.options & KeyOverride.opt.enabled);
                row.append(
                    el('button', {
                        class: 'btn small' + (on ? ' primary' : ''), text: on ? 'on' : 'off',
                        title: 'Enabled',
                        onclick: () => this.set(i, { options: e.options ^ KeyOverride.opt.enabled }),
                    }),
                    el('button', {
                        class: 'btn small', text: '✕', title: 'Clear this override',
                        onclick: () => this.set(i, KeyOverride.empty()),
                    }));
            }
            c.append(row);
        }
        c.append(el('div', { class: 'note faint', text:
            'New overrides use Vial\'s defaults (all layers, suppress trigger mods). ' +
            'Suppressed/negative mod masks keep their values — edit those in the desktop app if needed.' }));
        this.root.replaceChildren(c, this.picker.card);
    }
}
