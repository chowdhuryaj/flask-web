// Desktop HUD overlay: corner placement on the cursor's display (incl. the
// laptop + externals layouts, negative origins, tiny displays) and settings
// persistence (round trip, garbage and missing files fall back to defaults).
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

// Settings: defaults, sanitizing, round trip, bad files.
assert.deepEqual(P.sanitize(null), { ...P.DEFAULTS }); checks++;
assert.deepEqual(P.sanitize({ shown: 'yes', corner: 'middle', width: 999, opacity: 2 }), { ...P.DEFAULTS }); checks++;
assert.equal(P.DEFAULTS.width, 380); checks++;
const dir = mkdtempSync(join(tmpdir(), 'hud-prefs-'));
try {
    const f = join(dir, 'hud.json');
    assert.deepEqual(P.load(f), { ...P.DEFAULTS }); checks++;              // missing file
    const mine = { shown: true, corner: 'top-left', width: P.SIZES.Large, opacity: 0.55 };
    P.save(f, mine);
    assert.deepEqual(P.load(f), mine); checks++;
    writeFileSync(f, '{not json');
    assert.deepEqual(P.load(f), { ...P.DEFAULTS }); checks++;
    writeFileSync(f, JSON.stringify({ shown: true, corner: 'nowhere' }));
    assert.deepEqual(P.load(f), { ...P.DEFAULTS, shown: true }); checks++;  // keeps the valid half
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log(`hud-prefs: ${checks} checks passed`);
