// Generic HSV colour picker — no device or firmware knowledge, so it is a
// shared component (like ui.js's modal/saveBar), not ZMK code. Speaks the
// FIRMWARE's colour space directly: h/s/v each 0-255, where hue 0-255 maps
// onto 0-360°. That is what flask_rgb's LED frames carry, so nothing has to
// convert at the call site and no rounding creeps in between the picker and
// the wire.
//
// Deliberately inline, not a modal: picking a colour is the whole task on the
// RGB tab, and a dialog you open, use once and dismiss for every key is the
// thing that made the old three-slider brush tedious.
//
// window/localStorage are touched only inside functions — the node vector
// suite imports this file for the pure conversions.

/** hsv (0-255 each) → rgb (0-255 each). Mirrors rgb-tab.js's hsvCss maths. */
export function hsvToRgb(h, s, v) {
    const hh = (h / 255) * 360, ss = s / 255, vv = v / 255;
    const c = vv * ss, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = vv - c;
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x]
        : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map((n) => Math.round((n + m) * 255));
}

/** rgb (0-255 each) → hsv (0-255 each). Inverse of hsvToRgb. */
export function rgbToHsv(r, g, b) {
    const rr = r / 255, gg = g / 255, bb = b / 255;
    const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
    const d = max - min;
    let hh = 0;
    if (d) {
        if (max === rr) hh = ((gg - bb) / d) % 6;
        else if (max === gg) hh = (bb - rr) / d + 2;
        else hh = (rr - gg) / d + 4;
        hh *= 60;
        if (hh < 0) hh += 360;
    }
    return [
        Math.round((hh / 360) * 255) & 0xFF,
        Math.round((max ? d / max : 0) * 255),
        Math.round(max * 255),
    ];
}

export function hsvHex(h, s, v) {
    return '#' + hsvToRgb(h, s, v).map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** '#rgb' / '#rrggbb' (# optional) → hsv, or null if it isn't a colour. */
export function hexToHsv(hex) {
    const t = String(hex || '').trim().replace(/^#/, '');
    const full = t.length === 3 ? t.split('').map((c) => c + c).join('') : t;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    const n = parseInt(full, 16);
    return rgbToHsv((n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF);
}

export function hsvCssOf(h, s, v) {
    const [r, g, b] = hsvToRgb(h, s, v);
    return `rgb(${r}, ${g}, ${b})`;
}

/** Fixed starting palette. Full-value, full-saturation where it makes sense —
 * these are LED colours, not ink, so muted presets would be a waste of a slot. */
export const COLOR_PRESETS = [
    { name: 'White', hsv: [0, 0, 255] },
    { name: 'Red', hsv: [0, 255, 255] },
    { name: 'Orange', hsv: [18, 255, 255] },
    { name: 'Yellow', hsv: [36, 255, 255] },
    { name: 'Green', hsv: [85, 255, 255] },
    { name: 'Spring', hsv: [106, 255, 255] },
    { name: 'Cyan', hsv: [128, 255, 255] },
    { name: 'Azure', hsv: [147, 255, 255] },
    { name: 'Blue', hsv: [170, 255, 255] },
    { name: 'Violet', hsv: [190, 255, 255] },
    { name: 'Magenta', hsv: [212, 255, 255] },
    { name: 'Pink', hsv: [234, 200, 255] },
];

const SWATCH_KEY = 'flask-color-swatches';
const SWATCH_MAX = 18;

/** Saved swatches are a USER palette, not a device one — the same colours are
 * wanted on any board, so they are not keyed per family. */
export function loadSwatches() {
    try {
        const raw = JSON.parse(localStorage.getItem(SWATCH_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((c) => Array.isArray(c) && c.length === 3 && c.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
            .slice(0, SWATCH_MAX);
    } catch { return []; }
}

export function saveSwatches(list) {
    try { localStorage.setItem(SWATCH_KEY, JSON.stringify(list.slice(0, SWATCH_MAX))); }
    catch { /* quota — the palette is a convenience, never break painting over it */ }
}

/** Add hsv to the saved palette, newest first, de-duped. Returns the new list. */
export function addSwatch(hsv) {
    const key = (c) => c.join(',');
    const list = [hsv.slice(), ...loadSwatches().filter((c) => key(c) !== key(hsv))].slice(0, SWATCH_MAX);
    saveSwatches(list);
    return list;
}

export function removeSwatch(hsv) {
    const key = (c) => c.join(',');
    const list = loadSwatches().filter((c) => key(c) !== key(hsv));
    saveSwatches(list);
    return list;
}

// ---- the widget ----

const elx = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
    }
    n.append(...kids.filter(Boolean));
    return n;
};

/** Inline picker: saturation/value field + hue strip + hex + eyedropper +
 * presets + saved swatches. `onChange(hsv)` fires on every change (painting is
 * live, so there is nothing to commit). Returns the element; call `.setHsv()`
 * to drive it from outside. */
export function colorPicker({ hsv = [0, 0, 255], onChange = () => {} } = {}) {
    let cur = hsv.slice();
    const fire = () => onChange(cur.slice());

    // SV field: x = saturation, y = value. Background is the classic two-
    // gradient stack over the current hue.
    const field = elx('div', {
        class: 'cp-field',
        title: 'Drag to pick saturation and brightness',
    });
    const fieldDot = elx('div', { class: 'cp-dot' });
    field.append(fieldDot);

    const hueStrip = elx('div', { class: 'cp-hue', title: 'Drag to pick hue' });
    const hueDot = elx('div', { class: 'cp-dot cp-dot-hue' });
    hueStrip.append(hueDot);

    const hexIn = elx('input', {
        type: 'text', class: 'cp-hex', spellcheck: 'false',
        'aria-label': 'Hex colour',
    });
    const preview = elx('span', { class: 'cp-preview' });

    const savedRow = elx('div', { class: 'cp-chips' });

    const paint = () => {
        const [h, s, v] = cur;
        field.style.background =
            `linear-gradient(to top, #000, rgba(0,0,0,0)), `
            + `linear-gradient(to right, #fff, ${hsvCssOf(h, 255, 255)})`;
        fieldDot.style.left = `${(s / 255) * 100}%`;
        fieldDot.style.top = `${(1 - v / 255) * 100}%`;
        fieldDot.style.background = hsvCssOf(h, s, v);
        hueDot.style.left = `${(h / 255) * 100}%`;
        preview.style.background = hsvCssOf(h, s, v);
        if (document.activeElement !== hexIn) hexIn.value = hsvHex(h, s, v);
    };

    const setHsv = (next, notify = true) => {
        cur = [
            Math.max(0, Math.min(255, Math.round(next[0]))),
            Math.max(0, Math.min(255, Math.round(next[1]))),
            Math.max(0, Math.min(255, Math.round(next[2]))),
        ];
        paint();
        if (notify) fire();
    };

    // Pointer capture so a drag that leaves the element keeps tracking — the
    // difference between "a colour picker" and "a colour button".
    const drag = (node, onPos) => {
        const go = (e) => {
            const r = node.getBoundingClientRect();
            onPos(
                Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
                Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
            );
        };
        node.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            node.setPointerCapture(e.pointerId);
            go(e);
        });
        node.addEventListener('pointermove', (e) => {
            if (node.hasPointerCapture(e.pointerId)) go(e);
        });
    };
    drag(field, (x, y) => setHsv([cur[0], x * 255, (1 - y) * 255]));
    drag(hueStrip, (x) => setHsv([x * 255, cur[1], cur[2]]));

    hexIn.addEventListener('input', () => {
        const parsed = hexToHsv(hexIn.value);
        if (parsed) setHsv(parsed);
    });
    hexIn.addEventListener('blur', paint);   // snap a partial entry back

    const chip = (c, name, onPick, onRemove) => {
        const b = elx('button', {
            class: 'cp-chip', title: name || hsvHex(...c),
            onclick: () => onPick(c),
        });
        b.style.background = hsvCssOf(...c);
        if (onRemove) {
            b.addEventListener('contextmenu', (e) => { e.preventDefault(); onRemove(c); });
            b.title += ' — right-click to remove';
        }
        return b;
    };

    const renderSaved = () => {
        const list = loadSwatches();
        // replaceChildren stringifies null into a literal "null" text node —
        // filter, don't rely on the elx() guard, which this doesn't go through.
        savedRow.replaceChildren(...[
            ...list.map((c) => chip(c, null, (x) => setHsv(x), (x) => { removeSwatch(x); renderSaved(); })),
            elx('button', {
                class: 'btn small', text: '＋ Save',
                title: 'Add the current colour to your saved palette',
                onclick: () => { addSwatch(cur); renderSaved(); },
            }),
            list.length ? null : elx('span', { class: 'note', text: 'no saved colours yet' }),
        ].filter(Boolean));
    };

    // Chromium-only and genuinely useful here: match a colour off anything on
    // screen. Feature-detected — never assume a global exists (bench-3).
    const eyedropper = (typeof window !== 'undefined' && 'EyeDropper' in window)
        ? elx('button', {
            class: 'btn small', text: '🔍', title: 'Pick a colour from anywhere on screen',
            onclick: async () => {
                try {
                    const r = await new window.EyeDropper().open();
                    const parsed = hexToHsv(r.sRGBHex);
                    if (parsed) setHsv(parsed);
                } catch { /* user cancelled */ }
            },
        })
        : null;

    const root = elx('div', { class: 'cp' },
        elx('div', { class: 'cp-top' },
            elx('div', { class: 'cp-main' }, field, hueStrip),
            elx('div', { class: 'cp-side' }, preview, hexIn, eyedropper)),
        elx('div', { class: 'cp-chips' },
            ...COLOR_PRESETS.map((p) => chip(p.hsv, p.name, (c) => setHsv(c)))),
        savedRow);

    root.setHsv = (next) => setHsv(next, false);
    paint();
    renderSaved();
    return root;
}
