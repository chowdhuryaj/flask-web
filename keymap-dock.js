// The palette dock of the Keymap screen (look-shell): a collapsible strip under
// the board with a category list, search, "Add modifiers" chips and a grid of
// tiles. Click a tile with a key selected to assign it (and the selection
// advances); drag a tile onto any key to assign that key.
//
// dockModel() is pure (catalog in, tiles out) so node tests can pin it;
// createDock() is the DOM around it.
//
// Tile: {id, kind:'key'|'binding', cap, sub, tone, label, desc, search,
//        key?, mods?          (kind 'key': the modifier mask is added at click),
//        binding?             (kind 'binding': ready to write),
//        build?(tap)          (layer-tap / toggle: rebuilt around the key's tap)}

import { el } from './ui.js?v=77';
import { board, DRAG_TYPE } from './board.js?v=77';
import { SURFACES, surfaceEntries } from './binding-picker.js?v=77';
import { keySurfaceOf } from './boards.js?v=77';
import { captureOneKey } from './zmk-capture.js?v=77';
import { usageParts, kpParam } from './zmk-keycodes.js?v=77';
import { legendOf } from './legend.js?v=77';
import { encode, keySections, composeTapHold, tapHoldSpecOf, modsText, NERU_MENU, NERU_DESC } from './behavior-catalog.js?v=77';

const ADAPTER = 'zmk-studio';   // dockModel's default; createDock follows the board line
const KEY_A = 0x04;

/** "Add modifiers" chips: label, mask bit. Right-hand bits are the high nibble. */
export const MOD_CHIPS = [
    ['Ctl', 0x01], ['Sft', 0x02], ['Alt', 0x04], ['Gui', 0x08],
    ['RCtl', 0x10], ['RSft', 0x20], ['AltGr', 0x40], ['RGui', 0x80],
];
export const modNames = (mask) => MOD_CHIPS.filter(([, b]) => mask & b).map(([n]) => n).join('+');

const SECTION_CATEGORY = {
    letters: 'Letters', numbers: 'Numbers', shifted: 'Symbols', editing: 'Basic', modifiers: 'Modifiers',
    nav: 'Navigation', function: 'F-keys', numpad: 'Keypad', intl: 'Intl',
};
const ENTRY_CATEGORY = {
    'caps-word': 'Key behaviours', repeat: 'Key behaviours', 'alt-repeat': 'Key behaviours', 'grave-escape': 'Key behaviours', swapper: 'Key behaviours', 'super-delete': 'Key behaviours',
    'one-shot-mod': 'Key behaviours', 'key-toggle': 'Key behaviours',
    'hold-layer': 'Layers', 'toggle-layer': 'Layers', 'to-layer': 'Layers', 'one-shot-layer': 'Layers',
    'smart-layer': 'Layers', 'num-word': 'Layers', 'layer-tap': 'Layers',
    'tap-toggle': 'Layers', 'default-layer': 'Layers', 'layer-lock': 'Layers',
    'device-key': 'Device keys',
    bluetooth: 'Bluetooth & output', output: 'Bluetooth & output',
    'mouse-key': 'Mouse', autoscroll: 'Mouse', 'ball-swap': 'Mouse', gesture: 'Mouse',
    lighting: 'Lighting', underglow: 'Lighting',
    power: 'System', 'soft-off': 'System', reset: 'System', bootloader: 'System', 'studio-unlock': 'System',
    macro: 'Macros & run', 'tap-dance': 'Macros & run', adaptive: 'Macros & run', leader: 'Macros & run',
    advanced: 'Other',
};
const BEHAVIOUR_ORDER = ['Layers', 'Key behaviours', 'Bluetooth & output', 'Mouse', 'Device keys', 'Neru', 'Lighting', 'System', 'Macros & run', 'Other'];
// pointing.h packs x into the high int16, y into the low. Magnitudes are the compiled
// MOVE_VAL / SCRL_VAL of config/totem.keymap (1800 * MOUSE_SPEED_PCT/100, 20 * SCROLL_SPEED_PCT/100);
// the app cannot read them from the device. Up is -y for move, +y for scroll.
const POINTING = {
    mouse_move: { word: 'Mouse', val: 1800, dirs: [['left', -1, 0], ['down', 0, 1], ['up', 0, -1], ['right', 1, 0]] },
    mouse_scroll: { word: 'Scroll', val: 20, dirs: [['left', -1, 0], ['down', 0, -1], ['up', 0, 1], ['right', 1, 0]] },
};
// Totem firmware behaviors the picker expands by name (Totem-ZMK config/totem.keymap).
// Neru menu letters are HID keyboard usages; hold modifiers are the four left mods.
const NERU_USAGE = (c) => kpParam(c === '2' ? 0x1F : 0x04 + c.charCodeAt(0) - 65);
const HOLD_MODS = [['⌃ Ctrl', 0xE0], ['⇧ Shift', 0xE1], ['⌥ Opt', 0xE2], ['⌘ Cmd', 0xE3]];
const NERU_KEY = { 'Neru Menu + Key (stay)': 'stays on this layer', 'Neru Menu + Key (to base)': 'then back to Base' };
const NERU_PLAIN = { 'Neru Hints': 'Neru Hints: label every clickable target, type one to click', 'Neru Menu': 'Neru menu: opens the letter menu (g grid, r rgrid, b bisect …)' };
const MOD_HOLD = { 'Mod / Neru Hints': 'Neru Hints', 'Leader / Shift': 'Leader' };   // param1 = the held key, param2 unused
const LAYER_SHORT = { 'hold-layer': 'mo', 'toggle-layer': 'tog', 'to-layer': 'to', 'one-shot-layer': 'sl', 'tap-toggle': 'tt', 'default-layer': 'df' };
const TONE = { layer: 'layer', hold: 'hold', mod: 'hold', macro: 'macro', dim: 'dim', plain: '' };

function tile(base, binding, adapter = ADAPTER) {
    const lg = legendOf(binding, adapter);
    return { kind: 'binding', binding, cap: lg.main, sub: base.sub ?? lg.sub, tone: TONE[lg.kind] ?? '', ...base,
        search: `${lg.main} ${lg.sub} ${base.label ?? ''} ${base.desc ?? ''}`.toLowerCase() };
}

/**
 * @param {object[]} entries   surfaceEntries('zmk.key', app)
 * @param {object[]} sections  keySections()
 * @returns {{keys: {id,label,tiles}[], behaviours: {id,label,tiles}[], pinned: object[]}}
 */
export function dockModel(entries, sections, adapter = ADAPTER) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const keys = [];
    for (const s of sections) {
        const label = SECTION_CATEGORY[s.id];
        if (!label) continue;
        keys.push({ id: s.id, label, tiles: s.keys.map((k) => ({
            id: `key:${s.id}:${k.key}:${k.mods ?? 0}`, kind: 'key', key: k.key, mods: k.mods ?? 0,
            cap: k.cap || '·', sub: k.label && k.label !== k.cap ? k.label : '', tone: '', label: k.label,
            search: `${k.cap} ${k.label}`.toLowerCase(),
        })) });
    }
    const pinned = ['trans', 'none'].filter((id) => byId.has(id)).map((id) => {
        const e = byId.get(id);
        return tile({ id, label: e.name, desc: e.desc, sub: '' }, encode(id, {}, adapter), adapter);
    });

    const media = byId.get('media-key');
    const code = media?.params.find((p) => p.key === 'code');
    if (code) {
        keys.push({ id: 'media', label: 'Media', tiles: code.options.map((o) => {
            const b = encode('media-key', { code: o }, adapter);
            return tile({ id: `media:${o}`, label: code.labels?.[o] ?? String(o), desc: media.desc, sub: '' }, b, adapter);
        }) });
    }

    const cats = new Map();
    const add = (label, tiles) => { if (tiles.length) cats.set(label, [...(cats.get(label) ?? []), ...tiles]); };
    const safe = (fn) => { try { return fn(); } catch { return null; } };

    // Layers: ready-made tiles per layer (mo, lt "A / NAV", tog, to, sl).
    const layerEntry = byId.get('hold-layer') ?? byId.get('layer-tap');
    const lp = layerEntry?.params.find((p) => p.kind === 'layer');
    if (lp) {
        const ids = lp.options ?? [];
        const name = (id) => lp.labels?.[id] ?? `Layer ${id}`;
        const mk = (entryId, make) => ids.map((id) => {
            const e = byId.get(entryId);
            if (!e) return null;
            const b = safe(() => make(id));
            if (!b) return null;
            const t = tile({ id: `${entryId}:${id}`, label: `${e.name}: ${name(id)}`, desc: e.desc }, b, adapter);
            if (LAYER_SHORT[entryId]) t.sub = LAYER_SHORT[entryId];
            return t;
        }).filter(Boolean);
        const lt = byId.get('layer-tap') ? ids.map((id) => {
            const build = (tap = { key: KEY_A, mods: 0 }) => {
                const r = composeTapHold({ tap, hold: { kind: 'layer', layer: id } }, adapter);
                return r.ok ? r.value : null;
            };
            const b = build();
            if (!b) return null;
            const t = tile({ id: `layer-tap:${id}`, label: `Layer-tap: tap a key, hold for ${name(id)}`, desc: byId.get('layer-tap').desc }, b, adapter);
            t.build = build;
            return t;
        }).filter(Boolean) : [];
        add('Layers', [
            ...mk('hold-layer', (id) => encode('hold-layer', { layer: id }, adapter)),
            ...lt,
            ...mk('toggle-layer', (id) => encode('toggle-layer', { layer: id }, adapter)),
            ...mk('to-layer', (id) => encode('to-layer', { layer: id }, adapter)),
            ...mk('one-shot-layer', (id) => encode('one-shot-layer', { layer: id }, adapter)),
            ...mk('smart-layer', (id) => encode('smart-layer', { layer: id }, adapter)),
            ...mk('num-word', (id) => encode('num-word', { layer: id }, adapter)),
            ...mk('tap-toggle', (id) => encode('tap-toggle', { layer: id }, adapter)),
            ...mk('default-layer', (id) => encode('default-layer', { layer: id }, adapter)),
            ...(byId.has('layer-lock') ? [tile({ id: 'layer-lock', label: byId.get('layer-lock').name, desc: byId.get('layer-lock').desc }, encode('layer-lock', {}, adapter), adapter)] : []),
        ]);
    }

    for (const e of entries) {
        const cat = ENTRY_CATEGORY[e.id];
        if (!cat || cat === 'Layers' || e.id === 'advanced') continue;
        const params = e.params.filter((p) => p.kind !== 'raw');
        const t = (id, label, b) => b && tile({ id: `${e.id}:${id}`, label, desc: e.desc }, b, adapter);
        const out = [];
        if (!params.length) {
            out.push(t('', e.name, safe(() => encode(e.id, {}, adapter))));
        } else if (e.id === 'one-shot-mod') {
            for (const [n, bit] of MOD_CHIPS) out.push(t(n, `One-shot ${n}`, safe(() => encode(e.id, { mods: bit }, adapter))));
        } else if (e.id === 'key-toggle') {
            const build = (tap = { key: KEY_A, mods: 0 }) => encode('key-toggle', { key: tap.key, mods: tap.mods ?? 0 }, adapter);
            const x = t('', 'Key toggle: holds the key down until pressed again', safe(() => build()));
            if (x) { x.build = build; out.push(x); }
        } else if (params.length === 1 && params[0].kind === 'slot') {
            const p = params[0];
            for (let i = p.min ?? 0; i <= (p.max ?? 15); i++) out.push(t(String(i), `${e.name} ${i}`, safe(() => encode(e.id, { [p.key]: i }, adapter))));
        } else {
            const c = params.find((p) => p.kind === 'choice' && p.key === 'code');
            const prof = params.find((p) => p.key === 'profile');
            if (c && params.every((p) => p === c || p === prof)) {
                for (const o of c.options) {
                    const label = c.labels?.[o] ?? String(o);
                    if (prof && label === 'Select') {
                        for (let n = prof.min ?? 0; n <= (prof.max ?? 4); n++) out.push(t(`${o}:${n}`, `${e.name} select ${n}`, safe(() => encode(e.id, { code: o, profile: n }, adapter))));
                    } else out.push(t(String(o), `${e.name}: ${label}`, safe(() => encode(e.id, { code: o, ...(prof ? { profile: 0 } : {}) }, adapter))));
                }
            }
        }
        add(cat, out.filter(Boolean));
    }
    const adv = byId.get('advanced');
    if (adv?.behaviors?.length) {
        // Leftover firmware behaviors: plain ones as one tile; layer / key params expanded.
        const kinds = (d, w) => (d.metadata?.[0]?.[w] ?? []).filter((x) => x.kind !== 'nil');
        const defOf = (ds) => ds.find((x) => x.kind === 'constant')?.constant ?? ds.find((x) => x.kind === 'range')?.min ?? 0;
        const layerIds = lp?.options ?? [];
        const lname = (id) => lp?.labels?.[id] ?? `Layer ${id}`;
        const out = [];
        const mk = (d, id, label, cap, sub, b) => {
            return tile({ id: `adv:${d.id}:${id}`, label, desc: 'Other firmware behavior', cap, sub }, b, adapter);
        };
        const neru = [];
        const desc = 'Totem firmware behavior';
        for (const d of adv.behaviors) {
            const [p1, p2] = [kinds(d, 'param1'), kinds(d, 'param2')];
            const short = d.displayName.replace(/\s*\/\s*Layer$/, '');
            const n = d.displayName;
            if (NERU_PLAIN[n]) {
                neru.push(tile({ id: `adv:${d.id}`, label: NERU_PLAIN[n], desc }, { behaviorId: d.id, param1: 0, param2: 0 }, adapter));
            } else if (NERU_KEY[n]) {
                for (const [c, name] of Object.entries(NERU_MENU)) {
                    neru.push(tile({ id: `adv:${d.id}:${c}`, label: `Neru ${name}: ${NERU_DESC[c]}, ${NERU_KEY[n]}`, desc },
                        { behaviorId: d.id, param1: NERU_USAGE(c), param2: 0 }, adapter));
                }
            } else if (n === 'Mod / Neru Menu Key') {
                for (const [c, name] of Object.entries(NERU_MENU)) for (const [m, u] of HOLD_MODS) {
                    neru.push(tile({ id: `adv:${d.id}:${c}:${u}`, label: `Neru ${name} (tap), ${m} (hold): ${NERU_DESC[c]}`, desc },
                        { behaviorId: d.id, param1: kpParam(u), param2: NERU_USAGE(c) }, adapter));
                }
            } else if (MOD_HOLD[n]) {
                const to = n.includes('Neru') ? neru : out;
                for (const [m, u] of HOLD_MODS) {
                    to.push(tile({ id: `adv:${d.id}:${u}`, label: `${MOD_HOLD[n]} (tap), ${m} (hold)`, desc },
                        { behaviorId: d.id, param1: kpParam(u), param2: 0 }, adapter));
                }
            } else if (n === 'Mouse Layer-Tap') {
                // Like Layer-tap: hold = the layer, tap = the selected key's tap (default A).
                for (const id of layerIds) {
                    const build = (tap = { key: KEY_A, mods: 0 }) => ({ behaviorId: d.id, param1: id,
                        param2: ((((tap.mods ?? 0) & 0xFF) << 24) | kpParam(tap.key & 0xFFFF)) >>> 0 });
                    const t = tile({ id: `adv:${d.id}:${id}`, label: `Mouse Layer-Tap: tap a key, hold for ${lname(id)}`, desc }, build(), adapter);
                    t.build = build;
                    out.push(t);
                }
            } else if (!p1.length && POINTING[d.displayName]) {
                // Param-0 would be a no-op; offer the four directions instead.
                const { word, val, dirs } = POINTING[d.displayName];
                for (const [dir, x, y] of dirs) {
                    out.push(tile({ id: `adv:${d.id}:${dir}`, label: `${word} ${dir}`, desc: 'Other firmware behavior', sub: '' },
                        { behaviorId: d.id, param1: (((x * val & 0xFFFF) << 16) + (y * val & 0xFFFF)) >>> 0, param2: 0 }, adapter));
                }
            } else if (!p1.length) {
                out.push(tile({ id: `adv:${d.id}`, label: d.displayName, desc: 'Other firmware behavior', sub: '' },
                    { behaviorId: d.id, param1: 0, param2: 0 }, adapter));
            } else if (p1.some((x) => x.kind === 'layer_id')) {
                const both = p2.some((x) => x.kind === 'layer_id');
                for (const id of layerIds) {
                    out.push(mk(d, id, `${d.displayName}: ${lname(id)}`, lname(id), short,
                        { behaviorId: d.id, param1: id, param2: both ? id : defOf(p2) }));
                }
            } else if (p1.some((x) => x.kind === 'hid_usage') && !p2.length) {
                // Key param: like Key toggle, a tile that takes the selected key's tap (default A).
                const build = (tap = { key: KEY_A, mods: 0 }) => ({ behaviorId: d.id, param2: 0,
                    param1: ((((tap.mods ?? 0) & 0xFF) << 24) | kpParam(tap.key & 0xFFFF)) >>> 0 });
                const t = mk(d, 'key', `${d.displayName}: sends the selected key`, short, 'key', build());
                t.build = build;
                out.push(t);
            }
            // Other shapes (constants, ranges): no tile; the picker's "Other behavior" row covers them.
        }
        for (const t of out) t.search += ' advanced other';
        add('Other', out);
        for (const t of neru) t.search += ' neru';
        add('Neru', neru);
    }
    const behaviours = BEHAVIOUR_ORDER.filter((l) => cats.has(l)).map((label) => ({ id: label, label, tiles: cats.get(label) }));
    return { keys, behaviours, pinned };
}

/** All tiles matching `q` across both tabs (name, cap, code, description). */
export function searchTiles(model, q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const seen = new Set();
    const out = [];
    for (const t of [...model.pinned, ...model.keys.flatMap((c) => c.tiles), ...model.behaviours.flatMap((c) => c.tiles)]) {
        if (seen.has(t.id) || !t.search.includes(s)) continue;
        seen.add(t.id);
        out.push(t);
    }
    return out;
}

// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object}   o.app
 * @param {(binding) => *} o.assign   plain pick (the board assigns and advances)
 * @param {Element[]} [o.tools]       extra buttons for the tools row (Type-to-assign)
 * @param {string}   [o.surface]      'zmk.key' | 'qmk.key'; default: the app's firmware line
 */
export function createDock({ app, assign, tools = [], surface = keySurfaceOf(app) }) {
    const AD = SURFACES[surface].adapter;
    let model = null;
    let tab = 'keys';
    let cat = null;
    let query = '';
    let armed = 0;
    let target = null;          // {label, set({key, mods})} while the inspector wants a key
    let stopCapture = null;
    const ac = new AbortController();     // board listeners die with the dock
    let open = true;

    const root = el('section', { class: 'dock', 'data-open': 'true', 'aria-label': 'Palette' });
    const toggle = el('button', { class: 'dock-toggle', type: 'button', 'aria-expanded': 'true', 'aria-label': 'Collapse the palette',
        'data-caption': 'Show or hide the palette. Keys stay selectable either way.', onclick: () => setOpen(!open) }, '⌄');
    const hint = el('span', { class: 'dock-hint' });
    const seg = el('div', { class: 'seg', role: 'tablist', 'aria-label': 'Palette tab' });
    const catList = el('ul', { class: 'dock-cats' });
    const search = el('input', { type: 'search', class: 'dock-search', placeholder: 'Search: a, esc, volume, layer, bluetooth…', 'aria-label': 'Search keys and behaviours' });
    const press = el('button', { class: 'btn small', type: 'button', text: '⌨ Press a key',
        'data-caption': 'Press any key on your computer keyboard to pick it (modifiers held with it are kept). Esc cancels.' });
    const chipRow = el('div', { class: 'dock-mods', role: 'group', 'aria-label': 'Add modifiers' }, el('span', { class: 'dock-mods-label', text: 'Add modifiers' }));
    const banner = el('div', { class: 'dock-banner', role: 'status', hidden: true });
    const grid = el('div', { class: 'dock-grid' });
    const main = el('div', { class: 'dock-main' },
        el('div', { class: 'dock-tools' }, search, chipRow), banner, grid);
    const head = el('div', { class: 'dock-head' }, hint, press, ...tools, toggle);
    const body = el('div', { class: 'dock-body' }, el('aside', { class: 'dock-side' }, seg, catList), main);
    root.append(head, body);

    function setOpen(v) {
        open = v;
        root.dataset.open = String(v);
        toggle.setAttribute('aria-expanded', String(v));
        toggle.setAttribute('aria-label', v ? 'Collapse the palette' : 'Expand the palette');
        toggle.textContent = v ? '⌄' : '⌃';
    }

    const setHint = () => {
        hint.textContent = board.selectedKey()
            ? 'Click a tile to put it on the selected key, or drag a tile onto any key.'
            : 'Select a key, then click a tile. Or drag a tile onto any key.';
    };

    function chips() {
        chipRow.replaceChildren(chipRow.firstChild, ...MOD_CHIPS.map(([n, bit]) => el('button', {
            class: 'chip' + (armed & bit ? ' on' : ''), type: 'button', text: n, 'aria-pressed': String(!!(armed & bit)),
            'data-mod': n, 'data-caption': `Arm ${n}: the next key tile you click sends it with the key. Click again to disarm.`,
            onclick: () => { armed ^= bit; chips(); renderBanner(); },
        })));
    }
    function renderBanner() {
        if (target) {
            banner.hidden = false;
            banner.replaceChildren(`Key tiles will set the ${target.label}.`,
                el('button', { class: 'btn small ghost', type: 'button', text: 'Done', onclick: () => api.setTarget(null) }));
        } else if (armed) {
            banner.hidden = false;
            banner.replaceChildren(`Key tiles will send ${modNames(armed)} with the key.`,
                el('button', { class: 'btn small ghost', type: 'button', text: 'Clear modifiers', onclick: () => { armed = 0; chips(); renderBanner(); } }));
        } else banner.hidden = true;
    }

    const effective = (t) => {
        if (t.kind === 'key') {
            const mods = (t.mods | armed) & 0xFF;
            return encode('key', { key: t.key, mods }, AD);
        }
        if (t.build) {
            const spec = tapHoldSpecOf(board.bindingOf(), AD);
            return t.build(spec?.tap) ?? t.binding;
        }
        return t.binding;
    };

    function click(t) {
        if (t.kind === 'key' && target) { target.set({ key: t.key, mods: (t.mods | armed) & 0xFF }); return; }
        assign(effective(t));
    }

    function tileEl(t) {
        const b = el('button', { class: `tile${t.tone ? ' t-' + t.tone : ''}`, type: 'button', draggable: 'true',
            'data-tile': t.id, 'aria-label': t.label || t.cap, title: t.label || t.cap,
            'data-caption': `${t.label ?? t.cap}${t.desc ? ' · ' + t.desc : ''}`,
            onclick: () => click(t),
            ondragstart: (e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(t.kind === 'key' ? effective(t) : t.binding));
                e.dataTransfer.setData('text/plain', t.label || t.cap);
            },
        }, el('span', { class: 'tile-cap', text: t.cap }), t.sub ? el('span', { class: 'tile-sub', text: t.sub }) : null);
        return b;
    }

    function render() {
        if (!model) return;
        setHint();
        seg.replaceChildren(...[['keys', 'Keys'], ['behaviours', 'Behaviours']].map(([id, label]) => el('button', {
            class: tab === id && !query ? 'on' : '', role: 'tab', type: 'button', 'aria-selected': String(tab === id), text: label, 'data-tab': id,
            onclick: () => { tab = id; cat = null; query = ''; search.value = ''; render(); },
        })));
        const cats = model[tab];
        if (!cats.some((c) => c.id === cat)) cat = cats[0]?.id ?? null;
        catList.replaceChildren(...cats.map((c) => el('li', {}, el('button', {
            class: c.id === cat && !query ? 'on' : '', type: 'button', text: c.label, 'data-cat': c.id,
            onclick: () => { cat = c.id; query = ''; search.value = ''; render(); },
        }))));
        grid.replaceChildren();
        if (query) {
            const hits = searchTiles(model, query);
            if (!hits.length) grid.append(el('div', { class: 'dock-empty', text: `Nothing matches "${search.value}".` }));
            else grid.append(el('div', { class: 'tiles' }, ...hits.map(tileEl)));
            return;
        }
        const cur = cats.find((c) => c.id === cat);
        const lead = tab === 'keys' ? model.pinned : [];
        if (cur) grid.append(el('div', { class: 'tiles', 'data-cat': cur.id }, ...[...lead, ...cur.tiles].map(tileEl)));
    }

    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
    press.addEventListener('click', () => {
        if (stopCapture) { stopCapture(); return; }
        press.textContent = 'Press a key… (Esc cancels)';
        press.classList.add('primary');
        stopCapture = captureOneKey((usage) => {
            const { mods, id } = usageParts(usage);
            const isMod = id >= 0xE0 && id <= 0xE7;
            const m = ((isMod ? 0 : mods) | armed) & 0xFF;
            if (target) target.set({ key: id, mods: m });
            else assign(encode('key', { key: id, mods: m }, AD));
        }, { onStop: () => { stopCapture = null; press.textContent = '⌨ Press a key'; press.classList.remove('primary'); } });
    });
    chips();
    setOpen(true);

    const api = {
        root,
        /** Rebuild from the live catalog (layer names, slots). Keeps tab, category, search and armed mods. */
        refresh(app2 = app) {
            model = dockModel(surfaceEntries(surface, app2), keySections(), AD);
            render();
        },
        armedMods: () => armed,
        clearMods() { armed = 0; chips(); renderBanner(); },
        /** While set, key tiles call target.set({key, mods}) instead of assigning
         * the whole key (the inspector's TAP / HOLD-key boxes). null clears. */
        setTarget(t) { target = t; renderBanner(); root.classList.toggle('targeting', !!t); },
        get target() { return target; },
        setHint,
        stop() { stopCapture?.(); },
        /** Drop the board listener; the owning tab calls this when it is replaced. */
        dispose() { stopCapture?.(); ac.abort(); },
    };
    board.addEventListener('select', setHint, { signal: ac.signal });
    api.refresh();
    return api;
}

export { modsText };
