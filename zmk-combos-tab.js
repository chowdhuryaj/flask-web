// ZMK Combos tab — flask_combos runtime combos (channel 0x24, proto v7).
// UI copies nickcoutsos/keymap-editor's combos mode: one card per combo
// with the output binding as a keycap tile on the left and a mini board on
// the right with the combo's key positions highlighted; click keys on the
// mini board to toggle membership (up to 4), click the tile to pick the
// output. "Add New Combo" takes the first free slot; trash empties it.
//
// Differences from Coutsos (compile-time .keymap editing) by design:
//  - edits are LIVE on the device (write-through), Save persists;
//  - output is an encoded HID usage (keycode + modifiers — Vial parity),
//    not an arbitrary behavior;
//  - the timeout is global (one candidate window for all slots);
//  - devicetree combos baked into the firmware are invisible here (ZMK
//    Studio has no combo RPC) — runtime slots on the same positions
//    shadow them.
//
// Board geometry rides app.profile.keys, which the ZMK Keymap tab publishes
// after its Studio load; before that a numeric position fallback renders.

import { el, card, sliderRow, toggleRow, saveBar, modal, toast } from './ui.js?v=4';
import { CH, V } from './flaskproto.js?v=4';
import { renderKeyboardSVG } from './keymap-tab.js?v=4';
import {
    keyboardUsages, consumerUsages, kpParam, cpParam,
    usageCap, usageLabel, usageFromName,
} from './zmk-keycodes.js?v=4';
import {
    COMBO_POS_NONE, COMBO_MAX_KEYS,
    decodeComboSlot, encodeComboSlot, comboSlotIsEmpty,
} from './zmk-combos-codec.js?v=4';

const MODS = [
    { bit: 0x01, glyph: '⌃', label: 'Ctrl' },
    { bit: 0x02, glyph: '⇧', label: 'Shift' },
    { bit: 0x04, glyph: '⌥', label: 'Alt' },
    { bit: 0x08, glyph: '⌘', label: 'GUI' },
];

export class ZmkCombosTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.drafts = new Set(); // empty slots kept visible while editing
    }

    async load() {
        const { flask } = this.app;
        this.enabled = await flask.getU16(CH.combos, V.combosEnabled);
        this.slotCount = await flask.getU16(CH.combos, V.combosSlotCount);
        this.timeout = await flask.getU16(CH.combos, V.combosTimeout);
        this.slots = [];
        for (let i = 0; i < this.slotCount; i++) {
            const r = await flask.getBytes(CH.combos, V.combosSlot, [i]);
            this.slots.push(decodeComboSlot(r));
        }
        this.render();
    }

    async writeSlot(i) {
        try {
            const r = await this.app.flask.setBytes(CH.combos, V.combosSlot,
                encodeComboSlot(i, this.slots[i]));
            this.slots[i] = decodeComboSlot(r); // adopt the echo (normalized)
        } catch (e) {
            toast(`Combo write failed: ${e.message}`, true);
        }
        this.render();
    }

    addCombo() {
        const i = this.slots.findIndex((s, idx) =>
            comboSlotIsEmpty(s) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} combo slots are in use`, true); return; }
        this.drafts.add(i);
        this.render();
    }

    async clearSlot(i) {
        this.slots[i] = { slot: i, positions: [], usage: 0 };
        this.drafts.delete(i);
        await this.writeSlot(i);
    }

    togglePosition(i, pos) {
        const s = this.slots[i];
        const at = s.positions.indexOf(pos);
        if (at >= 0) s.positions.splice(at, 1);
        else if (s.positions.length < COMBO_MAX_KEYS) s.positions.push(pos);
        else { toast(`Combos take up to ${COMBO_MAX_KEYS} keys`, true); return; }
        this.writeSlot(i);
    }

    // ---- output picker (usage + modifiers) ----

    pickOutput(i) {
        const s = this.slots[i];
        let mods = (s.usage >>> 24) & 0xFF;
        const baseOf = (u) => u & 0xFFFFFF;
        let base = baseOf(s.usage);

        const apply = () => {
            this.slots[i].usage = base ? (((mods << 24) | base) >>> 0) : 0;
            back.remove();
            this.writeSlot(i);
        };

        const preview = el('span', {
            class: 'code',
            style: 'font-size:1.1em; padding:4px 10px; min-width:60px; text-align:center',
        });
        const refreshPreview = () => {
            const u = base ? (((mods << 24) | base) >>> 0) : 0;
            preview.textContent = u ? usageCap(u) : '—';
            preview.title = u ? usageLabel(u) : 'no output picked';
        };

        const modBtns = MODS.map((m) => {
            const btn = el('button', {
                class: 'btn small' + ((mods & m.bit) ? ' primary' : ''),
                text: `${m.glyph} ${m.label}`,
                title: `left ${m.label} held with the output`,
                onclick: () => {
                    mods ^= m.bit;
                    btn.classList.toggle('primary', !!(mods & m.bit));
                    refreshPreview();
                },
            });
            return btn;
        });

        const chipsWrap = el('div', {
            style: 'display:flex; flex-wrap:wrap; gap:4px; max-height:260px; overflow-y:auto; margin-top:8px',
        });
        const buildChips = (filter = '') => {
            const q = filter.trim().toLowerCase();
            const match = (k) => !q || k.label.toLowerCase().includes(q)
                || k.cap.toLowerCase().includes(q);
            const chip = (k, toParam) => el('button', {
                class: 'btn small' + (baseOf(toParam(k.code)) === base ? ' primary' : ''),
                text: k.cap, title: k.label,
                onclick: () => { base = baseOf(toParam(k.code)); refreshPreview(); buildChips(search.value); },
            });
            chipsWrap.replaceChildren(
                ...keyboardUsages.filter(match).map((k) => chip(k, kpParam)),
                ...consumerUsages.filter(match).map((k) => chip(k, cpParam)));
        };
        const search = el('input', {
            type: 'text', placeholder: 'Search keys… (name or cap)',
            style: 'width:100%',
            oninput: () => {
                const hit = usageFromName(search.value);
                if (hit != null) { base = baseOf(hit); refreshPreview(); }
                buildChips(search.value);
            },
        });

        const body = el('div', {},
            el('div', { class: 'row' },
                el('span', { class: 'lbl', text: 'Output' }),
                el('span', { style: 'flex:1' }), preview),
            el('div', { style: 'display:flex; gap:6px; margin:8px 0' }, ...modBtns),
            search, chipsWrap);

        const back = modal(`Combo ${i} output`, body, [
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => back.remove() }),
            el('button', { class: 'btn small primary', text: 'Apply', onclick: apply }),
        ]);
        refreshPreview();
        buildChips();
    }

    // ---- position selection ----

    miniBoard(i) {
        const geom = this.app.profile?.keys;
        const s = this.slots[i];
        if (!geom?.length) return this.positionFallback(i);

        const pressed = new Set(s.positions.map((p) => `0,${p}`));
        const mini = {
            keys: geom, encoderKeys: [],
            labelFor: () => '', hoverFor: () => 'click to toggle membership',
            keyName: (k) => String(k.pos),
        };
        return renderKeyboardSVG({
            profile: mini,
            scale: 0.42,
            keycodeAt: () => null,
            pressed,
            selected: null,
            onSelect: (sel) => this.togglePosition(i, sel.col),
        });
    }

    /** Numeric fallback until the Keymap tab has published device geometry. */
    positionFallback(i) {
        const s = this.slots[i];
        const posInput = el('input', {
            type: 'number', min: 0, max: 254, placeholder: 'position #',
            style: 'width:100px',
        });
        return el('div', {},
            el('div', { class: 'note faint', text: 'Open the Keymap tab once to load board geometry — picking keys by click needs it. Until then, add positions by number:' }),
            el('div', { style: 'display:flex; gap:4px; align-items:center; flex-wrap:wrap' },
                ...s.positions.map((p) => el('button', {
                    class: 'btn small primary', text: `pos ${p} ✕`,
                    onclick: () => this.togglePosition(i, p),
                })),
                posInput,
                el('button', {
                    class: 'btn small', text: 'Add',
                    onclick: () => {
                        const p = Number(posInput.value);
                        if (Number.isInteger(p) && p >= 0 && p < COMBO_POS_NONE) {
                            this.togglePosition(i, p);
                        }
                    },
                })));
    }

    comboCard(i) {
        const s = this.slots[i];
        const live = !comboSlotIsEmpty(s);
        const tile = el('button', {
            class: 'code',
            style: 'min-width:72px; min-height:44px; font-size:1.05em',
            title: s.usage ? usageLabel(s.usage) : 'pick the combo output',
            onclick: () => this.pickOutput(i),
        }, s.usage ? usageCap(s.usage) : 'output…');

        return el('div', { class: 'card', style: live ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, el('b', { text: `Combo ${i}` }),
                    el('span', {
                        class: 'hint',
                        text: live ? `${s.positions.length} keys → ${usageLabel(s.usage)}`
                            : 'incomplete — needs ≥ 2 keys and an output',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: '🗑', title: 'empty this combo slot',
                    onclick: () => this.clearSlot(i),
                })),
            el('div', { style: 'display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap' },
                el('div', {},
                    el('div', { class: 'note faint', text: 'output' }), tile),
                el('div', { style: 'flex:1; overflow-x:auto' }, this.miniBoard(i))));
    }

    render() {
        const { flask } = this.app;
        const visible = this.slots
            .map((s, i) => i)
            .filter((i) => !comboSlotIsEmpty(this.slots[i]) || this.drafts.has(i));
        const used = this.slots.filter((s) => !comboSlotIsEmpty(s)).length;

        const controls = card('Runtime combos',
            'press keys together, get a keycode — live-editable, unlike ZMK\'s devicetree combos',
            toggleRow({
                label: 'Combos enabled',
                hint: 'master switch; slots stay stored while off',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.combos, V.combosEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            sliderRow({
                label: 'Timeout',
                hint: 'candidate window for all combos, ms',
                min: 10, max: 2000, step: 5, value: this.timeout,
                format: (v) => `${v} ms`,
                onChange: async (val) => {
                    this.timeout = await flask.setU16(CH.combos, V.combosTimeout, val);
                    return this.timeout;
                },
            }),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn primary', text: 'Add New Combo',
                    onclick: () => this.addCombo(),
                }),
                el('span', { class: 'note faint', text: `${used} of ${this.slotCount} slots in use` })),
            saveBar(() => flask.save(CH.combos),
                'Edits are live; Save persists them across power cycles.'));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.comboCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No combos yet — Add New Combo, click at least two keys on the mini board, pick an output.',
            }));
    }
}
