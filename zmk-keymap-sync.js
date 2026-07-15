// Keymap snapshot + diff (ZMK line) — the pure half of keymap auto-restore
// (AJ ask 2026-07-13: "keep the keyboard's keymap consistent between
// flashes with what Flask has saved"). The tab persists a snapshot of the
// layers section on every successful device SAVE; on connect a device that
// differs (settings_reset wiped the Studio overlay, fresh board) is
// restored through the existing applyKeymapData path.
//
// Zero imports on purpose: the node vector suite imports this file
// directly, so it must never touch window/localStorage at module scope —
// storage lives in zmk-keymap-tab.js.

/** The layers section of the keymap export — also the snapshot format.
 * Display name is the cross-build identity (behavior ids shift across
 * firmware builds); the id is a same-build fallback. Shape matches the
 * v2 keymap export file so applyKeymapData consumes it unchanged. */
export function keymapLayersData(keymap, behaviors) {
    return keymap.layers.map((l) => ({
        name: l.name,
        bindings: l.bindings.map((b) => ({
            behavior: behaviors.get(b.behaviorId)?.displayName ?? null,
            behaviorId: b.behaviorId,
            param1: b.param1,
            param2: b.param2,
        })),
    }));
}

/** Position-wise diff of two layers sections (snapshot vs live device).
 * Bindings match on display name when BOTH sides carry one, else on id;
 * params always compare. Layer-count mismatch is reported, not counted
 * per-key (the applier already min-bounds and notes it). */
export function diffKeymapLayers(a, b) {
    const sameBinding = (x, y) => {
        if (!x || !y) return x === y;
        const ident = (x.behavior != null && y.behavior != null)
            ? x.behavior === y.behavior
            : x.behaviorId === y.behaviorId;
        return ident
            && ((x.param1 ?? 0) >>> 0) === (((y.param1 ?? 0)) >>> 0)
            && ((x.param2 ?? 0) >>> 0) === (((y.param2 ?? 0)) >>> 0);
    };
    let keys = 0;
    let names = 0;
    const layers = Math.min(a.length, b.length);
    for (let li = 0; li < layers; li++) {
        const av = a[li].bindings ?? [];
        const bv = b[li].bindings ?? [];
        const n = Math.min(av.length, bv.length);
        for (let p = 0; p < n; p++) {
            if (!sameBinding(av[p], bv[p])) keys++;
        }
        if ((a[li].name || '') !== (b[li].name || '')) names++;
    }
    return { keys, names, layersA: a.length, layersB: b.length };
}

/** True when the diff means the device needs a restore. */
export function keymapDiffers(d) {
    return d.keys > 0 || d.names > 0 || d.layersA !== d.layersB;
}
