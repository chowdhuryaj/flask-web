// Behavior catalog: every assignable thing as one plain-language entry with
// parameters (spec §4.3–4.4). Device behaviors and QMK keycodes map onto
// entries; variants (timing, smart mode) become parameters.
//
// WP0 STUB. Exports and shapes are final for Phase 1. catalogFor returns no
// entries yet, decode/encode only pass raw values through (entry
// 'advanced'), and capParts returns today's single cap label as `main`.
// WP3 fills the table (§4.4) and the adapters.

import { capLabel } from './keycodes.js?v=49';
import { bindingCap } from './zmk-keycodes.js?v=49';
import { napeKeyLabel } from './nape-proto.js?v=49';

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
 * @property {string} key      'hold' | 'tap' | 'layer' | 'slot' | 'timing' | 'mode' | …
 * @property {'mods'|'key'|'layer'|'slot'|'choice'|'ms'} kind
 * @property {string[]} [options]               kind 'choice'
 * @property {Record<string,string>} [labels]   kind 'choice'
 * @property {number} [min] @property {number} [max] @property {number} [step]  kind 'ms'
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
 * @typedef {{entryId: string, params: object}} Decoded
 */

/**
 * Hold-tap timing parameter (AJ Q4, 2026-10-01): a per-key ms value on a
 * slider, 50–1000. Mod-tap and Layer-tap carry it as
 * `{ ...TIMING_PARAM }`. On QMK it is replaced by the global tapping term.
 * @type {CatalogParam}
 */
export const TIMING_PARAM = { key: 'timing', kind: 'ms', min: 50, max: 1000, step: 10, default: 200 };

// AJ-Q4 runtime holdtap: the seam. Today a timing value lands on the
// nearest hold-tap variant compiled into the keymap ("Mod-Tap (fast 150)",
// "Mod-Tap" = 200, "Mod-Tap (slow 300)"). When the runtime hold-tap module
// in zmk-flask-modules ships (per-slot tapping term over a new Flask
// channel; wire contract not defined yet), its backend replaces this one
// through setTimingBackend and nothing else in the picker changes.
//
// A backend maps (entryId, ms, variants) → {behaviorId, ms, exact}:
//   variants: [{behaviorId, ms}] compiled on this device for that entry
//   exact:    true when the device will run exactly `ms`
let timingBackend = (entryId, ms, variants) => {
    const v = nearestVariant(ms, variants);
    return v && { behaviorId: v.behaviorId, ms: v.ms, exact: v.ms === ms };
};

/** AJ-Q4 runtime holdtap: swap the timing backend (returns the old one). */
export function setTimingBackend(fn) { const old = timingBackend; timingBackend = fn; return old; }

/** Resolve a timing value for an entry on this device. See the seam above. */
export function resolveTiming(entryId, ms, variants) { return timingBackend(entryId, ms, variants); }

/** Nearest compiled variant by |ms − variant.ms|; a tie goes to the longer
 * one (a too-long term only delays a hold, a too-short one misfires holds). */
export function nearestVariant(ms, variants) {
    let best = null;
    for (const v of variants) {
        const d = Math.abs(v.ms - ms);
        const bd = best && Math.abs(best.ms - ms);
        if (!best || d < bd || (d === bd && v.ms > best.ms)) best = v;
    }
    return best;
}

/**
 * Entries the connected device (or offline workspace) can assign, in group
 * order. Each named device behavior maps to exactly one entry or Advanced;
 * nameless ones are hidden and counted.
 * @param {object} app  {family, caps, …}
 * @returns {CatalogEntry[]}
 */
export function catalogFor(app) { // eslint-disable-line no-unused-vars
    return []; // WP3
}

/** Which adapter a raw binding belongs to, when the caller does not say. */
export function adapterOf(binding) {
    return typeof binding === 'object' && binding && 'behaviorId' in binding ? 'zmk-studio' : 'qmk';
}

/**
 * Binding → entry + params. `adapter` is a binding-picker SURFACES adapter;
 * Nape u16 values must pass 'nape' (they look like QMK numbers).
 * @returns {Decoded}
 */
export function decode(binding, adapter = adapterOf(binding)) {
    return { entryId: 'advanced', params: { raw: binding, adapter } }; // WP3
}

/** Entry + params → binding for `adapter`. Inverse of decode. */
export function encode(entryId, params, adapter) { // eslint-disable-line no-unused-vars
    if (entryId === 'advanced') return params.raw;
    throw new Error(`encode(${entryId}): catalog entries arrive in WP3`);
}

/**
 * Keycap text split (§2.4): `top` = the hold/variant part (may be ''),
 * `main` = the tap part. WP2 draws these; WP3 makes the split real.
 * @returns {{top: string, main: string}}
 */
export function capParts(binding, adapter = adapterOf(binding)) {
    if (adapter === 'zmk-studio') return { top: '', main: bindingCap(binding) };
    if (adapter === 'nape') return { top: '', main: napeKeyLabel(binding ?? 0) };
    return { top: '', main: capLabel(binding ?? 0) };
}
