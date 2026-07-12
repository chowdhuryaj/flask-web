// ZMK Gestures tab — flask_gestures runtime sets (channel 0x11, proto
// v10). ZMK-line module: hold the Flask Gesture key and stroke a ball; one
// typed output fires per ratchet-step of travel in the dominant of 8
// directions. Sets are live-switchable (the QMK set model, back after the
// kot149 stroke-count emulation); each set edits as a compass grid.

import { el, card, sliderRow, toggleRow, selectRow, toast } from './ui.js?v=11';
import { CH, V } from './flaskproto.js?v=11';
import { pickTypedOutput, outputLabel } from './zmk-leader-tab.js?v=11';
import { OUTPUT_ACTION, GESTURE_DIR_LABELS, encodeGestureSlot, decodeGestureSlot }
    from './zmk-output-codec.js?v=11';

// Compass placement: direction index (E SE S SW W NW N NE) → grid cell.
// 3x3 grid, center = the legend.
const COMPASS = [
    [1, 2], [2, 2], [2, 1], [2, 0], [1, 0], [0, 0], [0, 1], [0, 2],
];

const SET_HINTS = ['arrows', 'editing', 'media', 'tab-nav'];

export class ZmkGesturesTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.set = 0;
    }

    async load() {
        const { flask } = this.app;
        this.enabled = await flask.getU16(CH.gestures, V.gesturesEnabled);
        this.ratchet = await flask.getU16(CH.gestures, V.gesturesRatchetStep);
        this.activeSet = await flask.getU16(CH.gestures, V.gesturesActiveSet);
        this.setCount = await flask.getU16(CH.gestures, V.gesturesSetCount) || 8;
        this.macroSlots = this.app.caps.macros
            ? await flask.getU16(CH.macros, V.macrosSlotCount) : 0;
        this.set = Math.min(this.set, this.setCount - 1);
        await this.loadSet();
        this.render();
    }

    async loadSet() {
        const { flask, hid } = this.app;
        // HUD poll backs off for the 8-direction read (see combos tab note).
        hid?.pause?.();
        try {
            this.outputs = [];
            for (let dir = 0; dir < 8; dir++) {
                const r = await flask.getBytes(CH.gestures, V.gesturesSlot, [this.set, dir], 2);
                this.outputs.push(decodeGestureSlot(r));
            }
        } finally {
            hid?.resume?.();
        }
    }

    async writeDir(dir) {
        try {
            const r = await this.app.flask.setBytes(CH.gestures, V.gesturesSlot,
                encodeGestureSlot(this.set, dir, this.outputs[dir]), 2);
            this.outputs[dir] = decodeGestureSlot(r);
        } catch (e) {
            toast(`Gesture write failed: ${e.message}`, true);
        }
        this.render();
    }

    pickDir(dir) {
        const o = this.outputs[dir];
        pickTypedOutput(`Set ${this.set} · ${GESTURE_DIR_LABELS[dir]}`, o, this.macroSlots,
            (out) => {
                o.action = out.action;
                o.param = out.param;
                this.writeDir(dir);
            });
    }

    compass() {
        const grid = el('div', {
            style: 'display:grid; grid-template-columns:repeat(3, minmax(88px, 1fr));'
                + 'gap:6px; max-width:420px',
        });
        const cells = Array.from({ length: 9 }, () => null);
        for (let dir = 0; dir < 8; dir++) {
            const [r, c] = COMPASS[dir];
            const o = this.outputs[dir];
            const empty = o.action === OUTPUT_ACTION.none;
            cells[r * 3 + c] = el('button', {
                class: 'code',
                style: `min-height:52px; ${empty ? 'opacity:0.55' : ''}`,
                title: `${GESTURE_DIR_LABELS[dir]} — ${outputLabel(o)}`
                    + ((dir & 1) && empty ? ' (empty diagonal falls back to the nearest cardinal)' : ''),
                onclick: () => this.pickDir(dir),
            },
                el('div', { class: 'note faint', text: GESTURE_DIR_LABELS[dir] }),
                el('div', { text: outputLabel(o, { cap: true }) }));
        }
        cells[4] = el('div', {
            class: 'note faint',
            style: 'display:flex; align-items:center; justify-content:center; text-align:center',
            text: 'stroke direction',
        });
        grid.append(...cells);
        return grid;
    }

    setName(i) {
        return `Set ${i}${SET_HINTS[i] ? ` (${SET_HINTS[i]})` : ''}`;
    }

    render() {
        const { flask } = this.app;

        const controls = card('Runtime gestures',
            'hold the gesture key, stroke a ball — outputs fire per ratchet step',
            toggleRow({
                label: 'Gestures enabled',
                hint: 'master switch; the tables stay stored while off',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.gestures, V.gesturesEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            sliderRow({
                label: 'Ratchet step',
                hint: 'ball travel per fire — lower = more sensitive',
                min: 50, max: 2000, step: 10, value: this.ratchet,
                onChange: async (val) => {
                    this.ratchet = await flask.setU16(CH.gestures, V.gesturesRatchetStep, val);
                    return this.ratchet;
                },
            }),
            selectRow({
                label: 'Active set',
                hint: 'what a "Flask Gesture 255" key uses',
                value: this.activeSet,
                options: Array.from({ length: this.setCount }, (_, i) =>
                    ({ value: i, label: this.setName(i) })),
                onChange: async (val) => {
                    this.activeSet = await flask.setU16(CH.gestures, V.gesturesActiveSet, Number(val));
                    return this.activeSet;
                },
            }),
            el('div', { class: 'savebar' },
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Save to keyboard',
                    onclick: async () => {
                        try { await flask.save(CH.gestures); toast('Gesture sets saved'); }
                        catch (e) { toast(`Save failed: ${e.message}`, true); }
                    },
                })));

        const editor = card('Edit set',
            'each direction fires a keycode or plays a macro; empty diagonals fall back to cardinals',
            selectRow({
                label: 'Set', value: this.set,
                options: Array.from({ length: this.setCount }, (_, i) =>
                    ({ value: i, label: this.setName(i) })),
                onChange: async (val) => {
                    this.set = Number(val);
                    await this.loadSet();
                    this.render();
                },
            }),
            this.compass());

        this.root.replaceChildren(controls, editor);
    }
}
