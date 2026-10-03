// Svalboard macros (Vial dynamic macros): one row per slot, Edit opens the
// step editor sheet. Port of AdeptCompanion MacrosView. A row pastes MC_n
// (QK_MACRO + n) onto the key selected on the board.
// GOTCHA (quantum/via.c): macroSetBuffer is UNLOCK-GATED and silently
// ignored while locked, so writes are verified by re-reading. Offline mode
// journals the whole decoded macro list; sync replays it (and reports the
// unlock requirement if the board arrives locked).

import { el, card, toast } from './ui.js?v=76';
import { MacroCodec } from './vialproto.js?v=76';
import { encode } from './behavior-catalog.js?v=76';
import { bindingCell, pickKey, pasteToKey, addSummary, openSheet, reloadRow, slotRow } from './qmk-ui.js?v=76';

const STEP_KINDS = [
    ['text', 'Type text'], ['tap', 'Tap key'], ['down', 'Hold key down'], ['up', 'Release key'], ['delay', 'Delay'],
];
const KIND_LABEL = { text: 'Type text', tap: 'Tap', down: 'Hold down', up: 'Release', delay: 'Wait (ms)' };

/** "types 'hello w…'" / "3 steps" / "" — the tile and picker-chip summary. */
export function macroSummary(macro) {
    if (!macro?.length) return '';
    const first = macro[0];
    if (macro.length === 1 && first.t === 'text') {
        const s = first.s.length > 12 ? `${first.s.slice(0, 12)}…` : first.s;
        return `types '${s}'`;
    }
    return `${macro.length} step${macro.length === 1 ? '' : 's'}`;
}

export class MacrosTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { vial } = this.app;
        this.count = await vial.macroCount();
        this.app.macroCount = this.count;   // picker: M n slot range
        addSummary(this.app, 'macro', (i) => macroSummary(this.macros?.[i]));
        this.bufferSize = await vial.macroBufferSize();
        this.macros = MacroCodec.decode(await vial.readMacroBuffer(this.bufferSize), this.count);
        this.render();
    }

    usage(list = this.macros) { return (MacroCodec.encode(list) ?? []).length; }

    /** Write the whole buffer (a single macro cannot be written alone). */
    async write(next) {
        const img = MacroCodec.encode(next);
        if (!img) { toast('A keycode in these macros cannot be encoded', true); return false; }
        if (img.length > this.bufferSize) {
            toast(`Macros too big: ${img.length} of ${this.bufferSize} bytes`, true);
            return false;
        }
        if (!this.app.offline && !this.app.unlocked) {
            toast('Keyboard is locked, unlock first (macro writes are silently ignored)', true);
            return false;
        }
        try {
            await this.app.vial.writeMacroBuffer(img, this.bufferSize);
            if (!this.app.offline) {
                const back = await this.app.vial.readMacroBuffer(Math.max(img.length, 1));
                if (!img.every((b, i) => back[i] === b)) {
                    toast('Write did not stick. Is the keyboard still locked?', true);
                    return false;
                }
            }
        } catch (e) { toast(`Save failed: ${e.message}`, true); return false; }
        this.macros = next;
        toast(this.app.offline ? 'Macro queued' : 'Macro saved and verified');
        this.render();
        return true;
    }

    unlockBanner() {
        if (this.app.offline || this.app.unlocked) return null;
        return el('div', { class: 'banner', style: 'margin:6px 0' },
            'Macro writes are unlock-gated (the firmware silently ignores them while locked). ',
            el('button', { class: 'btn small', text: 'Unlock…', onclick: () => this.app.onHudLockClick?.() }));
    }

    stepRow(draft, i, sh) {
        const a = draft[i];
        const move = (d) => { const j = i + d; if (j < 0 || j >= draft.length) return; [draft[i], draft[j]] = [draft[j], draft[i]]; sh.refresh(); };
        let value;
        if (a.t === 'text') {
            value = el('input', { type: 'text', class: 'step-text', value: a.s, placeholder: 'text to type…' });
            value.addEventListener('input', () => { a.s = value.value; });
        } else if (a.t === 'delay') {
            value = el('input', { type: 'number', min: 1, max: 60000, value: a.ms, style: 'width:90px' });
            value.addEventListener('input', () => { a.ms = Number(value.value) || 0; });
        } else {
            value = bindingCell(a.kc, () => this.pickKey(a.kc, `${KIND_LABEL[a.t]} key`, (kc) => { a.kc = kc; sh.refresh(); }), 'Change key');
        }
        return el('div', { class: 'row step', 'data-step': a.t },
            el('span', { class: 'step-idx', text: String(i + 1) }),
            el('span', { class: 'step-kind', text: KIND_LABEL[a.t] }),
            value,
            el('span', { style: 'flex:1' }),
            el('button', { class: 'btn small', text: '↑', title: 'Move up', onclick: () => move(-1) }),
            el('button', { class: 'btn small', text: '↓', title: 'Move down', onclick: () => move(1) }),
            el('button', { class: 'btn small', text: '✕', title: 'Remove step', onclick: () => { draft.splice(i, 1); sh.refresh(); } }));
    }

    pickKey(value, title, onPick) {
        pickKey(this.app, 'qmk.macroKey', value, title, onPick);
    }

    editMacro(mi) {
        const draft = this.macros[mi].map((a) => ({ ...a }));
        openSheet(`Macro M${mi}`, (sh) => {
            const next = this.macros.map((m, i) => (i === mi ? draft : m));
            return [
                this.unlockBanner(),
                el('div', { class: 'note faint', text: `${this.usage(next)} of ${this.bufferSize} bytes used across all macros` }),
                ...draft.map((_, i) => this.stepRow(draft, i, sh)),
                draft.length ? null : el('div', { class: 'faint', text: 'No steps yet. Add one below.' }),
                el('div', { class: 'row', style: 'gap:4px; flex-wrap:wrap' }, ...STEP_KINDS.map(([t, label]) => el('button', {
                    class: 'btn small', text: label, 'data-add': t,
                    onclick: () => {
                        if (t === 'text') draft.push({ t, s: '' });
                        else if (t === 'delay') draft.push({ t, ms: 50 });
                        else return this.pickKey(0, `${label}`, (kc) => { draft.push({ t, kc }); sh.refresh(); });
                        sh.refresh();
                    },
                }))),
            ];
        }, (sh) => [
            el('button', { class: 'btn', text: 'Cancel', onclick: () => sh.close() }),
            el('button', { class: 'btn', text: 'Clear', onclick: () => { draft.length = 0; sh.refresh(); } }),
            el('button', {
                class: 'btn primary', text: 'Save macro', 'data-save': '',
                onclick: async () => {
                    const clean = draft.filter((a) => !(a.t === 'text' && !a.s) && !(a.t === 'delay' && !(a.ms > 0)));
                    if (await this.write(this.macros.map((m, i) => (i === mi ? clean : m)))) sh.close();
                },
            }),
        ]);
    }

    render() {
        const used = this.usage();
        const c = card('Macros', `${this.count} slots · ${used}/${this.bufferSize} bytes used`,
            this.unlockBanner(),
            el('div', {}, ...this.macros.map((m, i) => slotRow({
                name: `M${i}`, sub: macroSummary(m), empty: !m.length,
                onEdit: () => this.editMacro(i),
                onPaste: () => pasteToKey(encode('macro', { slot: i }, 'qmk')),
            }))),
            reloadRow(() => this.load(), 'Macro writes are saved to the keyboard at once.'));
        this.root.replaceChildren(c);
    }
}
