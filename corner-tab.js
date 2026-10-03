// Svalboard › Combos › Chords: positional corner chords (channel 0x28, v17+).
// Port of AdeptCompanion CornerCombos.swift, re-based on protocol v27.
//
// POSITIONAL chords, not keycode ones: the firmware matches WHERE you pressed
// (row, col), so a chord keeps working when the keys under it are remapped.
// Outputs are universal since v19 (one keycode per chord on every layer; the
// [def, layer] frames ignore the layer byte, 0 is sent). Members resolve
// through the reference layer (0x0D, v24: layer 0).
//
// Def indices are a wire contract (corner_seed.h): 8 finger clusters x 6
// chords, index 5 = Centre + North since v27; 48-59 (thumb chords) are
// retired and never shown or written.
//
// NO channel SAVE here, ever, and no top-bar Save registration: each output
// SET persists itself, and a 0x28 SAVE hard-wedged the board (2026-08-14).
// FlaskProto.save and save-state refuse it too. Enabled and the chord window
// therefore apply live only (their persistence path is that SAVE).
//
// Phase B: chord boxes on the board (board.setChordBoxes) and the layer-bar
// note; this tab is the table view until then.

import { el, card, sliderRow, toggleRow, toast } from './ui.js?v=76';
import { CH_QMK, V_QMK, CC, ccDefName, ccRow, ccCol, ccRetired } from './flaskproto.js?v=76';
import { bindingCell, bindingText, pickKey, reloadRow } from './qmk-ui.js?v=76';

const KC_TRNS = 0x0001;

/** The layer byte of the [def, layer] frames; ignored by v19+ firmware. */
const UNIVERSAL_LAYER = 0;

export class CornerTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const { flask, caps } = this.app;
        const g = (id) => flask.getU16(CH_QMK.corner, id);
        this.defCount = Math.min(await g(V_QMK.ccDefCount), CC.total);
        this.enabled = (await g(V_QMK.ccEnabled)) !== 0;
        this.termMs = await g(V_QMK.ccTerm);
        this.misfires = await g(V_QMK.ccMisfires).catch(() => 0);
        this.unplaced = 0;
        if (caps.cornerSlotDiag) {
            this.unplaced = await g(V_QMK.ccUnplaced).catch(() => 0);
            this.slotsUsed = await g(V_QMK.ccSlotsUsed).catch(() => 0);
        }
        this.refLayer = caps.cornerRefLayer ? await g(V_QMK.ccRefLayer).catch(() => null) : null;

        this.defs = [];
        this.outputs = [];
        for (let def = 0; def < this.defCount; def++) {
            if (ccRetired(def)) { this.defs.push([]); this.outputs.push(0); continue; }
            // [def, p0, p1, flags]: positions packed (row << 3) | col.
            const geo = await flask.getBytes(CH_QMK.corner, V_QMK.ccDef, [def], 1).catch(() => null);
            this.defs.push(geo && geo.length >= 1 + CC.maxKeys
                ? Array.from(geo.slice(1, 1 + CC.maxKeys)).filter((p) => p !== CC.posNone) : []);
            const r = await flask.getBytes(CH_QMK.corner, V_QMK.ccOut, [def, UNIVERSAL_LAYER], 2).catch(() => null);
            this.outputs.push(r && r.length >= 4 ? (r[2] << 8) | r[3] : 0);
        }
        this.render();
    }

    _pick(def) {
        pickKey(this.app, 'qmk.cornerChord', this.outputs[def] ?? 0, `Chord: ${ccDefName(def)}`, (kc) => this._set(def, kc));
    }

    /** Bind a chord. KC_TRNS (or Clear) unbinds it. The SET persists itself. */
    async _set(def, keycode) {
        const kc = keycode || KC_TRNS;
        try {
            await this.app.flask.setBytes(CH_QMK.corner, V_QMK.ccOut,
                [def, UNIVERSAL_LAYER, kc >> 8, kc & 0xFF], 2);
            const r = await this.app.flask.getBytes(CH_QMK.corner, V_QMK.ccOut, [def, UNIVERSAL_LAYER], 2);
            this.outputs[def] = r.length >= 4 ? (r[2] << 8) | r[3] : 0;
        } catch (e) {
            toast(`Write failed: ${e.message}`, true);
            return;
        }
        this.render();
    }

    _cell(def) {
        const members = this.defs[def] ?? [];
        if (members.length < 2) {
            return el('span', { class: 'btn small faint', text: '—', style: 'width:64px; opacity:0.3',
                title: `${ccDefName(def)}: no switch positions defined in firmware` });
        }
        const kc = this.outputs[def] ?? 0;
        const unbound = !kc || kc === KC_TRNS;
        const where = members.map((p) => `r${ccRow(p)}c${ccCol(p)}`).join(' + ');
        const cell = bindingCell(unbound ? 0 : kc, () => this._pick(def),
            `${ccDefName(def)} (${where})${unbound ? ': unassigned, click to bind' : ` → ${bindingText(kc)}`}`);
        cell.style.width = '64px';
        cell.dataset.def = String(def);
        if (unbound) { cell.textContent = '+'; cell.style.opacity = '0.4'; }
        return cell;
    }

    _grid() {
        const wrap = el('div', { style: 'overflow-x:auto' });
        wrap.append(el('div', { class: 'row', style: 'gap:2px' },
            el('span', { class: 'faint', style: 'width:72px', text: 'Finger' }),
            ...CC.fingerChordNames.map((n) => el('span', {
                class: 'hint', style: 'width:64px; text-align:center; font-size:9px', text: n,
            }))));
        CC.clusterNames.forEach((cluster, ci) => {
            const row = el('div', { class: 'row', style: 'gap:2px' },
                el('span', { class: 'faint', style: 'width:72px', text: cluster }));
            for (let chord = 0; chord < CC.fingerChords; chord++) {
                const def = ci * CC.fingerChords + chord;
                row.append(def < this.defCount ? this._cell(def) : el('span', { style: 'width:64px' }));
            }
            wrap.append(row);
        });
        return wrap;
    }

    render() {
        const { flask } = this.app;
        const ref = this.refLayer != null
            ? (this.app.profile?.layerNames?.[this.refLayer] ?? `layer ${this.refLayer}`) : 'the reference layer';
        const c = card('Chords', 'press two switches in one cluster together',
            el('div', { class: 'note faint', text:
                'Positional chords: the keyboard matches WHERE you pressed, not what those keys send, '
                + 'so a chord keeps working when you remap the keys under it. One output per chord, the '
                + 'same on every layer. Clear a chord to unbind it.' }),
            toggleRow({
                label: 'Enabled', hint: 'applies live; not saved from here',
                value: this.enabled,
                onChange: async (v) => {
                    const echoed = await flask.setU16(CH_QMK.corner, V_QMK.ccEnabled, v ? 1 : 0);
                    this.enabled = !!echoed;
                    return echoed;
                },
            }),
            sliderRow({
                label: 'Chord window (ms)', hint: 'how close together the two presses must be; applies live',
                min: 0, max: 200, step: 1, value: this.termMs,
                onChange: (v) => flask.setU16(CH_QMK.corner, V_QMK.ccTerm, v),
            }),
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, 'Misfires',
                    el('span', { class: 'hint', text: 'chords that started and timed out; high means the window is too tight' })),
                el('span', { style: 'flex:1' }),
                el('span', { class: 'mono', text: String(this.misfires) }),
                el('button', {
                    class: 'btn small', text: 'Reset',
                    onclick: async () => {
                        try { await flask.setU16(CH_QMK.corner, V_QMK.ccMisfires, 0); this.misfires = 0; this.render(); }
                        catch (e) { toast(e.message, true); }
                    },
                })),
            // A chord with no combo slot does nothing and looks broken. Name
            // the reference layer the firmware reports (0x0D), never a guess.
            this.unplaced
                ? el('div', { class: 'note', style: 'color:var(--danger)', text:
                    `${this.unplaced} chord(s) will NOT fire. Either ${ref} has nothing (or KC_TRNS) under `
                    + 'one of their keys (chords read their member keys from there on every layer), '
                    + `or the slot budget ran out (${this.slotsUsed}/64 slots used).` })
                : (this.app.caps.cornerSlotDiag
                    ? el('div', { class: 'note faint', text: `${this.slotsUsed}/64 combo slots used. Members resolve through ${ref}.` })
                    : null),
            this._grid(),
            reloadRow(() => this.load(), 'Assignments are durable the moment they are written. This channel has no Save.'));
        this.root.replaceChildren(c);
    }
}
