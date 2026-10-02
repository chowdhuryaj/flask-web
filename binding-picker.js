// BindingPicker: the one picker every surface opens (spec §4.5–4.7).
//
// WP0 STUB. The contract below is final for Phase 1; the body wraps today's
// pickers (picker.js buildPicker, zmk-picker-legacy.js buildZmkPicker,
// nape-keypicker.js buildKeycodePicker). WP3 replaces the body with the
// catalog-driven picker and keeps these exports and argument shapes.
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
import { buildPicker } from './picker.js?v=49';
import { buildZmkPicker } from './zmk-picker-legacy.js?v=1';
import { buildKeycodePicker } from './nape-keypicker.js?v=49';
import { zmkBehaviors } from './zmk-keycodes.js?v=49';

/**
 * Every surface a picker can serve (spec §4.7). `hide` lists catalog group
 * ids or entry ids (behavior-catalog.js) the surface cannot store; WP3
 * enforces it, the stub ignores it. Callers pass the key, e.g.
 * `openPicker({ surface: 'zmk.comboOutput', … })`.
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
 *        sheet:   modal titled `title`, closes on pick or a backdrop click
 * @param {Element} [o.anchor]
 * @param {string}  [o.title]      sheet title, e.g. "Combo 3 output"
 * @param {object}  [o.app]        the app object; supplies layerCount
 * @param {(value:*) => void} o.onPick  called with an adapter-typed value
 * @returns {() => void} close()   idempotent
 */
export function openPicker({ surface, value = null, host = 'sheet', anchor, title, app, onPick }) {
    const spec = SURFACES[surface];
    if (!spec) throw new Error(`openPicker: unknown surface ${surface}`);
    let closed = false;
    let dispose = () => {};
    const close = () => { if (!closed) { closed = true; dispose(); } };
    const pick = (v) => { if (host !== 'docked') close(); onPick(v); };
    const body = legacyPicker(spec.adapter, value, app, pick);

    if (host === 'docked') {
        if (!anchor) throw new Error('openPicker: docked host needs an anchor container');
        anchor.append(body);
        dispose = () => body.remove();
    } else if (host === 'popover') {
        const r = anchor?.getBoundingClientRect() ?? { left: 16, bottom: 16 };
        const pop = el('div', { class: 'picker-popover', role: 'dialog' }, body);
        pop.style.cssText = 'position:fixed; z-index:50; width:420px; max-height:360px; overflow:auto;'
            + ` left:${Math.max(8, Math.min(r.left, innerWidth - 428))}px;`
            + ` top:${Math.max(8, Math.min(r.bottom + 4, innerHeight - 368))}px;`
            + ' background:var(--surface); border:1px solid var(--border2); border-radius:12px; padding:10px;';
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        const onDown = (e) => { if (!pop.contains(e.target) && !anchor?.contains(e.target)) close(); };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown, true);
        document.body.append(pop);
        dispose = () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDown, true);
            pop.remove();
        };
    } else {
        const back = el('div', { class: 'modal-back' });
        back.append(el('div', { class: 'modal' }, el('h2', { text: title ?? 'Pick a binding' }), body));
        back.addEventListener('click', (e) => { if (e.target === back) close(); });
        document.body.append(back);
        dispose = () => back.remove();
    }
    return close;
}

// ---- WP0 stub body: today's pickers, unchanged ----

function legacyPicker(adapter, value, app, pick) {
    const layerCount = app?.layerCount ?? 16;
    if (adapter === 'qmk') return buildPicker({ layerCount, onPick: pick });
    if (adapter === 'nape') return buildKeycodePicker({ value, onPick: pick });
    const keyPressId = keyPressIdOf();
    if (adapter === 'zmk-studio') return buildZmkPicker({ keyPressId, onPick: pick });
    // zmk-typed: today's slot modals embed the Studio picker; convert its
    // binding into the slot vocabulary the same way they do.
    return buildZmkPicker({ keyPressId, onPick: (b) => pick(typedFromStudio(b, keyPressId)) });
}

function keyPressIdOf() {
    for (const [id, d] of zmkBehaviors()) if (d.displayName === 'Key Press') return id;
    return null;
}

/** Studio binding → typed slot value (usage / macro / behavior). */
export function typedFromStudio(b, keyPressId = keyPressIdOf()) {
    if (b.behaviorId === keyPressId) return { action: 1, param1: b.param1 >>> 0 };
    if (zmkBehaviors().get(b.behaviorId)?.displayName === 'Flask Macro') return { action: 2, param1: b.param1 >>> 0 };
    return { action: 3, behaviorId: b.behaviorId, param1: b.param1 >>> 0, param2: b.param2 >>> 0 };
}
