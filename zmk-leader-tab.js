// ZMK Leader tab — flask_leader runtime sequences (channel 0x19, proto
// v10). ZMK-line module: press &fled, then a key sequence from the table
// fires a typed output — a usage tap or a flask_macros slot. Sequences are
// ORDERED key positions (unlike combos' unordered sets), so the mini board
// APPENDS on click and the chip row shows the order.
//
// pickTypedOutput (exported; the Gestures tab shares it) wraps the combos
// tab's usage picker with the action choice: keycode / macro / none.

import { el, card, sliderRow, toggleRow, toast } from './ui.js?v=10';
import { CH, V } from './flaskproto.js?v=10';
import { renderKeyboardSVG } from './keymap-tab.js?v=10';
import { pickUsage } from './zmk-combos-tab.js?v=10';
import { usageCap, usageLabel } from './zmk-keycodes.js?v=10';
import { OUTPUT_ACTION, encodeLeaderSlot, decodeLeaderSlot, leaderSlotIsEmpty }
    from './zmk-output-codec.js?v=10';

/** Label for a typed output. */
export function outputLabel(o, { cap = false } = {}) {
    if (o.action === OUTPUT_ACTION.usage) return cap ? usageCap(o.param) : usageLabel(o.param);
    if (o.action === OUTPUT_ACTION.macro) return cap ? `M${o.param}` : `Macro ${o.param}`;
    return cap ? 'output…' : 'none';
}

/** Typed-output picker: choose keycode (→ usage modal) / macro slot / none.
 * onApply({action, param}). Shared by the Leader and Gestures tabs. */
export function pickTypedOutput(title, current, macroSlots, onApply) {
    const back = el('div', {
        style: 'position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:60;'
            + 'display:flex; align-items:center; justify-content:center',
        onclick: (e) => { if (e.target === back) back.remove(); },
    });
    const done = (out) => { back.remove(); onApply(out); };

    const macroRow = el('div', { style: 'display:flex; gap:6px; align-items:center' });
    if (macroSlots > 0) {
        const sel = el('select', {},
            ...Array.from({ length: macroSlots }, (_, i) =>
                el('option', {
                    value: i, text: `Macro ${i}`,
                    selected: current.action === OUTPUT_ACTION.macro && current.param === i,
                })));
        macroRow.append(
            el('button', {
                class: 'btn small', text: 'Play macro',
                onclick: () => done({ action: OUTPUT_ACTION.macro, param: Number(sel.value) }),
            }), sel);
    }

    back.append(el('div', { class: 'card', style: 'min-width:260px' },
        el('div', { class: 'row' }, el('b', { text: title })),
        el('div', { style: 'display:flex; flex-direction:column; gap:8px; margin-top:6px' },
            el('button', {
                class: 'btn small primary', text: current.action === OUTPUT_ACTION.usage
                    ? `Keycode… (now ${usageLabel(current.param)})` : 'Keycode…',
                onclick: () => {
                    back.remove();
                    pickUsage(title, current.action === OUTPUT_ACTION.usage ? current.param : 0,
                        (usage) => onApply(usage
                            ? { action: OUTPUT_ACTION.usage, param: usage }
                            : { action: OUTPUT_ACTION.none, param: 0 }));
                },
            }),
            macroRow,
            el('button', {
                class: 'btn small', text: 'None (empty)',
                onclick: () => done({ action: OUTPUT_ACTION.none, param: 0 }),
            }),
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => back.remove() }))));
    document.body.append(back);
}

export class ZmkLeaderTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.drafts = new Set();
    }

    async load() {
        const { flask } = this.app;
        this.enabled = await flask.getU16(CH.leader, V.leaderEnabled);
        this.timeout = await flask.getU16(CH.leader, V.leaderTimeout);
        this.slotCount = await flask.getU16(CH.leader, V.leaderSlotCount);
        this.maxKeys = await flask.getU16(CH.leader, V.leaderKeys) || 8;
        this.macroSlots = this.app.caps.macros
            ? await flask.getU16(CH.macros, V.macrosSlotCount) : 0;
        this.slots = [];
        for (let i = 0; i < this.slotCount; i++) {
            const r = await flask.getBytes(CH.leader, V.leaderSlot, [i]);
            this.slots.push(decodeLeaderSlot(r, this.maxKeys));
        }
        this.render();
    }

    async writeSlot(i) {
        try {
            const r = await this.app.flask.setBytes(CH.leader, V.leaderSlot,
                encodeLeaderSlot(i, this.slots[i], this.maxKeys));
            this.slots[i] = decodeLeaderSlot(r, this.maxKeys);
        } catch (e) {
            toast(`Leader write failed: ${e.message}`, true);
        }
        this.render();
    }

    addSequence() {
        const i = this.slots.findIndex((s, idx) =>
            leaderSlotIsEmpty(s) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} leader slots are in use`, true); return; }
        this.drafts.add(i);
        this.render();
    }

    async clearSlot(i) {
        this.slots[i] = { seq: i, positions: [], action: 0, param: 0 };
        this.drafts.delete(i);
        await this.writeSlot(i);
    }

    /** Sequences are ordered: board clicks APPEND (up to maxKeys); the chip
     * row removes. */
    appendPosition(i, pos) {
        const s = this.slots[i];
        if (s.positions.length >= this.maxKeys) {
            toast(`Sequences take up to ${this.maxKeys} keys`, true);
            return;
        }
        s.positions.push(pos);
        this.writeSlot(i);
    }

    removePosition(i, at) {
        this.slots[i].positions.splice(at, 1);
        this.writeSlot(i);
    }

    pickOutput(i) {
        const s = this.slots[i];
        pickTypedOutput(`Sequence ${i} output`, s, this.macroSlots, (out) => {
            s.action = out.action;
            s.param = out.param;
            this.writeSlot(i);
        });
    }

    miniBoard(i) {
        const geom = this.app.profile?.keys;
        if (!geom?.length) {
            return el('div', { class: 'note faint',
                text: 'Open the Keymap tab once to load board geometry.' });
        }
        const pressed = new Set(this.slots[i].positions.map((p) => `0,${p}`));
        return renderKeyboardSVG({
            profile: {
                keys: geom, encoderKeys: [],
                labelFor: () => '', hoverFor: () => 'click to append to the sequence',
                keyName: (k) => String(k.pos),
            },
            scale: 0.42,
            keycodeAt: () => null,
            pressed,
            selected: null,
            onSelect: (sel) => this.appendPosition(i, sel.col),
        });
    }

    seqCard(i) {
        const s = this.slots[i];
        const live = !leaderSlotIsEmpty(s);
        const chips = el('div', { style: 'display:flex; gap:4px; flex-wrap:wrap; align-items:center' },
            s.positions.length
                ? s.positions.map((p, at) => el('button', {
                    class: 'btn small primary', text: `${at + 1}· pos ${p} ✕`,
                    title: 'remove this step',
                    onclick: () => this.removePosition(i, at),
                }))
                : el('span', { class: 'note faint', text: 'click keys below, in order' }));

        return el('div', { class: 'card', style: live ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, el('b', { text: `Sequence ${i}` }),
                    el('span', {
                        class: 'hint',
                        text: live ? `${s.positions.length} keys → ${outputLabel(s)}`
                            : 'incomplete — needs ≥ 1 key and an output',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: '🗑', title: 'empty this slot',
                    onclick: () => this.clearSlot(i),
                })),
            chips,
            el('div', { style: 'display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; margin-top:6px' },
                el('div', {},
                    el('div', { class: 'note faint', text: 'output' }),
                    el('button', {
                        class: 'code',
                        style: 'min-width:72px; min-height:44px; font-size:1.05em',
                        title: 'pick the sequence output',
                        onclick: () => this.pickOutput(i),
                    }, outputLabel(s, { cap: true }))),
                el('div', { style: 'flex:1; overflow-x:auto' }, this.miniBoard(i))));
    }

    render() {
        const { flask } = this.app;
        const visible = this.slots.map((s, i) => i)
            .filter((i) => !leaderSlotIsEmpty(this.slots[i]) || this.drafts.has(i));
        const used = this.slots.filter((s) => !leaderSlotIsEmpty(s)).length;

        const controls = card('Runtime leader',
            'press the Flask Leader key, then a sequence — live-editable (urob\'s compiled sequences keep their own key)',
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
                el('span', { class: 'note faint', text: `${used}/${this.slotCount} slots used` }),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Save to keyboard',
                    onclick: async () => {
                        try { await flask.save(CH.leader); toast('Leader table saved'); }
                        catch (e) { toast(`Save failed: ${e.message}`, true); }
                    },
                })),
            el('div', { class: 'note faint',
                text: 'Bind the "Flask Leader" behavior to a key in the Keymap tab to trigger these. Edits are live; Save persists across power-off.' }));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.seqCard(i)));
    }
}
