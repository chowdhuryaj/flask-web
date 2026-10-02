// Appearance: themes, text size, board zoom. Moved out of main.js (WP1).
// Palettes are identical to AdeptCompanion's Pipette.Theme (spec §2.1);
// "classic" has no vars and falls back to the stylesheet's auto light/dark.
//
//   THEMES, THEME_VARS, DEFAULT_THEME
//   applyTheme(id) / currentTheme()        persisted as flask-theme
//   applyTextScale(v) / currentTextScale() --text-scale on <html>, flask-text-scale, 0.90-1.60
//   applyBoardZoom(pct) / currentBoardZoom() --board-zoom (a ratio) on <html>,
//                                          flask-board-zoom, 60-150 %; WP2's board reads the var
//   Each setter dispatches 'appearance' on `appearance` so open UI can refresh.

// ---------- themes (AlooMapper pattern; classic = stylesheet auto light/dark) ----------

export const THEME_VARS = ['bg', 'surface', 'surface2', 'text', 'muted', 'faint', 'border', 'border2',
    'accent', 'accent-bg', 'accent-text', 'ok', 'ok-bg', 'warn', 'warn-bg', 'danger', 'danger-bg',
    'keycap', 'keycap-border'];
export const THEMES = {
    classic: { label: 'Classic (auto light/dark)' },
    // keybr.com's own inks, sampled from the running site (2026-08-18) rather
    // than eyeballed: --primary/--secondary/--accent and their ramps. Mirrors
    // AdeptCompanion's Pipette.Theme, which is the default there.
    //
    // ok/danger in the dark entry are keybr's #448154/#9b4545 LIGHTENED. keybr
    // shows those on its page background; here they carry badge text on a
    // tinted chip, where the originals land near 2.6:1.
    keybrDark: {
        label: 'keybr Dark',
        vars: { bg: '#2b2b2b', surface: '#333333', surface2: '#404040', text: '#b8b3b3', muted: '#9f9999', faint: '#747070', border: '#404040', border2: '#4d4d4d', accent: '#867f7f', 'accent-bg': '#4d4d4d', 'accent-text': '#e4e0e0', ok: '#6dbe83', 'ok-bg': '#24402c', warn: '#e0a94f', 'warn-bg': '#3a2d14', danger: '#d77b7b', 'danger-bg': '#3e2222', keycap: '#404040', 'keycap-border': '#4d4d4d' },
    },
    keybrLight: {
        label: 'keybr Light',
        vars: { bg: '#f4f0f0', surface: '#ffffff', surface2: '#faf9f9', text: '#282640', muted: '#514e63', faint: '#7a7786', border: '#e9e1e1', border2: '#ded3d3', accent: '#3d475c', 'accent-bg': '#e3e6ed', 'accent-text': '#292f3d', ok: '#2a7e21', 'ok-bg': '#e6f1e4', warn: '#8a5a12', 'warn-bg': '#fef3e2', danger: '#a1464e', 'danger-bg': '#f7e8e9', keycap: '#ffffff', 'keycap-border': '#e9e1e1' },
    },
    light: {
        label: 'Light',
        vars: { bg: '#f5f5f4', surface: '#ffffff', surface2: '#fafaf9', text: '#1c1c1a', muted: '#6b6b66', faint: '#9a9a93', border: '#e2e2dd', border2: '#cfcfc8', accent: '#2563eb', 'accent-bg': '#e8f0fe', 'accent-text': '#14458a', ok: '#15803d', 'ok-bg': '#e7f6ec', warn: '#8a5a12', 'warn-bg': '#fef3e2', danger: '#b42318', 'danger-bg': '#fdeceb', keycap: '#ffffff', 'keycap-border': '#cfcfc8' },
    },
    dark: {
        label: 'Dark',
        vars: { bg: '#1a1a18', surface: '#242422', surface2: '#2c2c29', text: '#ececea', muted: '#a3a39d', faint: '#76766f', border: '#36352f', border2: '#45443d', accent: '#5b9aff', 'accent-bg': '#1c2a44', 'accent-text': '#bcd4ff', ok: '#69d28c', 'ok-bg': '#15301f', warn: '#e0a94f', 'warn-bg': '#3a2d14', danger: '#f1857c', 'danger-bg': '#3a1714', keycap: '#2c2c29', 'keycap-border': '#45443d' },
    },
    nord: {
        label: 'Nord',
        vars: { bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', text: '#eceff4', muted: '#aeb8cc', faint: '#7b869c', border: '#4c566a', border2: '#596580', accent: '#88c0d0', 'accent-bg': '#274552', 'accent-text': '#c8e4ec', ok: '#a3be8c', 'ok-bg': '#33402c', warn: '#ebcb8b', 'warn-bg': '#3f3826', danger: '#bf616a', 'danger-bg': '#40272b', keycap: '#434c5e', 'keycap-border': '#596580' },
    },
    dracula: {
        label: 'Dracula',
        vars: { bg: '#282a36', surface: '#313342', surface2: '#3a3d4f', text: '#f8f8f2', muted: '#b6b8c8', faint: '#7e8195', border: '#44475a', border2: '#565a72', accent: '#bd93f9', 'accent-bg': '#3b3354', 'accent-text': '#e3d3ff', ok: '#50fa7b', 'ok-bg': '#1f4030', warn: '#ffb86c', 'warn-bg': '#43331f', danger: '#ff5555', 'danger-bg': '#4a2020', keycap: '#3a3d4f', 'keycap-border': '#565a72' },
    },
    solarized: {
        label: 'Solarized Light',
        // muted/ok use Solarized base01 + a darkened green: the canonical
        // base00 #657b83 (4.30:1) and green #859900 (2.76:1 on ok-bg — the
        // "template" badge text) both sit under the 4.5:1 floor on this
        // theme's near-white surface.
        vars: { bg: '#fdf6e3', surface: '#fefbf0', surface2: '#f5efdc', text: '#073642', muted: '#586e75', faint: '#93a1a1', border: '#e6dfc8', border2: '#d3cbb0', accent: '#268bd2', 'accent-bg': '#e0eef8', 'accent-text': '#0d5a8f', ok: '#5b6800', 'ok-bg': '#eef0d8', warn: '#7d5c00', 'warn-bg': '#f6eed3', danger: '#dc322f', 'danger-bg': '#fbe3e2', keycap: '#fefbf0', 'keycap-border': '#d3cbb0' },
    },
};

// AJ Q5 (2026-10-01): keybr Dark is the default everywhere, as in native.
export const DEFAULT_THEME = 'keybrDark';
export const TEXT_SCALE = { min: 0.9, max: 1.6, step: 0.05, def: 1.15 };
export const BOARD_ZOOM = { min: 60, max: 150, step: 10, def: 100 };

export const appearance = new EventTarget();
const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const clamp = (v, { min, max, step }) => Math.min(max, Math.max(min, Math.round(v / step) * step));
const notify = () => appearance.dispatchEvent(new Event('appearance'));

export function currentTheme() {
    const t = store.get('flask-theme');
    return t in THEMES ? t : DEFAULT_THEME;
}

export function applyTheme(name) {
    const id = name in THEMES ? name : DEFAULT_THEME;
    const theme = THEMES[id];
    const root = document.documentElement;
    for (const v of THEME_VARS) root.style.removeProperty('--' + v);
    if (theme.vars) for (const [k, val] of Object.entries(theme.vars)) root.style.setProperty('--' + k, val);
    store.set('flask-theme', id);
    notify();
}

export function currentTextScale() {
    const n = parseFloat(store.get('flask-text-scale'));
    return Number.isFinite(n) ? Math.round(clamp(n, TEXT_SCALE) * 100) / 100 : TEXT_SCALE.def;
}
export function applyTextScale(v) {
    const s = Math.round(clamp(v, TEXT_SCALE) * 100) / 100;
    document.documentElement.style.setProperty('--text-scale', String(s));
    store.set('flask-text-scale', String(s));
    notify();
    return s;
}

export function currentBoardZoom() {
    const n = parseInt(store.get('flask-board-zoom'), 10);
    return Number.isFinite(n) ? clamp(n, BOARD_ZOOM) : BOARD_ZOOM.def;
}
export function applyBoardZoom(pct) {
    const p = clamp(pct, BOARD_ZOOM);
    document.documentElement.style.setProperty('--board-zoom', String(p / 100));
    store.set('flask-board-zoom', String(p));
    notify();
    return p;
}

/** Apply all three from storage; call once at boot. */
export function initAppearance() {
    applyTheme(currentTheme());
    applyTextScale(currentTextScale());
    applyBoardZoom(currentBoardZoom());
}
