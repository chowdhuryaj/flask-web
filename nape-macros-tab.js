// Keychron Nape Pro — macros tab.
//
// The device stores 16 macros end-to-end in one 2394-byte buffer, each
// terminated by 0x00, so a single macro cannot be written in isolation: the
// whole buffer is rewritten every save. Escapes recorded by Keychron's app are
// preserved verbatim rather than reinterpreted (see macroToText).

import { el, toast } from './ui.js?v=35';
import { macroToText, macroFromText } from './nape-proto.js?v=35';

export class NapeMacrosTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.editing = null;   // index being edited
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
            return;
        }
        const next = this.macros.slice();
        next[index] = bytes;
        const total = next.reduce((n, m) => n + m.length + 1, 0);
        if (total > this.bufferSize) {
            toast(`Too long — ${total} of ${this.bufferSize} bytes used across all macros`, true);
            return;
        }
        this.app.hid.pause();
        try {
            await this.app.nape.writeMacros(next, this.bufferSize);
            this.macros = next;
            this.editing = null;
            toast(`Macro ${index} saved`);
        } catch (e) {
            toast(`Save failed: ${e.message}`, true);
        } finally {
            this.app.hid.resume();
        }
        this.render();
    }

    _row(bytes, index) {
        const text = macroToText(bytes);
        const empty = bytes.length === 0;

        if (this.editing !== index) {
            return el('tr', { class: empty ? 'macro-empty' : '' },
                el('td', { class: 'macro-idx', text: `M${index}` }),
                el('td', { class: 'macro-text', text: empty ? 'Not set' : text }),
                el('td', { class: 'macro-len', text: empty ? '' : `${bytes.length} B` }),
                el('td', null, el('button', {
                    class: 'btn small', text: empty ? 'Add' : 'Edit',
                    onclick: () => { this.editing = index; this.render(); },
                })));
        }

        const input = el('input', {
            type: 'text', class: 'macro-input', value: text,
            placeholder: 'Text to type, e.g. chowd198@umn.edu',
        });
        let committed = false;      // Enter and blur both fire — commit once
        const commit = () => {
            if (committed) return;
            committed = true;
            this._save(index, input.value);
        };
        const cancel = () => {
            if (committed) return;
            committed = true;
            this.editing = null;
            this.render();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') cancel();
        });
        return el('tr', { class: 'macro-editing' },
            el('td', { class: 'macro-idx', text: `M${index}` }),
            el('td', { colspan: '2' }, input),
            el('td', null,
                el('button', { class: 'btn small primary', text: 'Save', onclick: commit }),
                el('button', { class: 'btn small', text: 'Cancel', onclick: cancel })));
    }

    render() {
        const rows = this.macros.map((m, i) => this._row(m, i));
        const pct = Math.round((this.used / this.bufferSize) * 100);
        this.root.replaceChildren(
            el('div', { class: 'nape-section' },
                el('h3', { text: 'Macros' }),
                el('p', { class: 'hint' },
                    'Type text a button can play back. Assign a macro to a button in the '
                    + 'Keymap tab. Non-typeable bytes are written as \\xNN, and anything '
                    + "recorded in Keychron's app is preserved exactly as it was."),
                el('table', { class: 'macro-table' },
                    el('tbody', null, ...rows)),
                el('p', { class: 'macro-usage' },
                    el('span', { class: 'macro-bar' },
                        el('span', { class: 'macro-bar-fill', style: `width:${pct}%` })),
                    el('span', { text: `${this.used} of ${this.bufferSize} bytes used` }))),
        );
    }
}
