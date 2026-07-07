// Typing tab: getreuer modules (custom shift keys, select word, sentence
// case), leader sequences, OS-aware shortcuts, num word. Port of
// AdeptCompanion TypingTab.swift over the same Flask channels.

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=1';
import { CH, V, slot, CSK_SLOTS, LEADER_SEQS, LEADER_KEYS, osName } from './flaskproto.js?v=1';
import { capLabel, describe } from './keycodes.js?v=1';
import { buildPicker } from './picker.js?v=1';

export class TypingTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    /** Small keycode cell that opens a shared picker to reassign. */
    _kcButton(kc, onSet) {
        const btn = el('button', {
            class: 'code', title: describe(kc),
            text: kc ? capLabel(kc) : '·',
        });
        btn.addEventListener('click', () => {
            this._pickTarget = onSet;
            this._pickerCard.style.display = '';
            this._pickerCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        return btn;
    }

    async load() {
        const { flask, caps } = this.app;
        const g = (ch, id) => flask.getU16(ch, id);
        const cardsRow = el('div', { class: 'cards-row' });
        this.root.replaceChildren(cardsRow);

        // Shared picker (hidden until a slot is clicked).
        this._pickTarget = null;
        this._pickerCard = card('Assign keycode', 'click a slot above, then pick', buildPicker({
            layerCount: this.app.layerCount,
            onPick: async (kc) => {
                if (!this._pickTarget) return;
                try {
                    await this._pickTarget(kc);
                    this._pickerCard.style.display = 'none';
                    this._pickTarget = null;
                    await this.load(); // re-render slot labels
                } catch (e) { toast(`Write failed: ${e.message}`, true); }
            },
        }));
        this._pickerCard.style.display = 'none';

        // ---- custom shift keys ----
        const csk = card('Custom shift keys', 'Shift+key types something else',
            toggleRow({ label: 'Enabled', value: await g(CH.customShift, V.cskEnabled),
                onChange: (v) => flask.setU16(CH.customShift, V.cskEnabled, v ? 1 : 0) }));
        const cskGrid = el('div', { class: 'codes' });
        for (let i = 0; i < CSK_SLOTS; i++) {
            const key = await g(CH.customShift, slot.cskKey(i));
            const shifted = await g(CH.customShift, slot.cskShift(i));
            if (!key && i > 0) {
                // Show first empty slot as the "add" affordance, skip the rest.
                cskGrid.append(this._kcButton(0, (kc) => flask.setU16(CH.customShift, slot.cskKey(i), kc)));
                break;
            }
            cskGrid.append(el('div', { style: 'display:flex; gap:2px; align-items:center' },
                this._kcButton(key, (kc) => flask.setU16(CH.customShift, slot.cskKey(i), kc)),
                '⇧→',
                this._kcButton(shifted, (kc) => flask.setU16(CH.customShift, slot.cskShift(i), kc))));
        }
        csk.append(cskGrid, saveBar(() => flask.save(CH.customShift)));
        cardsRow.append(csk);

        // ---- select word / sentence case ----
        cardsRow.append(card('Select word & sentence case', 'getreuer modules',
            toggleRow({ label: 'Select word: macOS hotkeys', hint: 'off = Windows/Linux style',
                value: await g(CH.selectWord, V.selectWordMac),
                onChange: (v) => flask.setU16(CH.selectWord, V.selectWordMac, v ? 1 : 0) }),
            saveBar(() => flask.save(CH.selectWord), 'Select word save'),
            toggleRow({ label: 'Sentence case', hint: 'auto-capitalize after ". " "! " "? "',
                value: await g(CH.sentenceCase, V.sentenceCaseEnabled),
                onChange: (v) => flask.setU16(CH.sentenceCase, V.sentenceCaseEnabled, v ? 1 : 0) }),
            saveBar(() => flask.save(CH.sentenceCase), 'Sentence case save')));

        // ---- OS shortcuts ----
        if (caps.osShortcuts) {
            const detected = await g(CH.os, V.osDetected);
            const os = card('OS-aware shortcuts', 'OS_CUT/COPY/PASTE… mac ⌘ vs pc ^',
                toggleRow({ label: 'Follow USB OS detection', value: await g(CH.os, V.osFollow),
                    onChange: (v) => flask.setU16(CH.os, V.osFollow, v ? 1 : 0) }),
                selectRow({ label: 'Mode', value: await g(CH.os, V.osMac),
                    options: [{ value: 0, label: 'PC (Ctrl)' }, { value: 1, label: 'Mac (⌘)' }],
                    onChange: (v) => flask.setU16(CH.os, V.osMac, Number(v)) }),
                el('div', { class: 'row' },
                    el('span', { class: 'lbl', text: 'Detected host OS' }),
                    el('span', { style: 'flex:1' }),
                    el('span', { class: 'muted', text: osName(detected) })),
                saveBar(() => flask.save(CH.os)));
            cardsRow.append(os);
        }

        // ---- num word ----
        if (caps.numWord) {
            cardsRow.append(card('Num word', 'caps-word for numbers (NUMWORD keycode)',
                sliderRow({ label: 'Idle timeout (ms)', hint: '0 = never', min: 0, max: 30000, step: 500,
                    value: await g(CH.numWord, V.nwTimeout),
                    onChange: (v) => flask.setU16(CH.numWord, V.nwTimeout, v) }),
                sliderRow({ label: 'Target layer', min: 0, max: 15, step: 1,
                    value: await g(CH.numWord, V.nwLayer),
                    onChange: (v) => flask.setU16(CH.numWord, V.nwLayer, v) }),
                saveBar(() => flask.save(CH.numWord))));
        }

        // ---- leader sequences ----
        const leader = card('Leader sequences', `${LEADER_SEQS} slots × up to ${LEADER_KEYS} keys → 1 output`);
        if (caps.leaderTimeout) {
            leader.append(sliderRow({ label: 'Timeout (ms)', min: 100, max: 2000, step: 50,
                value: await g(CH.leader, V.leaderTimeout),
                onChange: (v) => flask.setU16(CH.leader, V.leaderTimeout, v) }));
        }
        for (let seq = 0; seq < LEADER_SEQS; seq++) {
            const rowEl = el('div', { style: 'display:flex; gap:2px; align-items:center; padding:3px 0' },
                el('span', { class: 'faint', style: 'width:24px', text: `${seq + 1}.` }));
            let any = false;
            for (let pos = 0; pos < LEADER_KEYS; pos++) {
                const kc = await g(CH.leader, slot.leader(seq, pos));
                if (kc) any = true;
                rowEl.append(this._kcButton(kc,
                    (v) => flask.setU16(CH.leader, slot.leader(seq, pos), v)));
            }
            const out = await g(CH.leader, slot.leader(seq, LEADER_KEYS));
            rowEl.append('→', this._kcButton(out,
                (v) => flask.setU16(CH.leader, slot.leader(seq, LEADER_KEYS), v)));
            if (any || out || seq < 3) leader.append(rowEl);
        }
        leader.append(saveBar(() => flask.save(CH.leader)));
        cardsRow.append(leader);

        this.root.append(this._pickerCard);
    }
}
