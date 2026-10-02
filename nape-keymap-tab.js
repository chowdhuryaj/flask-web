// Keychron Nape Pro — keymap + settings tab.
//
// Model note (corrected 2026-07-26 at the bench): layers and angle snap are
// INDEPENDENT axes. Angle snap is the ball's direction lock in 45° steps, with a
// per-layer setting; layers are ordinary layers reached by layer keys. An
// earlier version of this file rendered layers AS orientations — that was wrong
// and is why the cards did not match the device.
//
// Physical button identity (M1/M2/01-04) is NOT inferred here. Columns are
// labelled by index until named at the bench, because guessing it once already
// produced a wrong map.

import { el, toast } from './ui.js?v=49';
import { board } from './board.js?v=1';
import { openPicker } from './binding-picker.js?v=1';
import { shell } from './app-shell.js?v=2';
import { KC, napeKeyLabel, setScrollMode } from './nape-proto.js?v=49';
import { napeProfile, saveKeyName, napeColLabel } from './nape.js?v=49';

let activeAbort = null;   // board listeners of the superseded instance

export class NapeKeymapTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.adapter = this._makeAdapter();
        activeAbort?.abort();
        activeAbort = new AbortController();
        const { signal } = activeAbort;
        board.addEventListener('select', () => this._renderNameRow(), { signal });
        board.addEventListener('layer', () => this._renderLayerNote(), { signal });
    }

    // Edited layer = the board's (defaults to the live one).
    get viewLayer() { return board.layer; }
    get sel() { const k = board.selectedKey(); return k ? { layer: k.layer, col: k.pos } : null; }

    _makeAdapter() {
        const tab = this;
        return {
            surface: 'nape.key',
            get app() { return tab.app; },
            get profile() { return { ...tab.app.profile, capAdapter: 'nape' }; },
            layers: () => tab.app.napeKeymap.map((_, index) => ({
                index, name: tab.app.profile.layerNames?.[index] ?? `Layer ${index}`,
                empty: false, live: index === tab.layer,
            })),
            bindingAt: (layer, sel) => tab.app.napeKeymap[layer]?.[sel.col] ?? 0,
            async write(layer, sel, keycode) {
                const { app } = tab;
                await app.nape.setKeycode(layer, sel.col, keycode);
                const back = await app.nape.getKeycode(layer, sel.col);   // echo is truth
                app.napeKeymap[layer][sel.col] = back;
                app.keymap[layer][0][sel.col] = back;
                app.hud?.open && app.hud.render();
                if (back !== keycode) toast(`Device stored ${napeKeyLabel(back)} instead`, true);
            },
            posOf: (sel) => sel.col,
            selOf: (pos) => (Number.isInteger(pos) ? { kind: 'key', row: 0, col: pos } : null),
        };
    }

    async load() {
        const app = this.app;
        app.hid.pause();
        try {
            const liveLayer = await app.nape.currentLayer();
            // Internal layers (10 = scroll) have no editable keymap — fall back
            // to layer 0 for editing and say so, rather than indexing undefined.
            this.internalLayer = liveLayer >= app.layerCount ? liveLayer : null;
            this.layer = this.internalLayer ? 0 : liveLayer;
            this.angle = await app.nape.angleSnap();
            this.layerAngles = await app.nape.layerAngleSnaps();
            this.battery = await app.nape.battery();
            this.dpi = await app.nape.dpi();
            this.force = await app.nape.forceGestureScroll();
        } finally {
            app.hid.resume();
        }
        board.bind(this.adapter);
        if (!this._shownOnce) { board.setLayer(this.layer); this._shownOnce = true; }
        this.render();
    }

    async _refresh(fn, okMsg) {
        try {
            await fn();
            if (okMsg) toast(okMsg);
        } catch (e) {
            toast(e.message, true);
        }
        await this.load();
    }

    // ---------- actions ----------

    async _scrollMode(mode, all) {
        const app = this.app;
        const layers = all ? app.napeKeymap.map((_, i) => i) : [this.layer];
        app.hid.pause();
        try {
            const edits = await setScrollMode(app.nape, app.napeKeymap, mode, { layers });
            for (const l of layers) app.keymap[l][0] = app.napeKeymap[l].slice();
            if (!edits.length) toast(`No scroll key on ${all ? 'any layer' : `layer ${this.layer}`}`);
            else toast(`Scroll is now ${mode} (${edits.length} key${edits.length > 1 ? 's' : ''})`);
        } catch (e) {
            toast(`Scroll mode failed: ${e.message}`, true);
        } finally {
            app.hid.resume();
        }
        this.render();
    }

    // ---------- render ----------

    _header() {
        const chip = (label, value) => el('div', { class: 'nape-chip' },
            el('span', { class: 'nape-chip-label', text: label }),
            el('span', { class: 'nape-chip-value', text: value }));
        return el('div', { class: 'nape-header' },
            chip('Firmware', this.app.napeFirmware ?? '—'),
            chip('Layer', this.internalLayer
                ? `${this.internalLayer} (scroll — editing layer 0)` : `${this.layer}`),
            chip('Angle snap', `${this.angle}°`),
            chip('DPI', `${this.dpi.value} (stage ${this.dpi.stage})`),
            chip('Battery', `${this.battery.percent}%${this.battery.state === 2 ? ' ⚡' : ''}`));
    }

    _scrollSection() {
        const has = this.app.napeKeymap[this.layer]?.includes(KC.scrollToggle) ? 'toggle'
            : this.app.napeKeymap[this.layer]?.includes(KC.scrollHold) ? 'hold' : null;
        const btn = (label, mode, all) => el('button', {
            class: 'btn' + (has === mode && !all ? ' active' : ''),
            text: label, onclick: () => this._scrollMode(mode, all),
        });
        return el('div', { class: 'nape-section' },
            el('h3', { text: 'Scroll key' }),
            el('p', { class: 'hint' },
                'Hold enters scroll while held; toggle latches until pressed again.'),
            el('div', { class: 'row' },
                btn('Hold', 'hold', false), btn('Toggle', 'toggle', false),
                el('span', { class: 'sep' }),
                btn('Hold everywhere', 'hold', true), btn('Toggle everywhere', 'toggle', true)),
            el('div', { class: 'row' },
                el('label', { class: 'check' },
                    el('input', {
                        type: 'checkbox', checked: this.force.scroll === 1,
                        onchange: (e) => this._refresh(
                            () => this.app.nape.setForceGestureScroll(
                                { ...this.force, scroll: e.target.checked ? 1 : 0 })),
                    }),
                    el('span', { text: 'Always scroll (ball is a permanent scroll wheel)' }))));
    }

    /** Name the selected button (M1, 03…). Names are labels only. */
    _renderNameRow() {
        if (!this._nameHost) return;
        const k = this.sel;
        if (!k) { this._nameHost.replaceChildren(); return; }
        const { layer, col } = k;
        const nameInput = el('input', {
            type: 'text', placeholder: 'name this button (M1, 03…)',
            value: napeColLabel(col).startsWith('col ') ? '' : napeColLabel(col),
        });
        let committed = false;   // Enter + blur both fire; commit exactly once
        const commit = () => {
            if (committed) return;
            committed = true;
            saveKeyName(col, nameInput.value.trim());
            this.app.profile = napeProfile();
            board.refresh();
            this._renderNameRow();
        };
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
        nameInput.addEventListener('blur', commit);
        this._nameHost.replaceChildren(el('div', { class: 'row' },
            el('h3', { text: `Layer ${layer}, ${napeColLabel(col)}` }), nameInput));
    }

    /** Layer-bar note: angle snap of the edited layer, and a switch button
     * when the device is on another layer. */
    _renderLayerNote() {
        const layer = board.layer;
        const kids = [el('span', { class: 'tag', text: `angle snap ${this.layerAngles?.[layer] ?? '—'}°` })];
        if (layer === this.layer) kids.push(el('span', { class: 'tag live', text: 'active on the device' }));
        else {
            kids.push(el('button', {
                class: 'btn small subtle', text: 'Switch device to this layer',
                onclick: () => this._refresh(() => this.app.nape.switchLayer(layer)),
            }));
        }
        board.setLayerBarNote(el('span', { class: 'row' }, ...kids));
    }

    render() {
        const boardHost = el('div');
        const pickerHost = el('div');
        this._nameHost = el('div');
        this.root.replaceChildren(
            this._header(),
            el('div', { class: 'nape-section' },
                el('h3', { text: 'Layers' }),
                boardHost,
                el('p', { class: 'board-hint',
                    text: 'Click a key, then pick a keycode; click it again for a popover.' }),
                this._nameHost),
            pickerHost,
            this._scrollSection(),
        );
        board.place(boardHost, shell.regions);
        this._renderLayerNote();
        this._renderNameRow();
        this.closePicker?.();
        this.closePicker = openPicker({
            surface: 'nape.key', host: 'docked', anchor: pickerHost, app: this.app,
            onPick: (kc) => board.assign(kc),
        });
    }
}
