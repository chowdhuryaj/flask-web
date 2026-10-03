// Shared bits of the ZMK Behaviour tabs (WP4a): the picker call, typed-value
// plumbing, the click-blur guard, and app.slotSummary for WP3's slot chips.

import { openPicker, valueLabel, renderBindingCell } from './binding-picker.js?v=68';
import { usageLabel } from './zmk-keycodes.js?v=68';
import { decode, isRecursiveOutput } from './behavior-catalog.js?v=68';
export { isRecursiveOutput };
import { CH, V } from './flaskproto.js?v=68';
import { decodeComboSlotV2, decodeComboSlotV3, comboSlotV2IsEmpty } from './zmk-combos-codec.js?v=68';
import { decodeTdStep } from './zmk-tapdance-codec.js?v=68';
import { decodeLeaderSlot, decodeGestureSlot } from './zmk-output-codec.js?v=68';

/** After ANY button click inside `root`, drop focus from it. A key-generated
 * Enter or Space (a combo firing Enter, say) would otherwise re-click the
 * focused Save / Add button. Bench 2026-10-01: the board froze on press. */
export function blurClicks(root) {
    root.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
    return root;
}

/** Any codec shape ({param} for leader/gesture, {param1} elsewhere) → the
 * zmk-typed picker value, or null when empty. */
export function typedOf(o) {
    if (!o || !o.action) return null;
    return { action: o.action, param1: (o.param1 ?? o.param ?? 0) >>> 0,
        behaviorId: o.behaviorId ?? 0, param2: (o.param2 ?? 0) >>> 0 };
}

/** One-line text for a typed output ('' when none): titles, chips, labels. */
export function outText(o, surface) {
    const v = typedOf(o);
    if (!v) return '';
    try { return valueLabel(v, surface); }
    catch { return o.action === 1 ? usageLabel(v.param1) : `#${v.behaviorId}`; }
}

/** A typed output as wp3b's binding cell (hold-tap: labelled HOLD and TAP
 * parts), or null when none. The ONE place Behaviour tab cells draw a
 * binding. `text` overrides the words of a non-hold-tap cell (combos name
 * compiled devicetree macros). */
export function outCell(o, surface, text) {
    const v = typedOf(o);
    if (!v) return null;
    const cell = renderBindingCell(v, surface);
    if (text && !cell.classList.contains('ht')) cell.textContent = text;
    return cell;
}

/** Open the shared sheet picker. onPick gets a normalised typed value
 * {action, param1, behaviorId, param2} (action 0 = cleared). */
export function pickOutput({ app, surface, title, value, onPick }) {
    return openPicker({
        surface, title, app, host: 'sheet', value: typedOf(value),
        onPick: (v) => onPick({ action: v?.action ?? 0, param1: (v?.param1 ?? 0) >>> 0,
            behaviorId: v?.behaviorId ?? 0, param2: (v?.param2 ?? 0) >>> 0 }),
    });
}

// ---- app.slotSummary(entryId, slot): "types 'hello'" / "A / Esc" ----------
// The macro and tap-dance tabs register a reader over their loaded cache.
// A tab that has not loaded yet answers '' (the chip just shows no summary).
const readers = new Map();
export function registerSummary(entryId, fn) { readers.set(entryId, fn); }

export function installSlotSummary(app) {
    app.slotSummary ??= (entryId, slot) => {
        try { return readers.get(entryId)?.(slot) ?? ''; } catch { return ''; }
    };
}

// ---- cross-tab sync (WB-01 / WB-04) ---------------------------------------
// A tab that writes another channel's table (Adaptive creating a text macro,
// Modes applying a mode) announces it; the tab that owns that channel reloads
// what it cached. detail = {channel, slot?}; slot omitted = the whole table.
export const SLOTS_EVENT = 'flask:slots-changed';

export function announceSlots(channel, detail = {}) {
    document.dispatchEvent(new CustomEvent(SLOTS_EVENT, { detail: { ...detail, channel } }));
}

/** Call fn(detail) when `channel` changes behind `tab`'s back. Instances left
 * over from an earlier connection (root detached) ignore it. */
export function onSlotsChanged(channel, tab, fn) {
    // One listener per channel: a rebuilt tab replaces its predecessor's.
    listeners.get(channel) && document.removeEventListener(SLOTS_EVENT, listeners.get(channel));
    const h = (e) => {
        if (e.detail?.channel === channel && tab.root?.isConnected !== false) fn(e.detail);
    };
    listeners.set(channel, h);
    document.addEventListener(SLOTS_EVENT, h);
}
const listeners = new Map();

/** Empty slots a tab is showing as an open draft: other tabs must not hand
 * them out (the Macros "New macro" card is a slot Adaptive could also pick). */
export const draftSlots = { macro: new Set() };

// ---- per-connection constants (slot / step counts) ------------------------
// Counts never change while connected; tabs read the same ones again on
// every load and in each other's loads. Keyed by the flask client.
const dims = new WeakMap();
export async function dim(app, ch, id) {
    const flask = app.flask;
    let m = dims.get(flask);
    if (!m) dims.set(flask, m = new Map());
    const k = `${ch}:${id}`;
    if (!m.has(k)) m.set(k, flask.getU16(ch, id).catch((e) => { m.delete(k); throw e; }));
    return m.get(k);
}

// ---- is a runtime macro slot referenced anywhere? (WB-02) ------------------
/** true / false, or null when something that may hold a reference could not
 * be checked (the keymap is not loaded). `rules` are the adaptive tab's own
 * rows (skipping `skipRule`); every other table is read off the device. */
export async function macroInUse(app, slot, { rules = [], fallback = [], skipRule = -1, keymap = undefined } = {}) {
    const { flask, caps } = app;
    const hit = (o) => !!o && ((o.action === 2 && (o.param1 ?? o.param) === slot)
        || (o.action === 3 && (o.param1 ?? 0) === slot && macroBehavior(o)));
    for (const r of rules) {
        if (r.index === skipRule) continue;
        if (r.steps.some(hit)) return true;
    }
    if (fallback.some(hit)) return true;
    if (caps?.combos && caps.combosTyped) {
        const n = await dim(app, CH.combos, V.combosSlotCount);
        const keys = caps.combosKeys ? (await dim(app, CH.combos, V.combosKeys)) || 4 : 4;
        for (let i = 0; i < n; i++) {
            const r = await flask.getBytes(CH.combos, caps.combosTimed ? V.combosSlotV3 : V.combosSlotV2, [i], 1);
            const c = caps.combosTimed ? decodeComboSlotV3(r, keys) : decodeComboSlotV2(r, keys);
            if (!comboSlotV2IsEmpty(c) && hit(c)) return true;
        }
    }
    if (caps?.tapDance) {
        const n = await dim(app, CH.tapDance, V.tdSlotCount);
        const taps = (await dim(app, CH.tapDance, V.tdTaps)) || 4;
        for (let i = 0; i < n; i++) {
            for (let t = 0; t < taps; t++) {
                const d = decodeTdStep(await flask.getBytes(CH.tapDance, V.tdStep, [i, t], 2));
                if (!d.action) break;
                if (hit(d)) return true;
            }
        }
    }
    if (caps?.gestures) {
        const sets = (await dim(app, CH.gestures, V.gesturesSetCount)) || 8;
        for (let s = 0; s < sets; s++) {
            for (let d = 0; d < 8; d++) {
                if (hit(decodeGestureSlot(await flask.getBytes(CH.gestures, V.gesturesSlot, [s, d], 2)))) return true;
            }
        }
    }
    if (caps?.leader) {
        const n = await dim(app, CH.leader, V.leaderSlotCount);
        const keys = (await dim(app, CH.leader, V.leaderKeys)) || 8;
        for (let i = 0; i < n; i++) {
            if (hit(decodeLeaderSlot(await flask.getBytes(CH.leader, V.leaderSlot, [i], 1), keys))) return true;
        }
    }
    const layers = keymap === undefined ? await liveKeymapLayers() : keymap;
    if (!layers) return null;
    for (const l of layers) {
        for (const b of l.bindings ?? []) {
            try {
                const d = decode(b, 'zmk-studio');
                if (d.entryId === 'macro' && d.params.slot === slot) return true;
            } catch { /* undecodable binding: not a macro */ }
        }
    }
    return false;
}

const macroBehavior = (o) => {
    try { return decode({ action: 3, behaviorId: o.behaviorId, param1: o.param1 ?? 0, param2: 0 }, 'zmk-typed').entryId === 'macro'; }
    catch { return false; }
};

async function liveKeymapLayers() {
    try {
        const { zmkLiveKeymapTab } = await import('./zmk-keymap-tab.js?v=68');
        return zmkLiveKeymapTab()?.keymap?.layers ?? null;
    } catch { return null; }
}
