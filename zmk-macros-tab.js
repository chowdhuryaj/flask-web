// ZMK Macros tab — flask_macros runtime macros (channel 0x25, proto v8).
// One card per macro slot: an ordered step list (Tap / Press / Release /
// Wait), each step's key picked with the shared usage modal (combos tab),
// wait times on an inline slider. Edits are LIVE on the device
// (write-through); Save persists; ▶ plays the slot over the protocol's
// live-state value (nothing has to be bound to a key to test it).
//
// Differences from Vial macros by design:
//  - steps are typed rows (tap/press/release/wait), not a byte stream;
//  - global tap/wait pacing (two knobs), not per-step delays — a Wait step
//    covers the long-pause case;
//  - devicetree macros baked into the firmware are invisible here (ZMK
//    Studio has no macro RPC) — &fmac only plays these runtime slots.
//
// Playback stops at the first empty step, so the editor keeps live steps
// compacted: deleting a row shifts the tail up and rewrites the suffix.

import { el, card, sliderRow, toggleRow, saveBar, toast, renameLabel } from './ui.js?v=18';
import { zmkSlotName, zmkSetSlotName } from './zmk.js?v=18';
import { CH, V } from './flaskproto.js?v=18';
import { usageCap, usageLabel } from './zmk-keycodes.js?v=18';
import { pickUsage } from './zmk-combos-tab.js?v=18';
import { armCapture, bareUsage, isModifierUsage } from './zmk-capture.js?v=18';
import {
    MACRO_ACTION, MACRO_ACTION_LABELS,
    decodeMacroStep, encodeMacroStep, macroIsEmpty, macroLiveSteps,
} from './zmk-macros-codec.js?v=18';

export class ZmkMacrosTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.drafts = new Set(); // empty slots kept visible while editing
    }

    async load() {
        const { flask, hid } = this.app;
        // HUD poll backs off for the bulk step read (see combos tab note).
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.macros, V.macrosEnabled);
            this.slotCount = await flask.getU16(CH.macros, V.macrosSlotCount);
            this.stepCount = await flask.getU16(CH.macros, V.macrosStepCount);
            this.tapMs = await flask.getU16(CH.macros, V.macrosTapMs);
            this.waitMs = await flask.getU16(CH.macros, V.macrosWaitMs);
            this.steps = [];
            for (let m = 0; m < this.slotCount; m++) {
                const slot = [];
                // Playback stops at the first empty step — so can the reads.
                for (let s = 0; s < this.stepCount; s++) {
                    const r = await flask.getBytes(CH.macros, V.macrosStep, [m, s], 2);
                    const step = decodeMacroStep(r);
                    slot.push({ action: step.action, param: step.param });
                    if (step.action === MACRO_ACTION.empty) break;
                }
                while (slot.length < this.stepCount) {
                    slot.push({ action: MACRO_ACTION.empty, param: 0 });
                }
                this.steps.push(slot);
            }
        } finally {
            hid?.resume?.();
        }
        this.render();
    }

    async writeStep(m, s) {
        try {
            const r = await this.app.flask.setBytes(CH.macros, V.macrosStep,
                encodeMacroStep(m, s, this.steps[m][s]), 2);
            const step = decodeMacroStep(r); // adopt the echo (normalized)
            this.steps[m][s] = { action: step.action, param: step.param };
        } catch (e) {
            toast(`Macro write failed: ${e.message}`, true);
        }
    }

    /** Rewrite steps from index `from` through the live suffix + one empty
     * terminator — the delete/compact path. */
    async writeFrom(m, from) {
        const last = Math.min(this.stepCount - 1,
            Math.max(macroLiveSteps(this.steps[m]).length, from));
        for (let s = from; s <= last; s++) {
            await this.writeStep(m, s);
        }
        this.render();
    }

    addMacro() {
        const i = this.steps.findIndex((st, idx) =>
            macroIsEmpty(st) && !this.drafts.has(idx));
        if (i < 0) { toast(`All ${this.slotCount} macro slots are in use`, true); return; }
        this.drafts.add(i);
        this.render();
    }

    async clearSlot(m) {
        const live = macroLiveSteps(this.steps[m]).length;
        this.steps[m] = Array.from({ length: this.stepCount },
            () => ({ action: MACRO_ACTION.empty, param: 0 }));
        this.drafts.delete(m);
        for (let s = 0; s < live; s++) {
            await this.writeStep(m, s);
        }
        this.render();
    }

    addStep(m) {
        const live = macroLiveSteps(this.steps[m]).length;
        if (live >= this.stepCount) {
            toast(`Macros take up to ${this.stepCount} steps`, true);
            return;
        }
        this.steps[m][live] = { action: MACRO_ACTION.tap, param: 0 };
        this.writeStep(m, live).then(() => this.render());
    }

    deleteStep(m, s) {
        const steps = this.steps[m];
        steps.splice(s, 1);
        steps.push({ action: MACRO_ACTION.empty, param: 0 });
        this.writeFrom(m, s);
    }

    async play(m) {
        try {
            await this.app.flask.setU16(CH.macros, V.macrosState, m + 1);
            toast(`Macro ${m} ▶ — plays on the keyboard`);
        } catch {
            toast('Play refused — another macro is running, or macros are disabled', true);
        }
    }

    // ---- keystroke recording ----
    // Arm window key capture and turn what you TYPE into steps, instead of
    // laying them out by hand. Each keydown appends a Press; the matching
    // keyup collapses an untouched Press into a Tap (plain typing → Tap per
    // key) or emits a Release (so a held chord like ⌃C records as Press
    // Ctrl · Tap C · Release Ctrl). Modifiers are their own steps, so the
    // key steps carry the BARE usage (no folded mods). Timing isn't
    // recorded — the tab's global tap/gap pacing covers it; add a Wait step
    // by hand for a long pause. Esc or leaving the tab stops.

    _recActive() { return !!this._rec; }

    toggleRecord(m) {
        if (this._rec) {                          // stop (this card or another)
            const stopping = this._rec.m;
            this._recStop?.();
            if (stopping !== m) this.startRecord(m);   // switch cards
            return;
        }
        this.startRecord(m);
    }

    startRecord(m) {
        // Append after the live steps; remember where we began so the flush
        // and an empty-recording cancel both know the range.
        this._rec = { m, start: macroLiveSteps(this.steps[m]).length };
        if (this._rec.start >= this.stepCount) {
            toast(`Macro ${m} is full (${this.stepCount} steps)`, true);
            this._rec = null;
            return;
        }
        this.drafts.add(m);
        this._recStop = armCapture({
            isActive: () => !!this.root.closest('.panel.active'),
            onDown: (param) => this._recDown(m, param),
            onUp: (param) => this._recUp(m, param),
            onStop: () => this._recFinish(),
        });
        this.render();
        toast('Recording — type your macro; Esc or ⏹ stops', false);
    }

    _liveLen(m) { return macroLiveSteps(this.steps[m]).length; }

    _recDown(m, param) {
        const live = this._liveLen(m);
        if (live >= this.stepCount) {              // no room — stop cleanly
            toast(`Macro full at ${this.stepCount} steps — recording stopped`, true);
            this._recStop?.();
            return;
        }
        // Modifiers keep their bare usage already; other keys drop folded
        // implicit mods (the modifier is its own Press/Release step).
        const usage = isModifierUsage(param) ? param : bareUsage(param);
        this.steps[m][live] = { action: MACRO_ACTION.press, param: usage };
        this.render();
    }

    _recUp(m, param) {
        const usage = isModifierUsage(param) ? param : bareUsage(param);
        const live = this._liveLen(m);
        const last = live > 0 ? this.steps[m][live - 1] : null;
        // A Press of this exact key with nothing recorded since → a Tap.
        if (last && last.action === MACRO_ACTION.press && last.param === usage) {
            last.action = MACRO_ACTION.tap;
        } else if (live < this.stepCount) {
            this.steps[m][live] = { action: MACRO_ACTION.release, param: usage };
        }
        this.render();
    }

    async _recFinish() {
        const rec = this._rec;
        this._rec = null;
        this._recStop = null;
        if (!rec) return;
        // Persist the recorded range (adopting each echo); writeFrom renders.
        await this.writeFrom(rec.m, rec.start);
        const added = this._liveLen(rec.m) - rec.start;
        toast(added ? `Recorded ${added} step${added === 1 ? '' : 's'} — Save to persist`
                    : 'Recording stopped — nothing captured');
    }

    stepRow(m, s) {
        const step = this.steps[m][s];
        const isKey = step.action === MACRO_ACTION.tap
            || step.action === MACRO_ACTION.press
            || step.action === MACRO_ACTION.release;

        const actionSel = el('select', {},
            ...Object.entries(MACRO_ACTION_LABELS).map(([v, label]) =>
                el('option', { value: v, text: label })));
        actionSel.value = String(step.action);
        actionSel.addEventListener('change', () => {
            const next = Number(actionSel.value);
            const wasKey = isKey;
            const nowKey = next !== MACRO_ACTION.wait;
            step.action = next;
            if (wasKey !== nowKey) step.param = 0;
            this.writeStep(m, s).then(() => this.render());
        });

        let paramEl;
        if (isKey) {
            paramEl = el('button', {
                class: 'code',
                style: 'min-width:64px',
                title: step.param ? usageLabel(step.param) : 'pick the key',
                onclick: () => pickUsage(`Macro ${m} step ${s + 1} key`, step.param, (usage) => {
                    step.param = usage;
                    this.writeStep(m, s).then(() => this.render());
                }),
            }, step.param ? usageCap(step.param) : 'key…');
        } else {
            const val = el('span', { class: 'val', text: `${step.param} ms` });
            const slider = el('input', {
                type: 'range', min: 0, max: 5000, step: 10, value: step.param,
                style: 'width:140px',
            });
            slider.addEventListener('input', () => { val.textContent = `${slider.value} ms`; });
            slider.addEventListener('change', () => {
                step.param = Number(slider.value);
                this.writeStep(m, s);
            });
            paramEl = el('span', { style: 'display:inline-flex; gap:6px; align-items:center' },
                slider, val);
        }

        return el('div', { class: 'row', style: 'gap:8px' },
            el('span', { class: 'faint', style: 'width:24px', text: `${s + 1}.` }),
            actionSel, paramEl,
            el('span', { style: 'flex:1' }),
            el('button', {
                class: 'btn small', text: '✕', title: 'delete this step (tail shifts up)',
                onclick: () => this.deleteStep(m, s),
            }));
    }

    macroCard(m) {
        const live = macroLiveSteps(this.steps[m]);
        const fam = this.app.profile?.family ?? 'imprint';
        const customName = zmkSlotName(fam, 'macros', m);
        return el('div', { class: 'card', style: live.length ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, renameLabel({
                    text: customName || `Macro ${m}`,
                    placeholder: `Macro ${m}`,
                    onCommit: (v) => { zmkSetSlotName(fam, 'macros', m, v); this.render(); },
                }),
                    el('span', {
                        class: 'hint',
                        text: live.length
                            ? `${live.length} step${live.length === 1 ? '' : 's'} — bind with &fmac ${m} (Keymap tab → Behaviors)`
                            : 'empty — add a step below',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small' + (this._rec?.m === m ? ' primary' : ''),
                    text: this._rec?.m === m ? '⏹ Stop (Esc)' : '⏺ Record',
                    title: this._rec?.m === m
                        ? 'stop recording'
                        : 'type your macro — keystrokes become steps (chords keep their modifiers)',
                    onclick: () => this.toggleRecord(m),
                }),
                el('button', {
                    class: 'btn small', text: '▶ Play', title: 'play this macro from here — no key binding needed',
                    onclick: () => this.play(m),
                }),
                el('button', {
                    class: 'btn small', text: '🗑', title: 'empty this macro slot',
                    onclick: () => this.clearSlot(m),
                })),
            ...live.map((_, s) => this.stepRow(m, s)),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn small', text: '＋ Add step',
                    onclick: () => this.addStep(m),
                }),
                el('span', { class: 'note faint', text: `${live.length} of ${this.stepCount} steps` })));
    }

    render() {
        const { flask } = this.app;
        const visible = this.steps
            .map((_, i) => i)
            .filter((i) => !macroIsEmpty(this.steps[i]) || this.drafts.has(i));
        const used = this.steps.filter((st) => !macroIsEmpty(st)).length;

        const controls = card('Runtime macros',
            'typed step sequences played from a key (&fmac) or the ▶ button — live-editable, unlike ZMK\'s devicetree macros',
            toggleRow({
                label: 'Macros enabled',
                hint: 'master switch; also stops a running macro',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.macros, V.macrosEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            sliderRow({
                label: 'Tap hold',
                hint: 'tap step down→up, ms',
                min: 1, max: 500, step: 1, value: this.tapMs,
                format: (v) => `${v} ms`,
                onChange: async (val) => {
                    this.tapMs = await flask.setU16(CH.macros, V.macrosTapMs, val);
                    return this.tapMs;
                },
            }),
            sliderRow({
                label: 'Step gap',
                hint: 'between steps, ms',
                min: 0, max: 2000, step: 5, value: this.waitMs,
                format: (v) => `${v} ms`,
                onChange: async (val) => {
                    this.waitMs = await flask.setU16(CH.macros, V.macrosWaitMs, val);
                    return this.waitMs;
                },
            }),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn primary', text: 'Add New Macro',
                    onclick: () => this.addMacro(),
                }),
                el('button', {
                    class: 'btn small', text: '⏹ Stop', title: 'stop whatever is playing (live-state rescue)',
                    onclick: async () => {
                        try { await flask.setU16(CH.macros, V.macrosState, 0); toast('Stopped'); }
                        catch (e) { toast(e.message, true); }
                    },
                }),
                el('span', { class: 'note faint', text: `${used} of ${this.slotCount} slots in use` })),
            saveBar(() => flask.save(CH.macros)));

        this.root.replaceChildren(controls,
            ...visible.map((m) => this.macroCard(m)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No macros yet — Add New Macro, add steps, pick keys, then ▶ to test.',
            }));
    }
}
