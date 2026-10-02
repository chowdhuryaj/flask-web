// Keychron Nape Pro — the one keycode picker.
//
// Used by the keymap, tap-holds and combos so the vocabulary never diverges
// between surfaces. Emits a plain u16 QMK keycode; every caller stores that
// verbatim, because the device's keymap, tap-hold table and combo slots all
// speak the same keycode space.
//
// The tap-hold composers here are the real thing: MT() and LT() are keycodes,
// so they go on ANY key of ANY layer with ANY tap key — unlike CUSTOM(41),
// which needs a matching entry in the per-(layer,column) tap-hold table.

import { buildPickerBody } from './binding-picker.js?v=1';
import { napeKeyLabel, modsLabel, basicKeyName } from './nape-proto.js?v=49';

/**
 * Nape adapter entry point (surface 'nape.key'): the catalog picker with
 * Nape's keycode space. Emits a plain u16 keycode.
 * @param value    current keycode
 * @param onPick   (keycode) => void
 * @param layers   layer count (for MO/TG/LT ranges)
 * @param macros   macro count (0 hides the macro entry)
 */
export function buildKeycodePicker({ value, onPick, layers = 9, macros = 16 }) {
    const root = buildPickerBody({ surface: 'nape.key', value, host: 'docked', onPick,
        app: { family: 'nape', layerCount: layers, macroCount: macros } }).root;
    root.classList.add('kp');
    return root;
}

export { napeKeyLabel, modsLabel, basicKeyName };
