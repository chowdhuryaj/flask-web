// ZMK Gestures tab — flask_gestures runtime sets (channel 0x11, proto
// v10). ZMK-line module: hold the Flask Gesture key and stroke a ball; one
// typed output fires per ratchet-step of travel in the dominant of 8
// directions. Sets are live-switchable (the QMK set model, back after the
// kot149 stroke-count emulation); each set edits as a compass grid.
//
// 2026-07-12 round: the Active-set slider became a DROPDOWN listing only
// sets with at least one configured direction (an empty set as the active
// set does nothing — offering it was noise); sets are renamable (client-
// side names, same localStorage + export-v2 story as combo/macro renames);
// and the board render with the physical trackballs sits above the editor
// (both balls stroke gestures).

import { el, card, sliderRow, toggleRow, selectRow, toast, renameLabel } from './ui.js?v=12';
import { CH, V } from './flaskproto.js?v=12';
import { renderKeyboardSVG } from './keymap-tab.js?v=12';
import { zmkSlotName, zmkSetSlotName } from './zmk.js?v=12';
import { pickTypedOutput, outputLabel } from './zmk-leader-tab.js?v=12';
import { OUTPUT_ACTION, GESTURE_DIR_LABELS, encodeGestureSlot, decodeGestureSlot }
    from './zmk-output-codec.js?v=12';

// Compass placement: direction index (E SE S SW W NW N NE) → grid cell.
// 3x3 grid, center = the legend.
const COMPASS = [
    [1, 2], [2, 2], [2, 1], [2, 0], [1, 0], [0, 0], [0, 1], [0, 2],
];

// Firmware-seeded defaults for sets 0-3 (Adept lineage) — placeholder
// names only; a rename overrides them.
const SET_HINTS = ['arrows', 'editing', 'media', 'tab-nav'];

export class ZmkGesturesTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.set = 0;
        this.sets = [];     // [set][dir] typed outputs — all sets, cached
    }

    async load() {
        const { flask, hid } = this.app;
        this.enabled = await flask.getU16(CH.gestures, V.gesturesEnabled);
        this.ratchet = await flask.getU16(CH.gestures, V.gesturesRatchetStep);
        this.activeSet = await flask.getU16(CH.gestures, V.gesturesActiveSet);
        this.setCount = await flask.getU16(CH.gestures, V.gesturesSetCount) || 8;
        this.macroSlots = this.app.caps.macros
            ? await flask.getU16(CH.macros, V.macrosSlotCount) : 0;
        this.set = Math.min(this.set, this.setCount - 1);
        // All sets up front (setCount × 8 slot frames — same burst size as
        // the combos tab): blank-set detection for the Active-set dropdown
        // needs the whole table anyway, and set switching becomes free.
        hid?.pause?.();
        try {
            this.sets = [];
            for (let s = 0; s < this.setCount; s++) {
                const dirs = [];
                for (let dir = 0; dir < 8; dir++) {
                    const r = await flask.getBytes(CH.gestures, V.gesturesSlot, [s, dir], 2);
                    dirs.push(decodeGestureSlot(r));
                }
                this.sets.push(dirs);
            }
        } finally {
            hid?.resume?.();
        }
        this.render();
    }

    get outputs() { return this.sets[this.set]; }

    setIsBlank(i) {
        return !this.sets[i]?.some((o) => o.action !== OUTPUT_ACTION.none);
    }

    async writeDir(dir) {
        try {
            const r = await this.app.flask.setBytes(CH.gestures, V.gesturesSlot,
                encodeGestureSlot(this.set, dir, this.outputs[dir]), 2);
            this.sets[this.set][dir] = decodeGestureSlot(r);
        } catch (e) {
            toast(`Gesture write failed: ${e.message}`, true);
        }
        this.render();
    }

    pickDir(dir) {
        const o = this.outputs[dir];
        pickTypedOutput(`${this.setName(this.set)} · ${GESTURE_DIR_LABELS[dir]}`, o, this.macroSlots,
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

    /** Display name for a set: custom rename → hint → plain index. */
    setName(i) {
        const custom = zmkSlotName(this.app.profile?.family ?? 'imprint', 'gestureSets', i);
        if (custom) return custom;
        return `Set ${i}${SET_HINTS[i] ? ` (${SET_HINTS[i]})` : ''}`;
    }

    /** Board render with the trackballs — a gesture is a ball stroke, so
     * show where the balls physically sit (both do gestures). */
    boardCard() {
        const { profile } = this.app;
        if (!profile?.decorations?.length || !profile?.keys?.length) return null;
        return card('Trackballs', 'hold the gesture key and stroke EITHER ball',
            el('div', { style: 'overflow-x:auto' }, renderKeyboardSVG({
                profile,
                scale: 0.42,
                keycodeAt: () => null,
                decorationLabel: () => 'gesture',
            })));
    }

    render() {
        const { flask } = this.app;
        const fam = this.app.profile?.family ?? 'imprint';

        // Active set: only sets that DO something (plus the current value,
        // even if blank, so the dropdown never lies about device state).
        const activeOptions = Array.from({ length: this.setCount }, (_, i) => i)
            .filter((i) => !this.setIsBlank(i) || i === this.activeSet)
            .map((i) => ({
                value: i,
                label: this.setName(i) + (this.setIsBlank(i) ? ' — empty' : ''),
            }));

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
                hint: 'what a "Flask Gesture 255" key uses — only configured sets are offered',
                value: this.activeSet,
                options: activeOptions,
                onChange: async (val) => {
                    this.activeSet = await flask.setU16(CH.gestures, V.gesturesActiveSet, Number(val));
                    this.render();
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
            'each direction fires a keycode or plays a macro; empty diagonals fall back to cardinals — click the set name to rename',
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, renameLabel({
                    text: this.setName(this.set),
                    placeholder: `Set ${this.set}${SET_HINTS[this.set] ? ` (${SET_HINTS[this.set]})` : ''}`,
                    onCommit: (v) => { zmkSetSlotName(fam, 'gestureSets', this.set, v); this.render(); },
                }),
                    el('span', {
                        class: 'hint',
                        text: this.setIsBlank(this.set)
                            ? 'empty — assign a direction to make it selectable as Active'
                            : (this.set === this.activeSet ? 'active set' : ''),
                    })),
                el('span', { style: 'flex:1' })),
            selectRow({
                label: 'Set', value: this.set,
                options: Array.from({ length: this.setCount }, (_, i) =>
                    ({ value: i, label: this.setName(i) + (this.setIsBlank(i) ? ' — empty' : '') })),
                onChange: async (val) => {
                    this.set = Number(val);
                    this.render();
                },
            }),
            this.compass());

        this.root.replaceChildren(...[controls, this.boardCard(), editor].filter(Boolean));
    }
}
