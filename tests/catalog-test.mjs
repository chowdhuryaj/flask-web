// WP3 catalog: dedup counts, mapping, encode/decode round trips on every
// ZMK adapter, capParts, and the flask_holdtap runtime timing backend (mocked
// device; the offline sim does not serve channel 0x2A).
// Import stamps match binding-picker.js so module state is shared.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../behavior-catalog.js?v=70';
import { setZmkContext } from '../zmk-keycodes.js?v=70';

let checks = 0;
const ok = (c, m = '') => { assert.ok(c, m); checks++; };
const eq = (a, b, m = '') => { assert.deepEqual(a, b, m); checks++; };
const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}-behaviors.json`, import.meta.url)));
const LAYERS = [0, 1, 2, 3, 4].map((id) => ({ id, name: ['base', 'nav', 'sym', 'num', 'fn'][id] }));

function useZmk(family) {
    const fx = fixture(family);
    setZmkContext({ behaviors: new Map(fx.behaviors.map((d) => [d.id, d])), layers: LAYERS });
    return fx;
}

// ---- dedup counts (spec §4.2) ----
const EXPECT = {
    // behavior-backed entries; +1 visible for Media key, which rides Key Press
    totem: 23, imprint: 30,
};
for (const family of ['totem', 'imprint']) {
    const fx = useZmk(family);
    const cat = C.catalogFor({ family });
    eq(cat.adapter, 'zmk-studio');
    const backed = cat.filter((e) => !e.rides);
    eq(backed.length, EXPECT[family], `${family} behavior entries: ${backed.map((e) => e.id).join(' ')}`);
    eq(cat.length, EXPECT[family] + 1, `${family} visible entries incl. Media key`);
    // every named behavior maps to exactly one entry or Advanced
    const named = fx.behaviors.filter((d) => d.displayName);
    const owner = new Map();
    for (const e of cat) for (const v of e.rides ? [] : e.device) {
        ok(!owner.has(v.behaviorId), `${family}: behavior ${v.behaviorId} in two entries`);
        owner.set(v.behaviorId, e.id);
    }
    for (const d of named) ok(owner.has(d.id), `${family}: "${d.displayName}" unmapped`);
    eq(cat.hidden, fx.behaviors.length - named.length, `${family} hidden = nameless`);
    // no entry in two groups, ids unique
    eq(new Set(cat.map((e) => e.id)).size, cat.length);
    ok(cat.every((e) => C.CATALOG_GROUPS.some((g) => g.id === e.group)));
    // the nameless behaviors never give an empty label
    for (const d of fx.behaviors.filter((x) => !x.displayName)) {
        const cp = C.capParts({ behaviorId: d.id, param1: 0, param2: 0 }, 'zmk-studio');
        ok(cp.main.trim().length > 0, `nameless ${d.id} cap`);
        ok(C.describeBinding({ behaviorId: d.id, param1: 0, param2: 0 }).trim().length > 0);
    }
}

// ---- before → after by name (TOTEM) ----
{
    useZmk('totem');
    const cat = C.catalogFor({ family: 'totem' });
    const by = Object.fromEntries(cat.map((e) => [e.id, e.device.map((v) => v.name).sort()]));
    // Virtual-slot helpers (combo / autoshift hold-taps, Totem-ZMK 4422ec7)
    // are absorbed as variants, never offered as a choice.
    eq(by['mod-tap'], ['Autoshift (live)', 'Hold-Tap (live)', 'Hold-Tap L (live)', 'Hold-Tap R (live)', 'Mod-Tap',
        'Mod-Tap (fast 150)', 'Mod-Tap (slow 300)', 'Mod-Tap Fn arrows (live)', 'Mod-Tap copy/cut combo (live)',
        'Mod-Tap undo/redo combo (live)', 'Smart Mod']);
    eq(by['layer-tap'], ['Layer-Tap', 'Layer-Tap (fast 150)', 'Layer-Tap (slow 300)',
        'Layer-Tap Control combo (live)', 'Layer-Tap Fn combo (live)']);
    eq(by['one-shot-mod'], ['Sticky Key', 'Sticky Mod (smart)']);
    eq(by['one-shot-layer'], ['Sticky Layer', 'Sticky Layer (smart)']);
    const mt = cat.find((e) => e.id === 'mod-tap');
    eq(mt.params.find((p) => p.key === 'timing').variants, [150, 200, 300]);
    eq(mt.params.find((p) => p.key === 'mode').options, ['plain', 'smart']);
    eq(mt.params.find((p) => p.key === 'live').options, ['off', 'any', 'left', 'right']);
    // Imprint has no live hold-taps → no live param
    useZmk('imprint');
    ok(!C.catalogFor({ family: 'imprint' }).find((e) => e.id === 'mod-tap').params.some((p) => p.key === 'live'));
}

// ---- round trips: every behavior × sample params, studio and typed ----
const SAMPLE = {
    key: [0x04, 0x29, 0xE3, 0x3A], mods: [0, 0x02, 0x09, 0x10 | 0x20], hold: [0x01, 0x02, 0x08, 0x11, 0x80],
    tap: [0x04, 0x2C], layer: [0, 1, 4], slot: [0, 3], timing: [150, 200, 300], profile: [0, 2],
};
function combos(entry) {
    let list = [{}];
    for (const p of entry.params) {
        let vals = SAMPLE[p.key];
        if (p.key === 'mods' && entry.id === 'one-shot-mod') vals = vals.filter(Boolean);
        if (p.kind === 'choice') vals = p.options;
        if (p.kind === 'slot') vals = [p.min, p.max];
        if (p.key === 'code' && entry.id === 'media-key') vals = p.options.slice(0, 4);
        if (!vals) continue;
        list = list.flatMap((c) => vals.map((v) => ({ ...c, [p.key]: v })));
    }
    return list;
}
const stable = (entry, d) => {   // params decode can't recover on purpose
    const p = { ...d.params };
    if (entry.id === 'mod-tap' || entry.id === 'layer-tap') {
        if (p.mode === 'smart' || (p.live && p.live !== 'off')) delete p.timing;
    }
    return p;
};
for (const family of ['totem', 'imprint']) {
    useZmk(family);
    for (const adapter of ['zmk-studio', 'zmk-typed']) {
        let n = 0;
        for (const e of C.catalogFor({ family })) {
            if (e.id === 'advanced') continue;
            if (adapter === 'zmk-typed' && ['trans'].includes(e.id)) continue;
            for (const params of combos(e)) {
                // compiled timing variants: 200 + live/smart don't combine
                const b = C.encode(e.id, params, adapter);
                const d = C.decode(b, adapter);
                eq(d.entryId, e.id, `${family} ${adapter} ${e.id} ${JSON.stringify(params)}`);
                const want = { ...C.decode(C.encode(e.id, params, adapter), adapter).params };
                eq(stable(e, d), stable(e, { params: want }));
                eq(C.encode(d.entryId, d.params, adapter), b, `${family} ${adapter} ${e.id} binding stable`);
                for (const [k, v] of Object.entries(params)) {
                    if (k === 'timing' && (params.mode === 'smart' || (params.live && params.live !== 'off'))) continue;
                    if (k === 'live' && params.mode === 'smart') continue;   // smart wins over live
                    eq(d.params[k], v, `${family} ${adapter} ${e.id}.${k}`);
                }
                ok(!/\(\w/.test(Object.values(C.capParts(b, adapter)).join(' ')), `cap ( fragment ${e.id}`);
                n++;
            }
        }
        ok(n > 100, `${family} ${adapter}: ${n} combos`);
    }
    // every binding in the shipped keymap decodes and re-encodes to itself
    if (family === 'totem') {
        const { TOTEM_DEFAULT } = await import('../zmk-totem-default.js?v=70');
        for (const layer of TOTEM_DEFAULT.layers) for (const [behaviorId, param1, param2] of layer.bindings) {
            const b = { behaviorId, param1, param2 };
            const d = C.decode(b, 'zmk-studio');
            eq(C.encode(d.entryId, d.params, 'zmk-studio'), d.entryId === 'advanced' ? b : C.encode(d.entryId, d.params, 'zmk-studio'));
            if (d.entryId !== 'advanced') eq(C.decode(C.encode(d.entryId, d.params, 'zmk-studio'), 'zmk-studio'), d);
            ok(!/\(\w/.test(Object.values(C.capParts(b)).join(' ')), `TOTEM default cap ${JSON.stringify(b)}`);
            ok(C.capParts(b).main.trim().length > 0, `TOTEM default cap empty ${JSON.stringify(b)}`);
        }
    }
}

// Mod-tap timing on a compiled-only device lands on the nearest variant.
{
    useZmk('totem');
    const id = (n) => fixture('totem').behaviors.find((d) => d.displayName === n).id;
    eq(C.encode('mod-tap', { hold: 2, tap: 4, timing: 150 }, 'zmk-studio').behaviorId, id('Mod-Tap (fast 150)'));
    eq(C.encode('mod-tap', { hold: 2, tap: 4, timing: 170 }, 'zmk-studio').behaviorId, id('Mod-Tap (fast 150)'));
    eq(C.encode('mod-tap', { hold: 2, tap: 4, timing: 260 }, 'zmk-studio').behaviorId, id('Mod-Tap (slow 300)'));
    eq(C.encode('mod-tap', { hold: 2, tap: 4, mode: 'smart' }, 'zmk-studio').behaviorId, id('Smart Mod'));
    eq(C.encode('mod-tap', { hold: 2, tap: 4, live: 'left' }, 'zmk-studio').behaviorId, id('Hold-Tap L (live)'));
    eq(C.encode('layer-tap', { layer: 1, tap: 4, timing: 300 }, 'zmk-studio').behaviorId, id('Layer-Tap (slow 300)'));
    // the shipped fht_l LCTRL T reads as Mod-tap ⌃ / T, live
    const d = C.decode({ behaviorId: id('Hold-Tap L (live)'), param1: 0x700E0, param2: 0x70017 });
    eq(d, { entryId: 'mod-tap', params: { hold: 0x01, tap: 0x17, timing: 200, mode: 'plain', live: 'left' } });
    eq(C.capParts({ behaviorId: id('Hold-Tap L (live)'), param1: 0x700E0, param2: 0x70017 }), { top: 'Mod-tap ⌃ · live', main: 'T' });
    eq(C.capParts({ behaviorId: id('Mod-Tap (fast 150)'), param1: 0x700E3, param2: 0x7000B }), { top: 'Mod-tap ⌘ · fast', main: 'H' });
    eq(C.describeBinding({ behaviorId: id('Mod-Tap (fast 150)'), param1: 0x700E3, param2: 0x7000B }), 'Mod-tap ⌘ H · 150 ms');
    eq(C.describeBinding({ action: 1, param1: 0x70029 }, 'zmk-typed'), 'Esc');
}

// ---- flask_holdtap runtime backend (contract bytes, mocked device) ----
function fakeHoldtapFlask({ slots = 44, proto17 = true } = {}) {
    const table = Array.from({ length: slots }, (_, i) => ({ term: 200, quick: 0, idle: 0, flavor: 1, def: 200 }));
    table[20] = { term: 280, quick: 175, idle: 150, flavor: 1, def: 280 };
    const frame = (i) => { const s = table[i]; return [i, s.term >> 8, s.term & 0xFF, s.quick >> 8, s.quick & 0xFF, s.idle >> 8, s.idle & 0xFF, s.flavor, s.term !== s.def ? 1 : 0]; };
    const log = [];
    return {
        log, table,
        async getU16(ch, id) { log.push(['get', ch, id]); if (!proto17 || ch !== 0x2A || id !== 1) throw new Error('unhandled'); return slots; },
        async getBytes(ch, id, [i]) {
            log.push(['get', ch, id, i]);
            if (id === 0x52) {
                const name = i >= 38 ? ['Control combo (32+33)', 'Fn combo (33+34)'][i - 38] ?? '' : '';
                return [i, i >= 38 ? 1 : 0, i >= 38 ? 0xFF : i, ...[...name].map((c) => c.charCodeAt(0)), ...Array(26 - name.length).fill(0)];
            }
            return frame(i);
        },
        async setBytes(ch, id, p) {
            log.push(['set', ch, id, ...p]);
            const s = table[p[0]];
            const term = (p[1] << 8) | p[2];
            if (term === 0) s.term = s.def; else s.term = Math.max(50, Math.min(1000, term));
            return frame(p[0]);
        },
        async save(ch) { log.push(['save', ch]); },
    };
}
{
    useZmk('totem');
    const live = (n) => fixture('totem').behaviors.find((d) => d.displayName === n).id;
    // no channel → default backend stays (nearest variant)
    const f0 = fakeHoldtapFlask({ proto17: false });
    eq(await C.attachHoldtap({ flask: f0, protocolVersion: 17 }), null);
    ok(!C.timingBackendNow().runtime);
    eq(await C.attachHoldtap({ flask: fakeHoldtapFlask(), protocolVersion: 16 }), null, 'proto < 17');
    // channel answers → runtime backend
    const f = fakeHoldtapFlask();
    let dirty = 0;
    const be = await C.attachHoldtap({ flask: f, protocolVersion: 17 }, { onDirty: () => dirty++ });
    ok(be?.runtime && C.timingBackendNow() === be, 'runtime backend installed');
    eq(be.slotCount, 44, 'slot count from the meta, not the key count');
    eq(await be.slotInfo(20), { slot: 20, kind: 'key', keyPos: 20, name: '' });
    eq(await be.slotInfo(38), { slot: 38, kind: 'virtual', keyPos: null, name: 'Control combo (32+33)' });
    eq((await be.slots()).filter((x) => x.kind === 'virtual').length, 6);
    eq(await be.write(39, 240), 240, 'virtual slots write like key slots');
    eq(await be.read(20), 280);
    eq(await be.write(20, 220), 220);
    eq(f.log.at(-1), ['set', 0x2A, 0x50, 20, 0x00, 0xDC, 0x00, 0xAF, 0x00, 0x96, 0x01, 0x00], 'contract SET bytes keep quick/idle/flavor');
    eq(await be.write(20, 30), 50, 'clamp echo adopted');
    eq(await be.reset(20), 280);
    eq(f.log.at(-1), ['set', 0x2A, 0x50, 20, 0, 0]);
    eq(dirty, 4);
    await be.save(); eq(f.log.at(-1), ['save', 0x2A]);
    await assert.rejects(be.write(44, 200)); checks++;
    // live mod-tap: exact ms, a write for the key position
    const r = C.resolveTiming('mod-tap', 260, [{ behaviorId: live('Hold-Tap L (live)'), ms: null, live: true, side: 'left' }], { side: 'left' });
    eq([r.behaviorId, r.ms, r.exact], [live('Hold-Tap L (live)'), 260, true]);
    eq(await r.write(31), 260);
    // compiled-only entries (layer-tap) still snap to a variant under the runtime backend
    eq(C.resolveTiming('layer-tap', 260, [{ behaviorId: 8, ms: 200 }, { behaviorId: 59, ms: 300 }]).behaviorId, 59);
    // the binding for a live pick is the live behavior, whatever the ms
    eq(C.encode('mod-tap', { hold: 2, tap: 4, live: 'any', timing: 730 }, 'zmk-studio').behaviorId, live('Hold-Tap (live)'));
    C.setTimingBackend(null);
    ok(!C.timingBackendNow().runtime, 'setTimingBackend(null) restores the default');
}

console.log(`catalog-test: ${checks} checks OK`);
