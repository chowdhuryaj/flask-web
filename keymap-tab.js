// QMK/Vial keymap controller. The board, layer bar, selection, undo and the
// click-again popover live in board.js (spec §3.1, §3.3); this file reads and
// writes the device and docks the picker. renderKeyboardSVG moved to board.js
// and is re-exported so hud.js, the trainer and the RGB painter keep working.

import { el, toast, card } from './ui.js?v=49';
import { openPicker } from './binding-picker.js?v=1';
import { board, renderKeyboardSVG } from './board.js?v=1';
import { shell } from './app-shell.js?v=2';
import { encoderCount, setLayerName, applyStoredLayerNames } from './profiles.js?v=49';

export { renderKeyboardSVG };

export class KeymapTab {
    constructor(app) {
        this.app = app;             // { vial, profile, keymap, layerCount }
        this.root = el('div');
        this.encoders = [];
        this.adapter = this.#adapter();
    }

    async load() {
        const { app } = this;
        app.keymap = await app.vial.readKeymap(app.layerCount, app.profile.matrixRows, app.profile.matrixCols);
        this.encoders = [];
        const encs = encoderCount(app.profile);
        if (encs) {
            for (let l = 0; l < app.layerCount; l++) {
                const layer = [];
                for (let i = 0; i < encs; i++) layer.push(await app.vial.encoderGet(l, i));
                this.encoders.push(layer);
            }
        }
        applyStoredLayerNames(app.profile);   // offline workspaces freeze a profile copy
        board.bind(this.adapter);
        this.render();
    }

    kcAt(layer, row, col) { return this.app.keymap?.[layer]?.[row]?.[col] ?? 0; }

    // Compat for command-palette.js (layer picks) and older callers.
    get layer() { return board.layer; }
    set layer(i) { board.setLayer(i); }
    set selected(_) { board.select(null); }
    set showEmptyLayers(on) { if (on) board.showEmptyLayers(); }
    renderStrip() { board.refresh(); }
    renderBoard() { board.refresh(); }
    assign(kc) { return board.assign(kc); }

    /** Layers with something on them, plus layer 0 and whatever is open.
     * Computed from the LIVE keymap, never hardcoded: the baked default
     * drifts from EEPROM between re-bakes. KC_NO (0x0000) and KC_TRNS
     * (0x0001) are "nothing here". Twin of AppModel.nonEmptyLayers(). */
    #isEmpty(l) {
        const grid = this.app.keymap?.[l];
        return !grid?.some((row) => row.some((kc) => kc !== 0x0000 && kc !== 0x0001));
    }

    #adapter() {
        const tab = this;
        return {
            surface: 'qmk.key',
            encoderSurface: 'qmk.encoder',
            get app() { return tab.app; },
            get profile() { return tab.app.profile; },
            layers: () => Array.from({ length: tab.app.layerCount }, (_, index) => ({
                index, name: tab.app.profile.layerNames[index] ?? `Layer ${index}`, empty: tab.#isEmpty(index),
            })),
            bindingAt: (layer, sel) => (sel.kind === 'key'
                ? tab.kcAt(layer, sel.row, sel.col)
                : tab.encoders?.[layer]?.[sel.index]?.[sel.cw ? 'cw' : 'ccw'] ?? 0),
            async write(layer, sel, kc) {
                const { app } = tab;
                if (sel.kind === 'key') {
                    await app.vial.setKeycode(layer, sel.row, sel.col, kc);
                    app.keymap[layer][sel.row][sel.col] = kc;
                } else {
                    await app.vial.encoderSet(layer, sel.index, sel.cw, kc);
                    tab.encoders[layer][sel.index][sel.cw ? 'cw' : 'ccw'] = kc;
                }
                app.hud?.open && app.hud.render();
            },
            posOf: (sel) => (sel.kind === 'key' ? { row: sel.row, col: sel.col }
                : { encoder: sel.index, dir: sel.cw ? 'cw' : 'ccw' }),
            selOf: (pos) => (pos && typeof pos === 'object'
                ? ('encoder' in pos ? { kind: 'enc', index: pos.encoder, cw: pos.dir === 'cw' }
                    : { kind: 'key', row: pos.row, col: pos.col })
                : null),
            async renameLayer(layer, name) { setLayerName(tab.app.profile, layer, name); },
        };
    }

    render() {
        const { app } = this;
        const boardHost = el('div');
        const pickerHost = el('div');
        this.root.replaceChildren(
            card(app.profile.name, `${app.layerCount} layers`,
                boardHost,
                el('div', { class: 'faint', style: 'margin-top:6px; font-size:12px' },
                    'Click a key, then pick a keycode. Writes are live, no save step.'),
                pickerHost),
        );
        board.place(boardHost, shell.regions);
        this.closePicker?.();
        this.closePicker = openPicker({
            surface: 'qmk.key', host: 'docked', anchor: pickerHost, app,
            onPick: (kc) => board.assign(kc),
        });
    }
}
