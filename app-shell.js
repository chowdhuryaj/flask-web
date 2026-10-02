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

import { setCaption, bindCaptionBar } from './caption.js?v=61';
import { board } from './board.js?v=61';
import { el } from './ui.js?v=61';
import { familyLabel } from './zmk.js?v=61';
import { THEMES, TEXT_SCALE, appearance, applyTheme, applyTextScale,
         currentTheme, currentTextScale } from './themes.js?v=61';

export const shell = {
    regions: {},
    board,
    mount({ statusBar, rail, layerBar, board: boardEl, palette } = {}) {
        this.regions = { statusBar, rail, layerBar, board: boardEl, palette };
        const bar = palette?.querySelector?.('.caption-bar');
        if (bar) bindCaptionBar(bar);
    },
    setCaption,
    selectedKey: () => board.selectedKey(),
};

// ---------- Device › Keyboard ----------

export class KeyboardTab {
    constructor(app) {
        this.app = app;
        this.root = el('div', { class: 'kb-tab' });
        this._refresh = () => this.#syncAppearance();
        appearance.addEventListener('appearance', this._refresh);
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
