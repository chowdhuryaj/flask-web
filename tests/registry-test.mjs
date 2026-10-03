// tab-registry.js: ids and order per workspace equal the pre-redesign
// buildTabs (tests/fixtures/tabs-before-wp0.json, generated from aa6edd9;
// trimmed to the ZMK boards and the standalone trainer), and every §1.3 tab
// id has its §1.3 group.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zmkCapabilities } from '../zmk.js?v=67';
import { TAB_TABLE, TAB_GROUPS, tabsFor, groupOf } from '../tab-registry.js?v=67';

const before = JSON.parse(readFileSync(new URL('./fixtures/tabs-before-wp0.json', import.meta.url)));
// Deliberate changes from §1.3; anything else differing is a regression.
const RELABEL = { 'zmk-shift': 'Mod Morph' };
// WP7 added Behaviour › Hold timing on ZMK boards with flask_holdtap (caps.holdtap).
const WP7_NEW = new Set(['zmk-holdtiming']);
let checks = 0;

for (const [ws, tabs] of Object.entries(before)) {
    if (ws.includes('@')) continue;
    const app = ws === 'trainerOnly' ? { trainerOnly: true }
        : { family: ws.split('-')[0], caps: zmkCapabilities(ws.split('-')[0], before[`${ws}@version`]) };
    // WP1 added Device › Keyboard (spec §1.3); everything else is unchanged.
    const now = tabsFor(app).filter((t) => t.id !== 'keyboard' && !WP7_NEW.has(t.id));
    assert.deepEqual(now.map((t) => t.id), tabs.map((t) => t[0]), `${ws}: tab ids/order`);
    for (const [i, [id, label, group]] of tabs.entries()) {
        assert.equal(now[i].label, RELABEL[id] ?? label, `${ws}/${id}: label`);
        assert.equal(now[i].group, group, `${ws}/${id}: group`);
        assert.equal(typeof now[i].ctor, 'function', `${ws}/${id}: ctor`);
        checks += 4;
    }
}

// §1.3 destination groups for every tab id.
const SPEC_1_3 = {
    'zmk-keymap': 'keys', gestures: 'device', mouse: 'device',
    trainer: 'trainer', rgb: 'device',
    'zmk-combos': 'behaviour', 'zmk-macros': 'behaviour', 'zmk-tapdance': 'behaviour',
    'zmk-shift': 'behaviour', 'zmk-leader': 'behaviour', 'zmk-modes': 'device', 'zmk-test': 'device',
    keyboard: 'device',
    'zmk-holdtiming': 'behaviour', 'zmk-adaptive': 'behaviour',
};
const groupIds = new Set(TAB_GROUPS.map((g) => g.id));
for (const [id, group] of Object.entries(SPEC_1_3)) {
    assert.ok(TAB_TABLE.some((t) => t.id === id), `${id} missing from TAB_TABLE`);
    assert.equal(groupOf(id), group, `${id}: §1.3 group`);
    checks += 2;
}
for (const t of TAB_TABLE) {
    assert.ok(groupIds.has(t.group), `${t.id}: unknown group ${t.group}`);
    assert.ok(t.id in SPEC_1_3, `${t.id}: not in the §1.3 table`);
    checks += 2;
}
// WP1: Device › Keyboard is last in every non-trainer workspace.
for (const ws of Object.keys(before)) {
    if (ws.includes('@') || ws === 'trainerOnly') continue;
    const app = { family: ws.split('-')[0], caps: zmkCapabilities(ws.split('-')[0], before[`${ws}@version`]) };
    const all = tabsFor(app);
    assert.equal(all.at(-1).id, 'keyboard', `${ws}: keyboard tab last`);
    assert.equal(all.at(-1).group, 'device'); checks += 2;
}
// WP7: Hold timing only with caps.holdtap (proto >= 17 and 0x2A answering,
// probed by main.js), on ZMK only, right after Leader.
{
    const caps = (fam, ht) => ({ ...zmkCapabilities(fam, 17), holdtap: ht });
    const beh = (fam, ht) => tabsFor({ family: fam, caps: caps(fam, ht) }).filter((t) => t.group === 'behaviour').map((t) => t.id);
    assert.ok(beh('totem', true).includes('zmk-holdtiming')); checks++;
    assert.equal(beh('totem', true).at(-1), 'zmk-holdtiming'); checks++;
    assert.ok(!beh('totem', false).includes('zmk-holdtiming')); checks++;
    assert.ok(!beh('imprint', undefined).includes('zmk-holdtiming')); checks++;
    assert.ok(!beh('generic', true).includes('zmk-holdtiming'), 'never without a ZMK family'); checks++;
    assert.equal(TAB_TABLE.find((t) => t.id === 'zmk-holdtiming').label, 'Hold timing'); checks++;
}
// flask_adaptive: Behaviour › Adaptive only with caps.adaptive (main.js probes GET 2B 02), ZMK only,
// next to Shift Keys.
{
    const beh = (fam, ak) => tabsFor({ family: fam, caps: { ...zmkCapabilities(fam, 18), adaptive: ak } })
        .filter((t) => t.group === 'behaviour').map((t) => t.id);
    assert.ok(beh('totem', true).includes('zmk-adaptive')); checks++;
    assert.equal(beh('totem', true)[beh('totem', true).indexOf('zmk-shift') + 1], 'zmk-adaptive', 'right after Mod Morph'); checks++;
    assert.ok(!beh('totem', false).includes('zmk-adaptive')); checks++;
    assert.ok(!beh('imprint', undefined).includes('zmk-adaptive')); checks++;
    assert.ok(!beh('generic', true).includes('zmk-adaptive'), 'never without a ZMK family'); checks++;
    const t = TAB_TABLE.find((u) => u.id === 'zmk-adaptive');
    assert.equal(t.label, 'Adaptive'); assert.equal(t.screen, 'behaviours'); checks += 2;
}
assert.deepEqual(tabsFor({ trainerOnly: true }).map((t) => t.id), ['trainer']); checks++;
// Rows sharing an id must agree on label and group.
for (const t of TAB_TABLE) {
    const first = TAB_TABLE.find((u) => u.id === t.id);
    assert.equal(t.label, first.label); assert.equal(t.group, first.group); checks += 2;
}
console.log(`registry-test: ${checks} checks OK`);
