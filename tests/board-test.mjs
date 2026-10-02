// WP2 board checks that need no DOM: cap splitting, geometry (rotation),
// selection, auto-advance, undo/redo, position-pick mode. The drawn SVG and
// popover are covered by tests/browser/board.py.
import assert from 'node:assert/strict';
import { Board, baseUnit, keyCorners, layoutOf, frameCentre, splitCap, capPartsOf, fitText, DRAG_TYPE } from '../board.js?v=61';
import { setZmkContext, bindingCap, bindingHover } from '../zmk-keycodes.js?v=61';
import { TOTEM_DEFAULT } from '../zmk-totem-default.js?v=61';
import { TOTEM_GEOM } from '../zmk-totem-layout.js?v=61';

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
}

// ---- TOTEM default bindings: no "(" fragments in either line ----
{
    const behaviors = new Map(TOTEM_DEFAULT.behaviors.map((b) => [b.id, b]));
    setZmkContext({ behaviors, layers: TOTEM_DEFAULT.layers.map((l, i) => ({ id: i, name: l.name })) });
    const profile = { family: 'totem', keys: [], labelFor: bindingCap, hoverFor: bindingHover, capAdapter: 'zmk-studio' };
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
    const map = [[10, 11, 12], [20, 21, 22]];
    const writes = [];
    const adapter = {
        surface: 'zmk.key', app: {}, profile: { family: 'x', keys },
        layers: () => map.map((_, index) => ({ index, name: `L${index}`, empty: false })),
        bindingAt: (l, s) => map[l][s.col],
        async write(l, s, v) { writes.push([l, s.kind, v]); map[l][s.col] = v; },
        posOf: (s) => s.col,
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
        surface: 'zmk.key', app: {}, profile: { family: 'x', keys },
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

// ---- WP3b: handOf, positions, bindingOf, assignMany = one undo step ----
{
    const keys = [0, 1, 2, 3, 6, 7, 8, 9].map((x, c) => ({ row: 0, col: c, x, y: 0, w: 1, h: 1 }));
    const map = [[4, 22, 7, 9, 13, 14, 15, 51]];
    const adapter = {
        surface: 'zmk.key', app: {}, profile: { family: 'x', keys },
        layers: () => [{ index: 0, name: 'base', empty: false }],
        bindingAt: (l, s) => map[l][s.col], async write(l, s, v) { map[l][s.col] = v; }, posOf: (s) => s.col,
        selOf: (p) => (Number.isInteger(p) ? { kind: 'key', row: 0, col: p } : null),
    };
    const b = new Board();
    b.bind(adapter);
    eq(b.handOf(0), 'left'); eq(b.handOf(3), 'left'); eq(b.handOf(4), 'right'); eq(b.handOf(99), null);
    eq(b.positions().map((p) => p.binding), map[0]);
    b.select({ kind: 'key', row: 0, col: 3 });
    eq(b.bindingOf(), 9);
    eq(await b.assignMany([{ pos: 0, value: 0x2804 }, { pos: 7, value: 0x3833 }]), true);
    eq([map[0][0], map[0][7]], [0x2804, 0x3833]);
    await b.undo();
    eq([map[0][0], map[0][7]], [4, 51], 'one undo restores the whole batch');
    await b.redo();
    eq([map[0][0], map[0][7]], [0x2804, 0x3833], 'redo reapplies it');
}

// ---- look-shell: jumpTo (Layers index), dropOn (drag a tile onto a key), click-again is harmless ----
{
    const keys = [0, 1, 2].map((c) => ({ row: 0, col: c, x: c, y: 0, w: 1, h: 1 }));
    const map = [[10, 11, 12], [20, 21, 22]];
    const adapter = {
        surface: 'zmk.key', app: {}, profile: { family: 'x', keys },
        layers: () => map.map((_, index) => ({ index, name: `L${index}`, empty: false })),
        bindingAt: (l, s) => map[l][s.col], async write(l, s, v) { map[l][s.col] = v; }, posOf: (s) => s.col,
        selOf: (p) => (Number.isInteger(p) ? { kind: 'key', row: 0, col: p } : null),
    };
    const b = new Board();
    b.bind(adapter);
    const seen = [];
    b.addEventListener('select', (e) => seen.push(e.detail));
    ok(b.jumpTo(1, 2), 'jumpTo works');
    eq(b.layer, 1); eq(b.selectedKey(), { layer: 1, pos: 2 }, 'jump shows the layer and selects the key');
    eq(seen.at(-1), { layer: 1, pos: 2 }, 'a select event fires');
    eq(b.jumpTo(0, 99), false, 'unknown position: refused');
    ok(DRAG_TYPE.startsWith('application/'), 'drag type');
    eq(await b.dropOn({ kind: 'key', row: 0, col: 1 }, '{"v":77}'), true, 'drop a JSON binding on key 1');
    eq(map[1][1], { v: 77 }, 'dropped value written on the shown layer');
    eq(b.selectedKey(), { layer: 1, pos: 1 }, 'drop selects the target and does not advance');
    ok(b.canUndo, 'a drop is one undo step'); await b.undo(); eq(map[1][1], 21, 'undo reverts the drop');
    eq(await b.dropOn({ kind: 'key', row: 0, col: 0 }, 'not json'), false, 'bad payload ignored');
    eq(await b.dropOn({ kind: 'key', row: 0, col: 0 }, 'null'), false, 'null payload ignored');
    // Click on the selected key again: nothing opens, nothing changes (the popover is gone).
    b.select({ kind: 'key', row: 0, col: 0 });
    const n = seen.length;
    b.fit(); // no DOM: must not throw
    eq(seen.length, n, 'fit() does not touch the selection');
}

console.log(`board-test: ${checks} checks OK`);
