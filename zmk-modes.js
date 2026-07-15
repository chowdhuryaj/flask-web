// Modes store (ZMK line) — the pure half of app-side device modes.
//
// A MODE is a named snapshot of the whole device: the v2 export payload,
// unchanged (`{kind:'flask-zmk-keymap', version:2, layers:[…], flask:{…}}`).
// Same shape as an export FILE on purpose, so a mode imports/exports with no
// conversion and the two can never drift.
//
// Why app-side and not on-device: the Imprint's settings partition is 0x8000
// = 32 KB total (assimilator-bt.dts) and holds BLE bonds plus every flask blob
// (the RGB map alone is 2.1 KB) plus NVS garbage-collection headroom. The board
// has no external flash. N full copies do not fit, and every extra write goes
// through the SAVE path. So the modes live here and the device keeps ONE saved
// baseline.
//
// THE BASELINE INVERSION (the load-bearing idea): the saved baseline should be
// the mode for the environment where there is NO app — the locked-down
// workstation. The environment that HAS the app (home) is the one that gets
// live-switched. That way a mode switch never writes to flash, and a SAVE only
// happens when you deliberately re-baseline, at the desk where you can watch it.
//
// Zero imports on purpose: the node vector suite imports this file directly, so
// it must never touch window/localStorage at module scope — storage lives in
// zmk-modes-tab.js.

export const MODES_VERSION = 1;

/** Per-family so an Imprint's modes never show up under another ZMK board. */
export function modesStoreKey(family) { return `flask-zmk-modes:${family || 'zmk'}`; }

export function emptyStore() {
    return { version: MODES_VERSION, modes: [], baselineId: null };
}

/** Coerce whatever came out of storage into a usable store. Never throws — a
 * corrupt or future-version blob degrades to empty rather than breaking the
 * tab, because losing the mode LIST is recoverable (re-capture) while a dead
 * tab is not. */
export function normalizeStore(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.modes)) return emptyStore();
    const modes = raw.modes.filter((m) => m && typeof m.id === 'string' && m.data)
        .map((m) => ({
            id: m.id,
            name: typeof m.name === 'string' && m.name.trim() ? m.name : 'Untitled',
            created: m.created || null,
            data: m.data,
        }));
    const baselineId = modes.some((m) => m.id === raw.baselineId) ? raw.baselineId : null;
    return { version: MODES_VERSION, modes, baselineId };
}

export function newModeId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Names are the only handle the human has — keep them unique so "Apply" is
 * never ambiguous. Collides → "Radiology 2". */
export function uniqueModeName(store, want) {
    const base = (want || '').trim() || 'Untitled';
    const taken = new Set(store.modes.map((m) => m.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const t = `${base} ${n}`;
        if (!taken.has(t)) return t;
    }
}

export function addMode(store, name, data) {
    const mode = {
        id: newModeId(),
        name: uniqueModeName(store, name),
        created: new Date().toISOString(),
        data,
    };
    return { store: { ...store, modes: [...store.modes, mode] }, mode };
}

export function renameMode(store, id, name) {
    const others = { ...store, modes: store.modes.filter((m) => m.id !== id) };
    const clean = uniqueModeName(others, name);
    return {
        ...store,
        modes: store.modes.map((m) => (m.id === id ? { ...m, name: clean } : m)),
    };
}

export function deleteMode(store, id) {
    return {
        ...store,
        modes: store.modes.filter((m) => m.id !== id),
        // Dropping the baseline mode clears the pointer — it does NOT touch the
        // device, whose flash still holds those values. The badge would just be
        // claiming something we can no longer show.
        baselineId: store.baselineId === id ? null : store.baselineId,
    };
}

export function setBaseline(store, id) {
    return { ...store, baselineId: store.modes.some((m) => m.id === id) ? id : null };
}

export function getMode(store, id) {
    return store.modes.find((m) => m.id === id) || null;
}

/** Is this parsed JSON usable as a mode payload? Same gate applyKeymapData
 * uses, so an import can't get further than an apply would. */
export function isModePayload(data) {
    return !!data && data.kind === 'flask-zmk-keymap' && Array.isArray(data.layers);
}

/** One-line description of what a mode actually carries — the human needs to
 * know whether a snapshot has RGB and slot tables in it or is keymap-only
 * (a capture taken with no Flask HID, or an older export). */
export function modeSummary(mode) {
    const d = mode?.data || {};
    const parts = [];
    const layers = Array.isArray(d.layers) ? d.layers.length : 0;
    parts.push(`${layers} layer${layers === 1 ? '' : 's'}`);
    const f = d.flask;
    if (!f) {
        parts.push('keymap only');
    } else {
        const named = {
            rgb: 'RGB', combos: 'combos', macros: 'macros', leader: 'leader',
            gestures: 'gestures', tapDance: 'tap dance', csk: 'shift',
            autoMouse: 'auto-mouse', accel: 'accel', scrollSnap: 'snap',
            autoscroll: 'autoscroll', ballswap: 'ball swap',
        };
        const has = Object.keys(named).filter((k) => f[k] != null).map((k) => named[k]);
        parts.push(has.length ? has.join(', ') : 'module state');
    }
    return parts.join(' · ');
}
