// HUD overlay: persisted settings + corner placement. Pure (fs only for
// load/save) so tests/hud-prefs-test.mjs can drive it without Electron.

const fs = require('fs');

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const SIZES = { Small: 300, Medium: 380, Large: 480 };          // window width, px
const OPACITIES = [1, 0.85, 0.7, 0.55];
const MARGIN = 12;
const DEFAULTS = Object.freeze({ shown: false, corner: 'bottom-right', width: SIZES.Medium, opacity: 0.85 });

/** Any stored object → a valid settings object (unknown values fall back). */
function sanitize(s) {
    const o = s && typeof s === 'object' ? s : {};
    return {
        shown: typeof o.shown === 'boolean' ? o.shown : DEFAULTS.shown,
        corner: CORNERS.includes(o.corner) ? o.corner : DEFAULTS.corner,
        width: Object.values(SIZES).includes(o.width) ? o.width : DEFAULTS.width,
        opacity: OPACITIES.includes(o.opacity) ? o.opacity : DEFAULTS.opacity,
    };
}

function load(file) {
    try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return sanitize(null); }
}

function save(file, s) {
    try { fs.writeFileSync(file, JSON.stringify(sanitize(s))); } catch { /* best effort */ }
}

/** Bounds for a {width,height} HUD in `corner` of a display's workArea,
 * MARGIN px in. Size is clamped so the HUD never hangs off a small display. */
function cornerBounds(workArea, size, corner) {
    const wa = workArea;
    const width = Math.max(1, Math.min(Math.round(size.width), wa.width - 2 * MARGIN));
    const height = Math.max(1, Math.min(Math.round(size.height), wa.height - 2 * MARGIN));
    const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
    return {
        x: right ? wa.x + wa.width - width - MARGIN : wa.x + MARGIN,
        y: bottom ? wa.y + wa.height - height - MARGIN : wa.y + MARGIN,
        width,
        height,
    };
}

module.exports = { CORNERS, SIZES, OPACITIES, MARGIN, DEFAULTS, sanitize, load, save, cornerBounds };
