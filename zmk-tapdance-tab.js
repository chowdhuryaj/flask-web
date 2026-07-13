// ZMK Tap Dance tab — flask_tapdance runtime dances (channel 0x28, proto
// v14). ZMK's native tap-dance is one compiled DT node per dance; these
// are live-editable slots with the SAME engine semantics: N taps inside
// the tapping term fire the Nth output (press-and-hold keeps it held; an
// interrupting key resolves early). Assign a slot to a key as the "Tap
// Dance" behavior (&ftd) in the Keymap tab — the wizard offers that step.
//
// Outputs are typed like combos v12 (keycode / macro / behavior). Per-slot
// tapping term ("behavior modification settings" — timing, AJ 2026-07-12);
// term 0 = the firmware default 200 ms.

import { el, card, toggleRow, modal, toast } from './ui.js?v=13';
import { zmkSlotName, zmkSetSlotName } from './zmk.js?v=13';
import { CH, V } from './flaskproto.js?v=13';
import { pickUsage } from './zmk-combos-tab.js?v=13';
import { usageCap, usageLabel, zmkBehaviors } from './zmk-keycodes.js?v=13';
import { buildZmkPicker } from './zmk-keymap-tab.js?v=13';
import {
    TD_ACTION, decodeTdStep, encodeTdStep, decodeTdCfg, encodeTdCfg,
    tdDanceLength, tdSlotIsEmpty,
} from './zmk-tapdance-codec.js?v=13';

const TAP_WORDS = ['Single tap', 'Double tap', 'Triple tap', 'Quad tap',
    '5 taps', '6 taps', '7 taps', '8 taps'];

export class ZmkTapDanceTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.drafts = new Set();
    }

    async load() {
        const { flask, hid } = this.app;
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.tapDance, V.tdEnabled);
            this.slotCount = await flask.getU16(CH.tapDance, V.tdSlotCount);
            this.maxTaps = await flask.getU16(CH.tapDance, V.tdTaps) || 4;
            this.macroSlots = this.app.caps.macros
                ? await flask.getU16(CH.macros, V.macrosSlotCount) : 0;
            this.slots = [];
            for (let i = 0; i < this.slotCount; i++) {
                const cfg = decodeTdCfg(await flask.getBytes(CH.tapDance, V.tdCfg, [i], 1));
                const taps = [];
                for (let t = 0; t < this.maxTaps; t++) {
                    taps.push(decodeTdStep(
                        await flask.getBytes(CH.tapDance, V.tdStep, [i, t], 2)));
                }
                this.slots.push({ slot: i, termMs: cfg.termMs, taps });
            }
        } finally {
            hid?.resume?.();
        }
        this.render();
    }

    async writeStep(i, t) {
        try {
            const r = await this.app.flask.setBytes(CH.tapDance, V.tdStep,
                encodeTdStep(i, t, this.slots[i].taps[t]), 2);
            this.slots[i].taps[t] = decodeTdStep(r); // adopt the echo
        } catch (e) {
            toast(`Tap-dance write failed: ${e.message}`, true);
        }
        this.render();
    }

    async writeTerm(i, termMs) {
        try {
            const r = await this.app.flask.setBytes(CH.tapDance, V.tdCfg,
                encodeTdCfg(i, termMs), 1);
            this.slots[i].termMs = decodeTdCfg(r).termMs;
        } catch (e) {
            toast(`Term write failed: ${e.message}`, true);
        }
        this.render();
    }

    emptySlot(i) {
        return { slot: i, termMs: 0,
            taps: Array.from({ length: this.maxTaps }, (_, t) => ({
                slot: i, tap: t, action: TD_ACTION.none,
                behaviorId: 0, param1: 0, param2: 0,
            })) };
    }

    async clearSlot(i) {
        this.slots[i] = this.emptySlot(i);
        this.drafts.delete(i);
        try {
            for (let t = 0; t < this.maxTaps; t++) await this.writeStepQuiet(i, t);
            await this.app.flask.setBytes(CH.tapDance, V.tdCfg, encodeTdCfg(i, 0), 1);
        } catch (e) {
            toast(`Clear failed: ${e.message}`, true);
        }
        this.render();
    }

    async writeStepQuiet(i, t) {
        const r = await this.app.flask.setBytes(CH.tapDance, V.tdStep,
            encodeTdStep(i, t, this.slots[i].taps[t]), 2);
        this.slots[i].taps[t] = decodeTdStep(r);
    }

    /** Output description for a tap step. */
    stepDesc(o, { cap = false } = {}) {
        switch (o.action) {
        case TD_ACTION.usage:
            return cap ? usageCap(o.param1) : usageLabel(o.param1);
        case TD_ACTION.macro:
            return cap ? `M${o.param1}` : `Macro ${o.param1}`;
        case TD_ACTION.behavior: {
            const d = zmkBehaviors().get(o.behaviorId);
            const name = d?.displayName || `behavior #${o.behaviorId}`;
            return cap ? name.split(' ').map((w) => w[0]).join('').slice(0, 4) : name;
        }
        default:
            return '';
        }
    }

    pickStep(i, t) {
        const o = this.slots[i].taps[t];
        const behaviors = zmkBehaviors();
        const apply = (patch) => {
            Object.assign(this.slots[i].taps[t], {
                action: TD_ACTION.none, behaviorId: 0, param1: 0, param2: 0,
            }, patch);
            this.writeStep(i, t);
        };
        const rows = [
            el('button', {
                class: 'btn small primary', text: '⌨ Keycode…',
                onclick: () => {
                    back.remove();
                    pickUsage(`${TAP_WORDS[t]} output`,
                        o.action === TD_ACTION.usage ? o.param1 : 0,
                        (usage) => apply(usage
                            ? { action: TD_ACTION.usage, param1: usage } : {}));
                },
            }),
        ];
        if (this.macroSlots > 0) {
            const sel = el('select', {}, ...Array.from({ length: this.macroSlots }, (_, m) =>
                el('option', {
                    value: m, text: `Macro ${m}`,
                    selected: o.action === TD_ACTION.macro && o.param1 === m,
                })));
            rows.push(el('div', { style: 'display:flex; gap:6px; align-items:center' },
                el('button', {
                    class: 'btn small', text: '▶ Play macro',
                    onclick: () => {
                        back.remove();
                        apply({ action: TD_ACTION.macro, param1: Number(sel.value) });
                    },
                }), sel));
        }
        if (behaviors.size) {
            rows.push(el('div', { class: 'note faint', style: 'margin-top:6px',
                text: 'Or any behavior — a held dance holds it (mods and layers work):' }));
            rows.push(buildZmkPicker({
                keyPressId: null,
                onPick: (b) => {
                    back.remove();
                    apply({ action: TD_ACTION.behavior, behaviorId: b.behaviorId,
                        param1: b.param1 >>> 0, param2: b.param2 >>> 0 });
                },
            }));
        }
        rows.push(el('button', {
            class: 'btn small', text: '∅ Clear this tap',
            onclick: () => { back.remove(); apply({}); },
        }));
        const back = modal(`Dance ${i} — ${TAP_WORDS[t]}`, el('div', {
            style: 'display:flex; flex-direction:column; gap:8px',
        }, ...rows), []);
    }

    /** The creation wizard: name → term → per-tap outputs, then points at
     * the Keymap tab for the &ftd assignment. */
    openWizard() {
        const i = this.slots.findIndex((s, idx) =>
            tdSlotIsEmpty(s) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} tap-dance slots are in use`, true); return; }
        this.slots[i] = this.emptySlot(i);
        this.drafts.add(i);
        this.render();

        const fam = this.app.profile?.family ?? 'imprint';
        const nameInput = el('input', {
            type: 'text', placeholder: `Dance ${i}`, style: 'width:100%',
        });
        const termInput = el('input', {
            type: 'number', min: 0, max: 1000, placeholder: '200 (default)',
            title: 'tapping term, ms — how long the dance waits for another tap',
            style: 'width:100px',
        });
        const stepsNote = el('div', { class: 'note faint',
            text: `Pick outputs on the Dance ${i} card after Create — `
                + `${TAP_WORDS.slice(0, this.maxTaps).join(' / ').toLowerCase()}.` });
        const back = modal('New tap dance', el('div', {
            style: 'display:flex; flex-direction:column; gap:8px',
        },
            el('div', { class: 'note faint', text: 'A tap dance fires a different output by how many times you tap the key inside its term.' }),
            el('label', { text: 'Name (yours, shown in this app)' }), nameInput,
            el('label', { text: 'Tapping term (ms)' }), termInput,
            stepsNote,
            el('div', { class: 'note faint',
                text: 'Then bind it: Keymap tab → pick a key → behavior "Tap Dance" → slot '
                    + `${i}. The wizard leaves the slot as a draft until it has outputs.` })), [
            el('button', { class: 'btn small', text: 'Cancel',
                onclick: () => { this.drafts.delete(i); back.remove(); this.render(); } }),
            el('button', { class: 'btn small primary', text: 'Create', onclick: async () => {
                const nm = nameInput.value.trim();
                if (nm) zmkSetSlotName(fam, 'tapdance', i, nm);
                const term = Math.max(0, Math.min(1000, Number(termInput.value) || 0));
                back.remove();
                if (term) await this.writeTerm(i, term);
                this.render();
                toast(`Dance ${i} created — pick its tap outputs, then bind &ftd ${i} in the Keymap tab`);
            } }),
        ]);
    }

    danceCard(i) {
        const s = this.slots[i];
        const len = tdDanceLength(s.taps);
        const live = len > 0;
        const fam = this.app.profile?.family ?? 'imprint';
        const customName = zmkSlotName(fam, 'tapdance', i);

        const stepTiles = s.taps.map((o, t) => el('div', {},
            el('div', { class: 'note faint', text: TAP_WORDS[t] || `${t + 1} taps` }),
            el('button', {
                class: 'code',
                style: 'min-width:64px; min-height:40px'
                    + (t > len ? '; opacity:0.45' : ''),
                title: o.action !== TD_ACTION.none ? this.stepDesc(o)
                    : (t > len ? 'fill the earlier taps first — a dance is a contiguous run'
                        : 'pick this tap count\'s output'),
                onclick: () => this.pickStep(i, t),
            }, o.action !== TD_ACTION.none ? this.stepDesc(o, { cap: true }) : '—')));

        const termInput = el('input', {
            type: 'number', min: 0, max: 1000, value: s.termMs || '',
            placeholder: '200', title: 'tapping term, ms (0 = firmware default 200)',
            style: 'width:80px',
            onchange: (e) => this.writeTerm(i,
                Math.max(0, Math.min(1000, Number(e.target.value) || 0))),
        });

        return el('div', { class: 'card', style: live ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, el('b', {
                    text: customName || `Dance ${i}`,
                }),
                    el('span', {
                        class: 'hint',
                        text: live
                            ? `${len} tap${len > 1 ? 's' : ''} configured — bind as Tap Dance slot ${i}`
                            : 'no outputs yet — pick at least the single tap',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: '🗑', title: 'empty this dance',
                    onclick: () => this.clearSlot(i),
                })),
            el('div', { style: 'display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap' },
                ...stepTiles,
                el('div', {},
                    el('div', { class: 'note faint', text: 'term (ms)' }), termInput)));
    }

    render() {
        const { flask } = this.app;
        const visible = this.slots.map((s, i) => i)
            .filter((i) => !tdSlotIsEmpty(this.slots[i]) || this.drafts.has(i));
        const used = this.slots.filter((s) => !tdSlotIsEmpty(s)).length;

        const controls = card('Tap dances',
            'one key, several outputs — by how many times you tap it',
            toggleRow({
                label: 'Tap dances enabled',
                hint: 'master switch; dances stay stored while off (their keys do nothing)',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.tapDance, V.tdEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn primary', text: '🪄 New tap dance…',
                    onclick: () => this.openWizard(),
                }),
                el('span', { class: 'note faint', text: `${used}/${this.slotCount} slots used` }),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Save to keyboard',
                    onclick: async () => {
                        try { await flask.save(CH.tapDance); toast('Tap dances saved'); }
                        catch (e) { toast(`Save failed: ${e.message}`, true); }
                    },
                })),
            el('div', { class: 'note faint',
                text: 'Bind a dance to a key in the Keymap tab: behavior "Tap Dance", param = the slot number. Edits are live; Save persists across power-off.' }));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.danceCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No tap dances yet — 🪄 New tap dance walks you through one.',
            }));
    }
}
