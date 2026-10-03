// .keymap export: pure generator (zmk-dt-export.js) fed the default Totem state.
// Cross-checks every layer cell and combo against the real firmware config when
// it is on disk (Totem-ZMK/config/totem.keymap), else asserts the same bindings
// appear from the known default.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
const { TOTEM_DEFAULT: T } = await import('../zmk-totem-default.js?v=69');
const { exportKeymapText, usageToDt } = await import('../zmk-dt-export.js?v=69');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

const byId = new Map(T.behaviors.map((b) => [b.id, b]));
const data = {
    family: 'totem', device: 'TOTEM test',
    layers: T.layers.map((l, i) => ({
        id: i, name: l.name,
        bindings: l.bindings.map(([id, p1, p2]) => ({ behavior: byId.get(id).displayName, behaviorId: id, param1: p1, param2: p2 })),
    })),
    flask: { combos: { enabled: 1, timeout: 50, slots: T.combos.map((c) => ({
        positions: c.positions, action: 3, behaviorId: c.behaviorId, param1: c.param1, param2: c.param2,
        timeoutMs: c.timeoutMs, priorIdleMs: c.priorIdleMs, layer: c.layer ?? 0xFF })) } },
};
const { text, notExported } = exportKeymapText(data, {
    behaviors: T.behaviors, nodeById: (id) => byId.get(id)?.node,
    comboNameFor: (i) => T.combos[i]?.name, date: '2026-10-02',
});

// ---- shape
eq(text.split('{').length, text.split('}').length, 'braces balance');
ok(text.includes('compatible = "zmk,keymap";'), 'keymap node');
ok(text.includes('#include <dt-bindings/zmk/keys.h>'), 'keys.h');
for (const n of ['L_BASE', 'L_CONTROL', 'L_FN', 'L_SYM', 'L_NUM']) ok(text.includes(`#define ${n}`), `define ${n}`);
ok(/&kp Q\s+&kp W\s+&kp E/.test(text), 'base row 1 keys appear');
ok(text.includes('&fht_l LCTRL T') && text.includes('&fht_r RSHFT R'), 'flask hold-taps keep hold/tap args');
ok(text.includes('&kp LS(TAB)'), 'modifier wrapper');
ok(text.includes('&bt BT_SEL 3') && text.includes('&bt BT_CLR'), 'bluetooth symbols');
ok(text.includes('&sw_layout OS_NEXT') && text.includes('#define OS_NEXT ZMK_SWITCH_LAYOUT_NEXT'), 'switch-layout param kept');
ok(text.includes('/* not exported:'), 'not-exported block is always present');
eq(notExported, [], 'the default Totem state exports completely');

// ---- usage names
eq(usageToDt((0x07 << 16) | 0x04), 'A');
eq(usageToDt((0x02 << 24) | (0x07 << 16) | 0x1E), 'EXCL');
eq(usageToDt(((0x01 | 0x02) << 24) | (0x07 << 16) | 0x2B), 'LC(LS(TAB))');
eq(usageToDt((0x0C << 16) | 0xE9), 'C_VOL_UP');
ok(usageToDt((0x07 << 16) | 0x91).startsWith('ZMK_HID_USAGE('), 'unknown usage is never lost');

// ---- unknown behaviors are reported, not dropped silently
{
    const r = exportKeymapText({ family: 'imprint', layers: [{ id: 0, name: 'base', bindings: [{ behavior: '', behaviorId: 99, param1: 5, param2: 0 }] }] }, { behaviors: [] });
    ok(r.text.includes('&none') && r.notExported.some((n) => n.includes('#99')), 'unresolved behavior listed');
    ok(r.text.includes('#99'), 'and named in the not-exported block');
}

// ---- runtime slots become nodes; the rest is listed
{
    const d = { ...data, flask: {
        macros: { tapMs: 30, waitMs: 15, slots: [[{ action: 1, param: (7 << 16) | 4 }, { action: 4, param: 50 }, { action: 2, param: (7 << 16) | 0xE1 }]] },
        tapDance: { slots: [{ termMs: 180, taps: [{ action: 1, param1: (7 << 16) | 4 }, { action: 1, param1: (7 << 16) | 5 }] }] },
        leader: { slots: [{ positions: [1, 2], action: 1, param: 4 }] },
        customShift: { slots: [{ base: 1, shifted: 2 }] },
        combos: { slots: [{ positions: [1, 2], action: 2, param1: 0 }] },
    }, holdtap: [{ slot: 20, term: 250, quick: 100, idle: 0, flavor: 2, custom: true, kind: 'key', name: '' }] };
    const r = exportKeymapText(d, { behaviors: T.behaviors, nodeById: (id) => byId.get(id)?.node });
    ok(r.text.includes('zmk,behavior-macro') && r.text.includes('&macro_tap &kp A') && r.text.includes('&macro_wait_time 50'), 'macro node');
    ok(r.text.includes('zmk,behavior-tap-dance') && r.text.includes('tapping-term-ms = <180>'), 'tap dance node');
    ok(r.text.includes('flask,holdtap-defaults') && r.text.includes('tapping-term-ms = <250>'), 'custom hold timing');
    ok(r.text.includes('bindings = <&fmac_0>'), 'combo with a macro output points at the macro node');
    ok(r.notExported.some((n) => n.startsWith('leader')) && r.notExported.some((n) => n.startsWith('shift keys')), 'leader + shift keys listed');
    const z = exportKeymapText(d, { behaviors: T.behaviors, combos: 'zmk' });
    ok(z.text.includes('compatible = "zmk,combos"'), 'stock combos on request');
}


// ---- verifier fixes: bt / mkp / escaping / header / hold timing for every slot
{
    const L = (name, ...bs) => ({ id: 0, name, bindings: bs.map(([behavior, behaviorId, param1, param2 = 0]) => ({ behavior, behaviorId, param1, param2 })) });
    const cat = [{ id: 1, displayName: 'Bluetooth' }, { id: 2, displayName: 'Mouse Key Press' }, { id: 3, displayName: 'Key Press' }];
    const r = exportKeymapText({ family: 'imprint', layers: [L('a"b\\c', ['Bluetooth', 1, 0], ['Bluetooth', 1, 3, 2], ['Bluetooth', 1, 4], ['Bluetooth', 1, 5, 1], ['Mouse Key Press', 2, 1])] }, { behaviors: cat });
    ok(r.text.includes('&bt BT_CLR ') && r.text.includes('&bt BT_SEL 2') && r.text.includes('&bt BT_CLR_ALL') && r.text.includes('&bt BT_DISC 1'), 'bt: new commands, second cell only for SEL/DISC');
    ok(!/BT_CLR \d|BT_CLR_ALL \d/.test(r.text), 'bt: no stray second cell');
    ok(r.text.includes('#include <dt-bindings/zmk/pointing.h>') && r.text.includes('&mkp MB1'), 'mkp pulls in pointing.h');
    const none = exportKeymapText({ family: 'imprint', layers: [L('x', ['Key Press', 3, 4])] }, { behaviors: cat });
    ok(!none.text.includes('pointing.h'), 'no pointing.h without &mkp');
    ok(r.text.includes('display-name = "a\\"b\\\\c";'), 'layer name escaped');
    ok(/NOT a drop-in replacement/.test(r.text) && r.text.includes('config repo'), 'header says firmware behaviours come from the config repo');
    const m = exportKeymapText({ family: 'imprint', layers: [L('x', ['Key Press', 3, 4])],
        flask: { macros: { slots: [[{ action: 1, param: (7 << 16) | 4 }]] , }, slotNames: { macros: { 0: 'say "hi" \\' } } } }, { behaviors: cat });
    ok(m.text.includes('display-name = "say \\"hi\\" \\\\";'), 'macro name escaped');
}
{
    const { readHoldtap } = await import('../zmk-extras.js?v=69');
    const bytes = (slot, custom) => [slot, 0, 200, 0, 0, 0, 0, 1, custom ? 1 : 0];
    const fake = { getU16: async () => 3, getBytes: async (ch, id, [slot]) => {
        if (slot === 2) throw new Error('timeout');
        return id === 0x50 ? bytes(slot, slot === 1) : [slot, 0, slot, 0, ...new Array(26).fill(0)];
    } };
    const res = await readHoldtap({ flask: fake, protocolVersion: 17 });
    eq(res.slots.map((s) => [s.slot, s.custom]), [[0, false], [1, true]], 'default (non-custom) slots are read too');
    eq(res.unreadable.map((u) => u.slot), [2], 'unreadable slot reported');
    const out = exportKeymapText({ family: 'totem', layers: [{ id: 0, name: 'a', bindings: [] }], holdtap: res.slots, holdtapUnreadable: res.unreadable }, { behaviors: [] });
    ok(out.text.includes('ht_key_0 {') && out.text.includes('ht_key_1 {'), 'every slot written, not only custom ones');
    ok(out.notExported.some((n) => n.startsWith('hold timing slot 2')), 'unreadable slot listed in not-exported');
}

// ---- cross-check against the real firmware keymap
const real = join(homedir(), 'dev/Input/Flask-Svalboard/Totem-ZMK/config/totem.keymap');
if (existsSync(real)) {
    const src = readFileSync(real, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const ALIAS = { RET: 'ENTER', RETURN: 'ENTER', DOWN_ARROW: 'DOWN', UP_ARROW: 'UP', LEFT_ARROW: 'LEFT', RIGHT_ARROW: 'RIGHT',
        C_REWIND: 'C_RW', C_PLAY_PAUSE: 'C_PP', C_FAST_FORWARD: 'C_FF', ESCAPE: 'ESC', BACKSPACE: 'BSPC', DELETE: 'DEL', PERIOD: 'DOT', SLASH: 'FSLH',
        LEFT_SHIFT: 'LSHFT', LSHIFT: 'LSHFT', LEFT_CONTROL: 'LCTRL', LCTL: 'LCTRL', LEFT_BRACKET: 'LBKT', RIGHT_BRACKET: 'RBKT', PAGE_UP: 'PG_UP', PAGE_DOWN: 'PG_DN' };
    const SHIFTED = { EXCL: 'LS(N1)', AT: 'LS(N2)', HASH: 'LS(N3)', DLLR: 'LS(N4)', PRCNT: 'LS(N5)', CARET: 'LS(N6)', AMPS: 'LS(N7)',
        STAR: 'LS(N8)', LPAR: 'LS(N9)', RPAR: 'LS(N0)', UNDER: 'LS(MINUS)', PLUS: 'LS(EQUAL)', LBRC: 'LS(LBKT)', RBRC: 'LS(RBKT)',
        PIPE: 'LS(BSLH)', COLON: 'LS(SEMI)', DQT: 'LS(SQT)', TILDE: 'LS(GRAVE)', LT: 'LS(COMMA)', GT: 'LS(DOT)', QMARK: 'LS(FSLH)' };
    const norm = (cell) => cell.trim().replace(/\s+/g, ' ').replace(/\b[A-Z_]+\b/g, (w) => ALIAS[w] ?? w)
        .replace(/\b[A-Z]+\b/g, (w) => SHIFTED[w] ?? w);
    const cellsOf = (bindingsText) => bindingsText.replace(/[<>]/g, ' ').split('&').slice(1).map(norm).map((c) => `&${c}`);
    const km = src.slice(src.indexOf('keymap {'));
    const layerNames = [...km.matchAll(/(\w+)\s*\{\s*(?:display-name[^;]*;\s*)?bindings\s*=\s*<([^>]*)>/g)];
    eq(layerNames.length, T.layers.length, 'real file has the same layer count');
    const outLayers = [...text.slice(text.indexOf('keymap {')).matchAll(/(\w+)\s*\{\s*display-name[^;]*;\s*bindings\s*=\s*<([^>]*)>/g)];
    layerNames.forEach((m, i) => {
        const want = cellsOf(m[2]).map((c) => c.replace(/^&(\w+)/, (_, n) => `&${n}`));
        const got = cellsOf(outLayers[i][1] ? outLayers[i][2] : '');
        // L_* defines are the same names the real file uses.
        eq(got, want, `layer ${i} (${m[1]}) matches the firmware keymap cell by cell`);
    });
    const realCombos = [...src.matchAll(/(\w+)\s*\{\s*bindings\s*=\s*<([^>]*)>;\s*key-positions\s*=\s*<([^>]*)>/g)]
        .filter((m) => !['base'].includes(m[1])).map((m) => ({ b: cellsOf(m[2]).join(' '), p: m[3].trim().replace(/\s+/g, ' ') }));
    const ourCombos = [...text.matchAll(/(\w+) \{\s*bindings\s*=\s*<([^>]*)>;\s*key-positions\s*=\s*<([^>]*)>/g)]
        .map((m) => ({ b: cellsOf(m[2]).join(' '), p: m[3].trim() }));
    const comboSet = (l) => l.map((c) => `${c.p} -> ${c.b}`).sort();
    const realTail = comboSet(realCombos).filter((c) => comboSet(ourCombos).includes(c));
    eq(comboSet(ourCombos).length, T.combos.length, 'every default combo exported');
    eq(realTail.length, T.combos.length, 'every exported combo (keys -> output) exists in the firmware keymap');
} else {
    console.log('keymap-export-test: firmware repo not found, cross-check skipped');
}

console.log(`keymap-export-test: ${checks} checks OK`);
