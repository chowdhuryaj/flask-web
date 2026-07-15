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

import { el, card, sliderRow, toggleRow, selectRow, saveBar, toast, modal } from './ui.js?v=17';
import { CH, V } from './flaskproto.js?v=17';
import { hsvCss } from './rgb-tab.js?v=17';
import { colorPicker } from './colorpicker.js?v=17';
import { renderKeyboardSVG } from './keymap-tab.js?v=17';

/**
 * LED index → key mapping over the physical layout.
 *
 * A WIZARD-MEASURED map wins when one is stored (the "Map LEDs → keys"
 * flow below — bench 2026-07-11 proved the guessed order wrong on real
 * hardware: LED 0 lit key 17). Entry = keymap position per wire LED
 * (null = LED with no visible key, e.g. underglow).
 *
 * Fallback guess: the central (left) half owns LEDs [0, ledCount/2), the
 * peripheral (right) the rest; halves split at the geometry's x midpoint;
 * within a half, LED order follows key-position order. Returns an array
 * where entry i = the key lit by LED i (or undefined).
 */
const LEDMAP_STORE = 'flask-zmk-ledmap-imprint';

export function storedLedMap() {
    try { return JSON.parse(localStorage.getItem(LEDMAP_STORE)) ?? null; }
    catch { return null; }
}

export function saveLedMap(order) {
    if (order == null) localStorage.removeItem(LEDMAP_STORE);
    else localStorage.setItem(LEDMAP_STORE, JSON.stringify(order));
}

export function ledKeyOrder(keys, ledCount) {
    if (!keys?.length) return [];
    const custom = storedLedMap();
    if (custom?.length === ledCount) {
        const byPos = new Map(keys.map((k) => [k.pos, k]));
        return custom.map((p) => (p == null ? undefined : byPos.get(p)));
    }
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
        // v14: global brightness percent (native rgb_ug BRI analog).
        this.brightness = this.app.caps?.rgbBrightness
            ? await flask.getU16(CH.rgbMap, V.rgbmapBrightness) : null;
        if (this.app.caps?.rgbEffects) {
            this.effect = await flask.getU16(CH.rgbMap, V.rgbmapEffect);
            this.effectSpeed = await flask.getU16(CH.rgbMap, V.rgbmapEffectSpeed);
            this.effectHsv = [
                await flask.getU16(CH.rgbMap, V.rgbmapEffectHue),
                await flask.getU16(CH.rgbMap, V.rgbmapEffectSat),
                await flask.getU16(CH.rgbMap, V.rgbmapEffectVal),
            ];
        }
        // Split-link diagnosis (0x09, RO): has the central discovered the
        // peripheral's rgb GATT characteristic? Older firmware answers
        // unhandled — treat as unknown.
        try { this.splitLink = await flask.getU16(CH.rgbMap, V.rgbmapSplitLink); }
        catch { this.splitLink = null; }
        this.layerCache = {};
        await this.loadLayer();
        this.render();
        this.publishTint();
        // NO background preload of every layer: 10 layers × 70 LED reads
        // saturated the HID request queue for ~30 s after connect — starved
        // the HUD poll and made everything else time out (bench 2026-07-11
        // "device did not answer in time"). HUD tint covers visited layers.
    }

    async loadLayer() {
        this.leds = await this.readLayer(this.layer);
    }

    async readLayer(layer) {
        if (this.layerCache[layer]) return this.layerCache[layer];
        const leds = [];
        // HUD poll backs off for the 70-LED read (see combos tab note).
        this.app.hid?.pause?.();
        try {
            for (let led = 0; led < this.ledCount; led++) {
                const r = await this.app.flask.getBytes(CH.rgbMap, V.rgbmapLed, [layer, led], 2);
                leds.push([r[2] ?? 0, r[3] ?? 0, r[4] ?? 0]);
            }
        } finally {
            this.app.hid?.resume?.();
        }
        this.layerCache[layer] = leds;
        return leds;
    }

    /** HUD board tint: keymap position → this layer's painted color (null =
     * unpainted). Published on app so the HUD can mirror the physical board
     * (bench 2026-07-11: "configurator map updates, the HUD does not"). */
    publishTint() {
        this.app.zmkRgbTint = (layer, key) => {
            const leds = this.layerCache?.[layer];
            const keys = this.app.profile?.keys;
            if (!leds || !keys?.length) return null;
            if (this._tintKeys !== keys) {
                this._tintKeys = keys;
                this._posToLed = new Map();
                ledKeyOrder(keys, this.ledCount).forEach((k, led) => {
                    if (k) this._posToLed.set(k.col, led);
                });
            }
            const [h, s, v] = leds[this._posToLed.get(key.col)] ?? [0, 0, 0];
            return v ? hsvCss(h, s, v) : null;
        };
    }

    async paint(led) {
        const [h, s, v] = this.brush;
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapLed, [this.layer, led, h, s, v], 2);
            this.leds[led] = [h, s, v];
            this.render();
        } catch (e) { toast(`Paint failed: ${e.message}`, true); }
    }

    async clear(led) {
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapLed, [this.layer, led, 0, 0, 0], 2);
            this.leds[led] = [0, 0, 0];
            this.render();
        } catch (e) { toast(`Clear failed: ${e.message}`, true); }
    }

    async fill() {
        const [h, s, v] = this.brush;
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapFill, [this.layer, h, s, v], 1);
            this.leds = this.layerCache[this.layer] = this.leds.map(() => [h, s, v]);
            this.render();
        } catch (e) { toast(`Fill failed: ${e.message}`, true); }
    }

    layerName(i) {
        return this.app.profile?.layerNames?.[i] ?? `Layer ${i}`;
    }

    // ---- LED→key mapping wizard (the interactive paint sweep) ----
    //
    // Lights one wire LED at a time; the user clicks the physical key that
    // lit (or Skip for LEDs with no visible key — underglow). The measured
    // order is stored (ledKeyOrder prefers it: painter, HUD tint, everything
    // follows) and a firmware key-positions snippet is generated for the
    // reactive overlay's devicetree map.

    async startWizard() {
        if (!this.app.profile?.keys?.length) {
            toast('Open the Keymap tab once first — the wizard needs board geometry', true);
            return;
        }
        this.wizard = { led: 0, order: Array(this.ledCount).fill(null), orig: null,
            effectWas: this.effect };
        // A running effect animates the WHOLE strip — the wizard's single
        // white LED disappears into it ("mapping stopped working", bench 5:
        // the sweep worked with the effect off, then an effect got saved and
        // the next run was unusable). Force Off for the sweep; finish/abort
        // restores.
        if (this.effect) {
            try { this.effect = await this.app.flask.setU16(CH.rgbMap, V.rgbmapEffect, 0); }
            catch { /* effect card still shows the truth on next load */ }
        }
        await this.lightWizardLed();
    }

    async _restoreWizardEffect(effectWas) {
        if (!effectWas) return;
        try { this.effect = await this.app.flask.setU16(CH.rgbMap, V.rgbmapEffect, effectWas); }
        catch { /* cosmetic */ }
    }

    async lightWizardLed() {
        const w = this.wizard;
        w.orig = [...(this.leds[w.led] ?? [0, 0, 0])];
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapLed, [this.layer, w.led, 0, 0, 255], 2);
        } catch (e) {
            toast(`Couldn't light LED ${w.led}: ${e.message}`, true);
        }
        this.render();
    }

    async restoreWizardLed() {
        const w = this.wizard;
        try {
            await this.app.flask.setBytes(CH.rgbMap, V.rgbmapLed,
                [this.layer, w.led, ...(w.orig ?? [0, 0, 0])], 2);
        } catch { /* cosmetic — the map cache still holds the original */ }
    }

    async answerWizard(pos) {
        const w = this.wizard;
        w.order[w.led] = pos;
        await this.restoreWizardLed();
        if (w.led + 1 >= this.ledCount) { this.finishWizard(); return; }
        w.led += 1;
        await this.lightWizardLed();
    }

    async backWizard() {
        const w = this.wizard;
        if (w.led === 0) return;
        await this.restoreWizardLed();
        w.led -= 1;
        w.order[w.led] = null;
        await this.lightWizardLed();
    }

    async abortWizard() {
        await this.restoreWizardLed();
        const { effectWas } = this.wizard;
        this.wizard = null;
        await this._restoreWizardEffect(effectWas);
        this.render();
    }

    finishWizard() {
        const { order, effectWas } = this.wizard;
        this.wizard = null;
        this._restoreWizardEffect(effectWas);
        saveLedMap(order);
        this._tintKeys = null; // rebuild the HUD tint lookup from the new map
        const mapped = order.filter((p) => p != null).length;
        if (this.app.caps?.rgbLedOrder) {
            // v12: the measured order lives ON THE DEVICE — the reactive
            // overlay (leader candidate lighting) follows it immediately,
            // no keymap edit or reflash. Save persists it.
            this._pushLedOrder(order).then((ok) => {
                const back = modal('LED map saved', el('div', {},
                    el('p', { text: `${mapped} of ${order.length} LEDs mapped to keys. The painter, HUD tint and exports use the measured order.` }),
                    el('p', { text: ok
                        ? 'Pushed to the device too — leader candidate lighting follows it now. Hit Save (RGB) to persist across power cycles.'
                        : 'Device push FAILED — the browser map is saved; retry the wizard or check the connection.' })), [
                    el('button', { class: 'btn small primary', text: 'Done', onclick: () => back.remove() }),
                ]);
            });
            this.render();
            return;
        }
        // Pre-v12 firmware: emit the devicetree snippet instead.
        const rows = [];
        for (let i = 0; i < order.length; i += 12) {
            rows.push('    ' + order.slice(i, i + 12).map((p) => String(p ?? 255).padStart(3)).join(' '));
        }
        const snippet = `key-positions = <\n${rows.join('\n')}\n>;`;
        const ta = el('textarea', {
            readonly: true, rows: 10,
            style: 'width:100%; font-family:monospace; font-size:12px',
        });
        ta.value = snippet;
        const back = modal('LED map saved', el('div', {},
            el('p', { text: `${mapped} of ${order.length} LEDs mapped to keys. The painter, HUD tint and exports now use the measured order (stored in this browser).` }),
            el('p', { text: 'Firmware side (leader candidate lighting): paste this over the key-positions block in config/imprint.keymap → flask_rgb.' }),
            ta), [
            el('button', { class: 'btn small primary', text: 'Done', onclick: () => back.remove() }),
        ]);
        this.render();
    }

    /** Push a measured LED→position order to the device in chunked
     * RGBMAP_LEDORDER frames (v12). 255 = no key under that LED. */
    async _pushLedOrder(order) {
        const { flask, hid } = this.app;
        const CHUNK = 24;
        hid?.pause?.();
        try {
            for (let start = 0; start < order.length; start += CHUNK) {
                const part = order.slice(start, start + CHUNK).map((p) => p ?? 0xFF);
                await flask.setBytes(CH.rgbMap, V.rgbmapLedOrder,
                    [start, part.length, ...part], 2);
            }
            return true;
        } catch (e) {
            toast(`LED order push failed: ${e.message}`, true);
            return false;
        } finally {
            hid?.resume?.();
        }
    }

    wizardCard() {
        const w = this.wizard;
        const keys = this.app.profile.keys;
        const mappedPos = new Set(w.order.filter((p) => p != null));
        const board = renderKeyboardSVG({
            profile: {
                keys, encoderKeys: [],
                labelFor: () => '', hoverFor: () => 'click if this key just lit',
                keyName: (k) => String(k.pos),
            },
            keycodeAt: () => null,
            pressed: new Set(),
            fillFor: (k) => (mappedPos.has(k.pos) ? 'rgba(60,180,110,0.45)' : null),
            onSelect: (sel) => this.answerWizard(sel.col),
            scale: 0.72,
        });
        return card('Map LEDs → keys',
            'one LED at a time — click the key that lights on the board',
            el('div', { class: 'row' },
                el('b', { text: `LED ${w.led} of ${this.ledCount}` }),
                el('span', { class: 'hint', text: 'is lit WHITE right now — click that key below (green = already mapped)' })),
            el('div', { style: 'overflow-x:auto' }, board),
            el('div', { class: 'savebar' },
                el('button', { class: 'btn small', text: '⏭ Skip (no key lit / underglow)',
                    onclick: () => this.answerWizard(null) }),
                el('button', { class: 'btn small', text: '↩ Back', onclick: () => this.backWizard() }),
                el('button', { class: 'btn small', text: '✕ Abort', onclick: () => this.abortWizard() })));
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
        if (this.wizard) {
            this.root.replaceChildren(this.wizardCard());
            return;
        }
        const { flask } = this.app;
        // The brush is the whole point of this tab, so it gets a real picker:
        // SV field + hue strip + hex + eyedropper + presets + saved swatches,
        // instead of three 0-255 sliders you re-dial for every colour. The
        // picker speaks the firmware's HSV space directly — nothing converts.
        const picker = colorPicker({
            hsv: this.brush,
            onChange: (hsv) => { this.brush = hsv; },
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
            this.brightness != null ? sliderRow({
                label: 'Brightness',
                hint: 'global — scales the painted map, effects and overlays on both halves',
                min: 0, max: 100, step: 5, value: this.brightness,
                format: (v) => `${v}%`,
                onChange: async (val) => {
                    this.brightness = await flask.setU16(CH.rgbMap, V.rgbmapBrightness, val);
                    return this.brightness;
                },
            }) : null,
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
                el('span', { class: 'lbl' }, 'Brush',
                    el('span', { class: 'hint', text: 'click a key on the board to paint it; right-click clears' }))),
            picker,
            this.board(),
            el('div', { class: 'savebar' },
                el('button', { class: 'btn small', text: 'Fill layer with brush', onclick: () => this.fill() }),
                el('button', {
                    class: 'btn small', text: 'Clear layer',
                    onclick: async () => {
                        try {
                            await flask.setBytes(CH.rgbMap, V.rgbmapFill, [this.layer, 0, 0, 0], 1);
                            this.leds = this.layerCache[this.layer] = this.leds.map(() => [0, 0, 0]);
                            this.render();
                        } catch (e) { toast(`Clear failed: ${e.message}`, true); }
                    },
                }),
                el('button', {
                    class: 'btn small', text: '🧭 Map LEDs → keys',
                    title: 'Interactive paint sweep: measures which physical key each wire LED lights',
                    onclick: () => this.startWizard(),
                }),
                storedLedMap() ? el('button', {
                    class: 'btn small', text: 'Reset LED map',
                    title: 'Forget the measured LED→key order (back to the guessed order)',
                    onclick: () => { saveLedMap(null); this._tintKeys = null; this.render(); },
                }) : null),
            el('div', {
                class: 'note faint',
                text: this.splitLink == null
                    ? (storedLedMap() ? 'Using the measured LED→key map.' : 'Using the GUESSED LED→key order — run Map LEDs → keys once on hardware.')
                    : `Peripheral link: ${this.splitLink ? '✓ connected — right half receives edits' : '✗ NOT connected — right half will stay dark (re-pair the halves, then reload)'}`
                    + (storedLedMap() ? ' · measured LED map in use.' : ' · GUESSED LED order — run Map LEDs → keys.'),
            }),
            saveBar(() => flask.save(CH.rgbMap),
                'Live edits reach both halves over the split link; Save persists on the central.'));

        this.root.replaceChildren(painter);
        if (this.app.caps?.rgbEffects) this.root.append(this.effectsCard());
    }
}

const EFFECT_NAMES = ['Off', 'Solid', 'Breathe', 'Spectrum', 'Swirl'];
