// Keychron Nape Pro — macros tab.
//
// The device stores 16 macros end-to-end in one 2394-byte buffer, each
// terminated by 0x00, so a single macro cannot be written in isolation: the
// whole buffer is rewritten every save. Escapes recorded by Keychron's app are
// preserved verbatim rather than reinterpreted (see macroToText).

import { el, card, toast } from './ui.js?v=49';
import { macroToText, macroFromText } from './nape-proto.js?v=49';
import { encode } from './behavior-catalog.js?v=1';
import { tile, tileGrid, openSheet, pasteToKey, addSummary } from './tiles.js?v=1';

const summary = (bytes) => {
    if (!bytes?.length) return '';
    const t = macroToText(bytes);
    return `types '${t.length > 12 ? `${t.slice(0, 12)}…` : t}'`;
};

export class NapeMacrosTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const app = this.app;
        app.hid.pause();
        try {
            const m = await app.nape.readMacros();
            this.count = m.count;
            this.bufferSize = m.bufferSize;
            this.macros = m.macros.map((b) => Array.from(b));
        } finally {
            app.hid.resume();
        }
        this.app.macroCount = this.count;   // WP3 picker: Nape macro slot range
        addSummary(this.app, 'macro', (i) => summary(this.macros?.[i]));
        this.render();
    }

    get used() {
        return this.macros.reduce((n, m) => n + m.length + 1, 0);
    }

    async _save(index, text) {
        let bytes;
        try {
            bytes = macroFromText(text);
        } catch (e) {
            toast(e.message, true);
            return false;
        }
        const next = this.macros.slice();
        next[index] = bytes;
        const total = next.reduce((n, m) => n + m.length + 1, 0);
        if (total > this.bufferSize) {
            toast(`Too long: ${total} of ${this.bufferSize} bytes used across all macros`, true);
            return false;
        }
        this.app.hid.pause();
        try {
            await this.app.nape.writeMacros(next, this.bufferSize);
            this.macros = next;
            toast(`Macro ${index} saved`);
        } catch (e) {
            toast(`Save failed: ${e.message}`, true);
            return false;
        } finally {
            this.app.hid.resume();
        }
        this.render();
        return true;
    }

    _edit(index) {
        const input = el('input', {
            type: 'text', class: 'macro-input step-text', value: macroToText(this.macros[index]),
            placeholder: 'Text to type, e.g. chowd198@umn.edu', style: 'width:100%',
        });
        const commit = async (sh) => { if (await this._save(index, input.value)) sh.close(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(sheet); });
        const sheet = openSheet(`Macro M${index}`, () => [
            el('div', { class: 'note faint', text:
                'Type text a button can play back. Non-typeable bytes are written as \\xNN, and anything '
                + "recorded in Keychron's app is preserved exactly as it was." }),
            input,
            el('div', { class: 'usage', text: `${this.used} of ${this.bufferSize} bytes used across all macros` }),
        ], (sh) => [
            el('button', { class: 'btn', text: 'Cancel', onclick: () => sh.close() }),
            el('button', { class: 'btn primary', text: 'Save macro', onclick: () => commit(sh) }),
        ]);
        input.focus();
    }

    render() {
        this.root.replaceChildren(card('Macros', `${this.count} slots · ${this.used}/${this.bufferSize} bytes used`,
            el('div', { class: 'note faint', text: 'Click a macro to paste it onto the selected key in the Keymap tab. The pencil edits it.' }),
            tileGrid(...this.macros.map((m, i) => tile({
                name: `M${i}`, sub: summary(m) || 'empty', empty: !m.length,
                caption: `Macro ${i}: ${summary(m) || 'empty'}. Click to paste onto the selected key.`,
                onPaste: () => pasteToKey(encode('macro', { slot: i }, 'nape')),
                onEdit: () => this._edit(i),
            })))));
    }
}
