// ZMK Adaptive tab — flask_adaptive runtime adaptive keys (channel 0x2B, proto
// v18, Totem). One key (&fak <set>) whose output depends on the key typed
// just before it: "b then fak within 500 ms types ecause". A set is a
// fallback output plus the rules of the shared rule pool whose `set` matches;
// a rule is trigger key (+ exact-mods flag) + max idle ms + an output of up to
// STEPS typed steps (keys, a macro slot, or any behavior such as a sticky
// shift). Output can be FULL TEXT: short text becomes inline key steps, longer
// text becomes a flask_macros slot created right here.
//
// Edits are live (write-through, adopt the echo); Save persists channel 0x2B
// (and 0x25 when a text macro was created). Bind a set from Keys › Run ›
// Adaptive key › set N.

import { el, card, toggleRow, modal, toast, renameLabel, reloadBar } from './ui.js?v=62';
import { zmkSlotName, zmkSetSlotName } from './zmk.js?v=62';
import { CH, V } from './flaskproto.js?v=62';
import { saveState } from './save-state.js?v=62';
import { blurClicks, pickOutput, outText, outCell, installSlotSummary, registerSummary } from './zmk-behaviour-common.js?v=62';
import { MACRO_ACTION, encodeMacroStep, decodeMacroStep } from './zmk-macros-codec.js?v=62';
import {
    AK_ACTION, decodeAkRule, encodeAkRule, decodeAkStep, encodeAkStep,
    decodeAkFallback, encodeAkFallback, akSeqLength, akRuleIsEmpty, textToUsages, usagesToText,
} from './zmk-adaptive-codec.js?v=62';

const STEP_SURFACE = 'zmk.adaptiveStep';
const TRIG_SURFACE = 'zmk.adaptiveTrigger';
const noStep = () => ({ action: AK_ACTION.none, behaviorId: 0, param1: 0, param2: 0 });
const usageStep = (u) => ({ action: AK_ACTION.usage, behaviorId: 0, param1: u >>> 0, param2: 0 });
const emptyRule = (index, nSteps) => ({ index, set: 0, trigger: 0, maxIdleMs: 0, strict: false,
    steps: Array.from({ length: nSteps }, noStep) });

/** Live steps of a rule (its contiguous output). */
const liveSteps = (r) => r.steps.slice(0, akSeqLength(r.steps));

/** Text for a step list: "ecause", `types 'hello'` (one macro) or steps
 * joined by ·. '' when empty. `macroText` maps slot -> text we created. */
export function outputText(steps, app, macroText = {}) {
    if (!steps.length) return '';
    const text = usagesToText(steps);
    if (text != null) return `"${text}"`;
    if (steps.length === 1 && steps[0].action === AK_ACTION.macro) {
        const slot = steps[0].param1;
        const t = macroText[slot] ?? app?.slotSummary?.('macro', slot) ?? '';
        return t ? (t.startsWith('types') ? t : `types '${t}'`) : `Macro ${slot}`;
    }
    return steps.map((s) => outText(s, STEP_SURFACE)).join(' · ');
}

export class ZmkAdaptiveTab {
    constructor(app) {
        this.app = app;
        this.root = blurClicks(el('div'));
        this.drafts = new Map();       // set -> { trigger, text, steps, idle, err }
        this.macroText = {};           // macro slot -> text this session created
        this.rules = [];
        this.fallback = [];
        installSlotSummary(app);
        registerSummary('adaptive', (set) => this.setSummary(set));
    }

    get fam() { return this.app.profile?.family ?? 'totem'; }

    async load() {
        const { flask, hid } = this.app;
        hid?.pause?.();
        try {
            this.enabled = await flask.getU16(CH.adaptive, V.akEnabled);
            this.setCount = await flask.getU16(CH.adaptive, V.akSetCount);
            this.ruleCount = await flask.getU16(CH.adaptive, V.akRuleCount);
            this.stepCount = await flask.getU16(CH.adaptive, V.akStepCount) || 6;
            this.rules = [];
            for (let i = 0; i < this.ruleCount; i++) {
                const rule = { ...decodeAkRule(await flask.getBytes(CH.adaptive, V.akRule, [i], 1)), index: i };
                rule.steps = [];
                // An empty rule has nothing to read; a live one is read to its first NONE.
                for (let s = 0; s < this.stepCount; s++) {
                    if (rule.trigger === 0) { rule.steps.push(noStep()); continue; }
                    const d = decodeAkStep(await flask.getBytes(CH.adaptive, V.akStep, [i, s], 2));
                    rule.steps.push({ action: d.action, behaviorId: d.behaviorId, param1: d.param1, param2: d.param2 });
                }
                this.rules.push(rule);
            }
            this.fallback = [];
            for (let st = 0; st < this.setCount; st++) {
                const d = decodeAkFallback(await flask.getBytes(CH.adaptive, V.akFallback, [st], 1));
                this.fallback.push({ action: d.action, behaviorId: d.behaviorId, param1: d.param1, param2: d.param2 });
            }
        } finally {
            hid?.resume?.();
        }
        this.bar ??= reloadBar(CH.adaptive, {
            label: 'Adaptive keys',
            save: () => this.app.flask.save(CH.adaptive),
            reload: () => this.load(),
        });
        this.render();
    }

    // ---- device writes (each adopts the echo, then marks the bar edited) ----

    async writeHeader(i) {
        const r = this.rules[i];
        const echo = decodeAkRule(await this.app.flask.setBytes(CH.adaptive, V.akRule, encodeAkRule(i, r), 1));
        Object.assign(r, { set: echo.set, trigger: echo.trigger, maxIdleMs: echo.maxIdleMs, strict: echo.strict });
        if (echo.trigger === 0) r.steps = Array.from({ length: this.stepCount }, noStep);
        this.bar?.markEdited();
    }

    async writeStep(i, s) {
        const d = decodeAkStep(await this.app.flask.setBytes(CH.adaptive, V.akStep,
            encodeAkStep(i, s, this.rules[i].steps[s]), 2));
        this.rules[i].steps[s] = { action: d.action, behaviorId: d.behaviorId, param1: d.param1, param2: d.param2 };
        this.bar?.markEdited();
    }

    /** Write `steps` (padded with NONE to STEPS) over rule i, only the steps that differ. */
    async writeSteps(i, steps) {
        const want = Array.from({ length: this.stepCount }, (_, k) => steps[k] ?? noStep());
        for (let s = 0; s < this.stepCount; s++) {
            const cur = this.rules[i].steps[s];
            const w = want[s];
            if (cur.action === w.action && cur.behaviorId === w.behaviorId
                && cur.param1 === w.param1 && cur.param2 === w.param2) continue;
            this.rules[i].steps[s] = w;
            await this.writeStep(i, s);
        }
    }

    async writeFallback(set, o) {
        try {
            this.fallback[set] = o;
            const d = decodeAkFallback(await this.app.flask.setBytes(CH.adaptive, V.akFallback,
                encodeAkFallback(set, o), 1));
            this.fallback[set] = { action: d.action, behaviorId: d.behaviorId, param1: d.param1, param2: d.param2 };
            this.bar?.markEdited();
        } catch (e) {
            toast(`Fallback write failed: ${e.message}`, true);
        }
        this.render();
    }

    /** Run a rule edit; any failure toasts and re-renders from the cache. */
    async guard(label, fn) {
        try { await fn(); } catch (e) { toast(`${label} failed: ${e.message}`, true); }
        this.render();
    }

    // ---- text -> output ----

    /** Lowest empty flask_macros slot, or null. */
    async freeMacroSlot(count) {
        for (let m = 0; m < count; m++) {
            const d = decodeMacroStep(await this.app.flask.getBytes(CH.macros, V.macrosStep, [m, 0], 2));
            if (d.action === MACRO_ACTION.empty) return m;
        }
        return null;
    }

    /** Text -> steps. Short text is inline key steps; longer text becomes a
     * new flask_macros slot (one MACRO step). Throws an Error with a message
     * fit for the user; nothing is written when it throws. */
    async stepsForText(text) {
        const usages = textToUsages(text);
        if (usages == null) {
            const bad = [...text].find((c) => textToUsages(c) == null);
            throw new Error(`Can't type "${bad}": only printable ASCII on a US layout can be typed from text.`);
        }
        if (usages.length <= this.stepCount) return usages.map(usageStep);
        const { flask, caps } = this.app;
        if (!caps.macros) {
            throw new Error(`Text over ${this.stepCount} characters needs a macro, and this keyboard has none.`);
        }
        const slots = await flask.getU16(CH.macros, V.macrosSlotCount);
        const cap = await flask.getU16(CH.macros, V.macrosStepCount);
        if (usages.length > cap) {
            throw new Error(`A macro holds at most ${cap} characters; this text has ${usages.length}.`);
        }
        const slot = await this.freeMacroSlot(slots);
        if (slot == null) throw new Error(`All ${slots} macro slots are in use; free one in Behaviour › Macros.`);
        for (let s = 0; s < usages.length; s++) {
            await flask.setBytes(CH.macros, V.macrosStep,
                encodeMacroStep(slot, s, { action: MACRO_ACTION.tap, param: usages[s] }), 2);
        }
        zmkSetSlotName(this.fam, 'macros', slot, `AK: ${text}`.slice(0, 40));
        this.macroText[slot] = text.length > 14 ? `${text.slice(0, 14)}…` : text;
        saveState.markDirty(CH.macros, 'Macros', () => this.app.flask.save(CH.macros));
        return [{ action: AK_ACTION.macro, behaviorId: 0, param1: slot, param2: 0 }];
    }

    /** Resolve an editor/draft result ({text} or {steps}) to steps. */
    async resolveOutput(res) {
        return res.text ? this.stepsForText(res.text) : res.steps;
    }

    // ---- actions ----

    freeIndex() { return this.rules.findIndex((r) => akRuleIsEmpty(r)); }

    async createRule(set, { trigger, steps, maxIdleMs }) {
        const i = this.freeIndex();
        if (i < 0) throw new Error(`All ${this.ruleCount} rules are in use`);
        const before = this.rules[i];
        this.rules[i] = { ...emptyRule(i, this.stepCount), set, trigger, maxIdleMs, strict: false };
        let wrote = false;
        try {
            await this.writeHeader(i);
            wrote = true;
            await this.writeSteps(i, steps);
        } catch (e) {
            if (!wrote) this.rules[i] = before;   // header never landed; a partial output stays as the device has it
            throw e;
        }
        return i;
    }

    async setOutput(i, res) {
        const steps = await this.resolveOutput(res);
        await this.writeSteps(i, steps);
        this.render();
    }

    async swap(a, b) {
        const A = structuredClone(this.rules[a]);
        const B = structuredClone(this.rules[b]);
        await this.guard('Reorder', async () => {
            for (const [to, from] of [[a, B], [b, A]]) {
                const cur = this.rules[to];
                Object.assign(cur, { set: from.set, trigger: from.trigger, maxIdleMs: from.maxIdleMs, strict: from.strict });
                await this.writeHeader(to);
                await this.writeSteps(to, from.steps);
            }
        });
    }

    pickTrigger(value, title, onPick) {
        pickOutput({
            app: this.app, surface: TRIG_SURFACE, title,
            value: value ? { action: 1, param1: value } : null,
            onPick: (v) => {
                const usage = (v.action === 1 ? v.param1 : 0) >>> 0;
                if (usage) onPick(usage);
            },
        });
    }

    // ---- output editor (modal) ----

    /** Edit an output: type text, or build a step sequence from keys and
     * behaviors. onOk({text} | {steps}) may throw (message shown inline);
     * the modal closes when it resolves. */
    openOutputEditor({ title, steps, onOk }) {
        const max = this.stepCount;
        let seq = steps.map((s) => ({ ...s }));
        const err = el('div', { class: 'note', style: 'color:var(--danger, #c0392b)' });
        const note = el('div', { class: 'note faint' });
        const input = el('input', {
            type: 'text', placeholder: 'e.g. ecause', style: 'width:100%', autocomplete: 'off',
            spellcheck: 'false', value: usagesToText(seq) ?? '',
        });
        const chips = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px; border:none' });

        const syncText = () => { input.value = usagesToText(seq) ?? ''; };
        const hint = () => {
            const n = [...input.value].length;
            note.textContent = n > max
                ? `${n} characters: stored as a new macro slot (up to ${max} characters stay inline in the rule).`
                : `Types exactly this text, up to ${max} characters inline. Longer text becomes a macro.`;
        };
        const drawChips = () => {
            chips.replaceChildren(...seq.map((s, k) => el('span', { class: 'row', style: 'gap:2px; padding:0; border:none' },
                el('button', {
                    class: 'btn small', title: 'replace this step',
                    onclick: () => pickOutput({ app: this.app, surface: STEP_SURFACE, title: `Step ${k + 1}`, value: s,
                        onPick: (v) => { if (v.action) { seq[k] = v; syncText(); hint(); drawChips(); } } }),
                }, outCell(s, STEP_SURFACE) ?? '?'),
                el('button', { class: 'btn small', text: '✕', title: 'remove this step',
                    onclick: () => { seq.splice(k, 1); syncText(); hint(); drawChips(); } }))),
                seq.length < max ? el('button', {
                    class: 'btn small', text: seq.length ? '＋ step' : '＋ Key or behavior…',
                    title: 'add a key, macro or behavior (a sticky shift, say)',
                    onclick: () => pickOutput({ app: this.app, surface: STEP_SURFACE,
                        title: `Step ${seq.length + 1}`, value: null,
                        onPick: (v) => { if (v.action) { seq.push(v); syncText(); hint(); drawChips(); } } }),
                }) : el('span', { class: 'note faint', text: `${max} steps max` }));
        };
        input.addEventListener('input', () => {
            err.textContent = '';
            const u = textToUsages(input.value);
            if (u == null) { seq = []; drawChips(); err.textContent = `Can't type "${[...input.value].find((c) => textToUsages(c) == null)}": printable ASCII (US layout) only.`; }
            else if (u.length <= max) { seq = u.map(usageStep); drawChips(); }
            else { seq = []; drawChips(); }
            hint();
        });
        const ok = async () => {
            err.textContent = '';
            const text = input.value;
            try {
                if (text && textToUsages(text) == null) throw new Error('That text has characters that cannot be typed (printable ASCII, US layout only).');
                if (text && [...text].length > max) await onOk({ text });
                else if (seq.length) await onOk({ steps: seq });
                else throw new Error('Type some text or add a key first.');
                back.remove();
            } catch (e) { err.textContent = e.message; }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
        const back = modal(title, el('div', { style: 'display:flex; flex-direction:column; gap:8px' },
            el('label', { text: 'Type the text it should produce' }), input, note,
            el('label', { text: 'or build it from keys and behaviors (up to ' + max + ' steps)' }), chips, err), [
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => back.remove() }),
            el('button', { class: 'btn small primary', text: 'OK', onclick: ok }),
        ]);
        drawChips();
        hint();
        input.focus();
    }

    // ---- drafts ("+ Add rule") ----

    addDraft(set) {
        if (this.freeIndex() < 0) { toast(`All ${this.ruleCount} rules are in use`, true); return; }
        if (!this.drafts.has(set)) this.drafts.set(set, { trigger: 0, text: '', steps: null, idle: '500', err: '' });
        this.render();
        // Fastest path: straight to the trigger key.
        this.pickTrigger(0, `Set ${set}: after which key?`, (u) => {
            this.drafts.get(set).trigger = u;
            this.focusDraft = set;
            this.render();
        });
    }

    async commitDraft(set) {
        const d = this.drafts.get(set);
        d.err = '';
        try {
            if (!d.trigger) throw new Error('Pick the key that comes before.');
            if (!d.text && !d.steps?.length) throw new Error('Type the output text or choose a key.');
            const steps = await this.resolveOutput(d.text ? { text: d.text } : { steps: d.steps });
            await this.createRule(set, { trigger: d.trigger, steps, maxIdleMs: Math.min(10000, Number(d.idle) || 0) });
            this.drafts.delete(set);
            toast(`Rule added to set ${set}`);
        } catch (e) {
            d.err = e.message;
        }
        this.render();
    }

    draftRow(set) {
        const d = this.drafts.get(set);
        const text = el('input', {
            type: 'text', placeholder: d.steps?.length ? outputText(d.steps, this.app) : 'output text, e.g. ecause',
            value: d.text, style: 'flex:1 1 160px; min-width:120px', autocomplete: 'off', spellcheck: 'false',
            'data-draft-text': set,
            oninput: (e) => { d.text = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') this.commitDraft(set); },
        });
        const idle = el('input', {
            type: 'number', min: 0, max: 10000, value: d.idle, placeholder: 'any', style: 'width:72px',
            title: 'max idle ms between the two keys (blank = any time)',
            oninput: (e) => { d.idle = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') this.commitDraft(set); },
        });
        return el('div', { class: 'row', 'data-draft': set, style: 'flex-wrap:wrap; gap:8px' },
            el('button', {
                class: 'btn small', 'data-act': 'draft-trigger',
                title: 'the key that has to come right before',
                onclick: () => this.pickTrigger(d.trigger, `Set ${set}: after which key?`, (u) => { d.trigger = u; this.render(); }),
            }, d.trigger ? outCell({ action: 1, param1: d.trigger }, TRIG_SURFACE) : 'Pick key…'),
            el('span', { class: 'faint', text: '→' }),
            text,
            el('button', {
                class: 'btn small', text: 'Keys…', title: 'build the output from keys or behaviors',
                onclick: () => this.openOutputEditor({
                    title: `Set ${set}: new rule output`, steps: d.steps ?? [],
                    onOk: async (res) => {
                        if (res.text) { d.text = res.text; d.steps = null; } else { d.steps = res.steps; d.text = ''; }
                        this.render();
                    },
                }),
            }),
            el('span', { class: 'faint', text: 'within' }), idle, el('span', { class: 'faint', text: 'ms' }),
            el('button', { class: 'btn small primary', text: 'Add', 'data-act': 'draft-add',
                onclick: () => this.commitDraft(set) }),
            el('button', { class: 'btn small', text: '✕', title: 'discard this draft',
                onclick: () => { this.drafts.delete(set); this.render(); } }),
            d.err ? el('div', { class: 'note', style: 'flex-basis:100%; color:var(--danger, #c0392b)', text: d.err }) : null);
    }

    // ---- rendering ----

    setRules(set) { return this.rules.filter((r) => !akRuleIsEmpty(r) && r.set === set); }

    ruleText(r) { return outputText(liveSteps(r), this.app, this.macroText); }

    setSummary(set) {
        const rs = this.setRules(set).filter((r) => liveSteps(r).length);
        if (!rs.length) return '';
        const one = (r) => `${outText({ action: 1, param1: r.trigger }, TRIG_SURFACE)}→${this.ruleText(r).replace(/^"|"$/g, '')}`;
        return rs.slice(0, 3).map(one).join(', ') + (rs.length > 3 ? ', …' : '');
    }

    ruleRow(r, group, pos) {
        const i = r.index;
        const live = liveSteps(r).length > 0;
        const earlier = group.slice(0, pos).some((o) => o.trigger === r.trigger);
        const text = this.ruleText(r);
        const idle = el('input', {
            type: 'number', min: 0, max: 10000, value: r.maxIdleMs || '', placeholder: 'any', style: 'width:72px',
            title: 'max idle ms between the two keys (blank = any time)',
            onchange: (e) => this.guard('Idle write', async () => {
                r.maxIdleMs = Math.max(0, Math.min(10000, Number(e.target.value) || 0));
                await this.writeHeader(i);
            }),
        });
        const exact = el('input', {
            type: 'checkbox', checked: r.strict,
            onchange: (e) => this.guard('Exact-mods write', async () => { r.strict = e.target.checked; await this.writeHeader(i); }),
        });
        return el('div', { class: 'row', 'data-rule': i, style: 'flex-wrap:wrap; gap:8px' },
            el('span', { style: 'display:inline-flex; gap:2px' },
                el('button', { class: 'btn small', text: '↑', title: 'earlier = higher priority', disabled: pos === 0,
                    onclick: () => this.swap(group[pos - 1].index, i) }),
                el('button', { class: 'btn small', text: '↓', title: 'later = lower priority', disabled: pos === group.length - 1,
                    onclick: () => this.swap(i, group[pos + 1].index) })),
            el('button', {
                class: 'btn small', 'data-act': 'trigger', title: 'change the key that has to come right before',
                onclick: () => this.pickTrigger(r.trigger, `Rule ${i}: after which key?`, (u) => this.guard('Trigger write', async () => {
                    r.trigger = u;
                    await this.writeHeader(i);
                })),
            }, outCell({ action: 1, param1: r.trigger }, TRIG_SURFACE) ?? '?'),
            el('span', { class: 'faint', text: '→' }),
            el('button', {
                class: 'btn small' + (live ? '' : ' faint'), 'data-act': 'output', style: 'flex:1 1 120px; text-align:left',
                title: 'change what it types',
                onclick: () => this.openOutputEditor({
                    title: `Rule ${i}: output`, steps: liveSteps(r),
                    onOk: async (res) => { await this.setOutput(i, res); },
                }),
            }, text || 'Choose output…'),
            el('span', { class: 'faint', text: 'within' }), idle, el('span', { class: 'faint', text: 'ms' }),
            el('label', { class: 'faint', title: 'only when the modifiers held match exactly (default: the trigger\'s modifiers must be a subset)' },
                exact, ' exact mods'),
            earlier ? el('span', { class: 'note', title: 'an earlier rule in this set has the same trigger and wins first',
                text: '⚠ shadowed' }) : null,
            el('button', { class: 'btn small', text: '✕', title: 'delete this rule', 'data-act': 'delete',
                onclick: () => this.guard('Delete', async () => { r.trigger = 0; await this.writeHeader(i); }) }));
    }

    setCard(set) {
        const group = this.setRules(set);
        const custom = zmkSlotName(this.fam, 'adaptive', set);
        const fb = this.fallback[set];
        const draft = this.drafts.has(set);
        return el('div', { class: 'card', 'data-set': set },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, renameLabel({
                    text: custom || `Set ${set}`, placeholder: `Set ${set}`,
                    onCommit: (v) => { zmkSetSlotName(this.fam, 'adaptive', set, v); this.render(); },
                }),
                    el('span', { class: 'hint', text: `${group.length} rule${group.length === 1 ? '' : 's'} · Keys picker: Run › Adaptive key › set ${set}` })),
                el('span', { style: 'flex:1' }),
                el('button', { class: 'btn small primary', text: '＋ Add rule', 'data-act': 'add-rule',
                    onclick: () => this.addDraft(set) })),
            el('div', { class: 'row', 'data-fallback': set, style: 'gap:8px' },
                el('span', { class: 'faint', style: 'width:96px', text: 'No rule matches' }),
                el('button', {
                    class: 'btn small', title: 'what the key does when no rule matches (key repeat, say)',
                    onclick: () => pickOutput({ app: this.app, surface: STEP_SURFACE, title: `Set ${set}: fallback`, value: fb,
                        onPick: (v) => this.writeFallback(set, v.action ? v : noStep()) }),
                }, fb.action !== AK_ACTION.none ? outCell(fb, STEP_SURFACE) : 'Do nothing…')),
            ...group.map((r, pos) => this.ruleRow(r, group, pos)),
            draft ? this.draftRow(set) : null,
            group.length || draft ? null : el('div', { class: 'note faint', text: 'No rules yet. ＋ Add rule: pick the key that comes first, type what to produce.' }));
    }

    render() {
        const { flask } = this.app;
        const used = this.rules.filter((r) => !akRuleIsEmpty(r)).length;
        const controls = card('Adaptive keys',
            'the output depends on the key typed just before',
            toggleRow({
                label: 'Adaptive keys enabled',
                hint: 'master switch; with it off the rules are skipped and each set\'s fallback still fires',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.adaptive, V.akEnabled, val ? 1 : 0);
                    this.bar?.markEdited();
                    return this.enabled;
                },
            }),
            el('div', { class: 'savebar' },
                el('span', { class: 'note faint', text: `${used} of ${this.ruleCount} rules used` })),
            this.bar,
            el('div', { class: 'note faint',
                text: 'Bind a set: Keys › Run › Adaptive key › set N. Edits are live; Save writes them to the keyboard.' }));
        this.root.replaceChildren(controls,
            ...Array.from({ length: this.setCount }, (_, s) => this.setCard(s)));
        if (this.focusDraft != null) {
            this.root.querySelector(`[data-draft-text="${this.focusDraft}"]`)?.focus();
            this.focusDraft = null;
        }
    }
}
