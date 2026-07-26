// Keychron Nape Pro — settings tab: angle snap, gestures, combos, tap-holds, DPI.
//
// Every frame written here was read out of Keychron's own Launcher bundle
// (see ~/ZMK-Flask/Nape-Pro/NAPE-PROTOCOL.md §2.2), not inferred — so these
// write exactly what their app writes, and nothing here touches the radio,
// the bootloader, or whole-device config.

import { el, toast } from './ui.js?v=32';
import { KC, NAPE_COMBO_SLOTS } from './nape-proto.js?v=32';
import { buildNapeExport, applyNapeImport, downloadNapeExport } from './nape-export.js?v=32';
import { napeVisibleCols, napeColLabel } from './nape.js?v=32';

const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

// QMK modifier bits, as seen in the stock combo slot LCTL(V) = 0x0119.
const MODS = [
    { bit: 0x0100, name: 'Ctrl' }, { bit: 0x0200, name: 'Shift' },
    { bit: 0x0400, name: 'Alt' }, { bit: 0x0800, name: 'Gui' },
];

const BASIC_KEYS = [
    { kc: 0x0000, name: '(none)' },
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c, i) => ({ kc: 0x04 + i, name: c })),
    ...'1234567890'.split('').map((c, i) => ({ kc: 0x1E + i, name: c })),
    { kc: 0x0028, name: 'Enter' }, { kc: 0x0029, name: 'Escape' },
    { kc: 0x002A, name: 'Backspace' }, { kc: 0x002B, name: 'Tab' },
    { kc: 0x002C, name: 'Space' }, { kc: 0x004C, name: 'Delete' },
    { kc: 0x004A, name: 'Home' }, { kc: 0x004D, name: 'End' },
    { kc: 0x004B, name: 'Page Up' }, { kc: 0x004E, name: 'Page Down' },
    { kc: 0x004F, name: '→ Right' }, { kc: 0x0050, name: '← Left' },
    { kc: 0x0051, name: '↓ Down' }, { kc: 0x0052, name: '↑ Up' },
    ...Array.from({ length: 12 }, (_, i) => ({ kc: 0x3A + i, name: `F${i + 1}` })),
];

const baseName = (kc) =>
    BASIC_KEYS.find((k) => k.kc === (kc & 0xFF))?.name ?? `0x${(kc & 0xFF).toString(16)}`;

export function keycodeName(kc) {
    if (!kc) return '(none)';
    const mods = MODS.filter((m) => kc & m.bit).map((m) => m.name);
    return [...mods, baseName(kc)].join('+');
}

/** Base-key dropdown + modifier checkboxes; commits on change. */
function keycodeEditor(value, onChange) {
    const sel = el('select', {
        onchange: (e) => onChange((value & 0xFF00) | parseInt(e.target.value, 10)),
    }, ...BASIC_KEYS.map((k) => el('option', {
        value: String(k.kc), text: k.name, selected: (value & 0xFF) === k.kc,
    })));
    const boxes = MODS.map((m) => el('label', { class: 'check tiny' },
        el('input', {
            type: 'checkbox', checked: !!(value & m.bit),
            onchange: (e) => onChange(e.target.checked ? value | m.bit : value & ~m.bit),
        }),
        el('span', { text: m.name })));
    return el('span', { class: 'kc-editor' }, sel, ...boxes);
}

export class NapeSettingsTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
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
            this.dpi = await app.nape.dpi();
            this.gestures = await app.nape.gestures();
            this.combos = await app.nape.combos(NAPE_COMBO_SLOTS);
            this.showAllCombos = this.showAllCombos || false;
            this.tapholds = {};
            for (const c of napeVisibleCols()) {
                this.tapholds[c] = await app.nape.taphold(this.layer, c);
            }
        } finally {
            app.hid.resume();
        }
        this.render();
    }

    async _do(fn, okMsg) {
        try {
            await fn();
            if (okMsg) toast(okMsg);
        } catch (e) {
            toast(e.message, true);
        }
        await this.load();
    }

    // ---------- sections ----------

    _angle() {
        return el('div', { class: 'nape-section' },
            el('h3', { text: 'Angle snap' }),
            el('p', { class: 'hint' },
                'Direction lock for the ball, in 45° steps. Independent of layers.'),
            el('div', { class: 'row' }, ...ANGLES.map((deg) => el('button', {
                class: 'btn' + (deg === this.angle ? ' active' : ''),
                text: `${deg}°`,
                onclick: () => this._do(() => this.app.nape.setAngleSnap(deg)),
            }))));
    }

    _gestures() {
        const row = (dir, label) => el('div', { class: 'row' },
            el('span', { class: 'gest-label', text: label }),
            keycodeEditor(this.gestures[dir], (v) => this._do(
                () => this.app.nape.setGestures({ ...this.gestures, [dir]: v }),
                `Gesture ${label} → ${keycodeName(v)}`)));
        return el('div', { class: 'nape-section' },
            el('h3', { text: 'Ball gestures' }),
            el('p', { class: 'hint' }, 'Flick the ball in a direction to send a key.'),
            row('up', 'Up'), row('down', 'Down'), row('left', 'Left'), row('right', 'Right'));
    }

    _combos() {
        const isEmpty = (c) => !c.cols && !c.tap && !c.held;
        const populated = this.combos.filter((c) => !isEmpty(c));
        const firstFree = this.combos.find(isEmpty);
        const shown = this.showAllCombos ? this.combos
            : populated.concat(firstFree && !this.showAllCombos ? [] : []);
        const rows = shown.map((c) => {
            const colBoxes = napeVisibleCols().map((i) => el('label', { class: 'check tiny' },
                el('input', {
                    type: 'checkbox', checked: !!(c.cols & (1 << i)),
                    onchange: (e) => this._do(() => this.app.nape.setCombo({
                        ...c, cols: e.target.checked ? c.cols | (1 << i) : c.cols & ~(1 << i),
                    })),
                }),
                el('span', { text: napeColLabel(i) })));
            const empty = !c.cols && !c.tap && !c.held;
            return el('div', { class: 'combo-row' + (empty ? ' empty' : '') },
                el('div', { class: 'row' },
                    el('strong', { text: `Slot ${c.index}` }),
                    el('span', { class: 'muted', text: 'keys:' }), ...colBoxes,
                    el('span', { class: 'muted', text: `layer ${c.layer}` }),
                    el('button', {
                        class: 'btn small', text: 'Delete',
                        onclick: () => this._do(() => this.app.nape.deleteCombo(c.index),
                            `Combo ${c.index} deleted`),
                    })),
                el('div', { class: 'row' },
                    el('span', { class: 'gest-label', text: 'Tap' }),
                    keycodeEditor(c.tap, (v) => this._do(() => this.app.nape.setCombo({ ...c, tap: v }))),
                    el('span', { class: 'gest-label', text: 'Hold' }),
                    keycodeEditor(c.held, (v) => this._do(() => this.app.nape.setCombo({ ...c, held: v }))),
                    el('span', { class: 'muted', text: `${c.timeout} ms` })));
        });
        return el('div', { class: 'nape-section' },
            el('h3', { text: 'Combos' }),
            el('p', { class: 'hint' },
                'Press several buttons together. Tap fires on release, hold fires when '
                + `held past the timeout. ${populated.length} of ${NAPE_COMBO_SLOTS} slots in use.`),
            rows.length ? el('div', null, ...rows) : el('p', { class: 'empty-note',
                text: 'No combos yet. Add one to fire a key from two buttons pressed together.' }),
            el('div', { class: 'row' },
                firstFree && !this.showAllCombos ? el('button', {
                    class: 'btn', text: 'Add combo',
                    onclick: () => {
                        this.showAllCombos = true;
                        this.render();
                    },
                }) : null,
                el('button', {
                    class: 'btn subtle',
                    text: this.showAllCombos ? 'Show only used slots'
                        : `Show all ${NAPE_COMBO_SLOTS} slots`,
                    onclick: () => { this.showAllCombos = !this.showAllCombos; this.render(); },
                })));
    }

    _backup() {
        return el('div', { class: 'nape-section' },
            el('h3', { text: 'Backup' }),
            el('p', { class: 'hint' },
                'Saves the whole device — keymap, macros, combos, tap-holds, gestures and '
                + 'angle snap — to a file. Restoring writes only what differs.'),
            el('div', { class: 'row' },
                el('button', {
                    class: 'btn', text: 'Export to file',
                    onclick: () => this._export(),
                }),
                el('button', {
                    class: 'btn', text: 'Restore from file',
                    onclick: () => this._importPrompt(),
                })));
    }

    async _export() {
        try {
            const data = await buildNapeExport(this.app);
            downloadNapeExport(data);
            toast('Exported');
        } catch (e) {
            toast(`Export failed: ${e.message}`, true);
        }
    }

    _importPrompt() {
        const input = el('input', { type: 'file', accept: '.json' });
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            let data;
            try {
                data = JSON.parse(await file.text());
            } catch (e) {
                toast('That file is not valid JSON', true);
                return;
            }
            if (data.firmware && data.firmware !== this.app.napeFirmware) {
                const go = confirm(`This backup came from ${data.firmware}, the device runs `
                    + `${this.app.napeFirmware}. Keychron changes the stock keymap between `
                    + 'releases. Restore anyway?');
                if (!go) return;
            }
            try {
                const report = await applyNapeImport(this.app, data);
                const bad = report.filter((r) => !r.ok);
                toast(bad.length
                    ? `Restored with ${bad.length} problem(s): ${bad.map((b) => b.name).join(', ')}`
                    : `Restored: ${report.map((r) => r.name).join(', ')}`, bad.length > 0);
            } catch (e) {
                toast(`Restore failed: ${e.message}`, true);
            }
            await this.load();
        });
        input.click();
    }

    _tapholds() {
        const rows = napeVisibleCols().map((col) => {
            const t = this.tapholds[col];
            // A tap/hold entry only fires if the key itself is CUSTOM(41) — that
            // keycode is what tells the firmware to consult this table. Editing
            // the entry for any other key silently does nothing.
            const live = this.app.napeKeymap[this.layer]?.[col] === KC.tapHold;
            return el('div', { class: 'row' + (live ? '' : ' inert') },
            el('span', { class: 'gest-label', text: napeColLabel(col) }),
            el('span', { class: 'muted', text: 'tap' }),
            keycodeEditor(t.tap, (v) => this._do(
                () => this.app.nape.setTaphold({ layer: this.layer, col, tap: v, held: t.held }))),
            el('span', { class: 'muted', text: 'hold' }),
            keycodeEditor(t.held, (v) => this._do(
                () => this.app.nape.setTaphold({ layer: this.layer, col, tap: t.tap, held: v }))),
            (t.tap || t.held) ? el('button', {
                class: 'btn small', text: 'Clear',
                onclick: () => this._do(() => this.app.nape.deleteTaphold(this.layer, col)),
            }) : null,
            live ? null : el('button', {
                class: 'btn small', text: 'Enable tap/hold here',
                title: 'Sets this key to the tap/hold keycode so the entry below takes effect',
                onclick: () => this._do(async () => {
                    await this.app.nape.setKeycode(this.layer, col, KC.tapHold);
                    const back = await this.app.nape.getKeycode(this.layer, col);
                    this.app.napeKeymap[this.layer][col] = back;
                    this.app.keymap[this.layer][0][col] = back;
                }, 'Tap/hold enabled on this key'),
            }));
        });
        return el('div', { class: 'nape-section' },
            el('h3', { text: `Tap / hold — layer ${this.layer}` }),
            el('p', { class: 'hint' },
                'Give one button two meanings: a tap sends one key, holding it sends another. '
                + 'Shown for the layer the device is on right now. A row only takes effect '
                + 'if that key is set to the tap/hold keycode — greyed rows are not wired up yet.'),
            ...rows);
    }

    _dpi() {
        return el('div', { class: 'nape-section' },
            el('h3', { text: 'DPI' }),
            el('p', { class: 'hint' },
                `Currently ${this.dpi.value} DPI, stage ${this.dpi.stage}. This firmware exposes no `
                + "DPI setter — Keychron's own app doesn't send one either. DPI changes by assigning "
                + 'a DPI keycode (Next DPI, Prev DPI, DPI loop, Custom DPI) to a button in the Keymap tab.'));
    }

    render() {
        this.root.replaceChildren(
            this._angle(), this._gestures(), this._combos(), this._tapholds(),
            this._dpi(), this._backup());
    }
}
