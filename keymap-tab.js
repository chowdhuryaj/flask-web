// Keymap editor: layer strip + SVG keyboard render + keycode picker.
// SVG rendering pattern from AlooMapper's renderDiagram; geometry from
// profiles.js (key units × UNIT px).

import { el, svgEl, toast, card } from './ui.js?v=17';
import { capLabel, hoverText } from './keycodes.js?v=17';
import { buildPicker } from './picker.js?v=17';
import { encoderCount } from './profiles.js?v=17';

const UNIT = 56;
const GAP = 3;

export class KeymapTab {
    constructor(app) {
        this.app = app;             // { vial, profile, keymap, layerCount }
        this.layer = 0;
        this.selected = null;       // {kind:'key',row,col} | {kind:'enc',index,cw}
        this.root = el('div');
    }

    async load() {
        const { app } = this;
        app.keymap = await app.vial.readKeymap(app.layerCount, app.profile.matrixRows, app.profile.matrixCols);
        this.encoders = [];
        const encs = encoderCount(app.profile);
        if (encs) {
            for (let l = 0; l < app.layerCount; l++) {
                const layer = [];
                for (let i = 0; i < encs; i++) layer.push(await app.vial.encoderGet(l, i));
                this.encoders.push(layer);
            }
        }
        this.render();
    }

    kcAt(layer, row, col) { return this.app.keymap?.[layer]?.[row]?.[col] ?? 0; }

    async assign(kc) {
        const { app } = this;
        const sel = this.selected;
        if (!sel) { toast('Click a key first'); return; }
        try {
            if (sel.kind === 'key') {
                await app.vial.setKeycode(this.layer, sel.row, sel.col, kc);
                app.keymap[this.layer][sel.row][sel.col] = kc;
                // Vial-GUI-style auto-advance: selection moves to the next
                // key so a whole layer can be filled by picking in sequence.
                const keys = app.profile.keys;
                const i = keys.findIndex((k) => k.row === sel.row && k.col === sel.col);
                const next = keys[i + 1];
                this.selected = next ? { kind: 'key', row: next.row, col: next.col } : null;
            } else {
                await app.vial.encoderSet(this.layer, sel.index, sel.cw, kc);
                this.encoders[this.layer][sel.index][sel.cw ? 'cw' : 'ccw'] = kc;
            }
            this.renderBoard();
        } catch (e) {
            toast(`Write failed: ${e.message}`, true);
        }
    }

    render() {
        const { app } = this;
        this.strip = el('div', { class: 'layer-strip' });
        this.boardWrap = el('div', { class: 'kb-wrap' });
        this.picker = buildPicker({
            layerCount: app.layerCount,
            onPick: (kc) => this.assign(kc),
        });
        this.root.replaceChildren(
            card(app.profile.name, `${app.layerCount} layers`,
                this.strip, this.boardWrap,
                el('div', { class: 'faint', style: 'margin-top:6px; font-size:12px' },
                    'Click a key, then pick a keycode. Writes are live — no save step.'),
                this.picker),
        );
        this.renderStrip();
        this.renderBoard();
    }

    renderStrip() {
        const { app } = this;
        this.strip.replaceChildren(...app.profile.layerNames.slice(0, app.layerCount).map((name, i) =>
            el('button', {
                class: i === this.layer ? 'shown' : '',
                text: name,
                onclick: () => { this.layer = i; this.selected = null; this.renderStrip(); this.renderBoard(); },
            })));
    }

    renderBoard() {
        this.boardWrap.replaceChildren(renderKeyboardSVG({
            profile: this.app.profile,
            keycodeAt: (row, col) => this.kcAt(this.layer, row, col),
            encoderAt: (index, cw) => this.encoders?.[this.layer]?.[index]?.[cw ? 'cw' : 'ccw'] ?? 0,
            selected: this.selected,
            onSelect: (sel) => { this.selected = sel; this.renderBoard(); },
        }));
    }
}

/**
 * Shared SVG keyboard renderer — used by the keymap tab, the HUD, and the
 * ZMK RGB painter.
 * opts: { profile, keycodeAt(row,col), encoderAt(index,cw)?, selected?,
 *         onSelect(sel)?, onContext(sel)?, fillFor(key)?,
 *         pressed?: Set<"row,col">, scale? }
 * fillFor(key) → CSS color painted onto the keycap rect (the RGB painter's
 * swatch fill); onContext(sel) fires on right-click (paint-clear). Both are
 * generic hooks — QMK callers pass neither and render unchanged.
 */
export function renderKeyboardSVG(opts) {
    const { profile } = opts;
    // Label functions are profile-overridable so non-QMK profiles (the ZMK
    // line renders opaque binding objects, not 16-bit ints) reuse this
    // renderer. QMK profiles define none of these — defaults preserved.
    const labelFor = profile.labelFor ?? capLabel;
    const hoverFor = profile.hoverFor ?? hoverText;
    const keyName = profile.keyName ?? ((k) => `${k.row},${k.col}`);
    const scale = opts.scale ?? 1;
    const unit = UNIT * scale;
    const all = [...profile.keys, ...profile.encoderKeys];
    if (profile.displayTile) all.push(profile.displayTile);
    // Non-key decorations (ZMK trackballs): {kind:'ball', x, y, r} circles
    // in the same key-unit space; centered coords, so extent = x+r as w.
    const decorations = profile.decorations ?? [];
    for (const d of decorations) all.push({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 });
    const maxX = Math.max(...all.map((k) => k.x + k.w), 1);
    const maxY = Math.max(...all.map((k) => k.y + k.h), 1);
    const svg = svgEl('svg', {
        class: 'kb-svg',
        width: maxX * unit + 8,
        height: maxY * unit + 8,
        viewBox: `0 0 ${maxX * unit + 8} ${maxY * unit + 8}`,
    });

    const sel = opts.selected;
    for (const key of profile.keys) {
        const x = key.x * unit + 4, y = key.y * unit + 4;
        const w = key.w * unit - GAP, h = key.h * unit - GAP;
        const kc = opts.keycodeAt(key.row, key.col);
        const isSel = sel?.kind === 'key' && sel.row === key.row && sel.col === key.col;
        const isPressed = opts.pressed?.has(`${key.row},${key.col}`);
        const fill = opts.fillFor?.(key);
        const rect = svgEl('rect', {
            class: 'keycap' + (isSel ? ' sel' : '') + (isPressed ? ' pressed' : ''),
            x, y, width: w, height: h, rx: 5 * scale,
            style: fill ? `fill:${fill}` : null,
            onclick: opts.onSelect ? () => opts.onSelect({ kind: 'key', row: key.row, col: key.col }) : null,
            oncontextmenu: opts.onContext ? (e) => {
                e.preventDefault();
                opts.onContext({ kind: 'key', row: key.row, col: key.col });
            } : null,
        });
        const title = svgEl('title', { text: `${key.label}\n${hoverFor(kc)}` });
        rect.append(title);
        svg.append(rect,
            svgEl('text', {
                x: x + w / 2, y: y + h / 2 + 4 * scale,
                'text-anchor': 'middle', text: fitCap(labelFor(kc)),
            }),
            svgEl('text', {
                class: 'keyname', x: x + w / 2, y: y + h - 5 * scale,
                'text-anchor': 'middle', text: keyName(key),
            }));
    }

    for (const enc of profile.encoderKeys) {
        const x = enc.x * unit + 4, y = enc.y * unit + 4;
        const w = enc.w * unit - GAP, h = enc.h * unit - GAP;
        const kc = opts.encoderAt ? opts.encoderAt(enc.index, enc.clockwise) : 0;
        const isSel = sel?.kind === 'enc' && sel.index === enc.index && sel.cw === enc.clockwise;
        const rect = svgEl('rect', {
            class: 'enc-cap' + (isSel ? ' sel' : ''),
            x, y, width: w, height: h, rx: h / 2,
            onclick: opts.onSelect ? () => opts.onSelect({ kind: 'enc', index: enc.index, cw: enc.clockwise }) : null,
        });
        rect.append(svgEl('title', { text: `Encoder ${enc.index} ${enc.clockwise ? 'CW ↻' : 'CCW ↺'}\n${hoverFor(kc)}` }));
        svg.append(rect,
            svgEl('text', {
                x: x + w / 2, y: y + h / 2 + 4 * scale,
                'text-anchor': 'middle', text: `${enc.clockwise ? '↻' : '↺'}${fitCap(labelFor(kc))}`,
            }));
    }

    if (profile.displayTile) {
        const t = profile.displayTile;
        svg.append(svgEl('rect', {
            class: 'oled-tile',
            x: t.x * unit + 4, y: t.y * unit + 4,
            width: t.w * unit - GAP, height: t.h * unit - GAP, rx: 4 * scale,
        }), svgEl('text', {
            class: 'keyname', x: (t.x + t.w / 2) * unit + 4, y: (t.y + t.h / 2) * unit + 8,
            'text-anchor': 'middle', text: 'OLED',
        }));
    }

    // Decorations — physical features that aren't keys (the Imprint's two
    // trackballs). Purely visual; `decorationLabel(d)` (from opts or the
    // profile) supplies the caption so tabs can show live roles.
    const decoLabel = opts.decorationLabel ?? profile.decorationLabel ?? (() => '');
    for (const d of decorations) {
        const cx = d.x * unit + 4, cy = d.y * unit + 4;
        const r = d.r * unit - GAP / 2;
        svg.append(
            svgEl('circle', {
                class: 'deco-ball', cx, cy, r,
                style: 'fill: var(--surface2, #8884); stroke: var(--border2, #8886); stroke-width: 2',
            }),
            svgEl('circle', {
                class: 'deco-ball-hl', cx: cx - r * 0.3, cy: cy - r * 0.35, r: r * 0.28,
                style: 'fill: var(--border, #fff2); opacity: 0.5',
            }),
            svgEl('text', {
                class: 'keyname', x: cx, y: cy + 4 * scale,
                'text-anchor': 'middle', text: fitCap(decoLabel(d) || ''),
            }));
    }

    return svg;
}

function fitCap(cap) {
    return cap.length > 7 ? cap.slice(0, 6) + '…' : cap;
}
