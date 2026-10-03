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
    const { ZmkKeymapTab } = await import('../zmk-keymap-tab.js?v=66');
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

// F4: combo import refuses duplicate key sets (file slots, and compiled
// defaults on pre-v14 Totem), before writing any slot.
{
    const { applyFlaskState } = await import('../zmk-export.js?v=66');
    const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=66');
    const run = async (slots, { timed = true, family = 'imprint' } = {}) => {
        const writes = [];
        const app = {
            caps: { combos: true, combosTyped: true, combosTimed: timed },
            profile: { family },
            flask: {
                getU16: async () => 8, setU16: async (_c, _i, v) => v,
                setBytes: async (ch, id, p) => { writes.push(p); },
                save: async () => {},
            },
        };
        const r = await applyFlaskState(app, { combos: { slots } }, { save: false });
        return { writes: writes.length, failures: r.failures };
    };
    const c = (positions, param1 = 4) => ({ positions, action: 1, behaviorId: 0, param1, param2: 0 });
    let r = await run([c([1, 2]), c([3, 4]), c([2, 1], 5)]);
    eq(r.writes, 0, 'duplicate in file: nothing written');
    assert.match(r.failures[0], /combos: combo 2 uses the same keys as combo 0/); checks++;
    r = await run([c([1, 2]), { positions: [1, 2], action: 0 }, c([3, 4])]);
    eq([r.writes, r.failures], [3, []], 'an empty slot sharing keys is not a duplicate');
    const dt = TOTEM_DEFAULT.combos[0].positions;
    r = await run([c([...dt])], { timed: false, family: 'totem' });
    eq(r.writes, 0, 'pre-v14 Totem: duplicate of a compiled default refused');
    assert.match(r.failures[0], /compiled combo 0/); checks++;
    r = await run([c([...dt])], { timed: true, family: 'totem' });
    eq(r.failures, [], 'v14+: compiled combos are runtime slots, no default check');
}

console.log(`zmk-import-test: ${checks} checks OK`);
