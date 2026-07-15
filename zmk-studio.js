// ZMK Studio RPC client — WebSerial transport + framing + a minimal
// hand-rolled proto3 codec. ZMK-line module (see zmk.js header: ALL ZMK
// code lives in zmk-scoped files; nothing here may be imported by a QMK
// module).
//
// Protocol sources (both MIT): zmkfirmware/zmk-studio-messages (schema),
// zmkfirmware/zmk-studio-ts-client (framing + transport reference). Field
// numbers below are transcribed from proto/zmk/{studio,meta,core,keymap,
// behaviors}.proto @ main, 2026-07-08. There is NO version handshake in the
// protocol — compatibility = proto3 unknown-field skipping + the device
// answering RPC_NOT_FOUND for requests it lacks.
//
// This file's only import is diag.js (node-safe: globals touched inside
// methods/try) and it only touches `navigator` inside methods, so the codec
// half stays importable under plain `node` for the test vectors
// (zmk-studio-test.mjs).

import { diag } from './diag.js?v=16';

// ---------------------------------------------------------------------------
// Framing: SOF/ESC/EOF byte-stuffing (framing.ts equivalent).

export const FRAME_SOF = 0xAB;
export const FRAME_ESC = 0xAC;
export const FRAME_EOF = 0xAD;

export function encodeFrame(payload) {
    const out = [FRAME_SOF];
    for (const b of payload) {
        if (b === FRAME_SOF || b === FRAME_ESC || b === FRAME_EOF) out.push(FRAME_ESC);
        out.push(b);
    }
    out.push(FRAME_EOF);
    return new Uint8Array(out);
}

/**
 * Streaming deframer. Frames arrive split across reads (the firmware TX
 * buffer is 64 bytes) and back-to-back within one read — push() returns
 * zero or more COMPLETE frames per chunk.
 */
export class FrameDecoder {
    constructor() {
        this.state = 'idle';    // idle | data | escaped
        this.buf = [];
    }

    push(chunk) {
        const frames = [];
        for (const b of chunk) {
            switch (this.state) {
            case 'idle':
                // Discard garbage until a start-of-frame.
                if (b === FRAME_SOF) { this.state = 'data'; this.buf = []; }
                break;
            case 'data':
                if (b === FRAME_ESC) this.state = 'escaped';
                else if (b === FRAME_EOF) { frames.push(new Uint8Array(this.buf)); this.state = 'idle'; }
                // Unescaped SOF mid-frame = desync; drop the partial frame
                // and treat it as a fresh start (defensive resync).
                else if (b === FRAME_SOF) this.buf = [];
                else this.buf.push(b);
                break;
            case 'escaped':
                this.buf.push(b);   // verbatim, whatever it is
                this.state = 'data';
                break;
            }
        }
        return frames;
    }
}

// ---------------------------------------------------------------------------
// Minimal proto3 codec — varint / zigzag / length-delimited only (that is
// the whole Studio schema; no floats, no 64-bit, one packed repeated).

export function zigzag(n) { return ((n << 1) ^ (n >> 31)) >>> 0; }
export function unzigzag(v) { return (v >>> 1) ^ -(v & 1); }

export function writeVarint(out, v) {
    v = v >>> 0;    // u32 discipline — callers pass already-masked values
    while (v > 0x7F) { out.push((v & 0x7F) | 0x80); v >>>= 7; }
    out.push(v);
}

/** Read one varint at `i`; returns [low 32 bits as u32, next index].
 * Consumes up to 10 bytes (a negative int32 is sign-extended to 64 bits on
 * the wire); bits above 31 are discarded — every field we decode is 32-bit. */
export function readVarintAt(bytes, i) {
    let lo = 0, shift = 0;
    for (;;) {
        if (i >= bytes.length) throw new Error('varint past end of buffer');
        const b = bytes[i++];
        if (shift < 32) lo = (lo | ((b & 0x7F) << shift)) >>> 0;
        if ((b & 0x80) === 0) return [lo, i];
        shift += 7;
        if (shift > 63) throw new Error('varint too long');
    }
}

const tag = (field, wire) => (field << 3) | wire;

/** Field of varint wire type. Omits proto3-default zeros unless `always`
 * (oneof selectors and oneof-selected values must be emitted explicitly). */
export function fVarint(field, v, always = false) {
    v = v >>> 0;
    if (v === 0 && !always) return [];
    const out = [];
    writeVarint(out, tag(field, 0));
    writeVarint(out, v);
    return out;
}

export function fBytes(field, bytes) {
    const out = [];
    writeVarint(out, tag(field, 2));
    writeVarint(out, bytes.length);
    out.push(...bytes);
    return out;
}

export function fString(field, s) {
    return fBytes(field, [...new TextEncoder().encode(s)]);
}

/**
 * Generic walker: returns [{field, wire, value?, bytes?}] in wire order.
 * wire 0 → value (u32, low 32 bits); wire 2 → bytes (subarray view);
 * wire 1/5 skipped (forward compat). Repeated fields appear repeatedly.
 */
export function readFields(bytes) {
    const fields = [];
    let i = 0;
    while (i < bytes.length) {
        let t;
        [t, i] = readVarintAt(bytes, i);
        const field = t >>> 3, wire = t & 7;
        if (wire === 0) {
            let v;
            [v, i] = readVarintAt(bytes, i);
            fields.push({ field, wire, value: v });
        } else if (wire === 2) {
            let len;
            [len, i] = readVarintAt(bytes, i);
            if (i + len > bytes.length) throw new Error('length-delimited field past end');
            fields.push({ field, wire, bytes: bytes.subarray(i, i + len) });
            i += len;
        } else if (wire === 5) {
            i += 4;
        } else if (wire === 1) {
            i += 8;
        } else {
            throw new Error(`unsupported wire type ${wire}`);
        }
    }
    return fields;
}

const first = (fields, n) => fields.find((f) => f.field === n);
const varintOf = (fields, n, dflt = 0) => first(fields, n)?.value ?? dflt;
const bytesOf = (fields, n) => first(fields, n)?.bytes;
const stringOf = (fields, n, dflt = '') => {
    const b = bytesOf(fields, n);
    return b ? new TextDecoder().decode(b) : dflt;
};

/** Packed repeated varint (also tolerates the unpacked encoding). */
function packedVarints(fields, n) {
    const out = [];
    for (const f of fields) {
        if (f.field !== n) continue;
        if (f.wire === 0) { out.push(f.value); continue; }
        let i = 0;
        while (i < f.bytes.length) {
            let v;
            [v, i] = readVarintAt(f.bytes, i);
            out.push(v);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Schema constants (zmk-studio-messages field numbers).

// studio.Request / RequestResponse subsystem fields
const SUB_META = 2;         // RequestResponse only
const SUB_CORE = 3;
const SUB_BEHAVIORS = 4;
const SUB_KEYMAP = 5;
// studio.Response oneof
const RESP_REQUEST_RESPONSE = 1;
const RESP_NOTIFICATION = 2;
// studio.Notification oneof
const NOTIF_CORE = 2;
const NOTIF_KEYMAP = 5;

// meta.Response
const META_NO_RESPONSE = 1;
const META_SIMPLE_ERROR = 2;
export const META_ERROR_NAMES = ['GENERIC', 'UNLOCK_REQUIRED', 'RPC_NOT_FOUND',
    'MSG_DECODE_FAILED', 'MSG_ENCODE_FAILED'];

// core.Request/Response
const CORE_GET_DEVICE_INFO = 1;
const CORE_GET_LOCK_STATE = 2;
// core.Notification
const CORE_NOTIF_LOCK_STATE = 1;

export const LOCK_LOCKED = 0;
export const LOCK_UNLOCKED = 1;

// keymap.Request/Response (same numbers both directions)
const KM_GET_KEYMAP = 1;
const KM_SET_LAYER_BINDING = 2;
const KM_CHECK_UNSAVED = 3;
const KM_SAVE_CHANGES = 4;
const KM_DISCARD_CHANGES = 5;
const KM_GET_PHYSICAL_LAYOUTS = 6;
const KM_MOVE_LAYER = 8;        // MoveLayerRequest{start_index=1,dest_index=2}
const KM_ADD_LAYER = 9;         // AddLayerRequest — EMPTY MESSAGE, not bool
const KM_REMOVE_LAYER = 10;     // RemoveLayerRequest{layer_index=1}
const KM_RESTORE_LAYER = 11;    // RestoreLayerRequest{layer_id=1,at_index=2}
const KM_SET_LAYER_PROPS = 12;
// keymap.Notification
const KM_NOTIF_UNSAVED = 1;

export const SET_BINDING_ERROR_NAMES = ['OK', 'INVALID_LOCATION', 'INVALID_BEHAVIOR',
    'INVALID_PARAMETERS'];
export const SAVE_ERROR_NAMES = ['OK', 'GENERIC', 'NOT_SUPPORTED', 'NO_SPACE'];
export const SET_LAYER_PROPS_ERROR_NAMES = ['OK', 'GENERIC', 'INVALID_ID'];
export const MOVE_LAYER_ERROR_NAMES = ['OK', 'GENERIC', 'INVALID_LAYER', 'INVALID_DESTINATION'];
export const ADD_LAYER_ERROR_NAMES = ['OK', 'GENERIC', 'NO_SPACE'];
export const REMOVE_LAYER_ERROR_NAMES = ['OK', 'GENERIC', 'INVALID_INDEX'];
export const RESTORE_LAYER_ERROR_NAMES = ['OK', 'GENERIC', 'INVALID_ID', 'INVALID_INDEX'];

// behaviors.Request/Response
const BHV_LIST_ALL = 1;
const BHV_GET_DETAILS = 2;

// ---------------------------------------------------------------------------
// Message builders/decoders used by the client (exported for tests).

/** studio.Request wrapper: request_id=1, then the subsystem submessage. */
export function buildRequest(requestId, subsysField, innerBytes) {
    return new Uint8Array([
        ...fVarint(1, requestId, true),
        ...fBytes(subsysField, innerBytes),
    ]);
}

/** BehaviorBinding — behavior_id is sint32 (ZIGZAG on the wire). */
export function encodeBinding({ behaviorId, param1, param2 }) {
    return [
        ...fVarint(1, zigzag(behaviorId | 0)),
        ...fVarint(2, param1 >>> 0),
        ...fVarint(3, param2 >>> 0),
    ];
}

export function decodeBinding(bytes) {
    const f = readFields(bytes);
    return {
        behaviorId: unzigzag(varintOf(f, 1)),
        param1: varintOf(f, 2) >>> 0,
        param2: varintOf(f, 3) >>> 0,
    };
}

export function decodeLayer(bytes) {
    const lf = readFields(bytes);
    return {
        id: varintOf(lf, 1),
        name: stringOf(lf, 2),
        bindings: lf.filter((b) => b.field === 3 && b.wire === 2)
            .map((b) => decodeBinding(b.bytes)),
    };
}

export function decodeKeymap(bytes) {
    const f = readFields(bytes);
    return {
        layers: f.filter((x) => x.field === 1 && x.wire === 2)
            .map((x) => decodeLayer(x.bytes)),
        availableLayers: varintOf(f, 2),
        maxLayerNameLength: varintOf(f, 3),
    };
}

// Layer-op responses share one shape: oneof result { ok = 1; err(enum) = 2 }.
// err is 0/absent on the ok arm; ok payload varies per op.

export function decodeMoveLayerResponse(bytes) {
    const f = readFields(bytes);
    const err = varintOf(f, 2, 0);
    const ok = bytesOf(f, 1);
    // ok arm carries the FULL post-move Keymap — callers should adopt it.
    return { err, keymap: !err && ok ? decodeKeymap(ok) : null };
}

export function decodeAddLayerResponse(bytes) {
    const f = readFields(bytes);
    const err = varintOf(f, 2, 0);
    if (err) return { err, index: -1, layer: null };
    const ok = bytesOf(f, 1);
    if (!ok) return { err: 0, index: -1, layer: null };
    const of = readFields(ok);      // AddLayerResponseDetails{index=1, layer=2}
    const lb = bytesOf(of, 2);
    return { err: 0, index: varintOf(of, 1), layer: lb ? decodeLayer(lb) : null };
}

export function decodeRemoveLayerResponse(bytes) {
    // ok arm is an empty message — only the error matters.
    return { err: varintOf(readFields(bytes), 2, 0) };
}

export function decodeRestoreLayerResponse(bytes) {
    const f = readFields(bytes);
    const err = varintOf(f, 2, 0);
    const ok = bytesOf(f, 1);       // ok arm = the restored Layer
    return { err, layer: !err && ok ? decodeLayer(ok) : null };
}

/** KeyPhysicalAttrs are sint32 CENTI-units on the wire — ÷100 here so the
 * rest of the app only ever sees key-units / degrees. */
export function decodePhysicalLayouts(bytes) {
    const f = readFields(bytes);
    const layouts = f.filter((x) => x.field === 2 && x.wire === 2).map((x) => {
        const lf = readFields(x.bytes);
        return {
            name: stringOf(lf, 1),
            keys: lf.filter((k) => k.field === 2 && k.wire === 2).map((k) => {
                const kf = readFields(k.bytes);
                const z = (n) => unzigzag(varintOf(kf, n)) / 100;
                return { w: z(1), h: z(2), x: z(3), y: z(4), r: z(5), rx: z(6), ry: z(7) };
            }),
        };
    });
    return { activeLayoutIndex: varintOf(f, 1), layouts };
}

export function decodeBehaviorDetails(bytes) {
    const f = readFields(bytes);
    const descs = (df) => df.map((d) => {
        const x = readFields(d.bytes);
        const desc = { name: stringOf(x, 1), kind: 'nil' };
        for (const fld of x) {
            if (fld.field === 2) desc.kind = 'nil';
            else if (fld.field === 3) { desc.kind = 'constant'; desc.constant = fld.value >>> 0; }
            else if (fld.field === 4) {
                const rf = readFields(fld.bytes);
                // range min/max are plain int32 (NOT zigzag) — low 32 bits, signed view
                desc.kind = 'range';
                desc.min = varintOf(rf, 1) | 0;
                desc.max = varintOf(rf, 2) | 0;
            } else if (fld.field === 5) {
                const hf = readFields(fld.bytes);
                desc.kind = 'hid_usage';
                desc.keyboardMax = varintOf(hf, 1);
                desc.consumerMax = varintOf(hf, 2);
            } else if (fld.field === 6) desc.kind = 'layer_id';
        }
        return desc;
    });
    return {
        id: varintOf(f, 1),
        displayName: stringOf(f, 2),
        metadata: f.filter((x) => x.field === 3 && x.wire === 2).map((x) => {
            const mf = readFields(x.bytes);
            return {
                param1: descs(mf.filter((d) => d.field === 1 && d.wire === 2)),
                param2: descs(mf.filter((d) => d.field === 2 && d.wire === 2)),
            };
        }),
    };
}

// ---------------------------------------------------------------------------
// Errors

export class StudioError extends Error {
    /** kinds: unsupported | cancelled | openFailed | notConnected | timeout |
     *  unlockRequired | rpcNotFound | decodeFailed | remote */
    constructor(kind, message, code) {
        super(message);
        this.name = 'StudioError';
        this.kind = kind;
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Client

const RPC_TIMEOUT_MS = 2000;
const SAVE_TIMEOUT_MS = 5000;   // settings flash write can be slow

/**
 * events: 'lockstate' {detail: 0|1} · 'unsaved' {detail: bool} · 'disconnect'
 */
export class StudioClient extends EventTarget {
    constructor() {
        super();
        this.port = null;
        this._writer = null;
        this._reader = null;
        this._decoder = new FrameDecoder();
        this._nextId = 0;
        this._pending = null;       // { id, resolve, reject, timer }
        this._chain = Promise.resolve();
        this._closing = false;
        this._onSerialDisconnect = (e) => {
            if (e.target === this.port || e.port === this.port) this._handleDisconnect();
        };
    }

    static supported() {
        return typeof navigator !== 'undefined' && 'serial' in navigator;
    }

    get connected() { return this.port !== null && this._writer !== null; }

    /**
     * filters: [{usbVendorId, usbProductId}] — passed in by the caller
     * (zmk.js ZMK_VIDPID) to keep this module import-free.
     * Silent path first: an already-granted port matching a filter opens
     * without a user gesture; requestPort needs one.
     */
    async connect({ filters = [], requestIfNeeded = true } = {}) {
        if (!StudioClient.supported()) {
            throw new StudioError('unsupported', 'WebSerial is not supported in this browser');
        }
        if (this.connected) return;

        let port = null;
        const granted = await navigator.serial.getPorts();
        for (const p of granted) {
            const info = p.getInfo();
            if (!filters.length || filters.some((f) =>
                info.usbVendorId === f.usbVendorId && info.usbProductId === f.usbProductId)) {
                port = p;
                break;
            }
        }
        if (!port) {
            if (!requestIfNeeded) throw new StudioError('cancelled', 'No granted serial port');
            try {
                port = await navigator.serial.requestPort({ filters });
            } catch {
                throw new StudioError('cancelled', 'No serial port selected');
            }
        }

        try {
            await port.open({ baudRate: 12500 });   // CDC-ACM: value is ignored
        } catch (e) {
            throw new StudioError('openFailed',
                `Serial port busy or unavailable — close ZMK Studio or other serial apps (${e.message})`);
        }

        this.port = port;
        this._closing = false;
        this._decoder = new FrameDecoder();
        this._writer = port.writable.getWriter();
        this._reader = port.readable.getReader();
        navigator.serial.addEventListener('disconnect', this._onSerialDisconnect);
        diag.log('studio-open', 'serial port opened');
        this._readLoop();   // intentionally un-awaited
    }

    async disconnect() {
        this._closing = true;
        await this._teardown();
    }

    async _teardown() {
        const port = this.port;
        if (!port) return;
        this.port = null;
        navigator.serial.removeEventListener('disconnect', this._onSerialDisconnect);
        this._rejectPending(new StudioError('notConnected', 'Serial connection closed'));
        try { await this._reader?.cancel(); } catch { /* already dead */ }
        try { this._reader?.releaseLock(); } catch { /* ok */ }
        try { this._writer?.releaseLock(); } catch { /* ok */ }
        this._reader = null;
        this._writer = null;
        try { await port.close(); } catch { /* unplugged */ }
    }

    _handleDisconnect() {
        if (!this.port) return;
        const wasClean = this._closing;
        diag.log('studio-disconnect', wasClean ? 'clean close' : 'port dropped');
        this._teardown().finally(() => {
            if (!wasClean) this.dispatchEvent(new CustomEvent('disconnect'));
        });
    }

    async _readLoop() {
        const reader = this._reader;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                for (const frame of this._decoder.push(value)) this._onFrame(frame);
            }
        } catch { /* stream torn down — fall through */ }
        this._handleDisconnect();
    }

    _onFrame(frame) {
        let fields;
        try {
            fields = readFields(frame);
        } catch (e) {
            console.warn('studio: undecodable frame dropped:', e.message);
            return;
        }
        const rr = bytesOf(fields, RESP_REQUEST_RESPONSE);
        if (rr) { this._onRequestResponse(rr); return; }
        const notif = bytesOf(fields, RESP_NOTIFICATION);
        if (notif) this._onNotification(notif);
    }

    _onRequestResponse(bytes) {
        const f = readFields(bytes);
        const id = varintOf(f, 1);
        const p = this._pending;
        if (!p || p.id !== id) {
            console.warn(`studio: dropping stale response (request_id ${id})`);
            return;
        }
        clearTimeout(p.timer);
        this._pending = null;

        const meta = bytesOf(f, SUB_META);
        if (meta) {
            const mf = readFields(meta);
            const err = first(mf, META_SIMPLE_ERROR);
            if (err) {
                const code = err.value;
                const name = META_ERROR_NAMES[code] ?? `error ${code}`;
                const kind = code === 1 ? 'unlockRequired'
                    : code === 2 ? 'rpcNotFound'
                    : code === 3 ? 'decodeFailed' : 'remote';
                p.reject(new StudioError(kind, `Device replied ${name}`, code));
            } else {
                p.resolve({ noResponse: true });    // meta.no_response
            }
            return;
        }
        for (const sub of [SUB_CORE, SUB_BEHAVIORS, SUB_KEYMAP]) {
            const b = bytesOf(f, sub);
            if (b) { p.resolve({ subsys: sub, fields: readFields(b) }); return; }
        }
        p.resolve({ noResponse: true });    // empty but matched — treat as ack
    }

    _onNotification(bytes) {
        const f = readFields(bytes);
        const core = bytesOf(f, NOTIF_CORE);
        if (core) {
            const cf = readFields(core);
            const ls = first(cf, CORE_NOTIF_LOCK_STATE);
            if (ls) this.dispatchEvent(new CustomEvent('lockstate', { detail: ls.value }));
            return;
        }
        const km = bytesOf(f, NOTIF_KEYMAP);
        if (km) {
            const kf = readFields(km);
            const us = first(kf, KM_NOTIF_UNSAVED);
            if (us) this.dispatchEvent(new CustomEvent('unsaved', { detail: us.value !== 0 }));
        }
    }

    _rejectPending(err) {
        const p = this._pending;
        if (!p) return;
        this._pending = null;
        clearTimeout(p.timer);
        p.reject(err);
    }

    /** One request in flight, ever (same FIFO promise-chain as FlaskHID). */
    _enqueue(fn) {
        const run = this._chain.then(fn, fn);
        this._chain = run.then(() => {}, () => {});
        return run;
    }

    _rpc(subsysField, innerBytes, { timeout = RPC_TIMEOUT_MS } = {}) {
        return this._enqueue(() => new Promise((resolve, reject) => {
            if (!this.connected) {
                reject(new StudioError('notConnected', 'Studio serial not connected'));
                return;
            }
            const id = this._nextId++;
            const payload = buildRequest(id, subsysField, innerBytes);
            this._pending = {
                id, resolve, reject,
                timer: setTimeout(() => {
                    if (this._pending?.id === id) {
                        this._pending = null;
                        reject(new StudioError('timeout', 'Device did not answer in time'));
                    }
                }, timeout),
            };
            this._writer.write(encodeFrame(payload)).catch((e) => {
                this._rejectPending(new StudioError('notConnected', `Serial write failed: ${e.message}`));
            });
        }));
    }

    _expect(reply, subsys, field) {
        if (reply.subsys !== subsys) {
            throw new StudioError('decodeFailed', 'Unexpected response subsystem');
        }
        return bytesOf(reply.fields, field) ?? null;
    }

    // ---- core ----

    async getDeviceInfo() {
        const r = await this._rpc(SUB_CORE, fVarint(CORE_GET_DEVICE_INFO, 1, true));
        const b = this._expect(r, SUB_CORE, CORE_GET_DEVICE_INFO);
        if (!b) throw new StudioError('decodeFailed', 'No device info in response');
        const f = readFields(b);
        return { name: stringOf(f, 1), serialNumber: bytesOf(f, 2) ?? new Uint8Array() };
    }

    async getLockState() {
        const r = await this._rpc(SUB_CORE, fVarint(CORE_GET_LOCK_STATE, 1, true));
        if (r.noResponse) return LOCK_LOCKED;
        // proto3: enum value 0 (LOCKED) may be omitted inside the oneof arm
        return varintOf(r.fields, CORE_GET_LOCK_STATE, LOCK_LOCKED);
    }

    // ---- keymap ----

    async getKeymap() {
        const r = await this._rpc(SUB_KEYMAP, fVarint(KM_GET_KEYMAP, 1, true));
        const b = this._expect(r, SUB_KEYMAP, KM_GET_KEYMAP);
        if (!b) throw new StudioError('decodeFailed', 'No keymap in response');
        return decodeKeymap(b);
    }

    async getPhysicalLayouts() {
        const r = await this._rpc(SUB_KEYMAP, fVarint(KM_GET_PHYSICAL_LAYOUTS, 1, true));
        const b = this._expect(r, SUB_KEYMAP, KM_GET_PHYSICAL_LAYOUTS);
        if (!b) throw new StudioError('decodeFailed', 'No physical layouts in response');
        return decodePhysicalLayouts(b);
    }

    async setLayerBinding(layerId, keyPosition, binding) {
        // Every assignment goes through the diagnostics ring — the exact
        // id/params the wire carried is the evidence that settles any
        // INVALID_PARAMETERS report (bench 5: "leader still fails").
        const summary = `layer=${layerId} pos=${keyPosition} bhv=${binding.behaviorId}`
            + ` p1=${(binding.param1 ?? 0) >>> 0} p2=${(binding.param2 ?? 0) >>> 0}`;
        const inner = fBytes(KM_SET_LAYER_BINDING, [
            ...fVarint(1, layerId),
            ...fVarint(2, keyPosition),
            ...fBytes(3, encodeBinding(binding)),
        ]);
        const r = await this._rpc(SUB_KEYMAP, inner);
        const code = r.noResponse ? 0 : varintOf(r.fields, KM_SET_LAYER_BINDING, 0);
        if (code !== 0) {
            const name = SET_BINDING_ERROR_NAMES[code] ?? `set-binding error ${code}`;
            diag.log('studio-assign-REJECTED', `${summary} → ${name}`);
            throw new StudioError('remote', name, code);
        }
        diag.log('studio-assign', summary);
    }

    async setLayerProps(layerId, name) {
        const inner = fBytes(KM_SET_LAYER_PROPS, [
            ...fVarint(1, layerId),
            ...fString(2, name),
        ]);
        const r = await this._rpc(SUB_KEYMAP, inner);
        const code = r.noResponse ? 0 : varintOf(r.fields, KM_SET_LAYER_PROPS, 0);
        if (code !== 0) {
            throw new StudioError('remote',
                SET_LAYER_PROPS_ERROR_NAMES[code] ?? `set-layer-props error ${code}`, code);
        }
    }

    // ---- layer structure ops (all live-applied; Save persists) ----

    _layerOpThrow(code, names, what) {
        if (code !== 0) {
            throw new StudioError('remote', `${what}: ${names[code] ?? `error ${code}`}`, code);
        }
    }

    /** Returns the full post-move Keymap when the device supplies it (adopt
     * it wholesale), else null (caller re-fetches or splices locally). */
    async moveLayer(startIndex, destIndex) {
        const inner = fBytes(KM_MOVE_LAYER, [
            ...fVarint(1, startIndex),
            ...fVarint(2, destIndex),
        ]);
        const r = await this._rpc(SUB_KEYMAP, inner);
        const b = r.noResponse ? null : bytesOf(r.fields, KM_MOVE_LAYER);
        if (!b) return null;
        const { err, keymap } = decodeMoveLayerResponse(b);
        this._layerOpThrow(err, MOVE_LAYER_ERROR_NAMES, 'Move layer');
        return keymap?.layers?.length ? keymap : null;
    }

    /** Returns {index, layer|null}. Only succeeds when the device has free
     * slots (available_layers > 0 — freed by remove_layer). */
    async addLayer() {
        // AddLayerRequest is an EMPTY MESSAGE (wire type 2), not a bool like
        // get_keymap/save_changes — encoding it as a varint made real
        // firmware reject the request while the wire-less offline sim passed
        // (bench 2026-07-11: "adding layers does not work").
        const r = await this._rpc(SUB_KEYMAP, fBytes(KM_ADD_LAYER, []));
        const b = r.noResponse ? null : bytesOf(r.fields, KM_ADD_LAYER);
        if (!b) throw new StudioError('decodeFailed', 'No add-layer result in response');
        const { err, index, layer } = decodeAddLayerResponse(b);
        this._layerOpThrow(err, ADD_LAYER_ERROR_NAMES, 'Add layer');
        return { index, layer };
    }

    async removeLayer(layerIndex) {
        const inner = fBytes(KM_REMOVE_LAYER, fVarint(1, layerIndex));
        const r = await this._rpc(SUB_KEYMAP, inner);
        const b = r.noResponse ? null : bytesOf(r.fields, KM_REMOVE_LAYER);
        if (b) this._layerOpThrow(decodeRemoveLayerResponse(b).err, REMOVE_LAYER_ERROR_NAMES, 'Remove layer');
    }

    /** Restore a previously removed layer (by its stable id) at at_index. */
    async restoreLayer(layerId, atIndex) {
        const inner = fBytes(KM_RESTORE_LAYER, [
            ...fVarint(1, layerId),
            ...fVarint(2, atIndex),
        ]);
        const r = await this._rpc(SUB_KEYMAP, inner);
        const b = r.noResponse ? null : bytesOf(r.fields, KM_RESTORE_LAYER);
        if (!b) return null;
        const { err, layer } = decodeRestoreLayerResponse(b);
        this._layerOpThrow(err, RESTORE_LAYER_ERROR_NAMES, 'Restore layer');
        return layer;
    }

    async checkUnsavedChanges() {
        const r = await this._rpc(SUB_KEYMAP, fVarint(KM_CHECK_UNSAVED, 1, true));
        if (r.noResponse) return false;
        return varintOf(r.fields, KM_CHECK_UNSAVED, 0) !== 0;
    }

    async saveChanges() {
        const r = await this._rpc(SUB_KEYMAP, fVarint(KM_SAVE_CHANGES, 1, true),
            { timeout: SAVE_TIMEOUT_MS });
        const b = r.noResponse ? null : bytesOf(r.fields, KM_SAVE_CHANGES);
        if (b) {
            const f = readFields(b);
            const err = first(f, 2);    // SaveChangesResponse.err
            if (err && err.value !== 0) {
                throw new StudioError('remote',
                    SAVE_ERROR_NAMES[err.value] ?? `save error ${err.value}`, err.value);
            }
        }
    }

    async discardChanges() {
        await this._rpc(SUB_KEYMAP, fVarint(KM_DISCARD_CHANGES, 1, true));
    }

    // ---- behaviors ----

    async listAllBehaviors() {
        const r = await this._rpc(SUB_BEHAVIORS, fVarint(BHV_LIST_ALL, 1, true));
        const b = this._expect(r, SUB_BEHAVIORS, BHV_LIST_ALL);
        if (!b) return [];
        return packedVarints(readFields(b), 1);
    }

    async getBehaviorDetails(behaviorId) {
        const inner = fBytes(BHV_GET_DETAILS, fVarint(1, behaviorId, true));
        const r = await this._rpc(SUB_BEHAVIORS, inner);
        const b = this._expect(r, SUB_BEHAVIORS, BHV_GET_DETAILS);
        if (!b) throw new StudioError('decodeFailed', 'No behavior details in response');
        return decodeBehaviorDetails(b);
    }
}
