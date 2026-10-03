// The one board in the frame (spec §2.4, §3.1, §3.3, §3.4): key drawing,
// layer rail, selection, assign + auto-advance, drag-drop from the palette,
// undo/redo, position-pick mode.
//
// Contract other packages call (stable since WP0, all kept):
//   board.selectedKey() → {layer, pos} | null   (pos = key index)
//   board.assign(binding, {advance = true}) → Promise<boolean>
//   board.pickPositions({initial = [], max, label, onChange, allowRepeat}) → stop()
//                         allowRepeat (leader): a click always appends, so a
//                         sequence may hit the same key twice; the caller removes
//   board.addEventListener('select', …)   detail = selectedKey()
// Added by WP2:
//   board.layer / board.setLayer(i)       current layer (events: 'layer')
//   board.undo() / board.redo()           events: 'history' (canUndo/canRedo)
//   board.setZoom(f)                      writes --board-zoom (1 = 100 %);
//                         the rail may also just set the CSS var
//   events: 'select' 'layer' 'change' 'history'
// Also exports renderKeyboardSVG, baseUnit, layoutOf, splitCap for the HUD,
// trainer, RGB and tests.
//
// Import this file ONLY as './board.js?v=69': x.js and x.js?v=69 are two
// module instances and the singleton would split.

import { el, svgEl, toast as uiToast } from './ui.js?v=69';
import { capParts as catalogCapParts, holdTapParts } from './behavior-catalog.js?v=69';
import { legendOf } from './legend.js?v=69';

export const BOARD_ZOOM_VAR = '--board-zoom';
/** dataTransfer type a palette tile drags: JSON of an adapter binding. */
export const DRAG_TYPE = 'application/x-flask-binding';
export const GAP = 5;
const PAD = 4;
const hasDom = () => typeof document !== 'undefined';
const toast = (...a) => { if (hasDom()) uiToast(...a); };   // node tests have no DOM

// ---------------------------------------------------------------- geometry

/** Native unit formula (§2.4): wide boards shrink to fit 1000 px, narrow
 * ones get 84 px per key unit. */
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

/** A key's centre y in key units, rotation included. */
function frameCentreYUnits(k) {
    const c = keyCorners(k);
    return c.reduce((s, p) => s + p[1], 0) / c.length;
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
    const adapter = profile.capAdapter ?? null;
    let label;
    if (adapter) {
        const p = catalogCapParts(value, adapter);
        if (p) return cleanTop(p);            // WP3's capParts is authoritative; never re-split on '·'
        label = '';
    } else {
        label = profile.labelFor?.(value) ?? '';
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
    const adapter = profile.capAdapter ?? null;
    return adapter ? holdTapParts(value, adapter) : null;
}

// Look-shell legend: tap label large and centred, hold / mode as a small mono
// sub-label under it, colour by kind (legend.js). Sizes follow the key, not a
// fixed px, so a rotated thumb key reads like its neighbours; the SVG is then
// scaled to the pane (--board-fit) so sub-labels are 0.27 of a key.
const SUB_MIN_PX = 10;
function drawLegend(g, f, lg, { mid, innerW, k }) {
    const u = Math.min(f.w, f.h);
    const mainFs = u * 0.38 * k, subFs = u * 0.27 * k;
    const main = fitText(lg.main, innerW, mainFs, { minScale: 0.5, maxLines: lg.sub ? 1 : 2 });
    const sub = lg.sub ? fitText(lg.sub, innerW, subFs, { minScale: 0.6, maxLines: 1 }) : null;
    g.classList.add('k-' + lg.kind);
    const mainY = lg.sub ? f.y + f.h * 0.46 : f.y + f.h / 2 + main.fs * 0.34 - (main.lines.length - 1) * main.fs * 0.55;
    main.lines.forEach((line, i) => g.append(svgEl('text', {
        class: 'cap-main', x: mid, y: mainY + i * main.fs * 1.1, 'text-anchor': 'middle',
        style: `font-size:${main.fs}px`, text: line,
    })));
    if (sub) {
        g.append(svgEl('text', {
            class: 'cap-sub s-' + (lg.subKind || 'dim'), x: mid, y: f.y + f.h * 0.82, 'text-anchor': 'middle',
            // never under SUB_MIN_PX on screen: the SVG is scaled by fit × zoom (CSS vars)
            style: `font-size:max(${sub.fs}px, calc(${SUB_MIN_PX}px / (var(--board-fit, 1) * var(${BOARD_ZOOM_VAR}, 1))))`,
            text: sub.lines[0], 'data-hold': lg.sub,
        }));
    }
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
 * opts: { profile, keycodeAt(row,col), selected?,
 *         onSelect(sel, evt)?, onContext(sel)?, fillFor(key)?,
 *         pressed?: Set<"row,col">, marked?: Set<"row,col">, scale?,
 *         names?: 'sel'|'all', tooltips?: bool, zoomable?: bool,
 *         partsFor?(value) → {top, main} }
 * Keys may carry r/rx/ry (degrees, key units); they draw and hit-test
 * rotated. fillFor / onContext are the RGB painter's generic hooks.
 */
export function renderKeyboardSVG(opts) {
    const { profile } = opts;
    const hoverFor = profile.hoverFor ?? (() => '');
    const keyName = profile.keyName ?? ((k) => `${k.row},${k.col}`);
    const scale = opts.scale ?? 1;
    const decorations = profile.decorations ?? [];
    const items = [...profile.keys];
    for (const d of decorations) items.push({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 });
    const L = layoutOf(items, scale);
    const ts = textScale() * Math.min(1, Math.max(scale, 0.7));
    const mainFs = 12 * ts, topFs = 9 * ts;
    const legendK = Math.min(1.3, Math.max(0.8, textScale() / 1.15));
    const radius = (profile.family && /^(totem|imprint)/.test(profile.family) ? 5 : 6) * Math.min(1, scale + 0.2);
    const svg = svgEl('svg', {
        class: 'kb-svg', width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`,
        // zoom is relative to "fits the pane": 1 never overflows, 1.5 may be 50 % wider.
        // --board-fit: board.js scales the board to its pane (width AND height);
        // zoom multiplies that. Without a measured fit it falls back to 100 % wide.
        style: opts.zoomable ? `width:calc(${L.width}px * var(--board-fit, 1) * var(${BOARD_ZOOM_VAR}, 1)); max-width:none; height:auto` : null,
    });
    const sel = opts.selected;
    const names = opts.names ?? 'sel';
    const lit = (set, k) => set?.has(`${k.row},${k.col}`);
    for (const key of profile.keys) {
        const f = L.frame(key);
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
            ondragover: opts.onDrop ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; g.classList.add('drop'); } : null,
            ondragleave: opts.onDrop ? () => g.classList.remove('drop') : null,
            ondrop: opts.onDrop ? (e) => {
                e.preventDefault(); g.classList.remove('drop');
                opts.onDrop({ kind: 'key', row: key.row, col: key.col }, e.dataTransfer.getData(DRAG_TYPE));
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
        if (profile.capAdapter && !opts.partsFor && value != null) {
            drawLegend(g, f, legendOf(value, profile.capAdapter), { mid, innerW, k: legendK });
            if (names === 'all' || (names === 'sel' && isSel)) {
                g.append(svgEl('text', { class: 'keyname', x: f.x + f.w - 4, y: f.y + f.h - 3, 'text-anchor': 'end', text: keyName(key) }));
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

    return svg;
}

// ------------------------------------------------------------------- board

/**
 * What a keymap tab hands to board.bind(). The board owns selection, layer,
 * history and drawing; the adapter owns the device.
 * @typedef {object} Adapter
 * @property {string} surface        binding-picker SURFACES key for a key
 * @property {object} app
 * @property {object} profile        keys (+ r/rx/ry), labelFor, hoverFor, capAdapter
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

const sameSel = (a, b) => !!a && !!b && a.kind === b.kind && a.row === b.row && a.col === b.col;

class Board extends EventTarget {
    #a = null;
    #layer = 0;
    #sel = null;
    #undo = [];
    #redo = [];
    #pick = null;
    #showEmpty = false;
    #renaming = null;
    #barEl = null;
    #boardEl = null;
    #bannerEl = null;
    // Edits run one at a time, in call order. Fast type-to-assign used to be
    // refused ("Still writing the last key") and lose keystrokes (WC-20).
    #queue = Promise.resolve();
    #serial(fn) {
        const run = this.#queue.then(fn);
        this.#queue = run.then(() => {}, () => {});
        return run;
    }

    // ---- public: contract ----

    selectedKey() {
        if (!this.#a || !this.#sel) return null;
        return { layer: this.#layer, pos: this.#a.posOf(this.#sel) };
    }

    assign(binding, opts) { return this.#serial(() => this.#assign(binding, opts)); }

    async #assign(binding, { advance = true } = {}) {
        const a = this.#a;
        if (!a || a.readOnly || this.#pick) return false;
        const sel = this.#sel;
        if (!sel) { toast('Click a key first'); return false; }
        const layer = this.#layer;
        const before = a.bindingAt(layer, sel);
        if (!(await this.#write(layer, sel, binding))) return false;
        this.#undo.push({ layer, sel, before, after: binding });
        this.#redo = [];
        if (advance) this.#sel = this.#nextKey(sel);
        this.#afterEdit();
        this.dispatchEvent(new Event('history'));
        if (advance) this.#emitSelect();
        return true;
    }

    /** Position-pick mode for combos and leader sequences (§3.4). Click order
     * is kept; `initial` comes first. One mode at a time. A click on a picked
     * key removes it, unless `allowRepeat` (leader sequences: "a, a"), where
     * every click appends and the caller owns removal. */
    pickPositions({ initial = [], max, label, onChange, allowRepeat = false } = {}) {
        this.#pick?.stop(true);
        const key = (p) => JSON.stringify(p);
        const state = { positions: [...initial], max, label, onChange, savedSel: this.#sel };
        this.#sel = null;
        const stop = (silent) => {
            if (this.#pick !== state) return;
            this.#pick = null;
            this.#sel = state.savedSel;
            if (!silent) this.refresh();
        };
        state.stop = stop;
        state.toggle = (pos) => {
            const i = allowRepeat ? -1 : state.positions.findIndex((p) => key(p) === key(pos));
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
     * when unknown (no layout). */
    handOf(pos) {
        const a = this.#a;
        const sel = a && pos != null ? a.selOf(pos) : null;
        if (!sel) return null;
        const keys = a.profile.keys;
        const cx = (k) => frameCentreUnits(k);
        const k = keys.find((x) => x.row === sel.row && x.col === sel.col);
        if (!k) return null;
        const xs = keys.map(cx);
        return cx(k) < (Math.min(...xs) + Math.max(...xs)) / 2 ? 'left' : 'right';
    }

    /** Every key on the shown layer: [{pos, x, y, binding}] (centre in key units). */
    positions() {
        const a = this.#a;
        if (!a) return [];
        return a.profile.keys.map((k) => {
            const sel = { kind: 'key', row: k.row, col: k.col };
            return { pos: a.posOf(sel), x: frameCentreUnits(k), y: frameCentreYUnits(k), binding: a.bindingAt(this.#layer, sel) };
        });
    }

    /** Write several keys as ONE undo step: [{pos, value}]. Stops at the
     * first refused write (already-written keys stay in the step). */
    assignMany(list) { return this.#serial(() => this.#assignMany(list)); }

    async #assignMany(list) {
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
        this.refresh();
        this.dispatchEvent(new Event('layer'));
        this.#emitSelect();
    }

    showEmptyLayers() { this.#showEmpty = true; this.refresh(); }

    resetHistory() {
        this.#undo = []; this.#redo = [];
        this.dispatchEvent(new Event('history'));
    }

    /** Show `layer` and select the key at public `pos` (Layers index jump). */
    jumpTo(layer, pos) {
        const a = this.#a;
        const sel = a ? a.selOf(pos) : null;
        if (!sel || a.readOnly || !a.profile.keys.some((k) => k.row === sel.row && k.col === sel.col)) return false;
        this.#layer = layer;
        this.#sel = sel;
        this.refresh();
        this.dispatchEvent(new Event('layer'));
        this.#emitSelect();
        return true;
    }

    /** A palette tile dropped on a key: select it and assign, no advance. */
    async dropOn(sel, text) {
        let binding;
        try { binding = JSON.parse(text); } catch { return false; }
        if (!binding || typeof binding !== 'object' || this.#a?.readOnly || this.#pick) return false;
        if (this.#a?.validBinding && !this.#a.validBinding(binding)) return false;   // foreign drag: ignore
        this.#sel = sel;
        this.#renderBoard();
        this.#emitSelect();
        return this.assign(binding, { advance: false });
    }

    /** Re-measure the pane and rescale the board to it (the Fit button). */
    fit() { this.#measure(); }

    undo() { return this.#serial(() => this.#step(this.#undo, this.#redo, 'before')); }
    redo() { return this.#serial(() => this.#step(this.#redo, this.#undo, 'after')); }

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
            this.#observe(regions.board);
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
        this.#a = null; this.#sel = null;
        this.#undo = []; this.#redo = [];
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

    // Clicking the selected key again does nothing (it used to open a second
    // picker; the inspector beside the board replaces it).
    #click(sel) {
        const a = this.#a;
        if (!a) return;
        if (this.#pick) { this.#pick.toggle(a.posOf(sel)); return; }
        if (a.readOnly || sameSel(sel, this.#sel)) return;
        this.select(sel);
    }

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
        try {
            const r = await this.#a.write(layer, sel, value);
            return r !== false;
        } catch (e) {
            toast(`Write failed: ${e.message}`, true);
            return false;
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

    #slot = null;
    #fit = 1;
    #ro = null;
    #observe(slot) {
        if (this.#slot === slot) return;
        this.#ro?.disconnect();
        this.#slot = slot;
        if (typeof ResizeObserver === 'function') {
            this.#ro = new ResizeObserver(() => this.#measure());
            this.#ro.observe(slot);
        }
    }

    /** Fit = the largest scale (<= 1.3) at which the whole board shows in its
     * pane, width and height. Zoom (--board-zoom) multiplies it. */
    #measure() {
        const slot = this.#slot, svg = this.#boardEl?.querySelector('.kb-svg');
        if (!slot || !svg) return;
        const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
        const cw = slot.clientWidth - 12, ch = slot.clientHeight - 12;
        if (!(w > 0 && h > 0 && cw > 0 && ch > 0)) return;
        const fit = Math.max(0.3, Math.min(1.3, cw / w, ch / h));
        if (Math.abs(fit - this.#fit) < 0.005) return;
        this.#fit = fit;
        this.#boardEl.style.setProperty('--board-fit', String(fit));
    }

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
                class: 'bd-op', type: 'button', text, 'data-caption': caption, 'aria-label': caption, title: caption,
                disabled: off, onclick: fn,
            });
            kids.push(
                el('button', {
                    class: 'bd-chip bd-add', type: 'button', 'aria-label': ops.addReason ?? 'Add a layer',
                    'data-caption': ops.addReason ?? 'Add a layer', title: ops.addReason ?? 'Add a layer',
                    disabled: !!ops.addReason, onclick: () => ops.add(),
                }, el('span', { class: 'bd-chip-i', text: '+' }), el('span', { text: 'Add layer' })),
                el('div', { class: 'bd-ops' },
                    btn('↑', 'Move this layer up (lower priority)', () => ops.move(-1), !ops.canMove(-1)),
                    btn('↓', 'Move this layer down (higher priority)', () => ops.move(1), !ops.canMove(1)),
                    btn('−', 'Remove this layer (frees a slot; undo with the restore button)', () => ops.remove(), !ops.canRemove)),
                ops.restoreLabel ? el('button', {
                    class: 'bd-op wide', type: 'button', text: `↩ Restore "${ops.restoreLabel}"`,
                    'data-caption': `Bring back removed layer "${ops.restoreLabel}"`, onclick: () => ops.restore(),
                }) : null);
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
        const svg = renderKeyboardSVG({
            profile: a.profile, zoomable: true, tooltips: false,
            names: pick ? 'all' : 'sel',
            keycodeAt: (row, col) => a.bindingAt(layer, { kind: 'key', row, col }),
            selected: pick || a.readOnly ? null : this.#sel,
            marked,
            onSelect: (sel) => this.#click(sel),
            onDrop: a.readOnly ? null : (sel, text) => this.dropOn(sel, text),
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
        this.#boardEl.style.setProperty('--board-fit', String(this.#fit));
        this.#measure();
    }
}

export const board = new Board();
export { Board };   // tests make their own instance
