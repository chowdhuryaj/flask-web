// BindingPicker: the one picker every surface opens (spec §4.5–4.7).
// Catalog-driven (behavior-catalog.js): one entry per behavior, variants as
// parameters, groups as chips, one search across keys and behaviors.
//
// Value types, by adapter (SURFACES[surface].adapter):
//   'qmk'        number, a QMK u16 keycode
//   'zmk-studio' {behaviorId, param1, param2}, a Studio binding
//   'zmk-typed'  {action, param1, behaviorId?, param2?}; action uses the
//                shared slot vocabulary (zmk-tapdance-codec TD_ACTION:
//                0 none, 1 usage, 2 macro slot, 3 behavior). Leader and
//                gesture codecs call param1 `param`.
//   'nape'       number, a Nape u16 keycode

import { el } from './ui.js?v=49';
import { zmkBehaviors, usageParts } from './zmk-keycodes.js?v=49';
import { captureOneKey } from './zmk-capture.js?v=49';
import { saveState } from './save-state.js?v=1';
import {
    CATALOG_GROUPS, catalogFor, decode, encode, capParts, describeBinding, keySections, modsText,
    resolveTiming, timingBackendNow, attachHoldtap, HOLDTAP, TIMING_PARAM,
} from './behavior-catalog.js?v=1';

/**
 * Every surface a picker can serve (spec §4.7). `hide` lists catalog group
 * ids or entry ids (behavior-catalog.js) the surface cannot store, plus
 * 'mods-row' (no held-modifier row on the Keys grid). Callers pass the key,
 * e.g. `openPicker({ surface: 'zmk.comboOutput', … })`.
 * @type {Record<string, {adapter: 'qmk'|'zmk-studio'|'zmk-typed'|'nape', stores: string, hide: string[]}>}
 */
export const SURFACES = {
    'qmk.key': { adapter: 'qmk', stores: 'u16 keycode', hide: [] },
    'qmk.encoder': { adapter: 'qmk', stores: 'u16 keycode', hide: [] },
    'qmk.comboOutput': { adapter: 'qmk', stores: 'u16 keycode', hide: ['leader'] },
    'qmk.tapDanceStep': { adapter: 'qmk', stores: 'u16 keycode', hide: ['leader'] },
    'qmk.keyOverride': { adapter: 'qmk', stores: 'u16 keycode', hide: ['leader'] },
    'qmk.cornerChord': { adapter: 'qmk', stores: 'u16 keycode', hide: ['leader'] },
    // Sval < v16 only takes tappable keycodes; v16+ is the mouseChord shape.
    // The caller picks the variant from caps.
    'qmk.gestureSlotTappable': { adapter: 'qmk', stores: 'tappable u16', hide: ['modifiers', 'layers', 'mouse', 'run', 'advanced'] },
    'qmk.gestureSlot': { adapter: 'qmk', stores: 'u16 keycode', hide: ['leader', 'layers'] },
    'qmk.mouseChord': { adapter: 'qmk', stores: 'u16 keycode', hide: ['leader', 'layers'] },
    'qmk.macroKey': { adapter: 'qmk', stores: 'basic keycode', hide: ['modifiers', 'layers', 'mouse', 'media', 'run', 'advanced', 'mods-row'] },
    'qmk.leaderKey': { adapter: 'qmk', stores: 'basic keycode', hide: ['modifiers', 'layers', 'mouse', 'media', 'run', 'advanced'] },
    'qmk.cskBase': { adapter: 'qmk', stores: 'basic keycode', hide: ['modifiers', 'layers', 'mouse', 'media', 'run', 'advanced', 'mods-row'] },
    'qmk.cskShifted': { adapter: 'qmk', stores: 'basic keycode + mods', hide: ['modifiers', 'layers', 'mouse', 'media', 'run', 'advanced'] },
    'zmk.key': { adapter: 'zmk-studio', stores: 'Studio binding', hide: [] },
    'zmk.comboOutput': { adapter: 'zmk-typed', stores: 'usage / macro / behavior', hide: ['leader', 'advanced'] },
    'zmk.tapDanceStep': { adapter: 'zmk-typed', stores: 'usage / macro / behavior', hide: ['leader', 'tap-dance', 'advanced'] },
    'zmk.typedOutput': { adapter: 'zmk-typed', stores: 'usage / macro', hide: ['modifiers', 'layers', 'mouse', 'leader', 'tap-dance', 'advanced'] },
    'zmk.macroKey': { adapter: 'zmk-typed', stores: 'usage', hide: ['modifiers', 'layers', 'mouse', 'run', 'advanced'] },
    'zmk.cskBase': { adapter: 'zmk-typed', stores: 'usage', hide: ['modifiers', 'layers', 'mouse', 'media', 'run', 'advanced', 'mods-row'] },
    'zmk.cskShifted': { adapter: 'zmk-typed', stores: 'usage + mods', hide: ['modifiers', 'layers', 'mouse', 'media', 'run', 'advanced'] },
    'nape.key': { adapter: 'nape', stores: 'Nape u16', hide: ['media', 'advanced'] },
};

// What each storage kind can hold, beyond the group hides: entry ids, or
// null for "anything the adapter encodes".
const STORES = {
    'basic keycode': ['key', 'none'],
    'basic keycode + mods': ['key', 'none'],
    'tappable u16': ['key', 'none', 'media-key'],
    'usage / macro': ['key', 'media-key', 'macro', 'none'],
    usage: ['key', 'media-key', 'none'],
    'usage + mods': ['key', 'media-key', 'none'],
};
const KEYMAP_SURFACES = new Set(['qmk.key', 'qmk.encoder', 'zmk.key', 'nape.key']);
const GROUP_REASON = {
    modifiers: 'Modifier behaviors', layers: 'Layer keys', mouse: 'Mouse keys', media: 'Media and system keys',
    run: 'Macros and tap dances', advanced: 'Raw behaviors',
};

/** Entries a surface shows, in catalog order, plus a one-line reason for
 * the groups it leaves out. Exported for WP4 tiles and tests. */
export function surfaceEntries(surface, app) {
    const spec = SURFACES[surface];
    if (!spec) throw new Error(`unknown surface ${surface}`);
    const fam = spec.adapter === 'nape' ? { family: 'nape' } : spec.adapter === 'qmk' ? { adapter: 'qmk' } : { adapter: 'zmk-studio' };
    const all = catalogFor({ ...app, ...fam });
    const storable = STORES[spec.stores] ?? null;
    const entries = all.filter((e) => !spec.hide.includes(e.group) && !spec.hide.includes(e.id)
        && (!storable || storable.includes(e.id))
        && (e.id !== 'trans' || KEYMAP_SURFACES.has(surface)))
        // Live hold-tap timing is per key position: keymap surfaces only.
        // ponytail: combo/autoshift virtual slots (contract update) get their sliders in WP4a.
        .map((e) => (spec.adapter === 'zmk-typed' && e.params.some((x) => x.key === 'live')
            ? { ...e, params: e.params.filter((x) => x.key !== 'live') } : e));
    const shown = new Set(entries.map((e) => e.group));
    const missing = CATALOG_GROUPS.filter((g) => !shown.has(g.id) && all.some((e) => e.group === g.id) && GROUP_REASON[g.id]);
    const reason = missing.length && !KEYMAP_SURFACES.has(surface)
        ? `${missing.map((g) => GROUP_REASON[g.id]).join(', ')} can't be stored in a ${spec.stores} slot.` : '';
    return Object.assign(entries, { hidden: all.hidden, reason, adapter: spec.adapter });
}

/**
 * Open a picker. One call shape for every host.
 *
 * @param {object} o
 * @param {string} o.surface       a SURFACES key
 * @param {*}      [o.value]       current value (adapter type above), or null
 * @param {'docked'|'popover'|'sheet'} [o.host='sheet']
 *        docked:  rendered inside `anchor` (a container element), stays open
 *        popover: floating 420×360 near `anchor` (an element), closes on
 *                 pick, Escape or an outside click
 *        sheet:   modal titled `title`, closes on pick, Escape or a backdrop click
 * @param {Element} [o.anchor]
 * @param {string}  [o.title]      sheet title, e.g. "Combo 3 output"
 * @param {object}  [o.app]        the app object: layerCount, tapDanceCount,
 *        flask + protocolVersion (ZMK live hold-tap timing), slotSummary?(entryId, slot) → text
 * @param {number}  [o.position]   key position (zmk.key): enables the per-key
 *        live timing slider; the slider writes that position's flask_holdtap slot
 * @param {(value:*) => void} o.onPick  called with an adapter-typed value
 * @returns {() => void} close()   idempotent. A docked picker also gets
 *        close.setValue(v) to show a new current value without rebuilding.
 */
export function openPicker({ surface, value = null, host = 'sheet', anchor, title, app, position, onPick }) {
    const spec = SURFACES[surface];
    if (!spec) throw new Error(`openPicker: unknown surface ${surface}`);
    let closed = false;
    let dispose = () => {};
    const close = () => { if (!closed) { closed = true; dispose(); } };
    const pick = (v) => { if (host !== 'docked') close(); onPick(v); };
    const view = buildPickerBody({ surface, value, app, position, host, onPick: pick });
    const body = view.root;
    const onKey = (e) => { if (e.key === 'Escape' && !view.capturing()) close(); };

    if (host === 'docked') {
        if (!anchor) throw new Error('openPicker: docked host needs an anchor container');
        anchor.append(body);
        dispose = () => { view.stop(); body.remove(); };
        close.setValue = view.setValue;
    } else if (host === 'popover') {
        const r = anchor?.getBoundingClientRect() ?? { left: 16, bottom: 16 };
        const pop = el('div', { class: 'picker-popover', role: 'dialog', 'aria-label': title ?? 'Pick a binding' }, body);
        pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 428))}px`;
        pop.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - 368))}px`;
        const onDown = (e) => { if (!pop.contains(e.target) && !anchor?.contains(e.target)) close(); };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown, true);
        document.body.append(pop);
        view.focus();
        dispose = () => {
            view.stop();
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDown, true);
            pop.remove();
        };
    } else {
        const back = el('div', { class: 'modal-back' });
        back.append(el('div', { class: 'modal picker-sheet', role: 'dialog', 'aria-label': title ?? 'Pick a binding' },
            el('div', { class: 'bp-sheet-head' },
                el('h2', { text: title ?? 'Pick a binding' }),
                el('button', { class: 'btn small', text: 'Cancel', onclick: () => close() })),
            body));
        back.addEventListener('click', (e) => { if (e.target === back) close(); });
        document.addEventListener('keydown', onKey);
        document.body.append(back);
        view.focus();
        dispose = () => { view.stop(); document.removeEventListener('keydown', onKey); back.remove(); };
    }
    return close;
}

/** Studio binding → typed slot value (usage / macro / behavior). */
export function typedFromStudio(b, keyPressId = keyPressIdOf()) {
    if (b.behaviorId === keyPressId) return { action: 1, param1: b.param1 >>> 0 };
    if (zmkBehaviors().get(b.behaviorId)?.displayName === 'Flask Macro') return { action: 2, param1: b.param1 >>> 0 };
    return { action: 3, behaviorId: b.behaviorId, param1: b.param1 >>> 0, param2: b.param2 >>> 0 };
}

function keyPressIdOf() {
    for (const [id, d] of zmkBehaviors()) if (d.displayName === 'Key Press') return id;
    return null;
}

// ---------------------------------------------------------------------------
// The picker body (all hosts)

const MOD_CHIPS = [{ bit: 0x01, g: '⌃', n: 'Control' }, { bit: 0x02, g: '⇧', n: 'Shift' },
    { bit: 0x04, g: '⌥', n: 'Option' }, { bit: 0x08, g: '⌘', n: 'Command' }];

/**
 * Build the picker content without a host. Returns
 * {root, setValue(v), focus(), stop(), capturing()}. picker.js and the
 * Nape/ZMK legacy wrappers use it; everything else calls openPicker.
 */
export function buildPickerBody({ surface, value = null, app = {}, position, host = 'docked', onPick }) {
    const spec = SURFACES[surface];
    const adapter = spec.adapter;
    const isZmk = adapter !== 'qmk' && adapter !== 'nape';
    let entries = surfaceEntries(surface, app);
    const keyEntry = entries.find((e) => e.id === 'key');
    const modsAllowed = !spec.hide.includes('mods-row') && !!keyEntry;
    let current = value == null ? null : safeDecode(value, adapter);
    let group = current && entries.some((e) => e.id === current.entryId)
        ? entries.find((e) => e.id === current.entryId).group : entries[0]?.group ?? 'keys';
    let query = '';
    let heldMods = current?.entryId === 'key' && modsAllowed ? current.params.mods ?? 0 : 0;
    let stopCapture = null;
    const state = new Map();   // entryId → params being edited

    const root = el('div', { class: 'picker bp', 'data-host': host, 'data-surface': surface });
    const search = el('input', { type: 'search', class: 'bp-search', placeholder: 'Search keys and behaviors…',
        'aria-label': 'Search keys and behaviors' });
    const captureBtn = el('button', { class: 'btn small bp-capture', text: '⌨ Press a key',
        'data-caption': 'Press any key on your computer keyboard to pick it (modifiers held with it are kept). Esc cancels.' });
    const chips = el('div', { class: 'bp-groups', role: 'tablist' });
    const bodyEl = el('div', { class: 'bp-body' });
    const caption = el('div', { class: 'bp-caption', 'aria-live': 'polite' });
    const defaultCaption = () => entries.reason || (adapter === 'qmk' ? '' : '');
    const setCap = (t) => { caption.textContent = t || defaultCaption(); };
    root.addEventListener('pointerover', (e) => { const t = e.target.closest?.('[data-caption]'); if (t) setCap(t.dataset.caption); });
    root.addEventListener('focusin', (e) => { const t = e.target.closest?.('[data-caption]'); if (t) setCap(t.dataset.caption); });
    root.addEventListener('pointerleave', () => setCap(''));

    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
    captureBtn.addEventListener('click', () => {
        if (stopCapture) { stopCapture(); return; }
        captureBtn.textContent = 'Press a key… (Esc cancels)';
        captureBtn.classList.add('primary');
        stopCapture = captureOneKey((usage) => {
            const { mods, id } = usageParts(usage);
            const isMod = id >= 0xE0 && id <= 0xE7;
            assign('key', { key: id, mods: modsAllowed && !isMod ? mods : 0 });
        }, { onStop: () => { stopCapture = null; captureBtn.textContent = '⌨ Press a key'; captureBtn.classList.remove('primary'); } });
    });

    const head = el('div', { class: 'bp-head' }, search, keyEntry ? captureBtn : null);
    root.append(head, chips, bodyEl, caption);

    // Live hold-tap timing (ZMK proto ≥ 17): probe once, re-render when known.
    if (adapter === 'zmk-studio' && app?.flask) {
        attachHoldtap(app, { onDirty: () => markHoldtapDirty() }).then((b) => { if (b) render(); });
    }

    function assign(entryId, params) {
        let v;
        try { v = encode(entryId, params, adapter); } catch (err) { setCap(String(err.message)); return; }
        const e = entries.find((x) => x.id === entryId);
        if (adapter === 'zmk-studio' && e && params.live && params.live !== 'off' && position != null) {
            const be = timingBackendNow();
            if (be.runtime) {
                const r = resolveTiming(entryId, params.timing ?? TIMING_PARAM.default,
                    e.device.filter((d) => d.set.live).map((d) => ({ behaviorId: d.behaviorId, ms: null, live: true, side: d.set.live })),
                    { side: params.live });
                r?.write?.(position).catch((err) => setCap(`Timing not written: ${err.message}`));
            }
        }
        current = decode(v, adapter);
        onPick(v);
        if (root.isConnected) render();
    }

    function renderChips() {
        const groups = CATALOG_GROUPS.filter((g) => entries.some((e) => e.group === g.id));
        chips.replaceChildren(...groups.map((g) => el('button', {
            class: 'chip' + (g.id === group && !query ? ' on' : ''), role: 'tab', 'aria-selected': String(g.id === group && !query),
            text: g.label, 'data-group': g.id,
            onclick: () => { group = g.id; query = ''; search.value = ''; render(); },
        })));
        chips.hidden = groups.length < 2;
    }

    function render() {
        entries = surfaceEntries(surface, app);
        renderChips();
        bodyEl.replaceChildren();
        if (query) return renderSearch();
        if (group === 'keys') renderKeys(bodyEl, (key, mods) => assign('key', { key, mods }), true);
        for (const e of entries.filter((x) => x.group === group && !['key', 'trans', 'none'].includes(x.id))) bodyEl.append(entryRow(e));
        if (group === 'advanced' && entries.hidden) bodyEl.append(footnote());
        if (entries.reason) bodyEl.append(el('div', { class: 'bp-note', text: entries.reason }));
    }

    function footnote() {
        return el('div', { class: 'bp-note',
            text: `${entries.hidden} firmware behavior${entries.hidden === 1 ? ' has' : 's have'} no name and can't be assigned from here.` });
    }

    // ---- Keys grid ----
    function renderKeys(host, onKey, withSpecials) {
        if (withSpecials) {
            const specials = entries.filter((e) => e.id === 'trans' || e.id === 'none');
            if (specials.length) {
                host.append(el('div', { class: 'bp-specials' }, ...specials.map((e) => keyBtn(
                    e.id === 'none' && !KEYMAP_SURFACES.has(surface) ? 'Clear' : e.tag, e.name, e.desc,
                    current?.entryId === e.id, () => assign(e.id, {})))));
            }
        }
        if (withSpecials && modsAllowed) host.append(modsRow());
        const curKey = current?.entryId === 'key' ? current.params.key : null;
        for (const s of keySections()) {
            if (s.id === 'shifted' && !modsAllowed) continue;
            host.append(el('div', { class: 'bp-section' },
                el('h4', { text: s.label }),
                el('div', { class: 'bp-grid' }, ...s.keys.map((k) => keyBtn(k.cap, k.label,
                    k.mods ? `${k.label} (Shift + key)` : k.label,
                    withSpecials && curKey === k.key && (current.params.mods ?? 0) === ((k.mods || heldMods) & 0xFF),
                    () => onKey(k.key, k.mods || (withSpecials ? heldMods : 0)), s.id === 'editing' || s.id === 'modifiers')))));
        }
    }

    function keyBtn(cap, label, desc, on, onclick, wide = false) {
        return el('button', { class: 'bp-key' + (on ? ' on' : '') + (wide ? ' wide' : ''),
            'data-caption': desc, 'aria-label': label, title: label, onclick }, cap || '·');
    }

    function modsRow() {
        const row = el('div', { class: 'bp-mods', 'data-caption': 'Modifiers held with the key you pick next (⌘C in one click). Right-hand uses the right-side modifiers.' },
            el('span', { class: 'bp-mods-label', text: 'Held with the key:' }));
        const right = !!(heldMods & 0xF0);
        const base = right ? heldMods >> 4 : heldMods & 0xF;
        for (const m of MOD_CHIPS) {
            row.append(el('button', { class: 'chip' + (base & m.bit ? ' on' : ''), text: m.g, title: m.n, 'aria-pressed': String(!!(base & m.bit)),
                onclick: () => { const b = base ^ m.bit; heldMods = right ? b << 4 : b; render(); } }));
        }
        row.append(el('button', { class: 'chip' + (right ? ' on' : ''), text: 'Right-hand', 'aria-pressed': String(right),
            onclick: () => { heldMods = right ? heldMods >> 4 : (heldMods & 0xF) << 4; render(); } }));
        return row;
    }

    // ---- Search: keys + entries, each once ----
    function renderSearch() {
        const q = query;
        if (keyEntry) {
            const hits = keySections().filter((s) => s.id !== 'shifted' || modsAllowed)
                .flatMap((s) => s.keys.filter((k) => k.label.toLowerCase().includes(q) || k.cap.toLowerCase() === q)
                    .map((k) => ({ ...k, section: s.label })));
            if (hits.length) {
                bodyEl.append(el('div', { class: 'bp-section' }, el('h4', { text: 'Keys' }),
                    el('div', { class: 'bp-grid' }, ...hits.map((k) => keyBtn(k.cap, k.label, `${k.label} · ${k.section}`, false,
                        () => assign('key', { key: k.key, mods: k.mods || heldMods }))))));
            }
        }
        const rows = entries.filter((e) => e.id !== 'key' && (e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q)
            || (e.params.find((p) => p.key === 'code')?.labels && Object.values(e.params.find((p) => p.key === 'code').labels).some((l) => String(l).toLowerCase().includes(q)))));
        for (const e of rows) bodyEl.append(entryRow(e, q));
        if (!bodyEl.children.length) bodyEl.append(el('div', { class: 'bp-note', text: `Nothing matches "${search.value}".` }));
    }

    // ---- Entry rows ----
    function paramsFor(e) {
        if (!state.has(e.id)) {
            const p = {};
            for (const x of e.params) if (x.default !== undefined) p[x.key] = x.default;
            if (e.params.some((x) => x.key === 'live') && timingBackendNow().runtime) p.live = e.params.find((x) => x.key === 'live').options.includes('any') ? 'any' : p.live;
            const lay = e.params.find((x) => x.kind === 'layer');
            if (lay?.options?.length && !lay.options.includes(p[lay.key])) p[lay.key] = lay.options[Math.min(1, lay.options.length - 1)];
            const ch = e.params.find((x) => x.kind === 'choice' && x.key === 'code');
            if (ch && p.code === undefined) p.code = ch.options[0];
            if (current?.entryId === e.id) Object.assign(p, current.params);
            state.set(e.id, p);
        }
        return state.get(e.id);
    }

    function entryRow(e, q = '') {
        const p = paramsFor(e);
        const isCur = current?.entryId === e.id;
        const row = el('div', { class: 'bp-entry' + (isCur ? ' current' : ''), 'data-entry': e.id, 'data-caption': e.desc });
        const headEl = el('div', { class: 'bp-entry-head' }, el('strong', { text: e.name }), el('span', { class: 'bp-desc', text: e.desc }));
        row.append(headEl);
        const visible = e.params.filter((x) => x.kind !== 'raw');
        // No params: one click assigns.
        if (!visible.length && e.id !== 'advanced') {
            row.classList.add('bp-entry-one');
            row.append(el('button', { class: 'btn small primary', text: isCur ? 'Assigned' : 'Assign', onclick: () => assign(e.id, {}) }));
            return row;
        }
        if (e.id === 'advanced') { row.append(advancedComposer(e)); return row; }
        // One chip-able param: chips assign on click.
        const only = visible.length === 1 ? visible[0] : null;
        if (only && (only.kind === 'layer' || only.kind === 'slot' || only.kind === 'choice')) {
            row.append(chipGrid(e, only, (v) => assign(e.id, { ...p, [only.key]: v }), q));
            return row;
        }
        const controls = el('div', { class: 'bp-params' });
        for (const x of visible) {
            const c = control(e, x, p);
            if (c) controls.append(c);
        }
        const go = el('button', { class: 'btn small primary bp-assign', text: 'Assign', onclick: () => {
            const missing = visible.find((x) => x.kind === 'key' && !p[x.key]);
            if (missing) { setCap(`Pick the ${missing.key === 'tap' ? 'tap key' : 'key'} first.`); return; }
            assign(e.id, p);
        } });
        row.append(controls, go);
        if (e.note) row.append(el('div', { class: 'bp-note', text: e.note }));
        return row;
    }

    function chipGrid(e, param, onChoose, q = '') {
        let opts = optionsOf(e, param);
        if (q) {
            const hit = opts.filter((o) => o.label.toLowerCase().includes(q));
            if (hit.length) opts = hit;
        }
        const cur = current?.entryId === e.id ? current.params[param.key] : undefined;
        return el('div', { class: 'bp-chips' }, ...opts.map((o) => el('button', {
            class: 'bp-key labeled' + (cur === o.value ? ' on' : ''),
            'data-caption': `${e.name}: ${o.label}${o.summary ? ' · ' + o.summary : ''}`,
            onclick: () => onChoose(o.value),
        }, el('span', { class: 'bp-top', text: o.top ?? '' }), el('span', { text: o.cap ?? o.label }))));
    }

    function optionsOf(e, param) {
        if (param.kind === 'layer') {
            const ids = param.options ?? Array.from({ length: (param.max ?? 15) + 1 }, (_, i) => i);
            const name = (id) => param.labels?.[id] ?? `Layer ${id}`;
            return ids.map((id) => ({ value: id, label: name(id), top: `${e.tag} ${isZmk ? '' : id}`.trim(), cap: isZmk ? name(id) : `${id}` }));
        }
        if (param.kind === 'slot') {
            const out = [];
            const pre = e.id === 'macro' ? 'M' : e.id === 'tap-dance' ? 'TD' : '';
            for (let i = param.min ?? 0; i <= (param.max ?? 15); i++) {
                const summary = app?.slotSummary?.(e.id, i) ?? '';
                out.push({ value: i, label: `${e.name} ${i}`, cap: `${pre}${i}`, top: summary ? summary.slice(0, 14) : '', summary });
            }
            return out;
        }
        return param.options.map((v) => ({ value: v, label: param.labels?.[v] ?? String(v),
            cap: shortCap(e, v, param), top: '' }));
    }

    function shortCap(e, v, param) {
        try { return capParts(encode(e.id, { ...paramsFor(e), [param.key]: v }, adapter), adapter).main; }
        catch { return param.labels?.[v] ?? String(v); }
    }

    function control(e, x, p) {
        const rerender = () => { render(); };
        if (x.kind === 'mods') {
            const wrap = el('span', { class: 'bp-ctl' }, el('label', { text: x.key === 'hold' ? 'Hold' : 'Modifier' }));
            const right = !!(p[x.key] & 0xF0);
            const base = right ? p[x.key] >> 4 : p[x.key] & 0xF;
            for (const m of MOD_CHIPS) {
                wrap.append(el('button', { class: 'chip' + (base & m.bit ? ' on' : ''), text: m.g, title: m.n, 'aria-pressed': String(!!(base & m.bit)),
                    onclick: () => { const b = base ^ m.bit; p[x.key] = right ? b << 4 : b; delete p.holdKey; delete p.key; rerender(); } }));
            }
            wrap.append(el('button', { class: 'chip' + (right ? ' on' : ''), text: 'R', title: 'Right-hand modifiers',
                onclick: () => { p[x.key] = right ? p[x.key] >> 4 : (p[x.key] & 0xF) << 4; rerender(); } }));
            return wrap;
        }
        if (x.kind === 'key') {
            const label = x.key === 'tap' ? 'Tap' : 'Key';
            const btn = el('button', { class: 'bp-key wide', text: p[x.key] ? keyText(p[x.key], x.key === 'key' ? p.mods : 0) : `${label.toLowerCase()} key…`,
                'data-caption': `Pick the key ${x.key === 'tap' ? 'a quick tap types' : 'this sends'}.` });
            const wrap = el('span', { class: 'bp-ctl' }, el('label', { text: label }), btn);
            btn.addEventListener('click', () => {
                const open = wrap.parentElement.parentElement.querySelector('.bp-nested');
                if (open) { open.remove(); return; }
                const nested = el('div', { class: 'bp-nested' });
                renderKeys(nested, (key) => { p[x.key] = key; rerender(); }, false);
                wrap.parentElement.after(nested);
            });
            return wrap;
        }
        if (x.kind === 'layer') {
            const sel = el('select', { 'aria-label': 'Layer', onchange: () => { p[x.key] = Number(sel.value); } },
                ...optionsOf(e, x).map((o) => el('option', { value: o.value, text: isZmk ? o.label : `${o.value} ${o.label === `Layer ${o.value}` ? '' : o.label}`.trim(), selected: o.value === p[x.key] })));
            return el('span', { class: 'bp-ctl' }, el('label', { text: 'Layer' }), sel);
        }
        if (x.kind === 'num' || x.kind === 'slot') {
            const sel = el('select', { onchange: () => { p[x.key] = Number(sel.value); } },
                ...Array.from({ length: (x.max ?? 4) - (x.min ?? 0) + 1 }, (_, i) => i + (x.min ?? 0))
                    .map((i) => el('option', { value: i, text: String(i), selected: i === p[x.key] })));
            return el('span', { class: 'bp-ctl' }, el('label', { text: x.key === 'profile' ? 'Profile' : 'Slot' }), sel);
        }
        if (x.kind === 'choice' && x.key === 'code') {
            const sel = el('select', { onchange: () => { p.code = Number(sel.value); } },
                ...x.options.map((o) => el('option', { value: o, text: x.labels?.[o] ?? String(o), selected: o === p.code })));
            return el('span', { class: 'bp-ctl' }, el('label', { text: 'Action' }), sel);
        }
        if (x.kind === 'choice') return segmented(x, p, rerender, e);
        if (x.kind === 'ms') return timingControl(e, x, p, rerender);
        return null;
    }

    function segmented(x, p, rerender, e) {
        const label = x.key === 'mode' ? 'Mode' : x.key === 'live' ? 'Timing source' : x.key;
        const wrap = el('span', { class: 'bp-ctl bp-seg', role: 'radiogroup', 'aria-label': label }, el('label', { text: label }));
        for (const o of x.options) {
            const disabled = x.key === 'live' && p.mode === 'smart';
            wrap.append(el('button', { class: 'chip' + (p[x.key] === o ? ' on' : ''), role: 'radio', 'aria-checked': String(p[x.key] === o),
                text: x.labels?.[o] ?? o, disabled,
                'data-caption': disabled ? 'Smart mod timing is compiled into the keymap.' : liveCaption(o, e),
                onclick: () => { p[x.key] = o; rerender(); } }));
        }
        return wrap;
    }

    function liveCaption(o, e) {
        if (!['any', 'left', 'right'].includes(o)) return o === 'off' ? 'Uses the timing compiled into the keymap (Fast / Standard / Slow).' : '';
        const rule = o === 'left' ? 'For left-hand keys: holds only when the other hand follows.'
            : o === 'right' ? 'For right-hand keys: holds only when the other hand follows.' : 'No hand rule.';
        return `${rule} Timing is set per key position, live (${e.name}).`;
    }

    function timingControl(e, x, p, rerender) {
        const be = timingBackendNow();
        const wantsLive = p.live && p.live !== 'off';
        if (p.mode === 'smart') {
            return el('span', { class: 'bp-ctl bp-note', text: 'Timing: compiled into Smart mod.' });
        }
        if (wantsLive) {
            if (!be.runtime || position == null) {
                return el('span', { class: 'bp-ctl bp-note', text: be.runtime
                    ? 'Timing: set it from the key itself (select the key, then open the picker).'
                    : `Timing: this key keeps its compiled default. Live per-key timing needs firmware protocol ${HOLDTAP.minProto} with flask_holdtap.` });
            }
            const val = el('output', { class: 'bp-ms', text: `${p.timing} ms` });
            const slider = el('input', { type: 'range', min: x.min, max: x.max, step: x.step, value: p.timing,
                'aria-label': `Tapping term for key ${position}`,
                'data-caption': `Tapping term for key ${position}: hold longer than this to get the hold. Applies on every layer at this key.` });
            slider.addEventListener('input', () => { p.timing = Number(slider.value); val.textContent = `${p.timing} ms`; });
            // Live key already on this position: retune in place, no reassign.
            slider.addEventListener('change', () => {
                if (current?.entryId === e.id && current.params.live && current.params.live !== 'off') {
                    be.write(position, p.timing).then((ms) => { p.timing = ms; val.textContent = `${ms} ms`; })
                        .catch((err) => setCap(`Timing not written: ${err.message}`));
                }
            });
            if (current?.entryId === e.id && !p._read) {
                p._read = true;
                be.read(position).then((ms) => { p.timing = ms; slider.value = ms; val.textContent = `${ms} ms`; }).catch(() => {});
            }
            return el('span', { class: 'bp-ctl bp-timing' }, el('label', { text: 'Tapping term' }), slider, val);
        }
        const ms = x.variants ?? [];
        if (ms.length < 2) return null;
        const names = (v) => (v < TIMING_PARAM.default ? 'Fast' : v > TIMING_PARAM.default ? 'Slow' : 'Standard');
        const wrap = el('span', { class: 'bp-ctl bp-seg', role: 'radiogroup', 'aria-label': 'Timing' }, el('label', { text: 'Timing' }));
        const near = ms.reduce((a, b) => (Math.abs(b - p.timing) < Math.abs(a - p.timing) ? b : a), ms[0]);
        for (const v of ms) {
            wrap.append(el('button', { class: 'chip' + (v === near ? ' on' : ''), role: 'radio', 'aria-checked': String(v === near),
                text: `${names(v)} · ${v} ms`, 'data-caption': `Hold longer than ${v} ms to get the hold (a variant compiled into the keymap).`,
                onclick: () => { p.timing = v; rerender(); } }));
        }
        return wrap;
    }

    function keyText(key, mods = 0) {
        return `${modsText(mods)}${capParts(encode('key', { key, mods: 0 }, adapter), adapter).main}`;
    }

    // ---- Advanced: device leftovers with metadata-driven params ----
    function advancedComposer(e) {
        const wrap = el('div', { class: 'bp-params' });
        if (adapter === 'qmk' || adapter === 'nape') {
            const input = el('input', { type: 'text', placeholder: '0x0000', size: 8, 'aria-label': 'Raw keycode (hex)',
                value: current?.entryId === 'advanced' ? '0x' + (current.params.raw >>> 0).toString(16).toUpperCase().padStart(4, '0') : '' });
            const go = el('button', { class: 'btn small primary', text: 'Assign', onclick: () => {
                const v = parseInt(input.value.replace(/^0x/i, ''), 16);
                if (!(v >= 0 && v <= 0xFFFF)) { setCap('Type a hex keycode, 0x0000–0xFFFF.'); return; }
                current = decode(v, adapter); onPick(v);
            } });
            wrap.append(el('span', { class: 'bp-ctl' }, el('label', { text: 'Keycode' }), input), go);
            return wrap;
        }
        const list = e.behaviors ?? [];
        const sel = el('select', { 'aria-label': 'Behavior' }, ...list.map((d) => el('option', { value: d.id, text: d.displayName })));
        const ps = el('span', { class: 'bp-ctl' });
        let read = () => [0, 0];
        const build = () => {
            const d = list.find((x) => x.id === Number(sel.value));
            const eds = []; const rd = [];
            for (const which of ['param1', 'param2']) {
                const ds = d?.metadata?.[0]?.[which] ?? [];
                const cs = ds.filter((x) => x.kind === 'constant');
                const rg = ds.find((x) => x.kind === 'range');
                if (cs.length) {
                    const s = el('select', {}, ...cs.map((c) => el('option', { value: c.constant, text: c.name || c.constant })));
                    eds.push(s); rd.push(() => Number(s.value));
                } else if (ds.some((x) => x.kind === 'layer_id')) {
                    const lp = entries.find((x) => x.id === 'hold-layer')?.params[0];
                    const s = el('select', {}, ...(lp?.options ?? [0]).map((id) => el('option', { value: id, text: lp?.labels?.[id] ?? id })));
                    eds.push(s); rd.push(() => Number(s.value));
                } else if (ds.some((x) => x.kind === 'hid_usage')) {
                    const s = el('select', {}, ...keySections().filter((k) => k.id !== 'shifted').flatMap((k) => k.keys)
                        .map((k) => el('option', { value: (0x07 << 16) | k.key, text: k.label })));
                    eds.push(s); rd.push(() => Number(s.value));
                } else if (rg) {
                    const s = el('input', { type: 'number', min: rg.min, max: rg.max, value: rg.min });
                    eds.push(s); rd.push(() => Number(s.value) | 0);
                } else rd.push(() => 0);
            }
            ps.replaceChildren(...eds);
            read = () => rd.map((r) => r());
        };
        sel.addEventListener('change', build);
        build();
        const go = el('button', { class: 'btn small primary', text: 'Assign', onclick: () => {
            const [p1, p2] = read();
            const b = { behaviorId: Number(sel.value), param1: p1 >>> 0, param2: p2 >>> 0 };
            const v = adapter === 'zmk-typed' ? { action: 3, ...b } : b;
            current = decode(v, adapter); onPick(v);
        } });
        wrap.append(el('span', { class: 'bp-ctl' }, el('label', { text: 'Behavior' }), sel), ps, go);
        return wrap;
    }

    render();
    setCap('');
    return {
        root,
        setValue(v) { current = v == null ? null : safeDecode(v, adapter); state.clear(); render(); },
        focus() { (host === 'docked' ? null : search)?.focus(); },
        stop() { stopCapture?.(); },
        capturing: () => !!stopCapture,
    };
}

function safeDecode(v, adapter) {
    try { return decode(v, adapter); } catch { return null; }
}

function markHoldtapDirty() {
    const be = timingBackendNow();
    if (!be.runtime) return;
    saveState.markDirty(HOLDTAP.channel, 'Hold-tap timing', () => be.save());
}

/** Text for a value on a surface (row buttons, tiles). Same words the
 * picker shows. */
export function valueLabel(value, surface) {
    const adapter = SURFACES[surface]?.adapter;
    return describeBinding(value, adapter);
}
