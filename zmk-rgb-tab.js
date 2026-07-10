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
//
// The paint surface renders on the same device-sourced key geometry as the
// keymap tab (app.profile.keys, published by ZmkKeymapTab/HUD load) — halves
// side by side, thumb clusters where they physically sit. Falls back to the
// flat index grid until the keymap tab has connected once.

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast } from './ui.js?v=9';
import { CH, V } from './flaskproto.js?v=9';
import { hsvCss } from './rgb-tab.js?v=9';
import { renderKeyboardSVG } from './keymap-tab.js?v=9';

/**
 * LED index → key mapping over the physical layout: the central (left) half
 * owns LEDs [0, ledCount/2), the peripheral (right) the rest. Halves are
 * split at the geometry's x midpoint; within a half, LED order is assumed to
 * follow key-position order until the bench paint-sweep says otherwise (fix
 * the ordering HERE if the sweep disagrees — the wire is index-addressed
 * either way). Returns an array where entry i = the key lit by LED i (or
 * undefined for LEDs beyond the mapped keys).
 */
export function ledKeyOrder(keys, ledCount) {
    if (!keys?.length) return [];
    const xs = keys.map((k) => k.x + k.w / 2);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const half = (pred) => keys.filter(pred).sort((a, b) => a.pos - b.pos);
    const left = half((k) => k.x + k.w / 2 < mid);
    const right = half((k) => k.x + k.w / 2 >= mid);
    const central = Math.ceil(ledCount / 2);
    const order = [];
    for (let i = 0; i < ledCount; i++) {
        order.push(i < central ? left[i] : right[i - central]);
    }
    return order;
}

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
        if (this.app.caps?.rgbEffects) {
            this.effect = await flask.getU16(CH.rgbMap, V.rgbmapEffect);
            this.effectSpeed = await flask.getU16(CH.rgbMap, V.rgbmapEffectSpeed);
            this.effectHsv = [
                await flask.getU16(CH.rgbMap, V.rgbmapEffectHue),
                await flask.getU16(CH.rgbMap, V.rgbmapEffectSat),
                await flask.getU16(CH.rgbMap, V.rgbmapEffectVal),
            ];
        }
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

    /** Whole-strip effect engine (flask_rgb v9): runs UNDER the painted map
     * — painted keys overlay it, the same layering the NLKB16 card
     * describes. One card, all live; Save rides the map's savebar (same
     * channel). */
    effectsCard() {
        const { flask } = this.app;
        const hsvSlider = (label, idx, vid) => sliderRow({
            label, min: 0, max: 255, step: 1, value: this.effectHsv[idx],
            onChange: async (v) => {
                this.effectHsv[idx] = await flask.setU16(CH.rgbMap, vid, v);
                return this.effectHsv[idx];
            },
        });

        return card('Effect engine', 'whole-strip animations — painted keys above overlay these',
            selectRow({
                label: 'Effect', value: this.effect,
                options: EFFECT_NAMES.map((label, value) => ({ value, label })),
                onChange: async (v) => {
                    this.effect = await flask.setU16(CH.rgbMap, V.rgbmapEffect, Number(v));
                    this.render();
                },
            }),
            sliderRow({
                label: 'Speed', min: 1, max: 255, step: 1, value: this.effectSpeed,
                onChange: async (v) => {
                    this.effectSpeed = await flask.setU16(CH.rgbMap, V.rgbmapEffectSpeed, v);
                    return this.effectSpeed;
                },
            }),
            hsvSlider('Hue', 0, V.rgbmapEffectHue),
            hsvSlider('Saturation', 1, V.rgbmapEffectSat),
            hsvSlider('Value', 2, V.rgbmapEffectVal),
            el('div', { class: 'note faint',
                text: 'Hue only shapes Solid and Breathe; Spectrum and Swirl cycle it. Save on the map card persists effect settings too (same channel).' }));
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

    /** Paint surface on the keymap tab's device-sourced geometry (halves side
     * by side, thumb clusters separated). LEDs that map past the key list —
     * or everything, before the keymap tab has connected — fall back to the
     * flat index grids. */
    board() {
        const keys = this.app.profile?.keys;
        const central = Math.ceil(this.ledCount / 2);
        if (!keys?.length) {
            return el('div', {},
                el('div', { class: 'note faint',
                    text: 'Open the Keymap tab once for the board view — index grid meanwhile.' }),
                this.half('Left half (central) — LEDs 0…' + (central - 1), 0, central),
                this.half(`Right half — LEDs ${central}…${this.ledCount - 1}`, central,
                    this.ledCount - central));
        }

        const order = ledKeyOrder(keys, this.ledCount);
        const ledOf = new Map();   // key identity → led index
        order.forEach((k, led) => { if (k) ledOf.set(k, led); });
        const mapped = order.filter(Boolean);

        const svg = renderKeyboardSVG({
            profile: {
                keys: mapped,
                encoderKeys: [],
                labelFor: () => '',
                hoverFor: (led) => {
                    const [h, s, v] = this.leds[led] ?? [0, 0, 0];
                    return `LED ${led} — hsv(${h}, ${s}, ${v}). Click paints; right-click clears.`;
                },
                keyName: (k) => String(ledOf.get(k)),
            },
            keycodeAt: (row, col) => ledOf.get(mapped.find((k) => k.row === row && k.col === col)),
            fillFor: (k) => {
                const [h, s, v] = this.leds[ledOf.get(k)] ?? [0, 0, 0];
                return v ? hsvCss(h, s, v) : null;
            },
            onSelect: (sel) => {
                const k = mapped.find((m) => m.row === sel.row && m.col === sel.col);
                if (k) this.paint(ledOf.get(k));
            },
            onContext: (sel) => {
                const k = mapped.find((m) => m.row === sel.row && m.col === sel.col);
                if (k) this.clear(ledOf.get(k));
            },
            scale: 0.72,
        });

        const spill = this.ledCount - mapped.length;
        return el('div', {},
            el('div', { style: 'overflow-x:auto' }, svg),
            spill > 0 ? this.half(`Unmapped LEDs ${mapped.length}…${this.ledCount - 1}`,
                mapped.length, spill) : null);
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
            this.board(),
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
        if (this.app.caps?.rgbEffects) this.root.append(this.effectsCard());
    }
}

const EFFECT_NAMES = ['Off', 'Solid', 'Breathe', 'Spectrum', 'Swirl'];
