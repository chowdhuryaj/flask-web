// Behaviour › Leader on the QMK line (spec 3.7, AJ-Q3). Moved out of Typing so
// both firmware lines keep leader in the same place. Channel 0x19 has two
// incompatible shapes:
//   Original (Adept, NLKB16, Svalboard < v12): 8 sequences, slot 5 IS the
//     output keycode.
//   Super Leader (Svalboard v12+): 16 sequences, slot 5 is an output KIND and
//     slot 6 the keycode or snippet index. Reading the old shape off a v12+
//     board hands you a kind where a keycode is expected, so this branches.
// Reads every value once into `this.s` and renders from that (Super Leader is
// 16 sequences x 7 slots; re-reading after each pick made it unusable).

import { el, card, sliderRow, toast, reloadBar } from './ui.js?v=49';
import {
    CH, V, slot, LEADER_SEQS, LEADER_KEYS, SL_SEQS, SL_KEYS, SL_KIND_POS, SL_OUT_POS,
    OUTPUT_KIND, SNIPPET_COUNT,
} from './flaskproto.js?v=49';
import { openPicker } from './binding-picker.js?v=1';
import { announceEdit, bindingCell } from './tiles.js?v=1';

/** "3: Regards," : what a snippet reads as in a dropdown. */
const snippetLabel = (index, text) => {
    const t = (text || '').trim();
    return `${index + 1}: ${t ? (t.length > 24 ? `${t.slice(0, 23)}…` : t) : '(empty)'}`;
};

export class QmkLeaderTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { flask, caps } = this.app;
        const g = (id) => flask.getU16(CH.leader, id);
        const s = this.s = { leaderSeqs: [] };
        const seqCount = caps.superLeader ? SL_SEQS : LEADER_SEQS;
        for (let seq = 0; seq < seqCount; seq++) {
            const keys = [];
            for (let pos = 0; pos < (caps.superLeader ? SL_KEYS : LEADER_KEYS); pos++) keys.push(await g(slot.leader(seq, pos)));
            if (caps.superLeader) {
                s.leaderSeqs.push({
                    keys,
                    kind: await g(slot.superLeader(seq, SL_KIND_POS)),
                    out: await g(slot.superLeader(seq, SL_OUT_POS)),
                });
            } else {
                s.leaderSeqs.push({ keys, out: await g(slot.leader(seq, LEADER_KEYS)) });
            }
        }
        if (caps.superLeader) {
            s.slTimeout = await g(V.slTimeout);
            s.slLiveCount = await g(V.slLiveCount);
        } else if (caps.leaderTimeout) {
            s.leaderTimeout = await g(V.leaderTimeout);
        }
        // Snippet names for the "Text" output (Svalboard v12-v17 only).
        if (caps.snippets) {
            s.snippets = [];
            for (let i = 0; i < SNIPPET_COUNT; i++) s.snippets.push(await flask.getSnippet(i));
        }
        this.bar ??= reloadBar(CH.leader, {
            reload: () => this.load(), save: () => this.app.flask.save(CH.leader),
            label: 'Leader sequences', line: 'qmk',
        });
        this.render();
    }

    /** Keycode cell: opens the picker on `surface`, writes, announces the edit. */
    _kc(kc, surface, title, write) {
        const cell = bindingCell(kc, () => openPicker({
            surface, value: kc, host: 'sheet', title, app: this.app,
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
        this.root.replaceChildren(this.app.caps.superLeader ? this._superLeaderCard() : this._leaderCard());
    }

    // ---- original 8-sequence shape ----

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
            const row = el('div', { class: 'row', 'data-seq': i, style: 'gap:2px' },
                el('span', { class: 'faint', style: 'width:24px', text: `${i + 1}.` }));
            seq.keys.forEach((kc, pos) => row.append(this._kc(kc, 'qmk.leaderKey', `Sequence ${i + 1}, key ${pos + 1}`, async (v) => {
                await flask.setU16(CH.leader, slot.leader(i, pos), v);
                seq.keys[pos] = v;
            })));
            row.append('→', this._kc(seq.out, 'qmk.comboOutput', `Sequence ${i + 1} output`, async (v) => {
                await flask.setU16(CH.leader, slot.leader(i, LEADER_KEYS), v);
                seq.out = v;
            }));
            if (seq.keys.some(Boolean) || seq.out || i < 3) c.append(row);
        });
        c.append(this.bar);
        return c;
    }

    // ---- Super Leader (Svalboard v12+) ----

    _superLeaderCard() {
        const { flask, caps } = this.app;
        const s = this.s;
        const filled = s.leaderSeqs.filter((q) => q.keys.some(Boolean)).length;
        const c = card('Leader',
            `${SL_SEQS} sequences × up to ${SL_KEYS} keys → a key${caps.snippets ? ' or a whole snippet' : ''}`,
            el('div', { class: 'note faint' },
                'Press the Leader key (QK_LEAD, 0x7C58, under Run in the picker), '
                + `then type up to ${SL_KEYS} keys. First match fires.`),
            sliderRow({
                label: 'Sequence timeout (ms)', hint: 'after the last key', min: 200, max: 10000, step: 100,
                value: s.slTimeout,
                onChange: (v) => flask.setU16(CH.leader, V.slTimeout, v),
            }));

        // Every configured sequence, plus two blanks to grow into: 16 empty
        // rows is a wall, and hiding all of them leaves nowhere to start.
        let blanks = 0;
        for (let seq = 0; seq < s.leaderSeqs.length; seq++) {
            const q = s.leaderSeqs[seq];
            if (!q.keys.some(Boolean) && !q.out) {
                if (blanks >= 2) continue;
                blanks++;
            }
            const row = el('div', { class: 'row', 'data-seq': seq, style: 'gap:2px' },
                el('span', { class: 'faint', style: 'width:24px', text: `${seq + 1}.` }));
            q.keys.forEach((kc, pos) => row.append(this._kc(kc, 'qmk.leaderKey', `Sequence ${seq + 1}, key ${pos + 1}`, async (v) => {
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
                        q.kind = await flask.setU16(CH.leader, slot.superLeader(seq, SL_KIND_POS), Number(kindSel.value));
                        // The output slot means something different now, so the
                        // stale value would render as a nonsense keycode/index.
                        q.out = await flask.setU16(CH.leader, slot.superLeader(seq, SL_OUT_POS), 0);
                        announceEdit(kindSel);
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
                        q.out = await flask.setU16(CH.leader, slot.superLeader(seq, SL_OUT_POS), Number(snipSel.value));
                        announceEdit(snipSel);
                    } catch (e) { toast(`Write failed: ${e.message}`, true); }
                });
                row.append(snipSel);
            } else {
                row.append(this._kc(q.out, 'qmk.comboOutput', `Sequence ${seq + 1} output`, async (v) => {
                    await flask.setU16(CH.leader, slot.superLeader(seq, SL_OUT_POS), v);
                    q.out = v;
                }));
            }

            row.append(el('button', {
                class: 'btn small', text: '✕', title: 'clear this sequence',
                onclick: async (e) => {
                    try {
                        for (let pos = 0; pos < SL_KEYS; pos++) {
                            await flask.setU16(CH.leader, slot.superLeader(seq, pos), 0);
                            q.keys[pos] = 0;
                        }
                        await flask.setU16(CH.leader, slot.superLeader(seq, SL_OUT_POS), 0);
                        q.out = 0;
                        announceEdit(e.currentTarget);
                        this.render();
                    } catch (err) { toast(`Clear failed: ${err.message}`, true); }
                },
            }));
            c.append(row);
        }

        // The device's own count of firable sequences. A row with keys but no
        // output (or pointing at an empty snippet) is compacted out firmware
        // side, so a mismatch here is the honest warning that a row is dead.
        if (s.slLiveCount !== filled) {
            c.append(el('div', { class: 'note faint' },
                `Device reports ${s.slLiveCount} firable sequence(s) but ${filled} row(s) have keys. `
                + 'A row with no output, or pointing at an empty snippet, is ignored.'));
        }
        c.append(this.bar);
        return c;
    }
}
