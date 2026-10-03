// HUD overlay: persisted settings + placement. Pure (fs only for load/save)
// so tests/hud-prefs-test.mjs can drive it without Electron.
//
// Placement is an anchor corner + offset from that corner's two edges of the
// display's workArea (DIP, so scale factors drop out). The same anchor puts
// the HUD at the same spot on whichever display the cursor is on; a drag
// re-derives it from where the HUD was dropped (anchorOf).

const fs = require('fs');

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const SIZES = { Small: 300, Medium: 380, Large: 480 };          // menu presets, window width px
const OPACITIES = [1, 0.85, 0.7, 0.55];                         // menu presets
const WIDTH = { min: 240, max: 900 };
const OPACITY = { min: 0.3, max: 1 };
const MARGIN = 12;
const DEFAULTS = Object.freeze({
    shown: false, corner: 'bottom-right', offsetX: MARGIN, offsetY: MARGIN, width: SIZES.Medium, opacity: 0.85,
});

const num = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const clampWidth = (w) => Math.round(num(w, WIDTH.min, WIDTH.max, DEFAULTS.width));
const clampOpacity = (o) => Math.round(num(o, OPACITY.min, OPACITY.max, DEFAULTS.opacity) * 100) / 100;

/** Any stored object → a valid settings object (unknown values fall back). */
function sanitize(s) {
    const o = s && typeof s === 'object' ? s : {};
    return {
        shown: typeof o.shown === 'boolean' ? o.shown : DEFAULTS.shown,
        corner: CORNERS.includes(o.corner) ? o.corner : DEFAULTS.corner,
        offsetX: Math.round(num(o.offsetX, 0, 10000, DEFAULTS.offsetX)),
        offsetY: Math.round(num(o.offsetY, 0, 10000, DEFAULTS.offsetY)),
        width: clampWidth(o.width),
        opacity: clampOpacity(o.opacity),
    };
}

function load(file) {
    try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return sanitize(null); }
}

function save(file, s) {
    try { fs.writeFileSync(file, JSON.stringify(sanitize(s))); } catch { /* best effort */ }
}

/** Bounds for a {width,height} HUD anchored at `corner` of a workArea,
 * `offset` px in from that corner's edges (default MARGIN). Size and spot are
 * clamped so the HUD is always fully on that display. */
function cornerBounds(workArea, size, corner, offset = { x: MARGIN, y: MARGIN }) {
    const wa = workArea;
    const width = Math.max(1, Math.min(Math.round(size.width), wa.width - 2 * MARGIN));
    const height = Math.max(1, Math.min(Math.round(size.height), wa.height - 2 * MARGIN));
    const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
    const ox = Math.min(Math.max(0, offset.x), wa.width - width);
    const oy = Math.min(Math.max(0, offset.y), wa.height - height);
    return {
        x: right ? wa.x + wa.width - width - ox : wa.x + ox,
        y: bottom ? wa.y + wa.height - height - oy : wa.y + oy,
        width,
        height,
    };
}

/** Where a HUD at `bounds` sits on `workArea`: the corner nearest its centre
 * plus its distance from that corner's edges (0 if it hangs over one). */
function anchorOf(workArea, bounds) {
    const wa = workArea;
    const right = bounds.x + bounds.width / 2 > wa.x + wa.width / 2;
    const bottom = bounds.y + bounds.height / 2 > wa.y + wa.height / 2;
    return {
        corner: `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`,
        offsetX: Math.max(0, Math.round(right ? wa.x + wa.width - bounds.x - bounds.width : bounds.x - wa.x)),
        offsetY: Math.max(0, Math.round(bottom ? wa.y + wa.height - bounds.y - bounds.height : bounds.y - wa.y)),
    };
}

module.exports = {
    CORNERS, SIZES, OPACITIES, WIDTH, OPACITY, MARGIN, DEFAULTS,
    sanitize, load, save, cornerBounds, anchorOf, clampWidth, clampOpacity,
};
