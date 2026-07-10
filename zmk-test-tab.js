// ZMK Test tab — interactive testers + timing calibrators (2026-07-10, AJ's
// brainstorm list). Everything here runs on BROWSER events from the real
// keyboard/trackballs, so it works identically online and in the offline
// preview:
//   - Typing tester: live per-key hold times + rollover view.
//   - Tap-hold calibrator: measures natural tap vs hold durations and
//     recommends a tapping-term. ZMK hold-tap timing is const DT (not
//     runtime-tunable) — the output is a keymap snippet, not a live write.
//   - Combo calibrator: measures how tightly combo keys land together and
//     recommends the flask_combos global timeout (0x24/0x03) — one click
//     writes it (runtime-tunable, unlike tap-hold).
//   - Mouse + scroll tester: pointer speed/peak, buttons, wheel notches and
//     direction — bench surface for the scroll chain / snap / accel feel.

import { el, card, toast } from './ui.js?v=9';
import { CH, V } from './flaskproto.js?v=9';

const now = () => performance.now();

const pctl = (sorted, p) => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

export class ZmkTestTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        this.root.replaceChildren(el('div', { class: 'cards-row' },
            this.typingCard(), this.tapHoldCard(), this.comboCard(), this.mouseCard()));
    }

    /** Focus-capture surface: keys pressed while focused are measured and
     * swallowed (preventDefault) so browser shortcuts don't fire. */
    captureBox(placeholder, onDown, onUp) {
        const box = el('div', {
            class: 'code',
            tabindex: '0',
            style: 'padding:14px; border:1px dashed var(--border, #666); border-radius:8px; '
                + 'min-height:44px; cursor:text; user-select:none; outline-offset:2px',
            text: placeholder,
        });
        box.addEventListener('keydown', (e) => {
            e.preventDefault();
            if (e.repeat) return;
            onDown(e);
        });
        box.addEventListener('keyup', (e) => { e.preventDefault(); onUp?.(e); });
        return box;
    }

    // ---- typing tester -------------------------------------------------

    typingCard() {
        const downs = new Map(); // code → t0
        const log = el('div', { class: 'code', style: 'font-size:12px; line-height:1.5; min-height:120px' });
        const held = el('div', { class: 'note', text: 'held: —' });
        const entries = [];

        const render = () => {
            log.replaceChildren(...entries.slice(-8).map((s) => el('div', { text: s })));
            held.textContent = downs.size
                ? `held: ${[...downs.keys()].join(' + ')}` : 'held: —';
        };
        const box = this.captureBox('Click here, then type — per-key hold times appear below.',
            (e) => { downs.set(e.code, now()); render(); },
            (e) => {
                const t0 = downs.get(e.code);
                downs.delete(e.code);
                if (t0 != null) {
                    entries.push(`${e.key.length === 1 ? e.key : e.code}  ↓${Math.round(now() - t0)} ms`
                        + (downs.size ? `  (rollover with ${[...downs.keys()].join('+')})` : ''));
                }
                render();
            });
        return card('Typing tester', 'per-key hold times + rollover — type into the box',
            box, held, log);
    }

    // ---- tap-hold calibrator --------------------------------------------

    tapHoldCard() {
        const taps = [];
        const holds = [];
        let mode = 'tap';
        const downs = new Map();

        const stats = el('div', { class: 'note', style: 'white-space:pre-line' });
        const snippet = el('div', { class: 'code', style: 'font-size:12px' });
        const modeBtns = {};

        const render = () => {
            const st = (a) => {
                const s = [...a].sort((x, y) => x - y);
                return a.length ? `${a.length}× — median ${Math.round(pctl(s, 50))} ms, p95 ${Math.round(pctl(s, 95))} ms` : 'none yet';
            };
            stats.textContent = `Taps: ${st(taps)}\nHolds: ${st(holds)}`;
            for (const [m, b] of Object.entries(modeBtns)) b.classList.toggle('active', m === mode);
            if (taps.length >= 5 && holds.length >= 3) {
                const tp = pctl([...taps].sort((a, b) => a - b), 95);
                const hp = pctl([...holds].sort((a, b) => a - b), 5);
                const rec = Math.round(hp > tp ? (tp + hp) / 2 : tp + 30);
                snippet.textContent = `Recommended: tapping-term-ms = <${rec}>;`
                    + (hp <= tp ? '  ⚠ your holds overlap your taps — retrain or use balanced flavor' : '')
                    + '\n(const DT — edit the hold-tap node in imprint.keymap; not runtime-tunable)';
            } else {
                snippet.textContent = 'Record ≥5 taps and ≥3 holds for a recommendation.';
            }
        };
        const box = this.captureBox('Click here. In Tap mode: tap keys naturally. In Hold mode: press and hold ~like a mod.',
            (e) => { downs.set(e.code, now()); },
            (e) => {
                const t0 = downs.get(e.code);
                downs.delete(e.code);
                if (t0 == null) return;
                (mode === 'tap' ? taps : holds).push(now() - t0);
                render();
            });
        const btnRow = el('div', { style: 'display:flex; gap:6px' },
            ...['tap', 'hold'].map((m) => (modeBtns[m] = el('button', {
                text: m === 'tap' ? 'Record taps' : 'Record holds',
                onclick: () => { mode = m; render(); },
            }))),
            el('button', { text: 'Reset', onclick: () => { taps.length = 0; holds.length = 0; render(); } }));
        render();
        return card('Tap-hold calibrator', 'measures your natural tap vs hold — recommends tapping-term',
            btnRow, box, stats, snippet);
    }

    // ---- combo calibrator -----------------------------------------------

    comboCard() {
        const gaps = [];       // per-trial spread between first and last down
        let burst = null;      // { t0, count } — open while keys land
        const stats = el('div', { class: 'note' });
        const rec = el('div', { class: 'note', style: 'font-weight:600' });
        let recommended = null;

        const render = () => {
            const s = [...gaps].sort((a, b) => a - b);
            stats.textContent = gaps.length
                ? `${gaps.length} trials — median spread ${Math.round(pctl(s, 50))} ms, p95 ${Math.round(pctl(s, 95))} ms`
                : 'No trials yet.';
            if (gaps.length >= 5) {
                recommended = Math.max(10, Math.min(2000, Math.round(pctl(s, 95) * 1.3 + 5)));
                rec.textContent = `Recommended combo timeout: ${recommended} ms`;
            } else {
                recommended = null;
                rec.textContent = 'Record ≥5 trials (press your combo keys together, release, repeat).';
            }
        };
        const box = this.captureBox('Click here, then press 2+ combo keys TOGETHER, release, repeat.',
            () => {
                const t = now();
                if (burst && t - burst.t0 < 300) {
                    burst.count++;
                    burst.last = t;
                } else {
                    if (burst && burst.count >= 2) gaps.push(burst.last - burst.t0);
                    burst = { t0: t, last: t, count: 1 };
                }
                render();
            },
            () => {
                if (burst && burst.count >= 2) { gaps.push(burst.last - burst.t0); render(); }
                burst = null;
            });
        const apply = el('button', {
            text: 'Apply to Combos timeout',
            onclick: async () => {
                if (recommended == null) { toast('Need ≥5 trials first', true); return; }
                if (!this.app.caps?.combos) { toast('Combos need firmware v7+', true); return; }
                try {
                    const echoed = await this.app.flask.setU16(CH.combos, V.combosTimeout, recommended);
                    toast(`Combos timeout → ${echoed} ms (Save on the Combos tab persists)`);
                } catch (e) { toast(`Write failed: ${e.message}`, true); }
            },
        });
        render();
        return card('Combo calibrator', 'measures how tightly your combo keys land — sets the runtime timeout',
            box, stats, rec, el('div', {},
                apply,
                el('button', { text: 'Reset', style: 'margin-left:6px', onclick: () => { gaps.length = 0; burst = null; render(); } })));
    }

    // ---- mouse + scroll tester -------------------------------------------

    mouseCard() {
        let lastMove = null;
        let peak = 0;
        let notches = 0;
        const speed = el('div', { class: 'note', text: 'speed: — px/s (peak —)' });
        const buttons = el('div', { class: 'note', text: 'buttons: —' });
        const wheelLog = el('div', { class: 'code', style: 'font-size:12px; min-height:60px' });
        const wheelEntries = [];

        const BTN = ['left', 'right', 'middle', 'back', 'forward'];
        const surface = el('div', {
            style: 'height:140px; border:1px dashed var(--border, #666); border-radius:8px; '
                + 'display:flex; align-items:center; justify-content:center; user-select:none',
            text: 'Move / click / scroll here',
        });
        surface.addEventListener('mousemove', (e) => {
            const t = now();
            if (lastMove) {
                const dt = t - lastMove.t;
                if (dt > 0) {
                    const v = Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / dt * 1000;
                    peak = Math.max(peak, v);
                    speed.textContent = `speed: ${Math.round(v)} px/s (peak ${Math.round(peak)})`;
                }
            }
            lastMove = { x: e.clientX, y: e.clientY, t };
        });
        const paintButtons = (e) => {
            const down = BTN.filter((_, i) => e.buttons & (1 << i));
            buttons.textContent = `buttons: ${down.length ? down.join(' + ') : '—'}`;
        };
        surface.addEventListener('mousedown', paintButtons);
        surface.addEventListener('mouseup', paintButtons);
        surface.addEventListener('contextmenu', (e) => e.preventDefault());
        surface.addEventListener('wheel', (e) => {
            e.preventDefault();
            notches++;
            const axis = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? 'Y' : 'X';
            const val = axis === 'Y' ? e.deltaY : e.deltaX;
            wheelEntries.push(`#${notches}  ${axis}${val > 0 ? '+' : ''}${Math.round(val)}`
                + `  (${['px', 'line', 'page'][e.deltaMode] ?? e.deltaMode})`);
            wheelLog.replaceChildren(...wheelEntries.slice(-5).map((s) => el('div', { text: s })));
        }, { passive: false });

        return card('Mouse + scroll tester', 'pointer speed, buttons, wheel notches — bench the scroll chain here',
            surface, speed, buttons, wheelLog,
            el('button', { text: 'Reset', onclick: () => {
                peak = 0; notches = 0; wheelEntries.length = 0; lastMove = null;
                speed.textContent = 'speed: — px/s (peak —)';
                wheelLog.replaceChildren();
            } }));
    }
}
