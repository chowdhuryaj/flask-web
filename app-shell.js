// The native editor frame (spec §0.1, §1.2): status bar, left rail, layer
// bar + board, palette (group chips, tab strip, content, caption bar).
// main.js owns the markup (index.html) and hands the regions in here; this
// module owns the contract other packages call, plus Device › Keyboard.
//
// Contract (stable for Phase 1, unchanged from WP0):
//   shell.mount({statusBar, rail, layerBar, board, palette})
//       Elements for each region; any may be omitted. WP2 fills layerBar and
//       board (append into them), WP6 fills the status bar's save segment.
//       If `palette` holds a .caption-bar it is bound as the caption bar.
//   shell.regions            the last mounted regions
//   shell.setCaption(text|null)   → caption.js setCaption
//   shell.selectedKey()      → board.selectedKey() (for ⌘K "assign to key")
//   shell.board              the board.js singleton
//
// Also exported: KeyboardTab (Device › Keyboard, spec §1.3 "Device ›
// Keyboard"): appearance, diagnostics, device info.

import { setCaption, bindCaptionBar } from './caption.js?v=69';
import { board } from './board.js?v=69';
import { el } from './ui.js?v=69';
import { familyLabel } from './zmk.js?v=69';
import { THEMES, TEXT_SCALE, appearance, applyTheme, applyTextScale, applyBoardZoom,
         currentTheme, currentTextScale, modeOf } from './themes.js?v=69';
import { comboSlotV2IsEmpty } from './zmk-combos-codec.js?v=69';
import { MACRO_ACTION } from './zmk-macros-codec.js?v=69';

const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

export const shell = {
    regions: {},
    board,
    mount({ statusBar, rail, layerBar, board: boardEl, palette } = {}) {
        this.regions = {
            statusBar, rail, layerBar, board: boardEl, palette,
            // Look-shell regions the Keymap tab fills.
            side: $('side'), boardState: $('board-state'), editor: $('editor'),
        };
        const bar = palette?.querySelector?.('.caption-bar');
        if (bar) bindCaptionBar(bar);
        wireChrome();
    },
    setCaption,
    selectedKey: () => board.selectedKey(),
    renderTabs,
    syncDeviceChip,
};

// ---------- top bar: theme switch, "…" menu, device chip, fit ----------

// look-extras defines these globals; the menu must work before they exist.
export const MENU_ACTIONS = [
    { id: 'menu-export-keymap', fn: 'flaskExportKeymap' },
    { id: 'menu-print-layers', fn: 'flaskPrintLayers' },
];

function wireChrome() {
    const btn = $('more-btn'), menu = $('more-menu');
    if (!btn || !menu || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => {
        // Guard at open time: the globals may arrive after this module loads.
        for (const { id, fn } of MENU_ACTIONS) {
            const item = $(id);
            if (item) item.disabled = typeof window[fn] !== 'function';
            if (item?.disabled) item.title = 'Not available in this build yet';
            else item?.removeAttribute('title');
        }
        menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
        menu.querySelector('button:not(:disabled):not([hidden])')?.focus();
    };
    btn.addEventListener('click', () => (menu.hidden ? open() : close()));
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) close(); });
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.menu-wrap')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
    for (const { id, fn } of MENU_ACTIONS) {
        $(id)?.addEventListener('click', () => { if (typeof window[fn] === 'function') window[fn](); });
    }

    // Sun / moon: stays inside the Graphite pair (dark ⇄ light).
    const paintTheme = () => {
        const mode = modeOf(currentTheme());
        for (const [id, m] of [['theme-dark', 'dark'], ['theme-light', 'light']]) $(id)?.setAttribute('aria-pressed', String(mode === m));
    };
    $('theme-dark')?.addEventListener('click', () => { if (modeOf(currentTheme()) !== 'dark') applyTheme('graphite'); });
    $('theme-light')?.addEventListener('click', () => { if (modeOf(currentTheme()) !== 'light') applyTheme('graphiteLight'); });
    appearance.addEventListener('appearance', paintTheme);
    paintTheme();

    // Fit: back to "the whole board fits the pane" (zoom 100 %).
    $('fit-btn')?.addEventListener('click', () => { applyBoardZoom(100); board.fit(); });
    for (const ev of ['layer', 'change']) board.addEventListener(ev, syncDeviceChip);
    // The narrow layout puts the inspector above the dock only while a key is selected.
    const paintSel = () => { const e = $('editor'); if (e) e.dataset.sel = board.selectedKey() ? '1' : '0'; };
    board.addEventListener('select', paintSel);
    paintSel();
}

/** Keyboard chip sub-line: "38 keys · split" (mono). */
export function syncDeviceChip() {
    const sub = $('device-sub');
    if (!sub) return;
    const n = board.adapter?.profile?.keys?.length;
    sub.textContent = n ? `${n} keys · split` : '';
}

// ---------- top-level tab row ----------

/** Used-slot counts for the tab badges; null = unknown (no badge). */
export function badgeFor(screenId, tabs, app) {
    const inst = (id) => tabs.find((t) => t.id === id)?.instance;
    try {
        if (screenId === 'combos') {
            const slots = inst('zmk-combos')?.slots ?? app.offlineWs?.zmk?.combos;
            return Array.isArray(slots) ? slots.filter((c) => !comboSlotV2IsEmpty(c)).length : null;
        }
        if (screenId === 'macros') {
            const slots = app.offlineWs?.zmk?.macros;
            return Array.isArray(slots) ? slots.filter((m) => m.some((st) => st.action !== MACRO_ACTION.empty)).length : null;
        }
    } catch { /* a badge is never worth a throw */ }
    return null;
}

/**
 * The second row of the top bar. `tabs` are the registry rows (instances
 * included once built); `active` is the tab id on show; `registry` is
 * tab-registry's {screensFor, screenOf, BOARD_TABS, SIDE_TABS}. Screens with several
 * tabs get a sub-strip above their panel. Also tells the frame what to show:
 * board / rail, the side panel, which screen.
 */
export function renderTabs({ tabs, active, onSelect, app, registry }) {
    // The registry arrives as an argument: it imports this file (KeyboardTab),
    // so importing it here would be a cycle that reads KeyboardTab too early.
    const { screensFor, screenOf, BOARD_TABS, SIDE_TABS } = registry;
    const nav = $('main-tabs'), sub = $('subtabs'), editor = $('editor');
    if (!nav) return;
    const screens = screensFor(tabs);
    const cur = screenOf(active);
    nav.replaceChildren(...screens.map((s) => {
        const n = badgeFor(s.id, tabs, app);
        return el('button', {
            class: 'maintab' + (s.id === cur ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(s.id === cur),
            'data-screen': s.id, onclick: () => onSelect(s.tabs.find((t) => t.id === active)?.id ?? s.tabs[0].id),
        }, s.label, n != null ? el('span', { class: 'badge', 'data-count': n, text: String(n) }) : null);
    }));
    nav.setAttribute('role', 'tablist');
    const here = screens.find((s) => s.id === cur);
    if (sub) {
        const many = here && here.tabs.length > 1;
        sub.hidden = !many;
        sub.replaceChildren(...(many ? here.tabs.map((t) => el('button', {
            class: 'subtab' + (t.id === active ? ' on' : ''), type: 'button', 'data-tab': t.id, text: t.label, onclick: () => onSelect(t.id),
        })) : []));
    }
    syncDeviceChip();
    if (editor) {
        editor.dataset.screen = cur;
        editor.dataset.board = BOARD_TABS.has(active) ? '1' : '0';
        editor.dataset.side = SIDE_TABS.has(active) ? '1' : '0';
    }
}

// ---------- Device › Keyboard ----------

let kbTabAbort = null;      // main.js rebuilds tabs without a dtor: newest instance wins

export class KeyboardTab {
    constructor(app) {
        this.app = app;
        this.root = el('div', { class: 'kb-tab' });
        this._refresh = () => this.#syncAppearance();
        kbTabAbort?.abort();
        kbTabAbort = new AbortController();
        appearance.addEventListener('appearance', this._refresh, { signal: kbTabAbort.signal });
    }

    load() {
        const { app } = this;
        this.themes = el('div', { class: 'kb-themes', role: 'group', 'aria-label': 'Theme' },
            ...Object.entries(THEMES).map(([id, t]) => el('button', {
                class: 'kb-theme', 'data-theme-id': id, 'aria-pressed': 'false',
                'data-caption': `Switch to the ${t.label} theme.`,
                onclick: () => applyTheme(id),
            }, swatch(t), el('span', { text: t.label }))));
        this.scale = el('input', {
            type: 'range', min: TEXT_SCALE.min, max: TEXT_SCALE.max, step: TEXT_SCALE.step,
            'aria-label': 'Text size', 'data-caption': 'How large text and controls are. Native Flask uses 115%.',
            oninput: () => applyTextScale(Number(this.scale.value)),
        });
        this.scaleOut = el('span', { class: 'mono' });

        const sections = [
            el('section', {},
                el('h3', { text: 'Appearance' }),
                this.themes,
                el('div', { class: 'kb-row', style: 'margin-top: var(--sp-5)' },
                    el('label', { text: 'Text size' }), this.scale, this.scaleOut,
                    el('button', { class: 'btn small', text: 'Reset', onclick: () => applyTextScale(TEXT_SCALE.def) }))),
            el('section', {},
                el('h3', { text: 'Diagnostics' }),
                el('p', { class: 'hint', text: 'Live transport and Studio event log. Export it when the board misbehaves.' }),
                el('button', { class: 'btn', text: 'Diagnostics…', onclick: () => app.openDiagnostics?.() })),
        ];
        sections.push(this.#infoSection());
        this.root.replaceChildren(...sections);
        this.#syncAppearance();
    }

    #syncAppearance() {
        if (!this.themes) return;
        const cur = currentTheme();
        for (const b of this.themes.children) b.setAttribute('aria-pressed', String(b.dataset.themeId === cur));
        const s = currentTextScale();
        this.scale.value = s;
        this.scaleOut.textContent = `${Math.round(s * 100)}%`;
    }

    #infoSection() {
        const { app } = this;
        const rows = [['Device', app.profile?.name ?? '—'], ['Family', familyLabel(app.family)]];
        if (app.offline) rows.push(['Mode', `Offline workspace: ${app.offlineWs?.label ?? ''}`]);
        if (app.protocolVersion != null) rows.push(['Flask protocol', `v${app.protocolVersion}`]);
        if (app.layerCount) rows.push(['Layers', String(app.layerCount)]);
        return el('section', {},
            el('h3', { text: 'Device info' }),
            el('dl', { class: 'kb-info' }, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])));
    }
}

function swatch(t) {
    // Classic has no vars: it follows the OS, so show a neutral light/dark split.
    const v = t.vars ?? { bg: '#f3f4f6', surface: '#242422', accent: '#2563eb', text: '#1c1e21' };
    return el('span', { class: 'kb-swatch', 'aria-hidden': 'true' },
        ...[v.bg, v.surface, v.accent, v.text].map((c) => el('i', { style: `background:${c}` })));
}
