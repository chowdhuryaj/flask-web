// WP4a: duplicate-combo refusal, hold-timing frame codec, and the offline
// sim's flask_holdtap (channel 0x2A) driven through WP3's holdtapBackend.
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
    _m: new Map(),
    getItem(k) { return this._m.get(k) ?? null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };

const { findDuplicateCombo, comboPosKey, COMBO_ACTION } = await import('../zmk-combos-codec.js?v=65');
const { encodeHoldtapSlot, decodeHoldtapSlot, decodeHoldtapInfo, clampTerm } = await import('../zmk-holdtap-codec.js?v=65');
const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=65');
const { createZmkTemplate, ZmkOfflineFlask } = await import('../zmk-offline.js?v=65');
const { holdtapBackend } = await import('../behavior-catalog.js?v=65');

// ---- duplicate combos ----
{
    const live = (positions) => ({ positions, action: COMBO_ACTION.usage, param1: 0x70028 });
    const slots = Array.from({ length: 10 }, () => ({ positions: [], action: 0 }));
    slots[7] = live([3, 13]);                        // R+F = Enter, as on AJ's Totem
    slots[8] = { positions: [5, 6], action: 0 };     // incomplete: never fires
    eq(comboPosKey([13, 3, 3]), '3,13', 'key is order-free and de-duplicated');
    eq(findDuplicateCombo(slots, 9, [3, 13]), { kind: 'slot', index: 7 }, '3+13 duplicates slot 7');
    eq(findDuplicateCombo(slots, 9, [13, 3]), { kind: 'slot', index: 7 }, 'order does not matter');
    eq(findDuplicateCombo(slots, 7, [3, 13]), null, 'a slot never duplicates itself');
    eq(findDuplicateCombo(slots, 9, [3, 12]), null, 'different set is fine');
    eq(findDuplicateCombo(slots, 9, [3, 13, 14]), null, 'superset is not an exact duplicate');
    eq(findDuplicateCombo(slots, 9, [5, 6]), null, 'a non-live twin does not count');
    eq(findDuplicateCombo(slots, 9, [3]), null, 'one key is never a combo');
    eq(findDuplicateCombo([], 0, [3, 13], TOTEM_DEFAULT.combos), { kind: 'default', index: 7 },
        'compiled devicetree default "ent" (3+13) is caught when it is not a runtime slot');
    eq(findDuplicateCombo([], 0, [3, 14], TOTEM_DEFAULT.combos), null, '3+14 is free');
}

// ---- hold-tap frames: contract byte examples ----
{
    // SET slot 20 term 220, others unchanged: 07 2A 50 14 00 DC 00 AF 00 96 01 00
    eq(encodeHoldtapSlot({ slot: 20, term: 220, quick: 175, idle: 150, flavor: 1 }),
        [0x14, 0x00, 0xDC, 0x00, 0xAF, 0x00, 0x96, 0x01, 0x00], 'SET slot 20 term 220');
    // echo with flags bit0 (custom)
    eq(decodeHoldtapSlot([0x14, 0x00, 0xDC, 0x00, 0xAF, 0x00, 0x96, 0x01, 0x01]),
        { slot: 20, term: 220, quick: 175, idle: 150, flavor: 1, custom: true }, 'decode echo');
    eq(decodeHoldtapSlot([0x14, 0x01, 0x18, 0x00, 0xAF, 0x00, 0x96, 0x01, 0x00]).term, 280, 'default 280');
    // reset = term 0
    eq(encodeHoldtapSlot({ slot: 20, term: 0 }).slice(0, 3), [0x14, 0, 0], 'reset frame');
    eq([clampTerm(30), clampTerm(5000), clampTerm(333.4)], [50, 1000, 333], 'term clamps 50..1000');
    // SLOT_INFO 38: 26 01 FF "Control combo (32+33)"
    const name = [...'Control combo (32+33)'].map((c) => c.charCodeAt(0));
    eq(decodeHoldtapInfo([38, 1, 0xFF, ...name, ...new Array(26 - name.length).fill(0)]),
        { slot: 38, kind: 'virtual', keyPos: null, name: 'Control combo (32+33)' }, 'virtual info');
    eq(decodeHoldtapInfo([20, 0, 20, ...new Array(26).fill(0)]),
        { slot: 20, kind: 'key', keyPos: 20, name: '' }, 'key info');
}

// ---- the offline sim serves 0x2A with the Totem firmware defaults ----
{
    const ws = createZmkTemplate('totem');
    const flask = new ZmkOfflineFlask(ws);
    eq(await flask.getU16(0x2A, 0x01), 44, '44 slots (38 keys + 6 virtual)');
    const imprint = new ZmkOfflineFlask(createZmkTemplate('imprint'));
    eq(await imprint.getU16(0x2A, 0x01), 0, 'imprint has no flask_holdtap');

    const slot = async (n) => decodeHoldtapSlot(await flask.getBytes(0x2A, 0x50, [n], 1));
    const d20 = await slot(20);
    eq([d20.term, d20.quick, d20.idle, d20.flavor], [280, 175, 150, 1], 'slot 20 default');
    eq((await slot(32)).flavor, 2, 'slot 32 tap-preferred');
    const d0 = await slot(0);
    eq([d0.term, d0.quick, d0.idle, d0.flavor], [200, 0, 0, 1], 'other key slots 200/0/0/balanced');
    const v40 = await slot(40);
    eq([v40.term, v40.quick, v40.flavor], [200, 150, 2], 'virtual 40 copy/cut');

    const be = holdtapBackend(flask, { slotCount: 44 });
    const all = await be.slots();
    eq(all.length, 44, 'backend.slots() lists every slot');
    eq(all.filter((s) => s.kind === 'virtual').map((s) => s.slot), [38, 39, 40, 41, 42, 43], 'six virtual slots');
    eq(all[38].name, 'Control combo (32+33)', 'virtual slot named from 0x52');
    eq(all[43].name, 'Sym autoshift digits');
    eq(all[33], { slot: 33, kind: 'key', keyPos: 33, name: '' }, 'key slot links to its position');

    eq(await be.write(33, 330), 330, 'write adopts the echo');
    eq((await slot(33)).term, 330);
    eq((await slot(33)).custom, true, 'flags bit0 once it differs from the default');
    eq(await be.write(33, 20), 50, 'clamped to 50');
    // quick/idle/flavor survive a term write; a full-frame write sets them
    const echo = decodeHoldtapSlot(await flask.setBytes(0x2A, 0x50,
        encodeHoldtapSlot({ slot: 33, term: 300, quick: 100, idle: 50, flavor: 3 }), 1));
    eq([echo.term, echo.quick, echo.idle, echo.flavor], [300, 100, 50, 3], 'full frame');
    await be.readSlot(33);   // the card re-reads after a full-frame write so the backend cache matches
    eq(await be.write(33, 310), 310);
    eq((await be.readSlot(33)).flavor, 3, 'term write keeps flavor');
    await assert.rejects(flask.setBytes(0x2A, 0x50, encodeHoldtapSlot({ slot: 32, term: 280, flavor: 7 }), 1),
        'flavor 7 is rejected'); checks++;
    await be.reset(33);
    eq((await be.readSlot(33)).term, 280, 'reset returns to the compiled default');
    eq((await be.readSlot(33)).custom, false);
    await flask.save(0x2A);
    eq(ws.dirty.saves.includes(0x2A), false, '0x2A save is not journalled for replay');
}

console.log(`wp4a-test: ${checks} checks OK`);
