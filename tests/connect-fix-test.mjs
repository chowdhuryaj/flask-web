// Connect-path fixes: WC-01 serial lock, WC-09 wrong-board port, WC-11 unsaved
// restore check, WC-15 bad nested frame, WC-17/18 flaskproto, port hint + parallel probe.
// Electron items (will-prevent-unload, second-instance, origin check) are code-only.
import assert from 'node:assert/strict';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ---- minimal browser globals ----
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
const toasts = [];
const node = () => ({ setAttribute() {}, addEventListener() {}, append() {}, remove() {}, classList: { toggle() {}, add() {} } });
globalThis.document = {
    createElement: node, createTextNode: (t) => ({ t }), querySelector: () => null,
    body: { append: (t) => toasts.push(t.textContent) },
};
// Web Locks: exclusive, ifAvailable.
const heldLocks = new Set();
const locks = {
    request(name, opts, cb) {
        if (heldLocks.has(name)) return Promise.resolve(cb(null));
        heldLocks.add(name);
        return Promise.resolve(cb({ name })).finally(() => heldLocks.delete(name));
    },
};

// ---- fake Studio serial ports ----
const { encodeFrame, FrameDecoder, readFields, fBytes, fVarint, fString, StudioClient } =
    await import('../zmk-studio.js?v=73');
const varint = (f, n) => f.find((x) => x.field === n && x.wire === 0)?.value;
const bytes = (f, n) => f.find((x) => x.field === n && x.wire === 2)?.bytes;

/** kind: 'silent' (never answers) | {keys: N} answers device info + layouts. */
function fakePort(kind, log, name) {
    let ctl;
    const dec = new FrameDecoder();
    const port = {
        name, opened: false,
        getInfo: () => ({ usbVendorId: 0x1d50, usbProductId: 0x615e }),
        // A real port hands out a fresh stream after every open().
        async open() {
            port.opened = true; log.push(`open ${name}`);
            port.readable = new ReadableStream({ start: (c) => { ctl = c; } });
        },
        async close() { port.opened = false; log.push(`close ${name}`); },
        readable: null,
        writable: {
            getWriter: () => ({
                releaseLock() {},
                async write(data) {
                    if (kind === 'silent') return;
                    for (const frame of dec.push(data)) {
                        const f = readFields(frame);
                        const id = varint(f, 1);
                        const sub = f.find((x) => x.field !== 1 && x.wire === 2);
                        const inner = readFields(sub.bytes)[0].field;
                        let payload = [];
                        if (sub.field === 3 && inner === 1) payload = [...fString(1, name), ...fBytes(2, [1, 2, 3])];
                        if (sub.field === 5 && inner === 6) {
                            const keys = Array.from({ length: kind.keys }, () => fBytes(2, [])).flat();
                            payload = [...fVarint(1, 0), ...fBytes(2, [...fString(1, 'L'), ...keys])];
                        }
                        const resp = fBytes(1, [...fVarint(1, id, true), ...fBytes(sub.field, fBytes(inner, payload))]);
                        ctl.enqueue(encodeFrame(resp));
                    }
                },
            }),
        },
    };
    return port;
}
function setSerial(ports) {
    const listeners = new Set();
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            locks,
            serial: {
                getPorts: async () => ports,
                requestPort: async () => { throw new Error('no chooser in tests'); },
                addEventListener: (_, l) => listeners.add(l),
                removeEventListener: (_, l) => listeners.delete(l),
            },
        },
    });
}
const want = (n) => async (c) => (await c.getPhysicalLayouts()).layouts[0].keys.length === n;

// ---- port selection: hint first, parallel probe of the rest, board check ----
{
    const log = [];
    const ports = [fakePort('silent', log, 'A'), fakePort('silent', log, 'B'), fakePort({ keys: 38 }, log, 'C')];
    setSerial(ports);
    const c = new StudioClient();
    const t0 = Date.now();
    await c.connect({ requestIfNeeded: false, verify: want(38), hintKey: 'totem' });
    const dt = Date.now() - t0;
    ok(c.connected && c.port === ports[2], 'connected to the answering port');
    ok(dt < 400, `silent ports do not delay the answering one (${dt} ms)`);
    eq(store.get('flask-studio-port:totem'), '2', 'answering port index remembered');
    await c.disconnect();

    // Second connect: remembered port goes first, silent ones are never opened.
    await new Promise((r) => setTimeout(r, 900));   // let the throwaway probes of the first connect finish
    log.length = 0;
    const c2 = new StudioClient();
    const t1 = Date.now();
    await c2.connect({ requestIfNeeded: false, verify: want(38), hintKey: 'totem' });
    ok(Date.now() - t1 < 500, 'remembered port answers without waiting for silent ones');
    eq(log, ['open C'], 'only the remembered port was opened');
    await c2.disconnect();
}
{
    // Two boards answer Studio: the one with the connected board's key count wins.
    const log = [];
    const ports = [fakePort({ keys: 70 }, log, 'imprint'), fakePort({ keys: 38 }, log, 'totem')];
    setSerial(ports);
    const c = new StudioClient();
    await c.connect({ requestIfNeeded: false, verify: want(38), hintKey: 'x' });
    ok(c.port === ports[1], 'wrong-size board skipped, right one kept');
    ok(!ports[0].opened, 'the rejected port was closed again');
    await c.disconnect();
}
{
    // Only the wrong board present: refuse, never guess.
    const log = [];
    const ports = [fakePort({ keys: 70 }, log, 'imprint')];
    setSerial(ports);
    const c = new StudioClient();
    await assert.rejects(c.connect({ requestIfNeeded: false, verify: want(38), hintKey: 'y' }),
        (e) => e.kind === 'wrongBoard');
    checks++;
    ok(!c.connected && !ports[0].opened, 'wrong board left closed');
}

// ---- WC-15: a nested undecodable response does not drop the port ----
{
    const c = new StudioClient();
    let disconnected = 0;
    c._handleDisconnect = () => disconnected++;
    c._onRequestResponse = () => { throw new Error('bad nested field'); };
    const warn = console.warn; console.warn = () => {};
    c._onFrame(new Uint8Array(fBytes(1, [1, 2, 3])));
    console.warn = warn;
    eq(disconnected, 0, '_onFrame swallows a throw from the nested decode');
}

// ---- keymap tab: WC-01 lock, WC-09 refuse, WC-11 unsaved ----
setSerial([]);
const { ZmkKeymapTab, _serialLockState } = await import('../zmk-keymap-tab.js?v=73');
const { board } = await import('../board.js?v=73');
board.bind = () => {};
const mkTab = (over = {}) => {
    const t = new ZmkKeymapTab({ profile: { family: 'totem' }, ...over });
    t.render = () => {};
    return t;
};
{
    // The silent connect fails (no granted port); the lock must not stay held.
    const t1 = mkTab();
    await assert.rejects(t1._connect(false), (e) => e.kind === 'cancelled'); checks++;
    eq(heldLocks.has('flask-web-serial'), false, 'failed connect releases the serial lock');
    eq(_serialLockState().held, false, 'module state agrees');
    // A new tab instance (reconnect rebuild) is not locked out.
    const t2 = mkTab();
    await assert.rejects(t2._connect(false), (e) => e.kind === 'cancelled'); checks++;
    ok(!toasts.some((m) => /in use by another/.test(m)), 'second instance gets no "in use" refusal');

    // Held by a live connection across instances: still acquirable by the new one, released on disconnect.
    const log = [];
    setSerial([fakePort({ keys: 38 }, log, 'ok')]);
    const t3 = mkTab();
    t3._handshake = async () => {};
    await t3._connect(false);
    eq(heldLocks.has('flask-web-serial'), true, 'held while the port is open');
    const t4 = mkTab();
    t4._handshake = async () => {};
    await t4._connect(false);
    ok(!toasts.some((m) => /in use by another/.test(m)), 'replacement instance reuses the page-wide lock');
    t4._onSerialDisconnect();
    await new Promise((r) => setTimeout(r, 0));
    eq(heldLocks.has('flask-web-serial'), false, 'released on disconnect');
    await t4.client.disconnect();
}

// WC-09 in the load path: layout key count must match the HID family.
const layoutOf = (n) => ({ activeLayoutIndex: 0, layouts: [{ keys: Array.from({ length: n }, () => ({ x: 0, y: 0, w: 1, h: 1 })) }] });
const loadable = (t, { unsaved, keys }) => {
    const calls = { sync: 0, seed: 0, disconnect: 0 };
    t.client = {
        getPhysicalLayouts: async () => layoutOf(keys),
        getKeymap: async () => ({ layers: [{ id: 1, name: 'b', bindings: [] }], availableLayers: 0 }),
        listAllBehaviors: async () => [],
        checkUnsavedChanges: async () => unsaved,
        disconnect: async () => { calls.disconnect++; },
        addEventListener() {},
    };
    t._setContext = () => {};
    t._publishToApp = () => {};
    t._setUnsaved = (v) => { t.unsaved = v; };
    t._applyQueuedOfflineKeymap = async () => {};
    t._keymapSyncCheck = async () => { calls.sync++; };
    t._seedUnplugged = ((orig) => function () { calls.seed++; return orig.call(this); })(t._seedUnplugged);
    return calls;
};
{
    const t = mkTab();
    const calls = loadable(t, { unsaved: false, keys: 70 });
    await t._loadEverything();
    eq([calls.disconnect, t.state, t.keymap], [1, 'idle', null], 'wrong-size Studio board is refused and disconnected');
    ok(toasts.some((m) => /different board/.test(m)), 'user is told why');
    eq(calls.sync, 0, 'no restore check against the wrong board');
}
{
    const t = mkTab();
    const calls = loadable(t, { unsaved: true, keys: 38 });
    await t._loadEverything();
    eq(t.state, 'ready', 'matching board loads');
    eq(calls.sync, 0, 'WC-11: restore check skipped while the device has unsaved changes');
    const t2 = mkTab();
    const c2 = loadable(t2, { unsaved: false, keys: 38 });
    await t2._loadEverything();
    eq(c2.sync, 1, 'restore check still runs on a clean device');

    // snapshot is only written from a saved keymap
    t.deviceSerial = 'abc';
    t.unsaved = true;
    t._writeSnapshot();
    eq(store.has('zmk-keymap-snapshot:abc'), false, 'no snapshot while unsaved');
    t.unsaved = false;
    t._writeSnapshot();
    eq(store.has('zmk-keymap-snapshot:abc'), true, 'snapshot written when saved');
}
// dispose drops the old instance's listeners and is safe on a bare tab
{
    const a = mkTab();
    let disposed = 0;
    a._dock = { dispose: () => disposed++ };
    a._inspector = { dispose: () => disposed++ };
    mkTab();    // newest instance supersedes a
    eq(disposed, 2, 'constructing a new tab disposes the previous dock and inspector');
}

// ---- flaskproto: NaN and live-action retries ----
{
    const { FlaskProto, CH, V } = await import('../flaskproto.js?v=73');
    const seen = [];
    const hid = { request: async (p, e, o) => { seen.push([p, o]); return [p[0], p[1], p[2], p[3], p[4]]; } };
    const fp = new FlaskProto(hid);
    await assert.rejects(fp.setU16(CH.combos, 1, NaN), RangeError); checks++;
    await assert.rejects(fp.setI16(CH.accel, V.accelOffset, NaN), RangeError); checks++;
    await fp.setU16(CH.macros, V.macrosState, 3);
    eq(seen.at(-1)[1], { retries: 0 }, 'macro play is never re-sent');
    await fp.setU16(CH.combos, 1, 3);
    eq(seen.at(-1)[1], undefined, 'ordinary SET keeps the default retries');
    await fp.setI16(CH.accel, V.accelOffset, 99999);
    eq(seen.at(-1)[0].slice(3), [0x7f, 0xff], 'setI16 clamps instead of wrapping');
}

console.log(`connect-fix-test: ${checks} checks OK`);
