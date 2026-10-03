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

import { el, card, toggleRow, modal, toast, reloadBar } from './ui.js?v=66';
import { zmkSlotName, zmkSetSlotName } from './zmk.js?v=66';
import { CH, V } from './flaskproto.js?v=66';
import { blurClicks, pickOutput, outText, outCell, installSlotSummary, registerSummary, onSlotsChanged, dim, isRecursiveOutput } from './zmk-behaviour-common.js?v=66';
import {
    TD_ACTION, decodeTdStep, encodeTdStep, decodeTdCfg, encodeTdCfg,
    tdDanceLength, tdSlotIsEmpty,
} from './zmk-tapdance-codec.js?v=66';

const TAP_WORDS = ['1 tap', '2 taps', '3 taps', '4 taps', '5 taps', '6 taps', '7 taps', '8 taps'];

/** Chip text for the picker: "A / Esc" (first three outputs). */
export function danceSummary(slot) {
    if (!slot) return '';
    return slot.taps.slice(0, tdDanceLength(slot.taps)).slice(0, 3)
        .map((o) => outText(o, 'zmk.tapDanceStep')).join(' / ');
}

export class ZmkTapDanceTab {
    constructor(app) {
        this.app = app;
        this.root = blurClicks(el('div'));
        this.drafts = new Set();
        installSlotSummary(app);
        registerSummary('tap-dance', (i) => danceSummary(this.slots?.[i]));
        onSlotsChanged(CH.tapDance, this, () => { if (this.slots) this.load().catch(() => {}); });
    }

    async load() {
        const { flask, hid } = this.app;
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.tapDance, V.tdEnabled);
            this.slotCount = await dim(this.app, CH.tapDance, V.tdSlotCount);
            this.maxTaps = await dim(this.app, CH.tapDance, V.tdTaps) || 4;
            this.slots = [];
            for (let i = 0; i < this.slotCount; i++) {
                const cfg = decodeTdCfg(await flask.getBytes(CH.tapDance, V.tdCfg, [i], 1));
                const taps = [];
                // A dance is its contiguous prefix (flask_tapdance.c slot_len): stop at
                // the first NONE. Taps behind it stay unread (`unknown`) and are cleared
                // before a write could make them live.
                let ended = false;
                for (let t = 0; t < this.maxTaps; t++) {
                    if (ended) { taps.push({ ...this.noTap(i, t), unknown: true }); continue; }
                    const d = decodeTdStep(await flask.getBytes(CH.tapDance, V.tdStep, [i, t], 2));
                    // Tap Dance / Adaptive Key as a step recurses in the firmware: show it as empty.
                    const o = isRecursiveOutput(d) ? { ...this.noTap(i, t), unknown: true } : d;
                    taps.push(o);
                    if (!o.action) ended = true;
                }
                this.slots.push({ slot: i, termMs: cfg.termMs, taps });
            }
        } finally {
            hid?.resume?.();
        }
        this.bar ??= reloadBar(CH.tapDance, {
            label: 'Tap dances',
            save: () => this.app.flask.save(CH.tapDance),
            reload: () => this.load(),
        });
        this.render();
    }

    noTap(i, t) {
        return { slot: i, tap: t, action: TD_ACTION.none, behaviorId: 0, param1: 0, param2: 0 };
    }

    /** Write tap t. The cache only changes from the echo, so a refused write
     * leaves the card showing what the device holds. */
    async writeStep(i, t, step) {
        try {
            if (step.action) await this.clearUnreadAfter(i, t);
            const r = await this.app.flask.setBytes(CH.tapDance, V.tdStep, encodeTdStep(i, t, step), 2);
            this.slots[i].taps[t] = decodeTdStep(r); // adopt the echo
            this.bar?.markEdited();
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
            this.bar?.markEdited();
        } catch (e) {
            toast(`Term write failed: ${e.message}`, true);
        }
        this.render();
    }

    /** Taps behind the first NONE were never read; one of them going live by
     * accident (a gap being filled) is worse than clearing it. */
    async clearUnreadAfter(i, t) {
        for (let k = t + 1; k < this.maxTaps; k++) {
            if (this.slots[i].taps[k].unknown) await this.writeStepQuiet(i, k, this.noTap(i, k));
        }
    }

    async clearSlot(i) {
        this.drafts.delete(i);
        zmkSetSlotName(this.app.profile?.family ?? 'imprint', 'tapdance', i, '');   // the name must not outlive the slot (WB-12)
        try {
            for (let t = 0; t < this.maxTaps; t++) await this.writeStepQuiet(i, t, this.noTap(i, t));
            this.slots[i].termMs = decodeTdCfg(await this.app.flask.setBytes(CH.tapDance, V.tdCfg, encodeTdCfg(i, 0), 1)).termMs;
            this.bar?.markEdited();
        } catch (e) {
            toast(`Clear failed: ${e.message}`, true);
        }
        this.render();
    }

    async writeStepQuiet(i, t, step) {
        const r = await this.app.flask.setBytes(CH.tapDance, V.tdStep, encodeTdStep(i, t, step), 2);
        this.slots[i].taps[t] = decodeTdStep(r);
    }

    pickStep(i, t) {
        const o = this.slots[i].taps[t];
        pickOutput({
            app: this.app, surface: 'zmk.tapDanceStep', title: `Dance ${i}: ${TAP_WORDS[t]}`, value: o,
            onPick: (v) => this.writeStep(i, t, v.action ? { ...this.noTap(i, t), ...v } : this.noTap(i, t)),
        });
    }

    /** The creation wizard: name → term → per-tap outputs, then points at
     * the Keymap tab for the &ftd assignment. */
    openWizard() {
        const i = this.slots.findIndex((s, idx) =>
            tdSlotIsEmpty(s) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} tap-dance slots are in use`, true); return; }
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
            text: `Pick outputs on the Dance ${i} card after Create: `
                + `${TAP_WORDS.slice(0, this.maxTaps).join(' / ').toLowerCase()}.` });
        const back = modal('New tap dance', el('div', {
            style: 'display:flex; flex-direction:column; gap:8px',
        },
            el('div', { class: 'note faint', text: 'A tap dance fires a different output by how many times you tap the key inside its term.' }),
            el('label', { text: 'Name (yours, shown in this app)' }), nameInput,
            el('label', { text: 'Tapping term (ms)' }), termInput,
            stepsNote,
            el('div', { class: 'note faint',
                text: 'Then bind it: Keys → pick a key → Run › Tap dance → slot '
                    + `${i}. The slot stays a draft until it has outputs.` })), [
            el('button', { class: 'btn small', text: 'Cancel',
                onclick: () => { this.drafts.delete(i); back.remove(); this.render(); } }),
            el('button', { class: 'btn small primary', text: 'Create', onclick: async () => {
                const nm = nameInput.value.trim();
                if (nm) zmkSetSlotName(fam, 'tapdance', i, nm);
                const term = Math.max(0, Math.min(1000, Number(termInput.value) || 0));
                back.remove();
                if (term) await this.writeTerm(i, term);
                this.render();
                toast(`Dance ${i} created. Pick its tap outputs, then bind it from Keys › Run › Tap dance`);
            } }),
        ]);
    }

    danceCard(i) {
        const s = this.slots[i];
        const len = tdDanceLength(s.taps);
        const live = len > 0;
        const fam = this.app.profile?.family ?? 'imprint';
        const customName = zmkSlotName(fam, 'tapdance', i);

        const stepRows = s.taps.map((o, t) => el('div', { class: 'row', style: 'gap:8px' },
            el('span', { class: 'faint', style: 'width:56px', text: TAP_WORDS[t] || `${t + 1} taps` }),
            el('button', {
                class: 'btn small' + (t > len ? ' faint' : ''), 'data-tap': t,
                title: t > len ? 'fill the earlier taps first; a dance is a contiguous run' : 'pick this tap count\'s output',
                onclick: () => this.pickStep(i, t),
            }, o.action !== TD_ACTION.none ? outCell(o, 'zmk.tapDanceStep') : 'Choose output…')));

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
                            ? `${danceSummary(s)} · Keys picker: Run › Tap dance ${i}`
                            : 'no outputs yet: pick at least the 1 tap',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Delete', title: 'empty this dance',
                    onclick: () => this.clearSlot(i),
                })),
            ...stepRows,
            el('div', { class: 'row', style: 'gap:8px' },
                el('span', { class: 'faint', style: 'width:56px', text: 'Term' }), termInput,
                el('span', { class: 'note faint', text: 'ms (0 = firmware default 200)' })));
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
                ),
            this.bar,
            el('div', { class: 'note faint',
                text: 'Bind a dance to a key from Keys › Run › Tap dance. Edits are live.' }));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.danceCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No tap dances yet — 🪄 New tap dance walks you through one.',
            }));
    }
}
