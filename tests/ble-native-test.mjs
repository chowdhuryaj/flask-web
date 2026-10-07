// Studio over the desktop CoreBluetooth helper: NativeBlePort against a fake
// window.totemFlask.bleStudio bridge, and StudioClient.connectBluetooth on it.
import assert from 'node:assert/strict';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

const { encodeFrame, FrameDecoder, readFields, fBytes, fVarint, fString, buildRequest,
    StudioClient, NativeBlePort } = await import('../zmk-studio.js?v=79');

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Fake bridge = main.js + helper. `on`: what the helper does on open
 * ('ready' | an error code | 'silent'). Answers get_device_info with `name`,
 * delivered in `piece`-byte data events (frames split across events). */
function fakeBridge({ on = 'ready', name = 'Totem', piece = 5, answer = true } = {}) {
    const b = { opens: [], writes: [], closes: 0, onEvent: null };
    const dec = new FrameDecoder();
    b.emit = (ev) => b.onEvent?.(ev);
    b.open = (n, onEvent) => {
        b.opens.push(n);
        b.onEvent = onEvent;
        queueMicrotask(() => {
            if (on === 'ready') b.emit({ type: 'ready', name });
            else if (on !== 'silent') { b.emit({ type: 'error', code: on, message: `helper says ${on}` }); b.emit({ type: 'closed' }); }
        });
    };
    b.write = (bytes) => {
        b.writes.push(Uint8Array.from(bytes));
        if (!answer) return;
        for (const frame of dec.push(bytes)) {
            const id = readFields(frame).find((x) => x.field === 1).value;
            const resp = encodeFrame(fBytes(1, [...fVarint(1, id, true),
                ...fBytes(3, fBytes(1, [...fString(1, name), ...fBytes(2, [9, 8])]))]));
            queueMicrotask(() => {
                for (let i = 0; i < resp.length; i += piece) b.emit({ type: 'data', bytes: resp.slice(i, i + piece) });
            });
        }
    };
    b.close = () => { b.closes++; b.onEvent = null; };
    return b;
}

const noWebBt = { requestDevice: async () => { throw new Error('Web Bluetooth must not be used'); } };

// ---- NativeBlePort alone: ready, data stream, writes, close ----
{
    const br = fakeBridge({ answer: false });
    const port = new NativeBlePort(br, 'Totem');
    await port.open();
    eq(br.opens, ['Totem'], 'open passes the board name');
    eq(port.transport, 'ble', 'transport is ble');
    const r = port.readable.getReader();
    br.emit({ type: 'data', bytes: Uint8Array.of(1, 2) });
    br.emit({ type: 'data', bytes: Uint8Array.of(3) });
    eq([...(await r.read()).value], [1, 2], 'data event 1 streams through');
    eq([...(await r.read()).value], [3], 'data event 2 streams through');
    const w = port.writable.getWriter();
    await w.write(Uint8Array.of(7, 8, 9));
    eq(br.writes.map((x) => [...x]), [[7, 8, 9]], 'write goes to the bridge whole (helper chunks to MTU)');
    await port.close();
    await port.close();
    eq(br.closes, 1, 'close is idempotent');
    ok((await r.read()).done, 'close ends the readable');
}

// ---- StudioClient over the bridge: frames split across data events ----
{
    const br = fakeBridge({ piece: 3 });
    const c = new StudioClient();
    await c.connectBluetooth({ name: 'Totem', native: br, bluetooth: noWebBt });
    ok(c.connected, 'connected through the native bridge');
    eq(c.transport, 'ble', 'client transport is ble');
    const info = await c.getDeviceInfo();
    eq(info.name, 'Totem', 'device info decoded from 3-byte data events');
    eq([...info.serialNumber], [9, 8], 'serial bytes intact');
    const frames = new FrameDecoder().push(Uint8Array.from(br.writes.flatMap((x) => [...x])));
    eq(frames[1], buildRequest(1, 3, fVarint(1, 1, true)), 'same request bytes as the serial path');

    // Link loss: the helper reports closed.
    let dropped = 0;
    c.addEventListener('disconnect', () => dropped++);
    br.emit({ type: 'closed' });
    await tick();
    ok(!c.connected, 'link loss tears the client down');
    eq(dropped, 1, 'link loss fires one disconnect event');
    br.emit({ type: 'data', bytes: Uint8Array.of(1) });   // late event after close: ignored
    ok(true, 'late data after close does not throw');
}

// ---- clean disconnect closes the helper session, no disconnect event ----
{
    const br = fakeBridge();
    const c = new StudioClient();
    await c.connectBluetooth({ native: br, name: 'Totem' });
    let dropped = 0;
    c.addEventListener('disconnect', () => dropped++);
    await c.disconnect();
    await tick();
    eq(br.closes, 1, 'disconnect closes the helper session once');
    eq(dropped, 0, 'a clean close is not a link loss');
}

// ---- errors: the two spelled-out messages, silent path, no answer, wrong board ----
{
    await assert.rejects(new StudioClient().connectBluetooth({ native: fakeBridge({ on: 'notFound' }), name: 'Totem' }),
        (e) => e.kind === 'openFailed' && e.message === 'Totem not found over Bluetooth. Is it awake and connected to this Mac?');
    checks++;
    await assert.rejects(new StudioClient().connectBluetooth({ native: fakeBridge({ on: 'unauthorized' }), name: 'Totem' }),
        (e) => e.kind === 'openFailed'
            && e.message === 'Totem-Flask needs Bluetooth permission: System Settings > Privacy & Security > Bluetooth.');
    checks++;
    await assert.rejects(new StudioClient().connectBluetooth({ native: fakeBridge({ on: 'failed' }), name: 'Totem' }),
        (e) => e.kind === 'openFailed' && /helper says failed/.test(e.message));
    checks++;
    // Launch (silent) path: nothing found must not toast.
    await assert.rejects(new StudioClient().connectBluetooth({ requestIfNeeded: false, native: fakeBridge({ on: 'notFound' }), name: 'Totem' }),
        (e) => e.kind === 'cancelled');
    checks++;
    // Helper crashed before ready with no error line (main.js still sends closed).
    const crash = fakeBridge({ on: 'silent' });
    const p = new StudioClient().connectBluetooth({ native: crash, name: 'Totem' });
    await tick();
    crash.emit({ type: 'closed' });
    await assert.rejects(p, (e) => e.kind === 'openFailed' && /Bluetooth helper closed/.test(e.message));
    checks++;
    // Ready but Studio never answers the probe.
    const mute = fakeBridge({ answer: false });
    await assert.rejects(new StudioClient().connectBluetooth({ native: mute, name: 'Totem' }),
        (e) => e.kind === 'openFailed' && e.message === 'Totem did not answer ZMK Studio over Bluetooth.');
    checks++;
    eq(mute.closes, 1, 'a silent board is closed again');
    await assert.rejects(new StudioClient().connectBluetooth({ native: fakeBridge(), name: 'Totem', verify: async () => false }),
        (e) => e.kind === 'wrongBoard');
    checks++;
}

console.log(`ble-native-test: ${checks} checks passed`);
