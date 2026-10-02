// Node test runner: every tests/*-test.mjs plus ../zmk-studio-test.mjs.
// No dependencies; exits non-zero if any suite fails.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [join(here, '..', 'zmk-studio-test.mjs'),
    ...readdirSync(here).filter((f) => f.endsWith('-test.mjs')).sort().map((f) => join(here, f))];
let failed = 0;
for (const s of suites) {
    const r = spawnSync(process.execPath, ['--no-warnings', s], { stdio: 'inherit' });
    if (r.status !== 0) { failed++; console.error(`FAIL ${s}`); }
}
console.log(failed ? `${failed}/${suites.length} suites failed` : `all ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
