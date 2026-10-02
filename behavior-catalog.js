// Behavior catalog: every assignable thing as one plain-language entry with
// parameters (spec §4.3–4.4). Device behaviors and QMK keycodes map onto
// entries; variants (timing, smart mode, live hold-tap) become parameters.
//
// Four adapters speak the same entries (binding-picker.js SURFACES):
//   'qmk'        number, a QMK u16 keycode
//   'zmk-studio' {behaviorId, param1, param2}, a Studio binding
//   'zmk-typed'  {action, param1, behaviorId?, param2?} slot vocabulary
//                (0 none · 1 usage · 2 macro slot · 3 behavior)
//   'nape'       number, a Nape u16 keycode
//
// Param value spaces are shared where the firmware allows it:
//   key    HID keyboard usage id (0x04…0xE7), the same number QMK uses for
//          basic keycodes. A ZMK usage on another page keeps its page:
//          (page << 16) | id.
//   mods   8-bit mask, ZMK layout: L ⌃⇧⌥⌘ = 0x01 0x02 0x04 0x08, R = << 4.
//          QMK/Nape store 5 bits (4 mods + a right-hand flag); mixing left
//          and right there keeps the right-hand set.
//   layer  QMK/Nape: layer index. ZMK: the stable Studio layer id.
//   slot   macro / tap-dance slot index.
//   code   an adapter-specific code from the entry's option list (media,
//          mouse, lighting, device keys).
//   timing ms (TIMING_PARAM). ZMK only; QMK uses the global tapping term.

import {
    capLabel, describe, lookup, R, mediaKeys, mouseKeys, rgbKeys, deviceCustoms, macroKeys,
    basicKeys, navKeys, fKeys, numpadKeys, intlKeys, shiftedSymbols,
} from './keycodes.js?v=49';
import {
    zmkBehaviors, zmkLayers, layerName, usageCap, usageLabel, usageParts, consumerUsages,
    kpParam, HID_PAGE_KEYBOARD, HID_PAGE_CONSUMER,
} from './zmk-keycodes.js?v=49';
import { napeKeyLabel, napeKeycodeGroups, KC as NKC, QK as NQK } from './nape-proto.js?v=49';
import { isZmkFamily } from './zmk.js?v=51';

/** Picker groups, in display order (§4.5). Entry.group is one of these ids. */
export const CATALOG_GROUPS = [
    { id: 'keys', label: 'Keys' },
    { id: 'modifiers', label: 'Modifiers' },
    { id: 'layers', label: 'Layers' },
    { id: 'mouse', label: 'Mouse' },
    { id: 'media', label: 'Media & System' },
    { id: 'run', label: 'Run' },
    { id: 'advanced', label: 'Advanced' },
];

/**
 * @typedef {object} CatalogParam
 * @property {string} key      'hold' | 'tap' | 'key' | 'mods' | 'layer' | 'slot' | 'code' | 'timing' | 'mode' | 'live' | …
 * @property {'mods'|'key'|'layer'|'slot'|'choice'|'ms'|'num'} kind
 * @property {(string|number)[]} [options]      kind 'choice'
 * @property {Record<string,string>} [labels]   kind 'choice'
 * @property {number} [min] @property {number} [max] @property {number} [step]  kind 'ms' | 'num' | 'slot'
 * @property {*} [default]
 *
 * @typedef {object} CatalogEntry
 * @property {string} id       stable, app-side ('mod-tap', 'hold-layer', …)
 * @property {string} group    a CATALOG_GROUPS id; exactly one
 * @property {string} name     plain language ('Mod-tap')
 * @property {string} desc     one line ('Hold for a modifier, tap for a key.')
 * @property {CatalogParam[]} params
 * @property {{match: {name: string, set: object}[], shape?: object}} [zmk]
 * @property {{params: string[]}} [qmk]
 *
 * catalogFor() returns entries resolved for one device: params narrowed to
 * that adapter and device (options, ranges), plus
 * @property {{behaviorId: number, name: string, set: object}[]} [device]  ZMK behaviors absorbed
 * @property {string} [rides]  'key' when the entry has no behavior of its own (Media key rides Key Press)
 *
 * @typedef {{entryId: string, params: object}} Decoded
 */

/**
 * Hold-tap timing parameter (AJ Q4, 2026-10-01): a per-key ms value on a
 * slider, 50–1000. Mod-tap and Layer-tap carry it as
 * `{ ...TIMING_PARAM }`. On QMK it is replaced by the global tapping term.
 * @type {CatalogParam}
 */
export const TIMING_PARAM = { key: 'timing', kind: 'ms', min: 50, max: 1000, step: 10, default: 200 };

// ---------------------------------------------------------------------------
// AJ-Q4 timing seam.
//
// A backend maps (entryId, ms, variants, ctx) → {behaviorId, ms, exact, write?}
//   variants: [{behaviorId, ms, live?, side?}] compiled on this device for
//             the entry, already narrowed to the kind encode() wants (live
//             hold-taps, or the compiled timing variants)
//   exact:    true when the device will run exactly `ms`
//   write:    (position) => Promise<appliedMs>, runtime backends only: puts
//             `ms` into that key position's runtime slot
// The default backend lands on the nearest compiled variant ("Mod-Tap (fast
// 150)", "Mod-Tap" = 200, "Mod-Tap (slow 300)"). The runtime backend
// (flask_holdtap, Flask channel 0x2A, ZMK proto v17) replaces it through
// setTimingBackend; attachHoldtap(app) does that when the device answers.

const defaultBackend = (entryId, ms, variants) => {
    const v = nearestVariant(ms, variants);
    return v && { behaviorId: v.behaviorId, ms: v.ms, exact: v.ms === ms };
};
let timingBackend = defaultBackend;

/** AJ-Q4 runtime holdtap: swap the timing backend (returns the old one). */
export function setTimingBackend(fn) { const old = timingBackend; timingBackend = fn ?? defaultBackend; return old; }

/** The backend in use. A runtime backend carries `.runtime === true` and
 * `.read(position)`, `.write(position, ms)`, `.reset(position)`, `.save()`. */
export function timingBackendNow() { return timingBackend; }

/** Resolve a timing value for an entry on this device. See the seam above. */
export function resolveTiming(entryId, ms, variants, ctx = {}) { return timingBackend(entryId, ms, variants, ctx); }

/** Nearest compiled variant by |ms − variant.ms|; a tie goes to the longer
 * one (a too-long term only delays a hold, a too-short one misfires holds). */
export function nearestVariant(ms, variants) {
    let best = null;
    for (const v of variants) {
        const d = Math.abs((v.ms ?? TIMING_PARAM.default) - ms);
        const bd = best && Math.abs((best.ms ?? TIMING_PARAM.default) - ms);
        if (!best || d < bd || (d === bd && (v.ms ?? 0) > (best.ms ?? 0))) best = v;
    }
    return best;
}

/** flask_holdtap wire constants (.workflow/scratch/flask-holdtap-contract.md). */
export const HOLDTAP = { channel: 0x2A, slotCount: 0x01, slot: 0x50, def: 0x51, info: 0x52, minProto: 17,
    FLAVORS: ['hold-preferred', 'balanced', 'tap-preferred', 'tap-unless-interrupted'] };

const decodeSlot = (b) => ({
    slot: b[0], term: (b[1] << 8) | b[2], quick: (b[3] << 8) | b[4], idle: (b[5] << 8) | b[6],
    flavor: b[7], custom: !!(b[8] & 1),
});
const encodeSlot = (s, term) => [s.slot, term >> 8, term & 0xFF, s.quick >> 8, s.quick & 0xFF,
    s.idle >> 8, s.idle & 0xFF, s.flavor, 0];

/**
 * Runtime backend over a FlaskProto-shaped client (getU16, getBytes,
 * setBytes, save). Live hold-taps run the slider value exactly at their key
 * position; anything else falls back to the nearest compiled variant.
 * `onDirty()` is called after every SET (the caller registers the Save).
 */
export function holdtapBackend(flask, { slotCount = 255, onDirty } = {}) {
    const cache = new Map();   // position → decoded slot
    const read = async (position) => {
        const s = decodeSlot(await flask.getBytes(HOLDTAP.channel, HOLDTAP.slot, [position], 1));
        cache.set(position, s);
        return s;
    };
    const write = async (position, ms) => {
        if (!(position >= 0 && position < slotCount)) throw new Error(`no hold-tap slot ${position}`);   // key positions and virtual slots alike
        const cur = cache.get(position) ?? await read(position);
        const term = Math.max(TIMING_PARAM.min, Math.min(TIMING_PARAM.max, Math.round(ms)));
        const echo = decodeSlot(await flask.setBytes(HOLDTAP.channel, HOLDTAP.slot, encodeSlot(cur, term), 1));
        cache.set(position, echo);   // adopt the applied values (clamp echo)
        onDirty?.();
        return echo.term;
    };
    const reset = async (position) => {
        const echo = decodeSlot(await flask.setBytes(HOLDTAP.channel, HOLDTAP.slot, [position, 0, 0], 1));
        cache.set(position, echo);
        onDirty?.();
        return echo.term;
    };
    const fn = (entryId, ms, variants, ctx) => {
        const live = variants.filter((v) => v.live);
        if (!live.length) return defaultBackend(entryId, ms, variants, ctx);
        const v = live.find((x) => x.side === ctx?.side) ?? live[0];
        return { behaviorId: v.behaviorId, ms, exact: true, write: (position) => write(position, ms) };
    };
    /** 0x52 SLOT_INFO → {slot, kind: 'key'|'virtual', keyPos, name}. */
    const slotInfo = async (slot) => {
        const b = await flask.getBytes(HOLDTAP.channel, HOLDTAP.info, [slot], 1);
        const name = String.fromCharCode(...b.slice(3, 29).filter((c) => c)).trim();
        return { slot: b[0], kind: b[1] === 1 ? 'virtual' : 'key', keyPos: b[1] === 1 ? null : b[2], name };
    };
    /** Every slot, key positions then virtual ones (WP4a: virtual sliders
     * labelled by name in the combo / behavior context). */
    const slots = async () => {
        const out = [];
        for (let i = 0; i < slotCount; i++) out.push(await slotInfo(i));
        return out;
    };
    return Object.assign(fn, {
        runtime: true, slotCount, read: async (p) => (await read(p)).term, readSlot: read, write, reset, slotInfo, slots,
        save: () => flask.save(HOLDTAP.channel),
    });
}

/**
 * Probe the connected ZMK device for flask_holdtap and install the runtime
 * backend when proto ≥ 17 and channel 0x2A answers; otherwise install the
 * nearest-variant default. Resolves to the runtime backend or null. Safe to
 * call repeatedly (memoized per flask client).
 */
const probes = new WeakMap();
let onDirtyHook = null;
export function attachHoldtap(app, { onDirty } = {}) {
    const flask = app?.flask;
    if (!flask || !((app.protocolVersion ?? 0) >= HOLDTAP.minProto)) {
        setTimingBackend(defaultBackend);
        return Promise.resolve(null);
    }
    if (!probes.has(flask)) {
        probes.set(flask, (async () => {
            try {
                const count = await flask.getU16(HOLDTAP.channel, HOLDTAP.slotCount);
                if (!count) return null;
                return holdtapBackend(flask, { slotCount: count, onDirty: () => onDirtyHook?.() });
            } catch { return null; }   // 0xFF echo: module not compiled in
        })());
    }
    if (onDirty) onDirtyHook = onDirty;
    return probes.get(flask).then((b) => { setTimingBackend(b ?? defaultBackend); return b; });
}

// ---------------------------------------------------------------------------
// Entries (§4.4). `zmk.match` names are absorbed by exact displayName; the
// regex rules in classifyZmk() catch renamed variants by shape.

const MODE_PARAM = { key: 'mode', kind: 'choice', options: ['plain', 'smart'], default: 'plain',
    labels: { plain: 'Plain', smart: 'Smart (hold only after a pause)' } };
const LIVE_PARAM = { key: 'live', kind: 'choice', options: ['off', 'any', 'left', 'right'], default: 'off',
    labels: { off: 'Compiled timing', any: 'Live · any key', left: 'Live · left-hand rule', right: 'Live · right-hand rule' } };

const E = (id, group, name, desc, params = [], zmkNames = [], extra = {}) => ({
    id, group, name, desc, params,
    zmk: { match: zmkNames.map((n) => (typeof n === 'string' ? { name: n, set: {} } : n)) },
    ...extra,
});

/** The static table, in group order. catalogFor() narrows it per device. */
export const CATALOG = [
    E('key', 'keys', 'Key', 'Types a key. Optional held modifiers (⌃⇧⌥⌘).',
        [{ key: 'key', kind: 'key' }, { key: 'mods', kind: 'mods', default: 0 }], ['Key Press'], { tag: '' }),
    E('trans', 'keys', 'Pass through', 'Uses the key from the layer below. ▽', [], ['Transparent'], { tag: '▽' }),
    E('none', 'keys', 'Nothing', 'Does nothing. ∅', [], ['None'], { tag: '∅' }),

    E('mod-tap', 'modifiers', 'Mod-tap', 'Hold for a modifier, tap for a key.',
        [{ key: 'hold', kind: 'mods', default: 0x02 }, { key: 'tap', kind: 'key' }, LIVE_PARAM, { ...TIMING_PARAM }, MODE_PARAM],
        ['Mod-Tap', 'Mod Tap', { name: 'Smart Mod', set: { mode: 'smart' } }], { tag: 'Mod-tap' }),
    E('one-shot-mod', 'modifiers', 'One-shot modifier', 'Next key gets the modifier.',
        [{ key: 'mods', kind: 'mods', default: 0x02 }, MODE_PARAM],
        ['Sticky Key', { name: 'Sticky Mod (smart)', set: { mode: 'smart' } }], { tag: 'One-shot' }),
    E('caps-word', 'modifiers', 'Caps word', 'Caps until a non-letter.', [], ['Caps Word'], { tag: 'Caps word' }),
    E('repeat', 'modifiers', 'Repeat key', 'Repeats the last key.', [], ['Key Repeat'], { tag: 'Repeat' }),
    E('alt-repeat', 'modifiers', 'Alt repeat', "Repeats the last key's opposite.", [], [], { tag: 'Alt rep' }),
    E('key-toggle', 'modifiers', 'Key toggle', 'Holds a key down until pressed again.',
        [{ key: 'key', kind: 'key' }, { key: 'mods', kind: 'mods', default: 0 }], ['Key Toggle'], { tag: 'Toggle' }),
    E('swapper', 'modifiers', 'Swapper', 'Hold to cycle windows (⌘-Tab style).', [], ['Swapper'], { tag: 'Swapper' }),
    E('grave-escape', 'modifiers', 'Grave/Escape', 'Esc, or ` with Shift/GUI.', [], ['Grave/Escape'], { tag: 'Esc/`' }),

    E('hold-layer', 'layers', 'Hold layer', 'Layer is on while held.', [{ key: 'layer', kind: 'layer' }], ['Momentary Layer'], { tag: 'Hold' }),
    E('layer-tap', 'layers', 'Layer-tap', 'Hold for a layer, tap for a key.',
        [{ key: 'layer', kind: 'layer', default: 1 }, { key: 'tap', kind: 'key' }, { ...TIMING_PARAM }], ['Layer-Tap', 'Layer Tap'], { tag: 'Layer-tap' }),
    E('to-layer', 'layers', 'Switch to layer', 'Turns this layer on, others off.', [{ key: 'layer', kind: 'layer' }], ['To Layer'], { tag: 'Switch' }),
    E('toggle-layer', 'layers', 'Toggle layer', 'Layer on/off with each press.', [{ key: 'layer', kind: 'layer' }], ['Toggle Layer'], { tag: 'Toggle' }),
    E('tap-toggle', 'layers', 'Tap-toggle layer', 'Hold = on while held; tap ×5 = toggle.', [{ key: 'layer', kind: 'layer' }], [], { tag: 'Tap-toggle' }),
    E('one-shot-layer', 'layers', 'One-shot layer', 'Next key comes from the layer.',
        [{ key: 'layer', kind: 'layer' }, MODE_PARAM], ['Sticky Layer', { name: 'Sticky Layer (smart)', set: { mode: 'smart' } }], { tag: 'One-shot' }),
    E('smart-layer', 'layers', 'Smart layer', 'Hold = one-shot layer, tap = toggle.', [{ key: 'layer', kind: 'layer' }], ['Smart Layer'], { tag: 'Smart' }),
    E('default-layer', 'layers', 'Default layer', 'Sets the base layer.', [{ key: 'layer', kind: 'layer' }], [], { tag: 'Default' }),
    E('layer-lock', 'layers', 'Layer lock', 'Keeps the current layer on.', [], [], { tag: 'Lock layer' }),
    E('num-word', 'layers', 'Num word', 'Number layer until a non-number.', [{ key: 'layer', kind: 'layer' }], ['Num Word'], { tag: 'Num word' }),

    E('mouse-key', 'mouse', 'Mouse button / move / wheel', 'Mouse keys.', [{ key: 'code', kind: 'choice' }],
        ['Mouse Key Press', 'Mouse Button Press'], { tag: 'Mouse' }),
    E('pointer', 'mouse', 'Pointer controls', 'DPI, polling rate, ball modes, angle snap.', [{ key: 'code', kind: 'choice' }], [], { tag: '' }),
    E('autoscroll', 'mouse', 'Autoscroll', 'Starts or stops hands-free scrolling.', [{ key: 'code', kind: 'choice' }], ['Flask Autoscroll'], { tag: 'Autoscroll' }),
    E('ball-swap', 'mouse', 'Ball swap', 'Swaps what the two trackballs do.', [{ key: 'code', kind: 'choice' }], ['Ball Swap'], { tag: 'Ball swap' }),
    E('gesture', 'mouse', 'Gesture', 'Hold and move the ball to fire a gesture set.', [{ key: 'slot', kind: 'slot' }], ['Flask Gesture'], { tag: 'Gesture' }),

    E('media-key', 'media', 'Media key', 'Play, volume, brightness…', [{ key: 'code', kind: 'choice' }], [], { tag: '', rides: 'key' }),
    E('lighting', 'media', 'Lighting', 'RGB controls.', [{ key: 'code', kind: 'choice' }], ['Flask RGB'], { tag: 'RGB' }),
    E('underglow', 'media', 'Underglow', 'Underglow lighting controls.', [{ key: 'code', kind: 'choice' }], ['RGB Underglow', 'Underglow'], { tag: 'Underglow' }),
    E('device-key', 'media', 'Device keys', 'Keys this firmware adds: DPI, drag scroll, select word…', [{ key: 'code', kind: 'choice' }], [], { tag: '' }),
    E('bluetooth', 'media', 'Bluetooth', 'Pick, clear or step through Bluetooth hosts.',
        [{ key: 'code', kind: 'choice' }, { key: 'profile', kind: 'num', min: 0, max: 4, default: 0 }], ['Bluetooth'], { tag: 'BT' }),
    E('output', 'media', 'Output', 'Send keys over USB or Bluetooth.', [{ key: 'code', kind: 'choice' }], ['Output Selection'], { tag: 'Output' }),
    E('power', 'media', 'External power', 'Turns the external power rail on or off.', [{ key: 'code', kind: 'choice' }], ['External Power'], { tag: 'Power' }),
    E('soft-off', 'media', 'Soft off', 'Turns the keyboard off.', [], ['Soft Off'], { tag: 'Off' }),
    E('reset', 'media', 'Reset', 'Restarts the keyboard.', [], ['Reset'], { tag: 'Reset' }),
    E('bootloader', 'media', 'Bootloader', 'Enters flashing mode. The keyboard disappears until flashed or re-plugged.', [], ['Bootloader'], { tag: 'Boot' }),
    E('studio-unlock', 'media', 'Studio unlock', 'Allows keymap edits over USB.', [], ['Studio Unlock'], { tag: 'Unlock' }),

    E('macro', 'run', 'Macro', 'Plays a macro you built (Behaviour › Macros).', [{ key: 'slot', kind: 'slot' }], ['Flask Macro'], { tag: 'Macro' }),
    E('tap-dance', 'run', 'Tap dance', 'Different output per tap count (Behaviour › Tap Dance).', [{ key: 'slot', kind: 'slot' }], ['Tap Dance'], { tag: 'Tap dance' }),
    E('leader', 'run', 'Leader', 'Starts a leader sequence (Behaviour › Leader).', [], ['Flask Leader'], { tag: 'Leader' }),

    E('advanced', 'advanced', 'Other behavior', 'Any other firmware behavior, raw params.', [{ key: 'raw', kind: 'raw' }], [], { tag: '' }),
];
const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));
export const entryById = (id) => BY_ID.get(id) ?? null;

// Which entries each adapter can encode at all (before device narrowing).
const QMK_IDS = new Set(['key', 'trans', 'none', 'mod-tap', 'one-shot-mod', 'caps-word', 'repeat', 'alt-repeat',
    'grave-escape', 'hold-layer', 'layer-tap', 'to-layer', 'toggle-layer', 'tap-toggle', 'one-shot-layer',
    'default-layer', 'layer-lock', 'mouse-key', 'media-key', 'lighting', 'device-key', 'reset', 'bootloader',
    'macro', 'tap-dance', 'leader', 'advanced']);
const NAPE_IDS = new Set(['key', 'none', 'mod-tap', 'hold-layer', 'layer-tap', 'to-layer', 'toggle-layer',
    'mouse-key', 'pointer', 'macro']);

// ---------------------------------------------------------------------------
// Mods

const MOD_GLYPH = ['⌃', '⇧', '⌥', '⌘'];
/** Mods mask → '⌃⇧' (left) or 'R⌘' (right); mixed shows both. */
export function modsText(mask) {
    const side = (m) => MOD_GLYPH.filter((_, i) => m & (1 << i)).join('');
    const l = side(mask & 0xF), r = side((mask >> 4) & 0xF);
    return l + (r ? 'R' + r : '');
}
const q5ToMask = (b) => ((b & 0x10) ? (b & 0xF) << 4 : b & 0xF);
const maskToQ5 = (m) => ((m & 0xF0) ? ((m >> 4) & 0xF) | 0x10 : m & 0xF);

// ZMK: a mods mask as one usage — lowest mod as the key, the rest as
// implicit-modifier bits.
function maskToUsage(m) {
    const i = [0, 1, 2, 3, 4, 5, 6, 7].find((b) => m & (1 << b));
    if (i == null) return 0;
    return ((((m & ~(1 << i)) & 0xFF) << 24) | kpParam(0xE0 + i)) >>> 0;
}
function usageToMask(u) {
    const { mods, page, id } = usageParts(u);
    return page === HID_PAGE_KEYBOARD && id >= 0xE0 && id <= 0xE7 ? (mods | (1 << (id - 0xE0))) & 0xFF : null;
}
// A key param (+ mods) ↔ a ZMK usage param.
const keyToUsage = (key, mods = 0) =>
    ((((mods & 0xFF) << 24) | (key > 0xFFFF ? key & 0xFFFFFF : kpParam(key & 0xFFFF))) >>> 0);
function usageToKey(u) {
    const { mods, page, id } = usageParts(u);
    return { key: page === HID_PAGE_KEYBOARD ? id : ((page << 16) | id) >>> 0, mods };
}

// ---------------------------------------------------------------------------
// ZMK: classify device behaviors

const md = (d, which) => d?.metadata?.[0]?.[which] ?? [];
const hasKind = (d, which, kind) => md(d, which).some((x) => x.kind === kind);
const shape = (d) => `${md(d, 'param1').map((x) => x.kind)[0] ?? ''}/${md(d, 'param2').map((x) => x.kind)[0] ?? ''}`;
const ZMK_EXACT = new Map();
for (const e of CATALOG) for (const m of e.zmk.match) ZMK_EXACT.set(m.name, { entryId: e.id, set: m.set });

/** Device behavior → {entryId, set} | null (Advanced) | 'hidden' (nameless). */
export function classifyZmk(d) {
    const name = d?.displayName ?? '';
    if (!name) return 'hidden';
    const exact = ZMK_EXACT.get(name);
    if (exact) {
        const set = { ...exact.set };
        if (exact.entryId === 'mod-tap' && !set.mode) Object.assign(set, { timing: TIMING_PARAM.default });
        if (exact.entryId === 'layer-tap') set.timing = TIMING_PARAM.default;
        return { entryId: exact.entryId, set };
    }
    const s = shape(d);
    let m;
    if (s === 'hid_usage/hid_usage' && (m = name.match(/^Mod-Tap \((\w+) (\d+)\)$/))) return { entryId: 'mod-tap', set: { timing: +m[2] } };
    // flask_holdtap. Key-position nodes ("Hold-Tap L (live)") are the
    // per-key live variants; any other "(live)" node reads a VIRTUAL slot
    // (combo / autoshift building block): absorbed as a helper variant that
    // decodes and round-trips but is never offered as a choice.
    if (s === 'hid_usage/hid_usage' && (m = name.match(/^Hold-Tap(?: ([LR]))? \(live\)$/))) {
        return { entryId: 'mod-tap', set: { live: m[1] === 'L' ? 'left' : m[1] === 'R' ? 'right' : 'any' } };
    }
    if (/\(live\)$/.test(name) && s === 'hid_usage/hid_usage') return { entryId: 'mod-tap', set: { live: 'fixed', helper: true } };
    if (/\(live\)$/.test(name) && s === 'layer_id/hid_usage') return { entryId: 'layer-tap', set: { live: 'fixed', helper: true } };
    if (s === 'layer_id/hid_usage' && (m = name.match(/^Layer-Tap \((\w+) (\d+)\)$/))) return { entryId: 'layer-tap', set: { timing: +m[2] } };
    if (/underglow/i.test(name)) return { entryId: 'underglow', set: {} };
    if (/grave.?escape/i.test(name)) return { entryId: 'grave-escape', set: {} };
    return null;
}

const asMap = (b) => (b instanceof Map ? b : new Map((b ?? []).map((d) => [d.id, d])));

/** Per-device index: entryId → absorbed behaviors; Advanced leftovers. */
function zmkIndex(behaviors) {
    const byEntry = new Map();
    const advanced = [];
    let hidden = 0;
    for (const d of behaviors.values()) {
        const c = classifyZmk(d);
        if (c === 'hidden') { hidden++; continue; }
        if (!c) { advanced.push(d); continue; }
        if (!byEntry.has(c.entryId)) byEntry.set(c.entryId, []);
        byEntry.get(c.entryId).push({ behaviorId: d.id, name: d.displayName, set: c.set, d });
    }
    return { byEntry, advanced, hidden };
}

const constantsOf = (d, which = 'param1') => md(d, which).filter((x) => x.kind === 'constant');
const rangeOf = (d, which = 'param1') => md(d, which).find((x) => x.kind === 'range');

// ---------------------------------------------------------------------------
// catalogFor

function adapterForApp(app) {
    if (app?.adapter) return app.adapter;
    if (app?.family === 'nape') return 'nape';
    if (app?.behaviors || isZmkFamily(app?.family)) return 'zmk-studio';
    return 'qmk';
}

const choice = (key, options, labels, def = options[0]) => ({ key, kind: 'choice', options, labels, default: def });
const codeChoices = (list) => choice('code', list.map((k) => k.code), Object.fromEntries(list.map((k) => [k.code, k.label])));

/**
 * Entries the connected device (or offline workspace) can assign, in group
 * order. Each named device behavior maps to exactly one entry or Advanced;
 * nameless ones are hidden and counted in `result.hidden`.
 * @param {object} app  {family, caps, layerCount, tapDanceCount, behaviors?, adapter?}
 *        ZMK behaviors come from app.behaviors (Map or array) or the
 *        zmk-keycodes context (setZmkContext).
 * @returns {CatalogEntry[] & {hidden: number, adapter: string}}
 */
export function catalogFor(app) {
    const adapter = adapterForApp(app);
    const out = adapter === 'qmk' ? qmkCatalog(app) : adapter === 'nape' ? napeCatalog(app) : zmkCatalog(app);
    out.adapter = adapter;
    return out;
}

function layerParam(p, max) { return { ...p, min: 0, max: max - 1 }; }

function qmkCatalog(app) {
    const layers = Math.max(1, app?.layerCount || 16);
    const out = [];
    for (const e of CATALOG) {
        if (!QMK_IDS.has(e.id)) continue;
        let params = e.params.filter((p) => !['timing', 'mode', 'live'].includes(p.key));
        params = params.map((p) => (p.kind === 'layer'
            ? layerParam(p, ['layer-tap'].includes(e.id) ? Math.min(layers, 16) : Math.min(layers, 32)) : p));
        if (e.id === 'mouse-key') params = [codeChoices(mouseKeys)];
        if (e.id === 'media-key') params = [codeChoices(mediaKeys)];
        if (e.id === 'lighting') params = [codeChoices(rgbKeys)];
        if (e.id === 'device-key') {
            const c = deviceCustoms();
            if (!c.length) continue;
            params = [codeChoices(c)];
        }
        if (e.id === 'macro') {
            const n = macroKeys().length;
            if (!n) continue;
            params = [{ key: 'slot', kind: 'slot', min: 0, max: n - 1, default: 0 }];
        }
        if (e.id === 'tap-dance') params = [{ key: 'slot', kind: 'slot', min: 0, max: (app?.tapDanceCount || 32) - 1, default: 0 }];
        const extra = (e.id === 'mod-tap' || e.id === 'layer-tap') ? { note: 'Tapping term: global — QMK Settings' } : {};
        out.push({ ...e, params, ...extra });
    }
    out.hidden = 0;
    return out;
}

function napeCatalog(app) {
    const layers = app?.layerCount || 9;
    const pointer = napeKeycodeGroups().filter((g) => !['Layers', 'None', 'Buttons'].includes(g.name))
        .flatMap((g) => g.codes.map((code) => ({ code, label: napeKeyLabel(code), section: g.name })));
    const buttons = napeKeycodeGroups().find((g) => g.name === 'Buttons').codes
        .map((code) => ({ code, label: napeKeyLabel(code) }));
    const out = [];
    for (const e of CATALOG) {
        if (!NAPE_IDS.has(e.id)) continue;
        let params = e.params.filter((p) => !['timing', 'mode', 'live'].includes(p.key))
            .map((p) => (p.kind === 'layer' ? layerParam(p, Math.min(layers, e.id === 'layer-tap' ? 16 : 32)) : p));
        if (e.id === 'mouse-key') params = [codeChoices(buttons)];
        if (e.id === 'pointer') params = [{ ...codeChoices(pointer), sections: Object.fromEntries(pointer.map((p) => [p.code, p.section])) }];
        if (e.id === 'macro') params = [{ key: 'slot', kind: 'slot', min: 0, max: (app?.macroCount ?? 16) - 1, default: 0 }];
        if (e.id === 'macro' && app?.macroCount === 0) continue;
        out.push({ ...e, params });
    }
    out.hidden = 0;
    return out;
}

function zmkCatalog(app) {
    const behaviors = asMap(app?.behaviors ?? behaviorsNow());
    const { byEntry, advanced, hidden } = zmkIndex(behaviors);
    const keyPress = byEntry.get('key');
    const out = [];
    for (const e of CATALOG) {
        let device = byEntry.get(e.id);
        if (e.id === 'media-key') device = keyPress;     // rides Key Press (consumer page)
        if (e.id === 'advanced') {
            if (!advanced.length) continue;
            device = advanced.map((d) => ({ behaviorId: d.id, name: d.displayName, set: {}, d }));
        }
        if (!device?.length) continue;
        const d0 = device[0].d;
        let params = e.params.map((p) => {
            if (p.key === 'timing') {
                const ms = [...new Set(device.filter((v) => v.set.timing != null).map((v) => v.set.timing))].sort((a, b) => a - b);
                return { ...p, variants: ms };
            }
            if (p.key === 'mode') {
                const opts = p.options.filter((o) => device.some((v) => (v.set.mode ?? 'plain') === o));
                return { ...p, options: opts };
            }
            if (p.key === 'live') {
                const sides = device.filter((v) => v.set.live).map((v) => v.set.live);
                return { ...p, options: ['off', ...p.options.filter((o) => sides.includes(o))] };
            }
            if (p.kind === 'layer') return { ...p, options: layersNow().map((l) => l.id), labels: Object.fromEntries(layersNow().map((l) => [l.id, l.name || `Layer ${l.id}`])) };
            if (p.kind === 'slot') {
                const r = rangeOf(d0);
                return { ...p, min: r?.min ?? 0, max: r ? Math.min(r.max, 63) : 31, default: r?.min ?? 0 };
            }
            if (p.key === 'code') {
                if (e.id === 'media-key') return codeChoices(consumerUsages.map((c) => ({ code: c.code, label: c.label })));
                const cs = constantsOf(d0);
                return choice('code', cs.map((c) => c.constant), Object.fromEntries(cs.map((c) => [c.constant, c.name || String(c.constant)])));
            }
            if (p.key === 'profile') {
                const r = rangeOf(d0, 'param2');
                return { ...p, min: r?.min ?? 0, max: r?.max ?? 4 };
            }
            return p;
        });
        // A choice with one option is not a choice.
        params = params.filter((p) => !(p.kind === 'choice' && ['mode', 'live'].includes(p.key) && p.options.length < 2));
        if (e.id === 'mod-tap' || e.id === 'layer-tap') {
            const t = params.find((p) => p.key === 'timing');
            if (t && t.variants.length < 2 && !device.some((v) => v.set.live)) params = params.filter((p) => p !== t);
        }
        out.push({ ...e, params, device: device.map(({ behaviorId, name, set }) => ({ behaviorId, name, set })),
            ...(e.id === 'advanced' ? { behaviors: device.map((v) => v.d) } : {}) });
    }
    out.hidden = hidden;
    return out;
}

// ---------------------------------------------------------------------------
// decode / encode

/** Which adapter a raw binding belongs to, when the caller does not say. */
export function adapterOf(binding) {
    if (typeof binding === 'object' && binding) return 'behaviorId' in binding && !('action' in binding) ? 'zmk-studio' : 'zmk-typed';
    return 'qmk';
}

const adv = (raw, adapter) => ({ entryId: 'advanced', params: { raw, adapter } });

/**
 * Binding → entry + params. `adapter` is a binding-picker SURFACES adapter;
 * Nape u16 values must pass 'nape' (they look like QMK numbers).
 * Unknown bindings decode to {entryId: 'advanced', params: {raw, adapter}}.
 * @returns {Decoded}
 */
export function decode(binding, adapter = adapterOf(binding)) {
    if (adapter === 'qmk') return decodeQmk(binding >>> 0 & 0xFFFF, adapter);
    if (adapter === 'nape') return decodeNape(binding >>> 0 & 0xFFFF);
    if (adapter === 'zmk-typed') return decodeTyped(binding);
    return decodeStudio(binding);
}

/** Entry + params → binding for `adapter`. Inverse of decode. Params left
 * out take the entry's defaults. Throws when the entry cannot be stored by
 * this adapter or device (e.g. Tap-toggle on ZMK). */
export function encode(entryId, params = {}, adapter) {
    if (entryId === 'advanced') return params.raw;
    if (adapter === 'qmk') return encodeQmk(entryId, params);
    if (adapter === 'nape') return encodeNape(entryId, params);
    if (adapter === 'zmk-typed') return encodeTyped(entryId, params);
    if (adapter === 'zmk-studio') return encodeStudio(entryId, params);
    throw new Error(`encode: unknown adapter ${adapter}`);
}

const fail = (id, adapter) => { throw new Error(`encode(${id}): not storable on ${adapter}`); };
const P = (id, params) => {   // params with entry defaults filled in
    const out = {};
    for (const p of entryById(id)?.params ?? []) if (p.default !== undefined) out[p.key] = p.default;
    return { ...out, ...params };
};

// ---- QMK ----

const QMK_FIXED = new Map([
    [0x0000, 'none'], [0x0001, 'trans'], [R.boot, 'bootloader'], [0x7C01, 'reset'], [0x7C16, 'grave-escape'],
    [0x7C73, 'caps-word'], [0x7C79, 'repeat'], [0x7C7A, 'alt-repeat'], [0x7C7B, 'layer-lock'], [0x7C58, 'leader'],
]);
const QMK_FIXED_BY_ID = new Map([...QMK_FIXED].map(([k, v]) => [v, k]));
const inSet = (list, kc) => list.some((k) => k.code === kc);

function decodeQmk(kc, adapter = 'qmk') {
    if (QMK_FIXED.has(kc)) return { entryId: QMK_FIXED.get(kc), params: {} };
    if (kc <= 0xFF) {
        if (inSet(mediaKeys, kc)) return { entryId: 'media-key', params: { code: kc } };
        if (kc >= 0xCD && kc <= 0xDF) return { entryId: 'mouse-key', params: { code: kc } };
        return { entryId: 'key', params: { key: kc, mods: 0 } };
    }
    const q5ok = (b) => (b & 0xF) !== 0;   // a right-hand flag with no mods is not a key we can show
    if (kc <= 0x1FFF && (!(kc & 0xFF) || !q5ok(kc >> 8))) return adv(kc, adapter);
    if (kc >= 0x2000 && kc <= 0x3FFF && !q5ok(kc >> 8)) return adv(kc, adapter);
    if (kc >= R.oneShotModBase && kc < R.oneShotModBase + 0x20 && !q5ok(kc)) return adv(kc, adapter);
    if (kc <= 0x1FFF) return { entryId: 'key', params: { key: kc & 0xFF, mods: q5ToMask((kc >> 8) & 0x1F) } };
    if (kc <= 0x3FFF) return { entryId: 'mod-tap', params: { hold: q5ToMask((kc >> 8) & 0x1F), tap: kc & 0xFF } };
    if (kc <= 0x4FFF) return { entryId: 'layer-tap', params: { layer: (kc >> 8) & 0xF, tap: kc & 0xFF } };
    const L = (base, id) => (kc >= base && kc < base + 0x20 ? { entryId: id, params: { layer: kc - base } } : null);
    const r = L(R.toBase, 'to-layer') ?? L(R.momentaryBase, 'hold-layer') ?? L(R.defLayerBase, 'default-layer')
        ?? L(R.toggleLayerBase, 'toggle-layer') ?? L(R.oneShotLayerBase, 'one-shot-layer') ?? L(R.layerTapToggleBase, 'tap-toggle');
    if (r) return r;
    if (kc >= R.oneShotModBase && kc < R.oneShotModBase + 0x20) return { entryId: 'one-shot-mod', params: { mods: q5ToMask(kc & 0x1F) } };
    if (kc >= R.tapDanceBase && kc <= R.tapDanceBase + 0xFF) return { entryId: 'tap-dance', params: { slot: kc & 0xFF } };
    if (kc >= R.macroBase && kc <= R.macroMax) return { entryId: 'macro', params: { slot: kc - R.macroBase } };
    if (inSet(rgbKeys, kc)) return { entryId: 'lighting', params: { code: kc } };
    if (kc >= R.kbBase && kc <= R.kbBase + 0xFF) return { entryId: 'device-key', params: { code: kc } };
    return adv(kc, adapter);
}

function encodeQmk(id, params) {
    const p = P(id, params);
    if (QMK_FIXED_BY_ID.has(id)) return QMK_FIXED_BY_ID.get(id);
    const key = (k) => (k ?? 0) & 0xFF;
    switch (id) {
        case 'key': return p.mods ? ((maskToQ5(p.mods) << 8) | key(p.key)) : key(p.key);
        case 'mod-tap': return R.modTapBase | (maskToQ5(p.hold) << 8) | key(p.tap);
        case 'layer-tap': return R.layerTapBase | ((p.layer & 0xF) << 8) | key(p.tap);
        case 'to-layer': return R.toBase | (p.layer & 0x1F);
        case 'hold-layer': return R.momentaryBase | (p.layer & 0x1F);
        case 'default-layer': return R.defLayerBase | (p.layer & 0x1F);
        case 'toggle-layer': return R.toggleLayerBase | (p.layer & 0x1F);
        case 'one-shot-layer': return R.oneShotLayerBase | (p.layer & 0x1F);
        case 'tap-toggle': return R.layerTapToggleBase | (p.layer & 0x1F);
        case 'one-shot-mod': return R.oneShotModBase | maskToQ5(p.mods);
        case 'tap-dance': return R.tapDanceBase | (p.slot & 0xFF);
        case 'macro': return R.macroBase + (p.slot & 0x7F);
        case 'media-key': case 'mouse-key': case 'lighting': case 'device-key': return p.code;
        default: return fail(id, 'qmk');
    }
}

// ---- Nape (QMK keycode space, Nape's own customs) ----

const NAPE_POINTER = new Set([NKC.scrollHold, NKC.scrollToggle, NKC.gestureHold, NKC.tapHold]);
function decodeNape(kc) {
    if (NAPE_POINTER.has(kc) || (kc >= NQK.kb && kc <= NQK.kb + 0xFF)) {
        if (kc === NQK.kb + 46) return { entryId: 'mouse-key', params: { code: kc } };   // double left-click
        return { entryId: 'pointer', params: { code: kc } };
    }
    if (kc >= 0xD1 && kc <= 0xD5) return { entryId: 'mouse-key', params: { code: kc } };
    const d = decodeQmk(kc, 'nape');
    return NAPE_IDS.has(d.entryId) ? d : adv(kc, 'nape');
}
function encodeNape(id, params) {
    if (!NAPE_IDS.has(id)) fail(id, 'nape');
    if (id === 'pointer' || id === 'mouse-key') return P(id, params).code;
    return encodeQmk(id, params);
}

// ---- ZMK Studio ----

// The ZMK context (behaviors + layers) comes from zmk-keycodes.js. A caller
// holding another instance of that module (a different ?v= stamp) passes
// its own context through withZmkContext.
let ctxOverride = null;
function behaviorsNow() { return ctxOverride?.behaviors ?? zmkBehaviors(); }
function layersNow() { return ctxOverride?.layers ?? zmkLayers(); }
const layerNameNow = (id) => (ctxOverride
    ? ctxOverride.layers.find((l) => l.id === id)?.name ?? `Layer#${id}` : layerName(id));
/** Run fn with an explicit ZMK context ({behaviors: Map, layers}). Sync only. */
export function withZmkContext(ctx, fn) {
    const old = ctxOverride;
    ctxOverride = ctx;
    try { return fn(); } finally { ctxOverride = old; }
}

function decodeStudio(b) {
    if (!b) return adv(b, 'zmk-studio');
    const d = behaviorsNow().get(b.behaviorId);
    const c = d ? classifyZmk(d) : null;
    if (!c || c === 'hidden') return adv({ behaviorId: b.behaviorId, param1: b.param1 >>> 0, param2: b.param2 >>> 0 }, 'zmk-studio');
    const p1 = b.param1 >>> 0, p2 = b.param2 >>> 0;
    const { entryId, set } = c;
    const base = { ...set };
    switch (entryId) {
        case 'key': {
            const { page } = usageParts(p1);
            if (page === HID_PAGE_CONSUMER) {
                const { mods, id } = usageParts(p1);
                if (!mods) return { entryId: 'media-key', params: { code: id } };
            }
            return { entryId, params: usageToKey(p1) };
        }
        case 'key-toggle': return { entryId, params: usageToKey(p1) };
        case 'mod-tap': {
            const hold = usageToMask(p1);
            const params = { hold: hold ?? 0, tap: usageToKey(p2).key, tapMods: usageToKey(p2).mods,
                timing: set.timing ?? TIMING_PARAM.default, mode: set.mode ?? 'plain', live: set.live ?? 'off' };
            if (hold == null) params.holdKey = p1;
            if (!params.tapMods) delete params.tapMods;
            if (set.helper) params.variant = b.behaviorId;
            return { entryId, params };
        }
        case 'one-shot-mod': {
            const m = usageToMask(p1);
            return { entryId, params: m == null ? { mods: 0, key: p1, mode: set.mode ?? 'plain' } : { mods: m, mode: set.mode ?? 'plain' } };
        }
        case 'layer-tap': {
            const t = usageToKey(p2);
            return { entryId, params: { layer: p1, tap: t.key, ...(t.mods ? { tapMods: t.mods } : {}), timing: set.timing ?? TIMING_PARAM.default,
                ...(set.helper ? { live: 'fixed', variant: b.behaviorId } : {}) } };
        }
        case 'hold-layer': case 'to-layer': case 'toggle-layer': case 'num-word':
            return { entryId, params: { layer: p1 } };
        case 'one-shot-layer': return { entryId, params: { layer: p1, mode: set.mode ?? 'plain' } };
        case 'smart-layer':
            return p1 === p2 ? { entryId, params: { layer: p1 } } : { entryId, params: { layer: p1, layer2: p2 } };
        case 'macro': case 'tap-dance': case 'gesture': return { entryId, params: { slot: p1 } };
        case 'bluetooth': return { entryId, params: { code: p1, profile: p2 } };
        case 'mouse-key': case 'autoscroll': case 'ball-swap': case 'lighting': case 'underglow': case 'output': case 'power':
            return { entryId, params: p2 ? { code: p1, p2 } : { code: p1 } };
        default:
            if (p1 || p2) return { entryId, params: { ...base, p1, p2 } };
            return { entryId, params: {} };
    }
}

/** Behaviors on this device absorbed by an entry. */
function variantsOf(entryId) {
    const out = [];
    for (const d of behaviorsNow().values()) {
        const c = classifyZmk(d);
        if (c && c !== 'hidden' && c.entryId === (entryId === 'media-key' ? 'key' : entryId)) out.push({ behaviorId: d.id, set: c.set, name: d.displayName });
    }
    return out;
}

/** Pick the behavior for an entry + params (mode / live / timing variants). */
export function behaviorFor(entryId, params = {}) {
    const vs = variantsOf(entryId);
    if (!vs.length) return null;
    const p = P(entryId, params);
    if (p.variant != null && vs.some((v) => v.behaviorId === p.variant)) return p.variant;   // helper (virtual slot)
    const mode = p.mode ?? 'plain';
    const live = p.live ?? 'off';
    if (entryId === 'mod-tap' || entryId === 'layer-tap') {
        if (mode === 'smart') return vs.find((v) => v.set.mode === 'smart')?.behaviorId ?? null;
        if (live !== 'off') {
            const lv = vs.filter((v) => v.set.live && !v.set.helper).map((v) => ({ behaviorId: v.behaviorId, ms: null, live: true, side: v.set.live }));
            const r = lv.length && resolveTiming(entryId, p.timing ?? TIMING_PARAM.default, lv, { side: live });
            const pick = lv.find((v) => v.side === live) ?? (r && lv.find((v) => v.behaviorId === r.behaviorId));
            if (pick) return pick.behaviorId;
        }
        const compiled = vs.filter((v) => !v.set.mode && !v.set.live).map((v) => ({ behaviorId: v.behaviorId, ms: v.set.timing }));
        const r = resolveTiming(entryId, p.timing ?? TIMING_PARAM.default, compiled, { side: null });
        return r?.behaviorId ?? compiled[0]?.behaviorId ?? null;
    }
    const want = vs.find((v) => (v.set.mode ?? 'plain') === mode) ?? vs[0];
    return want.behaviorId;
}

function encodeStudio(id, params) {
    const p = P(id, params);
    const bid = behaviorFor(id, p);
    if (bid == null) fail(id, 'zmk-studio');
    const B = (param1 = 0, param2 = 0) => ({ behaviorId: bid, param1: param1 >>> 0, param2: param2 >>> 0 });
    switch (id) {
        case 'key': case 'key-toggle': return B(keyToUsage(p.key ?? 0, p.mods));
        case 'media-key': return B(((HID_PAGE_CONSUMER << 16) | (p.code & 0xFFFF)) >>> 0);
        case 'mod-tap': return B(p.holdKey ?? maskToUsage(p.hold), keyToUsage(p.tap ?? 0, p.tapMods));
        case 'one-shot-mod': return B(p.key ?? maskToUsage(p.mods));
        case 'layer-tap': return B(p.layer, keyToUsage(p.tap ?? 0, p.tapMods));
        case 'hold-layer': case 'to-layer': case 'toggle-layer': case 'num-word': case 'one-shot-layer': return B(p.layer);
        case 'smart-layer': return B(p.layer, p.layer2 ?? p.layer);
        case 'macro': case 'tap-dance': case 'gesture': return B(p.slot);
        case 'bluetooth': return B(p.code, p.profile);
        case 'mouse-key': case 'autoscroll': case 'ball-swap': case 'lighting': case 'underglow': case 'output': case 'power':
            return B(p.code, p.p2 ?? 0);
        default: return B(p.p1 ?? 0, p.p2 ?? 0);
    }
}

// ---- ZMK typed slots ----

function decodeTyped(v) {
    if (!v || !v.action) return { entryId: 'none', params: {} };
    if (v.action === 1) {
        const { page, mods, id } = usageParts(v.param1 >>> 0);
        if (page === HID_PAGE_CONSUMER && !mods) return { entryId: 'media-key', params: { code: id } };
        return { entryId: 'key', params: usageToKey(v.param1 >>> 0) };
    }
    if (v.action === 2) return { entryId: 'macro', params: { slot: v.param1 >>> 0 } };
    const d = decodeStudio({ behaviorId: v.behaviorId, param1: v.param1, param2: v.param2 ?? 0 });
    return d.entryId === 'advanced' ? adv(v, 'zmk-typed') : d;
}

function encodeTyped(id, params) {
    const p = P(id, params);
    if (id === 'none') return { action: 0, param1: 0 };
    if (id === 'key') return { action: 1, param1: keyToUsage(p.key ?? 0, p.mods) };
    if (id === 'media-key') return { action: 1, param1: ((HID_PAGE_CONSUMER << 16) | (p.code & 0xFFFF)) >>> 0 };
    if (id === 'macro') return { action: 2, param1: p.slot >>> 0 };
    const b = encodeStudio(id, p);
    return { action: 3, behaviorId: b.behaviorId, param1: b.param1, param2: b.param2 };
}

// ---------------------------------------------------------------------------
// Labels

const layerText = (adapter, l) => (adapter === 'zmk-studio' || adapter === 'zmk-typed' ? layerNameNow(l) : `L${l}`);
const qmkKeyCap = (k) => (k ? capLabel(k & 0xFF) : '·');
function keyCap(adapter, key, mods = 0) {
    if (adapter === 'qmk' || adapter === 'nape') {
        const kc = mods ? ((maskToQ5(mods) << 8) | key) : key;
        if (lookup(kc)) return { top: '', main: capLabel(kc) };            // shifted symbols: '!'
        return { top: modsText(mods), main: adapter === 'nape' ? napeKeyLabel(key) : qmkKeyCap(key) };
    }
    return { top: modsText(mods), main: usageCap(keyToUsage(key, 0)) };
}
const codeLabel = (entry, code) => entry?.params?.find((p) => p.key === 'code')?.labels?.[code];
const timingTag = (p) => {
    if (p.variant != null) {
        const n = behaviorsNow().get(p.variant)?.displayName ?? '';
        return /autoshift/i.test(n) ? ' · autoshift' : /combo/i.test(n) ? ' · combo' : ' · shared';
    }
    if (p.live && p.live !== 'off') return ' · live';
    if (p.mode === 'smart') return ' · smart';
    if (p.timing != null && p.timing !== TIMING_PARAM.default) return p.timing < TIMING_PARAM.default ? ' · fast' : ' · slow';
    return '';
};

/**
 * Keycap text split (§2.4): `top` = the hold/variant part (may be ''),
 * `main` = the tap part. Never empty, never "(x" fragments.
 * @returns {{top: string, main: string}}
 */
export function capParts(binding, adapter = adapterOf(binding)) {
    const { entryId, params: p } = decode(binding, adapter);
    const e = entryById(entryId);
    switch (entryId) {
        case 'key': return keyCap(adapter, p.key, p.mods);
        case 'trans': return { top: '', main: '▽' };
        case 'none': return { top: '', main: adapter === 'zmk-typed' ? '—' : '∅' };
        case 'key-toggle': return { top: 'Toggle', main: keyCap(adapter, p.key, p.mods).main };
        case 'mod-tap':
            return { top: `Mod-tap ${p.holdKey != null ? usageCap(p.holdKey) : modsText(p.hold)}${timingTag(p)}`.trim(),
                main: keyCap(adapter, p.tap, p.tapMods ?? 0).main };
        case 'layer-tap': return { top: `LT ${layerText(adapter, p.layer)}${timingTag(p)}`, main: keyCap(adapter, p.tap, p.tapMods ?? 0).main };
        case 'one-shot-mod': return { top: `One-shot${timingTag(p)}`, main: p.key != null ? usageCap(p.key) : modsText(p.mods) || '·' };
        case 'hold-layer': case 'to-layer': case 'toggle-layer': case 'tap-toggle': case 'default-layer': case 'smart-layer': case 'num-word':
            return { top: e.tag, main: layerText(adapter, p.layer) };
        case 'one-shot-layer': return { top: `One-shot${timingTag(p)}`, main: layerText(adapter, p.layer) };
        case 'macro': return { top: '', main: `M${p.slot}` };
        case 'tap-dance': return { top: '', main: `TD${p.slot}` };
        case 'gesture': return { top: 'Gesture', main: String(p.slot) };
        case 'media-key':
            if (adapter === 'qmk') return { top: '', main: capLabel(p.code) };
            return { top: '', main: usageCap(((HID_PAGE_CONSUMER << 16) | p.code) >>> 0) };
        case 'mouse-key': case 'lighting': case 'device-key': case 'pointer':
            if (adapter === 'qmk') return { top: '', main: capLabel(p.code) };
            if (adapter === 'nape') return { top: '', main: napeKeyLabel(p.code) };
            return { top: e.tag, main: zmkConstName(binding, adapter) ?? String(p.code) };
        case 'bluetooth': {
            const n = zmkConstName(binding, adapter) ?? String(p.code);
            return { top: 'BT', main: n === 'Select' ? `Select ${p.profile}` : n };
        }
        case 'autoscroll': case 'ball-swap': case 'underglow': case 'output': case 'power':
            return { top: e.tag, main: zmkConstName(binding, adapter) ?? String(p.code) };
        case 'advanced': return { top: '', main: advancedCap(p.raw, adapter) };
        default: return { top: '', main: e?.tag || e?.name || '?' };
    }
}

function zmkConstName(binding, adapter) {
    const bid = adapter === 'zmk-typed' ? binding.behaviorId : binding?.behaviorId;
    const d = behaviorsNow().get(bid);
    const n = constantsOf(d).find((c) => c.constant === (binding.param1 >>> 0))?.name;
    return n ? n.replace(/\s*\(.*?\)/g, '') : null;   // caps never carry "(x" fragments
}

function advancedCap(raw, adapter) {
    if (adapter === 'qmk') return capLabel(raw);
    if (adapter === 'nape') return napeKeyLabel(raw);
    if (adapter === 'zmk-typed' && raw?.action === 1) return usageCap(raw.param1);
    const d = behaviorsNow().get(raw?.behaviorId);
    return d?.displayName ? d.displayName.slice(0, 10) : `#${raw?.behaviorId ?? '?'}`;
}

/** One-line text for a binding: row titles ("J + K → Esc"), toasts, the
 * caption bar. */
export function describeBinding(binding, adapter = adapterOf(binding)) {
    const { entryId, params } = decode(binding, adapter);
    const { top, main } = capParts(binding, adapter);
    if (entryId === 'key') return `${top}${main}`;
    if (entryId === 'advanced') {
        if (adapter === 'qmk') return describe(binding);
        if (adapter === 'nape') return napeKeyLabel(binding);
        if (adapter === 'zmk-typed' && binding?.action === 1) return usageLabel(binding.param1);
        const d = behaviorsNow().get(binding?.behaviorId);
        return d?.displayName || `Unnamed behavior #${binding?.behaviorId}`;
    }
    const e = entryById(entryId);
    if (entryId === 'media-key' || entryId === 'trans' || entryId === 'none') return e.name + (main && !['▽', '∅', '—'].includes(main) ? ` ${main}` : '');
    const t = params.timing != null && params.live === 'off' && params.mode !== 'smart' && (entryId === 'mod-tap' || entryId === 'layer-tap')
        ? ` · ${params.timing} ms` : '';
    return `${(t ? top.replace(/ · (fast|slow)$/, '') : top) || e.name} ${main}`.trim() + t;
}

// ---------------------------------------------------------------------------
// Tap/Hold composer (WP3b). The native Svalboard picker builds MT() from a
// ⌃⇧⌥⌘ row + "MT" toggle + key, and LT() from a layer + tap grid
// (KeycodePicker.swift). Here both are one spec: a TAP key and a HOLD
// (modifiers, a layer, or on ZMK any key), encoded per firmware line.

/**
 * Hold/tap split of a dual-role binding, for labelled caps and cells.
 * @returns {{entryId: 'mod-tap'|'layer-tap', hold: string, tag: string, tap: string}|null}
 *   hold  '⇧', 'R⌘', 'L1' / layer name, or the held key's cap
 *   tag   '', 'live', 'fast', 'slow', 'smart', 'combo', 'autoshift', 'shared'
 *   tap   the tap key's cap, held modifiers included ('⇧1' reads '!')
 */
export function holdTapParts(binding, adapter = adapterOf(binding)) {
    let d;
    try { d = decode(binding, adapter); } catch { return null; }
    const p = d.params;
    if (d.entryId !== 'mod-tap' && d.entryId !== 'layer-tap') return null;
    const k = keyCap(adapter, p.tap, p.tapMods ?? 0);
    const hold = d.entryId === 'layer-tap' ? layerText(adapter, p.layer)
        : p.holdKey != null ? usageCap(p.holdKey) : modsText(p.hold);
    return { entryId: d.entryId, hold: hold || '·', tag: timingTag(p).replace(/^ · /, ''), tap: (k.top + k.main) || '·' };
}

const MOD_LETTER = { C: 0x01, S: 0x02, A: 0x04, G: 0x08 };

/** Live hold-tap sides this ZMK device compiles ('left' | 'right' | 'any'),
 * from its "Hold-Tap L/R (live)" nodes (&fht_l / &fht_r / &fht). */
export function liveSides() {
    return variantsOf('mod-tap').filter((v) => v.set.live && !v.set.helper).map((v) => v.set.live);
}

/** The live variant for a key on `hand`: its own side, else the no-rule
 * node, else none ('off' = compiled timing). */
export function liveSideFor(hand, sides = liveSides()) {
    if (hand && sides.includes(hand)) return hand;
    if (sides.includes('any')) return 'any';
    return sides[0] ?? 'off';
}

/**
 * Tap + Hold → a binding for `adapter`, or a reason it can't be stored.
 * @param {object} spec
 * @param {{key:number, mods?:number}|null} spec.tap
 * @param {{kind:'mods', mods:number}|{kind:'layer', layer:number}|{kind:'key', key:number, mods?:number}|null} spec.hold
 * @param {'left'|'right'|null} [spec.hand]  the key's hand (ZMK live variant)
 * @param {number} [spec.timing]  ms (ZMK live slot / nearest compiled variant)
 * @returns {{ok:true, value:*, entryId:string, params:object, via:string}
 *          |{ok:false, message:string, fallback?:'tap-dance'}}
 */
export function composeTapHold({ tap, hold, hand = null, timing } = {}, adapter) {
    if (!tap?.key) return { ok: false, message: 'Pick the TAP key.' };
    if (!hold) return { ok: false, message: 'Pick what HOLD does.' };
    if (hold.kind === 'mods' && !(hold.mods & 0xFF)) return { ok: false, message: 'Pick at least one modifier to hold.' };
    const tapMods = tap.mods & 0xFF;
    const qmkLike = adapter === 'qmk' || adapter === 'nape';
    if (qmkLike) {
        const fw = adapter === 'nape' ? 'Nape' : 'QMK';
        const tapName = keyCap(adapter, tap.key, tapMods);
        const tapText = tapName.top + tapName.main;
        if (tap.key > 0xFF || tapMods) {
            return { ok: false, fallback: 'tap-dance',
                message: `${fw} ${hold.kind === 'layer' ? 'LT()' : 'MT()'} can only tap a plain key; "${tapText}" carries a modifier or is not a basic key. Use a tap dance (tap ${tapText}, hold ${hold.kind === 'layer' ? 'the layer' : modsText(hold.mods ?? 0)}).` };
        }
        if (hold.kind === 'key') return { ok: false, fallback: 'tap-dance', message: `${fw} holds only modifiers or a layer. Holding a key needs a tap dance.` };
        if (hold.kind === 'layer' && !(hold.layer >= 0 && hold.layer <= 15)) {
            return { ok: false, fallback: 'tap-dance', message: `${fw} LT() reaches layers 0–15 only. Layer ${hold.layer} needs a tap dance.` };
        }
        if (hold.kind === 'mods' && (hold.mods & 0x0F) && (hold.mods & 0xF0)) {
            return { ok: false, message: `${fw} MT() holds left or right modifiers, not both. Pick one side.` };
        }
    }
    const isStudio = adapter === 'zmk-studio';
    let entryId, params;
    if (hold.kind === 'layer') {
        entryId = 'layer-tap';
        params = { layer: hold.layer, tap: tap.key, ...(tapMods ? { tapMods } : {}) };
    } else {
        entryId = 'mod-tap';
        params = hold.kind === 'key'
            ? { hold: 0, holdKey: keyToUsage(hold.key, hold.mods ?? 0), tap: tap.key, ...(tapMods ? { tapMods } : {}) }
            : { hold: hold.mods & 0xFF, tap: tap.key, ...(tapMods ? { tapMods } : {}) };
        if (isStudio) params.live = liveSideFor(hand);
    }
    if (!qmkLike) params.timing = timing ?? TIMING_PARAM.default;
    let value;
    try { value = encode(entryId, params, adapter); } catch {
        return { ok: false, message: `This keyboard has no ${entryId === 'layer-tap' ? 'layer-tap' : 'mod-tap'} behavior for this slot.` };
    }
    const bid = adapter === 'zmk-typed' ? value.behaviorId : value?.behaviorId;
    const via = qmkLike ? (entryId === 'layer-tap' ? 'LT()' : 'MT()') : behaviorsNow().get(bid)?.displayName ?? '';
    return { ok: true, value, entryId, params, via };
}

/** A decoded mod-tap / layer-tap → composer spec ({tap, hold}); a plain key
 * → {tap, hold: null}; anything else → null. */
export function tapHoldSpecOf(binding, adapter) {
    let d;
    try { d = decode(binding, adapter); } catch { return null; }
    const p = d.params;
    if (d.entryId === 'key') return { tap: { key: p.key, mods: p.mods ?? 0 }, hold: null };
    if (d.entryId === 'layer-tap') return { tap: { key: p.tap, mods: p.tapMods ?? 0 }, hold: { kind: 'layer', layer: p.layer }, timing: p.timing };
    if (d.entryId === 'mod-tap') {
        const hold = p.holdKey != null ? { kind: 'key', ...usageToKey(p.holdKey) } : { kind: 'mods', mods: p.hold };
        return { tap: { key: p.tap, mods: p.tapMods ?? 0 }, hold, timing: p.timing };
    }
    return null;
}

/**
 * Home-row mods preset. `keys` = 8 positions [{pos, x, binding}] in any
 * order; sorted by x, the left four get `order` pinky→index (GACS: pinky ⌘,
 * ring ⌥, middle ⌃, index ⇧) as left mods, the right four the mirror as
 * right mods. Each keeps its current key (or current tap) as TAP.
 * @param {'GACS'|'CAGS'|string} order  four letters of C S A G
 * @returns {{ok:true, plan:{pos:*, value:*, hand:string}[]}|{ok:false, message:string}}
 */
export function homeRowPlan(keys, order, adapter, { timing } = {}) {
    if (keys.length !== 8) return { ok: false, message: `Pick 8 home keys (${keys.length} picked).` };
    const bits = [...String(order).toUpperCase()].map((c) => MOD_LETTER[c]);
    if (bits.length !== 4 || bits.some((b) => !b) || new Set(bits).size !== 4) return { ok: false, message: `Unknown mod order ${order}.` };
    const sorted = [...keys].sort((a, b) => a.x - b.x);
    const left = sorted.slice(0, 4), right = sorted.slice(4).reverse();
    const plan = [];
    for (const [hand, list] of [['left', left], ['right', right]]) {
        for (let i = 0; i < 4; i++) {
            const k = list[i];
            const spec = tapHoldSpecOf(k.binding, adapter);
            if (!spec) return { ok: false, message: `Key ${JSON.stringify(k.pos)} has no plain key to keep as the tap.` };
            const mods = hand === 'left' ? bits[i] : bits[i] << 4;
            const r = composeTapHold({ tap: spec.tap, hold: { kind: 'mods', mods }, hand, timing }, adapter);
            if (!r.ok) return { ok: false, message: `Key ${JSON.stringify(k.pos)}: ${r.message}` };
            plan.push({ pos: k.pos, value: r.value, hand });
        }
    }
    return { ok: true, plan };
}

/** Keys-group grid sections (§4.5), the same for every adapter:
 * [{id, label, keys: [{key, mods, label, cap}]}]. `key` is the Key entry's
 * key param (HID usage id); Shifted symbols carry mods ⇧. */
export function keySections() {
    const K = (list, mods = 0) => list.map((k) => ({ key: k.code & 0xFF, mods, label: k.label, cap: k.cap }));
    const inR = (lo, hi) => basicKeys.filter((k) => k.code >= lo && k.code <= hi);
    return [
        { id: 'letters', label: 'Letters', keys: K(inR(0x04, 0x1D)) },
        { id: 'numbers', label: 'Numbers', keys: K(inR(0x1E, 0x27)) },
        { id: 'editing', label: 'Editing & Punctuation', keys: K(inR(0x28, 0x39)) },
        { id: 'modifiers', label: 'Modifiers', keys: K(inR(0xE0, 0xE7)) },
        { id: 'nav', label: 'Navigation', keys: K(navKeys) },
        { id: 'function', label: 'Function', keys: K(fKeys) },
        { id: 'numpad', label: 'Numpad', keys: K(numpadKeys) },
        { id: 'intl', label: 'International', keys: K(intlKeys) },
        { id: 'shifted', label: 'Shifted symbols', keys: K(shiftedSymbols, 0x02) },
    ];
}
