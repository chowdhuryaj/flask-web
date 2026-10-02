// Shared bits of the ZMK Behaviour tabs (WP4a): the picker call, typed-value
// plumbing, the click-blur guard, and app.slotSummary for WP3's slot chips.

import { openPicker, valueLabel, renderBindingCell } from './binding-picker.js?v=62';
import { usageLabel } from './zmk-keycodes.js?v=62';

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
