// QMK picker helpers for the slot-grid tabs (kcCell, makePickerHost) and
// the legacy buildPicker entry point. The picker itself is binding-picker.js.

import { el, toast } from './ui.js?v=49';
import { describe, capLabel } from './keycodes.js?v=49';
import { buildPickerBody } from './binding-picker.js?v=1';

/**
 * Legacy entry point (keymap-tab, makePickerHost): the catalog picker for
 * surface 'qmk.key', docked. onPick(keycode) is called when the user
 * chooses. New code calls binding-picker.js openPicker instead.
 */
export function buildPicker({ layerCount, onPick, surface = 'qmk.key', value = null }) {
    return buildPickerBody({ surface, value, app: { layerCount }, host: 'docked', onPick }).root;
}

export { describe };

/** Small keycode cell button — shared by every slot-grid tab. */
export function kcCell(kc, onClick, title) {
    return el('button', {
        class: 'code', title: title ?? describe(kc),
        text: kc ? capLabel(kc) : '·',
        onclick: onClick,
    });
}

/**
 * One hidden picker card shared by all slots in a tab (typing-tab pattern).
 * request(onSet) shows the card and routes the next pick; restrict(kc) can
 * veto (with note toasted) — used by gestures/chords whose slots fire via
 * tap_code16 (basic keycodes + C()/S()/A()/G() combos only).
 */
export function makePickerHost({ layerCount, restrict, note }) {
    let target = null;
    const card = el('div', { class: 'card' },
        el('h3', { text: 'Assign keycode' },
            el('span', { class: 'sub', text: 'click a slot above, then pick' })));
    card.append(buildPicker({
        layerCount,
        onPick: async (kc) => {
            if (!target) return;
            if (restrict && !restrict(kc)) {
                toast(note || 'That keycode is not allowed in this slot', true);
                return;
            }
            const t = target;
            target = null;
            card.style.display = 'none';
            await t(kc);
        },
    }));
    card.style.display = 'none';
    return {
        card,
        request(onSet) {
            target = onSet;
            card.style.display = '';
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
        cancel() { target = null; card.style.display = 'none'; },
    };
}
