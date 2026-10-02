// Shared bits for the QMK/Nape Behaviour tabs (WP4b): tile grid, sheet
// editor, paste-to-selected-key, and the slot-summary registry that feeds
// the picker's "M3 · types 'hello'" chips (app.slotSummary).

import { el, toast, modal } from './ui.js?v=49';
import { board } from './board.js?v=1';

/** Announce a live write so the nearest card's reload bar registers its
 * channel with the status-bar Save (see ui.js reloadBar). */
export const announceEdit = (node) => node?.dispatchEvent(new CustomEvent('flask-edit', { bubbles: true }));

/** Paste a keycode onto the key selected on the board (no auto-advance: a
 * slot is a one-off, not a typing run). */
export async function pasteToKey(kc) {
    if (!board.selectedKey()) { toast('Click a key on the board first'); return false; }
    return board.assign(kc, { advance: false });
}

/** One clickable tile: click = onPaste, pencil = onEdit. */
export function tile({ name, sub = '', empty = false, caption, onPaste, onEdit }) {
    const t = el('div', {
        class: 'tile' + (empty ? ' empty' : ''), role: 'button', tabindex: 0,
        title: caption, 'data-caption': caption,
    },
    el('span', { class: 'tile-name', text: name }),
    el('span', { class: 'tile-sub', text: sub }),
    el('button', {
        class: 'tile-edit', text: '✎', title: `Edit ${name}`, 'aria-label': `Edit ${name}`,
        onclick: (e) => { e.stopPropagation(); onEdit(); },
    }));
    t.addEventListener('click', () => onPaste());
    t.addEventListener('keydown', (e) => {
        if (e.target === t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPaste(); }
    });
    return t;
}

/** Reload row for screens whose writes are persistent at once (no Save). */
export function reloadRow(reload, note) {
    const btn = el('button', { class: 'btn small', text: 'Reload from device' });
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await reload(); toast('Reloaded from device'); }
        catch (e) { toast(`Reload failed: ${e.message}`, true); }
        btn.disabled = false;
    });
    return el('div', { class: 'savebar' }, btn, note ? el('span', { class: 'note', text: note }) : null);
}

export const tileGrid = (...tiles) => el('div', { class: 'tile-grid' }, ...tiles);

/**
 * Sheet editor. render(api) returns the body nodes; buttons(api) the footer.
 * api = { refresh(), close(), el }. Escape closes only the topmost sheet, so
 * a picker opened from a sheet takes its own Escape first.
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
    api.el.firstElementChild.classList.add('sheet');
    document.addEventListener('keydown', onKey);
    api.refresh();
    return api;
}

/** Register summary(slotIndex) → text for a catalog entry id ('macro',
 * 'tap-dance'). One app.slotSummary routes to all registered tabs. */
export function addSummary(app, entryId, fn) {
    (app._summaries ??= {})[entryId] = fn;
    app.slotSummary ??= (id, i) => app._summaries[id]?.(i) ?? '';
}
