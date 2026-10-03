// Desktop HUD overlay: corner placement on the cursor's display (incl. the
// laptop + externals layouts, negative origins, tiny displays), the dragged
// anchor (corner + offset) carried across displays, and settings persistence
// (round trip, slider vs preset opacity, garbage and missing files).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const P = require('../desktop/hud-prefs.js');

let checks = 0;
const size = { width: 380, height: 220 };
const laptop = { x: 0, y: 25, width: 1512, height: 920 };          // menu bar takes 25
const leftExt = { x: -2560, y: -300, width: 2560, height: 1415 };   // external left of + above the laptop

// Each corner sits MARGIN px inside the workArea.
const at = (wa, c) => P.cornerBounds(wa, size, c);
assert.deepEqual(at(laptop, 'top-left'), { x: 12, y: 37, width: 380, height: 220 }); checks++;
assert.deepEqual(at(laptop, 'top-right'), { x: 1512 - 380 - 12, y: 37, width: 380, height: 220 }); checks++;
assert.deepEqual(at(laptop, 'bottom-left'), { x: 12, y: 25 + 920 - 220 - 12, width: 380, height: 220 }); checks++;
assert.deepEqual(at(laptop, 'bottom-right'), { x: 1120, y: 713, width: 380, height: 220 }); checks++;

// Same corner on another display = same offsets from that display's edges,
// negative origins included.
const r = at(leftExt, 'bottom-right');
assert.equal(r.x + r.width + 12, leftExt.x + leftExt.width); checks++;
assert.equal(r.y + r.height + 12, leftExt.y + leftExt.height); checks++;
assert.equal(at(leftExt, 'top-left').x, -2548); checks++;

// Every corner stays fully on its display, even one smaller than the HUD.
for (const wa of [laptop, leftExt, { x: 100, y: 0, width: 300, height: 150 }]) {
    for (const c of P.CORNERS) {
        const b = at(wa, c);
        assert.ok(b.x >= wa.x && b.y >= wa.y, `${c} off the top/left of ${JSON.stringify(wa)}`);
        assert.ok(b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height,
            `${c} off the bottom/right of ${JSON.stringify(wa)}`);
        checks += 2;
    }
}

// Dragged placement: anchorOf picks the corner nearest the HUD's centre and
// its offsets; cornerBounds puts it back at the same spot.
const anchored = (wa, b) => { const a = P.anchorOf(wa, b); return P.cornerBounds(wa, b, a.corner, { x: a.offsetX, y: a.offsetY }); };
const dropped = { x: 1512 - 380 - 200, y: 25 + 920 - 220 - 90, width: 380, height: 220 };
assert.deepEqual(P.anchorOf(laptop, dropped), { corner: 'bottom-right', offsetX: 200, offsetY: 90 }); checks++;
assert.deepEqual(anchored(laptop, dropped), dropped); checks++;
assert.deepEqual(P.anchorOf(laptop, { x: 300, y: 100, width: 380, height: 220 }),
    { corner: 'top-left', offsetX: 300, offsetY: 75 }); checks++;
assert.deepEqual(P.anchorOf(leftExt, { x: -2560 + 40, y: -300 + 1415 - 220 - 50, width: 380, height: 220 }),
    { corner: 'bottom-left', offsetX: 40, offsetY: 50 }); checks++;
// Hanging off an edge counts as 0 offset (re-placing pulls it on-screen).
assert.equal(P.anchorOf(laptop, { x: 1300, y: 800, width: 380, height: 220 }).offsetX, 0); checks++;

// The same anchor on another display: same distances from that display's
// edges. DIP bounds, so a 2x Retina laptop and a 1x external agree.
const anchor = { corner: 'bottom-right', offsetX: 200, offsetY: 90 };
const onExt = P.cornerBounds(leftExt, size, anchor.corner, { x: anchor.offsetX, y: anchor.offsetY });
assert.equal(leftExt.x + leftExt.width - (onExt.x + onExt.width), 200); checks++;
assert.equal(leftExt.y + leftExt.height - (onExt.y + onExt.height), 90); checks++;
const retina = { scaleFactor: 2, workArea: { x: 0, y: 25, width: 1512, height: 920 } };
const plain = { scaleFactor: 1, workArea: { x: 1512, y: 0, width: 1920, height: 1055 } };
for (const d of [retina, plain]) {
    const b = P.cornerBounds(d.workArea, size, 'top-right', { x: 50, y: 40 });
    assert.equal(d.workArea.x + d.workArea.width - (b.x + b.width), 50, `scale ${d.scaleFactor}`);
    assert.equal(b.y - d.workArea.y, 40, `scale ${d.scaleFactor}`);
    assert.deepEqual(P.anchorOf(d.workArea, b), { corner: 'top-right', offsetX: 50, offsetY: 40 });
    checks += 3;
}
// A big offset from a big display is clamped on a small one: fully on-screen.
const small = { x: 0, y: 0, width: 800, height: 500 };
for (const c of P.CORNERS) {
    const b = P.cornerBounds(small, size, c, { x: 2000, y: 900 });
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 800 && b.y + b.height <= 500, `${c} clamped`);
    checks++;
}

// Settings: defaults, sanitizing, round trip, bad files.
assert.deepEqual(P.sanitize(null), { ...P.DEFAULTS }); checks++;
assert.deepEqual(P.sanitize({ shown: 'yes', corner: 'middle', width: 'big', opacity: 'x', offsetX: -5 }),
    { ...P.DEFAULTS, offsetX: 0 }); checks++;
// Width (grip resize) and opacity (slider) clamp to their ranges.
assert.equal(P.sanitize({ width: 999 }).width, 900); checks++;
assert.equal(P.sanitize({ width: 100 }).width, 240); checks++;
assert.equal(P.sanitize({ width: 517.4 }).width, 517); checks++;
assert.equal(P.sanitize({ opacity: 2 }).opacity, 1); checks++;
assert.equal(P.sanitize({ opacity: 0.1 }).opacity, 0.3); checks++;
assert.equal(P.sanitize({ opacity: 0.4500001 }).opacity, 0.45); checks++;
assert.equal(P.DEFAULTS.width, 380); checks++;
const dir = mkdtempSync(join(tmpdir(), 'hud-prefs-'));
try {
    const f = join(dir, 'hud.json');
    assert.deepEqual(P.load(f), { ...P.DEFAULTS }); checks++;              // missing file
    const mine = { shown: true, corner: 'top-left', offsetX: 140, offsetY: 30, width: P.SIZES.Large, opacity: 0.55 };
    P.save(f, mine);
    assert.deepEqual(P.load(f), mine); checks++;
    // Slider value (not a preset) persists as is; a preset still matches its menu value.
    P.save(f, { ...mine, opacity: 0.4 });
    assert.equal(P.load(f).opacity, 0.4); checks++;
    P.save(f, { ...mine, opacity: 0.7 });
    assert.ok(P.OPACITIES.includes(P.load(f).opacity)); checks++;
    writeFileSync(f, '{not json');
    assert.deepEqual(P.load(f), { ...P.DEFAULTS }); checks++;
    writeFileSync(f, JSON.stringify({ shown: true, corner: 'nowhere' }));
    assert.deepEqual(P.load(f), { ...P.DEFAULTS, shown: true }); checks++;  // keeps the valid half
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log(`hud-prefs: ${checks} checks passed`);
