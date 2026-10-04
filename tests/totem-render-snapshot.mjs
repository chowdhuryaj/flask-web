// The Totem (ZMK) legend / picker / dock / inspector-model output as plain
// JSON, so the QMK adapter work can prove the ZMK paths are unchanged.
// qmk-keymap-test.mjs compares this against tests/fixtures/totem-render.json,
// (one sha256 per section: a layer's keys, a picker surface, the dock, the
// layer index), written BEFORE the QMK adapter landed:
//   node --no-warnings tests/totem-render-snapshot.mjs --write
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=79');
const { setZmkContext } = await import('../zmk-keycodes.js?v=79');
const { legendOf } = await import('../legend.js?v=79');
const cat = await import('../behavior-catalog.js?v=79');
const { SURFACES, surfaceEntries } = await import('../binding-picker.js?v=79');
const { dockModel } = await import('../keymap-dock.js?v=79');
const { inspectorModel } = await import('../keymap-inspector.js?v=79');
const { layerIndex } = await import('../keymap-layers.js?v=79');

export function totemRender() {
    const behaviors = new Map(TOTEM_DEFAULT.behaviors.map((b) => [b.id, b]));
    const layers = TOTEM_DEFAULT.layers.map((l, i) => ({ id: i, name: l.name }));
    setZmkContext({ behaviors, layers });
    const out = { keys: [], surfaces: {}, dock: null, layers: null };
    for (const [li, layer] of TOTEM_DEFAULT.layers.entries()) {
        for (const [pos, [behaviorId, param1, param2]] of layer.bindings.entries()) {
            const b = { behaviorId, param1, param2 };
            const safe = (fn) => { try { return fn(); } catch (e) { return `throw ${e.message}`; } };
            const d = safe(() => cat.decode(b, 'zmk-studio'));
            out.keys.push({ li, pos, legend: legendOf(b), cap: safe(() => cat.capParts(b)), text: safe(() => cat.describeBinding(b)),
                ht: safe(() => cat.holdTapParts(b)), d, enc: d?.entryId ? safe(() => cat.encode(d.entryId, d.params, 'zmk-studio')) : null,
                insp: safe(() => { const m = inspectorModel(b); return { ...m, spec: m.spec }; }) });
        }
    }
    for (const s of Object.keys(SURFACES)) out.surfaces[s] = JSON.parse(JSON.stringify(surfaceEntries(s, {})));
    out.dock = JSON.parse(JSON.stringify(dockModel(surfaceEntries('zmk.key', {}), cat.keySections())));
    out.layers = layerIndex({
        layers: TOTEM_DEFAULT.layers.map((l, index) => ({ index, id: index, name: l.name })),
        keys: TOTEM_DEFAULT.layers[0].bindings.map((_, col) => ({ row: 0, col })),
        bindingAt: (l, s) => { const [behaviorId, param1, param2] = TOTEM_DEFAULT.layers[l].bindings[s.col]; return { behaviorId, param1, param2 }; },
    });
    return JSON.parse(JSON.stringify(out));
}

/** Section → sha256 of its JSON. */
export function totemRenderHashes(r = totemRender()) {
    const h = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    const out = {};
    for (const li of new Set(r.keys.map((k) => k.li))) out[`layer ${li}`] = h(r.keys.filter((k) => k.li === li));
    for (const [s, v] of Object.entries(r.surfaces)) out[`surface ${s}`] = h(v);
    out.dock = h(r.dock);
    out.layers = h(r.layers);
    return out;
}

if (process.argv.includes('--write')) {
    writeFileSync(new URL('./fixtures/totem-render.json', import.meta.url), JSON.stringify(totemRenderHashes(), null, 1) + '\n');
    console.log('wrote tests/fixtures/totem-render.json');
}
