// Offline test vectors for the ZMK Studio codec — run: node zmk-studio-test.mjs
// Throws (non-zero exit) on any mismatch. Vectors transcribed from
// zmk-studio-ts-client test/framing.spec.ts + a hand-worked request example;
// they pin today's wire format so schema drift is detectable.

import {
    FRAME_SOF, FRAME_ESC, FRAME_EOF,
    encodeFrame, FrameDecoder,
    zigzag, unzigzag, writeVarint, readVarintAt, readFields,
    fVarint, fBytes, buildRequest,
    encodeBinding, decodeBinding, decodeKeymap, decodePhysicalLayouts,
    decodeBehaviorDetails,
    decodeLayer, decodeMoveLayerResponse, decodeAddLayerResponse,
    decodeRemoveLayerResponse, decodeRestoreLayerResponse,
} from './zmk-studio.js';

let checks = 0;

function eq(actual, expected, what) {
    const a = JSON.stringify(actual instanceof Uint8Array ? [...actual] : actual);
    const e = JSON.stringify(expected instanceof Uint8Array ? [...expected] : expected);
    if (a !== e) throw new Error(`${what}\n  actual:   ${a}\n  expected: ${e}`);
    checks++;
}

// ---- framing: encode ----
eq(encodeFrame([1, 2, 3]), [0xAB, 1, 2, 3, 0xAD], 'encode simple frame');
eq(encodeFrame([1, 0xAB, 0xAC, 2, 3, 0xAB, 4, 0xAD, 5]),
    [0xAB, 1, 0xAC, 0xAB, 0xAC, 0xAC, 2, 3, 0xAC, 0xAB, 4, 0xAC, 0xAD, 5, 0xAD],
    'encode escape-heavy frame');

// ---- framing: decode ----
{
    const d = new FrameDecoder();
    const frames = d.push(new Uint8Array([0xAB, 1, 2, 3, 0xAD, 0xAB, 4, 0xAD]));
    eq(frames.length, 2, 'back-to-back frame count');
    eq(frames[0], [1, 2, 3], 'frame 1 payload');
    eq(frames[1], [4], 'frame 2 payload');
}
{
    // 1-byte-at-a-time feed (64-byte firmware TX buffer splits frames arbitrarily)
    const d = new FrameDecoder();
    const wire = encodeFrame([1, 0xAB, 0xAC, 2, 0xAD, 3]);
    const got = [];
    for (const b of wire) got.push(...d.push(new Uint8Array([b])));
    eq(got.length, 1, 'split-feed frame count');
    eq(got[0], [1, 0xAB, 0xAC, 2, 0xAD, 3], 'split-feed round trip');
}
{
    // garbage before SOF is discarded
    const d = new FrameDecoder();
    const frames = d.push(new Uint8Array([0x00, 0xFF, 0x42, 0xAB, 9, 0xAD]));
    eq(frames.length, 1, 'garbage-then-frame count');
    eq(frames[0], [9], 'garbage-then-frame payload');
}
{
    // unescaped SOF mid-frame = resync to a fresh frame
    const d = new FrameDecoder();
    const frames = d.push(new Uint8Array([0xAB, 1, 2, 0xAB, 7, 8, 0xAD]));
    eq(frames.length, 1, 'resync frame count');
    eq(frames[0], [7, 8], 'resync keeps the fresh frame');
}

// ---- varint / zigzag ----
{
    const out = [];
    writeVarint(out, 0xFFFFFFFF);
    eq(out, [0xFF, 0xFF, 0xFF, 0xFF, 0x0F], 'u32 max varint encode');
    eq(readVarintAt(new Uint8Array(out), 0), [0xFFFFFFFF, 5], 'u32 max varint decode');
}
{
    // negative int32 arrives as a 10-byte (64-bit sign-extended) varint;
    // decoder keeps the low 32 bits: -2 → ...FFFFFFFE
    const wire = [0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01];
    const [v, n] = readVarintAt(new Uint8Array(wire), 0);
    eq(n, 10, 'int64-extended varint length');
    eq(v | 0, -2, 'negative int32 low-bits view');
}
for (const n of [0, -1, 1, -2, 2, 0x7FFFFFFF, -0x80000000]) {
    eq(unzigzag(zigzag(n)), n, `zigzag round trip ${n}`);
}
eq(zigzag(-1), 1, 'zigzag(-1)');
eq(zigzag(1), 2, 'zigzag(1)');

// ---- worked request vector (from the protocol recon) ----
{
    const payload = buildRequest(1, 5, fVarint(1, 1, true));   // keymap.get_keymap, req_id 1
    eq(payload, [0x08, 0x01, 0x2A, 0x02, 0x08, 0x01], 'get_keymap payload bytes');
    eq(encodeFrame(payload), [0xAB, 0x08, 0x01, 0x2A, 0x02, 0x08, 0x01, 0xAD],
        'get_keymap framed bytes');
}

// ---- oneof bool selector must be explicit even at request_id 0 ----
{
    const payload = buildRequest(0, 3, fVarint(2, 1, true));   // core.get_lock_state, req_id 0
    eq(payload, [0x08, 0x00, 0x1A, 0x02, 0x10, 0x01], 'req_id 0 emitted explicitly');
}

// ---- binding encode/decode ----
{
    // high-bit param (implicit mods above bit 24): LS(A)-style value survives u32
    const b = { behaviorId: 5, param1: 0x02070004, param2: 0 };
    const wire = encodeBinding(b);
    eq(decodeBinding(new Uint8Array(wire)), b, 'binding round trip w/ mod bits');
    // behavior_id is zigzag: 5 → 10 on the wire
    eq(wire[0], 0x08, 'binding field 1 tag');
    eq(wire[1], 10, 'binding behavior_id zigzagged');
}
{
    // proto3 defaults: absent fields decode to 0 (a {id,0,0} binding is just field 1)
    eq(decodeBinding(new Uint8Array([0x08, 0x02])),
        { behaviorId: 1, param1: 0, param2: 0 }, 'binding default params');
    eq(decodeBinding(new Uint8Array([])),
        { behaviorId: 0, param1: 0, param2: 0 }, 'empty binding decodes to zeros');
}

// ---- keymap decode ----
{
    // Keymap{ layers: [ Layer{id:2, name:"Base", bindings:[{1,0x70004,0},{-3,0,0}]} ],
    //         available_layers: 4, max_layer_name_length: 20 }
    const binding1 = [...fVarint(1, zigzag(1)), ...fVarint(2, 0x70004)];
    const binding2 = [...fVarint(1, zigzag(-3))];
    const layer = [
        ...fVarint(1, 2),
        ...fBytes(2, [...new TextEncoder().encode('Base')]),
        ...fBytes(3, binding1),
        ...fBytes(3, binding2),
    ];
    const keymap = [...fBytes(1, layer), ...fVarint(2, 4), ...fVarint(3, 20)];
    eq(decodeKeymap(new Uint8Array(keymap)), {
        layers: [{
            id: 2, name: 'Base',
            bindings: [
                { behaviorId: 1, param1: 0x70004, param2: 0 },
                { behaviorId: -3, param1: 0, param2: 0 },
            ],
        }],
        availableLayers: 4,
        maxLayerNameLength: 20,
    }, 'keymap decode');
}

// ---- physical layouts: centi-units ÷ 100, zigzag fields ----
{
    // one layout "Default", one key: w=100 h=100 x=250 y=125 r=-3000 rx=600 ry=1340
    const key = [
        ...fVarint(1, zigzag(100)), ...fVarint(2, zigzag(100)),
        ...fVarint(3, zigzag(250)), ...fVarint(4, zigzag(125)),
        ...fVarint(5, zigzag(-3000)), ...fVarint(6, zigzag(600)), ...fVarint(7, zigzag(1340)),
    ];
    const layout = [...fBytes(1, [...new TextEncoder().encode('Default')]), ...fBytes(2, key)];
    const msg = [...fVarint(1, 0), ...fBytes(2, layout)];
    eq(decodePhysicalLayouts(new Uint8Array(msg)), {
        activeLayoutIndex: 0,
        layouts: [{
            name: 'Default',
            keys: [{ w: 1, h: 1, x: 2.5, y: 1.25, r: -30, rx: 6, ry: 13.4 }],
        }],
    }, 'physical layout decode (centi-units, zigzag, negative rotation)');
}

// ---- behavior details decode ----
{
    // { id: 7, display_name: "Key Press", metadata: [ { param1: [hid_usage kb=255 cons=1024], param2: [nil] } ] }
    const descUsage = [
        ...fBytes(1, [...new TextEncoder().encode('usage')]),
        ...fBytes(5, [...fVarint(1, 255), ...fVarint(2, 1024)]),
    ];
    const descNil = [...fBytes(1, []), ...fBytes(2, [])];
    const set = [...fBytes(1, descUsage), ...fBytes(2, descNil)];
    const msg = [
        ...fVarint(1, 7),
        ...fBytes(2, [...new TextEncoder().encode('Key Press')]),
        ...fBytes(3, set),
    ];
    eq(decodeBehaviorDetails(new Uint8Array(msg)), {
        id: 7, displayName: 'Key Press',
        metadata: [{
            param1: [{ name: 'usage', kind: 'hid_usage', keyboardMax: 255, consumerMax: 1024 }],
            param2: [{ name: '', kind: 'nil' }],
        }],
    }, 'behavior details decode');
}
{
    // range descriptor: min/max are plain int32 (NOT zigzag) — negative min
    // arrives as a 10-byte sign-extended varint
    const negMin = [];
    // encode -5 as 64-bit two's-complement varint by hand
    negMin.push(0xFB, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01);
    const range = [0x08, ...negMin, ...fVarint(2, 5)];
    const desc = [...fBytes(1, [...new TextEncoder().encode('amount')]), ...fBytes(4, range)];
    const set = [...fBytes(1, desc)];
    const msg = [...fVarint(1, 9), ...fBytes(3, set)];
    const got = decodeBehaviorDetails(new Uint8Array(msg));
    eq(got.metadata[0].param1[0], { name: 'amount', kind: 'range', min: -5, max: 5 },
        'range descriptor with negative min');
}

// ---- layer structure ops (Request fields 8-11) ----
{
    // shared fixture: Layer{ id: 7, name: "Sym", bindings: [{2,4,0}] }
    const layerBytes = [
        ...fVarint(1, 7),
        ...fBytes(2, [...new TextEncoder().encode('Sym')]),
        ...fBytes(3, [...fVarint(1, zigzag(2)), ...fVarint(2, 4)]),
    ];
    const layerObj = { id: 7, name: 'Sym', bindings: [{ behaviorId: 2, param1: 4, param2: 0 }] };
    eq(decodeLayer(new Uint8Array(layerBytes)), layerObj, 'layer decode');

    // MoveLayerResponse ok arm = full Keymap
    const km = [...fBytes(1, layerBytes), ...fVarint(2, 3), ...fVarint(3, 20)];
    eq(decodeMoveLayerResponse(new Uint8Array(fBytes(1, km))),
        { err: 0, keymap: { layers: [layerObj], availableLayers: 3, maxLayerNameLength: 20 } },
        'move-layer ok decode');
    eq(decodeMoveLayerResponse(new Uint8Array(fVarint(2, 3))),
        { err: 3, keymap: null }, 'move-layer INVALID_DESTINATION');

    // AddLayerResponse ok arm = AddLayerResponseDetails{index=1, layer=2}
    const details = [...fVarint(1, 6), ...fBytes(2, layerBytes)];
    eq(decodeAddLayerResponse(new Uint8Array(fBytes(1, details))),
        { err: 0, index: 6, layer: layerObj }, 'add-layer ok decode');
    eq(decodeAddLayerResponse(new Uint8Array(fVarint(2, 2))),
        { err: 2, index: -1, layer: null }, 'add-layer NO_SPACE');

    // RemoveLayerResponse: ok arm is an empty message
    eq(decodeRemoveLayerResponse(new Uint8Array(fBytes(1, []))), { err: 0 }, 'remove-layer ok');
    eq(decodeRemoveLayerResponse(new Uint8Array(fVarint(2, 2))), { err: 2 }, 'remove-layer INVALID_INDEX');

    // RestoreLayerResponse ok arm = the restored Layer
    eq(decodeRestoreLayerResponse(new Uint8Array(fBytes(1, layerBytes))),
        { err: 0, layer: layerObj }, 'restore-layer ok decode');
    eq(decodeRestoreLayerResponse(new Uint8Array(fVarint(2, 1))),
        { err: 1, layer: null }, 'restore-layer GENERIC');

    // request encodings: move(1→3), remove(0 — zero index still decodes), restore(id 7 at 2)
    eq([...fVarint(1, 1), ...fVarint(2, 3)], [0x08, 1, 0x10, 3], 'move-layer request bytes');
    eq(fVarint(1, 0), [], 'remove-layer index 0 omitted (proto3 default)');
    eq([...fVarint(1, 7), ...fVarint(2, 2)], [0x08, 7, 0x10, 2], 'restore-layer request bytes');
}

// ---- readFields forward compat: unknown wire 5/1 skipped ----
{
    const bytes = new Uint8Array([
        0x0D, 1, 2, 3, 4,            // field 1, wire 5 (fixed32) — skipped
        0x11, 1, 2, 3, 4, 5, 6, 7, 8, // field 2, wire 1 (fixed64) — skipped
        0x18, 0x2A,                   // field 3, varint 42
    ]);
    const f = readFields(bytes);
    eq(f.length, 1, 'unknown wire types skipped');
    eq(f[0], { field: 3, wire: 0, value: 42 }, 'varint after skipped fields');
}

// ---- vocabulary (zmk-keycodes.js — imports keycodes.js via ?v= query,
// which node ESM accepts as a URL suffix) ----
{
    const {
        kpParam, cpParam, usageParts, usageCap, usageFromName,
        setZmkContext, bindingCap, bindingHover, eventToUsageParam,
    } = await import('./zmk-keycodes.js?v=4');

    // type-to-assign capture: KeyboardEvent.code → usage param
    eq(eventToUsageParam({ code: 'KeyA' }), 0x00070004, 'eventToUsage KeyA');
    eq(eventToUsageParam({ code: 'Digit0' }), 0x00070027, 'eventToUsage Digit0');
    eq(eventToUsageParam({ code: 'F13' }), 0x00070068, 'eventToUsage F13');
    eq(eventToUsageParam({ code: 'Numpad5' }), 0x0007005D, 'eventToUsage Numpad5');
    eq(eventToUsageParam({ code: 'KeyC', ctrlKey: true }), 0x01070006, 'eventToUsage ⌃C chord');
    eq(eventToUsageParam({ code: 'KeyC', ctrlKey: true, shiftKey: true }), 0x03070006, 'eventToUsage ⌃⇧C');
    eq(eventToUsageParam({ code: 'ShiftLeft', shiftKey: true }), 0x000700E1, 'bare modifier assigns unmodified');
    eq(eventToUsageParam({ code: 'MediaWeirdKey' }), null, 'unknown code → null');

    eq(kpParam(0x04), 0x00070004, 'kpParam(A)');
    eq(cpParam(0xE9), 0x000C00E9, 'cpParam(Vol+)');
    eq(usageParts(0x02070004), { mods: 2, page: 7, id: 4 }, 'usageParts w/ LSFT');
    eq(usageCap(0x00070004), 'A', 'usageCap A');
    eq(usageCap(0x02070004), '⇧A', 'usageCap LS(A)');
    eq(usageCap(0x000C00E9), 'Vol+', 'usageCap consumer Vol+');
    eq(usageCap(0x00FF0042), 'ff:0x0042', 'unknown page renders hex');
    eq(usageFromName('escape'), 0x00070029, 'usageFromName escape');
    eq(usageFromName('vol+'), 0x000C00E9, 'usageFromName consumer cap');
    eq(usageFromName('zzz-nope'), null, 'usageFromName unknown');

    // metadata-driven caps with a stubbed device context
    const behaviors = new Map([
        [1, { id: 1, displayName: 'Key Press', metadata: [{
            param1: [{ name: 'usage', kind: 'hid_usage', keyboardMax: 0xFF, consumerMax: 0x3FF }],
            param2: [] }] }],
        [2, { id: 2, displayName: 'Momentary Layer', metadata: [{
            param1: [{ name: 'layer', kind: 'layer_id' }], param2: [] }] }],
        [3, { id: 3, displayName: 'Layer Tap', metadata: [{
            param1: [{ name: 'layer', kind: 'layer_id' }],
            param2: [{ name: 'key', kind: 'hid_usage', keyboardMax: 0xFF, consumerMax: 0x3FF }] }] }],
        [4, { id: 4, displayName: 'Transparent', metadata: [] }],
        [5, { id: 5, displayName: 'Smart Layer', metadata: [{
            param1: [{ name: 'layer', kind: 'layer_id' }],
            param2: [{ name: 'layer', kind: 'layer_id' }] }] }],
        [6, { id: 6, displayName: 'Sticky Layer', metadata: [{
            param1: [{ name: 'layer', kind: 'layer_id' }], param2: [] }] }],
    ]);
    setZmkContext({ behaviors, layers: [{ id: 0, name: 'Base' }, { id: 3, name: 'Fn' }] });

    eq(bindingCap({ behaviorId: 1, param1: kpParam(0x05), param2: 0 }), 'B', 'kp cap = bare usage');
    eq(bindingCap({ behaviorId: 2, param1: 3, param2: 0 }), 'MO·Fn', 'mo cap uses layer NAME by stable id');
    eq(bindingCap({ behaviorId: 3, param1: 0, param2: kpParam(0x2C) }), 'LT·Base·Spc', 'lt cap layer+key');
    eq(bindingCap({ behaviorId: 4, param1: 0, param2: 0 }), '▽', 'transparent glyph');
    eq(bindingCap({ behaviorId: 99, param1: 0, param2: 0 }), '#99', 'unknown behavior renders id');
    // Smart one-shot/hold abbrevs: explicit entries keep Smart Layer off
    // Sticky Layer's 'SL'. Since the 2026-07-11 rework the layer rides in
    // BOTH params (hold = sticky, tap = toggle) — the cap collapses the
    // duplicate to one layer name.
    eq(bindingCap({ behaviorId: 5, param1: 3, param2: 3 }), 'SmL·Fn', 'smart layer cap collapses layer+layer');
    eq(bindingCap({ behaviorId: 6, param1: 3, param2: 0 }), 'SL·Fn', 'sticky layer keeps SL');
    eq(bindingHover({ behaviorId: 2, param1: 3, param2: 0 }).split('\n')[0], 'Momentary Layer(Fn)', 'hover head');
}

// ---- flask_combos slot codec (channel 0x24 payload frames) ----
{
    const { COMBO_POS_NONE, COMBO_MAX_KEYS, decodeComboSlot, encodeComboSlot,
            comboSlotIsEmpty } = await import('./zmk-combos-codec.js');

    // encode: pads to 4 positions, usage big-endian
    eq(encodeComboSlot(3, { positions: [12, 40], usage: 0x02070004 }),
        [3, 12, 40, 0xFF, 0xFF, 0x02, 0x07, 0x00, 0x04],
        'combo encode 2-key slot (LS(A))');
    eq(encodeComboSlot(0, { positions: [], usage: 0 }),
        [0, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0],
        'combo encode empty slot');
    eq(encodeComboSlot(31, { positions: [1, 2, 3, 4], usage: 0xFFFFFFFF }),
        [31, 1, 2, 3, 4, 0xFF, 0xFF, 0xFF, 0xFF],
        'combo encode full slot, unsigned u32 survives');
    eq(encodeComboSlot(5, { positions: [9, 8, 7, 6, 5], usage: 0x70004 }),
        [5, 9, 8, 7, 6, 0x00, 0x07, 0x00, 0x04],
        'combo encode drops positions beyond 4');

    // decode: strips 0xFF, reassembles u32 unsigned
    eq(decodeComboSlot([3, 12, 40, 0xFF, 0xFF, 0x02, 0x07, 0x00, 0x04]),
        { slot: 3, positions: [12, 40], usage: 0x02070004 },
        'combo decode round-trip');
    eq(decodeComboSlot([7, 0xFF, 0xFF, 0xFF, 0xFF, 0x80, 0x07, 0x00, 0x04]).usage,
        0x80070004, 'combo decode keeps bit 31 unsigned');
    eq(decodeComboSlot(new Uint8Array([1, 2, 0xFF, 3, 0xFF, 0, 7, 0, 4])),
        { slot: 1, positions: [2, 3], usage: 0x70004 },
        'combo decode sparse positions + Uint8Array payload');

    // live-slot rule mirrors the firmware
    eq(comboSlotIsEmpty({ positions: [1, 2], usage: 0 }), true, 'no output = empty');
    eq(comboSlotIsEmpty({ positions: [1], usage: 0x70004 }), true, '1 key = empty');
    eq(comboSlotIsEmpty({ positions: [1, 2], usage: 0x70004 }), false, '2 keys + output = live');
    eq(COMBO_MAX_KEYS, 4, 'combo max keys pinned');
    eq(COMBO_POS_NONE, 0xFF, 'combo empty position pinned');
}

// ---- flask_macros step codec (channel 0x25 payload frames) ----
{
    const { MACRO_ACTION, decodeMacroStep, encodeMacroStep,
            macroIsEmpty, macroLiveSteps } = await import('./zmk-macros-codec.js');

    // encode: [slot, step, action, param u32 BE]
    eq(encodeMacroStep(2, 5, { action: MACRO_ACTION.tap, param: 0x02070004 }),
        [2, 5, 1, 0x02, 0x07, 0x00, 0x04],
        'macro encode tap step (LS(A))');
    eq(encodeMacroStep(0, 0, { action: MACRO_ACTION.wait, param: 1500 }),
        [0, 0, 4, 0x00, 0x00, 0x05, 0xDC],
        'macro encode wait step (1500 ms)');
    eq(encodeMacroStep(15, 15, { action: MACRO_ACTION.press, param: 0xFFFFFFFF }),
        [15, 15, 2, 0xFF, 0xFF, 0xFF, 0xFF],
        'macro encode press, unsigned u32 survives');
    eq(encodeMacroStep(1, 2, { action: 9, param: 0x70004 }),
        [1, 2, 0, 0, 0, 0, 0],
        'macro encode normalizes unknown action to empty (param zeroed)');
    eq(encodeMacroStep(1, 2, { action: MACRO_ACTION.empty, param: 0x70004 }),
        [1, 2, 0, 0, 0, 0, 0],
        'macro encode zeroes param on empty');

    // decode: reassembles u32 unsigned
    eq(decodeMacroStep([2, 5, 1, 0x02, 0x07, 0x00, 0x04]),
        { slot: 2, step: 5, action: 1, param: 0x02070004 },
        'macro decode round-trip');
    eq(decodeMacroStep(new Uint8Array([0, 1, 3, 0x80, 0x07, 0x00, 0x04])).param,
        0x80070004, 'macro decode keeps bit 31 unsigned');

    // live-prefix rule mirrors the firmware (playback stops at first empty)
    const steps = [
        { action: MACRO_ACTION.tap, param: 0x70004 },
        { action: MACRO_ACTION.wait, param: 100 },
        { action: MACRO_ACTION.empty, param: 0 },
        { action: MACRO_ACTION.tap, param: 0x70005 }, // dead — behind the empty
    ];
    eq(macroLiveSteps(steps).length, 2, 'live steps stop at first empty');
    eq(macroIsEmpty(steps), false, 'macro with a live first step is not empty');
    eq(macroIsEmpty([{ action: MACRO_ACTION.empty, param: 0 }]), true, 'empty first step = empty macro');
    eq(macroIsEmpty([]), true, 'no steps = empty macro');
}

// ---- offline imprint preview template (zmk-offline.js) ----
{
    const { createZmkTemplate, ZmkOfflineFlask, OfflineStudioClient,
            zmkPendingCount } = await import('./zmk-offline.js');
    const { CH, V } = await import('./flaskproto.js');

    // localStorage shim so saveWorkspace calls inside the sims don't throw.
    globalThis.localStorage ??= {
        _m: new Map(),
        getItem(k) { return this._m.get(k) ?? null; },
        setItem(k, v) { this._m.set(k, String(v)); },
        removeItem(k) { this._m.delete(k); },
        key(i) { return [...this._m.keys()][i] ?? null; },
        get length() { return this._m.size; },
    };

    const ws = createZmkTemplate('imprint');
    eq(ws.zmk.keymap.layers.length, 10, 'template has 10 layers');
    eq(ws.zmk.keymap.layers.every((l) => l.bindings.length === 70), true,
        'every template layer has 70 bindings');
    eq(ws.profile.keys.length, 70, 'template geometry has 70 keys');
    eq(ws.protocolVersion, 14, 'template speaks the expected imprint protocol');

    const flask = new ZmkOfflineFlask(ws);
    eq(await flask.getU16(CH.meta, V.metaFamily), 4, 'sim meta family = imprint');
    eq(await flask.getU16(CH.macros, V.macrosSlotCount), 32, 'sim macro slots (v9 Kconfig default)');
    eq(await flask.getU16(CH.macros, V.macrosStepCount), 32, 'sim macro steps (v9 Kconfig default)');
    eq(await flask.getU16(CH.combos, V.combosSlotCount), 64, 'sim combo slots (v9 Kconfig default)');
    eq(await flask.getU16(CH.combos, V.combosKeys), 8, 'sim advertises keys-per-slot (v9)');
    eq(await flask.getU16(CH.combos, V.combosTimeout), 50, 'sim seeds combo timeout default');
    eq(await flask.getU16(CH.autoscroll, V.asSpeedScale), 100, 'sim seeds autoscroll scale');
    // v9 seeds: accel boots disabled with drashna defaults; snap enabled.
    eq(await flask.getU16(CH.accel, V.accelEnabled), 0, 'sim accel boots disabled');
    eq(await flask.getU16(CH.accel, V.accelTakeoff), 200, 'sim accel takeoff default');
    eq(await flask.getU16(CH.scrollSnap, V.snapEnabled), 1, 'sim snap boots enabled');
    eq(await flask.getU16(CH.scrollSnap, V.snapThreshold), 63, 'sim snap threshold default');
    eq(await flask.getU16(CH.rgbMap, V.rgbmapEffect), 0, 'sim rgb effect boots off');
    // v13 seeds: auto-mouse mirrors the flask_automouse keymap node.
    eq(await flask.getU16(CH.autoMouse, V.amEnabled), 1, 'sim automouse boots enabled');
    eq(await flask.getU16(CH.autoMouse, V.amTimeout), 750, 'sim automouse timeout default');
    eq(await flask.getU16(CH.autoMouse, V.amThreshold), 0, 'sim automouse threshold default');
    eq(await flask.getU16(CH.autoMouse, V.amLayer), 3, 'sim automouse targets the Mouse layer');
    eq(await flask.getU16(CH.autoMouse, V.amExtend), 1, 'sim automouse extends on key');
    eq(await flask.setU16(CH.autoMouse, V.amTimeout, 0), 0, 'sim automouse latch (0) set echoes');
    eq(await flask.getU16(CH.autoMouse, V.amTimeout), 0, 'sim automouse latch persists');
    await flask.setU16(CH.autoMouse, V.amTimeout, 750);

    // Combo slot write round-trip + journal (8-position v9 frame).
    const comboFrame = [2, 10, 20, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x07, 0x00, 0x04];
    const echo = await flask.setBytes(CH.combos, V.combosSlot, comboFrame);
    eq([...echo], comboFrame, 'sim combo slot echoes (8-pos frame)');
    eq(zmkPendingCount(ws), 1, 'combo edit journals');

    // Macro step write normalizes unknown actions like the firmware.
    const mecho = await flask.setBytes(CH.macros, V.macrosStep, [0, 0, 9, 0, 0, 0, 5]);
    eq([...mecho], [0, 0, 0, 0, 0, 0, 0], 'sim macro step normalizes bad action to empty');

    // Studio sim: binding write + layer ops mirror real semantics.
    const studio = new OfflineStudioClient(ws);
    const km = await studio.getKeymap();
    eq(km.availableLayers, 0, 'template starts with no free layer slots');
    await studio.setLayerBinding(0, 13, { behaviorId: 1, param1: 0x70004, param2: 0 });
    eq(ws.zmk.keymap.layers[0].bindings[13].param1, 0x70004, 'sim binding write lands');
    await studio.removeLayer(9);
    eq((await studio.getKeymap()).availableLayers, 1, 'remove frees a slot');
    const added = await studio.addLayer();
    eq(added.index, 9, 'add reuses the freed slot at the end');
    eq((await studio.getKeymap()).availableLayers, 0, 'add consumes the slot');
    const moved = await studio.moveLayer(9, 0);
    eq(moved.layers.length, 10, 'move returns the full keymap');
    await studio.discardChanges();
    eq((await studio.getKeymap()).layers[9].name, 'spare4', 'discard restores the saved structure');

    // Metadata-less behavior (urob leader mirror, bench 5): listed by the
    // device, but assignment is rejected like real firmware — validate_binding
    // returns -ENODEV → INVALID_PARAMETERS, params zero or not.
    const ids = await studio.listAllBehaviors();
    const details = [];
    for (const id of ids) details.push(await studio.getBehaviorDetails(id));
    const nameless = details.find((d) => !d.displayName);
    eq(!!nameless, true, 'sim lists a metadata-less behavior (urob leader mirror)');
    let namelessErr = null;
    try {
        await studio.setLayerBinding(0, 14, { behaviorId: nameless.id, param1: 0, param2: 0 });
    } catch (e) { namelessErr = e.message; }
    eq(namelessErr, 'INVALID_PARAMETERS', 'sim rejects assigning the metadata-less behavior');
    // A named 0-param behavior accepts (0,0) but rejects junk in an unused
    // param slot (check_params_match_metadata: empty descriptors want 0).
    const fled = details.find((d) => d.displayName === 'Flask Leader');
    await studio.setLayerBinding(0, 14, { behaviorId: fled.id, param1: 0, param2: 0 });
    eq(ws.zmk.keymap.layers[0].bindings[14].behaviorId, fled.id, 'fled (0,0) assigns clean');
    let junkErr = null;
    try {
        await studio.setLayerBinding(0, 14, { behaviorId: fled.id, param1: 7, param2: 0 });
    } catch (e) { junkErr = e.message; }
    eq(junkErr, 'INVALID_PARAMETERS', 'nonzero param on a 0-param behavior is rejected');
    // The composer's assignability rule: display name present. v14 grew
    // the nameless set to 7 — urob's &leader plus the six slk_* OS-aware
    // shortcut behaviors the imported default combos reference.
    eq(details.filter((d) => d.displayName).length, details.length - 7,
        'exactly the nameless behaviors are composer-hidden');
    await studio.discardChanges();
}

// ---- offline keymap auto-sync queue (zmk-offline.js) ----
{
    const { createZmkTemplate, OfflineStudioClient, zmkPendingCount,
            zmkClearDirty, zmkApplyPendingKeymap } = await import('./zmk-offline.js');

    const ws = createZmkTemplate('imprint');
    const studio = new OfflineStudioClient(ws);
    eq(ws.zmk.pendingKeymap, null, 'template starts with no queued keymap');

    await studio.setLayerBinding(0, 5, { behaviorId: 1, param1: 0x70005, param2: 0 });
    eq(zmkPendingCount(ws), 0, 'unsaved keymap edit does not queue');
    await studio.saveChanges();
    eq(zmkPendingCount(ws), 1, 'offline Save queues the keymap');
    eq(ws.zmk.pendingKeymap.kind, 'flask-zmk-keymap', 'queued keymap is export-shaped');
    eq(ws.zmk.pendingKeymap.layers.length, 10, 'queued keymap carries all layers');
    eq(typeof ws.zmk.pendingKeymap.layers[0].bindings[5].behavior, 'string',
        'queued bindings carry behavior display names');

    // Consume path: success clears the queue…
    const app = { zmkQueuedWs: ws };
    const res = await zmkApplyPendingKeymap(app, async (data) =>
        ({ wrote: data.layers.length, renamed: 0, skipped: 0, stopped: false }));
    eq(res.wrote, 10, 'applier receives the queued data');
    eq(ws.zmk.pendingKeymap, null, 'successful apply clears the queue');
    eq(app.zmkQueuedWs, null, 'successful apply clears the stash');

    // …a stopped/locked apply leaves it queued for the next connect.
    await studio.saveChanges();
    app.zmkQueuedWs = ws;
    await zmkApplyPendingKeymap(app, async () =>
        ({ wrote: 1, renamed: 0, skipped: 0, stopped: true }));
    eq(zmkPendingCount(ws), 1, 'stopped apply keeps the keymap queued');
    await zmkApplyPendingKeymap(app, async () => null);
    eq(zmkPendingCount(ws), 1, 'locked apply keeps the keymap queued');

    zmkClearDirty(ws);
    eq(zmkPendingCount(ws), 0, 'zmkClearDirty drops the queued keymap');
}

// ---- combos codec: keys-per-slot sized frames (zmk-combos-codec.js) ----
{
    const { encodeComboSlot, decodeComboSlot, COMBO_MAX_KEYS } =
        await import('./zmk-combos-codec.js');

    // Default (v7/v8) stays byte-compatible with the old 4-pos frame.
    eq(COMBO_MAX_KEYS, 4, 'codec default stays at the v7/v8 wire shape');
    const legacy = encodeComboSlot(3, { positions: [10, 20], usage: 0x70004 });
    eq(legacy.length, 9, 'default frame is 9 bytes');
    eq(decodeComboSlot(legacy).usage, 0x70004, 'default round-trip usage');

    // v9: 8-pos frame, usage shifts after the position block.
    const wide = encodeComboSlot(3, { positions: [10, 20, 30], usage: 0x70004 }, 8);
    eq(wide.length, 13, 'v9 frame is 13 bytes');
    const back = decodeComboSlot(wide, 8);
    eq(back.positions.join(','), '10,20,30', 'v9 round-trip positions');
    eq(back.usage, 0x70004, 'v9 round-trip usage');
}

// ---- typed-output codecs: leader + gestures (zmk-output-codec.js) ----
{
    const { encodeLeaderSlot, decodeLeaderSlot, leaderSlotIsEmpty,
            encodeGestureSlot, decodeGestureSlot, OUTPUT_ACTION } =
        await import('./zmk-output-codec.js');

    const lf = encodeLeaderSlot(2, { positions: [13, 14], action: 1, param: 0x70004 }, 8);
    eq(lf.length, 14, 'leader frame = seq + 8 pos + action + u32');
    const lb = decodeLeaderSlot(lf, 8);
    eq(lb.positions.join(','), '13,14', 'leader round-trip preserves ORDER');
    eq(lb.action, 1, 'leader round-trip action');
    eq(lb.param, 0x70004, 'leader round-trip param');
    // Sequences are the leading prefix: a hole ends the decode.
    const holed = decodeLeaderSlot([0, 5, 0xFF, 9, ...new Array(11).fill(0xFF)], 8);
    eq(holed.positions.join(','), '5', 'leader decode stops at the first empty');
    eq(leaderSlotIsEmpty({ positions: [3], action: OUTPUT_ACTION.none }), true,
        'no output = empty sequence');
    eq(leaderSlotIsEmpty({ positions: [3], action: OUTPUT_ACTION.macro, param: 2 }), false,
        'macro output = live sequence');

    const gf = encodeGestureSlot(3, 6, { action: 2, param: 5 });
    eq(gf.length, 7, 'gesture frame = set + dir + action + u32');
    const gb = decodeGestureSlot(gf);
    eq([gb.set, gb.dir, gb.action, gb.param].join(','), '3,6,2,5', 'gesture round-trip');
}

// ---- v10 sim: leader + gesture channels ----
{
    const { createZmkTemplate, ZmkOfflineFlask, zmkPendingCount, zmkClearDirty } =
        await import('./zmk-offline.js');
    const { CH, V } = await import('./flaskproto.js');
    const { encodeLeaderSlot, decodeLeaderSlot, encodeGestureSlot, decodeGestureSlot } =
        await import('./zmk-output-codec.js');

    const ws = createZmkTemplate('imprint');
    eq(ws.protocolVersion, 14, 'template speaks v14');
    const flask = new ZmkOfflineFlask(ws);
    eq(await flask.getU16(CH.leader, V.leaderSlotCount), 32, 'sim leader slots');
    eq(await flask.getU16(CH.leader, V.leaderKeys), 8, 'sim leader keys-per-seq');
    eq(await flask.getU16(CH.leader, V.leaderTimeout), 1000, 'sim leader timeout default');
    eq(await flask.getU16(CH.gestures, V.gesturesSetCount), 8, 'sim gesture sets');
    eq(await flask.getU16(CH.gestures, V.gesturesRatchetStep), 150, 'sim ratchet default');

    // Firmware-seeded defaults: set 0 East = Right Arrow (0x7004F).
    const east = decodeGestureSlot(await flask.getBytes(CH.gestures, V.gesturesSlot, [0, 0]));
    eq(east.action, 1, 'set 0 East seeds a usage output');
    eq(east.param, 0x7004F, 'set 0 East = Right Arrow');
    // Set 3 West = ^⇧Tab (mods 0x03 << 24 | 0x7002B).
    const w3 = decodeGestureSlot(await flask.getBytes(CH.gestures, V.gesturesSlot, [3, 4]));
    eq(w3.param >>> 0, ((0x03 << 24) | 0x7002B) >>> 0, 'set 3 West = Ctrl-Shift-Tab');

    // Writes journal + normalize + echo.
    const le = await flask.setBytes(CH.leader, V.leaderSlot,
        encodeLeaderSlot(0, { positions: [12, 200, 13], action: 9, param: 7 }, 8));
    const lb = decodeLeaderSlot(le, 8);
    eq(lb.positions.join(','), '12,13', 'sim drops off-board leader positions');
    eq(lb.action, 0, 'sim normalizes unknown leader action to none');
    const ge = await flask.setBytes(CH.gestures, V.gesturesSlot,
        encodeGestureSlot(1, 1, { action: 2, param: 4 }));
    eq(decodeGestureSlot(ge).param, 4, 'sim gesture write echoes');
    eq(zmkPendingCount(ws), 2, 'leader + gesture edits journal');

    // ---- v11: ball swap channel (0x27) ----
    eq(await flask.getU16(CH.ballSwap, V.bswapSwapped), 0, 'sim boots unswapped');
    eq(await flask.getU16(CH.ballSwap, V.bswapEffective), 0, 'sim effective mirrors base');
    eq(await flask.setU16(CH.ballSwap, V.bswapSwapped, 1), 1, 'sim swap set echoes');
    eq(await flask.getU16(CH.ballSwap, V.bswapEffective), 1, 'sim effective follows the base');
    eq(await flask.setU16(CH.ballSwap, V.bswapSwapped, 0), 0, 'sim swap clears');
    zmkClearDirty(ws);
    eq(zmkPendingCount(ws), 0, 'clear drops v10 extras too');
}

// ---- full-device export/import round trip (zmk-export.js) ----
{
    const { createZmkTemplate, ZmkOfflineFlask } = await import('./zmk-offline.js');
    const { zmkCapabilities } = await import('./zmk.js');
    const { exportFlaskState, applyFlaskState } = await import('./zmk-export.js');
    const { CH, V } = await import('./flaskproto.js');
    const { encodeComboSlot } = await import('./zmk-combos-codec.js');
    const { encodeLeaderSlot } = await import('./zmk-output-codec.js');

    const mkApp = () => {
        const ws = createZmkTemplate('imprint');
        return { ws, flask: new ZmkOfflineFlask(ws),
            caps: zmkCapabilities('imprint', ws.protocolVersion),
            protocolVersion: ws.protocolVersion };
    };

    // Device A: make it distinctive.
    const a = mkApp();
    await a.flask.setU16(CH.scrollSnap, V.snapThreshold, 80);
    await a.flask.setBytes(CH.rgbMap, V.rgbmapLed, [1, 7, 10, 20, 30]);
    await a.flask.setBytes(CH.combos, V.combosSlot,
        encodeComboSlot(5, { positions: [10, 11], usage: 0x70005 }, 8));
    await a.flask.setBytes(CH.leader, V.leaderSlot,
        encodeLeaderSlot(3, { positions: [12, 13], action: 2, param: 4 }, 8));
    await a.flask.setU16(CH.gestures, V.gesturesActiveSet, 2);

    await a.flask.setU16(CH.autoMouse, V.amTimeout, 0);       // latch mode
    await a.flask.setU16(CH.autoMouse, V.amThreshold, 40);

    const state = await exportFlaskState(a);
    eq(state.scrollSnap.threshold, 80, 'export carries snap threshold');
    eq(state.autoMouse.timeout, 0, 'export carries the automouse latch timeout (v13)');
    eq(state.autoMouse.threshold, 40, 'export carries the automouse threshold');
    eq(state.rgb.map[1][7].join(','), '10,20,30', 'export carries the RGB map');
    eq(state.combos.slots[5].action, 1, 'export carries typed combo slots (v12)');
    eq(state.combos.slots[5].param1, 0x70005, 'export carries the combo usage as param1');
    eq(state.leader.slots[3].action, 2, 'export carries leader slots');
    eq(state.gestures.activeSet, 2, 'export carries the active gesture set');
    eq(state.gestures.sets[0][0].param, 0x7004F, 'export carries seeded gesture sets');

    // Device B (fresh): import restores everything.
    const b = mkApp();
    const { applied, failures } = await applyFlaskState(b, state);
    eq(failures.length, 0, 'import applies with no failures');
    eq(applied > 700, true, 'import writes the full surface (map + slots + knobs)');
    eq(await b.flask.getU16(CH.scrollSnap, V.snapThreshold), 80, 'import restored snap');
    const led = await b.flask.getBytes(CH.rgbMap, V.rgbmapLed, [1, 7]);
    eq([led[2], led[3], led[4]].join(','), '10,20,30', 'import restored the RGB map');
    eq(await b.flask.getU16(CH.gestures, V.gesturesActiveSet), 2, 'import restored active set');
    eq(await b.flask.getU16(CH.autoMouse, V.amTimeout), 0, 'import restored automouse latch');
    eq(await b.flask.getU16(CH.autoMouse, V.amThreshold), 40, 'import restored automouse threshold');
    const b5 = await b.flask.getBytes(CH.combos, V.combosSlot, [5]);
    eq(b5[1], 10, 'import restored combo positions');

    // Modes switch: `save: false` writes everything LIVE and touches no
    // channel's SAVE. This is the whole point of an app-side mode — the
    // device keeps one saved baseline and alternates never enter the SAVE
    // path or grow the 32 KB settings partition.
    const c = mkApp();
    const cSaves = [];
    c.flask.save = async (ch) => { cSaves.push(ch); };
    const live = await applyFlaskState(c, state, { save: false });
    eq(live.failures.length, 0, 'live-apply lands with no failures');
    eq(cSaves.length, 0, 'live-apply issues no SAVE for any channel');
    eq(live.saved, 0, 'live-apply reports nothing saved');
    eq(await c.flask.getU16(CH.scrollSnap, V.snapThreshold), 80,
        'live-apply still writes values through to the device');
    eq(await c.flask.getU16(CH.autoMouse, V.amThreshold), 40,
        'live-apply writes automouse through too');

    // …and the default still saves, so import/auto-restore are unchanged.
    const d = mkApp();
    const dSaves = [];
    d.flask.save = async (ch) => { dSaves.push(ch); };
    const persisted = await applyFlaskState(d, state);
    eq(dSaves.length > 0, true, 'default apply still SAVEs each touched channel');
    eq(persisted.saved, dSaves.length, 'default apply reports the saved channel count');
}

// ---- colour picker maths (colorpicker.js) ----
{
    const C = await import('./colorpicker.js');

    // The picker speaks the FIRMWARE's space (h/s/v 0-255), so a colour that
    // survives a round trip is a colour the board renders as shown.
    for (const hsv of [[0, 0, 255], [0, 255, 255], [85, 255, 255], [170, 255, 255],
                       [128, 128, 128], [0, 0, 0], [212, 200, 90]]) {
        const back = C.rgbToHsv(...C.hsvToRgb(...hsv));
        // Hue is meaningless with no saturation, and both are meaningless at
        // zero value — only assert what the colour space actually preserves.
        if (hsv[2] === 0) { eq(back[2], 0, `hsv ${hsv} round-trips black`); continue; }
        eq(Math.abs(back[1] - hsv[1]) <= 1, true, `hsv ${hsv} round-trips saturation`);
        eq(Math.abs(back[2] - hsv[2]) <= 1, true, `hsv ${hsv} round-trips value`);
        if (hsv[1] > 0) {
            eq(Math.min(Math.abs(back[0] - hsv[0]), 255 - Math.abs(back[0] - hsv[0])) <= 1,
                true, `hsv ${hsv} round-trips hue`);
        }
    }

    eq(C.hsvHex(0, 0, 255), '#ffffff', 'full value, no saturation is white');
    eq(C.hsvHex(0, 255, 255), '#ff0000', 'hue 0 is red');
    eq(C.hsvHex(85, 255, 255), '#00ff00', 'hue 85 is green');
    eq(C.hsvHex(170, 255, 255), '#0000ff', 'hue 170 is blue');
    eq(C.hsvHex(0, 0, 0), '#000000', 'zero value is black');

    eq(C.hexToHsv('#ff0000').join(','), '0,255,255', 'hex red parses');
    eq(C.hexToHsv('f00').join(','), '0,255,255', 'shorthand hex parses');
    eq(C.hexToHsv('00FF00').join(','), '85,255,255', 'hex is case-insensitive, # optional');
    eq(C.hexToHsv('nope'), null, 'a non-colour is rejected, not coerced');
    eq(C.hexToHsv('#12345'), null, 'a partial hex is rejected');
    eq(C.hexToHsv(''), null, 'empty is rejected');
    eq(C.hexToHsv(null), null, 'null is rejected');

    // hsvCssOf must agree with the existing painter, or a swatch would preview
    // a different colour than the board shows.
    const { hsvCss } = await import('./rgb-tab.js');
    for (const hsv of [[0, 255, 255], [85, 255, 255], [128, 128, 128], [212, 200, 90]]) {
        eq(C.hsvCssOf(...hsv), hsvCss(...hsv), `picker preview matches the painter for ${hsv}`);
    }

    eq(C.COLOR_PRESETS.length > 0, true, 'presets exist');
    eq(C.COLOR_PRESETS.every((p) => p.name && p.hsv.length === 3
        && p.hsv.every((n) => n >= 0 && n <= 255)), true, 'every preset is a named, in-range hsv');
}

// ---- Modes store (zmk-modes.js) ----
{
    const M = await import('./zmk-modes.js');
    const payload = (layers = 3, flask = null) => ({
        kind: 'flask-zmk-keymap', version: 2,
        layers: Array.from({ length: layers }, (_, i) => ({ name: `L${i}`, bindings: [] })),
        ...(flask ? { flask } : {}),
    });

    eq(M.modesStoreKey('imprint'), 'flask-zmk-modes:imprint', 'modes are stored per family');
    eq(M.normalizeStore(null).modes.length, 0, 'a missing store degrades to empty');
    eq(M.normalizeStore({ modes: 'nope' }).modes.length, 0, 'a corrupt store degrades to empty');

    let s = M.emptyStore();
    ({ store: s } = M.addMode(s, 'Radiology', payload()));
    ({ store: s } = M.addMode(s, 'Radiology', payload()));
    eq(s.modes[1].name, 'Radiology 2', 'a duplicate name is disambiguated, not silently merged');
    ({ store: s } = M.addMode(s, '   ', payload()));
    eq(s.modes[2].name, 'Untitled', 'a blank name falls back rather than creating an unclickable row');
    eq(new Set(s.modes.map((m) => m.id)).size, 3, 'mode ids are unique');

    // Baseline pointer integrity — a badge must never outlive its mode.
    s = M.setBaseline(s, s.modes[0].id);
    eq(s.baselineId, s.modes[0].id, 'baseline points at the chosen mode');
    s = M.setBaseline(s, 'nope');
    eq(s.baselineId, null, 'baseline refuses an id that is not in the store');
    s = M.setBaseline(s, s.modes[0].id);
    const keptId = s.modes[1].id;
    s = M.deleteMode(s, s.modes[0].id);
    eq(s.baselineId, null, 'deleting the baseline mode clears the pointer');
    eq(M.normalizeStore({ modes: s.modes, baselineId: 'ghost' }).baselineId, null,
        'a dangling baseline id is dropped on load');

    // Rename must not collide with OTHER modes but may keep its own name.
    s = M.renameMode(s, keptId, 'Radiology 2');
    eq(M.getMode(s, keptId).name, 'Radiology 2', 'renaming to its own name is a no-op, not "… 2"');

    eq(M.isModePayload(payload()), true, 'a v2 export is a valid mode payload');
    eq(M.isModePayload({ kind: 'something-else', layers: [] }), false, 'a foreign file is rejected');
    eq(M.isModePayload({ kind: 'flask-zmk-keymap' }), false, 'a payload with no layers is rejected');

    eq(M.modeSummary({ data: payload(3) }), '3 layers · keymap only',
        'a keymap-only snapshot says so rather than implying module state');
    eq(M.modeSummary({ data: payload(1, { rgb: {}, combos: {} }) }), '1 layer · RGB, combos',
        'the summary names the sections a mode actually carries');
}

// ---- v13 caps + profile decorations (zmk.js) ----
{
    const { zmkCapabilities, zmkProfile, ZMK_TRACKBALLS } = await import('./zmk.js');
    const v12 = zmkCapabilities('imprint', 12);
    const v13 = zmkCapabilities('imprint', 13);
    eq(v12.autoMouse, false, 'v12 firmware has no automouse channel');
    eq(v13.autoMouse, true, 'v13 firmware unlocks the automouse card');
    eq(v13.autoMouseLatch && v13.autoMouseExtend, true, 'v13 unlocks latch + extend semantics');
    eq(ZMK_TRACKBALLS.imprint.length, 2, 'imprint carries two trackball decorations');
    const prof = zmkProfile('imprint');
    eq(prof.decorations.length, 2, 'profile publishes the trackball decorations');
    eq(prof.decorations.map((d) => d.side).join(','), 'left,right', 'balls tagged by side');
}

// ---- RGB painter LED → key geometry mapping (zmk-rgb-tab.js) ----
{
    const { ledKeyOrder } = await import('./zmk-rgb-tab.js');
    // Two halves of 2 keys each, right half offset in x; thumb-cluster-style
    // stragglers keep position order within their half.
    const keys = [
        { pos: 0, x: 0, y: 0, w: 1, h: 1 }, { pos: 1, x: 1, y: 0, w: 1, h: 1 },
        { pos: 2, x: 10, y: 0, w: 1, h: 1 }, { pos: 3, x: 11, y: 0, w: 1, h: 1 },
        { pos: 4, x: 2, y: 3, w: 1, h: 1 },  // left thumb
        { pos: 5, x: 9, y: 3, w: 1, h: 1 },  // right thumb
    ];
    const order = ledKeyOrder(keys, 6);
    eq(order.map((k) => k.pos).join(','), '0,1,4,2,3,5',
        'central LEDs walk the left half in position order, then the right');
    eq(ledKeyOrder([], 4).length, 0, 'no geometry = no mapping (grid fallback)');
    const short = ledKeyOrder(keys.slice(0, 2), 6);
    eq(short.filter(Boolean).length, 2, 'LEDs past the key list stay unmapped');
}

// ---- Studio layer-op wire encodings (zmk-studio.js) ----
// AddLayerRequest is an EMPTY SUB-MESSAGE (wire type 2), not a bool varint —
// encoding it like get_keymap made real firmware reject layer adds while the
// wire-less offline sim passed (bench 2026-07-11). Field 9, length 0.
eq(fBytes(9, []), [0x4A, 0x00], 'add_layer = empty length-delimited field 9');

// ---- LED→key custom measured map (zmk-rgb-tab.js wizard store) ----
{
    const { ledKeyOrder, saveLedMap, storedLedMap } = await import('./zmk-rgb-tab.js');
    // Node has no localStorage — storedLedMap must fail soft (guess path).
    eq(storedLedMap(), null, 'no localStorage = no stored map');
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    const keys = [
        { pos: 0, x: 0, y: 0, w: 1, h: 1 }, { pos: 1, x: 1, y: 0, w: 1, h: 1 },
        { pos: 2, x: 10, y: 0, w: 1, h: 1 }, { pos: 3, x: 11, y: 0, w: 1, h: 1 },
    ];
    // Measured order wins over the geometry guess; null = unmapped (underglow).
    saveLedMap([2, null, 0, 1]);
    const order = ledKeyOrder(keys, 4);
    eq(order.map((k) => k?.pos ?? null), [2, null, 0, 1], 'stored wizard map drives LED order');
    // Stale map for a different LED count is ignored → geometry guess.
    eq(ledKeyOrder(keys, 3).map((k) => k?.pos ?? null), [0, 1, 2],
        'length-mismatched stored map falls back to the guess');
    saveLedMap(null);
    eq(storedLedMap(), null, 'cleared map reads back null');
    delete globalThis.localStorage;
}

// ---- FlaskHID reply matcher: payload-address echo (webhid.js) ----
// A LATE reply for slot 3 (after its request timed out) must not satisfy the
// in-flight slot-4 request — with echoBytes the matcher checks the address
// prefix, so the stale frame is dropped and the real answer is adopted.
{
    const { FlaskHID } = await import('./webhid.js');
    const hid = new FlaskHID();
    hid.device = { opened: true, sendReport: async () => {} };
    const reply = (bytes) => {
        const buf = new Uint8Array(32);
        buf.set(bytes);
        hid._onInputReport({ data: new DataView(buf.buffer) });
    };
    const tick = () => new Promise((r) => setImmediate(r));
    // Combos slot GET [0x08, 0x24, 0x10, slot] with echoBytes 1.
    const p = hid.request([0x08, 0x24, 0x10, 4], 1);
    await tick();                               // let the queued send arm _pending
    reply([0x08, 0x24, 0x10, 3, 13, 14]);      // stale slot-3 frame → dropped
    reply([0x08, 0x24, 0x10, 4, 21, 22]);      // slot-4 answer → adopted
    const r = await p;
    eq(r.slice(3, 6), [4, 21, 22], 'echo matcher drops the stale slot frame');
    // echoBytes 0 keeps the old semantics: any same-(channel, value) reply.
    const p0 = hid.request([0x08, 0x24, 0x02], 0);
    await tick();
    reply([0x08, 0x24, 0x02, 0, 64]);
    eq((await p0)[4], 64, 'echoBytes 0 = legacy channel/value match');
}

// ---- client-side slot names (zmk.js — bench-5 rename ask) ----
{
    // The LED-map block above deletes the shared shim (it asserts the
    // no-localStorage path) — install a fresh one for this block.
    globalThis.localStorage = {
        _m: new Map(),
        getItem(k) { return this._m.get(k) ?? null; },
        setItem(k, v) { this._m.set(k, String(v)); },
        removeItem(k) { this._m.delete(k); },
    };
    const { zmkSlotName, zmkSetSlotName, zmkAllSlotNames, zmkApplySlotNames } =
        await import('./zmk.js');
    zmkSetSlotName('imprint', 'combos', 3, 'copy-pair');
    eq(zmkSlotName('imprint', 'combos', 3), 'copy-pair', 'slot name round-trips');
    zmkSetSlotName('imprint', 'combos', 3, '');
    eq(zmkSlotName('imprint', 'combos', 3), '', 'empty commit clears the name');
    zmkApplySlotNames('imprint', { macros: { 0: 'hello' } });
    eq(zmkAllSlotNames('imprint').macros[0], 'hello', 'import applies the whole table');
    delete globalThis.localStorage;
}

// ---- v12: typed combo slots + runtime LED order ----
{
    globalThis.localStorage = {
        _m: new Map(),
        getItem(k) { return this._m.get(k) ?? null; },
        setItem(k, v) { this._m.set(k, String(v)); },
        removeItem(k) { this._m.delete(k); },
    };
    const { createZmkTemplate, ZmkOfflineFlask } = await import('./zmk-offline.js');
    const { CH, V } = await import('./flaskproto.js');
    const { encodeComboSlotV2, decodeComboSlotV2, COMBO_ACTION } =
        await import('./zmk-combos-codec.js');

    const t = { positions: [3, 9], action: COMBO_ACTION.behavior,
        behaviorId: 0xBEEF, param1: 0x02070004, param2: 7 };
    const enc = encodeComboSlotV2(5, t, 8);
    eq(enc.length, 1 + 8 + 11, 'v2 frame length (8-key device)');
    eq(decodeComboSlotV2(enc, 8), { slot: 5, ...t }, 'v2 codec round trip');

    const ws = createZmkTemplate('imprint');
    const flask = new ZmkOfflineFlask(ws);
    const echo = await flask.setBytes(CH.combos, V.combosSlotV2, encodeComboSlotV2(2, t, 8));
    eq(decodeComboSlotV2(echo, 8).action, COMBO_ACTION.behavior, 'sim stores behavior action');
    const legacy = await flask.getBytes(CH.combos, V.combosSlot, [2], 1);
    eq((legacy[9] | legacy[10] | legacy[11] | legacy[12]) >>> 0, 0,
        'legacy view reports usage 0 for a behavior slot');
    await flask.setBytes(CH.combos, V.combosSlot,
        [3, 1, 2, 255, 255, 255, 255, 255, 255, 0x00, 0x07, 0x00, 0x04]);
    const typed = decodeComboSlotV2(await flask.getBytes(CH.combos, V.combosSlotV2, [3], 1), 8);
    eq(typed.action, COMBO_ACTION.usage, 'legacy write lands as a usage action');
    eq(typed.param1, 0x70004, 'legacy usage carried into param1');

    await flask.setBytes(CH.rgbMap, V.rgbmapLedOrder, [10, 4, 60, 61, 62, 255]);
    eq([...await flask.getBytes(CH.rgbMap, V.rgbmapLedOrder, [10, 4], 2)],
        [10, 4, 60, 61, 62, 255], 'ledOrder chunk round trip');
    delete globalThis.localStorage;
}

// ---- v14: timed combo slots, imported defaults, csk, tap dance, brightness ----
{
    globalThis.localStorage = {
        _m: new Map(),
        getItem(k) { return this._m.get(k) ?? null; },
        setItem(k, v) { this._m.set(k, String(v)); },
        removeItem(k) { this._m.delete(k); },
    };
    const { createZmkTemplate, ZmkOfflineFlask } = await import('./zmk-offline.js');
    const { CH, V } = await import('./flaskproto.js');
    const { encodeComboSlotV3, decodeComboSlotV3, COMBO_ACTION, COMBO_LAYER_ANY } =
        await import('./zmk-combos-codec.js');
    const { encodeCskSlot, decodeCskSlot, cskSlotIsEmpty } =
        await import('./zmk-csk-codec.js');
    const { TD_ACTION, encodeTdStep, decodeTdStep, encodeTdCfg, decodeTdCfg,
        tdDanceLength } = await import('./zmk-tapdance-codec.js');

    // v3 codec round trip (timing + layer ride behind the v2 frame).
    const t3 = { positions: [3, 9], action: COMBO_ACTION.behavior,
        behaviorId: 0xBEEF, param1: 0x02070004, param2: 7,
        timeoutMs: 120, priorIdleMs: 150, layer: 2 };
    const enc3 = encodeComboSlotV3(6, t3, 8);
    eq(enc3.length, 1 + 8 + 11 + 5, 'v3 frame length (8-key device)');
    eq(decodeComboSlotV3(enc3, 8), { slot: 6, ...t3 }, 'v3 codec round trip');

    // Sim boots the IMPORTED devicetree combos (28 defaults, firmware boot
    // state), not an empty table.
    const ws = createZmkTemplate('imprint');
    const flask = new ZmkOfflineFlask(ws);
    const d0 = decodeComboSlotV3(await flask.getBytes(CH.combos, V.combosSlotV3, [0], 1), 8);
    eq(d0.positions, [27, 26], 'default 0 = copy_cut positions');
    eq(d0.timeoutMs, 35, 'default 0 timeout 35 ms');
    eq(d0.priorIdleMs, 150, 'default 0 prior-idle 150 ms');
    eq(d0.layer, COMBO_LAYER_ANY, 'default 0 fires on all layers');
    const d15 = decodeComboSlotV3(await flask.getBytes(CH.combos, V.combosSlotV3, [15], 1), 8);
    eq(d15.layer, 0, 'excl combo is layer-0 gated');
    const d27 = decodeComboSlotV3(await flask.getBytes(CH.combos, V.combosSlotV3, [27], 1), 8);
    eq(d27.action, COMBO_ACTION.behavior, 'rrep default is a behavior output');
    const d25 = decodeComboSlotV3(await flask.getBytes(CH.combos, V.combosSlotV3, [25], 1), 8);
    eq(d25.timeoutMs, 50, 'z combo keeps its 50 ms window');
    eq(d25.param2 >>> 0, 0x7001D, 'z combo carries lt tap usage in param2');

    // v3 write normalization: timeout clamps 10..2000, emptied slot resets
    // timing/layer.
    const echo3 = decodeComboSlotV3(await flask.setBytes(CH.combos, V.combosSlotV3,
        encodeComboSlotV3(40, { positions: [1, 2], action: COMBO_ACTION.usage,
            param1: 0x70004, timeoutMs: 5, priorIdleMs: 90, layer: 3 }, 8)), 8);
    eq(echo3.timeoutMs, 10, 'v3 timeout clamps up to 10');
    eq(echo3.layer, 3, 'v3 layer stored');
    const cleared = decodeComboSlotV3(await flask.setBytes(CH.combos, V.combosSlotV3,
        encodeComboSlotV3(40, { positions: [], action: COMBO_ACTION.none,
            timeoutMs: 500, priorIdleMs: 90, layer: 3 }, 8)), 8);
    eq(cleared.timeoutMs, 0, 'emptied slot zeroes timeout');
    eq(cleared.layer, COMBO_LAYER_ANY, 'emptied slot resets the layer gate');

    // csk codec + sim round trip.
    const cskEnc = encodeCskSlot(4, { base: 0x70036, shifted: 0x70033 });
    eq(cskEnc.length, 9, 'csk frame length');
    eq(decodeCskSlot(cskEnc), { slot: 4, base: 0x70036, shifted: 0x70033 },
        'csk codec round trip');
    eq(cskSlotIsEmpty({ base: 0, shifted: 0 }), true, 'csk empty rule');
    const cskEcho = decodeCskSlot(await flask.setBytes(CH.customShift, V.cskSlot, cskEnc));
    eq(cskEcho.base, 0x70036, 'sim stores the csk base');
    eq(await flask.getU16(CH.customShift, V.cskSlotCount), 16, 'csk slot count');
    eq(await flask.getU16(CH.customShift, V.cskEnabled), 1, 'csk boots enabled');

    // tap dance codec + sim round trip (term clamp + step normalization).
    const stepEnc = encodeTdStep(2, 1, { action: TD_ACTION.usage, param1: 0x70005 });
    eq(stepEnc.length, 13, 'td step frame length');
    eq(decodeTdStep(stepEnc), { slot: 2, tap: 1, action: TD_ACTION.usage,
        behaviorId: 0, param1: 0x70005, param2: 0 }, 'td step codec round trip');
    eq(decodeTdCfg(encodeTdCfg(2, 250)), { slot: 2, termMs: 250 }, 'td cfg codec round trip');
    const cfgEcho = decodeTdCfg(await flask.setBytes(CH.tapDance, V.tdCfg, encodeTdCfg(2, 20)));
    eq(cfgEcho.termMs, 50, 'sim clamps the term up to 50');
    await flask.setBytes(CH.tapDance, V.tdStep, stepEnc);
    const stepBack = decodeTdStep(await flask.getBytes(CH.tapDance, V.tdStep, [2, 1], 2));
    eq(stepBack.param1, 0x70005, 'sim stores the td step');
    eq(tdDanceLength([{ action: 1 }, { action: 0 }, { action: 1 }]), 1,
        'dance length is the contiguous prefix');
    eq(await flask.getU16(CH.tapDance, V.tdSlotCount), 16, 'td slot count');
    eq(await flask.getU16(CH.tapDance, V.tdTaps), 4, 'td taps per slot');

    // v14 leader capacity + brightness seed.
    eq(await flask.getU16(CH.leader, V.leaderSlotCount), 32, 'leader slots 32 (v14)');
    eq(await flask.getU16(CH.rgbMap, V.rgbmapBrightness), 100, 'brightness boots 100%');
    const b = await flask.setU16(CH.rgbMap, V.rgbmapBrightness, 60);
    eq(b, 60, 'brightness set echoes');
    delete globalThis.localStorage;
}

// ---- keymap auto-restore snapshot/diff (zmk-keymap-sync.js, pure) ----
{
    const { keymapLayersData, diffKeymapLayers, keymapDiffers } =
        await import('./zmk-keymap-sync.js');

    const behaviors = new Map([
        [7, { displayName: 'Key Press' }],
        [9, { displayName: 'Momentary Layer' }],
        [11, { displayName: '' }],          // metadata-less: name must NOT match
    ]);
    const keymap = { layers: [
        { name: 'Base', bindings: [
            { behaviorId: 7, param1: 0x70004, param2: 0 },
            { behaviorId: 9, param1: 1, param2: 0 },
        ] },
        { name: 'Nav', bindings: [{ behaviorId: 7, param1: 0x70050, param2: 0 }] },
    ] };
    const snap = keymapLayersData(keymap, behaviors);
    eq(snap[0].bindings[0], { behavior: 'Key Press', behaviorId: 7, param1: 0x70004, param2: 0 },
        'snapshot carries display name + id + params');

    // identical → no diff
    const live = JSON.parse(JSON.stringify(snap));
    eq(diffKeymapLayers(snap, live), { keys: 0, names: 0, layersA: 2, layersB: 2 },
        'identical layers diff clean');
    eq(keymapDiffers(diffKeymapLayers(snap, live)), false, 'identical = no restore');

    // param drift on one key
    live[0].bindings[1].param1 = 3;
    eq(diffKeymapLayers(snap, live).keys, 1, 'param change counts one key');

    // cross-build: ids shifted but names match → clean
    const rebuilt = JSON.parse(JSON.stringify(snap));
    rebuilt[0].bindings[0].behaviorId = 99;
    eq(diffKeymapLayers(snap, rebuilt).keys, 0, 'name match beats id drift');

    // name-less on one side falls back to id compare
    const anon = JSON.parse(JSON.stringify(snap));
    anon[0].bindings[0].behavior = null;
    eq(diffKeymapLayers(snap, anon).keys, 0, 'null name falls back to same id');
    anon[0].bindings[0].behaviorId = 99;
    eq(diffKeymapLayers(snap, anon).keys, 1, 'null name + id drift = differs');

    // layer rename + count mismatch
    const renamed = JSON.parse(JSON.stringify(snap));
    renamed[1].name = 'Navigation';
    eq(diffKeymapLayers(snap, renamed).names, 1, 'layer rename counts');
    const d = diffKeymapLayers(snap, snap.slice(0, 1));
    eq([d.layersA, d.layersB, keymapDiffers(d)], [2, 1, true],
        'layer-count mismatch reported and restorable');
}

// ---- capture helpers (zmk-capture.js, pure — window untouched) ----
{
    const { isModifierUsage, bareUsage } = await import('./zmk-capture.js');
    const { kpParam } = await import('./zmk-keycodes.js');
    eq(isModifierUsage(kpParam(0xE0)), true, 'Left Ctrl is a modifier usage');
    eq(isModifierUsage(kpParam(0xE7)), true, 'Right GUI is a modifier usage');
    eq(isModifierUsage(kpParam(0x04)), false, 'A is not a modifier usage');
    // ⌃C folded (ctrl bit in the top byte) → bare C, mods stripped.
    const ctrlC = ((0x01 << 24) | kpParam(0x06)) >>> 0;
    eq(bareUsage(ctrlC), kpParam(0x06), 'bareUsage strips folded modifiers');
    eq(bareUsage(kpParam(0x06)), kpParam(0x06), 'bareUsage is a no-op on a plain key');
}

console.log(`zmk-studio-test: ${checks} checks OK`);
