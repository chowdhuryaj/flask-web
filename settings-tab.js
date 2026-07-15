// QMK Settings tab — catalog-driven (vialproto.js QMK_SETTINGS), gated by
// what the device's qmkSettingsQuery actually reports. Values persist
// immediately in firmware (qmk_settings_set → eeprom); no save bar.
// Port of AdeptCompanion QMKSettingsView.swift.

import { el, card, sliderRow, toggleRow, toast } from './ui.js?v=14';
import { QMK_SETTINGS } from './vialproto.js?v=14';

export class SettingsTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const { vial } = this.app;
        const supported = new Set(await vial.qmkSettingsQSIDs());
        if (!supported.size) {
            this.root.replaceChildren(card('QMK Settings', '',
                el('p', { class: 'muted', text: 'This firmware compiles no QMK settings.' })));
            return;
        }

        const groups = new Map();
        for (const desc of QMK_SETTINGS) {
            if (!supported.has(desc.qsid)) continue;
            if (!groups.has(desc.group)) groups.set(desc.group, []);
            groups.get(desc.group).push(desc);
        }
        // Anything the device reports that the catalog doesn't know → raw field.
        const known = new Set(QMK_SETTINGS.map((d) => d.qsid));
        const unknown = [...supported].filter((q) => !known.has(q));

        const cardsRow = el('div', { class: 'cards-row' });
        this.root.replaceChildren(cardsRow);

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
                    try { await vial.qmkSettingsReset(); toast('Reset — reloading'); await this.load(); }
                    catch (e) { toast(e.message, true); }
                },
            })));
    }
}
