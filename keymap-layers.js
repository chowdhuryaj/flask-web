// "What turns each layer on": the Layers reverse index and a small lint for
// the Keymap side panel (look-shell). Pure; node tests feed it a keymap.
//
//   layerIndex({layers, keys, bindingAt, adapter}) →
//     { rows:  [{index, id, name, always, activators:[{layer, layerName, pos, code}
//                                                    | {combo:true, positions, code}]}],
//       problems: [{index, name, message}],
//       unnamed: number of keys bound to a firmware behaviour with no name }
//
// `layers`    [{index, id?, name, empty?}] (adapter.layers(); a binding's layer
//             param is the layer ID, which is the array index unless `id` says so)
// `keys`      profile keys ({row, col}); the public position is `col`
// `bindingAt` (layerIndex, {kind:'key', row, col}) → binding
// `combos` [{positions, binding}] (Studio-shaped bindings) count as ways in too:
// AJ's Totem reaches Control, Fn and Sym through combos. Leader sequences,
// macros and unnamed firmware behaviours are not scanned (`unnamed` says how
// many keys hide one), so the lint says "nothing found", never "unreachable".

import { decode } from './behavior-catalog.js?v=64';
import { layerCodeOf } from './legend.js?v=64';

export function layerIndex({ layers, keys, bindingAt, combos = [], adapter = 'zmk-studio' }) {
    const byId = new Map(layers.map((l) => [l.id ?? l.index, l.index]));
    const rows = layers.map((l) => ({ index: l.index, id: l.id ?? l.index, name: l.name, always: l.index === 0, activators: [] }));
    let unnamed = 0;
    for (const c of combos) {
        let d;
        try { d = decode(c.binding, adapter); } catch { continue; }
        const code = layerCodeOf(d.entryId);
        const target = code && d.params.layer != null ? byId.get(d.params.layer) : null;
        if (target != null) rows[target].activators.push({ combo: true, layer: null, positions: c.positions, code });
    }
    for (const src of layers) {
        for (const k of keys) {
            let d;
            try { d = decode(bindingAt(src.index, { kind: 'key', row: k.row, col: k.col }), adapter); } catch { continue; }
            if (d.entryId === 'advanced') unnamed++;
            const code = layerCodeOf(d.entryId);
            if (!code || d.params.layer == null) continue;
            const target = byId.get(d.params.layer);
            if (target == null) continue;
            rows[target].activators.push({ layer: src.index, layerName: src.name, pos: k.col, code });
        }
    }
    const problems = [];
    for (const r of rows) {
        const l = layers[r.index];
        if (r.always || l.empty) continue;          // an empty spare layer is not a bug yet
        const outside = r.activators.filter((a) => a.combo || a.layer !== r.index);
        if (!outside.length) {
            problems.push({ index: r.index, name: r.name,
                message: r.activators.length
                    ? `${r.name}: only a key on ${r.name} itself switches to it, so nothing can reach it`
                    : `${r.name}: no key or combo turns this layer on` });
        }
    }
    return { rows, problems, unnamed };
}
