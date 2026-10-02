// WP2 board checks that need no DOM: cap splitting, geometry (rotation),
// selection, auto-advance, undo/redo, position-pick mode. The drawn SVG and
// popover are covered by tests/browser/board.py.
import assert from 'node:assert/strict';
import { Board, baseUnit, keyCorners, layoutOf, frameCentre, splitCap, capPartsOf, fitText } from '../board.js?v=1';
import { capParts, describeBinding, decode } from '../behavior-catalog.js?v=1';
import { setZmkContext, bindingCap, bindingHover } from '../zmk-keycodes.js?v=49';
import { TOTEM_DEFAULT } from '../zmk-totem-default.js';
import { TOTEM_GEOM } from '../zmk-totem-layout.js';

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const near = (a, b, m = '') => ok(Math.abs(a - b) < 1e-6, `${m}: ${a} vs ${b}`);

// ---- unit formula (spec §2.4) ----
eq(baseUnit(4.75), 84, 'narrow board: 84 px per unit');
eq(baseUnit(8), 84, '8u is still narrow');
near(baseUnit(12.5), 80, 'wide board fits 1000 px');
eq(baseUnit(40), 48, 'unit never below 48');

// ---- rotation ----
{
    const k = { x: 0, y: 0, w: 2, h: 1, r: 90, rx: 1, ry: 0.5 };   // about its own centre
    const c = keyCorners(k);
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    near(Math.min(...xs), 0.5, '90° swaps width and height (x)'); near(Math.max(...xs), 1.5, 'x max');
    near(Math.min(...ys), -0.5, 'y min'); near(Math.max(...ys), 1.5, 'y max');
    // r = 0 is untouched; no rx means the key centre.
    eq(keyCorners({ x: 1, y: 1, w: 1, h: 1 }), [[1, 1], [2, 1], [2, 2], [1, 2]]);
    const same = keyCorners({ x: 1, y: 1, w: 1, h: 1, r: 90 }).flat().map((v) => +v.toFixed(6)).sort();
    eq(same, [1, 1, 1, 1, 2, 2, 2, 2].sort(), 'square about its centre keeps its footprint');
}

// ---- TOTEM: rotated thumbs stay inside the frame ----
{
    ok(TOTEM_GEOM.length === 38 && TOTEM_GEOM.some((k) => k.r), 'totem has rotated keys');
    const L = layoutOf(TOTEM_GEOM, 1);
    for (const [i, k] of TOTEM_GEOM.entries()) {
        const f = L.frame(k);
        const rot = (f.r * Math.PI) / 180;
        const pts = [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]].map(([px, py]) => [
            f.cx + (px - f.cx) * Math.cos(rot) - (py - f.cy) * Math.sin(rot),
            f.cy + (px - f.cx) * Math.sin(rot) + (py - f.cy) * Math.cos(rot)]);
        for (const [px, py] of pts) ok(px >= -1e-6 && py >= -1e-6 && px <= L.width + 1e-6 && py <= L.height + 1e-6, `key ${i} inside the frame`);
    }
    // frameCentre of a rotated key = rotation of its own centre about (rx, ry).
    const t = TOTEM_GEOM.find((k) => k.r);
    const f = L.frame(t);
    const [cx, cy] = frameCentre(f);
    ok(Math.hypot(cx - (f.x + f.w / 2), cy - (f.y + f.h / 2)) < f.w, 'rotated centre stays near the unrotated one');
}

// ---- cap splitting ----
{
    eq(splitCap('MT·A'), { top: 'MT', main: 'A' });
    eq(splitCap('MT·⌘·A'), { top: 'MT ⌘', main: 'A' });
    eq(splitCap('Esc'), { top: '', main: 'Esc' });
    eq(splitCap('·'), { top: '', main: '·' });
    // QMK: board caps follow WP3's capParts (not the legacy capLabel); the top line
    // holds the hold/mod part and the pair agrees with describeBinding.
    const samples = [0x0004, 0x0005, 0x001d, 0x0029, 0x002c, 0x0104, 0x0204, 0x0404, 0x0804, 0x1104, 0x2104, 0x2204, 0x2504, 0x2a04,
        0x4204, 0x4104, 0x4304, 0x5204, 0x5223, 0x5222, 0x7c00, 0x7700, 0x0001, 0x0000, 0x00cd, 0x00d1, 0x00a5, 0x00ab, 0x00e2, 0x2f01];
    eq(samples.length, 30);
    const qmk = { family: 'svalboard', keys: [], encoderKeys: [] };
    for (const kc of samples) {
        const hex = `0x${kc.toString(16)}`;
        const cat = capParts(kc, 'qmk'), p = capPartsOf(kc, qmk);
        eq(p, { top: cat.top.replace(/^Mod-tap\b/, 'MT'), main: cat.main }, `qmk ${hex} board parts are the catalog parts (Mod-tap shortened to MT)`);
        ok(p.main.length > 0, `main is never empty (${hex})`);
        ok(!/[()]/.test(p.top) && !/\(\w/.test(p.main), `no "(" fragment (${hex})`);
        ok(!p.top.includes('·') || /· (fast|slow)$/.test(p.top), `top is not a '·' split (${hex})`);
        const d = describeBinding(kc, 'qmk');
        ok(d.includes(p.main) || ['Nothing', 'Pass through'].includes(d) || /^Mouse|^Bootloader/.test(d), `describeBinding "${d}" carries main "${p.main}"`);
        const { entryId } = decode(kc, 'qmk');
        if (['mod-tap', 'layer-tap', 'hold-layer'].includes(entryId)) ok(p.top.length > 0, `hold part on top line (${hex})`);
        if (entryId === 'mod-tap') ok(/^MT\b/.test(p.top) && cat.top.startsWith('Mod-tap') && d.startsWith('Mod-tap'), `mod-tap top "${p.top}" matches "${d}"`);
    }
    eq(capPartsOf(0x4204, qmk), { top: 'LT L2', main: 'A' });
    eq(capPartsOf(0x2104, qmk), { top: 'MT ⌃', main: 'A' });
    eq(capPartsOf(0x2a04, qmk), { top: 'MT ⇧⌘', main: 'A' });
    eq(capPartsOf(0x5223, qmk), { top: 'Hold', main: 'L3' });
    eq(capPartsOf(0x0004, qmk), { top: '', main: 'A' });
    eq(capPartsOf(0x0104, qmk), { top: '⌃', main: 'A' });
}

// ---- TOTEM default bindings: no "(" fragments in either line ----
{
    const behaviors = new Map(TOTEM_DEFAULT.behaviors.map((b) => [b.id, b]));
    setZmkContext({ behaviors, layers: TOTEM_DEFAULT.layers.map((l, i) => ({ id: i, name: l.name })) });
    const profile = { family: 'totem', keys: [], encoderKeys: [], labelFor: bindingCap, hoverFor: bindingHover, capAdapter: 'zmk-studio' };
    let n = 0;
    for (const layer of TOTEM_DEFAULT.layers) {
        for (const [behaviorId, param1, param2] of layer.bindings) {
            const p = capPartsOf({ behaviorId, param1, param2 }, profile);
            ok(!/[()]/.test(p.top) && !/\(\w/.test(p.main), `no "(" fragment in "${p.top}" / "${p.main}"`);
            n++;
        }
    }
    ok(n === 38 * TOTEM_DEFAULT.layers.length, 'every default binding checked');
}

// ---- text fitting ----
{
    eq(fitText('A', 40, 12).lines, ['A']);
    ok(fitText('Backspace', 30, 12).fs < 12, 'long labels shrink');
    eq(fitText('Left Click', 40, 12, { maxLines: 2 }).lines, ['Left', 'Click']);
    ok(fitText('Averyveryverylongword', 30, 12, { minScale: 0.45, maxLines: 1 }).lines[0].endsWith('…'), 'still too long: ellipsis');
}

// ---- selection, assign, auto-advance, undo/redo on a fake keymap ----
{
    const keys = [0, 1, 2].map((c) => ({ row: 0, col: c, x: c, y: 0, w: 1, h: 1 }));
    const encoderKeys = [{ index: 0, clockwise: false, x: 4, y: 0, w: 1, h: 1 }];
    const map = [[10, 11, 12], [20, 21, 22]];
    const enc = [[{ ccw: 100, cw: 101 }], [{ ccw: 200, cw: 201 }]];
    const writes = [];
    const adapter = {
        surface: 'qmk.key', app: {}, profile: { family: 'x', keys, encoderKeys },
        layers: () => map.map((_, index) => ({ index, name: `L${index}`, empty: false })),
        bindingAt: (l, s) => (s.kind === 'key' ? map[l][s.col] : enc[l][s.index][s.cw ? 'cw' : 'ccw']),
        async write(l, s, v) { writes.push([l, s.kind, v]); if (s.kind === 'key') map[l][s.col] = v; else enc[l][s.index][s.cw ? 'cw' : 'ccw'] = v; },
        posOf: (s) => (s.kind === 'key' ? s.col : { encoder: s.index, dir: s.cw ? 'cw' : 'ccw' }),
        selOf: (p) => (Number.isInteger(p) ? { kind: 'key', row: 0, col: p } : null),
    };
    const b = new Board();
    const events = [];
    b.addEventListener('select', (e) => events.push(e.detail));
    eq(b.selectedKey(), null, 'nothing bound');
    b.bind(adapter);
    eq(await b.assign(1), false, 'assign with no selection is refused');
    b.select({ kind: 'key', row: 0, col: 0 });
    eq(b.selectedKey(), { layer: 0, pos: 0 });
    eq(await b.assign(99), true);
    eq(map[0][0], 99); eq(b.selectedKey().pos, 1, 'auto-advance');
    await b.assign(98, { advance: false });
    eq(b.selectedKey().pos, 1, 'advance:false stays');
    b.select({ kind: 'key', row: 0, col: 2 });
    await b.assign(97);
    eq(b.selectedKey().pos, 0, 'advance wraps after the last key');
    // undo/redo walk back and forth
    ok(b.canUndo && !b.canRedo);
    await b.undo(); eq(map[0][2], 12, 'undo last'); eq(b.selectedKey().pos, 2, 'undo reselects');
    await b.undo(); eq(map[0][1], 11, 'undo second'); await b.undo(); eq(map[0][0], 10, 'undo first');
    ok(!b.canUndo && b.canRedo);
    await b.redo(); eq(map[0][0], 99, 'redo first'); eq(await b.undo(), true);
    // a new edit clears redo
    b.select({ kind: 'key', row: 0, col: 1 }); await b.assign(5, { advance: false });
    ok(!b.canRedo, 'new edit clears redo');
    // layers
    b.setLayer(1);
    eq(b.layer, 1); eq(b.selectedKey(), null, 'layer switch clears selection');
    b.select({ kind: 'key', row: 0, col: 0 }); await b.assign(77);
    eq(map[1][0], 77, 'writes go to the current layer'); await b.undo();
    eq(map[1][0], 20); eq(b.layer, 1);
    // encoders: select, assign, no advance, undo
    b.select({ kind: 'enc', index: 0, cw: true });
    eq(b.selectedKey().pos, { encoder: 0, dir: 'cw' });
    await b.assign(555);
    eq(enc[1][0].cw, 555); eq(b.selectedKey().pos, { encoder: 0, dir: 'cw' }, 'encoder does not advance');
    await b.undo(); eq(enc[1][0].cw, 201, 'encoder undo');
    ok(events.length > 3, 'select events fire');
    // a failing write leaves history alone (toast needs a DOM, so make it refuse quietly)
    adapter.write = async () => false;
    const before = b.canUndo;
    eq(await b.assign(1), false); eq(b.canUndo, before, 'refused write is not recorded');
    // read-only refuses everything
    adapter.readOnly = true;
    eq(await b.assign(1), false); eq(await b.undo(), false);
    b.unbind(adapter);
    eq(b.selectedKey(), null);
}

// ---- pickPositions ----
{
    const keys = [0, 1, 2, 3].map((c) => ({ row: 0, col: c, x: c, y: 0, w: 1, h: 1 }));
    const adapter = {
        surface: 'zmk.key', app: {}, profile: { family: 'x', keys, encoderKeys: [] },
        layers: () => [{ index: 0, name: 'base', empty: false }],
        bindingAt: () => 0, async write() {}, posOf: (s) => s.col,
        selOf: (p) => (Number.isInteger(p) ? { kind: 'key', row: 0, col: p } : null),
    };
    const b = new Board();
    b.bind(adapter);
    b.select({ kind: 'key', row: 0, col: 2 });
    let last = null;
    const stop = b.pickPositions({ initial: [1], max: 3, label: 'Combo', onChange: (p) => { last = p; } });
    eq(b.selectedKey(), null, 'pick mode hides the selection');
    eq(await b.assign(5), false, 'assign is off in pick mode');
    stop();
    eq(b.selectedKey(), { layer: 0, pos: 2 }, 'stop() restores the selection');
    eq(last, null, 'no change event without a click');
}

console.log(`board-test: ${checks} checks OK`);
