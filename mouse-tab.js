// Mouse (pointing-device) tuning tab — Adept + Svalboard. Port of
// AdeptCompanion MouseTab.swift + ModuleViews.swift; slider ranges mirror
// those files, but the firmware clamps are authoritative (clamp-echo).
// Float params ride the wire ×100 (accel, smoothing factor).

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=4';
import { CH, V, ADEPT_DPI_OPTIONS, SVAL_DPI_OPTIONS, SVAL_AUTOMOUSE_TIMEOUTS,
         CPI_MIN, CPI_MAX, CPI_STEP } from './flaskproto.js?v=4';

const pct = (v) => (v / 100).toFixed(2);

export class MouseTab {
    constructor(app) {
        this.app = app; // { flask, caps, family }
        this.root = el('div');
    }

    async load() {
        const { flask, caps, family } = this.app;
        const sval = family === 'svalboard';
        const g = (ch, id) => flask.getU16(ch, id);
        const cardsRow = el('div', { class: 'cards-row' });
        this.root.replaceChildren(cardsRow);

        // ---- acceleration ----
        if (caps.accel) {
        const accel = card('Acceleration', 'sigmoid curve (drashna pd_accel)',
            toggleRow({ label: 'Enabled', value: await g(CH.accel, V.accelEnabled),
                onChange: (v) => flask.setU16(CH.accel, V.accelEnabled, v ? 1 : 0) }),
            sliderRow({ label: 'Takeoff', hint: 'curve steepness', min: 50, max: 1000, step: 5,
                value: await g(CH.accel, V.accelTakeoff), format: pct,
                onChange: (v) => flask.setU16(CH.accel, V.accelTakeoff, v) }),
            sliderRow({ label: 'Growth rate', min: 0, max: 200, step: 1,
                value: await g(CH.accel, V.accelGrowth), format: pct,
                onChange: (v) => flask.setU16(CH.accel, V.accelGrowth, v) }),
            sliderRow({ label: 'Offset', hint: 'signed midpoint shift', min: -1000, max: 1000, step: 10,
                value: await flask.getI16(CH.accel, V.accelOffset), format: pct,
                onChange: (v) => flask.setI16(CH.accel, V.accelOffset, v) }),
            sliderRow({ label: 'Limit', hint: 'max multiplier', min: 0, max: 100, step: 1,
                value: await g(CH.accel, V.accelLimit), format: pct,
                onChange: (v) => flask.setU16(CH.accel, V.accelLimit, v) }),
            saveBar(() => flask.save(CH.accel)));
        cardsRow.append(accel);
        }

        // ---- DPI ----
        if (caps.dpi) {
        const dpi = card('DPI', sval ? 'per-ball sensor CPI' : 'sensor CPI');
        if (sval) {
            const mk = async (label, idxId, cpiId) => {
                const idx = await g(CH.dpi, idxId);
                dpi.append(selectRow({
                    label, value: idx,
                    options: SVAL_DPI_OPTIONS.map((d, i) => ({ value: i, label: `${d} DPI` })),
                    onChange: (v) => flask.setU16(CH.dpi, idxId, Number(v)),
                }));
                if (this.app.caps.rawCpi) {
                    const cpi = await g(CH.dpi, cpiId);
                    dpi.append(sliderRow({
                        label: `${label} raw CPI`, hint: '0 = use the list above',
                        min: 0, max: CPI_MAX, step: CPI_STEP, value: cpi,
                        onChange: (v) => flask.setU16(CH.dpi, cpiId, v),
                    }));
                }
            };
            await mk('Left ball (scroll)', V.svalDpiLeft, V.svalDpiLeftCpi);
            await mk('Right ball (cursor)', V.svalDpiRight, V.svalDpiRightCpi);
        } else {
            dpi.append(selectRow({
                label: 'DPI', value: await g(CH.dpi, V.dpiIndex),
                options: ADEPT_DPI_OPTIONS.map((d, i) => ({ value: i, label: `${d} DPI` })),
                onChange: (v) => flask.setU16(CH.dpi, V.dpiIndex, Number(v)),
            }));
            if (caps.rawCpi) {
                dpi.append(sliderRow({
                    label: 'Raw CPI', hint: `0 = table mode; ${CPI_MIN}-${CPI_MAX} step ${CPI_STEP}`,
                    min: 0, max: CPI_MAX, step: CPI_STEP,
                    value: await g(CH.dpi, V.dpiCpi),
                    onChange: (v) => flask.setU16(CH.dpi, V.dpiCpi, v),
                }));
            }
        }
        dpi.append(el('div', { class: 'note faint', text: 'DPI persists immediately — no save needed.' }));
        cardsRow.append(dpi);
        }

        // ---- smoothing ----
        if (caps.smoothing) {
        cardsRow.append(card('Smoothing', 'EMA (drashna pointing_device_smoothing)',
            toggleRow({ label: 'Enabled', value: await g(CH.smoothing, V.smoothingEnabled),
                onChange: (v) => flask.setU16(CH.smoothing, V.smoothingEnabled, v ? 1 : 0) }),
            sliderRow({ label: 'Factor', hint: '0 = raw, 1 = heavy', min: 0, max: 100, step: 1,
                value: await g(CH.smoothing, V.smoothingFactor), format: pct,
                onChange: (v) => flask.setU16(CH.smoothing, V.smoothingFactor, v) }),
            sliderRow({ label: 'Timeout (ms)', min: 0, max: 1000, step: 25,
                value: await g(CH.smoothing, V.smoothingTimeout),
                onChange: (v) => flask.setU16(CH.smoothing, V.smoothingTimeout, v) }),
            saveBar(() => flask.save(CH.smoothing))));
        }

        // ---- drag scroll ----
        // QMK trackballs only (caps.drag) — the Imprint runs the stock ZMK
        // scroll chain since imprint v3. Knob shapes vary by family:
        // per-axis divisors (Adept), emit-window tuning (Sval).
        if (caps.drag) {
        const perAxis = caps.dragPerAxis;
        const drag = card('Drag scroll',
            sval ? 'left-ball scrolling'
                 : 'DRG_TOG / scroll layer',
            sliderRow({ label: perAxis ? 'Horizontal divisor' : 'Divisor',
                min: 1, max: family === 'adept' ? 64 : 120, step: 1,
                value: await g(CH.dragScroll, V.dragDivH),
                onChange: (v) => flask.setU16(CH.dragScroll, V.dragDivH, v) }));
        if (perAxis) {
            drag.append(sliderRow({ label: 'Vertical divisor',
                min: 1, max: family === 'adept' ? 64 : 120, step: 1,
                value: await g(CH.dragScroll, V.dragDivV),
                onChange: (v) => flask.setU16(CH.dragScroll, V.dragDivV, v) }));
        }
        drag.append(toggleRow({ label: 'Inverted (natural)', value: await g(CH.dragScroll, V.dragInverted),
            onChange: (v) => flask.setU16(CH.dragScroll, V.dragInverted, v ? 1 : 0) }));
        if (caps.dragInvertX) {
            drag.append(toggleRow({ label: 'Invert horizontal', hint: 'orientation correction',
                value: await g(CH.dragScroll, V.dragInvertX),
                onChange: (v) => flask.setU16(CH.dragScroll, V.dragInvertX, v ? 1 : 0) }));
        }
        if (caps.dragWindow) {
            drag.append(
                sliderRow({ label: 'Emit interval (ms)', hint: 'coalescing window for slow viewers',
                    min: 0, max: 200, step: 2, value: await g(CH.dragScroll, V.dragInterval),
                    onChange: (v) => flask.setU16(CH.dragScroll, V.dragInterval, v) }),
                sliderRow({ label: 'Max notches/report', min: 1, max: 30, step: 1,
                    value: await g(CH.dragScroll, V.dragMaxNotches),
                    onChange: (v) => flask.setU16(CH.dragScroll, V.dragMaxNotches, v) }));
        }
        if (caps.dragRescue) {
            drag.append(el('button', {
                class: 'btn small', text: 'Force scroll off (rescue)',
                title: 'Live-state override — if the cursor is stuck in scroll mode',
                onclick: async () => {
                    try { await flask.setU16(CH.dragScroll, V.dragActive, 0); toast('Scroll forced off'); }
                    catch (e) { toast(e.message, true); }
                },
            }));
        }
        drag.append(saveBar(() => flask.save(CH.dragScroll)));
        cardsRow.append(drag);
        }

        // ---- wiggle ----
        if (caps.wiggle) {
            const wiggle = card('Shake to toggle', 'wiggle_ball',
                toggleRow({ label: 'Enabled', hint: 'kill switch — off if shakes misfire during fast movement',
                    value: await g(CH.wiggle, V.wiggleEnabled),
                    onChange: (v) => flask.setU16(CH.wiggle, V.wiggleEnabled, v ? 1 : 0) }),
                sliderRow({ label: 'Interval (ms)', min: 10, max: 2000, step: 10,
                    value: await g(CH.wiggle, V.wiggleInterval),
                    onChange: (v) => flask.setU16(CH.wiggle, V.wiggleInterval, v) }),
                sliderRow({ label: 'Cooldown (ms)', min: 50, max: 2000, step: 10,
                    value: await g(CH.wiggle, V.wiggleCooldown),
                    onChange: (v) => flask.setU16(CH.wiggle, V.wiggleCooldown, v) }),
                sliderRow({ label: 'Threshold (reversals)', min: 0, max: 20, step: 1,
                    value: await g(CH.wiggle, V.wiggleThreshold),
                    onChange: (v) => flask.setU16(CH.wiggle, V.wiggleThreshold, v) }),
                saveBar(() => flask.save(CH.wiggle)));
            cardsRow.append(wiggle);
        }

        // ---- auto-mouse ----
        if (caps.autoMouse) {
            const am = card('Auto-mouse layer', 'ball motion activates a layer',
                toggleRow({ label: 'Enabled', value: await g(CH.autoMouse, V.amEnabled),
                    onChange: (v) => flask.setU16(CH.autoMouse, V.amEnabled, v ? 1 : 0) }));
            if (sval) {
                // Sval: timeout is an INDEX into mh_timer_choices (persists
                // immediately in the stock KB datablock, like DPI).
                am.append(selectRow({
                    label: 'Timeout', value: await g(CH.autoMouse, V.amTimeout),
                    options: SVAL_AUTOMOUSE_TIMEOUTS.map((t, i) =>
                        ({ value: i, label: t < 0 ? '∞ (never)' : `${t} ms` })),
                    onChange: (v) => flask.setU16(CH.autoMouse, V.amTimeout, Number(v)),
                }));
            } else {
                am.append(sliderRow({ label: 'Timeout (ms)', min: 100, max: 5000, step: 50,
                    value: await g(CH.autoMouse, V.amTimeout),
                    onChange: (v) => flask.setU16(CH.autoMouse, V.amTimeout, v) }));
            }
            am.append(
                sliderRow({ label: 'Threshold (counts)', min: 0, max: 60, step: 1,
                    value: await g(CH.autoMouse, V.amThreshold),
                    onChange: (v) => flask.setU16(CH.autoMouse, V.amThreshold, v) }),
                selectRow({ label: 'Target layer', value: await g(CH.autoMouse, V.amLayer),
                    options: Array.from({ length: this.app.layerCount }, (_, i) =>
                        ({ value: i, label: this.app.profile?.layerNames?.[i] ?? `Layer ${i}` })),
                    onChange: (v) => flask.setU16(CH.autoMouse, V.amLayer, Number(v)) }),
                saveBar(() => flask.save(CH.autoMouse)));
            cardsRow.append(am);
        }

        // ---- autoscroll ----
        if (caps.autoscroll) {
            const as = card('Autoscroll', 'hands-free continuous scroll',
                toggleRow({ label: 'Inverted', value: await g(CH.autoscroll, V.asInverted),
                    onChange: (v) => flask.setU16(CH.autoscroll, V.asInverted, v ? 1 : 0) }),
                sliderRow({ label: 'Speed scale', hint: '1.00 = Ben White interval table as-is',
                    min: 25, max: 400, step: 5,
                    value: await g(CH.autoscroll, V.asSpeedScale), format: pct,
                    onChange: (v) => flask.setU16(CH.autoscroll, V.asSpeedScale, v) }));
            if (caps.autoscrollJog) {
                as.append(
                    sliderRow({ label: 'Jog deadzone', min: 0, max: 200, step: 5,
                        value: await g(CH.autoscroll, V.asDeadzone),
                        onChange: (v) => flask.setU16(CH.autoscroll, V.asDeadzone, v) }),
                    sliderRow({ label: 'Jog range', min: 50, max: 2000, step: 25,
                        value: await g(CH.autoscroll, V.asRange),
                        onChange: (v) => flask.setU16(CH.autoscroll, V.asRange, v) }));
            }
            if (caps.autoscrollStopOnKey) {
                as.append(toggleRow({ label: 'Any key stops scrolling',
                    value: await g(CH.autoscroll, V.asStopOnKey),
                    onChange: (v) => flask.setU16(CH.autoscroll, V.asStopOnKey, v ? 1 : 0) }));
            }
            as.append(
                el('button', {
                    class: 'btn small', text: 'Force stop (rescue)',
                    onclick: async () => {
                        try { await flask.setU16(CH.autoscroll, V.asState, 0); toast('Autoscroll stopped'); }
                        catch (e) { toast(e.message, true); }
                    },
                }),
                saveBar(() => flask.save(CH.autoscroll)));
            cardsRow.append(as);
        }

        // ---- health / freeze diagnostic ----
        if (caps.diag) {
            const gapEl = el('span', { class: 'mono' });
            const upEl = el('span', { class: 'mono' });
            const refresh = async () => {
                try {
                    gapEl.textContent = `${await g(CH.diag, V.diagMaxGap)} ms`;
                    const s = await g(CH.diag, V.diagUptime);
                    upEl.textContent = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
                } catch { /* leave stale */ }
            };
            await refresh();
            cardsRow.append(card('Health', 'freeze diagnostic',
                el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Largest pointing-task gap',
                    el('span', { class: 'hint', text: 'near a freeze length = firmware stall; single-digit ms = sensor/host' })),
                    el('span', { style: 'flex:1' }), gapEl),
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Uptime' }),
                    el('span', { style: 'flex:1' }), upEl),
                el('div', { class: 'savebar' },
                    el('button', { class: 'btn small', text: 'Refresh', onclick: refresh }),
                    el('button', {
                        class: 'btn small', text: 'Reset watermark',
                        onclick: async () => { await flask.setU16(CH.diag, V.diagMaxGap, 0); await refresh(); },
                    }))));
        }
    }
}
