// ZMK Combos tab — flask_combos runtime combos (channel 0x24, proto v7).
// Native frame (spec 3.4): "+ New combo" makes a draft row and puts the main
// board in pick mode ("Pick keys for Combo N"); the output opens the shared
// BindingPicker sheet; window / idle / layer stay as row fields. Edits are
// LIVE; the top bar's Save persists (reloadBar -> saveState).
//
// Since v14 the keymap's devicetree combos ARE runtime slots (compiled
// defaults), so they all list and edit here. Two live combos on the same
// position set freeze the board on press (bench 2026-10-01: R+F, positions
// 3+13, is slot 7 "ent" on the Totem), so a duplicate is refused.
//
// Also hosts the "Hold timing" card (flask_holdtap, proto 17).

import { el, card, sliderRow, toggleRow, toast, renameLabel, reloadBar } from './ui.js?v=71';
import { zmkSlotName, zmkSetSlotName } from './zmk.js?v=71';
import { CH, V } from './flaskproto.js?v=71';
import { board, capPartsOf, htPartsOf } from './board.js?v=71';
import { saveState } from './save-state.js?v=71';
import {
    COMBO_POS_NONE, COMBO_MAX_KEYS, COMBO_ACTION, COMBO_LAYER_ANY,
    decodeComboSlot, encodeComboSlot,
    decodeComboSlotV2, encodeComboSlotV2, comboSlotV2IsEmpty,
    decodeComboSlotV3, encodeComboSlotV3,
    comboSlotToTyped, comboTypedToLegacy, findDuplicateCombo, comboPosKey,
} from './zmk-combos-codec.js?v=71';
import { TOTEM_DEFAULT } from './zmk-totem-default.js?v=71';
import { zmkLayers, layerLabel } from './zmk-keycodes.js?v=71';
import { blurClicks, pickOutput, outText, outCell, installSlotSummary, onSlotsChanged, dim } from './zmk-behaviour-common.js?v=71';

/** A key position's legend on the BASE layer ("Q", "Esc", a tap-hold's tap),
 * or the raw index when the board has no keymap bound yet. */
export function legendOf(pos) {
    const a = board.adapter;
    try {
        const sel = a?.selOf(pos);
        const b = sel && a.bindingAt(0, sel);
        if (!b) return String(pos);
        const ht = htPartsOf(b, a.profile);
        if (ht) return ht.tap;
        const { top, main } = capPartsOf(b, a.profile);
        return (top && main ? `${top} ${main}` : main || top) || String(pos);
    } catch { return String(pos); }
}

let activeTabAbort = null;

const posText = (ps) => ps.map(legendOf).join(' + ');

export class ZmkCombosTab {
    constructor(app) {
        this.app = app;
        this.root = blurClicks(el('div'));
        this.drafts = new Set(); // empty slots kept visible while editing
        this.warn = new Map();   // slot -> refusal text, shown on its row
        installSlotSummary(app);
        // Legends follow base-layer edits. Not mid-pick: render() there would
        // fight the board's pick banner.
        // A rebuilt tab drops its predecessor's listener (it grew by one per rebuild).
        activeTabAbort?.abort();
        activeTabAbort = new AbortController();
        board.addEventListener('change', () => {
            if (this.root.isConnected && this.slots && this.editing == null) this.render();
        }, { signal: activeTabAbort.signal });
        onSlotsChanged(CH.combos, this, () => { if (this.slots && this.editing == null) this.load().catch(() => {}); });
    }

    async load() {
        const { flask, hid } = this.app;
        // Back the HUD poll off for the whole bulk read (64 slot frames) —
        // interleaved polling stretches the burst and multiplies timeout
        // exposure (bench 2026-07-11 congestion round).
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.combos, V.combosEnabled);
            this.slotCount = await dim(this.app, CH.combos, V.combosSlotCount);
            this.timeout = await flask.getU16(CH.combos, V.combosTimeout);
            // Keys per slot sizes the wire frame — RO value on v9+; v7/v8
            // firmware answers unhandled (0) and is fixed at 4.
            this.maxKeys = (this.app.caps?.combosKeys
                && await dim(this.app, CH.combos, V.combosKeys)) || COMBO_MAX_KEYS;
            // v12 firmware speaks typed slots (usage-hold / macro /
            // behavior); older firmware keeps the usage-only frame, bridged
            // into the same typed shape so the tab has ONE internal model.
            this.typed = !!this.app.caps?.combosTyped;
            // v14 timed slots: per-combo timeout / prior-idle / layer (the
            // imported devicetree combos' knobs) ride the SLOT_V3 frame.
            this.timed = !!this.app.caps?.combosTimed;
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
        this.bar ??= reloadBar(CH.combos, {
            label: 'Combos',
            save: () => this.app.flask.save(CH.combos),
            reload: () => this.load(),
        });
        this.render();
    }

    /** Compiled devicetree combos that are NOT runtime slots (pre-v14
     * firmware). On v14+ they are slots, so the slot scan already covers
     * them and a deleted default must stay re-addable. */
    dtDefaults() {
        return !this.timed && this.app.profile?.family === 'totem' ? TOTEM_DEFAULT.combos : [];
    }

    /** Output text for a slot. A compiled devicetree macro has no Studio
     * name ("Unnamed behavior #47"), so say what it is from the keymap. */
    outLabel(i) {
        const s = this.slots[i];
        const t = outText(s, 'zmk.comboOutput');
        if (!/^Unnamed behavior/.test(t)) return t;
        const dt = this.app.profile?.family === 'totem' ? TOTEM_DEFAULT.combos[i] : null;
        return dt && comboPosKey(dt.positions) === comboPosKey(s.positions)
            ? `${dt.name.replaceAll('_', ' ')} (compiled)` : 'Compiled behavior';
    }

    duplicateText(dup) {
        if (dup.kind === 'default') return `the keymap's compiled combo ${dup.index}`;
        const s = this.slots[dup.index];
        const out = this.outLabel(dup.index);
        return `Combo ${dup.index} (${posText(s.positions)}${out ? ` → ${out}` : ''})`;
    }

    /** Refusal text when `positions` would duplicate a live combo, else ''. */
    refusal(i, positions) {
        const dup = findDuplicateCombo(this.slots, i, positions, this.dtDefaults());
        return dup ? `Same keys as ${this.duplicateText(dup)}. Two combos on one key set freeze the board, so this one was not written.` : '';
    }

    markUnsaved() {
        if (this.bar) this.bar.markEdited();
        else saveState.markDirty(CH.combos, 'Combos', () => this.app.flask.save(CH.combos));
    }

    async writeSlot(i, before = null) {
        // Central guard: every path that makes a slot live routes here.
        const why = !comboSlotV2IsEmpty(this.slots[i]) && this.refusal(i, this.slots[i].positions);
        if (why) {
            if (before) this.slots[i] = before;
            this.warn.set(i, why);
            toast(why, true);
            this.render();
            return;
        }
        // A combo needs 2+ keys. With fewer (a new draft mid-pick, or a combo
        // being re-picked) the device gets an EMPTY slot and the row keeps
        // its local draft, so an abandoned draft never leaves a 1-key slot.
        const local = this.slots[i];
        const wire = local.positions.length < 2 ? this.emptySlot(i) : local;
        // The firmware zeroes window / idle / layer of a slot with no output; keep
        // what the user set for the write that first gives it one (WB-07).
        const adopt = (echo) => {
            if (wire !== local) return;
            const keep = local.action === COMBO_ACTION.none && this.timed
                ? { timeoutMs: local.timeoutMs, priorIdleMs: local.priorIdleMs, layer: local.layer } : {};
            this.slots[i] = { ...echo, ...keep };
        };
        try {
            if (this.timed) {
                const r = await this.app.flask.setBytes(CH.combos, V.combosSlotV3,
                    encodeComboSlotV3(i, wire, this.maxKeys), 1);
                adopt(decodeComboSlotV3(r, this.maxKeys)); // adopt the echo
            } else if (this.typed) {
                const r = await this.app.flask.setBytes(CH.combos, V.combosSlotV2,
                    encodeComboSlotV2(i, wire, this.maxKeys), 1);
                adopt(decodeComboSlotV2(r, this.maxKeys)); // adopt the echo
            } else {
                const r = await this.app.flask.setBytes(CH.combos, V.combosSlot,
                    encodeComboSlot(i, comboTypedToLegacy(wire), this.maxKeys), 1);
                adopt(comboSlotToTyped(decodeComboSlot(r, this.maxKeys)));
            }
            this.warn.delete(i);
            this.markUnsaved();
        } catch (e) {
            // Revert the optimistic local edit — keeping it made the UI lie
            // about what the device holds (bench 2026-07-11, timeouts).
            if (before) this.slots[i] = before;
            toast(`Combo write failed: ${e.message}`, true);
        }
        this.render();
    }

    emptySlot(i) {
        return { slot: i, positions: [], action: COMBO_ACTION.none,
            behaviorId: 0, param1: 0, param2: 0,
            timeoutMs: 0, priorIdleMs: 0, layer: COMBO_LAYER_ANY };
    }

    addCombo() {
        const i = this.slots.findIndex((s, idx) =>
            comboSlotV2IsEmpty(s) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} combo slots are in use`, true); return; }
        // An EMPTY slot can still carry position junk (zero-filled boot
        // tables read back as pos 0 x maxKeys). A draft starts clean; the
        // first write persists the real content.
        this.slots[i] = this.emptySlot(i);
        this.drafts.add(i);
        this.render();
        this.startPick(i);
        this.reveal(i);
    }

    /** Scroll a card into view (the palette body scrolls on its own) and focus it. */
    reveal(i) {
        const card = this.root.querySelector(`[data-combo="${i}"]`);
        if (!card) return;
        card.setAttribute('tabindex', '-1');
        card.classList.add('x-new');
        card.scrollIntoView({ block: 'start' });
        card.focus({ preventScroll: true });
        setTimeout(() => card.classList.remove('x-new'), 1600);
    }

    async clearSlot(i) {
        if (this.editing === i) this.stopPick();
        const before = { ...this.slots[i], positions: [...this.slots[i].positions] };
        this.slots[i] = this.emptySlot(i);
        this.drafts.delete(i);
        this.warn.delete(i);
        zmkSetSlotName(this.app.profile?.family ?? 'imprint', 'combos', i, '');   // the name must not outlive the slot (WB-12)
        await this.writeSlot(i, before);
    }

    // ---- position picking: on the main board ----

    stopPick() {
        this._stopPick?.();
        this._stopPick = null;
        this._pickWatch?.disconnect();
        this._pickWatch = null;
        this.editing = null;
    }

    startPick(i) {
        this.stopPick();
        if (!board.adapter) { this.render(); return; }   // numeric fallback on the row
        this.editing = i;
        const start = (initial) => {
            this._stopPick = board.pickPositions({
                initial, max: this.maxKeys, label: `Pick keys for Combo ${i}`,
                onChange: (ps) => this.setPositions(i, ps, start),
            });
        };
        start([...this.slots[i].positions]);
        // Leaving the tab must end pick mode, or a click on the Keys tab
        // would edit this combo instead of the key.
        const panel = this.root.closest('.panel');
        if (panel) {
            this._pickWatch = new MutationObserver(() => {
                if (!panel.classList.contains('active')) { this.stopPick(); this.render(); }
            });
            this._pickWatch.observe(panel, { attributes: true, attributeFilter: ['class'] });
        }
        this.render();
    }

    togglePick(i) {
        // The board's own Done button ends pick mode without telling us.
        const live = this.editing === i && document.querySelector('.bd-banner');
        if (live) this.stopPick(); else this.startPick(i);
        this.render();
    }

    /** Positions came from the board (or the numeric fallback). `restart`
     * re-enters pick mode with the old set when the new one is refused. */
    setPositions(i, positions, restart) {
        const s = this.slots[i];
        const before = { ...s, positions: [...s.positions] };
        const why = this.refusal(i, positions);
        if (why) {
            this.warn.set(i, why);
            toast(why, true);
            restart?.([...before.positions]);
            this.render();
            return;
        }
        s.positions = positions.slice(0, this.maxKeys);
        this.writeSlot(i, before);
    }

    // ---- output picker ----

    _applyOutput(i, v) {
        const before = { ...this.slots[i], positions: [...this.slots[i].positions] };
        Object.assign(this.slots[i], {
            action: COMBO_ACTION.none, behaviorId: 0, param1: 0, param2: 0,
        }, v.action ? v : {});
        this.writeSlot(i, before);
    }

    pickOutputFor(i) {
        pickOutput({
            app: this.app,
            // pre-v12 firmware stores a usage only
            surface: this.typed ? 'zmk.comboOutput' : 'zmk.macroKey',
            title: `Combo ${i} output`, value: this.slots[i],
            onPick: (v) => this._applyOutput(i, v),
        });
    }

    // ---- rows ----

    /** Numeric fallback when no board is bound (Keymap tab not loaded). */
    positionFallback(i) {
        const s = this.slots[i];
        const posInput = el('input', {
            type: 'number', min: 0, max: 254, placeholder: 'position #', style: 'width:100px',
        });
        return el('div', { style: 'display:flex; gap:4px; align-items:center; flex-wrap:wrap' },
            ...s.positions.map((p) => el('button', {
                class: 'btn small primary', text: `${p} ✕`,
                onclick: () => this.setPositions(i, s.positions.filter((x) => x !== p)),
            })),
            posInput,
            el('button', {
                class: 'btn small', text: 'Add',
                onclick: () => {
                    const p = Number(posInput.value);
                    if (!Number.isInteger(p) || p < 0 || p >= COMBO_POS_NONE || s.positions.includes(p)) return;
                    if (s.positions.length >= this.maxKeys) { toast(`Combos take up to ${this.maxKeys} keys`, true); return; }
                    this.setPositions(i, [...s.positions, p]);
                },
            }));
    }

    /** Per-combo timing/layer fields (v14 timed slots). */
    timingStrip(i) {
        const s = this.slots[i];
        const commit = (patch) => {
            const before = { ...s, positions: [...s.positions] };
            Object.assign(this.slots[i], patch);
            this.writeSlot(i, before);
        };
        const num = (value, title, placeholder, onCommit) => el('input', {
            type: 'number', min: 0, max: 2000, value: value || '',
            placeholder, title, 'aria-label': title, style: 'width:72px',
            onchange: (e) => onCommit(Math.max(0, Math.min(2000, Number(e.target.value) || 0))),
        });
        // The firmware compares the combo's layer to the layer ID (stable across
        // reorders), so the option VALUE is the id; the label shows the rail's
        // index. Without a loaded keymap: ids = indexes.
        const known = zmkLayers();
        const layerOpts = known.length
            ? known.map((l, i) => ({ id: l.id, text: `${i}: ${layerLabel(l.name, i)}` }))
            : Array.from({ length: Math.max((this.app.profile?.layerNames ?? []).length, 6) }, (_, l) => ({
                id: l, text: this.app.profile?.layerNames?.[l] ? `${l}: ${this.app.profile.layerNames[l]}` : `Layer ${l}` }));
        if (s.layer !== COMBO_LAYER_ANY && !layerOpts.some((o) => o.id === s.layer)) {
            layerOpts.push({ id: s.layer, text: `Layer#${s.layer}` });
        }
        const layerSel = el('select', {
            title: 'layer this combo fires on', 'aria-label': 'Only on layer',
            onchange: (e) => commit({ layer: Number(e.target.value) }),
        },
            el('option', { value: COMBO_LAYER_ANY, text: 'All layers', selected: s.layer === COMBO_LAYER_ANY }),
            ...layerOpts.map((o) => el('option', { value: o.id, text: o.text, selected: s.layer === o.id })));
        return el('div', {
            style: 'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px',
        },
            el('span', { class: 'note faint', text: 'Window (ms)' }),
            num(s.timeoutMs, 'candidate window for THIS combo, ms; 0 inherits the global window',
                'global', (v) => commit({ timeoutMs: v })),
            el('span', { class: 'note faint', text: 'Needs idle before (ms)' }),
            num(s.priorIdleMs, 'only fire when the last non-modifier tap is at least this old, ms; guards against typing rolls; 0 = off',
                'off', (v) => commit({ priorIdleMs: v })),
            el('span', { class: 'note faint', text: 'Only on layer' }),
            layerSel);
    }

    comboCard(i) {
        const s = this.slots[i];
        const live = !comboSlotV2IsEmpty(s);
        const out = this.outLabel(i);
        const auto = s.positions.length
            ? `${posText(s.positions)} → ${out || '…'}` : `New combo`;
        const fam = this.app.profile?.family ?? 'imprint';
        const custom = zmkSlotName(fam, 'combos', i);
        const picking = this.editing === i;
        const warn = this.warn.get(i);

        return el('div', { class: 'card', 'data-combo': i, style: live ? '' : 'opacity:0.85' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, renameLabel({
                    text: custom || auto, placeholder: auto,
                    onCommit: (v) => { zmkSetSlotName(fam, 'combos', i, v); this.render(); },
                }),
                    el('span', {
                        class: 'hint',
                        text: live ? `Combo ${i}` : `Combo ${i} · incomplete: needs 2 or more keys and an output`,
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Delete', title: 'empty this combo slot',
                    onclick: () => this.clearSlot(i),
                })),
            el('div', { style: 'display:flex; gap:10px; align-items:center; flex-wrap:wrap' },
                board.adapter
                    ? el('button', {
                        class: 'btn small' + (picking ? ' primary' : ''), 'data-act': 'keys',
                        text: picking ? 'Done picking keys' : (s.positions.length ? 'Change keys' : 'Pick keys'),
                        title: 'toggle keys on the main board',
                        onclick: () => this.togglePick(i),
                    })
                    : this.positionFallback(i),
                el('button', {
                    class: 'btn small', 'data-act': 'output',
                    onclick: () => this.pickOutputFor(i),
                }, out ? ['Output: ', outCell(s, 'zmk.comboOutput', out)] : 'Choose output…')),
            warn ? el('div', { class: 'note', role: 'alert', 'data-warn': '', text: warn }) : null,
            this.timed ? this.timingStrip(i) : null);
    }

    render() {
        const { flask } = this.app;
        // Visible = any slot with CONTENT (or an open draft), not just live
        // ones: filtering on the fire rule made a combo VANISH the moment
        // you unpicked one key mid-edit (bench 5: "combos delete themselves").
        const visible = this.slots
            .map((s, i) => i)
            .filter((i) => {
                const s = this.slots[i];
                return s.positions.length > 0 || s.action !== COMBO_ACTION.none
                    || this.drafts.has(i);
            });
        const used = this.slots.filter((s) => !comboSlotV2IsEmpty(s)).length;

        const controls = card('Combos',
            'press keys together, get an output; live-editable',
            toggleRow({
                label: 'Combos enabled',
                hint: this.timed
                    ? 'master switch for ALL combos; the keymap\'s combos live in these slots since v14'
                    : 'master switch for RUNTIME combos (slots stay stored); the '
                    + 'firmware\'s compiled devicetree combos have no off switch',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.combos, V.combosEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            sliderRow({
                label: 'Window',
                hint: this.timed
                    ? 'default candidate window, ms; a combo\'s own window overrides it'
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
                    class: 'btn primary', text: '＋ New combo', 'data-act': 'new',
                    onclick: () => this.addCombo(),
                }),
                el('span', { class: 'note faint', text: `${used} of ${this.slotCount} slots in use` })),
            this.bar);

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.comboCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No combos yet. ＋ New combo, then click at least two keys on the board and choose an output.',
            }));
    }
}
