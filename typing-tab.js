// Typing tab: getreuer modules (custom shift keys, select word, sentence
// case), leader sequences, OS-aware shortcuts, num word — plus the Svalboard
// v12+ text machinery: Super Leader, the snippet pool, Cyclotab, and
// alt-repeat behaviour. Port of AdeptCompanion TypingTab.swift over the same
// Flask channels.
//
// Reads every value ONCE into `this.s` and renders from that. The old
// re-read-everything-after-each-pick shape cost 3 round trips per slot; Super
// Leader alone is 16 sequences x 7 slots, which made it unusable.

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=39';
import {
    CH, V, slot, CSK_SLOTS, LEADER_SEQS, LEADER_KEYS, osName,
    SL_SEQS, SL_KEYS, SL_KIND_POS, SL_OUT_POS, OUTPUT_KIND,
    SNIPPET_COUNT, SNIPPET_LEN, SNIPPET_KEYS, CYCLOTAB_KEYS,
} from './flaskproto.js?v=39';
import { kcCell, makePickerHost } from './picker.js?v=39';

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

        // ---- custom shift keys ----
        s.cskEnabled = await g(CH.customShift, V.cskEnabled);
        s.cskKey = [];
        s.cskShifted = [];
        for (let i = 0; i < CSK_SLOTS; i++) {
            s.cskKey.push(await g(CH.customShift, slot.cskKey(i)));
            s.cskShifted.push(await g(CH.customShift, slot.cskShift(i)));
        }

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

        // ---- leader: two incompatible shapes on channel 0x19 ----
        // Original: 8 sequences, slot 5 IS the output keycode.
        // Super Leader (Svalboard v12+): 16 sequences, slot 5 is an output
        // KIND and slot 6 the keycode or snippet index. Reading the old shape
        // off a v12+ board hands you a kind where a keycode is expected, which
        // is why this branches rather than revealing extra controls.
        const seqCount = caps.superLeader ? SL_SEQS : LEADER_SEQS;
        s.leaderSeqs = [];
        for (let seq = 0; seq < seqCount; seq++) {
            const keys = [];
            for (let pos = 0; pos < (caps.superLeader ? SL_KEYS : LEADER_KEYS); pos++) {
                keys.push(await g(CH.leader, slot.leader(seq, pos)));
            }
            if (caps.superLeader) {
                s.leaderSeqs.push({
                    keys,
                    kind: await g(CH.leader, slot.superLeader(seq, SL_KIND_POS)),
                    out: await g(CH.leader, slot.superLeader(seq, SL_OUT_POS)),
                });
            } else {
                s.leaderSeqs.push({ keys, out: await g(CH.leader, slot.leader(seq, LEADER_KEYS)) });
            }
        }
        if (caps.superLeader) {
            s.slTimeout = await g(CH.leader, V.slTimeout);
            s.slLiveCount = await g(CH.leader, V.slLiveCount);
        } else if (caps.leaderTimeout) {
            s.leaderTimeout = await g(CH.leader, V.leaderTimeout);
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

        this.picker = makePickerHost({ layerCount: this.app.layerCount });
        this.render();
    }

    /** Keycode cell that routes the next pick into `write`, then re-renders. */
    _kc(kc, write) {
        return kcCell(kc, () => this.picker.request(async (picked) => {
            try {
                await write(picked);
                this.render();
            } catch (e) { toast(`Write failed: ${e.message}`, true); }
        }));
    }

    render() {
        const { flask, caps } = this.app;
        const s = this.s;
        const cardsRow = el('div', { class: 'cards-row' });

        // ---- custom shift keys ----
        const csk = card('Custom shift keys', 'Shift+key types something else',
            toggleRow({
                label: 'Enabled', value: s.cskEnabled,
                onChange: (v) => flask.setU16(CH.customShift, V.cskEnabled, v ? 1 : 0),
            }));
        const cskGrid = el('div', { class: 'codes' });
        for (let i = 0; i < CSK_SLOTS; i++) {
            const key = s.cskKey[i];
            if (!key && i > 0) {
                // First empty slot is the "add" affordance; the rest stay hidden.
                cskGrid.append(this._kc(0, async (kc) => {
                    await flask.setU16(CH.customShift, slot.cskKey(i), kc);
                    s.cskKey[i] = kc;
                }));
                break;
            }
            cskGrid.append(el('div', { style: 'display:flex; gap:2px; align-items:center' },
                this._kc(key, async (kc) => {
                    await flask.setU16(CH.customShift, slot.cskKey(i), kc);
                    s.cskKey[i] = kc;
                }),
                '⇧→',
                this._kc(s.cskShifted[i], async (kc) => {
                    await flask.setU16(CH.customShift, slot.cskShift(i), kc);
                    s.cskShifted[i] = kc;
                })));
        }
        csk.append(cskGrid, saveBar(() => flask.save(CH.customShift)));
        cardsRow.append(csk);

        // ---- select word / sentence case ----
        cardsRow.append(card('Select word & sentence case', 'getreuer modules',
            toggleRow({
                label: 'Select word: macOS hotkeys', hint: 'off = Windows/Linux style',
                value: s.selectWordMac,
                onChange: (v) => flask.setU16(CH.selectWord, V.selectWordMac, v ? 1 : 0),
            }),
            saveBar(() => flask.save(CH.selectWord), 'Select word save'),
            toggleRow({
                label: 'Sentence case', hint: 'auto-capitalize after ". " "! " "? "',
                value: s.sentenceCase,
                onChange: (v) => flask.setU16(CH.sentenceCase, V.sentenceCaseEnabled, v ? 1 : 0),
            }),
            saveBar(() => flask.save(CH.sentenceCase), 'Sentence case save')));

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
                saveBar(() => flask.save(CH.os))));
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
                saveBar(() => flask.save(CH.numWord))));
        }

        cardsRow.append(caps.superLeader ? this._superLeaderCard() : this._leaderCard());
        if (caps.cyclotab) cardsRow.append(this._cyclotabCard());
        if (caps.altRepeatBehaviour) cardsRow.append(this._altRepeatCard());
        if (caps.snippets) cardsRow.append(this._snippetCard());

        this.root.replaceChildren(cardsRow, this.picker.card);
    }

    _layerOptions() {
        return Array.from({ length: this.app.layerCount || 16 }, (_, i) =>
            ({ value: i, label: this.app.profile?.layerNames?.[i] ?? `Layer ${i}` }));
    }

    // ---- leader, original 8-sequence shape (Adept, NLKB16) ----

    _leaderCard() {
        const { flask, caps } = this.app;
        const s = this.s;
        const c = card('Leader sequences', `${LEADER_SEQS} slots × up to ${LEADER_KEYS} keys → 1 output`);
        if (caps.leaderTimeout) {
            c.append(sliderRow({
                label: 'Timeout (ms)', min: 100, max: 2000, step: 50, value: s.leaderTimeout,
                onChange: (v) => flask.setU16(CH.leader, V.leaderTimeout, v),
            }));
        }
        s.leaderSeqs.forEach((seq, i) => {
            const row = el('div', { style: 'display:flex; gap:2px; align-items:center; padding:3px 0' },
                el('span', { class: 'faint', style: 'width:24px', text: `${i + 1}.` }));
            seq.keys.forEach((kc, pos) => row.append(this._kc(kc, async (v) => {
                await flask.setU16(CH.leader, slot.leader(i, pos), v);
                seq.keys[pos] = v;
            })));
            row.append('→', this._kc(seq.out, async (v) => {
                await flask.setU16(CH.leader, slot.leader(i, LEADER_KEYS), v);
                seq.out = v;
            }));
            if (seq.keys.some(Boolean) || seq.out || i < 3) c.append(row);
        });
        c.append(saveBar(() => flask.save(CH.leader)));
        return c;
    }

    // ---- Super Leader (Svalboard v12+) ----

    _superLeaderCard() {
        const { flask, caps } = this.app;
        const s = this.s;
        const filled = s.leaderSeqs.filter((q) => q.keys.some(Boolean)).length;
        const c = card('Leader Key (Super Leader)',
            `${SL_SEQS} sequences × up to ${SL_KEYS} keys → a key or a whole snippet`,
            el('div', { class: 'note faint' },
                'Press the Leader key (QK_LEAD, 0x7C58 — in the picker under Device), '
                + 'then type up to 5 keys. First match fires.'),
            sliderRow({
                label: 'Sequence timeout (ms)', hint: 'after the last key', min: 200, max: 10000, step: 100,
                value: s.slTimeout,
                onChange: (v) => flask.setU16(CH.leader, V.slTimeout, v),
            }));

        // Every configured sequence, plus two blanks to grow into — 16 empty
        // rows is a wall, and hiding all of them leaves nowhere to start.
        let blanks = 0;
        for (let seq = 0; seq < s.leaderSeqs.length; seq++) {
            const q = s.leaderSeqs[seq];
            if (!q.keys.some(Boolean) && !q.out) {
                if (blanks >= 2) continue;
                blanks++;
            }
            const row = el('div', { style: 'display:flex; gap:2px; align-items:center; padding:3px 0; flex-wrap:wrap' },
                el('span', { class: 'faint', style: 'width:24px', text: `${seq + 1}.` }));
            q.keys.forEach((kc, pos) => row.append(this._kc(kc, async (v) => {
                await flask.setU16(CH.leader, slot.superLeader(seq, pos), v);
                q.keys[pos] = v;
            })));
            row.append('→');

            // The Key/Text switch only exists while the board has a snippet
            // pool to point "Text" at. From v18 a sequence has exactly one kind
            // of output, so offering the choice would be offering nothing.
            if (caps.snippets) {
                const kindSel = el('select', {},
                    el('option', { value: OUTPUT_KIND.keycode, text: 'Key' }),
                    el('option', { value: OUTPUT_KIND.snippet, text: 'Text' }));
                kindSel.value = String(q.kind);
                kindSel.addEventListener('change', async () => {
                    try {
                        q.kind = await flask.setU16(CH.leader,
                            slot.superLeader(seq, SL_KIND_POS), Number(kindSel.value));
                        // The output slot means something different now, so the
                        // stale value would render as a nonsense keycode/index.
                        q.out = await flask.setU16(CH.leader, slot.superLeader(seq, SL_OUT_POS), 0);
                        this.render();
                    } catch (e) { toast(`Write failed: ${e.message}`, true); }
                });
                row.append(kindSel);
            }

            if (q.kind === OUTPUT_KIND.snippet && caps.snippets) {
                const snipSel = el('select', { style: 'max-width:190px' },
                    ...Array.from({ length: SNIPPET_COUNT }, (_, i) =>
                        el('option', { value: i, text: snippetLabel(i, s.snippets?.[i]) })));
                snipSel.value = String(Math.min(q.out, SNIPPET_COUNT - 1));
                snipSel.addEventListener('change', async () => {
                    try {
                        q.out = await flask.setU16(CH.leader,
                            slot.superLeader(seq, SL_OUT_POS), Number(snipSel.value));
                    } catch (e) { toast(`Write failed: ${e.message}`, true); }
                });
                row.append(snipSel);
            } else {
                row.append(this._kc(q.out, async (v) => {
                    await flask.setU16(CH.leader, slot.superLeader(seq, SL_OUT_POS), v);
                    q.out = v;
                }));
            }

            row.append(el('button', {
                class: 'btn small', text: '✕', title: 'clear this sequence',
                onclick: async () => {
                    try {
                        for (let pos = 0; pos < SL_KEYS; pos++) {
                            await flask.setU16(CH.leader, slot.superLeader(seq, pos), 0);
                            q.keys[pos] = 0;
                        }
                        await flask.setU16(CH.leader, slot.superLeader(seq, SL_OUT_POS), 0);
                        q.out = 0;
                        this.render();
                    } catch (e) { toast(`Clear failed: ${e.message}`, true); }
                },
            }));
            c.append(row);
        }

        // The device's own count of firable sequences. A row with keys but no
        // output (or pointing at an empty snippet) is compacted out firmware
        // side, so a mismatch here is the honest warning that a row is dead.
        if (s.slLiveCount !== filled) {
            c.append(el('div', { class: 'note faint' },
                `Device reports ${s.slLiveCount} firable sequence(s) but ${filled} row(s) have keys — `
                + 'a row with no output, or pointing at an empty snippet, is ignored.'));
        }
        c.append(saveBar(() => flask.save(CH.leader)));
        return c;
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
                    // Emptying a snippet changes which leader sequences can
                    // fire, so the device's count has to be re-read.
                    s.slLiveCount = await flask.getU16(CH.leader, V.slLiveCount).catch(() => s.slLiveCount);
                    toast(`Snippet ${i + 1} saved`);
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
        c.append(saveBar(() => flask.save(CH.snippets)));
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
            grid.append(this._kc(s.cycKeys[i], async (kc) => {
                await flask.setU16(CH.cyclotab, slot.cyclotabKey(i), kc);
                s.cycKeys[i] = kc;
            }));
        }
        c.append(el('div', { class: 'row' },
            el('span', { class: 'lbl' }, 'Hotkeys',
                el('span', { class: 'hint', text: 'defaults cover Windows and macOS at once' })),
            el('span', { style: 'flex:1' }), grid));
        c.append(saveBar(() => flask.save(CH.cyclotab)));
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
                this._kc(s.arepDefaultOut, async (kc) => {
                    await flask.setU16(CH.altRepeat, V.arepDefaultOut, kc);
                    s.arepDefaultOut = kc;
                })),
            saveBar(() => flask.save(CH.altRepeat)));
    }
}
