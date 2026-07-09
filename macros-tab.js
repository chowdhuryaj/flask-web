// Macro editor. Port of AdeptCompanion MacrosView.swift over MacroCodec.
// GOTCHA (quantum/via.c): macroSetBuffer is UNLOCK-GATED and silently
// ignored while locked — writes are verified by re-reading. Offline mode
// journals the whole decoded macro list; sync replays it (and reports the
// unlock requirement if the board arrives locked).

import { el, card, toast } from './ui.js?v=6';
import { kcCell, makePickerHost } from './picker.js?v=6';
import { MacroCodec } from './vialproto.js?v=6';
import { capLabel } from './keycodes.js?v=6';

export class MacrosTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { vial } = this.app;
        this.count = await vial.macroCount();
        this.bufferSize = await vial.macroBufferSize();
        this.macros = MacroCodec.decode(await vial.readMacroBuffer(this.bufferSize), this.count);
        this.dirty = false;
        this.picker = makePickerHost({ layerCount: this.app.layerCount });
        this.render();
    }

    usage() { return (MacroCodec.encode(this.macros) ?? []).length; }

    edit(fn) { fn(); this.dirty = true; this.render(); }

    async save() {
        const img = MacroCodec.encode(this.macros);
        if (!img) { toast('A keycode in these macros cannot be encoded', true); return; }
        if (img.length > this.bufferSize) {
            toast(`Macros too big: ${img.length} of ${this.bufferSize} bytes`, true);
            return;
        }
        if (!this.app.offline && !this.app.unlocked) {
            toast('Keyboard is locked — unlock first (macro writes are silently ignored)', true);
            return;
        }
        try {
            await this.app.vial.writeMacroBuffer(img, this.bufferSize);
            if (!this.app.offline) {
                const back = await this.app.vial.readMacroBuffer(Math.max(img.length, 1));
                if (!img.every((b, i) => back[i] === b)) {
                    toast('Write did not stick — is the keyboard still locked?', true);
                    return;
                }
            }
            this.dirty = false;
            toast(this.app.offline ? 'Macros queued' : 'Macros saved & verified');
            this.render();
        } catch (e) { toast(`Save failed: ${e.message}`, true); }
    }

    actionChip(mi, ai, a) {
        const label = a.t === 'text' ? `“${a.s}”`
            : a.t === 'delay' ? `${a.ms} ms`
            : `${a.t} ${capLabel(a.kc)}`;
        return el('span', { class: 'badge', title: a.t },
            label, el('button', {
                class: 'btn small', text: '✕', style: 'margin-left:4px',
                onclick: () => this.edit(() => this.macros[mi].splice(ai, 1)),
            }));
    }

    macroCard(mi) {
        const macro = this.macros[mi];
        const chips = el('div', { style: 'display:flex; gap:4px; flex-wrap:wrap; min-height:24px' },
            ...macro.map((a, ai) => this.actionChip(mi, ai, a)),
            macro.length ? null : el('span', { class: 'faint', text: 'empty' }));

        const textIn = el('input', { type: 'text', placeholder: 'type text…', size: 14 });
        const addText = () => {
            if (!textIn.value) return;
            this.edit(() => macro.push({ t: 'text', s: textIn.value }));
        };
        textIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addText(); });
        const delayIn = el('input', { type: 'number', min: 1, max: 60000, placeholder: 'ms', style: 'width:64px' });
        const kcBtn = (t) => el('button', {
            class: 'btn small', text: t,
            title: `Add a ${t} action (picker below)`,
            onclick: () => this.picker.request((kc) => this.edit(() => macro.push({ t, kc }))),
        });
        return el('div', { style: 'padding:6px 0; border-bottom:1px solid var(--border)' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl mono', text: `M${mi}` }),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Clear',
                    onclick: () => this.edit(() => { this.macros[mi] = []; }),
                })),
            chips,
            el('div', { class: 'row', style: 'gap:4px; flex-wrap:wrap' },
                textIn, el('button', { class: 'btn small', text: '+ text', onclick: addText }),
                kcBtn('tap'), kcBtn('down'), kcBtn('up'),
                delayIn, el('button', {
                    class: 'btn small', text: '+ delay',
                    onclick: () => {
                        const ms = Number(delayIn.value);
                        if (ms > 0) this.edit(() => macro.push({ t: 'delay', ms }));
                    },
                })));
    }

    render() {
        const used = this.usage();
        const c = card('Macros', `${this.count} slots · ${used}/${this.bufferSize} bytes used`);
        if (!this.app.offline && !this.app.unlocked) {
            c.append(el('div', { class: 'banner', style: 'margin:6px 0' },
                'Macro writes are unlock-gated (the firmware silently ignores them while locked). ',
                el('button', {
                    class: 'btn small', text: 'Unlock…',
                    onclick: () => this.app.onHudLockClick?.(),
                })));
        }
        // Show used macros + a couple of spares (M0 always).
        let last = -1;
        this.macros.forEach((m, i) => { if (m.length) last = i; });
        const show = Math.min(this.count, Math.max(last + 3, 4));
        for (let mi = 0; mi < show; mi++) c.append(this.macroCard(mi));
        if (show < this.count) c.append(el('div', { class: 'note faint', text: `+ ${this.count - show} more empty slots` }));
        c.append(el('div', { class: 'savebar' },
            el('button', {
                class: 'btn' + (this.dirty ? ' primary' : ''), text: 'Save macros',
                onclick: () => this.save(),
            }),
            el('span', { class: 'note', text: this.dirty
                ? 'Unsaved changes — macros write as one buffer.'
                : 'Place MC_0…MC_n from the picker\'s Quantum list.' })));
        this.root.replaceChildren(c, this.picker.card);
    }
}
