// ZMK Combos tab — flask_combos runtime combos (channel 0x24, proto v7).
// UI copies nickcoutsos/keymap-editor's combos mode: one card per combo
// with the output binding as a keycap tile on the left and a mini board on
// the right with the combo's key positions highlighted; click keys on the
// mini board to toggle membership (device keys-per-slot), click the tile to pick the
// output. "Add New Combo" takes the first free slot; trash empties it.
//
// Differences from Coutsos (compile-time .keymap editing) by design:
//  - edits are LIVE on the device (write-through), Save persists;
//  - outputs are typed since v12 (usage / macro / any Studio behavior);
//  - per-combo timeout / prior-idle / layer since v14 (proto 14) — the
//    keymap's devicetree combos were IMPORTED into runtime slots as
//    compiled defaults, so they all show up and edit here now (pre-v14
//    firmware kept them invisible and the timeout global).
//
// Board geometry rides app.profile.keys, which the ZMK Keymap tab publishes
// after its Studio load; before that a numeric position fallback renders.

import { el, card, sliderRow, toggleRow, saveBar, modal, toast, renameLabel } from './ui.js?v=18';
import { zmkSlotName, zmkSetSlotName } from './zmk.js?v=18';
import { CH, V } from './flaskproto.js?v=18';
import { renderKeyboardSVG } from './keymap-tab.js?v=18';
import {
    keyboardUsages, consumerUsages, kpParam, cpParam,
    usageCap, usageLabel, usageFromName,
} from './zmk-keycodes.js?v=18';
import {
    COMBO_POS_NONE, COMBO_MAX_KEYS, COMBO_ACTION, COMBO_LAYER_ANY,
    decodeComboSlot, encodeComboSlot,
    decodeComboSlotV2, encodeComboSlotV2, comboSlotV2IsEmpty,
    decodeComboSlotV3, encodeComboSlotV3,
    comboSlotToTyped, comboTypedToLegacy,
} from './zmk-combos-codec.js?v=18';
import { zmkBehaviors } from './zmk-keycodes.js?v=18';
import { buildZmkPicker } from './zmk-keymap-tab.js?v=18';
import { captureOneKey } from './zmk-capture.js?v=18';

// Shared with the keymap picker's mod chips + tap-hold composer (same
// circular-import pattern as buildZmkPicker: only used inside functions).
export const MODS = [
    { bit: 0x01, glyph: '⌃', label: 'Ctrl' },
    { bit: 0x02, glyph: '⇧', label: 'Shift' },
    { bit: 0x04, glyph: '⌥', label: 'Alt' },
    { bit: 0x08, glyph: '⌘', label: 'GUI' },
];

/** Modal usage picker (keycode + implicit modifiers → encoded u32). Shared
 * by the ZMK Combos and Macros tabs — onApply(usage) fires on Apply. */
export function pickUsage(title, currentUsage, onApply) {
    let mods = (currentUsage >>> 24) & 0xFF;
    const baseOf = (u) => u & 0xFFFFFF;
    let base = baseOf(currentUsage);

    const apply = () => {
        onApply(base ? (((mods << 24) | base) >>> 0) : 0);
        back.remove();
    };

    const preview = el('span', {
        class: 'code',
        style: 'font-size:1.1em; padding:4px 10px; min-width:60px; text-align:center',
    });
    const refreshPreview = () => {
        const u = base ? (((mods << 24) | base) >>> 0) : 0;
        preview.textContent = u ? usageCap(u) : '—';
        preview.title = u ? usageLabel(u) : 'no key picked';
    };

    const modBtns = MODS.map((m) => {
        const btn = el('button', {
            class: 'btn small' + ((mods & m.bit) ? ' primary' : ''),
            text: `${m.glyph} ${m.label}`,
            title: `left ${m.label} held with the key`,
            onclick: () => {
                mods ^= m.bit;
                btn.classList.toggle('primary', !!(mods & m.bit));
                refreshPreview();
            },
        });
        return btn;
    });

    // Press-to-pick: arm window key capture and adopt the pressed key
    // (with any held modifiers), the keymap editor's type-to-assign in every
    // settings-tab picker. A second click (or Esc) disarms.
    let captureStop = null;
    const syncMods = () => modBtns.forEach((b, i) =>
        b.classList.toggle('primary', !!(mods & MODS[i].bit)));
    const pressBtn = el('button', {
        class: 'btn small',
        title: 'press the physical key you want (chords capture their modifiers)',
        text: '⌨ Press a key',
    });
    const setArmed = (on) => {
        pressBtn.classList.toggle('primary', on);
        pressBtn.textContent = on ? '⌨ Press a key… (Esc)' : '⌨ Press a key';
    };
    pressBtn.addEventListener('click', () => {
        if (captureStop) { captureStop(); return; }
        setArmed(true);
        captureStop = captureOneKey((param) => {
            mods = (param >>> 24) & 0xFF;
            base = baseOf(param);
            syncMods();
            refreshPreview();
            buildChips(search.value);
        }, { onStop: () => { captureStop = null; setArmed(false); } });
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
            el('span', { class: 'lbl', text: 'Key' }),
            el('span', { style: 'flex:1' }), preview),
        el('div', { style: 'display:flex; gap:6px; margin:8px 0; align-items:center; flex-wrap:wrap' },
            ...modBtns, el('span', { style: 'flex:1' }), pressBtn),
        search, chipsWrap);

    const back = modal(title, body, [
        el('button', { class: 'btn small', text: 'Cancel', onclick: () => { captureStop?.(); back.remove(); } }),
        el('button', { class: 'btn small primary', text: 'Apply', onclick: () => { captureStop?.(); apply(); } }),
    ]);
    refreshPreview();
    buildChips();
    return back;
}

export class ZmkCombosTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.drafts = new Set(); // empty slots kept visible while editing
    }

    async load() {
        const { flask, hid } = this.app;
        // Back the HUD poll off for the whole bulk read (64 slot frames) —
        // interleaved polling stretches the burst and multiplies timeout
        // exposure (bench 2026-07-11 congestion round).
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.combos, V.combosEnabled);
            this.slotCount = await flask.getU16(CH.combos, V.combosSlotCount);
            this.timeout = await flask.getU16(CH.combos, V.combosTimeout);
            // Keys per slot sizes the wire frame — RO value on v9+; v7/v8
            // firmware answers unhandled (0) and is fixed at 4.
            this.maxKeys = (this.app.caps?.combosKeys
                && await flask.getU16(CH.combos, V.combosKeys)) || COMBO_MAX_KEYS;
            // v12 firmware speaks typed slots (usage-hold / macro /
            // behavior); older firmware keeps the usage-only frame, bridged
            // into the same typed shape so the tab has ONE internal model.
            this.typed = !!this.app.caps?.combosTyped;
            // v14 timed slots: per-combo timeout / prior-idle / layer (the
            // imported devicetree combos' knobs) ride the SLOT_V3 frame.
            this.timed = !!this.app.caps?.combosTimed;
            this.macroSlots = (this.typed && this.app.caps?.macros)
                ? await flask.getU16(CH.macros, V.macrosSlotCount) : 0;
            this.slots = [];
            for (let i = 0; i < this.slotCount; i++) {
                if (this.timed) {
                    const r = await flask.getBytes(CH.combos, V.combosSlotV3, [i], 1);
                    this.slots.push(decodeComboSlotV3(r, this.maxKeys));
                } else if (this.typed) {
                    const r = await flask.getBytes(CH.combos, V.combosSlotV2, [i], 1);
                    this.slots.push(decodeComboSlotV2(r, this.maxKeys));
                } else {
                    const r = await flask.getBytes(CH.combos, V.combosSlot, [i], 1);
                    this.slots.push(comboSlotToTyped(decodeComboSlot(r, this.maxKeys)));
                }
            }
        } finally {
            hid?.resume?.();
        }
        this.render();
    }

    async writeSlot(i, before = null) {
        try {
            if (this.timed) {
                const r = await this.app.flask.setBytes(CH.combos, V.combosSlotV3,
                    encodeComboSlotV3(i, this.slots[i], this.maxKeys), 1);
                this.slots[i] = decodeComboSlotV3(r, this.maxKeys); // adopt the echo
            } else if (this.typed) {
                const r = await this.app.flask.setBytes(CH.combos, V.combosSlotV2,
                    encodeComboSlotV2(i, this.slots[i], this.maxKeys), 1);
                this.slots[i] = decodeComboSlotV2(r, this.maxKeys); // adopt the echo
            } else {
                const r = await this.app.flask.setBytes(CH.combos, V.combosSlot,
                    encodeComboSlot(i, comboTypedToLegacy(this.slots[i]), this.maxKeys), 1);
                this.slots[i] = comboSlotToTyped(decodeComboSlot(r, this.maxKeys));
            }
        } catch (e) {
            // Revert the optimistic local edit — keeping it made the UI lie
            // about what the device holds (bench 2026-07-11, timeouts).
            if (before) this.slots[i] = before;
            toast(`Combo write failed: ${e.message}`, true);
        }
        this.render();
    }

    addCombo() {
        const i = this.slots.findIndex((s, idx) =>
            comboSlotV2IsEmpty(s) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} combo slots are in use`, true); return; }
        // An EMPTY slot can still carry position junk: firmware that boots
        // its table zero-filled reads back as pos 0 × maxKeys (bench
        // 2026-07-12 — every draft started with 6-8 phantom position-0
        // entries that each took a click to remove). A draft always starts
        // from a clean slate; the first write persists the real content.
        this.slots[i] = this.emptySlot(i);
        this.drafts.add(i);
        this.render();
    }

    emptySlot(i) {
        return { slot: i, positions: [], action: COMBO_ACTION.none,
            behaviorId: 0, param1: 0, param2: 0,
            timeoutMs: 0, priorIdleMs: 0, layer: COMBO_LAYER_ANY };
    }

    async clearSlot(i) {
        this.slots[i] = this.emptySlot(i);
        this.drafts.delete(i);
        await this.writeSlot(i);
    }

    togglePosition(i, pos) {
        const s = this.slots[i];
        const before = { ...s, positions: [...s.positions] };
        const at = s.positions.indexOf(pos);
        if (at >= 0) s.positions.splice(at, 1);
        else if (s.positions.length < this.maxKeys) s.positions.push(pos);
        else { toast(`Combos take up to ${this.maxKeys} keys`, true); return; }
        this.writeSlot(i, before);
    }

    // ---- output picker ----

    /** Describe a typed output for the tile / hint. */
    outputDesc(s, { cap = false } = {}) {
        switch (s.action) {
        case COMBO_ACTION.usage:
            return cap ? usageCap(s.param1) : usageLabel(s.param1);
        case COMBO_ACTION.macro:
            return cap ? `M${s.param1}` : `Macro ${s.param1}`;
        case COMBO_ACTION.behavior: {
            const d = zmkBehaviors().get(s.behaviorId);
            const name = d?.displayName || `behavior #${s.behaviorId}`;
            const params = [s.param1, s.param2].filter((p) => p !== 0);
            return cap ? name.split(' ').map((w) => w[0]).join('').slice(0, 4)
                : `${name}${params.length ? ' (' + params.join(', ') + ')' : ''}`;
        }
        default:
            return '';
        }
    }

    _applyOutput(i, patch) {
        const before = { ...this.slots[i], positions: [...this.slots[i].positions] };
        Object.assign(this.slots[i], {
            action: COMBO_ACTION.none, behaviorId: 0, param1: 0, param2: 0,
        }, patch);
        this.writeSlot(i, before);
    }

    pickOutput(i) {
        const s = this.slots[i];
        if (!this.typed) {
            // pre-v12 firmware: usage-only, straight to the keycode picker
            pickUsage(`Combo ${i} output`, s.action === COMBO_ACTION.usage ? s.param1 : 0,
                (usage) => this._applyOutput(i,
                    usage ? { action: COMBO_ACTION.usage, param1: usage } : {}));
            return;
        }
        // v12 typed output: keycode / macro / any Studio behavior (tap-hold,
        // layer key…) — the behavior list needs the Keymap tab's catalog.
        const behaviors = zmkBehaviors();
        const macroSlots = this.macroSlots ?? 0;
        const rows = [
            el('button', {
                class: 'btn small primary', text: '⌨ Keycode…',
                onclick: () => {
                    back.remove();
                    pickUsage(`Combo ${i} output`,
                        s.action === COMBO_ACTION.usage ? s.param1 : 0,
                        (usage) => this._applyOutput(i,
                            usage ? { action: COMBO_ACTION.usage, param1: usage } : {}));
                },
            }),
        ];
        if (macroSlots > 0) {
            const sel = el('select', {}, ...Array.from({ length: macroSlots }, (_, m) =>
                el('option', {
                    value: m, text: `Macro ${m}`,
                    selected: s.action === COMBO_ACTION.macro && s.param1 === m,
                })));
            rows.push(el('div', { style: 'display:flex; gap:6px; align-items:center' },
                el('button', {
                    class: 'btn small', text: '▶ Play macro',
                    onclick: () => {
                        back.remove();
                        this._applyOutput(i, { action: COMBO_ACTION.macro, param1: Number(sel.value) });
                    },
                }), sel));
        }
        if (behaviors.size) {
            rows.push(el('div', { class: 'note faint', style: 'margin-top:6px',
                text: 'Or any behavior — tap-holds and layer keys work; the combo behaves like a key at its first position:' }));
            rows.push(buildZmkPicker({
                keyPressId: null,
                onPick: (b) => {
                    back.remove();
                    this._applyOutput(i, {
                        action: COMBO_ACTION.behavior, behaviorId: b.behaviorId,
                        param1: b.param1 >>> 0, param2: b.param2 >>> 0,
                    });
                },
            }));
        } else {
            rows.push(el('div', { class: 'note faint',
                text: 'Behavior outputs need the device behavior catalog — open the Keymap tab once first.' }));
        }
        rows.push(el('button', {
            class: 'btn small', text: '∅ Clear output',
            onclick: () => { back.remove(); this._applyOutput(i, {}); },
        }));
        const back = modal(`Combo ${i} output`, el('div', {
            style: 'display:flex; flex-direction:column; gap:8px',
        }, ...rows), []);
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

    /** Per-combo timing/layer strip (v14 timed slots). Inputs commit ONCE
     * on change — writeSlot re-renders, so no blur double-commit path. */
    timingStrip(i) {
        const s = this.slots[i];
        const commit = (patch) => {
            const before = { ...s, positions: [...s.positions] };
            Object.assign(this.slots[i], patch);
            this.writeSlot(i, before);
        };
        const num = (value, title, placeholder, onCommit) => el('input', {
            type: 'number', min: 0, max: 2000, value: value || '',
            placeholder, title,
            style: 'width:72px',
            onchange: (e) => onCommit(Math.max(0, Math.min(2000, Number(e.target.value) || 0))),
        });
        const layerNames = this.app.profile?.layerNames ?? [];
        const layerCount = Math.max(layerNames.length, 6);
        const layerSel = el('select', {
            title: 'layer this combo fires on',
            onchange: (e) => commit({ layer: Number(e.target.value) }),
        },
            el('option', { value: COMBO_LAYER_ANY, text: 'All layers',
                selected: s.layer === COMBO_LAYER_ANY }),
            ...Array.from({ length: layerCount }, (_, l) => el('option', {
                value: l, text: layerNames[l] ? `${l}: ${layerNames[l]}` : `Layer ${l}`,
                selected: s.layer === l,
            })));
        return el('div', {
            style: 'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px',
        },
            el('span', { class: 'note faint', text: 'timeout' }),
            num(s.timeoutMs, 'candidate window for THIS combo, ms — 0 inherits the global timeout',
                'global', (v) => commit({ timeoutMs: v })),
            el('span', { class: 'note faint', text: 'prior idle' }),
            num(s.priorIdleMs, 'only fire when the last non-modifier tap is at least this old, ms — guards against typing rolls; 0 = off',
                'off', (v) => commit({ priorIdleMs: v })),
            el('span', { class: 'note faint', text: 'layer' }),
            layerSel);
    }

    comboCard(i) {
        const s = this.slots[i];
        const live = !comboSlotV2IsEmpty(s);
        const hasOut = s.action !== COMBO_ACTION.none;
        const tile = el('button', {
            class: 'code',
            style: 'min-width:72px; min-height:44px; font-size:1.05em',
            title: hasOut ? this.outputDesc(s) : 'pick the combo output',
            onclick: () => this.pickOutput(i),
        }, hasOut ? this.outputDesc(s, { cap: true }) : 'output…');

        const fam = this.app.profile?.family ?? 'imprint';
        const customName = zmkSlotName(fam, 'combos', i);
        return el('div', { class: 'card', style: live ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, renameLabel({
                    text: customName || `Combo ${i}`,
                    placeholder: `Combo ${i}`,
                    onCommit: (v) => { zmkSetSlotName(fam, 'combos', i, v); this.render(); },
                }),
                    el('span', {
                        class: 'hint',
                        text: live ? `${s.positions.length} keys → ${this.outputDesc(s)}`
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
                el('div', { style: 'flex:1; overflow-x:auto' }, this.miniBoard(i))),
            this.timed ? this.timingStrip(i) : null);
    }

    render() {
        const { flask } = this.app;
        // Visible = any slot with CONTENT (or an open draft) — not just
        // "live" slots. comboSlotIsEmpty is the firmware's fire rule
        // (usage + ≥2 keys), so filtering on it alone made a combo VANISH
        // the moment you unchecked one key mid-edit (bench 5: "combos
        // delete themselves") — the 1-key slot was still on the device,
        // just unreachable. The card already renders the incomplete state.
        const visible = this.slots
            .map((s, i) => i)
            .filter((i) => {
                const s = this.slots[i];
                return s.positions.length > 0 || s.action !== COMBO_ACTION.none
                    || this.drafts.has(i);
            });
        const used = this.slots.filter((s) => !comboSlotV2IsEmpty(s)).length;

        const controls = card('Runtime combos',
            'press keys together, get a keycode — live-editable, unlike ZMK\'s devicetree combos',
            toggleRow({
                label: 'Combos enabled',
                hint: this.timed
                    ? 'master switch for ALL combos — the keymap\'s combos live in these slots since v14'
                    : 'master switch for RUNTIME combos (slots stay stored) — the '
                    + 'firmware\'s compiled devicetree combos have no off switch',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.combos, V.combosEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            sliderRow({
                label: 'Timeout',
                hint: this.timed
                    ? 'default candidate window, ms — a combo\'s own timeout overrides it'
                    : 'candidate window for all combos, ms',
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
            saveBar(() => flask.save(CH.combos)));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.comboCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No combos yet — Add New Combo, click at least two keys on the mini board, pick an output.',
            }));
    }
}
