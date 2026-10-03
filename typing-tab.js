// Svalboard › Device › Typing: getreuer modules (select word, sentence case),
// OS-aware shortcuts, num word, Cyclotab and alt-repeat behaviour (QMK line
// channels 0x17, 0x18, 0x1D, 0x1E, 0x23, 0x25). The snippet pool (0x24) was
// removed from the firmware at v18 and is not offered. Port of
// AdeptCompanion TypingTab.swift. Leader and shift keys live under
// Behaviours (qmk-leader-tab.js, qmk-shift-tab.js); Typing links to them.
//
// Reads every value ONCE into `this.s` and renders from that.

import { el, card, sliderRow, toggleRow, selectRow, reloadBar, toast } from './ui.js?v=76';
import { CH_QMK, V_QMK, slot, osName, CYCLOTAB_KEYS } from './flaskproto.js?v=76';
import { announceEdit, kcCell, pickKeycode, layerOptions } from './qmk-ui.js?v=76';

export class TypingTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const { flask, caps } = this.app;
        const g = (ch, id) => flask.getU16(ch, id);
        const s = this.s = {};

        s.selectWordMac = await g(CH_QMK.selectWord, V_QMK.selectWordMac);
        s.sentenceCase = await g(CH_QMK.sentenceCase, V_QMK.sentenceCaseEnabled);

        if (caps.osShortcuts) {
            s.osFollow = await g(CH_QMK.os, V_QMK.osFollow);
            s.osMac = await g(CH_QMK.os, V_QMK.osMac);
            s.osDetected = await g(CH_QMK.os, V_QMK.osDetected);
        }
        if (caps.numWord) {
            s.nwTimeout = await g(CH_QMK.numWord, V_QMK.nwTimeout);
            s.nwLayer = await g(CH_QMK.numWord, V_QMK.nwLayer);
        }

        if (caps.cyclotab) {
            s.cycEnabled = await g(CH_QMK.cyclotab, V_QMK.cycEnabled);
            s.cycTimeout = await g(CH_QMK.cyclotab, V_QMK.cycTimeout);
            s.cycKeys = [];
            for (let i = 0; i < CYCLOTAB_KEYS; i++) {
                s.cycKeys.push(await g(CH_QMK.cyclotab, slot.cyclotabKey(i)));
            }
        }

        if (caps.altRepeatBehaviour) {
            s.arepChain = await g(CH_QMK.altRepeat, V_QMK.arepChain);
            s.arepStaleMs = await g(CH_QMK.altRepeat, V_QMK.arepStaleMs);
            s.arepDefaultOut = await g(CH_QMK.altRepeat, V_QMK.arepDefaultOut);
        }

        this.bars = {};
        this.render();
    }

    /** One persistent reload bar per channel (keeps its dirty/saved state across renders). */
    _bar(ch, label) {
        return (this.bars[ch] ??= reloadBar(ch, {
            reload: () => this.load(), save: () => this.app.flask.save(ch), label, line: 'qmk',
        }));
    }

    /** Keycode cell: opens the picker, writes the pick, announces the edit, re-renders. */
    _kc(kc, title, write) {
        const cell = kcCell(kc, () => pickKeycode({
            value: kc, title,
            onPick: async (picked) => {
                try {
                    await write(picked);
                    announceEdit(cell);
                    this.render();
                } catch (e) { toast(`Write failed: ${e.message}`, true); }
            },
        }));
        return cell;
    }

    render() {
        const { flask, caps } = this.app;
        const s = this.s;
        const cardsRow = el('div', { class: 'cards-row' });

        // Leader and shift keys live under Behaviour now; keep the way there.
        cardsRow.append(card('Leader and shift keys', 'moved to Behaviour',
            el('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap' },
                el('button', { class: 'btn small', text: 'Leader sequences →', 'data-goto': 'qmk-leader', onclick: () => this.app.showTab?.('qmk-leader') }),
                el('button', { class: 'btn small', text: 'Custom shift keys →', 'data-goto': 'qmk-shift', onclick: () => this.app.showTab?.('qmk-shift') }),
                el('span', { class: 'hint', text: 'Behaviour › Leader and Behaviour › Shift Keys' }))));

        // ---- select word / sentence case ----
        cardsRow.append(card('Select word', 'getreuer module',
            toggleRow({
                label: 'Select word: macOS hotkeys', hint: 'off = Windows/Linux style',
                value: s.selectWordMac,
                onChange: (v) => flask.setU16(CH_QMK.selectWord, V_QMK.selectWordMac, v ? 1 : 0),
            }),
            this._bar(CH_QMK.selectWord, 'Select word')));
        cardsRow.append(card('Sentence case', 'getreuer module',
            toggleRow({
                label: 'Sentence case', hint: 'auto-capitalize after ". " "! " "? "',
                value: s.sentenceCase,
                onChange: (v) => flask.setU16(CH_QMK.sentenceCase, V_QMK.sentenceCaseEnabled, v ? 1 : 0),
            }),
            this._bar(CH_QMK.sentenceCase, 'Sentence case')));

        // ---- OS shortcuts ----
        if (caps.osShortcuts) {
            cardsRow.append(card('OS-aware shortcuts', 'OS_CUT/COPY/PASTE… mac ⌘ vs pc ^',
                toggleRow({
                    label: 'Follow USB OS detection', value: s.osFollow,
                    onChange: (v) => flask.setU16(CH_QMK.os, V_QMK.osFollow, v ? 1 : 0),
                }),
                selectRow({
                    label: 'Mode', value: s.osMac,
                    options: [{ value: 0, label: 'PC (Ctrl)' }, { value: 1, label: 'Mac (⌘)' }],
                    onChange: (v) => flask.setU16(CH_QMK.os, V_QMK.osMac, Number(v)),
                }),
                el('div', { class: 'row' },
                    el('span', { class: 'lbl', text: 'Detected host OS' }),
                    el('span', { style: 'flex:1' }),
                    el('span', { class: 'muted', text: osName(s.osDetected) })),
                this._bar(CH_QMK.os, 'OS shortcuts')));
        }

        // ---- num word ----
        if (caps.numWord) {
            cardsRow.append(card('Num word', 'caps-word for numbers (NUMWORD keycode)',
                sliderRow({
                    label: 'Idle timeout (ms)', hint: '0 = never', min: 0, max: 30000, step: 500,
                    value: s.nwTimeout,
                    onChange: (v) => flask.setU16(CH_QMK.numWord, V_QMK.nwTimeout, v),
                }),
                selectRow({
                    label: 'Target layer', value: s.nwLayer,
                    options: layerOptions(this.app),
                    onChange: (v) => flask.setU16(CH_QMK.numWord, V_QMK.nwLayer, Number(v)),
                }),
                this._bar(CH_QMK.numWord, 'Num word')));
        }

        if (caps.cyclotab) cardsRow.append(this._cyclotabCard());
        if (caps.altRepeatBehaviour) cardsRow.append(this._altRepeatCard());

        this.root.replaceChildren(cardsRow);
    }

    // ---- Cyclotab (0x23) ----

    _cyclotabCard() {
        const { flask } = this.app;
        const s = this.s;
        const c = card('Cyclotab', 'Alt-Tab / Cmd-Tab without holding the modifier',
            el('div', { class: 'note faint' },
                'Tap one of the hotkeys below and the modifier stays held, so you can keep '
                + 'tapping Tab or the arrows to walk the window list. Shift reverses. It releases '
                + 'on Escape, on the timeout, or as soon as you press anything else. Putting a '
                + 'hotkey in your layout is what arms it — it costs no custom keycode.'),
            toggleRow({
                label: 'Enabled', value: s.cycEnabled,
                onChange: (v) => flask.setU16(CH_QMK.cyclotab, V_QMK.cycEnabled, v ? 1 : 0),
            }),
            sliderRow({
                label: 'Hold timeout (ms)', hint: '0 = never time out', min: 0, max: 10000, step: 100,
                value: s.cycTimeout,
                onChange: (v) => flask.setU16(CH_QMK.cyclotab, V_QMK.cycTimeout, v),
            }));
        const grid = el('div', { class: 'row', style: 'gap:4px' });
        for (let i = 0; i < CYCLOTAB_KEYS; i++) {
            grid.append(this._kc(s.cycKeys[i], `Cyclotab hotkey ${i + 1}`, async (kc) => {
                await flask.setU16(CH_QMK.cyclotab, slot.cyclotabKey(i), kc);
                s.cycKeys[i] = kc;
            }));
        }
        c.append(el('div', { class: 'row' },
            el('span', { class: 'lbl' }, 'Hotkeys',
                el('span', { class: 'hint', text: 'defaults cover Windows and macOS at once' })),
            el('span', { style: 'flex:1' }), grid));
        c.append(this._bar(CH_QMK.cyclotab, 'Cyclotab'));
        return c;
    }

    // ---- alt-repeat behaviour (0x25) ----

    _altRepeatCard() {
        const { flask } = this.app;
        const s = this.s;
        return card('Alt Repeat behaviour', "layered on Vial's own Alt Repeat rules",
            el('div', { class: 'note faint' },
                'Chaining exists because QMK core refuses to record what an Alt Repeat emitted '
                + 'as the new "last key". Without it a second press repeats the same substitution '
                + 'forever instead of composing — Q→U then U→A giving QUA.'),
            toggleRow({
                label: 'Chain substitutions', value: s.arepChain,
                onChange: (v) => flask.setU16(CH_QMK.altRepeat, V_QMK.arepChain, v ? 1 : 0),
            }),
            sliderRow({
                label: 'Stale after (ms)', hint: '0 = never stale', min: 0, max: 60000, step: 500,
                value: s.arepStaleMs,
                onChange: (v) => flask.setU16(CH_QMK.altRepeat, V_QMK.arepStaleMs, v),
            }),
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, 'Stale output',
                    el('span', { class: 'hint', text: 'fires instead of a stale last key; empty = do nothing' })),
                el('span', { style: 'flex:1' }),
                this._kc(s.arepDefaultOut, 'Alt Repeat stale output', async (kc) => {
                    await flask.setU16(CH_QMK.altRepeat, V_QMK.arepDefaultOut, kc);
                    s.arepDefaultOut = kc;
                })),
            this._bar(CH_QMK.altRepeat, 'Alt Repeat'));
    }
}
