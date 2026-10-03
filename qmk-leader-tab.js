// Svalboard › Behaviours › Leader: Super Leader on channel 0x19 (v12+).
// 16 sequences x up to 5 keys -> one keycode; slot 5 is the output KIND
// (keycode only since v18: snippets are gone) and slot 6 the keycode. The
// ZMK line's leader is a different payload on the same channel number
// (zmk-leader-tab.js). Reads every value once into `this.s` and renders
// from that (16 x 7 slots; re-reading after each pick made it unusable).

import { el, card, sliderRow, toast, reloadBar } from './ui.js?v=76';
import { CH_QMK, V_QMK, slot, SL_SEQS, SL_KEYS, SL_KIND_POS, SL_OUT_POS } from './flaskproto.js?v=76';
import { announceEdit, bindingCell, pickKey } from './qmk-ui.js?v=76';

const OUTPUT_KEYCODE = 0;   // flask_output_kind FLASK_OUT_KEYCODE

export class QmkLeaderTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { flask, caps } = this.app;
        if (!caps.superLeader) {
            this.root.replaceChildren(card('Leader', '', el('p', { class: 'muted',
                text: 'Super Leader needs Svalboard firmware v12 or newer. Reflash to edit leader sequences here.' })));
            return;
        }
        const g = (id) => flask.getU16(CH_QMK.leader, id);
        const s = this.s = { seqs: [] };
        for (let seq = 0; seq < SL_SEQS; seq++) {
            const keys = [];
            for (let pos = 0; pos < SL_KEYS; pos++) keys.push(await g(slot.superLeader(seq, pos)));
            s.seqs.push({ keys, kind: await g(slot.superLeader(seq, SL_KIND_POS)), out: await g(slot.superLeader(seq, SL_OUT_POS)) });
        }
        s.timeout = await g(V_QMK.slTimeout);
        s.liveCount = await g(V_QMK.slLiveCount);
        this.bar ??= reloadBar(CH_QMK.leader, {
            reload: () => this.load(), save: () => this.app.flask.save(CH_QMK.leader),
            label: 'Leader sequences', line: 'qmk',
        });
        this.render();
    }

    /** Keycode cell: opens the picker on `surface`, writes, announces the edit. */
    _kc(kc, surface, title, write) {
        const cell = bindingCell(kc, () => pickKey(this.app, surface, kc, title, async (picked) => {
            try {
                await write(picked);
                announceEdit(cell);
                this.render();
            } catch (e) { toast(`Write failed: ${e.message}`, true); }
        }));
        return cell;
    }

    render() {
        const { flask } = this.app;
        const s = this.s;
        const filled = s.seqs.filter((q) => q.keys.some(Boolean)).length;
        const c = card('Leader', `${SL_SEQS} sequences × up to ${SL_KEYS} keys → a key`,
            el('div', { class: 'note faint' },
                `Press the Leader key (QK_LEAD), then type up to ${SL_KEYS} keys. First match fires.`),
            sliderRow({
                label: 'Sequence timeout (ms)', hint: 'after the last key', min: 200, max: 10000, step: 100,
                value: s.timeout,
                onChange: (v) => flask.setU16(CH_QMK.leader, V_QMK.slTimeout, v),
            }));

        // Every configured sequence, plus two blanks to grow into.
        let blanks = 0;
        s.seqs.forEach((q, seq) => {
            if (!q.keys.some(Boolean) && !q.out) {
                if (blanks >= 2) return;
                blanks++;
            }
            const row = el('div', { class: 'row', 'data-seq': seq, style: 'gap:2px' },
                el('span', { class: 'faint', style: 'width:24px', text: `${seq + 1}.` }));
            q.keys.forEach((kc, pos) => row.append(this._kc(kc, 'qmk.leaderKey', `Sequence ${seq + 1}, key ${pos + 1}`, async (v) => {
                await flask.setU16(CH_QMK.leader, slot.superLeader(seq, pos), v);
                q.keys[pos] = v;
            })));
            row.append('→', this._kc(q.out, 'qmk.comboOutput', `Sequence ${seq + 1} output`, async (v) => {
                // A stale snippet kind (pre-v18 datablock) would compact the row out.
                if (q.kind !== OUTPUT_KEYCODE) q.kind = await flask.setU16(CH_QMK.leader, slot.superLeader(seq, SL_KIND_POS), OUTPUT_KEYCODE);
                await flask.setU16(CH_QMK.leader, slot.superLeader(seq, SL_OUT_POS), v);
                q.out = v;
            }));
            row.append(el('button', {
                class: 'btn small', text: '✕', title: 'clear this sequence',
                onclick: async (e) => {
                    const btn = e.currentTarget;
                    try {
                        for (let pos = 0; pos < SL_KEYS; pos++) {
                            await flask.setU16(CH_QMK.leader, slot.superLeader(seq, pos), 0);
                            q.keys[pos] = 0;
                        }
                        await flask.setU16(CH_QMK.leader, slot.superLeader(seq, SL_OUT_POS), 0);
                        q.out = 0;
                        announceEdit(btn);
                        this.render();
                    } catch (err) { toast(`Clear failed: ${err.message}`, true); }
                },
            }));
            c.append(row);
        });

        // The device's own count of firable sequences: a row with keys but no
        // output is compacted out firmware side, so a mismatch is a dead row.
        if (s.liveCount !== filled) {
            c.append(el('div', { class: 'note faint' },
                `Device reports ${s.liveCount} firable sequence(s) but ${filled} row(s) have keys. A row with no output is ignored.`));
        }
        c.append(this.bar);
        this.root.replaceChildren(c);
    }
}
