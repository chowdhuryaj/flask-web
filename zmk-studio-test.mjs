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
        setZmkContext, bindingCap, bindingHover,
    } = await import('./zmk-keycodes.js?v=4');

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
    ]);
    setZmkContext({ behaviors, layers: [{ id: 0, name: 'Base' }, { id: 3, name: 'Fn' }] });

    eq(bindingCap({ behaviorId: 1, param1: kpParam(0x05), param2: 0 }), 'B', 'kp cap = bare usage');
    eq(bindingCap({ behaviorId: 2, param1: 3, param2: 0 }), 'MO·Fn', 'mo cap uses layer NAME by stable id');
    eq(bindingCap({ behaviorId: 3, param1: 0, param2: kpParam(0x2C) }), 'LT·Base·Spc', 'lt cap layer+key');
    eq(bindingCap({ behaviorId: 4, param1: 0, param2: 0 }), '▽', 'transparent glyph');
    eq(bindingCap({ behaviorId: 99, param1: 0, param2: 0 }), '#99', 'unknown behavior renders id');
    eq(bindingHover({ behaviorId: 2, param1: 3, param2: 0 }).split('\n')[0], 'Momentary Layer(Fn)', 'hover head');
}

console.log(`zmk-studio-test: ${checks} checks OK`);
