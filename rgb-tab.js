// NLKB16 RGB tab: per-layer per-key HSV painter (Flask channel 0x21,
// PAYLOAD-ADDRESSED frames — never the u16 helpers) + the stock VialRGB
// effect engine (2-byte-header frames straight through hid.rawCommand;
// the Flask handler leaves data[1] ∈ 0x40-0x44 alone by design).
// Ports of NLKB16Model.swift + TileGridTabs.swift.

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=10';
import { CH, V, NLKB } from './flaskproto.js?v=10';

const VIALRGB = { getInfo: 0x40, mode: 0x41, getSupported: 0x42 };
const EFFECT_NAMES = ['Off', 'Direct Control', 'Solid Color', 'Alphas/Mods',
    'Gradient Up/Down', 'Gradient Left/Right', 'Breathing', 'Band Sat',
    'Band Val', 'Band Pinwheel Sat', 'Band Pinwheel Val', 'Band Spiral Sat',
    'Band Spiral Val', 'Cycle All', 'Cycle Left/Right', 'Cycle Up/Down',
    'Rainbow Moving Chevron', 'Cycle Out/In', 'Cycle Out/In Dual',
    'Cycle Pinwheel', 'Cycle Spiral', 'Dual Beacon', 'Rainbow Beacon',
    'Rainbow Pinwheels', 'Raindrops', 'Jellybean Raindrops', 'Hue Breathing',
    'Hue Pendulum', 'Hue Wave', 'Typing Heatmap', 'Digital Rain',
    'Solid Reactive Simple', 'Solid Reactive', 'Solid Reactive Wide',
    'Solid Reactive Multiwide', 'Solid Reactive Cross',
    'Solid Reactive Multicross', 'Solid Reactive Nexus',
    'Solid Reactive Multinexus', 'Splash', 'Multisplash', 'Solid Splash',
    'Solid Multisplash', 'Pixel Rain', 'Pixel Fractal',
    'Per-Key RGB (Keychron)', 'Mixed RGB (Keychron)'];

/** QMK HSV (0-255 each) → CSS color. */
export function hsvCss(h, s, v) {
    const hh = (h / 255) * 360, ss = s / 255, vv = v / 255;
    const c = vv * ss, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = vv - c;
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x]
        : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    const to = (n) => Math.round((n + m) * 255);
    return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}

export class RgbTab {
    constructor(app) { this.app = app; this.root = el('div'); }

    async load() {
        this.layer = 0;
        this.brush = [140, 255, 180]; // pleasant default teal-ish
        this.enabled = await this.app.flask.getU16(CH.rgbMap, V.rgbmapEnabled);
        await this.loadLayer();
        this.render();
    }

    async loadLayer() {
        this.leds = [];
        for (let led = 0; led < NLKB.ledCount; led++) {
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

    async fill() {
        const [h, s, v] = this.brush;
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapFill, [this.layer, h, s, v]);
            this.leds = this.leds.map(() => [h, s, v]);
            this.render();
        } catch (e) { toast(`Fill failed: ${e.message}`, true); }
    }

    swatch(led) {
        const [h, s, v] = this.leds[led];
        return el('button', {
            class: 'code', title: `LED ${led} — hsv(${h}, ${s}, ${v})`,
            style: `background:${v ? hsvCss(h, s, v) : 'transparent'}; width:40px; height:32px;` +
                (v ? '' : 'opacity:0.5'),
            onclick: () => this.paint(led),
        }, v ? '' : '·');
    }

    async vialrgbCard() {
        // Live effect engine — raw frames, so only when a device is attached.
        if (this.app.offline) return null;
        try {
            const info = await this.app.hid.rawCommand([0x08, VIALRGB.getInfo]);
            const maxBright = info[4] ?? 255;
            const supported = [];
            let gt = 0;
            for (;;) {
                const r = await this.app.hid.rawCommand([0x08, VIALRGB.getSupported, gt & 0xFF, gt >> 8]);
                let got = false;
                for (let i = 2; i + 1 < r.length; i += 2) {
                    const id = r[i] | (r[i + 1] << 8);
                    if (id === 0xFFFF) break;
                    supported.push(id);
                    gt = id + 1;
                    got = true;
                }
                if (!got) break;
            }
            const m = await this.app.hid.rawCommand([0x08, VIALRGB.mode]);
            let mode = m[2] | (m[3] << 8), speed = m[4], h = m[5], s = m[6], vv = m[7];
            const push = async () => {
                await this.app.hid.rawCommand([0x07, VIALRGB.mode, mode & 0xFF, mode >> 8, speed, h, s, vv]);
            };
            return card('Effect engine (VialRGB)', 'whole-strip animations — the per-key map above overlays these',
                selectRow({
                    label: 'Effect', value: mode,
                    options: supported.map((id) => ({ value: id, label: EFFECT_NAMES[id] ?? `Effect ${id}` })),
                    onChange: async (val) => { mode = Number(val); await push(); },
                }),
                sliderRow({ label: 'Speed', min: 0, max: 255, step: 5, value: speed,
                    onChange: async (val) => { speed = val; await push(); return val; } }),
                sliderRow({ label: 'Hue', min: 0, max: 255, step: 5, value: h,
                    onChange: async (val) => { h = val; await push(); return val; } }),
                sliderRow({ label: 'Saturation', min: 0, max: 255, step: 5, value: s,
                    onChange: async (val) => { s = val; await push(); return val; } }),
                sliderRow({ label: 'Brightness', min: 0, max: maxBright, step: 5, value: vv,
                    onChange: async (val) => { vv = val; await push(); return val; } }));
        } catch { return null; } // plain-Vial or VialRGB absent — hide quietly
    }

    render() {
        const { flask } = this.app;
        const [h, s, v] = this.brush;
        const preview = el('span', {
            class: 'code',
            style: `background:${hsvCss(h, s, v)}; width:40px; height:24px; display:inline-block`,
        });
        const brushSlider = (label, idx, max = 255) => sliderRow({
            label, min: 0, max, step: 1, value: this.brush[idx],
            onChange: async (val) => {
                this.brush[idx] = val;
                preview.style.background = hsvCss(...this.brush);
                return val;
            },
        });

        const painter = card('Per-key RGB map', `layer-colored keys — RGBMAP_TOG on the keymap flips it live`,
            toggleRow({ label: 'Layer map enabled', value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.rgbMap, V.rgbmapEnabled, val ? 1 : 0);
                    return this.enabled;
                } }),
            selectRow({ label: 'Layer', value: this.layer,
                options: Array.from({ length: NLKB.rgbLayers }, (_, i) => ({ value: i, label: `Layer ${i}` })),
                onChange: async (val) => { this.layer = Number(val); await this.loadLayer(); this.render(); } }),
            el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Brush' }), el('span', { style: 'flex:1' }), preview),
            brushSlider('Hue', 0), brushSlider('Saturation', 1), brushSlider('Value', 2),
            el('div', { class: 'note faint', text: 'Key LEDs (matrix order):' }),
            el('div', { style: 'display:grid; grid-template-columns:repeat(4, 40px); gap:3px' },
                ...Array.from({ length: NLKB.keyLeds }, (_, i) => this.swatch(i))),
            el('div', { class: 'note faint', text: 'Knob / edge LEDs:' }),
            el('div', { style: 'display:flex; gap:3px; flex-wrap:wrap' },
                ...Array.from({ length: NLKB.ledCount - NLKB.keyLeds }, (_, i) => this.swatch(NLKB.keyLeds + i))),
            el('div', { class: 'savebar' },
                el('button', { class: 'btn small', text: 'Fill layer with brush', onclick: () => this.fill() })),
            saveBar(() => flask.save(CH.rgbMap)));

        this.root.replaceChildren(painter);
        this.vialrgbCard().then((c) => { if (c) this.root.append(c); });
    }
}
