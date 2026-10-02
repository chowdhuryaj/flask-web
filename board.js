// The one board in the frame (spec §2.4, §3.1, §3.3, §3.4): key drawing,
// layer bar, selection, assign + auto-advance, click-again popover,
// undo/redo, position-pick mode, chord boxes.
//
// Contract other packages call (stable since WP0, all kept):
//   board.selectedKey() → {layer, pos} | null   (QMK: pos = {row, col} or
//                         {encoder, dir:'cw'|'ccw'}; ZMK/Nape: pos = index)
//   board.assign(binding, {advance = true}) → Promise<boolean>
//   board.pickPositions({initial = [], max, label, onChange}) → stop()
//   board.addEventListener('select', …)   detail = selectedKey()
// Added by WP2:
//   board.layer / board.setLayer(i)       current layer (events: 'layer')
//   board.undo() / board.redo()           events: 'history' (canUndo/canRedo)
//   board.setChordBoxes(boxes|null, onClick)   boxes: [{id, positions:[pos…],
//                         label, inherited?}]; onClick(box, evt). Read-only
//                         render between the member keys (Svalboard chords).
//   board.setLayerBarNote(node|null)      chord hint/warning, right of the chips
//   board.place(inlineHost, shell.regions)  put layerBarEl + boardEl into the
//                         frame regions when WP1 mounted them, else inline
//   board.bind(adapter) → unbind()        a keymap tab hands over its device;
//                         see the Adapter typedef
//   board.refresh() / board.resetHistory() / board.showEmptyLayers()
//   board.setZoom(f)                      writes --board-zoom (1 = 100 %);
//                         the rail may also just set the CSS var
//   events: 'select' 'layer' 'change' 'history'
// Also exports renderKeyboardSVG (moved here; keymap-tab.js re-exports it),
// baseUnit, layoutOf, splitCap for the HUD, trainer, RGB and tests.
//
// Import this file ONLY as './board.js?v=1': x.js and x.js?v=1 are two
// module instances and the singleton would split.

import { el, svgEl, toast as uiToast } from './ui.js?v=49';
import { capLabel, hoverText } from './keycodes.js?v=49';
import { capParts as catalogCapParts, holdTapParts } from './behavior-catalog.js?v=1';

export const BOARD_ZOOM_VAR = '--board-zoom';
export const GAP = 5;
const PAD = 4;
const hasDom = () => typeof document !== 'undefined';
const toast = (...a) => { if (hasDom()) uiToast(...a); };   // node tests have no DOM

// ---------------------------------------------------------------- geometry

/** Native unit formula (§2.4): wide boards shrink to fit 1000 px, narrow
 * ones (Adept) get 84 px per key unit. */
export function baseUnit(widthUnits) {
    return widthUnits > 8 ? Math.max(48, 1000 / widthUnits) : 84;
}

/** The four corners of a key in key units, rotated by r degrees about
 * (rx, ry) like a ZMK physical layout (default origin: the key centre). */
export function keyCorners(k) {
    const { x, y, w, h } = k;
    const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const r = k.r || 0;
    if (!r) return pts;
    const cx = k.rx ?? x + w / 2, cy = k.ry ?? y + h / 2;
    const a = (r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return pts.map(([px, py]) => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c]);
}

/** Pixel layout for a set of items ({x,y,w,h,r?,rx?,ry?} in key units).
 * Rotated corners count toward the frame, so rotated thumbs stay inside. */
export function layoutOf(items, scale = 1) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
        for (const [px, py] of keyCorners(it)) {
            minX = Math.min(minX, px); minY = Math.min(minY, py);
            maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
    }
    if (!items.length) { minX = minY = 0; maxX = maxY = 1; }
    const unit = baseUnit(maxX - minX) * scale;
    const frame = (k) => {
        const w = k.w * unit - GAP, h = k.h * unit - GAP;
        const x = (k.x - minX) * unit + PAD + GAP / 2, y = (k.y - minY) * unit + PAD + GAP / 2;
        const r = k.r || 0;
        const cx = r ? ((k.rx ?? k.x + k.w / 2) - minX) * unit + PAD : x + w / 2;
        const cy = r ? ((k.ry ?? k.y + k.h / 2) - minY) * unit + PAD : y + h / 2;
        return { x, y, w, h, r, cx, cy };
    };
    return { unit, frame, width: (maxX - minX) * unit + PAD * 2, height: (maxY - minY) * unit + PAD * 2 };
}

/** A key's centre x in key units, rotation included. */
function frameCentreUnits(k) {
    const c = keyCorners(k);
    return c.reduce((s, p) => s + p[0], 0) / c.length;
}

/** Where the centre of a frame ends up after its rotation. */
export function frameCentre(f) {
    const mx = f.x + f.w / 2, my = f.y + f.h / 2;
    if (!f.r) return [mx, my];
    const a = (f.r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [f.cx + (mx - f.cx) * c - (my - f.cy) * s, f.cy + (mx - f.cx) * s + (my - f.cy) * c];
}

// -------------------------------------------------------------------- caps

/** Split a one-string cap label ("MT·⌘·A", "LT2·A") into the stacked pair:
 * `top` the hold part, `main` the tap part (§2.4). Labels without a '·'
 * have no top. */
export function splitCap(label) {
    const s = String(label ?? '');
    const i = s.lastIndexOf('·');
    if (i > 0 && i < s.length - 1) return { top: s.slice(0, i).replaceAll('·', ' '), main: s.slice(i + 1) };
    return { top: '', main: s };
}

// Parentheses in a top label are a device display name chopped by an
// abbreviation ("Hold-Tap L (live)" → "HL("). Drop them; the top line is a
// hint, the full binding is in the caption.
// "Mod-tap R⇧ · live" does not fit a 1u cap at a readable size, so the board
// (only) writes it "MT R⇧ · live"; pickers and captions keep the full words.
const cleanTop = (p) => ({ ...p, top: p.top.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^Mod-tap\b/, 'MT') });

/** The stacked pair for one binding value: catalog split when WP3 provides
 * one, else the label split at its last '·'. */
export function capPartsOf(value, profile, opts = {}) {
    if (opts.partsFor) return cleanTop(opts.partsFor(value));
    const adapter = profile.capAdapter ?? (profile.labelFor ? null : 'qmk');
    let label;
    if (adapter) {
        const p = catalogCapParts(value, adapter);
        if (p) return cleanTop(p);            // WP3's capParts is authoritative; never re-split on '·'
        label = '';
    } else {
        label = profile.labelFor(value);
    }
    return cleanTop(splitCap(label));
}
const partsOf = capPartsOf;

/** Fit `text` into maxW at font size fs: one line, else two lines split at a
 * space, else shrink to minScale × fs, else ellipsise. Glyph width is
 * estimated (0.58 em); good enough for caps. */
export function fitText(text, maxW, fs, { minScale = 0.45, maxLines = 2 } = {}) {
    const s = String(text);
    const wide = (t, f) => t.length * 0.58 * f;
    if (wide(s, fs) <= maxW) return { lines: [s], fs };
    if (maxLines > 1) {
        const at = [...s].map((c, i) => (c === ' ' ? i : -1)).filter((i) => i > 0)
            .sort((a, b) => Math.abs(a - s.length / 2) - Math.abs(b - s.length / 2))[0];
        if (at != null) {
            const lines = [s.slice(0, at), s.slice(at + 1)];
            const longest = Math.max(...lines.map((l) => l.length));
            const f = Math.max(fs * minScale, Math.min(fs, maxW / (0.58 * longest)));
            return { lines, fs: f };
        }
    }
    const f = Math.max(fs * minScale, maxW / (0.58 * s.length));
    if (wide(s, f) <= maxW) return { lines: [s], fs: f };
    const keep = Math.max(1, Math.floor(maxW / (0.58 * f)) - 1);
    return { lines: [s.slice(0, keep) + '…'], fs: f };
}

/** Hold/tap split for a dual-role key cap (mod-tap, layer-tap), or null. */
export function htPartsOf(value, profile, opts = {}) {
    if (opts.partsFor) return null;
    const adapter = profile.capAdapter ?? (profile.labelFor ? null : 'qmk');
    return adapter ? holdTapParts(value, adapter) : null;
}

// Dual-role cap: a tinted HOLD band on top ("hold ⇧ · live"), the TAP key
// below ("tap F"). The tiny words are the markers; the band is the cue that
// survives a glance and the rotated Totem thumbs (the group rotates as one).
function drawHoldTap(g, f, ht, { mid, innerW, mainFs, topFs, radius }) {
    const bandH = f.h * 0.42, r = Math.min(radius, bandH / 2);
    g.append(svgEl('path', {
        class: 'cap-holdband',
        d: `M${f.x},${f.y + bandH} V${f.y + r} Q${f.x},${f.y} ${f.x + r},${f.y} H${f.x + f.w - r} Q${f.x + f.w},${f.y} ${f.x + f.w},${f.y + r} V${f.y + bandH} Z`,
    }));
    const markFs = Math.max(6, topFs * 0.78);
    const holdText = ht.tag ? `${ht.hold} · ${ht.tag}` : ht.hold;
    const holdFit = fitText(holdText, innerW - markFs * 0.58 * 5, topFs * 1.1, { minScale: 0.55, maxLines: 1 });
    const t = svgEl('text', { class: 'cap-hold', x: mid, y: f.y + bandH * 0.68, 'text-anchor': 'middle', 'data-hold': ht.hold });
    t.append(svgEl('tspan', { class: 'cap-mark', style: `font-size:${markFs}px`, text: 'hold ' }),
        svgEl('tspan', { style: `font-size:${holdFit.fs}px`, text: holdFit.lines[0] }));
    const tapFit = fitText(ht.tap, innerW - markFs * 0.58 * 4, mainFs, { minScale: 0.5, maxLines: 1 });
    const m = svgEl('text', { class: 'cap-main cap-tap', x: mid, y: f.y + bandH + (f.h - bandH) * 0.62, 'text-anchor': 'middle', 'data-tap': ht.tap });
    m.append(svgEl('tspan', { class: 'cap-mark', style: `font-size:${markFs}px`, text: 'tap ' }),
        svgEl('tspan', { style: `font-size:${tapFit.fs}px`, text: tapFit.lines[0] }));
    g.classList.add('ht');
    g.append(t, m);
}

const textScale = () => {
    if (!hasDom()) return 1;
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return px > 0 ? px / 16 : 1;
};

// --------------------------------------------------------------- rendering

/**
 * Shared SVG keyboard renderer: the frame's board, the HUD, the trainer and
 * the RGB painter.
 * opts: { profile, keycodeAt(row,col), encoderAt(index,cw)?, selected?,
 *         onSelect(sel, evt)?, onContext(sel)?, fillFor(key)?,
 *         pressed?: Set<"row,col">, marked?: Set<"row,col">, scale?,
 *         names?: 'sel'|'all', tooltips?: bool, zoomable?: bool,
 *         chords?: [{id, keys:[{row,col}], label, inherited?}],
 *         onChord?(chord, evt), partsFor?(value) → {top, main} }
 * Keys may carry r/rx/ry (degrees, key units); they draw and hit-test
 * rotated. fillFor / onContext are the RGB painter's generic hooks.
 */
export function renderKeyboardSVG(opts) {
    const { profile } = opts;
    const hoverFor = profile.hoverFor ?? hoverText;
    const keyName = profile.keyName ?? ((k) => `${k.row},${k.col}`);
    const scale = opts.scale ?? 1;
    const decorations = profile.decorations ?? [];
    const items = [...profile.keys, ...profile.encoderKeys];
    if (profile.displayTile) items.push(profile.displayTile);
    for (const d of decorations) items.push({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 });
    const L = layoutOf(items, scale);
    const { unit } = L;
    const ts = textScale() * Math.min(1, Math.max(scale, 0.7));
    const mainFs = 12 * ts, topFs = 9 * ts;
    const radius = (profile.family && /^(totem|imprint)/.test(profile.family) ? 5 : 6) * Math.min(1, scale + 0.2);
    const svg = svgEl('svg', {
        class: 'kb-svg', width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`,
        // zoom is relative to "fits the pane": 1 never overflows, 1.5 may be 50 % wider.
        style: opts.zoomable ? `width:calc(${L.width}px * var(${BOARD_ZOOM_VAR}, 1)); max-width:calc(100% * var(${BOARD_ZOOM_VAR}, 1)); height:auto` : null,
    });
    const sel = opts.selected;
    const names = opts.names ?? 'sel';
    const lit = (set, k) => set?.has(`${k.row},${k.col}`);
    const centres = new Map();

    for (const key of profile.keys) {
        const f = L.frame(key);
        centres.set(`${key.row},${key.col}`, frameCentre(f));
        const value = opts.keycodeAt(key.row, key.col);
        const isSel = sel?.kind === 'key' && sel.row === key.row && sel.col === key.col;
        const isPressed = lit(opts.pressed, key);
        const isMarked = lit(opts.marked, key);
        const fill = opts.fillFor?.(key);
        const hover = hoverFor(value).split('\n')[0];
        const caption = `Key ${keyName(key)} · ${hover}`;
        const parts = partsOf(value, profile, opts);
        const g = svgEl('g', {
            class: 'key' + (isSel ? ' sel' : '') + (isPressed ? ' pressed' : '') + (isMarked ? ' picked' : ''),
            transform: f.r ? `rotate(${f.r} ${f.cx} ${f.cy})` : null,
            'data-caption': caption,
            role: opts.onSelect ? 'button' : null,
            tabindex: opts.onSelect ? 0 : null,
            'aria-label': caption,
            onclick: opts.onSelect ? (e) => opts.onSelect({ kind: 'key', row: key.row, col: key.col }, e) : null,
            onkeydown: opts.onSelect ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    opts.onSelect({ kind: 'key', row: key.row, col: key.col }, e);
                }
            } : null,
            oncontextmenu: opts.onContext ? (e) => {
                e.preventDefault();
                opts.onContext({ kind: 'key', row: key.row, col: key.col });
            } : null,
        });
        const rect = svgEl('rect', {
            class: 'keycap' + (isSel ? ' sel' : '') + (isPressed ? ' pressed' : '') + (isMarked ? ' picked' : ''),
            x: f.x, y: f.y, width: f.w, height: f.h, rx: radius,
            style: fill ? `fill:${fill}` : null,
        });
        if (opts.tooltips !== false) rect.append(svgEl('title', { text: `${key.label ?? ''}\n${hoverFor(value)}` }));
        g.append(rect);
        const mid = f.x + f.w / 2;
        const innerW = f.w - 6;
        const ht = htPartsOf(value, profile, opts);
        if (ht) {
            drawHoldTap(g, f, ht, { mid, innerW, mainFs, topFs, radius });
            if (names === 'all' || (names === 'sel' && isSel)) {
                g.append(svgEl('text', { class: 'keyname', x: f.x + f.w - 4, y: f.y + f.h - 4, 'text-anchor': 'end', text: keyName(key) }));
            }
            svg.append(g);
            continue;
        }
        const main = fitText(parts.main, innerW, mainFs, { minScale: 0.45, maxLines: 2 });
        const top = parts.top ? fitText(parts.top, innerW, topFs, { minScale: 0.6, maxLines: 1 }) : null;
        // Stacked pair: hold part above, tap part below; a lone main centres.
        const mainBase = top ? f.y + f.h * 0.66 : f.y + f.h / 2 + main.fs * 0.34 - (main.lines.length - 1) * main.fs * 0.55;
        if (top) {
            g.append(svgEl('text', {
                class: 'cap-top', x: mid, y: f.y + f.h * 0.3, 'text-anchor': 'middle',
                style: `font-size:${top.fs}px`, text: top.lines[0],
            }));
        }
        main.lines.forEach((line, i) => g.append(svgEl('text', {
            class: 'cap-main', x: mid, y: mainBase + i * main.fs * 1.1, 'text-anchor': 'middle',
            style: `font-size:${main.fs}px`, text: line,
        })));
        if (names === 'all' || (names === 'sel' && isSel)) {
            g.append(svgEl('text', {
                class: 'keyname', x: mid, y: f.y + f.h - 4, 'text-anchor': 'middle', text: keyName(key),
            }));
        }
        svg.append(g);
    }

    for (const enc of profile.encoderKeys) {
        const f = L.frame(enc);
        const value = opts.encoderAt ? opts.encoderAt(enc.index, enc.clockwise) : 0;
        const isSel = sel?.kind === 'enc' && sel.index === enc.index && sel.cw === enc.clockwise;
        const caption = `Encoder ${enc.index} ${enc.clockwise ? 'CW ↻' : 'CCW ↺'} · ${hoverFor(value).split('\n')[0]}`;
        const parts = partsOf(value, profile, opts);
        const pick = { kind: 'enc', index: enc.index, cw: enc.clockwise };
        const g = svgEl('g', {
            class: 'enc' + (isSel ? ' sel' : ''), 'data-caption': caption, 'aria-label': caption,
            role: opts.onSelect ? 'button' : null, tabindex: opts.onSelect ? 0 : null,
            onclick: opts.onSelect ? (e) => opts.onSelect(pick, e) : null,
            onkeydown: opts.onSelect ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onSelect(pick, e); }
            } : null,
        });
        const rect = svgEl('rect', {
            class: 'enc-cap' + (isSel ? ' sel' : ''), x: f.x, y: f.y, width: f.w, height: f.h, rx: f.h / 2,
        });
        if (opts.tooltips !== false) rect.append(svgEl('title', { text: `Encoder ${enc.index} ${enc.clockwise ? 'CW ↻' : 'CCW ↺'}\n${hoverFor(value)}` }));
        const fit = fitText(`${enc.clockwise ? '↻' : '↺'}${parts.top ? parts.top + ' ' : ''}${parts.main}`, f.w - 6, mainFs, { minScale: 0.5, maxLines: 1 });
        g.append(rect, svgEl('text', {
            class: 'cap-main', x: f.x + f.w / 2, y: f.y + f.h / 2 + fit.fs * 0.34, 'text-anchor': 'middle',
            style: `font-size:${fit.fs}px`, text: fit.lines[0],
        }));
        svg.append(g);
    }

    if (profile.displayTile) {
        const f = L.frame(profile.displayTile);
        svg.append(svgEl('rect', { class: 'oled-tile', x: f.x, y: f.y, width: f.w, height: f.h, rx: 4 * scale }),
            svgEl('text', { class: 'keyname', x: f.x + f.w / 2, y: f.y + f.h / 2 + 3, 'text-anchor': 'middle', text: 'OLED' }));
    }

    // Decorations: physical features that are not keys (the Imprint's two
    // trackballs). `decorationLabel(d)` supplies a live caption.
    const decoLabel = opts.decorationLabel ?? profile.decorationLabel ?? (() => '');
    for (const d of decorations) {
        const f = L.frame({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 });
        const cx = f.x + f.w / 2, cy = f.y + f.h / 2, r = f.w / 2;
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
                class: 'keyname', x: cx, y: cy + 4 * scale, 'text-anchor': 'middle',
                text: fitText(decoLabel(d) || '', r * 1.6, 10, { maxLines: 1 }).lines[0],
            }));
    }

    // Chord boxes (Svalboard corner chords): a small rounded box centred
    // between its member keys. Solid = owned on this layer, dashed =
    // inherited from a lower layer.
    for (const chord of opts.chords ?? []) {
        const pts = chord.keys.map((k) => centres.get(`${k.row},${k.col}`)).filter(Boolean);
        if (!pts.length) continue;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const bw = Math.max(28, unit * 0.46), bh = Math.max(18, unit * 0.3);
        const fit = fitText(chord.label ?? '', bw - 4, 10 * ts, { minScale: 0.6, maxLines: 1 });
        const g = svgEl('g', {
            class: 'chord-box' + (chord.inherited ? ' inherited' : ''),
            'data-caption': chord.caption ?? `Chord · ${chord.label ?? ''}`,
            role: opts.onChord ? 'button' : null, tabindex: opts.onChord ? 0 : null,
            onclick: opts.onChord ? (e) => { e.stopPropagation(); opts.onChord(chord, e); } : null,
            onkeydown: opts.onChord ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onChord(chord, e); }
            } : null,
        });
        g.append(svgEl('rect', { x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh, rx: bh / 2 }),
            svgEl('text', { x: cx, y: cy + fit.fs * 0.34, 'text-anchor': 'middle', style: `font-size:${fit.fs}px`, text: fit.lines[0] }));
        svg.append(g);
    }
    return svg;
}

// ------------------------------------------------------------------- board

/**
 * What a keymap tab hands to board.bind(). The board owns selection, layer,
 * history and drawing; the adapter owns the device.
 * @typedef {object} Adapter
 * @property {string} surface        binding-picker SURFACES key for a key
 * @property {string} [encoderSurface]
 * @property {object} app
 * @property {object} profile        keys/encoderKeys (+ r/rx/ry), labelFor, hoverFor, capAdapter
 * @property {() => {index:number,name:string,empty:boolean,live?:boolean}[]} layers
 * @property {(layer:number, sel:object) => *} bindingAt
 * @property {(layer:number, sel:object, value:*) => Promise<boolean|void>} write
 *           throws on failure; returns false when it refused after toasting
 * @property {(sel:object) => *} posOf       internal sel → public pos
 * @property {(pos:*) => object|null} selOf  public pos → internal sel
 * @property {boolean} [readOnly]
 * @property {(layer:number, name:string) => Promise<void>} [renameLayer]
 * @property {() => {canMove:(d:number)=>boolean, canRemove:boolean, addReason:string|null,
 *            restoreLabel:string|null, move:(d:number)=>*, remove:()=>*, add:()=>*, restore:()=>*}} [layerOps]
 * @property {(layer:number, sel:object, value:*) => void} [onWrite]  HUD repaint
 */

const sameSel = (a, b) => !!a && !!b && a.kind === b.kind
    && (a.kind === 'key' ? a.row === b.row && a.col === b.col : a.index === b.index && a.cw === b.cw);

class Board extends EventTarget {
    #a = null;
    #layer = 0;
    #sel = null;
    #undo = [];
    #redo = [];
    #pick = null;
    #chords = null;
    #note = null;
    #popover = null;
    #showEmpty = false;
    #renaming = null;
    #barEl = null;
    #boardEl = null;
    #bannerEl = null;
    #busy = false;

    // ---- public: contract ----

    selectedKey() {
        if (!this.#a || !this.#sel) return null;
        return { layer: this.#layer, pos: this.#a.posOf(this.#sel) };
    }

    async assign(binding, { advance = true } = {}) {
        const a = this.#a;
        if (!a || a.readOnly || this.#pick) return false;
        const sel = this.#sel;
        if (!sel) { toast('Click a key first'); return false; }
        const layer = this.#layer;
        const before = a.bindingAt(layer, sel);
        if (!(await this.#write(layer, sel, binding))) return false;
        this.#undo.push({ layer, sel, before, after: binding });
        this.#redo = [];
        if (advance && sel.kind === 'key') this.#sel = this.#nextKey(sel);
        this.#afterEdit();
        this.dispatchEvent(new Event('history'));
        if (advance && sel.kind === 'key') this.#emitSelect();
        return true;
    }

    /** Position-pick mode for combos and leader sequences (§3.4). Click order
     * is kept; `initial` comes first. One mode at a time. */
    pickPositions({ initial = [], max, label, onChange } = {}) {
        this.#pick?.stop(true);
        const key = (p) => JSON.stringify(p);
        const state = { positions: [...initial], max, label, onChange, savedSel: this.#sel };
        this.#closePopover();
        this.#sel = null;
        const stop = (silent) => {
            if (this.#pick !== state) return;
            this.#pick = null;
            this.#sel = state.savedSel;
            if (!silent) this.refresh();
        };
        state.stop = stop;
        state.toggle = (pos) => {
            const i = state.positions.findIndex((p) => key(p) === key(pos));
            if (i >= 0) state.positions.splice(i, 1);
            else if (max != null && state.positions.length >= max) { toast(`At most ${max} positions`); return; }
            else state.positions.push(pos);
            this.refresh();
            onChange?.([...state.positions]);
        };
        this.#pick = state;
        this.refresh();
        return () => stop(false);
    }

    // ---- public: WP3b additions (tap-hold composer, home-row preset) ----

    /** Current binding at a public pos on the shown layer (default: the selection). */
    bindingOf(pos = this.selectedKey()?.pos) {
        const a = this.#a;
        const sel = a && pos != null ? a.selOf(pos) : null;
        return sel ? a.bindingAt(this.#layer, sel) : null;
    }

    /** 'left' | 'right' by the key's centre against the board's middle; null
     * when unknown (encoders, no layout). */
    handOf(pos) {
        const a = this.#a;
        const sel = a && pos != null ? a.selOf(pos) : null;
        if (!sel || sel.kind !== 'key') return null;
        const keys = a.profile.keys;
        const cx = (k) => frameCentreUnits(k);
        const k = keys.find((x) => x.row === sel.row && x.col === sel.col);
        if (!k) return null;
        const xs = keys.map(cx);
        return cx(k) < (Math.min(...xs) + Math.max(...xs)) / 2 ? 'left' : 'right';
    }

    /** Every key on the shown layer: [{pos, x, binding}] (x in key units). */
    positions() {
        const a = this.#a;
        if (!a) return [];
        return a.profile.keys.map((k) => {
            const sel = { kind: 'key', row: k.row, col: k.col };
            return { pos: a.posOf(sel), x: frameCentreUnits(k), binding: a.bindingAt(this.#layer, sel) };
        });
    }

    /** Write several keys as ONE undo step: [{pos, value}]. Stops at the
     * first refused write (already-written keys stay in the step). */
    async assignMany(list) {
        const a = this.#a;
        if (!a || a.readOnly || this.#pick || !list.length) return false;
        const layer = this.#layer;
        const batch = [];
        for (const { pos, value } of list) {
            const sel = a.selOf(pos);
            if (!sel) continue;
            const before = a.bindingAt(layer, sel);
            if (!(await this.#write(layer, sel, value))) break;
            batch.push({ layer, sel, before, after: value });
        }
        if (!batch.length) return false;
        this.#undo.push({ layer, sel: batch[0].sel, batch });
        this.#redo = [];
        this.#afterEdit();
        this.dispatchEvent(new Event('history'));
        return batch.length === list.length;
    }

    // ---- public: WP2 additions ----

    get layer() { return this.#layer; }
    get adapter() { return this.#a; }
    get canUndo() { return this.#undo.length > 0; }
    get canRedo() { return this.#redo.length > 0; }

    setLayer(i, { keepSelection = false } = {}) {
        if (i === this.#layer) return;
        this.#layer = i;
        if (!keepSelection) this.#sel = null;
        this.#closePopover();
        this.refresh();
        this.dispatchEvent(new Event('layer'));
        this.#emitSelect();
    }

    showEmptyLayers() { this.#showEmpty = true; this.refresh(); }

    resetHistory() {
        this.#undo = []; this.#redo = [];
        this.dispatchEvent(new Event('history'));
    }

    async undo() { return this.#step(this.#undo, this.#redo, 'before'); }
    async redo() { return this.#step(this.#redo, this.#undo, 'after'); }

    setChordBoxes(boxes, onClick) {
        this.#chords = boxes ? { boxes, onClick } : null;
        this.#renderBoard();
    }

    setLayerBarNote(node) {
        this.#note = node ?? null;
        this.#renderBar();
    }

    setZoom(f) {
        if (hasDom()) document.documentElement.style.setProperty(BOARD_ZOOM_VAR, String(f));
    }

    get layerBarEl() { this.#ensureDom(); return this.#barEl; }
    get boardEl() { this.#ensureDom(); return this.#boardEl; }

    place(inline, regions = {}) {
        if (!hasDom()) return;
        this.#ensureDom();
        if (regions.layerBar && regions.board) {
            regions.layerBar.replaceChildren(this.#barEl);
            regions.board.replaceChildren(this.#boardEl);
        } else if (inline) {
            inline.replaceChildren(this.#barEl, this.#boardEl);
        }
        this.refresh();
    }

    /** Hand over a device. Returns unbind(); rebinding the same adapter keeps
     * the selection and history. */
    bind(adapter) {
        if (this.#a !== adapter) {
            this.#pick?.stop(true);
            this.#a = adapter;
            this.#sel = null;
            this.#undo = []; this.#redo = [];
            this.#chords = null;
            this.#renaming = null;
            const n = adapter.layers().length;
            if (this.#layer >= n) this.#layer = 0;
            this.dispatchEvent(new Event('history'));
        }
        this.refresh();
        return () => this.unbind(adapter);
    }

    unbind(adapter) {
        if (adapter && this.#a !== adapter) return;
        this.#pick?.stop(true);
        this.#closePopover();
        this.#a = null; this.#sel = null;
        this.#undo = []; this.#redo = [];
        this.#chords = null;
        if (this.#barEl) { this.#barEl.replaceChildren(); this.#boardEl.replaceChildren(); }
    }

    refresh() {
        if (!hasDom()) return;
        this.#ensureDom();
        this.#renderBar();
        this.#renderBoard();
    }

    // ---- selection and clicks ----

    select(sel) {
        if (this.#a?.readOnly) return;
        this.#sel = sel;
        this.#renderBoard();
        this.#emitSelect();
    }

    #click(sel, evt) {
        const a = this.#a;
        if (!a) return;
        if (this.#pick) { this.#pick.toggle(a.posOf(sel)); return; }
        if (a.readOnly) return;
        if (sameSel(sel, this.#sel)) { this.#openPopover(sel, evt?.currentTarget); return; }
        this.#closePopover();
        this.select(sel);
    }

    #openPopover(sel, anchor) {
        const a = this.#a;
        this.#closePopover();
        const surface = sel.kind === 'enc' ? (a.encoderSurface ?? a.surface) : a.surface;
        const value = a.bindingAt(this.#layer, sel);
        // Loaded on demand: binding-picker pulls in the legacy ZMK picker,
        // which imports keymap-tab, which imports this file.
        let closed = false, close = null;
        this.#popover = () => { closed = true; close?.(); };
        import('./binding-picker.js?v=1').then(({ openPicker }) => {
            if (closed) return;
            close = openPicker({
                surface, host: 'popover', anchor, app: a.app, value,
                onPick: (v) => { this.#popover = null; this.assign(v, { advance: false }); },
            });
        });
    }

    #closePopover() { this.#popover?.(); this.#popover = null; }

    #nextKey(sel) {
        const keys = this.#a.profile.keys;
        const i = keys.findIndex((k) => k.row === sel.row && k.col === sel.col);
        if (i < 0 || keys.length < 2) return sel;
        const n = keys[(i + 1) % keys.length];       // profile order, wrapping
        return { kind: 'key', row: n.row, col: n.col };
    }

    #emitSelect() {
        this.dispatchEvent(new CustomEvent('select', { detail: this.selectedKey() }));
    }

    async #write(layer, sel, value) {
        if (this.#busy) return false;
        this.#busy = true;
        try {
            const r = await this.#a.write(layer, sel, value);
            return r !== false;
        } catch (e) {
            toast(`Write failed: ${e.message}`, true);
            return false;
        } finally {
            this.#busy = false;
        }
    }

    async #step(from, to, field) {
        const a = this.#a;
        const e = from[from.length - 1];
        if (!a || a.readOnly || !e) return false;
        const steps = e.batch ? (field === 'before' ? [...e.batch].reverse() : e.batch) : [e];
        for (const s of steps) if (!(await this.#write(s.layer, s.sel, s[field]))) return false;
        from.pop();
        to.push(e);
        // Show what changed.
        this.#layer = e.layer;
        this.#sel = e.sel;
        this.#afterEdit();
        this.dispatchEvent(new Event('history'));
        this.#emitSelect();
        return true;
    }

    #afterEdit() {
        this.#renderBoard();
        this.#renderBar();
        this.dispatchEvent(new Event('change'));
    }

    // ---- rendering ----

    #ensureDom() {
        if (this.#barEl || !hasDom()) return;
        this.#barEl = el('div', { class: 'bd-layerbar' });
        this.#boardEl = el('div', { class: 'bd-board kb-wrap' });
        document.addEventListener('flask-hud-change', () => this.#renderBar());
        window.addEventListener('focus', () => this.#renderBar());
    }

    #chip(l, a) {
        const on = l.index === this.#layer;
        if (this.#renaming === l.index && a.renameLayer) {
            const input = el('input', { class: 'bd-rename', type: 'text', value: l.name, maxlength: 20, size: 10 });
            let done = false;
            const finish = async (commit) => {
                if (done) return;
                done = true;
                this.#renaming = null;
                const name = input.value.trim();
                if (commit && name && name !== l.name) {
                    try { await a.renameLayer(l.index, name); } catch (e) { toast(`Rename failed: ${e.message}`, true); }
                }
                this.refresh();
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') finish(true);
                if (e.key === 'Escape') finish(false);
            });
            input.addEventListener('blur', () => finish(true));
            queueMicrotask(() => { input.focus(); input.select(); });
            return input;
        }
        return el('button', {
            class: 'bd-chip' + (on ? ' on' : '') + (l.live ? ' live' : ''),
            type: 'button', 'aria-pressed': on ? 'true' : 'false',
            'data-caption': `Layer ${l.index} · ${l.name}` + (a.renameLayer ? ' — double-click to rename' : ''),
            onclick: () => this.setLayer(l.index),
            ondblclick: a.renameLayer && !a.readOnly ? () => { this.#renaming = l.index; this.#renderBar(); } : null,
        }, el('span', { class: 'bd-chip-i', text: String(l.index) }), el('span', { text: l.name }));
    }

    #renderBar() {
        const a = this.#a;
        if (!this.#barEl) return;
        if (!a) { this.#barEl.replaceChildren(); return; }
        const all = a.layers();
        const shown = this.#showEmpty ? all : all.filter((l) => !l.empty || l.index === 0 || l.index === this.#layer);
        const hidden = all.length - shown.length;
        const kids = shown.map((l) => this.#chip(l, a));
        if (hidden > 0) {
            kids.push(el('button', {
                class: 'bd-chip bd-more', type: 'button', text: `+${hidden} empty`,
                'data-caption': 'Layers with nothing assigned yet. Show them to start building one.',
                onclick: () => this.showEmptyLayers(),
            }));
        }
        const ops = a.layerOps?.();
        if (ops && !a.readOnly) {
            const btn = (text, caption, fn, off) => el('button', {
                class: 'bd-op', type: 'button', text, 'data-caption': caption, 'aria-label': caption,
                disabled: off, onclick: fn,
            });
            kids.push(
                btn('◀', 'Move this layer left (lower priority)', () => ops.move(-1), !ops.canMove(-1)),
                btn('▶', 'Move this layer right (higher priority)', () => ops.move(1), !ops.canMove(1)),
                btn('−', 'Remove this layer (frees a slot; undo with the restore button)', () => ops.remove(), !ops.canRemove),
                ops.restoreLabel ? el('button', {
                    class: 'bd-op wide', type: 'button', text: `↩ Restore "${ops.restoreLabel}"`,
                    'data-caption': `Bring back removed layer "${ops.restoreLabel}"`, onclick: () => ops.restore(),
                }) : null,
                btn('＋', ops.addReason ?? 'Add a layer', () => ops.add(), !!ops.addReason));
        }
        kids.push(el('span', { class: 'bd-spacer' }));
        if (this.#note) kids.push(this.#note);
        const hud = a.app?.hud;
        if (hud && !a.app.offline) {
            kids.push(el('button', {
                class: 'bd-popout' + (hud.open ? ' on' : ''), type: 'button',
                text: hud.open ? 'Floating' : 'Pop out',
                'data-caption': hud.open ? 'The live board is floating — click to bring it back' : 'Float the live board over other apps',
                onclick: async () => { await hud.toggle(); this.#renderBar(); },
            }));
        }
        this.#barEl.replaceChildren(...kids.filter(Boolean));
    }

    #renderBoard() {
        const a = this.#a;
        if (!this.#boardEl) return;
        if (!a) { this.#boardEl.replaceChildren(); return; }
        const layer = this.#layer;
        const pick = this.#pick;
        const marked = pick ? new Set(pick.positions.map((p) => {
            const s = a.selOf(p);
            return s && `${s.row},${s.col}`;
        }).filter(Boolean)) : null;
        const chords = this.#chords && this.#chords.boxes.map((b) => ({
            ...b, keys: b.positions.map((p) => a.selOf(p)).filter(Boolean),
        }));
        const svg = renderKeyboardSVG({
            profile: a.profile, zoomable: true, tooltips: false,
            names: pick || this.#chords ? 'all' : 'sel',
            keycodeAt: (row, col) => a.bindingAt(layer, { kind: 'key', row, col }),
            encoderAt: (index, cw) => a.bindingAt(layer, { kind: 'enc', index, cw }),
            selected: pick || a.readOnly ? null : this.#sel,
            marked,
            chords,
            onChord: this.#chords ? (c, e) => this.#chords.onClick?.(this.#chords.boxes.find((b) => b.id === c.id), e) : null,
            onSelect: (sel, evt) => this.#click(sel, evt),
        });
        const kids = [];
        if (pick) {
            kids.push(el('div', { class: 'bd-banner', role: 'status' },
                pick.label ?? 'Pick positions',
                el('span', { class: 'bd-banner-n', text: pick.max != null ? `${pick.positions.length} of ${pick.max}` : `${pick.positions.length} picked` }),
                el('button', { class: 'bd-op wide', type: 'button', text: 'Done', onclick: () => pick.stop(false) })));
        }
        kids.push(svg);
        this.#boardEl.replaceChildren(...kids);
    }
}

export const board = new Board();
export { Board };   // tests make their own instance
