// look-shell: key legends, the Layers reverse index + lint, the palette dock
// model (ready-made layer tiles, search), the key inspector's model, and the
// four hold-tap flavour lines. All pure: no DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../behavior-catalog.js?v=63';
import { setZmkContext } from '../zmk-keycodes.js?v=63';
import { legendOf, layerCodeOf } from '../legend.js?v=63';
import { layerIndex } from '../keymap-layers.js?v=63';
import { dockModel, searchTiles, modNames, MOD_CHIPS } from '../keymap-dock.js?v=63';
import { inspectorModel, SHORTCUTS } from '../keymap-inspector.js?v=63';
import { surfaceEntries } from '../binding-picker.js?v=63';
import { FLAVOR_INFO } from '../zmk-holdtiming-card.js?v=63';

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };

const fx = JSON.parse(readFileSync(new URL('./fixtures/totem-behaviors.json', import.meta.url)));
const NAMES = ['base', 'nav', 'fn', 'num'];
const LAYERS = NAMES.map((name, id) => ({ id, name }));
setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: LAYERS });
const id = (n) => fx.behaviors.find((d) => d.displayName === n).id;
const kp = (key, mods = 0) => C.encode('key', { key, mods }, 'zmk-studio');
const F = 0x09, SHIFT = 0x02;
const shiftF = C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT }, hand: 'left' }, 'zmk-studio').value;
const navF = C.composeTapHold({ tap: { key: F }, hold: { kind: 'layer', layer: 1 } }, 'zmk-studio').value;
const mo = (l) => C.encode('hold-layer', { layer: l }, 'zmk-studio');

// ---- legends: big tap label, small sub-label, colour kind ----
{
    eq(legendOf(kp(0x04)), { main: 'A', sub: '', kind: 'plain', subKind: '' }, 'plain key');
    eq(legendOf(C.encode('trans', {}, 'zmk-studio')).kind, 'dim'); eq(legendOf(C.encode('trans', {}, 'zmk-studio')).main, '▽', 'transparent is a dim ▽, no cell triangle');
    eq(legendOf(C.encode('none', {}, 'zmk-studio')).main, '✕'); eq(legendOf(C.encode('none', {}, 'zmk-studio')).kind, 'dim');
    const mt = legendOf(shiftF);
    eq([mt.main, mt.sub, mt.kind, mt.subKind], ['F', '⇧', 'hold', 'hold'], 'mod-tap: tap big, hold amber under it');
    const lt = legendOf(navF);
    eq([lt.main, lt.sub, lt.kind, lt.subKind], ['F', 'nav', 'hold', 'layer'], 'layer-tap: hold is the layer, blue');
    const m = legendOf(mo(1));
    eq([m.main, m.sub, m.kind], ['nav', 'mo', 'layer'], 'momentary layer: name big, mo under it');
    eq(legendOf(C.encode('toggle-layer', { layer: 2 }, 'zmk-studio')).sub, 'tog');
    eq(legendOf(C.encode('to-layer', { layer: 2 }, 'zmk-studio')).sub, 'to');
    eq(legendOf(kp(0xE1)).kind, 'mod', 'a bare modifier key is amber');
    eq(legendOf(C.encode('macro', { slot: 3 }, 'zmk-studio')).kind, 'macro');
    eq([layerCodeOf('layer-tap'), layerCodeOf('hold-layer'), layerCodeOf('key')], ['lt', 'mo', null]);
}

// ---- Layers reverse index + lint ----
{
    const keys = [0, 1, 2].map((c) => ({ row: 0, col: c }));
    const trans = C.encode('trans', {}, 'zmk-studio');
    const maps = [
        [mo(1), navF, kp(4)],          // base: key 0 = mo NAV, key 1 = lt NAV
        [trans, trans, mo(2)],         // nav: key 2 = mo FN (own layer reaches FN)
        [trans, trans, trans],         // fn
        [kp(5), trans, trans],         // num: nothing turns it on
    ];
    const layers = NAMES.map((name, index) => ({ index, id: index, name, empty: false }));
    const idx = layerIndex({ layers, keys, bindingAt: (l, s) => maps[l][s.col] });
    eq(idx.rows[0].always, true, 'base is always on');
    eq(idx.rows[1].activators.map((a) => [a.layerName, a.pos, a.code]), [['base', 0, 'mo'], ['base', 1, 'lt']], 'NAV: activated by BASE key 0 &mo, key 1 &lt');
    eq(idx.rows[2].activators.map((a) => [a.layerName, a.pos, a.code]), [['nav', 2, 'mo']]);
    eq(idx.problems.map((p) => p.name), ['num'], 'only NUM is unreachable');
    ok(/no key or combo turns this layer on/.test(idx.problems[0].message), idx.problems[0].message);
    // A combo whose output is `mo FN` counts as a way in (AJ's Totem uses combos for Control, Fn, Sym).
    const viaCombo = layerIndex({ layers, keys, bindingAt: (l, s) => maps[l][s.col], combos: [{ positions: [32, 33], binding: C.encode('hold-layer', { layer: 3 }, 'zmk-studio') }] });
    eq(viaCombo.rows[3].activators.map((a) => [a.combo, a.positions, a.code]), [[true, [32, 33], 'mo']], 'NUM: activated by combo 32+33 &mo');
    eq(viaCombo.problems, [], 'a combo clears the "nothing turns it on" lint');
    eq(idx.unnamed, 0, 'no unnamed behaviours here');
    // An empty spare layer is not a problem; a layer only its own key switches to is.
    const spare = layerIndex({ layers: layers.map((l) => (l.index === 3 ? { ...l, empty: true } : l)), keys, bindingAt: (l, s) => maps[l][s.col] });
    eq(spare.problems, [], 'empty layers are not flagged');
    const selfOnly = layerIndex({ layers, keys, bindingAt: (l, s) => (l === 3 && s.col === 1 ? mo(3) : maps[l][s.col]) });
    ok(selfOnly.problems.some((p) => /only a key on num itself/.test(p.message)), 'self-reference is not a way in');
    // A layer param is a layer ID: ids that differ from array positions still map.
    const shifted = layerIndex({ layers: layers.map((l) => ({ ...l, id: l.index + 10 })), keys: [{ row: 0, col: 0 }],
        bindingAt: () => C.encode('hold-layer', { layer: 12 }, 'zmk-studio') });
    ok(shifted.rows[2].activators.length > 0, 'layer params resolve through ids');
}

// ---- palette dock model ----
{
    const entries = surfaceEntries('zmk.key', {});
    const model = dockModel(entries, C.keySections());
    eq(model.pinned.map((t) => t.id), ['trans', 'none'], 'pass-through and none are pinned');
    ok(['Letters', 'Numbers', 'Basic', 'Modifiers', 'Navigation', 'F-keys'].every((l) => model.keys.some((c) => c.label === l)), 'key categories');
    const letters = model.keys.find((c) => c.label === 'Letters');
    eq(letters.tiles.length, 26); eq(letters.tiles[0].cap, 'A');
    const layers = model.behaviours.find((c) => c.label === 'Layers');
    ok(layers, 'a Layers category');
    const n = LAYERS.length;
    const by = (sub) => layers.tiles.filter((t) => t.id.startsWith(sub + ':'));
    eq([by('hold-layer').length, by('layer-tap').length, by('toggle-layer').length, by('to-layer').length, by('one-shot-layer').length], [n, n, n, n, n],
        'mo / lt / tog / to / sl tile for every layer');
    eq(by('hold-layer').map((t) => [t.cap, t.sub]), NAMES.map((x) => [x, 'mo']), 'mo tile: layer name big, mo under it');
    const ltNav = by('layer-tap')[1];
    eq([ltNav.cap, ltNav.sub], ['A', 'nav'], 'lt tile reads "A / NAV"');
    eq(C.tapHoldSpecOf(ltNav.binding, 'zmk-studio').tap.key, 0x04, 'default tap is A');
    eq(C.tapHoldSpecOf(ltNav.build({ key: F, mods: 0 }), 'zmk-studio').tap.key, F, 'dropped on a key it keeps that key as the tap');
    eq(C.tapHoldSpecOf(ltNav.build(), 'zmk-studio').hold, { kind: 'layer', layer: 1 });
    ok(model.behaviours.some((c) => c.label === 'Key behaviours'), 'key behaviours'); 
    ok(searchTiles(model, 'nav').some((t) => t.id === 'hold-layer:1'), 'search "nav" finds the NAV tiles');
    ok(searchTiles(model, 'caps word').length > 0, 'search reaches behaviours');
    eq(searchTiles(model, '  '), [], 'blank search is empty');
    // Armed modifier chips: eight, left then right; names read like the banner.
    eq(MOD_CHIPS.map(([n]) => n), ['Ctl', 'Sft', 'Alt', 'Gui', 'RCtl', 'RSft', 'AltGr', 'RGui']);
    eq(modNames(0x01), 'Ctl'); eq(modNames(0x03), 'Ctl+Sft'); eq(modNames(0x40), 'AltGr');
    // Every tile has something to write and something to draw.
    for (const c of [...model.keys, ...model.behaviours]) for (const t of c.tiles) ok(t.kind === 'key' ? t.key != null : t.binding != null, `${c.label}/${t.id}`);
}

// ---- inspector model ----
{
    const plain = inspectorModel(kp(F));
    eq([plain.plain, plain.hasHold, plain.tap.key], [true, false, F], 'plain key: tap known, no hold');
    const mt = inspectorModel(shiftF);
    eq([mt.hasHold, mt.kind, mt.mods, mt.right, mt.tap.key], [true, 'mods', SHIFT, false, F], 'mod-tap');
    const rmt = inspectorModel(C.composeTapHold({ tap: { key: F }, hold: { kind: 'mods', mods: SHIFT << 4 }, hand: 'right' }, 'zmk-studio').value);
    eq([rmt.kind, rmt.mods, rmt.right], ['mods', SHIFT, true], 'right-hand mod-tap reads back as Right');
    const lt = inspectorModel(navF);
    eq([lt.kind, lt.layer], ['layer', 1]);
    const t = inspectorModel(C.encode('trans', {}, 'zmk-studio'));
    eq([t.tap, t.hasHold, t.legend.kind], [null, false, 'dim'], 'not a key: no tap yet');
    ok(SHORTCUTS.some(([k]) => k.includes('K')) && SHORTCUTS.some(([k]) => k.includes('Esc')), 'shortcuts listed');
}

// ---- flavours: four, each one plain line ----
{
    eq(FLAVOR_INFO.length, 4); eq(FLAVOR_INFO.length, C.HOLDTAP.FLAVORS.length, 'one per wire flavour');
    for (const f of FLAVOR_INFO) ok(f.label && f.info.length > 30 && f.info.length < 120 && !f.info.includes('\n'), f.label);
}

console.log(`lookshell-test: ${checks} checks OK`);
