// Gestures (Adept/Sval) + Mouse (wheel) Chords tabs. Ports of
// AdeptCompanion GesturesTab.swift / MouseChordsTab.swift.
// Both slot families fire via tap_code16 in firmware — basic keycodes and
// C()/S()/A()/G() combos only; no macros, layer keys, or QK_KB customs.

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=5';
import { kcCell, makePickerHost } from './picker.js?v=5';
import { CH, V, slot, GESTURE_DIRS, GESTURE_SETS, WC_BUTTONS } from './flaskproto.js?v=5';

const TAPPABLE = (kc) => kc > 0 && kc <= 0x1FFF; // basic + QK_MODS range
const TAP_NOTE = 'Gesture/chord slots fire via tap_code16 — basic keys + modifier combos only';

function slotGrid({ title, rows, rowLabel, getKc, onPick }) {
    const table = el('div', { style: 'overflow-x:auto' });
    const head = el('div', { class: 'row', style: 'gap:2px' },
        el('span', { class: 'faint', style: 'width:52px', text: title }));
    for (const d of GESTURE_DIRS) head.append(el('span', { class: 'hint', style: 'width:48px; text-align:center', text: d }));
    table.append(head);
    for (let r = 0; r < rows; r++) {
        const row = el('div', { class: 'row', style: 'gap:2px' },
            el('span', { class: 'faint', style: 'width:52px', text: rowLabel(r) }));
        for (let dir = 0; dir < 8; dir++) {
            const cell = kcCell(getKc(r, dir), () => onPick(r, dir));
            cell.style.width = '48px';
            row.append(cell);
        }
        table.append(row);
    }
    return table;
}

export class GesturesTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { flask } = this.app;
        this.slots = [];
        for (let set = 0; set < GESTURE_SETS; set++) {
            const dirs = [];
            for (let dir = 0; dir < 8; dir++) dirs.push(await flask.getU16(CH.gestures, slot.gesture(set, dir)));
            this.slots.push(dirs);
        }
        this.ratchet = await flask.getU16(CH.gestures, V.gesturesRatchetStep);
        this.active = await flask.getU16(CH.gestures, V.gesturesActiveSet);
        this.picker = makePickerHost({ layerCount: this.app.layerCount, restrict: TAPPABLE, note: TAP_NOTE });
        this.render();
    }

    async setSlot(set, dir, kc) {
        try {
            await this.app.flask.setU16(CH.gestures, slot.gesture(set, dir), kc);
            this.slots[set][dir] = kc;
            this.render();
        } catch (e) { toast(`Write failed: ${e.message}`, true); }
    }

    render() {
        const { flask } = this.app;
        const c = card('Ball gestures', '8 sets × 8 directions — flick the ball, fire a key',
            sliderRow({ label: 'Ratchet step (counts)', hint: 'ball travel per repeat', min: 1, max: 2000, step: 5,
                value: this.ratchet,
                onChange: (v) => flask.setU16(CH.gestures, V.gesturesRatchetStep, v) }),
            selectRow({
                label: 'Active set', hint: 'GR1–GR8 keycodes toggle these from the keymap',
                value: this.active > 7 ? 0xFF : this.active,
                options: [{ value: 0xFF, label: 'None' },
                    ...Array.from({ length: GESTURE_SETS }, (_, i) => ({ value: i, label: `Set ${i + 1}` }))],
                onChange: async (v) => {
                    // SET 0xFF cancels; an index toggles through the firmware
                    // guard (an all-empty set refuses to latch ON).
                    await flask.setU16(CH.gestures, V.gesturesActiveSet, Number(v));
                    this.active = await flask.getU16(CH.gestures, V.gesturesActiveSet);
                },
            }),
            slotGrid({
                title: '', rows: GESTURE_SETS,
                rowLabel: (r) => `Set ${r + 1}`,
                getKc: (r, dir) => this.slots[r][dir],
                onPick: (r, dir) => this.picker.request((kc) => this.setSlot(r, dir, kc)),
            }),
            el('div', { class: 'note faint', text: 'Empty diagonals fall back to the nearest cardinal, so 4-way sets keep their feel.' }),
            saveBar(() => flask.save(CH.gestures)));
        this.root.replaceChildren(c, this.picker.card);
    }
}

export class ChordsTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { flask } = this.app;
        this.enabled = await flask.getU16(CH.wheelChords, V.wcEnabled);
        this.step = await flask.getU16(CH.wheelChords, V.wcStep);
        this.holdMs = await flask.getU16(CH.wheelChords, V.wcHoldMs);
        this.slots = [];
        for (let b = 0; b < WC_BUTTONS; b++) {
            const dirs = [];
            for (let dir = 0; dir < 8; dir++) dirs.push(await flask.getU16(CH.wheelChords, slot.wheelChord(b, dir)));
            this.slots.push(dirs);
        }
        this.picker = makePickerHost({ layerCount: this.app.layerCount, restrict: TAPPABLE, note: TAP_NOTE });
        this.render();
    }

    async setSlot(b, dir, kc) {
        try {
            await this.app.flask.setU16(CH.wheelChords, slot.wheelChord(b, dir), kc);
            this.slots[b][dir] = kc;
            this.render();
        } catch (e) { toast(`Write failed: ${e.message}`, true); }
    }

    render() {
        const { flask } = this.app;
        const c = card('Mouse chords', 'hold a button + roll the ball → keycode (click still clicks)',
            toggleRow({ label: 'Enabled', value: this.enabled,
                onChange: (v) => flask.setU16(CH.wheelChords, V.wcEnabled, v ? 1 : 0) }),
            sliderRow({ label: 'Step (counts)', hint: 'ball travel per fire', min: 50, max: 2000, step: 25,
                value: this.step,
                onChange: (v) => flask.setU16(CH.wheelChords, V.wcStep, v) }),
            sliderRow({ label: 'Hold grace (ms)', min: 0, max: 1000, step: 10,
                value: this.holdMs,
                onChange: (v) => flask.setU16(CH.wheelChords, V.wcHoldMs, v) }),
            slotGrid({
                title: '', rows: WC_BUTTONS,
                rowLabel: (r) => `BTN${r + 1}`,
                getKc: (r, dir) => this.slots[r][dir],
                onPick: (r, dir) => this.picker.request((kc) => this.setSlot(r, dir, kc)),
            }),
            el('div', { class: 'note faint', text: 'Motion is swallowed only while the held button has at least one bound direction.' }),
            saveBar(() => flask.save(CH.wheelChords)));
        this.root.replaceChildren(c, this.picker.card);
    }
}
