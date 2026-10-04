// Svalboard › Keymap: the Vial dynamic keymap on the os-keys inspector
// pattern. The board, layer rail, selection and undo are board.js; the
// palette dock and the key inspector are keymap-dock.js / keymap-inspector.js
// with the 'qmk' adapter (u16 keycodes). This file reads every layer with
// Vial readKeymap and writes one key with Vial setKeycode.
//
// Vial writes are immediate and persistent: there is no Save / Discard, the
// state strip says "Applied live". Vial's layer count is compiled into the
// firmware, so no layer add / move / remove; a rename lives in the app
// (boards.js setLayerName). setKeycode needs no unlock.

import { el, toast, card } from './ui.js?v=77';
import { board } from './board.js?v=77';
import { shell } from './app-shell.js?v=77';
import { createDock } from './keymap-dock.js?v=77';
import { createInspector } from './keymap-inspector.js?v=77';
import { encode, describeBinding, setQmkLayerNames } from './behavior-catalog.js?v=77';
import { setLayerName, svalboardKeys } from './boards.js?v=77';

const KC_NO = 0x0000, KC_TRNS = 0x0001;
const isKeycode = (v) => Number.isInteger(v) && v >= 0 && v <= 0xFFFF;

export class QmkKeymapTab {
    constructor(app) {
        this.app = app;             // { vial, profile, layerCount, keymap, board }
        this._vial = app.vial;      // pinned: a write after reconnect must not reach the next board
        this.root = el('div');
        this.state = 'loading';     // loading | ready | error
        this.statusMsg = '';
        this.adapter = this._makeAdapter();
    }

    dispose() {
        this._shortcutAbort?.abort();
        this._dock?.dispose();
        this._inspector?.dispose();
    }

    async load() {
        const { app } = this;
        this.state = 'loading';
        this.render();
        try {
            const { matrixRows, matrixCols } = app.profile;
            app.keymap = await app.vial.readKeymap(app.layerCount, matrixRows, matrixCols);
        } catch (e) {
            this.state = 'error';
            this.statusMsg = `Could not read the keymap: ${e.message}`;
            this.render();
            return;
        }
        // HUD, trainer and the picker read the same names.
        setQmkLayerNames(app.profile.layerNames);
        this.state = 'ready';
        board.resetHistory();
        this.render();
        app.hud?.open && app.hud.render();
    }

    // Compat for the command palette and older callers.
    get layer() { return board.layer; }
    set layer(i) { board.setLayer(i); }
    assign(kc) { return board.assign(kc); }

    kcAt(layer, row, col) { return this.app.keymap?.[layer]?.[row]?.[col] ?? KC_NO; }

    /** Board position = index into the static layout (svalboard-layout.js),
     * stable across the five-key variant (hidden keys keep their index). */
    _allKeys() { return (this._all ??= svalboardKeys(false)); }

    _isEmpty(l) {
        const grid = this.app.keymap?.[l];
        return !grid?.some((row) => row.some((kc) => kc !== KC_NO && kc !== KC_TRNS));
    }

    /** The device write behind board.assign / undo / redo. */
    async _write(layer, sel, kc) {
        const { app } = this;
        if (!isKeycode(kc)) throw new Error('not a QMK keycode');
        if (app.vial !== this._vial) { toast('Keyboard changed: reopen the tab', true); return false; }
        await app.vial.setKeycode(layer, sel.row, sel.col, kc);
        app.keymap[layer][sel.row][sel.col] = kc;
        app.hud?.open && app.hud.render();
        toast(`${this.adapter.keyTitle(this.adapter.posOf(sel))} → ${describeBinding(kc, 'qmk')} (applied live)`);
        return true;
    }

    _makeAdapter() {
        const tab = this;
        const keys = () => tab.app.profile.keys;
        const index = (sel) => tab._allKeys().findIndex((k) => k.row === sel.row && k.col === sel.col);
        return {
            surface: 'qmk.key',
            get app() { return tab.app; },
            get readOnly() { return tab.state !== 'ready'; },
            get profile() { return { ...tab.app.profile, keys: keys() }; },
            layers: () => Array.from({ length: tab.app.layerCount }, (_, i) => ({
                index: i, id: i, name: tab.app.profile.layerNames[i] ?? `Layer ${i}`, empty: tab._isEmpty(i),
            })),
            bindingAt: (layer, sel) => tab.kcAt(layer, sel.row, sel.col),
            write: (layer, sel, kc) => tab._write(layer, sel, kc),
            validBinding: isKeycode,
            posOf: (sel) => index(sel),
            selOf: (pos) => {
                const k = Number.isInteger(pos) ? tab._allKeys()[pos] : null;
                return k ? { kind: 'key', row: k.row, col: k.col } : null;
            },
            /** "Left index · North" for a board position (inspector, toasts). */
            keyTitle: (pos) => tab._allKeys()[pos]?.label ?? `Key ${pos}`,
            async renameLayer(layer, name) {
                setLayerName(tab.app.profile, layer, name);
                setQmkLayerNames(tab.app.profile.layerNames);
                tab._dock?.refresh(tab.app);
            },
            // No layerOps: Vial's layer count is fixed by the firmware.
        };
    }

    render() {
        if (this.state !== 'ready') {
            shell.regions.side?.replaceChildren();
            shell.regions.boardState?.replaceChildren();
            this.root.replaceChildren(card('Keymap', 'Vial',
                el('p', { class: 'muted', text: this.state === 'error' ? this.statusMsg : 'Reading the keymap…' }),
                this.state === 'error' ? el('button', { class: 'btn small', text: 'Retry', onclick: () => this.load() }) : null));
            return;
        }
        this.root.replaceChildren(this._buildDock().root);
        board.bind(this.adapter);
        board.place(null, shell.regions);
        this._dock.refresh(this.app);
        const side = shell.regions.side;
        if (side) { side.replaceChildren(this._inspector.root); this._inspector.render(); }
        this._renderStateStrip();
    }

    _buildDock() {
        if (this._dock) return this._dock;
        this._dock = createDock({ app: this.app, assign: (kc) => board.assign(kc), surface: 'qmk.key' });
        this._inspector = createInspector({ app: this.app, dock: this._dock });
        this._installShortcuts();
        return this._dock;
    }

    /** "Applied live" in place of Save / Discard: Vial writes each key at once. */
    _renderStateStrip() {
        const host = shell.regions.boardState;
        if (!host) return;
        host.dataset.state = 'saved';
        host.replaceChildren(el('span', { class: 'dot', 'aria-hidden': 'true' }),
            el('span', { class: 'chip-live', 'data-live': '', text: 'Applied live: each key is written to the keyboard at once (no Save)' }));
    }

    /** Undo / redo, Esc, Delete: only while this tab shows, never in a field. */
    _installShortcuts() {
        this._shortcutAbort?.abort();
        this._shortcutAbort = new AbortController();
        window.addEventListener('keydown', (e) => {
            if (this.app?.palette?.open || e.defaultPrevented) return;
            if (!this.root.closest('.panel.active') || this.state !== 'ready') return;
            if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
            const mod = e.metaKey || e.ctrlKey;
            const k = e.key.toLowerCase();
            if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? board.redo() : board.undo()); }
            else if (mod && k === 'y') { e.preventDefault(); board.redo(); }
            else if (!mod && e.key === 'Escape') { if (this._inspector?.escape()) e.preventDefault(); }
            else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && board.selectedKey()) {
                e.preventDefault();
                board.assign(encode('trans', {}, 'qmk'), { advance: false });
            }
        }, { signal: this._shortcutAbort.signal });
    }
}
