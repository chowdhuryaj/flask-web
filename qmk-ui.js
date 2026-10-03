// Shared bits for the Svalboard (QMK line) tabs, drawn with the os-keys
// shell's own pieces (ui.js card / row / btn / modal). Replaces the deleted
// tiles.js + picker.js without their tile styling. Keycodes are shown and
// picked through the one picker (binding-picker.js, 'qmk' adapter): the
// surfaces are qmk.key, qmk.comboOutput, qmk.tapDanceStep, qmk.keyOverride,
// qmk.cornerChord, qmk.macroKey, qmk.leaderKey, qmk.cskBase, qmk.cskShifted.

import { el, toast, modal } from './ui.js?v=76';
import { openPicker, renderBindingCell } from './binding-picker.js?v=76';
import { describeBinding } from './behavior-catalog.js?v=76';
import { board } from './board.js?v=76';
import { registerSummary, installSlotSummary } from './zmk-behaviour-common.js?v=76';
import { isQmkFamily } from './boards.js?v=76';

/** One-line text for a keycode ('' when unset), the picker's words. */
export const bindingText = (kc) => (kc ? describeBinding(kc, 'qmk') : '');

/** Small clickable keycode cell; a mod-tap / layer-tap shows HOLD and TAP. */
export function bindingCell(kc, onClick, title) {
    const b = el('button', { class: 'btn small mono', type: 'button', title: title ?? (bindingText(kc) || 'empty'), onclick: onClick });
    b.append(kc ? renderBindingCell(kc, 'qmk') : '·');
    return b;
}

/** Open the picker as a sheet on a QMK surface; onPick gets a u16. */
export function pickKey(app, surface, value, title, onPick) {
    return openPicker({ surface, value: value || null, host: 'sheet', title, app, onPick });
}

/** Paste a keycode (M n, TD(n)) onto the key selected on the board, no
 * auto-advance (a slot is a one-off, not a typing run). */
export async function pasteToKey(kc) {
    if (!board.selectedKey()) { toast('Select a key on the board first'); return false; }
    return board.assign(kc, { advance: false });
}

/** Register summary(slot) → text for a catalog entry id ('macro',
 * 'tap-dance'): the picker's slot chips read app.slotSummary. One registry
 * with the ZMK tabs (zmk-behaviour-common.js); a Svalboard reader goes quiet
 * once another board connects, until that board's tab registers its own. */
export function addSummary(app, entryId, fn) {
    registerSummary(entryId, (i) => (isQmkFamily(app.family) ? fn(i) : ''));
    installSlotSummary(app);
}

/** Announce a live write so the nearest card's reload bar registers its
 * channel with the top-bar Save (see ui.js reloadBar). */
export const announceEdit = (node) => node?.dispatchEvent(new CustomEvent('flask-edit', { bubbles: true }));

/** Reload row for screens whose writes persist at once (Vial: no Save). */
export function reloadRow(reload, note) {
    const btn = el('button', { class: 'btn small', text: 'Reload from device' });
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await reload(); toast('Reloaded from device'); }
        catch (e) { toast(`Reload failed: ${e.message}`, true); }
        btn.disabled = false;
    });
    return el('div', { class: 'savebar' }, btn, el('span', { class: 'state', text: 'Applied live' }),
        note ? el('span', { class: 'note', text: note }) : null);
}

/** One slot as a row: name, summary, Edit, and (keymap slots) Paste onto
 * the selected key. */
export function slotRow({ name, sub = '', empty = false, onEdit, onPaste }) {
    return el('div', { class: 'row' + (empty ? ' faint' : ''), 'data-slot': name },
        el('span', { class: 'lbl' }, el('b', { text: name }), el('span', { class: 'hint', text: sub || 'empty' })),
        el('span', { style: 'flex:1' }),
        onPaste ? el('button', { class: 'btn small', text: 'Paste on key', 'data-paste': name,
            title: `Put ${name} on the key selected on the board`, onclick: onPaste }) : null,
        el('button', { class: 'btn small', text: 'Edit', title: `Edit ${name}`, onclick: onEdit }));
}

/**
 * Sheet editor. render(api) returns the body nodes; buttons(api) the footer.
 * api = { refresh(), close(), el }. Escape closes only the topmost sheet.
 */
export function openSheet(title, render, buttons) {
    const body = el('div', { class: 'sheet-body' });
    const api = {
        el: null,
        refresh() { body.replaceChildren(...[].concat(render(api)).filter(Boolean)); },
        close() { api.el.remove(); document.removeEventListener('keydown', onKey); },
    };
    const onKey = (e) => {
        if (!api.el.isConnected) { document.removeEventListener('keydown', onKey); return; }
        if (e.key === 'Escape' && [...document.querySelectorAll('.modal-back')].at(-1) === api.el) api.close();
    };
    api.el = modal(title, body, buttons ? buttons(api) : [el('button', { class: 'btn', text: 'Done', onclick: () => api.close() })]);
    document.addEventListener('keydown', onKey);
    api.refresh();
    return api;
}

/** Layer options for selects, named from the profile. */
export const layerOptions = (app) => Array.from({ length: app.layerCount || 16 }, (_, i) =>
    ({ value: i, label: app.profile?.layerNames?.[i] ?? `Layer ${i}` }));
