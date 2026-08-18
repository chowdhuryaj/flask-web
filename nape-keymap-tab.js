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

import { el, toast } from './ui.js?v=41';
import { renderKeyboardSVG } from './keymap-tab.js?v=41';
import { KC, napeKeyLabel, setScrollMode } from './nape-proto.js?v=41';
import { buildKeycodePicker } from './nape-keypicker.js?v=41';
import { napeProfile, saveKeyName, napeColLabel } from './nape.js?v=41';

export class NapeKeymapTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.sel = null;      // { layer, col }
        this.viewLayer = null; // layer being edited; defaults to the live one
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
        if (this.viewLayer == null) this.viewLayer = this.layer;
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

    async _assign(layer, col, keycode) {
        const app = this.app;
        try {
            await app.nape.setKeycode(layer, col, keycode);
            const back = await app.nape.getKeycode(layer, col);   // echo is truth
            app.napeKeymap[layer][col] = back;
            app.keymap[layer][0][col] = back;
            if (back !== keycode) toast(`Device stored ${napeKeyLabel(back)} instead`, true);
        } catch (e) {
            toast(`Assign failed: ${e.message}`, true);
        }
        this.sel = null;
        this.render();
    }

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

    _picker() {
        if (!this.sel) return el('div');
        const { layer, col } = this.sel;
        const picker = buildKeycodePicker({
            value: this.app.napeKeymap[layer][col],
            layers: this.app.layerCount,
            macros: 16,
            onPick: (kc) => this._assign(layer, col, kc),
        });
        const nameInput = el('input', {
            type: 'text', placeholder: 'name this button (M1, 03…)',
            value: napeColLabel(col).startsWith('col ')
                ? '' : napeColLabel(col),
        });
        let committed = false;   // Enter + blur both fire; commit exactly once
        const commit = () => {
            if (committed) return;
            committed = true;
            saveKeyName(col, nameInput.value.trim());
            this.app.profile = napeProfile();
            this.render();
        };
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
        nameInput.addEventListener('blur', commit);
        return el('div', { class: 'nape-picker' },
            el('div', { class: 'row' },
                el('h3', { text: `Layer ${layer}, ${napeColLabel(col)}` }),
                nameInput,
                el('button', {
                    class: 'btn', text: 'Cancel',
                    onclick: () => { committed = true; this.sel = null; this.render(); },
                })),
            picker);
    }

    _layerBar() {
        return el('div', { class: 'layer-bar', role: 'tablist' },
            ...this.app.napeKeymap.map((_, l) => {
                const live = l === this.layer;
                const on = l === this.viewLayer;
                return el('button', {
                    class: 'layer-chip' + (on ? ' on' : '') + (live ? ' live' : ''),
                    role: 'tab',
                    'aria-selected': on ? 'true' : 'false',
                    title: live ? 'The device is on this layer now' : `Edit layer ${l}`,
                    onclick: () => { this.viewLayer = l; this.sel = null; this.render(); },
                }, el('span', { text: `L${l}` }),
                   el('span', { class: 'layer-chip-angle', text: `${this.layerAngles[l]}°` }));
            }));
    }

    _board() {
        const app = this.app;
        const layer = this.viewLayer;
        const svg = renderKeyboardSVG({
            profile: app.profile,
            scale: 1.15,
            keycodeAt: (_r, col) => app.napeKeymap[layer][col],
            selected: this.sel ? { kind: 'key', row: 0, col: this.sel.col } : null,
            onSelect: ({ col }) => { this.sel = { layer, col }; this.render(); },
        });
        return el('div', { class: 'board' },
            el('div', { class: 'board-head' },
                el('strong', { text: `Layer ${layer}` }),
                layer === this.layer
                    ? el('span', { class: 'tag live', text: 'active on the device' })
                    : el('button', {
                        class: 'btn small subtle', text: 'Switch device to this layer',
                        onclick: () => this._refresh(() => app.nape.switchLayer(layer)),
                    }),
                el('span', { class: 'tag', text: `angle snap ${this.layerAngles[layer]}°` })),
            svg,
            el('p', { class: 'board-hint',
                text: 'Click a key to reassign it. Double-click its name to rename the button.' }));
    }

    render() {
        this.root.replaceChildren(
            this._header(),
            this._picker(),
            this._scrollSection(),
            el('div', { class: 'nape-section' },
                el('h3', { text: 'Layers' }),
                this._layerBar(),
                this._board()),
        );
    }
}
