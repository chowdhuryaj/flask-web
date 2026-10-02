// WP7: one ?v= stamp per module everywhere. "x.js" and "x.js?v=1" are two
// module instances (browser and Node alike): a split stamp splits singletons
// (app-shell regions, board, save state, ZMK context). Scans the app,
// index.html, the node tests and the browser tests.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
    ...readdirSync(ROOT).filter((f) => /\.(js|mjs|html)$/.test(f)),
    ...readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.mjs') && f !== 'stamps-test.mjs').map((f) => 'tests/' + f),
    ...readdirSync(join(ROOT, 'tests/browser')).filter((f) => f.endsWith('.py')).map((f) => 'tests/browser/' + f),
];
// A quoted local path with a ./ ../ / prefix or a stamp. Bare unstamped names
// are filesystem paths or prose, not imports.
const RE = /(['"`])((?:\.\.?\/|\/)?)((?:css\/|vendor\/)?[A-Za-z0-9_-]+\.(?:js|css))(\?v=[0-9]+)?\1/g;

export function stampUses(read = (f) => readFileSync(join(ROOT, f), 'utf8'), list = files) {
    const uses = new Map();   // module → Map(stamp → [file:line])
    for (const f of list) {
        read(f).split('\n').forEach((line, i) => {
            for (const [, , pre, path, stamp] of line.matchAll(RE)) {
                if (!existsSync(join(ROOT, path)) || (!pre && !stamp)) continue;
                const s = stamp || '(none)';
                if (!uses.has(path)) uses.set(path, new Map());
                const m = uses.get(path);
                if (!m.has(s)) m.set(s, []);
                m.get(s).push(`${f}:${i + 1}`);
            }
        });
    }
    return uses;
}

export function splits(uses) {
    return [...uses].filter(([, m]) => m.size > 1)
        .map(([p, m]) => `${p}: ` + [...m].map(([s, at]) => `${s} at ${at.slice(0, 3).join(', ')}`).join(' | '));
}

let checks = 0;
// The checker catches a split (self-test on synthetic sources).
const fake = { 'a.js': "import { shell } from './app-shell.js?v=2';", 'b.js': "import { shell } from './app-shell.js?v=1';" };
assert.equal(splits(stampUses((f) => fake[f], Object.keys(fake))).length, 1, 'checker misses a split stamp'); checks++;
const fake2 = { 'a.js': "import x from '../board.js';", 'b.js': "import x from './board.js?v=3';" };
assert.equal(splits(stampUses((f) => fake2[f], Object.keys(fake2))).length, 1, 'checker misses unstamped vs stamped'); checks++;

const uses = stampUses();
assert.ok(uses.size > 50, `only ${uses.size} modules found`); checks++;
const bad = splits(uses);
assert.deepEqual(bad, [], 'modules imported under two stamps:\n' + bad.join('\n')); checks++;
console.log(`stamps-test: ${checks} checks OK (${uses.size} modules)`);
