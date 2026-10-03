// Svalboard › Device › Mouse: the trackball channels the QMK line serves at
// v27. DPI 0x14 (persists on SET), drag scroll 0x15, auto-mouse 0x1B
// (enabled + timeout persist on SET; threshold, layer and the v24 ball mask
// 0x05 need a Save), mouse buttons 0x29, freeze diagnostic 0x1F.
// Accel, smoothing, wiggle, autoscroll and teleport were removed from the
// firmware (v18/v26) and have no card. The ZMK line's Mouse tab is
// mouse-tab.js; 0x1B/0x05 means something else there.

import { el, card, sliderRow, toggleRow, selectRow, reloadBar, toast } from './ui.js?v=76';
import { CH_QMK, V_QMK, SVAL_DPI_OPTIONS, SVAL_AUTOMOUSE_TIMEOUTS, CPI_MAX, CPI_STEP } from './flaskproto.js?v=76';
import { layerOptions } from './qmk-ui.js?v=76';

const AM_SRC_LEFT = 0x01, AM_SRC_RIGHT = 0x02;

export class QmkMouseTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    _bar(ch, label, save = true) {
        return reloadBar(ch, {
            reload: () => this.load(), label, line: 'qmk',
            save: save ? () => this.app.flask.save(ch) : undefined,
        });
    }

    async load() {
        const { flask, caps } = this.app;
        const g = (ch, id) => flask.getU16(ch, id);
        const cardsRow = el('div', { class: 'cards-row' });
        this.root.replaceChildren(cardsRow);

        // ---- DPI (persists immediately) ----
        const dpi = card('DPI', 'per-ball sensor CPI');
        const side = async (label, idxId, cpiId) => {
            dpi.append(selectRow({
                label, value: await g(CH_QMK.dpi, idxId),
                options: SVAL_DPI_OPTIONS.map((d, i) => ({ value: i, label: `${d} DPI` })),
                onChange: (v) => flask.setU16(CH_QMK.dpi, idxId, Number(v)),
            }));
            if (caps.rawCpi) {
                dpi.append(sliderRow({
                    label: `${label} raw CPI`, hint: '0 = use the list above',
                    min: 0, max: CPI_MAX, step: CPI_STEP, value: await g(CH_QMK.dpi, cpiId),
                    onChange: (v) => flask.setU16(CH_QMK.dpi, cpiId, v),
                }));
            }
        };
        await side('Left ball (scroll)', V_QMK.dpiLeft, V_QMK.dpiLeftCpi);
        await side('Right ball (cursor)', V_QMK.dpiRight, V_QMK.dpiRightCpi);
        dpi.append(this._bar(CH_QMK.dpi, 'DPI', false),
            el('div', { class: 'note faint', text: 'DPI persists immediately; no Save needed.' }));
        cardsRow.append(dpi);

        // ---- drag scroll (left ball) ----
        const drag = card('Drag scroll', 'left-ball scrolling',
            sliderRow({ label: 'Divisor', min: 1, max: 120, step: 1,
                value: await g(CH_QMK.dragScroll, V_QMK.dragDivisor),
                onChange: (v) => flask.setU16(CH_QMK.dragScroll, V_QMK.dragDivisor, v) }),
            toggleRow({ label: 'Inverted (natural)', value: await g(CH_QMK.dragScroll, V_QMK.dragInverted),
                onChange: (v) => flask.setU16(CH_QMK.dragScroll, V_QMK.dragInverted, v ? 1 : 0) }),
            sliderRow({ label: 'Emit interval (ms)', hint: 'coalescing window for slow viewers',
                min: 0, max: 200, step: 2, value: await g(CH_QMK.dragScroll, V_QMK.dragInterval),
                onChange: (v) => flask.setU16(CH_QMK.dragScroll, V_QMK.dragInterval, v) }),
            sliderRow({ label: 'Max notches/report', min: 1, max: 30, step: 1,
                value: await g(CH_QMK.dragScroll, V_QMK.dragMaxNotches),
                onChange: (v) => flask.setU16(CH_QMK.dragScroll, V_QMK.dragMaxNotches, v) }));
        if (caps.hiresScroll) {
            const active = await g(CH_QMK.dragScroll, V_QMK.dragHiresActive).catch(() => 0);
            drag.append(
                selectRow({
                    label: 'High-res scroll', hint: 'fine-grained wheel steps instead of whole detents',
                    value: await g(CH_QMK.dragScroll, V_QMK.dragHiresMode),
                    options: [
                        { value: 2, label: 'Follow the OS (recommended)' },
                        { value: 1, label: 'Always on' },
                        { value: 0, label: 'Off, whole detents' },
                    ],
                    onChange: (v) => flask.setU16(CH_QMK.dragScroll, V_QMK.dragHiresMode, Number(v)),
                }),
                el('div', { class: 'note faint', text:
                    `Currently ${active ? 'ON' : 'off'} for this host. Windows and Linux turn the HID resolution `
                    + 'multiplier on and expect fine steps; macOS leaves it off. If scrolling is wildly too fast, '
                    + 'set Off; if it barely moves, set Always on.' }));
        }
        drag.append(this._bar(CH_QMK.dragScroll, 'Drag scroll'));
        cardsRow.append(drag);

        // ---- auto-mouse layer ----
        if (caps.autoMouse) {
            const am = card('Auto-mouse layer', 'ball motion opens a layer',
                toggleRow({ label: 'Enabled', hint: 'persists immediately',
                    value: await g(CH_QMK.autoMouse, V_QMK.amEnabled),
                    onChange: (v) => flask.setU16(CH_QMK.autoMouse, V_QMK.amEnabled, v ? 1 : 0) }),
                selectRow({
                    label: 'Timeout', hint: 'persists immediately', value: await g(CH_QMK.autoMouse, V_QMK.amTimeout),
                    options: SVAL_AUTOMOUSE_TIMEOUTS.map((t, i) => ({ value: i, label: t < 0 ? 'never' : `${t} ms` })),
                    onChange: (v) => flask.setU16(CH_QMK.autoMouse, V_QMK.amTimeout, Number(v)),
                }),
                sliderRow({
                    label: 'Threshold (counts)', hint: 'ball speed before the layer opens',
                    min: 0, max: 2040, step: 8, value: await g(CH_QMK.autoMouse, V_QMK.amThreshold),
                    format: (v) => (v === 0 ? 'any motion' : `${v} (~${(v / 79).toFixed(1)} mm)`),
                    onChange: (v) => flask.setU16(CH_QMK.autoMouse, V_QMK.amThreshold, v),
                }),
                selectRow({
                    label: 'Target layer', value: await g(CH_QMK.autoMouse, V_QMK.amLayer),
                    options: layerOptions(this.app),
                    onChange: (v) => flask.setU16(CH_QMK.autoMouse, V_QMK.amLayer, Number(v)),
                }));
            if (caps.autoMouseSources) {
                // v24 0x1B/0x05: which BALL may open the layer (QMK meaning only).
                let mask = await g(CH_QMK.autoMouse, V_QMK.amSources);
                const bit = (label, b, hint) => toggleRow({
                    label, hint, value: mask & b,
                    onChange: async (v) => {
                        mask = await flask.setU16(CH_QMK.autoMouse, V_QMK.amSources, v ? (mask | b) : (mask & ~b));
                        return mask & b;
                    },
                });
                am.append(bit('Left ball opens it', AM_SRC_LEFT, 'the scroll ball'),
                    bit('Right ball opens it', AM_SRC_RIGHT, 'the cursor ball'));
            }
            am.append(this._bar(CH_QMK.autoMouse, 'Auto-mouse'));
            cardsRow.append(am);
        }

        // ---- mouse buttons (v20) ----
        if (caps.mouseButtons) {
            const locked = await g(CH_QMK.mouseButtons, V_QMK.mbLockMask).catch(() => 0);
            cardsRow.append(card('Mouse buttons', 'double click + click lock',
                sliderRow({
                    label: 'Double-click gap (ms)', hint: 'too short and the host reads one click; too long and it reads two',
                    min: 10, max: 500, step: 5, value: await g(CH_QMK.mouseButtons, V_QMK.mbDoubleGap),
                    onChange: (v) => flask.setU16(CH_QMK.mouseButtons, V_QMK.mbDoubleGap, v),
                }),
                el('div', { class: 'row' },
                    el('span', { class: 'lbl' }, 'Latched buttons',
                        el('span', { class: 'hint', text: 'click lock holds these down until pressed again' })),
                    el('span', { style: 'flex:1' }),
                    el('span', { class: 'mono', text: locked
                        ? [1, 2, 3, 4, 5].filter((b) => locked & (1 << (b - 1))).map((b) => `BTN${b}`).join(' ') : 'none' }),
                    el('button', {
                        class: 'btn small', text: 'Release all', title: 'Frees any button click lock left held',
                        onclick: async () => {
                            try { await flask.setU16(CH_QMK.mouseButtons, V_QMK.mbLockMask, 0); toast('Released'); }
                            catch (e) { toast(e.message, true); }
                        },
                    })),
                this._bar(CH_QMK.mouseButtons, 'Mouse buttons')));
        }

        // ---- freeze diagnostic (nothing persists) ----
        if (caps.diag) {
            const gapEl = el('span', { class: 'mono' });
            const upEl = el('span', { class: 'mono' });
            const refresh = async () => {
                try {
                    gapEl.textContent = `${await g(CH_QMK.diag, V_QMK.diagMaxGap)} ms`;
                    const s = await g(CH_QMK.diag, V_QMK.diagUptime);
                    upEl.textContent = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
                } catch { /* leave stale */ }
            };
            await refresh();
            cardsRow.append(card('Health', 'freeze diagnostic',
                el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Largest pointing-task gap',
                    el('span', { class: 'hint', text: 'near a freeze length = firmware stall; single-digit ms = sensor/host' })),
                el('span', { style: 'flex:1' }), gapEl),
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Uptime' }), el('span', { style: 'flex:1' }), upEl),
                el('div', { class: 'savebar' },
                    el('button', { class: 'btn small', text: 'Refresh', onclick: refresh }),
                    el('button', {
                        class: 'btn small', text: 'Reset watermark',
                        onclick: async () => { await flask.setU16(CH_QMK.diag, V_QMK.diagMaxGap, 0); await refresh(); },
                    }))));
        }
    }
}
