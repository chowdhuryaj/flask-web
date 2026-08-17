// Corner combos (channel 0x28, Svalboard v17+). Port of AdeptCompanion
// CornerCombos.swift.
//
// POSITIONAL chords, not keycode ones: the firmware matches on (row, col) and
// keeps one output per layer, unlike Vial's own combos which match keycodes and
// ignore layers. Two tables behind it — geometry (which switches form a chord)
// and a sparse (def, layer) → keycode map — and a layer with no entry of its own
// INHERITS from the layer below, exactly like KC_TRNS in the keymap. That is why
// every cell tracks two things: the resolved keycode (what would actually fire,
// which the device computes) and whether THIS layer owns the entry. A borrowed
// binding is drawn dimmed, so the two can never be merged.
//
// The desktop draws these as chips between the keycaps on its keymap canvas.
// Here they are a table grouped the way the firmware indexes them (cluster ×
// chord), which is also the .vil wire order — a chord is found by the finger it
// belongs to rather than by hunting the board picture.

import { el, card, sliderRow, toggleRow, selectRow, toast } from './ui.js?v=34';
import { kcCell, makePickerHost } from './picker.js?v=34';
import { CH, V, CC, ccDefName, ccRow, ccCol } from './flaskproto.js?v=34';

/** Layer inherits again when the entry is cleared — KC_TRNS is how the
 * firmware spells "no entry of my own here". */
const KC_TRNS = 0x0001;

export class CornerTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.layer = 0;
        this.outputs = {}; // layer -> def -> resolved keycode
    }

    async load() {
        const { flask } = this.app;
        const g = (id) => flask.getU16(CH.corner, id);

        this.defCount = await g(V.ccDefCount);
        this.enabled = (await g(V.ccEnabled)) !== 0;
        this.termMs = await g(V.ccTerm);
        this.misfires = await g(V.ccMisfires).catch(() => 0);

        // Geometry + own-entry masks are layer-independent, so they load once.
        this.defs = [];
        this.ownLayers = [];
        for (let def = 0; def < this.defCount; def++) {
            // [def, p0, p1, flags] — positions packed (row << 3) | col.
            const geo = await flask.getBytes(CH.corner, V.ccDef, [def], 1).catch(() => null);
            this.defs.push(geo && geo.length >= 1 + CC.maxKeys
                ? Array.from(geo.slice(1, 1 + CC.maxKeys))
                : new Array(CC.maxKeys).fill(CC.posNone));
            // [def, maskHi, maskLo] — bit N set = layer N carries its OWN entry.
            const mask = await flask.getBytes(CH.corner, V.ccLayers, [def], 1).catch(() => null);
            this.ownLayers.push(mask && mask.length >= 3 ? (mask[1] << 8) | mask[2] : 0);
        }

        await this._loadOutputs(this.layer);
        this.picker = makePickerHost({ layerCount: this.app.layerCount });
        this.render();
    }

    /** Resolved keycode per chord on one layer — inheritance already applied
     * device-side, so this is "what would fire", not "what is stored here". */
    async _loadOutputs(layer) {
        const { flask } = this.app;
        const row = {};
        for (let def = 0; def < this.defCount; def++) {
            const r = await flask.getBytes(CH.corner, V.ccOut, [def, layer], 2).catch(() => null);
            if (r && r.length >= 4) row[def] = (r[2] << 8) | r[3];
        }
        this.outputs[layer] = row;
    }

    _isOwn(def, layer) {
        return layer < 16 && (this.ownLayers[def] & (1 << layer)) !== 0;
    }

    _members(def) {
        return (this.defs[def] || []).filter((p) => p !== CC.posNone);
    }

    /** Bind a chord on the shown layer. KC_TRNS clears the entry so the layer
     * inherits again — that is how "un-override" is expressed. */
    async _set(def, keycode) {
        const { flask } = this.app;
        try {
            await flask.setBytes(CH.corner, V.ccOut,
                [def, this.layer, keycode >> 8, keycode & 0xFF], 2);
        } catch (e) {
            toast(`Write failed: ${e.message}`, true);
            return;
        }
        // NO channel save here, ever. The firmware persists this one 4-byte
        // entry inside the SET itself; asking for a channel save writes the
        // whole ~1.9 KB corner block, and on the RP2040 that window (flash
        // writes run with XIP disabled) hard-wedged the board on 2026-08-14.
        if (def < this.ownLayers.length && this.layer < 16) {
            if (keycode === KC_TRNS) this.ownLayers[def] &= ~(1 << this.layer);
            else this.ownLayers[def] |= (1 << this.layer);
        }
        await this._loadOutputs(this.layer);
        this.render();
    }

    async _switchLayer(layer) {
        this.layer = layer;
        if (!this.outputs[layer]) {
            try { await this._loadOutputs(layer); }
            catch (e) { toast(`Read failed: ${e.message}`, true); return; }
        }
        this.render();
    }

    /** One chord cell, carrying its own-vs-inherited-vs-unbound state. */
    _cell(def) {
        const members = this._members(def);
        if (members.length < 2) {
            return el('span', {
                class: 'code faint', text: '—', style: 'width:56px; opacity:0.3',
                title: `${ccDefName(def)} — no switch positions defined in firmware`,
            });
        }
        const kc = this.outputs[this.layer]?.[def] ?? 0;
        const own = this._isOwn(def, this.layer);
        const unbound = kc === 0 && !own;
        const inherited = !own && !unbound;
        const where = members.map((p) => `r${ccRow(p)}c${ccCol(p)}`).join(' + ');
        const title = `${ccDefName(def)} (${where})`
            + (unbound ? ' — unassigned, click to bind'
                : inherited ? ' — inherited from a lower layer' : '');

        const cell = kcCell(unbound ? 0 : kc,
            () => this.picker.request((picked) => this._set(def, picked)), title);
        cell.style.width = '56px';
        if (unbound) { cell.textContent = '+'; cell.style.opacity = '0.35'; }
        else if (inherited) { cell.style.opacity = '0.55'; cell.style.borderStyle = 'dashed'; }
        return cell;
    }

    _grid(title, clusterNames, chordNames, defBase) {
        const wrap = el('div', { style: 'overflow-x:auto' });
        const head = el('div', { class: 'row', style: 'gap:2px' },
            el('span', { class: 'faint', style: 'width:72px', text: title }));
        for (const n of chordNames) {
            head.append(el('span', {
                class: 'hint', style: 'width:56px; text-align:center; font-size:9px', text: n,
            }));
        }
        wrap.append(head);
        clusterNames.forEach((cluster, ci) => {
            const row = el('div', { class: 'row', style: 'gap:2px' },
                el('span', { class: 'faint', style: 'width:72px', text: cluster }));
            for (let chord = 0; chord < chordNames.length; chord++) {
                row.append(this._cell(defBase + ci * chordNames.length + chord));
            }
            wrap.append(row);
        });
        return wrap;
    }

    render() {
        const { flask } = this.app;
        const c = card('Corner combos', 'press two switches in one cluster together',
            el('div', { class: 'note faint' },
                'Positional chords: the keyboard matches WHERE you pressed, not what those keys '
                + 'send, so a chord keeps working when you remap the keys under it. Each chord has '
                + 'one output per layer, and a layer with no output of its own inherits from the '
                + 'layer below — pick ▽ (Transparent) to hand a layer back to inheritance.'),
            toggleRow({
                label: 'Enabled', value: this.enabled,
                onChange: async (v) => {
                    const echoed = await flask.setU16(CH.corner, V.ccEnabled, v ? 1 : 0);
                    this.enabled = !!echoed;
                    return echoed;
                },
            }),
            sliderRow({
                label: 'Chord window (ms)', hint: 'how close together the two presses must be',
                min: 0, max: 200, step: 1, value: this.termMs,
                onChange: (v) => flask.setU16(CH.corner, V.ccTerm, v),
            }),
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, 'Misfires',
                    el('span', { class: 'hint', text: 'chords that started and timed out — high means the window is too tight' })),
                el('span', { style: 'flex:1' }),
                el('span', { class: 'mono', text: String(this.misfires) }),
                el('button', {
                    class: 'btn small', text: 'Reset',
                    onclick: async () => {
                        try {
                            await flask.setU16(CH.corner, V.ccMisfires, 0);
                            this.misfires = 0;
                            this.render();
                        } catch (e) { toast(e.message, true); }
                    },
                })),
            selectRow({
                label: 'Layer', hint: 'outputs below are for this layer',
                value: this.layer,
                options: Array.from({ length: this.app.layerCount || 16 }, (_, i) =>
                    ({ value: i, label: this.app.profile?.layerNames?.[i] ?? `Layer ${i}` })),
                onChange: (v) => this._switchLayer(Number(v)),
            }),
            this._grid('Finger', CC.clusterNames, CC.fingerChordNames, 0),
            this._grid('Thumb', ['L thumb', 'R thumb'], CC.thumbChordNames, CC.thumbBase),
            // Deliberately NO save bar — see the comment in _set().
            el('div', { class: 'note faint', text: 'Assignments are durable the moment they are written — this channel has no separate Save.' }));
        this.root.replaceChildren(c, this.picker.card);
    }
}
