// Typing tab: getreuer modules (select word, sentence case), OS-aware
// shortcuts, num word, plus the Svalboard v12+ text machinery: the snippet
// pool, Cyclotab, and alt-repeat behaviour. Port of AdeptCompanion
// TypingTab.swift over the same Flask channels.
//
// Leader (incl. Super Leader) and custom shift keys moved to Behaviour ›
// Leader and Behaviour › Shift Keys (qmk-leader-tab.js, qmk-shift-tab.js;
// AJ-Q3). Typing keeps a link line to each.
//
// Reads every value ONCE into `this.s` and renders from that.

import { el, card, sliderRow, toggleRow, selectRow, reloadBar, toast } from './ui.js?v=49';
import {
    CH, V, slot, osName, SNIPPET_COUNT, SNIPPET_LEN, SNIPPET_KEYS, CYCLOTAB_KEYS,
} from './flaskproto.js?v=49';
import { kcCell } from './picker.js?v=49';
import { openPicker } from './binding-picker.js?v=1';
import { announceEdit } from './tiles.js?v=1';

/** "3: Regards," — what a snippet reads as in a dropdown. */
function snippetLabel(index, text) {
    const t = (text || '').trim();
    return `${index + 1}: ${t ? (t.length > 24 ? `${t.slice(0, 23)}…` : t) : '(empty)'}`;
}

export class TypingTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const { flask, caps } = this.app;
        const g = (ch, id) => flask.getU16(ch, id);
        const s = this.s = {};

        s.selectWordMac = await g(CH.selectWord, V.selectWordMac);
        s.sentenceCase = await g(CH.sentenceCase, V.sentenceCaseEnabled);

        if (caps.osShortcuts) {
            s.osFollow = await g(CH.os, V.osFollow);
            s.osMac = await g(CH.os, V.osMac);
            s.osDetected = await g(CH.os, V.osDetected);
        }
        if (caps.numWord) {
            s.nwTimeout = await g(CH.numWord, V.nwTimeout);
            s.nwLayer = await g(CH.numWord, V.nwLayer);
        }

        // ---- snippet pool (Svalboard v12-v17 only) ----
        // Removed from the firmware at v18: the board stored no snippet text
        // and none of its keycodes were bound. Still read on an older board so
        // this app keeps working against one.
        if (caps.snippets) {
            s.snipKeyCount = Math.min(SNIPPET_KEYS,
                await g(CH.snippets, V.snipKeyCount).catch(() => SNIPPET_KEYS));
            s.snippets = [];
            for (let i = 0; i < SNIPPET_COUNT; i++) s.snippets.push(await flask.getSnippet(i));
            s.snipTargets = [];
            for (let k = 0; k < s.snipKeyCount; k++) {
                s.snipTargets.push(await g(CH.snippets, slot.snippetTarget(k)));
            }
        }

        if (caps.cyclotab) {
            s.cycEnabled = await g(CH.cyclotab, V.cycEnabled);
            s.cycTimeout = await g(CH.cyclotab, V.cycTimeout);
            s.cycKeys = [];
            for (let i = 0; i < CYCLOTAB_KEYS; i++) {
                s.cycKeys.push(await g(CH.cyclotab, slot.cyclotabKey(i)));
            }
        }

        if (caps.altRepeatBehaviour) {
            s.arepChain = await g(CH.altRepeat, V.arepChain);
            s.arepStaleMs = await g(CH.altRepeat, V.arepStaleMs);
            s.arepDefaultOut = await g(CH.altRepeat, V.arepDefaultOut);
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
        const cell = kcCell(kc, () => openPicker({
            surface: 'qmk.key', value: kc, host: 'sheet', title, app: this.app,
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
            el('div', { class: 'moved-links' },
                el('button', { class: 'btn small', text: 'Leader sequences →', 'data-goto': 'qmk-leader', onclick: () => this.app.showTab?.('qmk-leader') }),
                el('button', { class: 'btn small', text: 'Custom shift keys →', 'data-goto': 'qmk-shift', onclick: () => this.app.showTab?.('qmk-shift') }),
                el('span', { class: 'hint', text: 'Behaviour › Leader and Behaviour › Shift Keys' }))));

        // ---- select word / sentence case ----
        cardsRow.append(card('Select word', 'getreuer module',
            toggleRow({
                label: 'Select word: macOS hotkeys', hint: 'off = Windows/Linux style',
                value: s.selectWordMac,
                onChange: (v) => flask.setU16(CH.selectWord, V.selectWordMac, v ? 1 : 0),
            }),
            this._bar(CH.selectWord, 'Select word')));
        cardsRow.append(card('Sentence case', 'getreuer module',
            toggleRow({
                label: 'Sentence case', hint: 'auto-capitalize after ". " "! " "? "',
                value: s.sentenceCase,
                onChange: (v) => flask.setU16(CH.sentenceCase, V.sentenceCaseEnabled, v ? 1 : 0),
            }),
            this._bar(CH.sentenceCase, 'Sentence case')));

        // ---- OS shortcuts ----
        if (caps.osShortcuts) {
            cardsRow.append(card('OS-aware shortcuts', 'OS_CUT/COPY/PASTE… mac ⌘ vs pc ^',
                toggleRow({
                    label: 'Follow USB OS detection', value: s.osFollow,
                    onChange: (v) => flask.setU16(CH.os, V.osFollow, v ? 1 : 0),
                }),
                selectRow({
                    label: 'Mode', value: s.osMac,
                    options: [{ value: 0, label: 'PC (Ctrl)' }, { value: 1, label: 'Mac (⌘)' }],
                    onChange: (v) => flask.setU16(CH.os, V.osMac, Number(v)),
                }),
                el('div', { class: 'row' },
                    el('span', { class: 'lbl', text: 'Detected host OS' }),
                    el('span', { style: 'flex:1' }),
                    el('span', { class: 'muted', text: osName(s.osDetected) })),
                this._bar(CH.os, 'OS shortcuts')));
        }

        // ---- num word ----
        if (caps.numWord) {
            cardsRow.append(card('Num word', 'caps-word for numbers (NUMWORD keycode)',
                sliderRow({
                    label: 'Idle timeout (ms)', hint: '0 = never', min: 0, max: 30000, step: 500,
                    value: s.nwTimeout,
                    onChange: (v) => flask.setU16(CH.numWord, V.nwTimeout, v),
                }),
                selectRow({
                    label: 'Target layer', value: s.nwLayer,
                    options: this._layerOptions(),
                    onChange: (v) => flask.setU16(CH.numWord, V.nwLayer, Number(v)),
                }),
                this._bar(CH.numWord, 'Num word')));
        }

        if (caps.cyclotab) cardsRow.append(this._cyclotabCard());
        if (caps.altRepeatBehaviour) cardsRow.append(this._altRepeatCard());
        if (caps.snippets) cardsRow.append(this._snippetCard());

        this.root.replaceChildren(cardsRow);
    }

    _layerOptions() {
        return Array.from({ length: this.app.layerCount || 16 }, (_, i) =>
            ({ value: i, label: this.app.profile?.layerNames?.[i] ?? `Layer ${i}` }));
    }

    // ---- text snippets (0x24) ----

    _snippetCard() {
        const { flask } = this.app;
        const s = this.s;
        const c = card('Text snippets', `${SNIPPET_COUNT} slots × ${SNIPPET_LEN - 1} characters`,
            el('div', { class: 'note faint' },
                'Super Leader sequences and the Snp keycodes type these. Put a Snp key in an '
                + 'Alt Repeat rule\'s output and Alt Repeat types a whole phrase.'));

        for (let i = 0; i < SNIPPET_COUNT; i++) {
            const input = el('input', {
                type: 'text', value: s.snippets[i], maxlength: SNIPPET_LEN - 1,
                style: 'flex:1; font-family:var(--mono, monospace)',
            });
            // Commit on blur/Enter, never per keystroke: a write costs 4 frames
            // and a re-render would steal focus mid-word.
            const commit = async () => {
                if (input.value === s.snippets[i]) return;
                try {
                    await flask.setSnippet(i, input.value);
                    s.snippets[i] = input.value;
                    announceEdit(input);
                    toast(`Snippet ${i + 1} written`);
                } catch (e) {
                    toast(`Write failed: ${e.message}`, true);
                    input.value = s.snippets[i];
                }
            };
            input.addEventListener('change', commit);
            c.append(el('div', { class: 'row' },
                el('span', { class: 'faint', style: 'width:24px', text: `${i + 1}.` }), input));
        }

        if (s.snipKeyCount) {
            c.append(el('div', { class: 'note faint' },
                `${s.snipKeyCount} Snp keycode(s) — point each at any snippet.`));
            const grid = el('div');
            for (let k = 0; k < s.snipKeyCount; k++) {
                grid.append(selectRow({
                    label: `Snp${k + 1}`, value: s.snipTargets[k],
                    options: Array.from({ length: SNIPPET_COUNT }, (_, i) =>
                        ({ value: i, label: snippetLabel(i, s.snippets[i]) })),
                    onChange: async (v) => {
                        s.snipTargets[k] = await flask.setU16(CH.snippets,
                            slot.snippetTarget(k), Number(v));
                    },
                }));
            }
            c.append(grid);
        }
        c.append(this._bar(CH.snippets, 'Text snippets'));
        return c;
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
                onChange: (v) => flask.setU16(CH.cyclotab, V.cycEnabled, v ? 1 : 0),
            }),
            sliderRow({
                label: 'Hold timeout (ms)', hint: '0 = never time out', min: 0, max: 10000, step: 100,
                value: s.cycTimeout,
                onChange: (v) => flask.setU16(CH.cyclotab, V.cycTimeout, v),
            }));
        const grid = el('div', { class: 'codes' });
        for (let i = 0; i < CYCLOTAB_KEYS; i++) {
            grid.append(this._kc(s.cycKeys[i], `Cyclotab hotkey ${i + 1}`, async (kc) => {
                await flask.setU16(CH.cyclotab, slot.cyclotabKey(i), kc);
                s.cycKeys[i] = kc;
            }));
        }
        c.append(el('div', { class: 'row' },
            el('span', { class: 'lbl' }, 'Hotkeys',
                el('span', { class: 'hint', text: 'defaults cover Windows and macOS at once' })),
            el('span', { style: 'flex:1' }), grid));
        c.append(this._bar(CH.cyclotab, 'Cyclotab'));
        return c;
    }

    // ---- alt-repeat behaviour (0x25) ----

    _altRepeatCard() {
        const { flask } = this.app;
        const s = this.s;
        return card('Alt Repeat behaviour', 'layered on the Alt Repeat rules in Key Overrides',
            el('div', { class: 'note faint' },
                'Chaining exists because QMK core refuses to record what an Alt Repeat emitted '
                + 'as the new "last key". Without it a second press repeats the same substitution '
                + 'forever instead of composing — Q→U then U→A giving QUA.'),
            toggleRow({
                label: 'Chain substitutions', value: s.arepChain,
                onChange: (v) => flask.setU16(CH.altRepeat, V.arepChain, v ? 1 : 0),
            }),
            sliderRow({
                label: 'Stale after (ms)', hint: '0 = never stale', min: 0, max: 60000, step: 500,
                value: s.arepStaleMs,
                onChange: (v) => flask.setU16(CH.altRepeat, V.arepStaleMs, v),
            }),
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, 'Stale output',
                    el('span', { class: 'hint', text: 'fires instead of a stale last key; empty = do nothing' })),
                el('span', { style: 'flex:1' }),
                this._kc(s.arepDefaultOut, 'Alt Repeat stale output', async (kc) => {
                    await flask.setU16(CH.altRepeat, V.arepDefaultOut, kc);
                    s.arepDefaultOut = kc;
                })),
            this._bar(CH.altRepeat, 'Alt Repeat'));
    }
}
