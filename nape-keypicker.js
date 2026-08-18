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

import { el } from './ui.js?v=41';
import {
    KC, QK, MOD_BITS, MOD_RIGHT, BASIC_KEYS, basicKeyName, napeKeyLabel,
    encodeModTap, encodeLayerTap, encodeMacro, decodeKeycode, modsLabel,
} from './nape-proto.js?v=41';

const custom = (n) => QK.kb + n;

const SIMPLE_GROUPS = [
    { name: 'Buttons', codes: [KC.btn1, KC.btn2, KC.btn3, KC.btn4, KC.btn5, custom(46)] },
    { name: 'Ball', codes: [KC.scrollHold, KC.scrollToggle, KC.gestureHold, custom(43)] },
    { name: 'DPI', codes: [custom(37), custom(38), custom(44), custom(47)] },
    { name: 'Polling rate', codes: [custom(39), custom(40), custom(45)] },
    { name: 'Angle snap', codes: [28, 29, 30, 31, 32, 33, 34, 35].map(custom) },
];

/**
 * @param value    current keycode
 * @param onPick   (keycode) => void
 * @param layers   layer count (for MO/TG/LT ranges)
 * @param macros   macro count (0 hides the macro group)
 */
export function buildKeycodePicker({ value, onPick, layers = 9, macros = 16 }) {
    const cur = decodeKeycode(value ?? 0);
    const root = el('div', { class: 'kp' });

    const chips = (codes) => el('div', { class: 'kp-chips' },
        ...codes.map((kc) => el('button', {
            class: 'keycap-btn' + (kc === value ? ' on' : ''),
            text: napeKeyLabel(kc),
            onclick: () => onPick(kc),
        })));

    const group = (name, body) => el('div', { class: 'kp-group' },
        el('h4', { text: name }), body);

    // --- plain key + modifiers -------------------------------------------
    const basicState = {
        base: (cur.kind === 'basic' || cur.kind === 'modTap' || cur.kind === 'layerTap')
            ? cur.base : 0,
        mods: cur.kind === 'basic' ? cur.mods : 0,
    };
    const emitBasic = () => onPick(((basicState.mods & 0x1F) << 8) | basicState.base);
    const baseSelect = (onChange, selected) => el('select', {
        class: 'kp-select',
        onchange: (e) => onChange(parseInt(e.target.value, 10)),
    }, ...BASIC_KEYS.map((k) => el('option', {
        value: String(k.kc), text: k.name, selected: k.kc === selected,
    })));

    const modBoxes = (get, set) => MOD_BITS.map((m) => el('label', { class: 'check tiny' },
        el('input', {
            type: 'checkbox', checked: !!(get() & m.bit),
            onchange: (e) => set(e.target.checked ? get() | m.bit : get() & ~m.bit),
        }),
        el('span', { text: m.name })));

    const basicRow = el('div', { class: 'kp-row' },
        baseSelect((v) => { basicState.base = v; emitBasic(); }, basicState.base),
        ...modBoxes(() => basicState.mods, (v) => { basicState.mods = v; emitBasic(); }),
        el('label', { class: 'check tiny' },
            el('input', {
                type: 'checkbox', checked: !!(basicState.mods & MOD_RIGHT),
                onchange: (e) => {
                    basicState.mods = e.target.checked
                        ? basicState.mods | MOD_RIGHT : basicState.mods & ~MOD_RIGHT;
                    emitBasic();
                },
            }),
            el('span', { text: 'Right-hand' })));

    // --- mod-tap ----------------------------------------------------------
    const mt = { mods: cur.kind === 'modTap' ? cur.mods : 0x01, base: cur.kind === 'modTap' ? cur.base : 0 };
    const emitMT = () => onPick(encodeModTap(mt.mods, mt.base));
    const mtRow = el('div', { class: 'kp-row' },
        el('span', { class: 'kp-lead', text: 'Tap' }),
        baseSelect((v) => { mt.base = v; emitMT(); }, mt.base),
        el('span', { class: 'kp-lead', text: 'Hold' }),
        ...modBoxes(() => mt.mods, (v) => { mt.mods = v; emitMT(); }),
        el('label', { class: 'check tiny' },
            el('input', {
                type: 'checkbox', checked: !!(mt.mods & MOD_RIGHT),
                onchange: (e) => {
                    mt.mods = e.target.checked ? mt.mods | MOD_RIGHT : mt.mods & ~MOD_RIGHT;
                    emitMT();
                },
            }),
            el('span', { text: 'Right-hand' })));

    // --- layer-tap --------------------------------------------------------
    const lt = { layer: cur.kind === 'layerTap' ? cur.layer : 1, base: cur.kind === 'layerTap' ? cur.base : 0 };
    const emitLT = () => onPick(encodeLayerTap(lt.layer, lt.base));
    const ltRow = el('div', { class: 'kp-row' },
        el('span', { class: 'kp-lead', text: 'Tap' }),
        baseSelect((v) => { lt.base = v; emitLT(); }, lt.base),
        el('span', { class: 'kp-lead', text: 'Hold layer' }),
        el('select', {
            class: 'kp-select',
            onchange: (e) => { lt.layer = parseInt(e.target.value, 10); emitLT(); },
        }, ...Array.from({ length: layers }, (_, i) => el('option', {
            value: String(i), text: `L${i}`, selected: i === lt.layer,
        }))));

    root.append(
        el('p', { class: 'kp-current' },
            el('span', { class: 'kp-current-label', text: 'This key sends' }),
            el('strong', { text: napeKeyLabel(value ?? 0) })),
        ...SIMPLE_GROUPS.map((g) => group(g.name, chips(g.codes))),
        group('Key', basicRow),
        group('Tap / hold — modifier', mtRow),
        group('Tap / hold — layer', ltRow),
        group('Layers', chips([
            ...Array.from({ length: layers }, (_, i) => QK.mo + i),
            ...Array.from({ length: layers }, (_, i) => QK.tg + i),
        ])),
    );
    if (macros) {
        root.append(group('Macros', chips(
            Array.from({ length: macros }, (_, i) => encodeMacro(i)))));
    }
    root.append(group('Other', chips([KC.tapHold, KC.none])));
    return root;
}

export { napeKeyLabel, modsLabel, basicKeyName };
