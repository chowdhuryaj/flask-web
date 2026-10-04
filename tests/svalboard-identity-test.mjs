// Identity + routing for both firmware lines: a fake 303a:4044 device is a
// Svalboard on protocol 27 and gets the QMK tab rows; a fake 1d50:615e device
// is a ZMK board (meta 0x03) and gets the ZMK rows, unchanged. Also: the
// WebHID filters cover both VID/PIDs, QMK caps never light a ZMK row, and
// the HUD's 0x1A poll is off on the QMK line.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), key: () => null, length: 0 };

const { familyOf, familyLabel, capabilities, expectedProtocol, lineOf, HID_IDS, qmkProfile, readBoardMeta } = await import('../boards.js?v=79');
const { FlaskProto, CMD, CH_QMK, V_QMK, CH_ZMK, V } = await import('../flaskproto.js?v=79');
const { confirmZmkFamily } = await import('../zmk.js?v=79');
const { tabsFor } = await import('../tab-registry.js?v=79');

/** Fake raw-HID transport answering GETs from a table, unhandled otherwise. */
const fakeHid = (table) => ({
    request: async (frame) => {
        const [cmd, ch, id] = frame;
        const v = table[`${ch}:${id}`];
        if (cmd !== CMD.get || v == null) return [CMD.unhandled, ch, id, 0, 0];
        return [CMD.get, ch, id, v >> 8, v & 0xFF];
    },
});

// 1. WebHID filters + desktop allow-list carry both identities.
eq(HID_IDS.map((d) => `${d.vid.toString(16)}:${d.pid.toString(16)}`), ['1d50:615e', '303a:4044'], 'filter ids');
ok(readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8').includes("'303a:4044'"), 'desktop HID_ALLOW has the Svalboard');

// 2. Svalboard: 303a:4044 + meta answering v27.
const svalTable = {
    [`${CH_QMK.meta}:${V_QMK.metaProtocolVersion}`]: 27,
    [`${CH_QMK.meta}:${V_QMK.metaBoardVariant}`]: 2,
    [`${CH_QMK.meta}:${V_QMK.metaClusterKeys}`]: 5,
    [`${CH_QMK.meta}:${V_QMK.metaAbsentDrops}`]: 3,
    [`${CH_QMK.meta}:${V_QMK.metaHalf}`]: 1,
};
const sval = { family: familyOf(0x303A, 0x4044) };
eq(sval.family, 'svalboard', '303a:4044 is a Svalboard');
eq(familyLabel(sval.family), 'Svalboard');
eq(lineOf(sval.family), 'qmk');
const sp = new FlaskProto(fakeHid(svalTable));
sp.line = lineOf(sval.family);
sval.protocolVersion = await sp.handshake();
eq(sval.protocolVersion, 27, 'handshake reads protocol 27');
eq(expectedProtocol('svalboard'), 27, 'app expects v27: no reflash warning');
sval.caps = capabilities(sval.family, sval.protocolVersion);
eq(await readBoardMeta(sp, sval.caps), { variant: 2, clusterKeys: 5, absentDrops: 3, half: 1, fiveKey: true }, 'meta 0x04-0x07 into the device record');
eq(qmkProfile('svalboard', 8).matrixRows, 10);
const svalTabs = tabsFor(sval).map((t) => t.id);
eq(svalTabs, ['qmk-keymap', 'qmk-combos', 'qmk-chords', 'qmk-tapdance', 'qmk-overrides', 'qmk-leader', 'qmk-shift',
    'qmk-macros', 'qmk-typing', 'qmk-mouse', 'qmk-settings', 'trainer', 'keyboard'], 'Svalboard v27 tab rows');
for (const t of tabsFor(sval)) ok(t.screen, `${t.id} has a screen`);
ok(!svalTabs.some((id) => id.startsWith('zmk-') || ['mouse', 'gestures', 'rgb'].includes(id)), 'no ZMK row on a Svalboard');
// Removed channels stay removed: no cap for them at v27.
for (const k of ['accel', 'smoothing', 'wiggle', 'autoscroll', 'teleport', 'snippets', 'gestures', 'wheelChords', 'zmkStudio', 'macros', 'combos', 'tapDance', 'leader', 'customShift', 'rgbMap', 'ballSwap']) {
    ok(!sval.caps[k], `svalboard caps.${k} is off`);
}
// Plain Vial firmware (no Flask meta): Vial rows only.
const plain = { family: 'svalboard', caps: capabilities('svalboard', null) };
eq(tabsFor(plain).map((t) => t.id), ['qmk-keymap', 'qmk-combos', 'qmk-tapdance', 'qmk-overrides', 'qmk-macros', 'qmk-settings', 'trainer', 'keyboard'], 'stock Svalboard firmware: Vial tabs only');
// Unplugged Svalboard: tunables only (no Vial surface, no chords).
const off = { family: 'svalboard', caps: { ...capabilities('svalboard', 27), vial: false, cornerCombos: false } };
eq(tabsFor(off).map((t) => t.id), ['qmk-leader', 'qmk-shift', 'qmk-typing', 'qmk-mouse', 'trainer', 'keyboard'], 'Svalboard Unplugged tabs');

// 3. ZMK: 1d50:615e is a candidate; meta 0x03 = 6 makes it a Totem.
const zmkTable = { [`${CH_ZMK.meta}:${V.metaProtocolVersion}`]: 19, [`${CH_ZMK.meta}:${V.metaFamily}`]: 6 };
const zmk = { family: familyOf(0x1D50, 0x615E) };
eq(zmk.family, 'imprint', 'ZMK VID/PID guesses imprint until meta 0x03');
eq(lineOf(zmk.family), 'zmk');
const zp = new FlaskProto(fakeHid(zmkTable));
zp.line = 'zmk';
zmk.protocolVersion = await zp.handshake();
zmk.family = await confirmZmkFamily(zp, zmk.family);
eq([zmk.family, zmk.protocolVersion, expectedProtocol(zmk.family)], ['totem', 19, 21], 'a v19 Totem resolves; the app expects v21 (mouse keys 0x2D + start floor)');
zmk.caps = capabilities(zmk.family, zmk.protocolVersion);
const zmkTabs = tabsFor(zmk).map((t) => t.id);
eq(zmkTabs[0], 'zmk-keymap', 'ZMK still lands on its keymap');
ok(!zmkTabs.some((id) => id.startsWith('qmk-')), 'no QMK row on a ZMK board');
ok(['zmk-combos', 'zmk-macros', 'zmk-tapdance', 'zmk-shift', 'zmk-leader', 'zmk-autoshift', 'zmk-modes', 'zmk-test', 'keyboard'].every((id) => zmkTabs.includes(id)), 'ZMK rows present');
const imp = { family: 'imprint', caps: capabilities('imprint', 19) };
ok(tabsFor(imp).some((t) => t.id === 'mouse'), 'Imprint keeps its Mouse tab');
eq(familyOf(0x1234, 0x5678), 'generic', 'anything else is generic');

// 4. HUD: the 0x1A/0x25/0x27 status poll is ZMK-only.
const hud = readFileSync(new URL('../' + 'hud.js', import.meta.url), 'utf8');
ok(/!isQmkFamily\(app\.family\)\s*\n?\s*&& \(app\.caps\.autoscroll/.test(hud), 'HUD status poll gated off the QMK line');

// 5. snapshotQmkWorkspace: an unplugged link (hid.connected false) must not save.
{
    const { snapshotQmkWorkspace } = await import('../vil.js?v=79');
    const flask = { getU16: async () => { throw new Error('unplugged'); } };
    const app = { family: 'svalboard', flask, caps: capabilities('svalboard', 27), hid: { connected: false } };
    await snapshotQmkWorkspace(app);
    ok(![...mem.keys()].some((k) => /svalboard/.test(k)), 'unplugged Svalboard saves no workspace');
}

console.log(`svalboard-identity-test: ${checks} checks OK`);
