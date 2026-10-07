// Studio over Bluetooth LE: GattPort framing/chunking against a fake GATT
// characteristic, and StudioClient.connectBluetooth end to end on it.
import assert from 'node:assert/strict';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

const { encodeFrame, FrameDecoder, readFields, fBytes, fVarint, fString, buildRequest,
    StudioClient, GattPort, STUDIO_GATT_SERVICE, STUDIO_GATT_RPC_CHAR, GATT_WRITE_CHUNK } =
    await import('../zmk-studio.js?v=79');

eq(STUDIO_GATT_SERVICE, '00000000-0196-6107-c967-c5cfb1c2482a', 'service UUID (zmk uuid.h)');
eq(STUDIO_GATT_RPC_CHAR, '00000001-0196-6107-c967-c5cfb1c2482a', 'RPC characteristic UUID');

/** Fake Studio device. Firmware characteristic props: WRITE | READ | INDICATE.
 * Answers get_device_info with `name`; indicates replies in `indicateSize`
 * pieces. silent: never answers. */
function fakeDevice({ name = 'Totem', indicateSize = 27, silent = false, connectFails = false } = {}) {
    const writes = [];
    const listeners = { char: new Map(), dev: new Map() };
    const on = (m) => (t, l) => m.set(t, l);
    const off = (m) => (t) => m.delete(t);
    const dec = new FrameDecoder();
    const log = [];
    const ch = {
        properties: { write: true, read: true, indicate: true, writeWithoutResponse: false },
        notifying: false,
        async startNotifications() { ch.notifying = true; log.push('start'); return ch; },
        async stopNotifications() { ch.notifying = false; log.push('stop'); return ch; },
        addEventListener: on(listeners.char),
        removeEventListener: off(listeners.char),
        async writeValueWithoutResponse() { throw new Error('NotSupportedError: no write-without-response'); },
        async writeValueWithResponse(b) {
            writes.push(Uint8Array.from(b));
            if (silent) return;
            for (const frame of dec.push(b)) {
                const f = readFields(frame);
                const id = f.find((x) => x.field === 1).value;
                const resp = encodeFrame(fBytes(1, [...fVarint(1, id, true),
                    ...fBytes(3, fBytes(1, [...fString(1, name), ...fBytes(2, [9, 8])]))]));
                queueMicrotask(() => {
                    for (let i = 0; i < resp.length; i += indicateSize) {
                        const piece = resp.slice(i, i + indicateSize);
                        // Real DataViews can sit at an offset inside a bigger buffer.
                        const big = new Uint8Array(piece.length + 4);
                        big.set(piece, 2);
                        listeners.char.get('characteristicvaluechanged')?.({ target: { value: new DataView(big.buffer, 2, piece.length) } });
                    }
                });
            }
        },
    };
    const dev = {
        name, log, writes, ch,
        addEventListener: on(listeners.dev),
        removeEventListener: off(listeners.dev),
        gatt: {
            connected: false,
            async connect() {
                if (connectFails) throw new Error('NetworkError: connection failed');
                dev.gatt.connected = true; log.push('connect'); return dev.gatt;
            },
            disconnect() { dev.gatt.connected = false; log.push('disconnect'); },
            async getPrimaryService(uuid) {
                eq(uuid, STUDIO_GATT_SERVICE, 'asks for the Studio service');
                return { async getCharacteristic(c) { eq(c, STUDIO_GATT_RPC_CHAR, 'asks for the RPC char'); return ch; } };
            },
        },
        drop() { dev.gatt.connected = false; listeners.dev.get('gattserverdisconnected')?.(); },
        listenerCount: () => listeners.char.size + listeners.dev.size,
    };
    return dev;
}

// ---- GattPort: chunked writes reassemble to the frame, indications stream back ----
{
    const dev = fakeDevice({ silent: true });   // random payload: just record writes
    const port = new GattPort(dev);
    await port.open();
    eq(dev.log, ['connect', 'stop', 'start'], 'connect, then stop+start indications (ts-client reconnect fix)');
    const frame = encodeFrame(Uint8Array.from({ length: 70 }, (_, i) => (i * 37) & 0xff));
    const w = port.writable.getWriter();
    await w.write(frame);
    ok(dev.writes.length === Math.ceil(frame.length / GATT_WRITE_CHUNK), 'split into MTU-sized writes');
    ok(dev.writes.every((b) => b.length <= GATT_WRITE_CHUNK), `no write over ${GATT_WRITE_CHUNK} bytes`);
    eq(Uint8Array.from(dev.writes.flatMap((b) => [...b])), frame, 'chunks reassemble to the exact frame');
    w.releaseLock();
    await port.close();
    eq(dev.log.slice(-2), ['stop', 'disconnect'], 'close stops indications and drops GATT');
    eq(dev.listenerCount(), 0, 'close removes every listener');
}

// ---- StudioClient over BLE: request/response, odd indication splits, disconnect ----
{
    const dev = fakeDevice({ indicateSize: 7 });
    const c = new StudioClient();
    const bt = { getDevices: async () => [], requestDevice: async (opts) => {
        eq(opts.filters, [{ services: [STUDIO_GATT_SERVICE] }], 'chooser filtered to the Studio service');
        return dev;
    } };
    await c.connectBluetooth({ bluetooth: bt });
    ok(c.connected, 'connected over BLE');
    eq(c.transport, 'ble', 'transport reports ble');
    const info = await c.getDeviceInfo();
    eq(info.name, 'Totem', 'device info decoded from 7-byte indications');
    eq([...info.serialNumber], [9, 8], 'serial bytes intact');
    // Same bytes on the wire as serial would send.
    const sent = Uint8Array.from(dev.writes.flatMap((b) => [...b]));
    const frames = new FrameDecoder().push(sent);
    eq(frames.length, 2, 'probe + getDeviceInfo, one frame each');
    eq(frames[1], buildRequest(1, 3, fVarint(1, 1, true)), 'same request payload as the serial path');

    let dropped = 0;
    c.addEventListener('disconnect', () => dropped++);
    dev.drop();
    await new Promise((r) => setTimeout(r, 10));
    ok(!c.connected, 'link loss tears the client down');
    eq(dropped, 1, 'link loss fires one disconnect event');
}

// ---- silent path: a granted device opens with no chooser ----
{
    const dev = fakeDevice();
    const c = new StudioClient();
    await c.connectBluetooth({ requestIfNeeded: false,
        bluetooth: { getDevices: async () => [dev], requestDevice: async () => { throw new Error('no chooser'); } } });
    ok(c.connected, 'granted device reconnects silently');
    await c.disconnect();
    // No getDevices (Electron 33): silent path gives up quietly.
    const c2 = new StudioClient();
    await assert.rejects(c2.connectBluetooth({ requestIfNeeded: false, bluetooth: { requestDevice: async () => dev } }),
        (e) => e.kind === 'cancelled');
    checks++;
}

// ---- errors: cancelled chooser, unreachable device, wrong board ----
{
    const nf = Object.assign(new Error('User cancelled'), { name: 'NotFoundError' });
    await assert.rejects(new StudioClient().connectBluetooth({ bluetooth: { requestDevice: async () => { throw nf; } } }),
        (e) => e.kind === 'cancelled');
    checks++;
    await assert.rejects(new StudioClient().connectBluetooth({ bluetooth: { requestDevice: async () => fakeDevice({ connectFails: true }) } }),
        (e) => e.kind === 'openFailed' && /Totem not reachable over Bluetooth\. Is it awake and connected to this Mac\?/.test(e.message));
    checks++;
    await assert.rejects(new StudioClient().connectBluetooth({ verify: async () => false,
        bluetooth: { requestDevice: async () => fakeDevice() } }), (e) => e.kind === 'wrongBoard');
    checks++;
}

console.log(`ble-gatt-test: ${checks} checks passed`);
