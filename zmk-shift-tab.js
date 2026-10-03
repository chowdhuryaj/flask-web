// ZMK Mod Morph tab — flask_csk, the QMK custom_shift_keys analog grown into a
// full mod-morph table (channel 0x16, proto v14; trigger sets need MORPH_CAPS).
// While the slot's trigger modifiers (any non-empty subset of ⌃⇧⌥⌘, matched
// EXACTLY, side-agnostic) are held, a key whose BASE usage matches sends the
// REPLACEMENT instead; the trigger mods are masked out of the report unless
// "keep mods" is on (ZMK mod-morph keep-mods). Tab id stays 'zmk-shift'.
//
//   ⇧ , → ;        shift-comma types ;       (shift masked)
//   ⇧ ⌫ → ⌦        shift-backspace deletes forward
//   ⌥ ⌫ → ⌦ keep   alt-backspace sends alt-delete (word delete forward)
//   ⌃⇧ , → ;       ctrl+shift+comma types ;  (a different slot from ⇧ ,)
//
// The replacement picker's modifier row encodes into the replacement (bits
// 24-31); the base is matched by page+id (its mod bits are ignored by the
// firmware). Firmware without MORPH_CAPS is Shift-only: the same UI minus the
// trigger chips and keep toggle. Same slot-list pattern as the Leader tab.

import { el, card, toggleRow, toast, reloadBar } from './ui.js?v=67';
import { CH, V } from './flaskproto.js?v=67';
import { usageFromName } from './zmk-keycodes.js?v=67';
import { blurClicks, pickOutput, outText, outCell, installSlotSummary, onSlotsChanged, dim } from './zmk-behaviour-common.js?v=67';
import { decodeCskSlot, encodeCskSlot, cskSlotIsEmpty, cskMorphCaps, cskNeedsMorph, cskDuplicateOf,
    cskSummary, trigText, TRIGGER_MODS, MOD_CTL, MOD_SFT, MOD_ALT, MOD_SHIFT_ONLY } from './zmk-csk-codec.js?v=67';

// One-click starters. Encodings ride usageFromName so the table stays data —
// names must exist in zmk-keycodes.js. shiftedMods = implicit-modifier bits
// for the replacement (0x02 = ⇧, MODS table). mods = trigger set (default ⇧).
const PRESETS = [
    { label: '⇧ ⌫ → ⌦', base: 'Backspace', shifted: 'Delete', hint: 'shift-backspace deletes forward' },
    { label: '⇧ , → ;', base: 'Comma', shifted: 'Semicolon', hint: 'shift-comma types a semicolon' },
    { label: '⇧ . → :', base: 'Dot', shifted: 'Semicolon', shiftedMods: 0x02, hint: 'shift-dot types a colon' },
    { label: '⌥ ⌫ → ⌦ keep', base: 'Backspace', shifted: 'Delete', mods: MOD_ALT, keep: true,
        hint: 'alt-backspace sends alt-delete (word delete forward)' },
    { label: '⌃⇧ , → ;', base: 'Comma', shifted: 'Semicolon', mods: MOD_CTL | MOD_SFT,
        hint: 'ctrl-shift-comma types a semicolon (separate from shift-comma)' },
];

export class ZmkShiftTab {
    constructor(app) {
        this.app = app;
        this.root = blurClicks(el('div'));
        this.drafts = new Set();
        this.morph = false;
        onSlotsChanged(CH.customShift, this, () => { if (this.slots) this.load().catch(() => {}); });
        installSlotSummary(app);
    }

    async load() {
        const { flask, hid } = this.app;
        hid?.pause?.();
        try {
            this.morph = await cskMorphCaps(flask);
            this.enabled = await flask.getU16(CH.customShift, V.cskEnabled);
            this.slotCount = await dim(this.app, CH.customShift, V.cskSlotCount);
            this.slots = [];
            for (let i = 0; i < this.slotCount; i++) {
                const r = await flask.getBytes(CH.customShift, V.cskSlot, [i], 1);
                this.slots.push(decodeCskSlot(r));
            }
        } finally {
            hid?.resume?.();
        }
        this.bar ??= reloadBar(CH.customShift, {
            label: 'Mod morphs',
            save: () => this.app.flask.save(CH.customShift),
            reload: () => this.load(),
        });
        this.render();
    }

    async writeSlot(i, before = null) {
        try {
            const s = this.slots[i];
            // Shift-only firmware cannot carry another trigger set: refuse rather than
            // silently rewrite a ⌃/⌥/⌘ or keep slot as plain Shift.
            if (!this.morph && cskNeedsMorph(s)) {
                if (before) this.slots[i] = before;
                toast('This firmware is Shift-only; update it to write ⌃ ⌥ ⌘ triggers or keep-mods', true);
                this.render();
                return;
            }
            const r = await this.app.flask.setBytes(CH.customShift, V.cskSlot,
                encodeCskSlot(i, s), 1);
            this.slots[i] = decodeCskSlot(r); // adopt the echo
            this.bar?.markEdited();
        } catch (e) {
            if (before) this.slots[i] = before;
            toast(`Mod-morph write failed: ${e.message}`, true);
        }
        this.render();
    }

    freeSlot() {
        return this.slots.findIndex((s, idx) =>
            cskSlotIsEmpty(s) && !this.drafts.has(idx));
    }

    addPair(patch = null) {
        const i = this.freeSlot();
        if (i < 0) { toast(`All ${this.slotCount} mod-morph slots are in use`, true); return; }
        this.slots[i] = { slot: i, base: 0, shifted: 0, mods: MOD_SHIFT_ONLY, keep: false, ...(patch || {}) };
        if (patch) this.writeSlot(i);
        else { this.drafts.add(i); this.render(); }
    }

    addPreset(p) {
        const mods = p.mods ?? MOD_SHIFT_ONLY;
        if (!this.morph && mods !== MOD_SHIFT_ONLY) {
            toast('This firmware only supports Shift triggers; update it for other modifiers', true);
            return;
        }
        const base = usageFromName(p.base);
        let shifted = usageFromName(p.shifted);
        if (base == null || shifted == null) { toast('Preset keycode missing', true); return; }
        if (p.shiftedMods) shifted = (((p.shiftedMods & 0xFF) << 24) | shifted) >>> 0;
        // Same base under the same trigger set → don't duplicate.
        if (this.slots.some((s) => !cskSlotIsEmpty(s) && (s.base & 0xFFFFFF) === (base & 0xFFFFFF)
            && s.mods === mods)) {
            toast(`${trigText(mods)} on that base key is already mapped`, true);
            return;
        }
        this.addPair({ base: base >>> 0, shifted: shifted >>> 0, mods, keep: !!p.keep });
    }

    async clearSlot(i) {
        this.slots[i] = { slot: i, base: 0, shifted: 0, mods: MOD_SHIFT_ONLY, keep: false };
        this.drafts.delete(i);
        await this.writeSlot(i);
    }

    toggleMod(i, bit) {
        const s = this.slots[i];
        const mods = s.mods ^ bit;
        if (!mods) { toast('A mod morph needs at least one trigger modifier', true); return; }
        const before = { ...s };
        s.mods = mods;
        this.writeSlot(i, before);
    }

    toggleKeep(i) {
        const before = { ...this.slots[i] };
        this.slots[i].keep = !before.keep;
        this.writeSlot(i, before);
    }

    pickSide(i, side) {
        const s = this.slots[i];
        const trig = trigText(s.mods);
        const title = side === 'base'
            ? `Slot ${i}: base key (what you press)`
            : `Slot ${i}: replacement (what ${trig}+key types)`;
        pickOutput({
            app: this.app, surface: side === 'base' ? 'zmk.cskBase' : 'zmk.cskShifted', title,
            value: s[side] ? { action: 1, param1: s[side] } : null,
            onPick: (v) => {
                const usage = (v.action === 1 ? v.param1 : 0) >>> 0;
                const before = { ...s };
                this.slots[i][side] = usage;
                this.writeSlot(i, before);
            },
        });
    }

    pairCard(i) {
        const s = this.slots[i];
        const live = !cskSlotIsEmpty(s) && s.base !== 0 && s.shifted !== 0;
        const label = (u) => outText({ action: 1, param1: u }, 'zmk.cskShifted');
        const trig = trigText(s.mods);
        const tile = (side, value, hint) => el('div', {},
            el('div', { class: 'note faint', text: hint }),
            el('button', {
                class: 'code',
                style: 'min-width:72px; min-height:44px; font-size:1.05em',
                title: value ? label(value) : `pick the ${hint}`,
                onclick: () => this.pickSide(i, side),
            }, value ? outCell({ action: 1, param1: value }, side === 'base' ? 'zmk.cskBase' : 'zmk.cskShifted') : `${hint}…`));

        const dup = cskDuplicateOf(this.slots, i);
        const chips = this.morph ? el('div', {},
            el('div', { class: 'note faint', text: 'trigger (held exactly)' }),
            el('div', { style: 'display:flex; gap:4px', role: 'group', 'aria-label': `Slot ${i} trigger modifiers` },
                ...TRIGGER_MODS.map((t) => el('button', {
                    class: 'chip' + (s.mods & t.bit ? ' on' : ''),
                    style: 'min-height:44px; min-width:44px; font-size:1.05em',
                    title: t.name, 'aria-pressed': String(!!(s.mods & t.bit)),
                    text: t.glyph,
                    onclick: () => this.toggleMod(i, t.bit),
                })))) : null;
        const keep = this.morph ? el('label', {
            class: 'note', style: 'display:flex; gap:6px; align-items:center; padding-bottom:12px',
            title: 'leave the trigger modifiers pressed alongside the replacement (ZMK keep-mods)',
        }, el('input', { type: 'checkbox', checked: s.keep, onchange: () => this.toggleKeep(i) }),
        'keep mods') : null;

        return el('div', { class: 'card', style: live ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, el('b', { text: `Slot ${i}` }),
                    el('span', {
                        class: 'hint',
                        text: live ? cskSummary(s, label) : 'incomplete: pick both sides',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Delete', title: 'empty this slot',
                    onclick: () => this.clearSlot(i),
                })),
            el('div', { style: 'display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap' },
                chips,
                tile('base', s.base, 'base key'),
                el('span', { style: 'font-size:1.4em; padding-bottom:10px', text: `${trig}→` }),
                tile('shifted', s.shifted, 'replacement'),
                keep),
            dup >= 0 ? el('div', {
                class: 'note', role: 'alert', 'data-dup': String(dup),
                text: `Duplicate: slot ${dup} already maps ${trig} + this base key, so one of them never fires. Change the trigger or the key.`,
            }) : null);
    }

    render() {
        const { flask } = this.app;
        const visible = this.slots.map((s, i) => i)
            .filter((i) => !cskSlotIsEmpty(this.slots[i]) || this.drafts.has(i));
        const used = this.slots.filter((s) => !cskSlotIsEmpty(s)).length;

        const controls = card('Mod morph',
            this.morph
                ? 'remap what any modifier combination + key types, no hand-written mod-morph behaviors'
                : 'remap what ⇧+key types (this firmware is Shift-only; update it for ⌃ ⌥ ⌘ triggers)',
            toggleRow({
                label: 'Mod morphs enabled',
                hint: 'master switch; slots stay stored while off',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.customShift, V.cskEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn small primary', text: '＋ New slot',
                    onclick: () => this.addPair(),
                }),
                ...PRESETS.filter((p) => this.morph || !p.mods).map((p) => el('button', {
                    class: 'btn small', text: p.label, title: p.hint,
                    onclick: () => this.addPreset(p),
                })),
                el('span', { class: 'note faint', text: `${used}/${this.slotCount} slots used` }),
                ),
            this.bar,
            el('div', { class: 'note faint',
                text: 'A slot fires only when exactly its trigger modifiers are held, so ⇧ , and ⌃⇧ , are separate slots. '
                    + 'The replacement picker\'s modifier row rides the replacement, e.g. pick R with ⇧ for h→R. '
                    + (this.morph ? 'Keep mods leaves the trigger pressed with the replacement. ' : '')
                    + 'With ⌃ or ⌘ triggers the trigger stays masked until the morphed key is released, so roll-then-shortcut (⌃H then ⌃C) sends a plain key: release first. '
                    + 'Edits are live.' }));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.pairCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No slots yet. Use a preset or ＋ New slot, then pick the trigger, the base key and its replacement.',
            }));
    }
}
