// Svalboard › Settings: QMK settings (catalog-driven, vialproto.js
// QMK_SETTINGS, gated by what qmkSettingsQuery reports; values persist
// immediately via Vial), the Vial lock, and the board record from the meta
// channel (v25 variant / cluster keys / drops, v26 half).
// Port of AdeptCompanion QMKSettingsView.swift.

import { el, card, sliderRow, toggleRow, selectRow, reloadBar, toast } from './ui.js?v=76';
import { QMK_SETTINGS } from './vialproto.js?v=76';
import { CH_QMK, V_QMK } from './flaskproto.js?v=76';
import { BOARD_VARIANTS, readBoardMeta } from './boards.js?v=76';
import { runUnlockFlow, lockKeyboard } from './unlock.js?v=76';

export class SettingsTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const { vial } = this.app;
        const cardsRow = el('div', { class: 'cards-row' });
        this.root.replaceChildren(cardsRow);
        cardsRow.append(await this._boardCard(), this._lockCard());

        const supported = new Set(await vial.qmkSettingsQSIDs());
        if (!supported.size) {
            cardsRow.append(card('QMK Settings', '',
                el('p', { class: 'muted', text: 'This firmware compiles no QMK settings.' })));
            return;
        }
        const groups = new Map();
        for (const desc of QMK_SETTINGS) {
            if (!supported.has(desc.qsid)) continue;
            if (!groups.has(desc.group)) groups.set(desc.group, []);
            groups.get(desc.group).push(desc);
        }
        // Anything the device reports that the catalog doesn't know → listed raw.
        const known = new Set(QMK_SETTINGS.map((d) => d.qsid));
        const unknown = [...supported].filter((q) => !known.has(q));

        for (const [group, descs] of groups) {
            const c = card(group, 'persists immediately');
            for (const desc of descs) {
                let value;
                try { value = await vial.qmkSettingGet(desc.qsid, desc.width); }
                catch { continue; }
                if (desc.bool) {
                    c.append(toggleRow({
                        label: desc.label, value,
                        onChange: async (v) => { await vial.qmkSettingSet(desc.qsid, desc.width, v ? 1 : 0); return v; },
                    }));
                } else if (desc.bits) {
                    let current = value;
                    for (const [bit, label] of desc.bits) {
                        c.append(toggleRow({
                            label, value: (current >> bit) & 1,
                            onChange: async (v) => {
                                current = v ? (current | (1 << bit)) : (current & ~(1 << bit));
                                await vial.qmkSettingSet(desc.qsid, desc.width, current >>> 0);
                                return v;
                            },
                        }));
                    }
                } else {
                    c.append(sliderRow({
                        label: desc.label, min: desc.min, max: desc.max, step: 1, value,
                        onChange: async (v) => { await vial.qmkSettingSet(desc.qsid, desc.width, v); return v; },
                    }));
                }
            }
            cardsRow.append(c);
        }
        if (unknown.length) {
            cardsRow.append(card('Other settings', 'reported by firmware, not in the catalog',
                el('p', { class: 'mono muted', text: 'QSIDs: ' + unknown.join(', ') })));
        }
        cardsRow.append(card('Reset', '',
            el('button', {
                class: 'btn danger', text: 'Reset all QMK settings to defaults',
                onclick: async () => {
                    if (!confirm('Reset every QMK setting on the keyboard to its default?')) return;
                    try { await vial.qmkSettingsReset(); toast('Reset, reloading'); await this.load(); }
                    catch (e) { toast(e.message, true); }
                },
            })));
    }

    /** Board record (meta 0x04-0x07). The variant is TOLD, not detected, and
     * persists only through a meta SAVE, so it rides the top-bar Save. */
    async _boardCard() {
        const { app } = this;
        const { flask, caps } = app;
        if (caps.flask) app.board = await readBoardMeta(flask, caps);
        const b = app.board ?? {};
        const ro = (label, value, hint) => el('div', { class: 'row' },
            el('span', { class: 'lbl' }, label, hint ? el('span', { class: 'hint', text: hint }) : null),
            el('span', { style: 'flex:1' }), el('span', { class: 'mono', text: value ?? '—' }));
        const c = card('Board', 'what this Svalboard is');
        if (caps.boardHalf) c.append(ro('Half', b.half === 1 ? 'Left' : b.half === 2 ? 'Right' : null, 'reported by the firmware'));
        if (caps.boardVariant) {
            c.append(selectRow({
                label: 'Finger clusters', hint: 'tell the board which one you have; it cannot detect it',
                value: b.variant ?? 0,
                options: Object.entries(BOARD_VARIANTS).map(([v, label]) => ({ value: v, label })),
                onChange: async (v) => {
                    const echoed = await flask.setU16(CH_QMK.meta, V_QMK.metaBoardVariant, Number(v));
                    app.board = await readBoardMeta(flask, caps);
                    if (echoed !== Number(v)) toast(`Board kept variant ${echoed}`, true);
                },
            }),
            ro('Keys per finger cluster', b.clusterKeys != null ? String(b.clusterKeys) : null),
            ro('Absent-key drops', b.absentDrops != null ? String(b.absentDrops) : null, 'presses on keys a five-key board does not have'),
            reloadBar(CH_QMK.meta, {
                reload: () => this.load(), save: () => flask.save(CH_QMK.meta),
                label: 'Board variant', line: 'qmk',
            }));
        } else {
            c.append(el('p', { class: 'muted', text: 'Board variant needs Flask protocol v25 or newer.' }));
        }
        return c;
    }

    _lockCard() {
        const { app } = this;
        const state = el('span', { class: 'mono', text: app.unlocked ? 'Unlocked' : 'Locked' });
        const sync = (u) => { app.unlocked = u; state.textContent = u ? 'Unlocked' : 'Locked'; };
        return card('Keyboard lock', 'Vial security',
            el('div', { class: 'note faint', text: 'Macro writes and the live key matrix need the keyboard unlocked. Unlocking asks you to hold keys on the board.' }),
            el('div', { class: 'row' },
                el('span', { class: 'lbl', text: 'State' }), el('span', { style: 'flex:1' }), state,
                el('button', { class: 'btn small', text: 'Unlock…', onclick: () => runUnlockFlow(app, sync) }),
                el('button', { class: 'btn small', text: 'Lock', onclick: () => lockKeyboard(app, sync) })));
    }
}
