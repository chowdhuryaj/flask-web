// WP0 contracts: the shared APIs Phase 1 builds against exist with the
// Import stamps matter: "x.js" and "x.js?v=61" are two module instances in
// Node and the browser alike. Import a module with the same ?v= as the code
// under test does, or singletons (caption, board, zmk context) split.
// agreed shapes, and the parts with logic (save order, timing seam) work.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SaveState, saveState } from '../save-state.js?v=61';
import * as catalog from '../behavior-catalog.js?v=61';
import { SURFACES, openPicker, typedFromStudio } from '../binding-picker.js?v=61';
import { board } from '../board.js?v=61';
import { shell } from '../app-shell.js?v=61';
import * as caption from '../caption.js?v=61';
import { CATALOG_GROUPS } from '../behavior-catalog.js?v=61';
import { setZmkContext } from '../zmk-keycodes.js?v=61';   // same stamp as binding-picker: one module instance

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };

// ---- save-state: order, stop on first failure, re-mark during save ----
{
    const s = new SaveState();
    const ran = [];
    const saver = (id, fail) => async () => { ran.push(id); if (fail) throw new Error('boom'); };
    let changes = 0;
    s.addEventListener('change', () => changes++);
    s.markDirty(0x1A, 'Autoscroll', saver(0x1A));
    s.markDirty('studio-keymap', 'Keymap', saver('studio-keymap'));
    s.markDirty(0x10, 'Accel', saver(0x10, true));
    s.markDirty(0x05, 'DPI', saver(0x05));
    eq(s.dirty().map((d) => d.source), ['studio-keymap', 0x05, 0x10, 0x1A], 'save order');
    const r = await s.saveAll();
    eq(ran, ['studio-keymap', 0x05, 0x10], 'stops at first failure');
    eq(r.saved, ['studio-keymap', 0x05], 'saved list');
    eq(r.failed?.source, 0x10, 'failed source');
    eq(s.dirty().map((d) => d.source), [0x10, 0x1A], 'failure and later stay dirty');
    ok(changes >= 6, 'change events fire');
    // A source re-marked during its own save stays dirty.
    const t = new SaveState();
    t.markDirty(1, 'x', async () => { t.markDirty(1, 'x', async () => {}); });
    await t.saveAll();
    eq(t.dirty().length, 1, 're-marked source stays dirty');
    assert.throws(() => t.markDirty(2, 'y')); checks++;
    ok(typeof saveState.saveAll === 'function', 'singleton');
}

// ---- catalog: groups, timing seam (AJ-Q4 runtime holdtap) ----
{
    eq(CATALOG_GROUPS.map((g) => g.id), ['keys', 'modifiers', 'layers', 'mouse', 'media', 'run', 'advanced']);
    eq([catalog.TIMING_PARAM.min, catalog.TIMING_PARAM.max, catalog.TIMING_PARAM.kind], [50, 1000, 'ms']);
    const v = [{ behaviorId: 53, ms: 150 }, { behaviorId: 9, ms: 200 }, { behaviorId: 54, ms: 300 }];
    eq(catalog.nearestVariant(50, v).behaviorId, 53);
    eq(catalog.nearestVariant(1000, v).behaviorId, 54);
    eq(catalog.nearestVariant(170, v).behaviorId, 53);
    eq(catalog.nearestVariant(175, v).behaviorId, 9, 'tie goes to the longer term');
    eq(catalog.nearestVariant(250, v).behaviorId, 54, 'tie goes to the longer term');
    eq(catalog.nearestVariant(200, [v[0], v[1]]).ms, 200);
    eq(catalog.nearestVariant(300, []), null);
    eq(catalog.resolveTiming('mod-tap', 200, v), { behaviorId: 9, ms: 200, exact: true });
    eq(catalog.resolveTiming('mod-tap', 260, v), { behaviorId: 54, ms: 300, exact: false });
    const old = catalog.setTimingBackend((id, ms) => ({ behaviorId: 99, ms, exact: true }));
    eq(catalog.resolveTiming('mod-tap', 260, v), { behaviorId: 99, ms: 260, exact: true }, 'backend swap');
    catalog.setTimingBackend(old);
    for (const f of ['catalogFor', 'decode', 'encode', 'capParts', 'adapterOf']) ok(typeof catalog[f] === 'function', f);
    // Stubs: raw round trip through 'advanced'; capParts = today's label.
    const b = { behaviorId: 1, param1: 0x70004, param2: 0 };
    eq(catalog.encode(catalog.decode(b).entryId, catalog.decode(b).params), b);
    eq(catalog.adapterOf(b), 'zmk-studio'); eq(catalog.adapterOf({ action: 1, param1: 1 }), 'zmk-typed');
    const totem = JSON.parse(readFileSync(new URL('./fixtures/totem-behaviors.json', import.meta.url)));
    setZmkContext({ behaviors: new Map(totem.behaviors.map((d) => [d.id, d])), layers: [] });
    eq(catalog.capParts(b).top, ''); ok(catalog.capParts(b).main.trim().length > 0, 'zmk cap label');
    eq(typedFromStudio(b, 1), { action: 1, param1: 0x70004 });
    eq(typedFromStudio({ behaviorId: 60, param1: 3, param2: 0 }, 1), { action: 2, param1: 3 });
    eq(typedFromStudio({ behaviorId: 9, param1: 5, param2: 6 }, 1), { action: 3, behaviorId: 9, param1: 5, param2: 6 });
}

// ---- picker surfaces (§4.7) ----
{
    const groups = new Set([...CATALOG_GROUPS.map((g) => g.id), 'leader', 'tap-dance', 'mods-row']);
    for (const [id, s] of Object.entries(SURFACES)) {
        ok(['zmk-studio', 'zmk-typed'].includes(s.adapter), `${id} adapter`);
        ok(s.hide.every((h) => groups.has(h)), `${id} hide ids`);
    }
    for (const id of ['zmk.key', 'zmk.comboOutput', 'zmk.tapDanceStep', 'zmk.typedOutput', 'zmk.macroKey',
        'zmk.cskBase', 'zmk.cskShifted']) ok(id in SURFACES, `§4.7 surface ${id}`);
    ok(!Object.keys(SURFACES).some((id) => !id.startsWith('zmk.')), 'only ZMK surfaces');
    assert.throws(() => openPicker({ surface: 'nope', onPick() {} })); checks++;
}

// ---- board / shell / caption shapes ----
{
    eq(board.selectedKey(), null);
    eq(await board.assign(1), false);
    ok(typeof board.pickPositions({ onChange() {} }) === 'function', 'pickPositions → stop()');
    shell.mount({ palette: 'p' });
    eq(shell.regions.palette, 'p');
    eq(shell.selectedKey(), null);
    eq(caption.currentCaption(), caption.CAPTION_DEFAULTS.keys);
    shell.setCaption('hello'); eq(caption.currentCaption(), 'hello');
    shell.setCaption(null); caption.setCaptionGroup('device');
    eq(caption.currentCaption(), caption.CAPTION_DEFAULTS.device);
}

// ---- fixtures match the spec's counts ----
{
    const named = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}-behaviors.json`, import.meta.url)))
        .behaviors.filter((b) => b.displayName).length;
    eq(named('totem'), 39, 'TOTEM named behaviors (30 + 3 key-position and 6 virtual-slot live hold-taps, Totem-ZMK 4422ec7)'); eq(named('imprint'), 37, 'Imprint named behaviors');
}
console.log(`contracts-test: ${checks} checks OK`);
