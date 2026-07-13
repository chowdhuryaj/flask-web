// ZMK Shift tab — flask_csk custom shift keys (channel 0x16, proto v14).
// The QMK custom_shift_keys analog: while Shift is held, a key whose BASE
// usage matches a slot sends the SHIFTED usage instead, with the physical
// Shift masked out of the report. No per-key mod-morph behaviors to hand-
// write — one table, applied to whatever the keymap emits.
//
//   base , → shifted ;      ⇧, types ;   (shift masked)
//   base ⌫ → shifted ⌦      ⇧⌫ deletes forward
//   base H → shifted ⇧R     ⇧h types R   (the replacement's own shift)
//
// The shifted PICKER's modifier chips encode into the replacement (bits
// 24-31); the base is matched by page+id (its mod bits are ignored by the
// firmware). Same slot-list pattern as the Leader tab.

import { el, card, toggleRow, toast } from './ui.js?v=13';
import { CH, V } from './flaskproto.js?v=13';
import { pickUsage } from './zmk-combos-tab.js?v=13';
import { usageCap, usageLabel, usageFromName } from './zmk-keycodes.js?v=13';
import { decodeCskSlot, encodeCskSlot, cskSlotIsEmpty } from './zmk-csk-codec.js?v=13';

// One-click starters (AJ's examples). Encodings ride usageFromName so the
// table stays data — names must exist in zmk-keycodes.js. shiftedMods =
// implicit-modifier bits for the replacement (0x02 = ⇧, MODS table).
const PRESETS = [
    { label: '⌫ → ⌦', base: 'Backspace', shifted: 'Delete', hint: 'shift-backspace deletes forward' },
    { label: ', → ;', base: 'Comma', shifted: 'Semicolon', hint: 'shift-comma types a semicolon' },
    { label: '. → :', base: 'Dot', shifted: 'Semicolon', shiftedMods: 0x02, hint: 'shift-dot types a colon' },
];

export class ZmkShiftTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.drafts = new Set();
    }

    async load() {
        const { flask, hid } = this.app;
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.customShift, V.cskEnabled);
            this.slotCount = await flask.getU16(CH.customShift, V.cskSlotCount);
            this.slots = [];
            for (let i = 0; i < this.slotCount; i++) {
                const r = await flask.getBytes(CH.customShift, V.cskSlot, [i], 1);
                this.slots.push(decodeCskSlot(r));
            }
        } finally {
            hid?.resume?.();
        }
        this.render();
    }

    async writeSlot(i, before = null) {
        try {
            const r = await this.app.flask.setBytes(CH.customShift, V.cskSlot,
                encodeCskSlot(i, this.slots[i]), 1);
            this.slots[i] = decodeCskSlot(r); // adopt the echo
        } catch (e) {
            if (before) this.slots[i] = before;
            toast(`Shift-pair write failed: ${e.message}`, true);
        }
        this.render();
    }

    freeSlot() {
        return this.slots.findIndex((s, idx) =>
            cskSlotIsEmpty(s) && !this.drafts.has(idx));
    }

    addPair(patch = null) {
        const i = this.freeSlot();
        if (i < 0) { toast(`All ${this.slotCount} shift-pair slots are in use`, true); return; }
        this.slots[i] = { slot: i, base: 0, shifted: 0, ...(patch || {}) };
        if (patch) this.writeSlot(i);
        else { this.drafts.add(i); this.render(); }
    }

    addPreset(p) {
        const base = usageFromName(p.base);
        let shifted = usageFromName(p.shifted);
        if (base == null || shifted == null) { toast('Preset keycode missing', true); return; }
        if (p.shiftedMods) shifted = (((p.shiftedMods & 0xFF) << 24) | shifted) >>> 0;
        // Already mapped → don't duplicate the base.
        if (this.slots.some((s) => s.base === (base >>> 0) && !cskSlotIsEmpty(s))) {
            toast('That base key already has a shift pair', true);
            return;
        }
        this.addPair({ base: base >>> 0, shifted: shifted >>> 0 });
    }

    async clearSlot(i) {
        this.slots[i] = { slot: i, base: 0, shifted: 0 };
        this.drafts.delete(i);
        await this.writeSlot(i);
    }

    pickSide(i, side) {
        const s = this.slots[i];
        const title = side === 'base'
            ? `Pair ${i} — base key (what you press)`
            : `Pair ${i} — shifted output (what ⇧+key types)`;
        pickUsage(title, s[side], (usage) => {
            const before = { ...s };
            // A duplicate base would shadow the earlier slot — refuse.
            if (side === 'base' && usage
                && this.slots.some((o, oi) => oi !== i && o.base === (usage >>> 0)
                    && !cskSlotIsEmpty(o))) {
                toast('That base key already has a shift pair', true);
                return;
            }
            this.slots[i][side] = usage >>> 0;
            this.writeSlot(i, before);
        });
    }

    pairCard(i) {
        const s = this.slots[i];
        const live = !cskSlotIsEmpty(s) && s.base !== 0 && s.shifted !== 0;
        const tile = (side, value, hint) => el('div', {},
            el('div', { class: 'note faint', text: hint }),
            el('button', {
                class: 'code',
                style: 'min-width:72px; min-height:44px; font-size:1.05em',
                title: value ? usageLabel(value) : `pick the ${hint}`,
                onclick: () => this.pickSide(i, side),
            }, value ? usageCap(value) : `${hint}…`));

        return el('div', { class: 'card', style: live ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, el('b', { text: `Pair ${i}` }),
                    el('span', {
                        class: 'hint',
                        text: live
                            ? `⇧ ${usageLabel(s.base)} types ${usageLabel(s.shifted)}`
                            : 'incomplete — pick both sides',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: '🗑', title: 'empty this pair',
                    onclick: () => this.clearSlot(i),
                })),
            el('div', { style: 'display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap' },
                tile('base', s.base, 'base key'),
                el('span', { style: 'font-size:1.4em; padding-bottom:10px', text: '⇧→' }),
                tile('shifted', s.shifted, 'shifted output')));
    }

    render() {
        const { flask } = this.app;
        const visible = this.slots.map((s, i) => i)
            .filter((i) => !cskSlotIsEmpty(this.slots[i]) || this.drafts.has(i));
        const used = this.slots.filter((s) => !cskSlotIsEmpty(s)).length;

        const controls = card('Custom shift keys',
            'remap what ⇧+key types — no hand-written mod-morph behaviors',
            toggleRow({
                label: 'Custom shifts enabled',
                hint: 'master switch; pairs stay stored while off',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.customShift, V.cskEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn small primary', text: '＋ New pair',
                    onclick: () => this.addPair(),
                }),
                ...PRESETS.map((p) => el('button', {
                    class: 'btn small', text: p.label, title: p.hint,
                    onclick: () => this.addPreset(p),
                })),
                el('span', { class: 'note faint', text: `${used}/${this.slotCount} slots used` }),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Save to keyboard',
                    onclick: async () => {
                        try { await flask.save(CH.customShift); toast('Shift pairs saved'); }
                        catch (e) { toast(`Save failed: ${e.message}`, true); }
                    },
                })),
            el('div', { class: 'note faint',
                text: 'The shifted picker\'s modifier chips ride the replacement — e.g. pick R with ⇧ for h→R. '
                    + 'Edits are live; Save persists across power-off.' }));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.pairCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No pairs yet — use a preset or ＋ New pair, then pick the base key and its shifted output.',
            }));
    }
}
