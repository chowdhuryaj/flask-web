// NLKB16 Display tab: OLED widgets per big line, custom text, idle sleep,
// overlays, push test, panel health + re-init. Port of NLKB16Tabs.swift.
// Glass gotchas (vial-qmk CLAUDE.md): 64×32 window, 4 double-height lines,
// custom text ≤5 chars/line; push/raw-cmd/reinit are live actions (offline
// mode journals only widgets, text, and the three sliders).

import { el, card, sliderRow, selectRow, saveBar, toast } from './ui.js?v=16';
import { CH, V, slot, NLKB } from './flaskproto.js?v=16';

export class DisplayTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        const { flask } = this.app;
        this.widgets = [];
        this.texts = [];
        for (let line = 0; line < NLKB.bigLines; line++) {
            this.widgets.push(await flask.getU16(CH.display, slot.dispWidget(line)));
            const t = await flask.getBytes(CH.display, slot.dispCustom(line), []);
            this.texts.push(new TextDecoder().decode(new Uint8Array(t)).replace(/\0.*$/, '').trimEnd());
        }
        this.holdMs = await flask.getU16(CH.display, V.dispHoldMs);
        this.sleepS = await flask.getU16(CH.display, V.dispSleepS);
        this.overlayMs = await flask.getU16(CH.display, V.dispOverlayMs);
        this.render();
    }

    lineRow(line) {
        const { flask } = this.app;
        const textIn = el('input', {
            type: 'text', maxlength: NLKB.visibleCols, size: 6,
            value: this.texts[line], placeholder: '5 chars',
            title: 'Custom text for this line (widget "Custom text")',
        });
        textIn.addEventListener('change', async () => {
            try {
                await flask.setBytes(CH.display, slot.dispCustom(line),
                    [...new TextEncoder().encode(textIn.value.slice(0, NLKB.visibleCols))]);
                this.texts[line] = textIn.value;
                toast(`Line ${line} text set`);
            } catch (e) { toast(`Write failed: ${e.message}`, true); }
        });
        return el('div', { class: 'row', style: 'gap:6px' },
            el('span', { class: 'lbl', text: `Line ${line}` }),
            el('select', {
                onchange: async (ev) => {
                    try {
                        this.widgets[line] = await flask.setU16(CH.display, slot.dispWidget(line), Number(ev.target.value));
                    } catch (e) { toast(`Write failed: ${e.message}`, true); }
                },
            }, ...NLKB.widgetNames.map((name, i) =>
                el('option', { value: i, text: name, selected: i === this.widgets[line] ? true : null }))),
            textIn);
    }

    async liveCards() {
        if (this.app.offline) return [];
        const { flask } = this.app;
        const out = [];
        // Push test — transient overlay lines on the real panel.
        const pushLine = el('select', {},
            ...Array.from({ length: NLKB.bigLines }, (_, i) => el('option', { value: i, text: `Line ${i}` })));
        const pushText = el('input', { type: 'text', maxlength: NLKB.visibleCols, size: 6, placeholder: 'HELLO' });
        out.push(card('Push test', 'temporary lines on the panel (release restores widgets)',
            el('div', { class: 'row', style: 'gap:6px' }, pushLine, pushText,
                el('button', {
                    class: 'btn small', text: 'Push',
                    onclick: async () => {
                        try {
                            await flask.setBytes(CH.display, V.dispPush,
                                [Number(pushLine.value), ...new TextEncoder().encode(pushText.value)]);
                        } catch (e) { toast(e.message, true); }
                    },
                }),
                el('button', {
                    class: 'btn small', text: 'Release',
                    onclick: async () => {
                        try { await flask.setBytes(CH.display, V.dispRelease, []); }
                        catch (e) { toast(e.message, true); }
                    },
                }))));
        // Health.
        try {
            const active = await flask.getU16(CH.display, V.dispActive);
            const fails = await flask.getU16(CH.display, V.dispI2CFails);
            const recovers = await flask.getU16(CH.display, V.dispI2CRecovers);
            out.push(card('Panel health', '',
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Panel on' }),
                    el('span', { style: 'flex:1' }), el('span', { class: 'mono', text: active ? 'yes' : 'no' })),
                el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'I2C fails / recovers' }),
                    el('span', { style: 'flex:1' }), el('span', { class: 'mono', text: `${fails} / ${recovers}` })),
                el('div', { class: 'savebar' }, el('button', {
                    class: 'btn small', text: 'Re-init panel',
                    title: 'Full SSD1306 re-init — the RGB-boot-wedge rescue; survives without a replug',
                    onclick: async () => {
                        try { await flask.setU16(CH.display, V.dispReinit, 1); toast('Panel re-initialized'); }
                        catch (e) { toast(e.message, true); }
                    },
                }))));
        } catch { /* health ids missing — leave the card out */ }
        return out;
    }

    render() {
        const { flask } = this.app;
        const c = card('OLED display', '4 double-height lines × 5 chars — pick a widget per line',
            ...Array.from({ length: NLKB.bigLines }, (_, line) => this.lineRow(line)),
            sliderRow({ label: 'Pushed-line hold (ms)', min: 250, max: 10000, step: 250,
                value: this.holdMs,
                onChange: (v) => flask.setU16(CH.display, V.dispHoldMs, v) }),
            sliderRow({ label: 'Idle sleep (s)', hint: '0 = never — the burn-in guard', min: 0, max: 3600, step: 30,
                value: this.sleepS,
                onChange: (v) => flask.setU16(CH.display, V.dispSleepS, v) }),
            sliderRow({ label: 'Overlay duration (ms)', hint: 'volume / RGB / autoscroll flashes; 0 = off',
                min: 0, max: 10000, step: 250,
                value: this.overlayMs,
                onChange: (v) => flask.setU16(CH.display, V.dispOverlayMs, v) }),
            saveBar(() => flask.save(CH.display)));
        this.root.replaceChildren(c);
        this.liveCards().then((cards) => this.root.append(...cards));
    }
}
