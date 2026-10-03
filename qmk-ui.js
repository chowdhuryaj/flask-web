// Shared bits for the Svalboard (QMK line) tabs, drawn with the os-keys
// shell's own pieces (ui.js card / row / btn / modal). Replaces the deleted
// tiles.js + picker.js without their tile styling.
//
// PHASE A STAND-IN: QMK keycodes (u16) show as names for the basic HID range
// (plus Ctrl/Shift/Alt/GUI wraps) and hex otherwise, and are picked by typing
// a name or a hex value. Phase B threads a 'qmk' adapter through
// behavior-catalog / binding-picker / keycodes.js and replaces kcText,
// kcCell and pickKeycode with the real picker surfaces (qmk.key,
// qmk.comboOutput, qmk.tapDanceStep, qmk.keyOverride, qmk.cornerChord,
// qmk.macroKey, qmk.leaderKey, qmk.cskBase, qmk.cskShifted).

import { el, toast, modal } from './ui.js?v=76';
import { basicKeys, navKeys, fKeys, numpadKeys, intlKeys, shiftedSymbols } from './keycodes.js?v=76';

export const KC_TRNS = 0x0001;

const BY_CODE = new Map();
const BY_NAME = new Map();
for (const k of [...basicKeys, ...navKeys, ...fKeys, ...numpadKeys, ...intlKeys, ...shiftedSymbols]) {
    if (!BY_CODE.has(k.code)) BY_CODE.set(k.code, k);
    for (const n of [k.label, k.cap]) if (n && !BY_NAME.has(n.toLowerCase())) BY_NAME.set(n.toLowerCase(), k.code);
}
BY_NAME.set('trns', KC_TRNS).set('transparent', KC_TRNS).set('▽', KC_TRNS);
BY_NAME.set('none', 0).set('no', 0);

// QMK mod wrappers: 0x0100 Ctrl, 0x0200 Shift, 0x0400 Alt, 0x0800 GUI, 0x1000 = right-hand.
const MOD_GLYPHS = [[0x0100, '⌃'], [0x0200, '⇧'], [0x0400, '⌥'], [0x0800, '⌘']];

/** Short text for a QMK keycode ('' when unset). */
export function kcText(kc) {
    if (!kc) return '';
    if (kc === KC_TRNS) return '▽';
    const hex = `0x${kc.toString(16).padStart(4, '0')}`;
    if (BY_CODE.has(kc)) return BY_CODE.get(kc).cap;
    if (kc < 0x2000) {
        const base = BY_CODE.get(kc & 0xFF)?.cap;
        if (!base) return hex;
        const mods = MOD_GLYPHS.filter(([bit]) => kc & bit).map(([, g]) => g).join('');
        return `${kc & 0x1000 ? 'R' : ''}${mods}${base}`;
    }
    return hex;
}

/** Long text for titles: name plus the raw value. */
export function kcTitle(kc) {
    if (!kc) return 'empty';
    const k = BY_CODE.get(kc);
    return `${k ? k.label : kcText(kc)} (0x${kc.toString(16).padStart(4, '0')})`;
}

/** Parse what pickKeycode accepts: '0x2a', '42', a key name ('A', 'Esc',
 * 'Backspace'), or a name with mod prefixes 'C-', 'S-', 'A-', 'G-'. Returns
 * a u16 or null. */
export function parseKeycode(text) {
    let t = String(text ?? '').trim();
    if (!t) return 0;
    if (/^0x[0-9a-f]{1,4}$/i.test(t)) return parseInt(t.slice(2), 16);
    if (/^[0-9]+$/.test(t) && t.length > 1) { const n = Number(t); return n <= 0xFFFF ? n : null; }
    let mods = 0;
    const MOD = { c: 0x0100, s: 0x0200, a: 0x0400, g: 0x0800 };
    while (/^[csag]-./i.test(t)) { mods |= MOD[t[0].toLowerCase()]; t = t.slice(2); }
    const code = BY_NAME.get(t.toLowerCase());
    if (code == null) return null;
    return mods ? (mods | (code & 0xFF)) : code;
}

/** Small clickable keycode cell. */
export function kcCell(kc, onClick, title) {
    return el('button', {
        class: 'btn small mono', type: 'button', title: title ?? kcTitle(kc),
        text: kc ? kcText(kc) : '·', onclick: onClick,
    });
}

/** Keycode entry sheet (Phase A stand-in for the QMK picker surfaces).
 * onPick(kc) gets a u16; Clear picks 0. */
export function pickKeycode({ title = 'Pick a key', value = 0, onPick }) {
    const input = el('input', {
        type: 'text', value: value ? (BY_CODE.get(value)?.label ?? `0x${value.toString(16).padStart(4, '0')}`) : '',
        placeholder: 'A, Esc, Backspace, C-A, 0x2A', style: 'width:100%',
    });
    const out = el('div', { class: 'note faint' });
    const show = () => {
        const kc = parseKeycode(input.value);
        out.textContent = kc == null ? 'Not a key name or hex value' : kc ? `→ ${kcTitle(kc)}` : 'empty';
    };
    input.addEventListener('input', show);
    let back;
    const commit = async (kc) => {
        if (kc == null) { toast('Not a key name or hex value (try 0x2A)', true); return; }
        back.remove();
        await onPick(kc);
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit(parseKeycode(input.value));
        else if (e.key === 'Escape') back.remove();
    });
    back = modal(title, el('div', {}, input, out,
        el('div', { class: 'note faint', text: 'Type a key name or a raw QMK keycode. The full key picker for the Svalboard comes with the keymap editor.' })), [
        el('button', { class: 'btn', text: 'Cancel', onclick: () => back.remove() }),
        el('button', { class: 'btn', text: 'Clear', onclick: () => commit(0) }),
        el('button', { class: 'btn primary', text: 'Set', onclick: () => commit(parseKeycode(input.value)) }),
    ]);
    show();
    input.focus();
    return back;
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

/** One slot as a row: name, summary, Edit. */
export function slotRow({ name, sub = '', empty = false, onEdit }) {
    return el('div', { class: 'row', style: empty ? 'opacity:0.6' : '' },
        el('span', { class: 'lbl' }, el('b', { text: name }), el('span', { class: 'hint', text: sub || 'empty' })),
        el('span', { style: 'flex:1' }),
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
