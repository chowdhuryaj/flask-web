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
        id: l.id,
        name: l.name,
        bindings: l.bindings.map((b) => ({
            behavior: behaviors.get(b.behaviorId)?.displayName ?? null,
            behaviorId: b.behaviorId,
            param1: b.param1,
            param2: b.param2,
        })),
    }));
}

/** Pair source layers with live layers: [{si, li}] (indexes). By layer ID when
 * both sides carry ids (a reorder done elsewhere moves a layer's index, never
 * its id; a source layer the device no longer has is dropped), by index for
 * sources without ids (old snapshots, templates). */
export function pairLayers(src, live) {
    const ided = (ls) => ls.length > 0 && ls.every((l) => Number.isInteger(l?.id));
    if (!ided(src) || !ided(live)) {
        return Array.from({ length: Math.min(src.length, live.length) }, (_, i) => ({ si: i, li: i }));
    }
    const at = new Map(live.map((l, i) => [l.id, i]));
    return src.flatMap((l, si) => (at.has(l.id) ? [{ si, li: at.get(l.id) }] : []));
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
    const changed = [];     // per layer: {layer, name, positions, renamed}
    for (const { si, li } of pairLayers(a, b)) {
        const av = a[si].bindings ?? [];
        const bv = b[li].bindings ?? [];
        const n = Math.min(av.length, bv.length);
        const positions = [];
        for (let p = 0; p < n; p++) {
            if (!sameBinding(av[p], bv[p])) positions.push(p);
        }
        keys += positions.length;
        const renamed = (a[si].name || '') !== (b[li].name || '');
        if (renamed) names++;
        if (positions.length || renamed) changed.push({ layer: li, snapLayer: si, name: b[li].name || a[si].name || `Layer ${li}`, positions, renamed });
    }
    return { keys, names, layersA: a.length, layersB: b.length, changed,
        layersChanged: changed.filter((c) => c.positions.length).length };
}

/** "Keyboard differs from Totem-Flask's saved copy: N keys on M layers". */
export function keymapDiffSummary(d) {
    const parts = [`${d.keys} key${d.keys === 1 ? '' : 's'} on ${d.layersChanged} layer${d.layersChanged === 1 ? '' : 's'}`];
    if (d.names) parts.push(`${d.names} layer name${d.names === 1 ? '' : 's'}`);
    if (d.layersA !== d.layersB) parts.push(`saved copy has ${d.layersA} layers, keyboard ${d.layersB}`);
    return `Keyboard differs from Totem-Flask's saved copy: ${parts.join(', ')}`;
}

/** True when the diff means the device differs from the snapshot. */
export function keymapDiffers(d) {
    return d.keys > 0 || d.names > 0 || d.layersA !== d.layersB;
}
