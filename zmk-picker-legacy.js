// Legacy ZMK picker entry point, kept so zmk-keymap-tab / zmk-combos-tab /
// zmk-tapdance-tab keep working until WP2/WP4a call openPicker directly.
// The picker is binding-picker.js (surface 'zmk.key'). WP7 deletes this file.

import { buildPickerBody } from './binding-picker.js?v=1';

export function buildZmkPicker({ onPick, value = null, app, position }) {
    return buildPickerBody({ surface: 'zmk.key', value, app, position, host: 'docked', onPick }).root;
}
