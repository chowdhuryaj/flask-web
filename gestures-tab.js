// Gestures (Adept/Sval) + Mouse (wheel) Chords tabs. Ports of
// AdeptCompanion GesturesTab.swift / MouseChordsTab.swift.
//
// Slot keycode range depends on the firmware: up to Svalboard v15 both families
// fired via tap_code16, which MANGLED everything above basic+mods, so the picker
// restricted. From v16 they fire through vial_keycode_tap and the whole range
// works — hence caps.gestureAnyKeycode rather than a blanket restriction.

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=19';
import { kcCell, makePickerHost } from './picker.js?v=19';
import {
    CH, CH_BALL_LEFT, V, slot, GESTURE_DIRS, GESTURE_SETS, WC_BUTTONS,
} from './flaskproto.js?v=19';

const TAPPABLE = (kc) => kc > 0 && kc <= 0x1FFF; // basic + QK_MODS range
const TAP_NOTE = 'On this firmware gesture slots fire via tap_code16 — basic keys + modifier combos only';

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
        this.picker = makePickerHost({
            layerCount: this.app.layerCount,
            restrict: this.app.caps.gestureAnyKeycode ? null : TAPPABLE,
            note: TAP_NOTE,
        });
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

/**
 * Ball gestures: hold a button, roll a ball, fire a keycode.
 *
 * TWO INDEPENDENT TABLES on the Svalboard since v15 — 0x1C the left/scroll
 * ball, 0x27 the right/cursor ball — carrying identical value ids, so one
 * editor drives either by channel. The Adept has one ball and only ever serves
 * 0x1C. Each side is loaded on first view; loading both up front is 128 round
 * trips for a table the user may never open.
 */
export class ChordsTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.side = 0;
        this.sides = {};
    }

    _ch(side) { return side === 0 ? CH_BALL_LEFT : CH.ballGesturesRight; }

    async _loadSide(side) {
        const { flask } = this.app;
        const ch = this._ch(side);
        const st = {
            enabled: await flask.getU16(ch, V.wcEnabled),
            step: await flask.getU16(ch, V.wcStep),
            holdMs: await flask.getU16(ch, V.wcHoldMs),
            slots: [],
        };
        for (let b = 0; b < WC_BUTTONS; b++) {
            const dirs = [];
            for (let dir = 0; dir < 8; dir++) dirs.push(await flask.getU16(ch, slot.wheelChord(b, dir)));
            st.slots.push(dirs);
        }
        this.sides[side] = st;
    }

    async load() {
        const { flask, caps } = this.app;
        await this._loadSide(0);
        // Deferred click is NOT per-side despite living on both channels — one
        // physical button cannot defer on one ball and not the other, so both
        // channels back the same firmware flag.
        if (caps.deferredClick) this.defer = await flask.getU16(CH_BALL_LEFT, V.wcDeferClick);
        this.picker = makePickerHost({
            layerCount: this.app.layerCount,
            restrict: caps.gestureAnyKeycode ? null : TAPPABLE,
            note: TAP_NOTE,
        });
        this.render();
    }

    async setSlot(b, dir, kc) {
        try {
            await this.app.flask.setU16(this._ch(this.side), slot.wheelChord(b, dir), kc);
            this.sides[this.side].slots[b][dir] = kc;
            this.render();
        } catch (e) { toast(`Write failed: ${e.message}`, true); }
    }

    async _switchSide(side) {
        if (!this.sides[side]) {
            try { await this._loadSide(side); }
            catch (e) { toast(`Read failed: ${e.message}`, true); return; }
        }
        this.side = side;
        this.render();
    }

    render() {
        const { flask, caps } = this.app;
        const st = this.sides[this.side];
        const ch = this._ch(this.side);
        const c = card('Mouse chords', 'hold a button + roll the ball → keycode (click still clicks)');

        if (caps.rightBallGestures) {
            c.append(selectRow({
                label: 'Ball', hint: 'each ball has its own independent table',
                value: this.side,
                options: [{ value: 0, label: 'Left / scroll ball' },
                    { value: 1, label: 'Right / cursor ball' }],
                onChange: (v) => this._switchSide(Number(v)),
            }));
        }

        c.append(
            toggleRow({
                label: 'Enabled', value: st.enabled,
                onChange: (v) => flask.setU16(ch, V.wcEnabled, v ? 1 : 0),
            }),
            sliderRow({
                label: 'Step (counts)', hint: 'ball travel per fire', min: 50, max: 2000, step: 25,
                value: st.step,
                onChange: (v) => flask.setU16(ch, V.wcStep, v),
            }),
            sliderRow({
                label: 'Hold grace (ms)', min: 0, max: 1000, step: 10,
                value: st.holdMs,
                onChange: (v) => flask.setU16(ch, V.wcHoldMs, v),
            }));

        if (caps.deferredClick) {
            c.append(toggleRow({
                label: 'Defer the click', hint: 'both balls — the click belongs to the button, not a ball',
                value: this.defer,
                onChange: async (v) => {
                    const echoed = await flask.setU16(ch, V.wcDeferClick, v ? 1 : 0);
                    this.defer = echoed;
                    return echoed;
                },
            }));
        }

        c.append(
            slotGrid({
                title: '', rows: WC_BUTTONS,
                rowLabel: (r) => `BTN${r + 1}`,
                getKc: (r, dir) => st.slots[r][dir],
                onPick: (r, dir) => this.picker.request((kc) => this.setSlot(r, dir, kc)),
            }),
            el('div', { class: 'note faint', text: 'Motion is swallowed only while the held button has at least one bound direction on this ball.' }),
            // Saves BOTH channels when there are two: the deferred-click flag is
            // shared, so a one-channel save could leave it unpersisted.
            saveBar(async () => {
                await flask.save(CH_BALL_LEFT);
                if (caps.rightBallGestures) await flask.save(CH.ballGesturesRight);
            }));
        this.root.replaceChildren(c, this.picker.card);
    }
}
