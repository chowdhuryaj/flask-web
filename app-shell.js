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
// Keyboard"): appearance, diagnostics, lock, bootloader, device info.

import { setCaption, bindCaptionBar } from './caption.js?v=1';
import { board } from './board.js?v=1';
import { el, toast } from './ui.js?v=49';
import { familyLabel } from './profiles.js?v=49';
import { THEMES, TEXT_SCALE, appearance, applyTheme, applyTextScale,
         currentTheme, currentTextScale } from './themes.js?v=1';

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

    async load() {
        const { app } = this;
        const qmk = !!app.caps?.vial && !app.offline && !!app.hid?.connected;

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
        if (qmk) sections.push(this.#lockSection());
        sections.push(await this.#infoSection());
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

    #lockSection() {
        const { app } = this;
        const state = el('span', { text: app.unlocked ? 'Unlocked' : 'Locked' });
        const lockBtn = el('button', {
            class: 'btn', text: app.unlocked ? 'Lock' : 'Unlock…', onclick: () => app.onHudLockClick?.(),
        });
        const boot = el('button', {
            class: 'btn danger', text: 'Jump to bootloader', disabled: !app.unlocked,
            title: app.unlocked ? '' : 'Unlock the keyboard first',
            'data-caption': 'Reboots the keyboard into its bootloader for flashing. Needs unlock.',
            onclick: async () => {
                if (!confirm('Reboot into the bootloader? The keyboard disconnects until you flash or replug it.')) return;
                try { await app.vial.bootloaderJump(); } catch (e) { toast(`Bootloader jump failed: ${e.message}`, true); }
            },
        });
        return el('section', {},
            el('h3', { text: 'Unlock' }),
            el('p', { class: 'hint', text: 'Macros, matrix reads and the bootloader jump are locked until you unlock.' }),
            el('div', { class: 'kb-row' }, state, lockBtn, boot));
    }

    async #infoSection() {
        const { app } = this;
        const rows = [['Device', app.profile?.name ?? '—'], ['Family', familyLabel(app.family)]];
        if (app.offline) rows.push(['Mode', `Offline workspace: ${app.offlineWs?.label ?? ''}`]);
        if (app.protocolVersion != null) rows.push(['Flask protocol', `v${app.protocolVersion}`]);
        else if (!app.offline && app.caps?.vial) rows.push(['Flask protocol', 'none (plain Vial)']);
        if (app.viaVersion != null) rows.push(['VIA protocol', String(app.viaVersion)]);
        if (app.vialVersion != null) rows.push(['Vial protocol', String(app.vialVersion)]);
        if (app.layerCount) rows.push(['Layers', String(app.layerCount)]);
        if (app.vial && app.caps?.vial) {
            try {
                const c = await app.vial.dynamicEntryCounts();
                rows.push(['Tap dance slots', String(c.tapDance)], ['Combo slots', String(c.combo)],
                    ['Key override slots', String(c.keyOverride)]);
                rows.push(['Macro slots', String(await app.vial.macroCount())]);
            } catch { /* older firmware: no dynamic entries */ }
        }
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
