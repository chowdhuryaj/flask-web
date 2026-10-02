// Final-verify F3/F4: ZMK keymap import gates.
import assert from 'node:assert/strict';

const toasts = [];
const node = () => ({ setAttribute() {}, addEventListener() {}, append() {}, remove() {} });
globalThis.document = {
    createElement: node, createTextNode: (t) => ({ t }), querySelector: () => null,
    body: { append: (t) => toasts.push(t.textContent) },
};
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// F3: importKeymap applies module state only after a clean keymap import.
{
    const { ZmkKeymapTab } = await import('../zmk-keymap-tab.js?v=60');
    const run = async (r) => {
        let paused = 0;
        const t = Object.create(ZmkKeymapTab.prototype);
        t.applyKeymapData = async () => r;
        t.app = { flask: {}, caps: { flask: true }, hid: { pause: () => paused++, resume() {} } };
        await t.importKeymap({ text: async () => JSON.stringify({ flask: { accel: {} } }) });
        return paused;
    };
    eq(await run(null), 0, 'refused import: no module state');
    eq(await run({ stopped: true, wrote: 2 }), 0, 'stopped import: no module state');
    eq(await run({ wrote: 2 }), 1, 'clean import: module state applies');
}

console.log(`zmk-import-test: ${checks} checks OK`);
