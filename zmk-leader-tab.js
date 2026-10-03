// ZMK Leader tab — flask_leader runtime sequences (channel 0x19, proto
// v10). ZMK-line module: press &fled, then a key sequence from the table
// fires a typed output — a usage tap or a flask_macros slot. Sequences are
// ORDERED key positions (unlike combos' unordered sets): pick them in order
// on the main board; the row shows the order. Outputs use the shared
// BindingPicker (zmk.typedOutput).

import { el, card, sliderRow, toggleRow, toast, reloadBar } from './ui.js?v=66';
import { CH, V } from './flaskproto.js?v=66';
import { ZMK_LEADER_FN_PRESET } from './zmk.js?v=66';
import { board } from './board.js?v=66';
import { kpParam } from './zmk-keycodes.js?v=66';
import { OUTPUT_ACTION, encodeLeaderSlot, decodeLeaderSlot, leaderSlotIsEmpty }
    from './zmk-output-codec.js?v=66';
import { blurClicks, pickOutput, outText, outCell, onSlotsChanged, dim } from './zmk-behaviour-common.js?v=66';

export class ZmkLeaderTab {
    constructor(app) {
        this.app = app;
        this.root = blurClicks(el('div'));
        this.drafts = new Set();
        onSlotsChanged(CH.leader, this, () => { if (this.slots && this.editing == null) this.load().catch(() => {}); });
    }

    async load() {
        const { flask, hid } = this.app;
        // HUD poll backs off for the bulk slot read (see combos tab note).
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.leader, V.leaderEnabled);
            this.timeout = await flask.getU16(CH.leader, V.leaderTimeout);
            this.slotCount = await dim(this.app, CH.leader, V.leaderSlotCount);
            this.maxKeys = await dim(this.app, CH.leader, V.leaderKeys) || 8;
            this.slots = [];
            for (let i = 0; i < this.slotCount; i++) {
                const r = await flask.getBytes(CH.leader, V.leaderSlot, [i], 1);
                this.slots.push(decodeLeaderSlot(r, this.maxKeys));
            }
        } finally {
            hid?.resume?.();
        }
        this.bar ??= reloadBar(CH.leader, {
            label: 'Leader',
            save: () => this.app.flask.save(CH.leader),
            reload: () => this.load(),
        });
        this.render();
    }

    async writeSlot(i, before = null) {
        try {
            const r = await this.app.flask.setBytes(CH.leader, V.leaderSlot,
                encodeLeaderSlot(i, this.slots[i], this.maxKeys), 1);
            this.slots[i] = decodeLeaderSlot(r, this.maxKeys);
            this.bar?.markEdited();
        } catch (e) {
            // Revert the optimistic edit: the card must show what the device holds.
            if (before) this.slots[i] = before;
            toast(`Leader write failed: ${e.message}`, true);
        }
        this.render();
    }

    /** Apply `patch` to slot i and write it; a refused write restores the old slot. */
    edit(i, patch) {
        const before = { ...this.slots[i], positions: [...this.slots[i].positions] };
        Object.assign(this.slots[i], patch);
        return this.writeSlot(i, before);
    }

    addSequence() {
        const i = this.slots.findIndex((s, idx) =>
            leaderSlotIsEmpty(s) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} leader slots are in use`, true); return; }
        this.slots[i] = { seq: i, positions: [], action: 0, param: 0 };
        this.drafts.add(i);
        this.render();
        this.startPick(i);
    }

    /** F-key preset (AJ's 2026-07-12 spec): leader→1..9 = F1-F9, leader→0
     * = F10, leader→F→1..9 = F11-F19, leader→F→0 = F20. Fills FREE slots
     * only — existing sequences stay untouched. */
    async addFnPreset() {
        const fam = this.app.profile?.family ?? 'imprint';
        const geo = ZMK_LEADER_FN_PRESET[fam];
        if (!geo) { toast('No F-key preset geometry for this board', true); return; }

        // F1-F12 = usage 0x3A+, F13-F24 = 0x68+ (HID keyboard page).
        const fUsage = (n) => kpParam(n <= 12 ? 0x3A + n - 1 : 0x68 + n - 13);
        const wanted = [];
        for (let n = 1; n <= 10; n++) {
            wanted.push({ positions: [geo.digits[n - 1]], usage: fUsage(n) });
        }
        for (let n = 11; n <= 20; n++) {
            wanted.push({ positions: [geo.fKey, geo.digits[n - 11]], usage: fUsage(n) });
        }

        // Skip pairs whose exact sequence already exists; place the rest in
        // free slots.
        const seqKey = (p) => p.join(',');
        const existing = new Set(this.slots
            .filter((s) => !leaderSlotIsEmpty(s)).map((s) => seqKey(s.positions)));
        const todo = wanted.filter((w) => !existing.has(seqKey(w.positions)));
        const free = this.slots.map((s, i) => i)
            .filter((i) => leaderSlotIsEmpty(this.slots[i]) && !this.drafts.has(i));
        if (todo.length === 0) { toast('F-key sequences already present'); return; }
        if (free.length < todo.length) {
            toast(`Needs ${todo.length} free slots, only ${free.length} left`, true);
            return;
        }
        const { hid } = this.app;
        hid?.pause?.();
        try {
            for (let k = 0; k < todo.length; k++) {
                const i = free[k];
                this.slots[i] = { seq: i, positions: [...todo[k].positions],
                    action: OUTPUT_ACTION.usage, param: todo[k].usage };
                const r = await this.app.flask.setBytes(CH.leader, V.leaderSlot,
                    encodeLeaderSlot(i, this.slots[i], this.maxKeys), 1);
                this.slots[i] = decodeLeaderSlot(r, this.maxKeys);
            }
            this.bar?.markEdited();
            toast(`${todo.length} F-key sequences added`);
        } catch (e) {
            toast(`F-key preset failed: ${e.message}`, true);
        } finally {
            hid?.resume?.();
        }
        this.render();
    }

    async clearSlot(i) {
        const before = this.slots[i];
        this.slots[i] = { seq: i, positions: [], action: 0, param: 0 };
        this.drafts.delete(i);
        await this.writeSlot(i, before);
    }

    // ---- position picking: in order, on the main board ----

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
        this._stopPick = board.pickPositions({
            initial: [...this.slots[i].positions], max: this.maxKeys, allowRepeat: true,
            label: `Click the keys of Sequence ${i} in order`,
            onChange: (ps) => { this.edit(i, { positions: ps }); },
        });
        // Leaving the tab ends pick mode (else a Keys-tab click edits this).
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
        const live = this.editing === i && document.querySelector('.bd-banner');
        if (live) this.stopPick(); else this.startPick(i);
        this.render();
    }

    removePosition(i, at) {
        // The board keeps its own copy while picking: resync it.
        this.edit(i, { positions: this.slots[i].positions.filter((_, k) => k !== at) })
            .then(() => { if (this.editing === i) this.startPick(i); });
    }

    pickOutputFor(i) {
        const s = this.slots[i];
        pickOutput({
            app: this.app, surface: 'zmk.typedOutput', title: `Sequence ${i} output`, value: s,
            onPick: (v) => this.edit(i, { action: v.action, param: v.action ? v.param1 : 0 }),
        });
    }

    seqCard(i) {
        const s = this.slots[i];
        const live = !leaderSlotIsEmpty(s);
        const out = outText(s, 'zmk.typedOutput');
        const picking = this.editing === i;
        const chips = el('div', { style: 'display:flex; gap:4px; flex-wrap:wrap; align-items:center' },
            s.positions.length
                ? s.positions.map((p, at) => el('button', {
                    class: 'btn small primary', text: `${at + 1}· pos ${p} ✕`,
                    title: 'remove this key from the sequence',
                    onclick: () => this.removePosition(i, at),
                }))
                : el('span', { class: 'note faint', text: 'no keys yet' }));

        return el('div', { class: 'card', 'data-seq': i, style: live ? '' : 'opacity:0.85' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, el('b', {
                    text: s.positions.length ? `${s.positions.join(' → ')} → ${out || '…'}` : `Sequence ${i}`,
                }),
                    el('span', {
                        class: 'hint',
                        text: live ? `Sequence ${i}` : `Sequence ${i} · incomplete: needs 1 or more keys and an output`,
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Delete', title: 'empty this slot',
                    onclick: () => { if (this.editing === i) this.stopPick(); this.clearSlot(i); },
                })),
            chips,
            el('div', { style: 'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px' },
                board.adapter ? el('button', {
                    class: 'btn small' + (picking ? ' primary' : ''),
                    text: picking ? 'Done picking keys' : (s.positions.length ? 'Change keys' : 'Pick keys'),
                    onclick: () => this.togglePick(i),
                }) : this.positionFallback(i),
                el('button', {
                    class: 'btn small', 'data-act': 'output',
                    onclick: () => this.pickOutputFor(i),
                }, out ? ['Output: ', outCell(s, 'zmk.typedOutput')] : 'Choose output…')));
    }

    /** Numeric fallback when no board is bound. */
    positionFallback(i) {
        const input = el('input', { type: 'number', min: 0, max: 254, placeholder: 'pos #', style: 'width:80px' });
        return el('span', { style: 'display:inline-flex; gap:4px' }, input, el('button', {
            class: 'btn small', text: 'Add key',
            onclick: () => {
                const p = Number(input.value);
                if (!Number.isInteger(p) || p < 0 || p > 254) return;
                if (this.slots[i].positions.length >= this.maxKeys) { toast(`Sequences take up to ${this.maxKeys} keys`, true); return; }
                this.edit(i, { positions: [...this.slots[i].positions, p] });
            },
        }));
    }

    render() {
        const { flask } = this.app;
        // Content-based visibility, not the fire rule — filtering on
        // leaderSlotIsEmpty (output + ≥1 position) made a sequence VANISH
        // mid-edit when its positions were cleared before a new output was
        // picked (same class as the bench-5 combos "delete themselves").
        const visible = this.slots.map((s, i) => i)
            .filter((i) => {
                const s = this.slots[i];
                return s.positions.length > 0 || s.action !== OUTPUT_ACTION.none
                    || this.drafts.has(i);
            });
        const used = this.slots.filter((s) => !leaderSlotIsEmpty(s)).length;

        const controls = card('Runtime leader',
            'press the Flask Leader key, then a sequence; live-editable',
            toggleRow({
                label: 'Leader enabled',
                hint: 'master switch; sequences stay stored while off',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.leader, V.leaderEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            sliderRow({
                label: 'Timeout',
                hint: 'per-key wait before the capture gives up, ms',
                min: 100, max: 5000, step: 50, value: this.timeout,
                format: (v) => `${v} ms`,
                onChange: async (val) => {
                    this.timeout = await flask.setU16(CH.leader, V.leaderTimeout, val);
                    return this.timeout;
                },
            }),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn small primary', text: '＋ New sequence',
                    onclick: () => this.addSequence(),
                }),
                // Only boards with preset geometry (Imprint) get the button.
                ZMK_LEADER_FN_PRESET[this.app.profile?.family ?? 'imprint'] ? el('button', {
                    class: 'btn small', text: 'F-keys preset',
                    title: 'leader→1..9 = F1-F9, leader→0 = F10, leader→F→1..9 = F11-F19, leader→F→0 = F20',
                    onclick: () => this.addFnPreset(),
                }) : null,
                el('span', { class: 'note faint', text: `${used}/${this.slotCount} slots used` }),
            ),
            this.bar,
            el('div', { class: 'note faint',
                text: 'Bind "Flask Leader" to a key in the Keys picker (Run) to trigger these.' }),
            el('div', { class: 'note faint', 'data-note': 'compiled-leader',
                text: 'Your keymap\'s compiled leader (urob &leader) is separate and keeps its own key. Edit it in firmware.' }));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.seqCard(i)));
    }
}
