// ZMK RGB tab — flask_rgb per-layer per-key HSV painter (channel 0x21,
// PAYLOAD-ADDRESSED frames). ZMK-line module: dimensions come from the
// device (0x02 layers / 0x03 leds), never from board constants; layer
// names ride along from the Studio keymap tab when it has connected
// (app.profile.layerNames). No VialRGB effect engine on ZMK — flask_rgb
// is the whole strip owner.
//
// LED indices are the module's global space: the central (left) half is
// [0, ledCount/2), the peripheral (right) follows. The bench paint-sweep
// is how the physical mapping gets confirmed — paint one LED at a time
// and watch which key lights.

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=6';
import { CH, V } from './flaskproto.js?v=6';
import { hsvCss } from './rgb-tab.js?v=6';

export class ZmkRgbTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
    }

    async load() {
        const { flask } = this.app;

        this.layer = 0;
        this.brush = [140, 255, 180];
        this.enabled = await flask.getU16(CH.rgbMap, V.rgbmapEnabled);
        this.layerCount = await flask.getU16(CH.rgbMap, V.rgbmapLayers);
        this.ledCount = await flask.getU16(CH.rgbMap, V.rgbmapLeds);
        await this.loadLayer();
        this.render();
    }

    async loadLayer() {
        this.leds = [];
        for (let led = 0; led < this.ledCount; led++) {
            const r = await this.app.flask.getBytes(CH.rgbMap, V.rgbmapLed, [this.layer, led]);
            this.leds.push([r[2] ?? 0, r[3] ?? 0, r[4] ?? 0]);
        }
    }

    async paint(led) {
        const [h, s, v] = this.brush;
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapLed, [this.layer, led, h, s, v]);
            this.leds[led] = [h, s, v];
            this.render();
        } catch (e) { toast(`Paint failed: ${e.message}`, true); }
    }

    async clear(led) {
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapLed, [this.layer, led, 0, 0, 0]);
            this.leds[led] = [0, 0, 0];
            this.render();
        } catch (e) { toast(`Clear failed: ${e.message}`, true); }
    }

    async fill() {
        const [h, s, v] = this.brush;
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapFill, [this.layer, h, s, v]);
            this.leds = this.leds.map(() => [h, s, v]);
            this.render();
        } catch (e) { toast(`Fill failed: ${e.message}`, true); }
    }

    layerName(i) {
        return this.app.profile?.layerNames?.[i] ?? `Layer ${i}`;
    }

    swatch(led) {
        const [h, s, v] = this.leds[led];
        return el('button', {
            class: 'code',
            title: `LED ${led} — hsv(${h}, ${s}, ${v}). Click paints; right-click clears.`,
            style: `background:${v ? hsvCss(h, s, v) : 'transparent'}; width:34px; height:28px;`
                + (v ? '' : 'opacity:0.5'),
            onclick: () => this.paint(led),
            oncontextmenu: (e) => { e.preventDefault(); this.clear(led); },
        }, v ? '' : '·');
    }

    half(label, start, count) {
        return el('div', {},
            el('div', { class: 'note faint', text: label }),
            el('div', { style: 'display:grid; grid-template-columns:repeat(7, 34px); gap:3px; margin-bottom:8px' },
                ...Array.from({ length: count }, (_, i) => this.swatch(start + i))));
    }

    render() {
        const { flask } = this.app;
        const [h, s, v] = this.brush;
        const preview = el('span', {
            class: 'code',
            style: `background:${hsvCss(h, s, v)}; width:40px; height:24px; display:inline-block`,
        });
        const brushSlider = (label, idx) => sliderRow({
            label, min: 0, max: 255, step: 1, value: this.brush[idx],
            onChange: async (val) => {
                this.brush[idx] = val;
                preview.style.background = hsvCss(...this.brush);
                return val;
            },
        });

        const central = Math.ceil(this.ledCount / 2);
        const painter = card('Per-key RGB map',
            'layer-colored keys — edits are live on the board; Save persists',
            toggleRow({
                label: 'Layer map enabled',
                hint: '&frgb FRGB_TOG on the Control layer flips this too',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.rgbMap, V.rgbmapEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            selectRow({
                label: 'Layer', value: this.layer,
                options: Array.from({ length: this.layerCount }, (_, i) =>
                    ({ value: i, label: this.layerName(i) })),
                onChange: async (val) => {
                    this.layer = Number(val);
                    await this.loadLayer();
                    this.render();
                },
            }),
            el('div', { class: 'row' },
                el('span', { class: 'lbl', text: 'Brush' }),
                el('span', { style: 'flex:1' }), preview),
            brushSlider('Hue', 0), brushSlider('Saturation', 1), brushSlider('Value', 2),
            this.half('Left half (central) — LEDs 0…' + (central - 1), 0, central),
            this.half(`Right half — LEDs ${central}…${this.ledCount - 1}`, central,
                this.ledCount - central),
            el('div', { class: 'savebar' },
                el('button', { class: 'btn small', text: 'Fill layer with brush', onclick: () => this.fill() }),
                el('button', {
                    class: 'btn small', text: 'Clear layer',
                    onclick: async () => {
                        try {
                            await flask.setBytes(CH.rgbMap, V.rgbmapFill, [this.layer, 0, 0, 0]);
                            this.leds = this.leds.map(() => [0, 0, 0]);
                            this.render();
                        } catch (e) { toast(`Clear failed: ${e.message}`, true); }
                    },
                })),
            saveBar(() => flask.save(CH.rgbMap),
                'Live edits reach both halves over the split link; Save persists on the central.'));

        this.root.replaceChildren(painter);
    }
}
