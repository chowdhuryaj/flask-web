// WebHID transport for QMK raw HID: usage page 0xFF60 / usage 0x61,
// 32-byte INPUT/OUTPUT reports, no report ID. Port of the Swift app's
// HIDClient (AdeptCompanion Sources/AdeptCore/HIDClient.swift) — same
// single-in-flight + matcher + timeout/retry/drain semantics, with the
// Swift `.busy` throw replaced by a FIFO promise chain so any caller
// (tabs, HUD poll) can fire and ordering is preserved.

import { diag, diagHex } from './diag.js?v=11';

export const USAGE_PAGE = 0xFF60;
export const USAGE = 0x61;
export const REPORT_SIZE = 32;

// The HUD's poll family — key-state + meta active-layer at ~15 Hz, status
// chips (autoscroll level / macro playing / ballswap effective) at ~4 Hz.
// The diagnostics ring COUNTS these instead of listing them, or the
// 600-entry ring holds under a minute of session (bench 5's report was
// wall-to-wall meta-layer GETs). GET frames only — SETs always list.
const POLL_VALUES = { 0x23: null, 0x00: 0x02, 0x1a: 0x05, 0x25: 0x06, 0x27: 0x02 };
function isPollFrame(bytes) {
    if (bytes[0] !== 0x08) return false;
    const v = POLL_VALUES[bytes[1]];
    return v === null || v === bytes[2];
}

export class HIDError extends Error {
    constructor(kind, msg) { super(msg || kind); this.kind = kind; }
}

export class FlaskHID extends EventTarget {
    constructor() {
        super();
        this.device = null;          // HIDDevice
        this._pending = null;        // { matches, resolve, reject, timer }
        this._chain = Promise.resolve();
        this._pauseCount = 0;
        navigator.hid?.addEventListener('disconnect', (e) => {
            if (e.device === this.device) this._handleDisconnect();
        });
        navigator.hid?.addEventListener('connect', (e) => {
            // Replug of a previously-granted device: offer silent reconnect.
            this.dispatchEvent(new CustomEvent('deviceavailable', { detail: e.device }));
        });
    }

    static supported() { return 'hid' in navigator; }

    get connected() { return !!this.device?.opened; }

    /** All previously-granted raw-HID interfaces (no user gesture needed). */
    static async grantedDevices() {
        if (!navigator.hid) return [];
        const devices = await navigator.hid.getDevices();
        return devices.filter((d) =>
            d.collections.some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE));
    }

    /** User-gesture connect: browser chooser filtered to QMK raw HID. */
    async requestDevice() {
        const devices = await navigator.hid.requestDevice({
            filters: [{ usagePage: USAGE_PAGE, usage: USAGE }],
        });
        const dev = devices.find((d) =>
            d.collections.some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE));
        if (!dev) throw new HIDError('cancelled', 'No device chosen');
        return dev;
    }

    async open(dev) {
        if (this.device && this.device !== dev) await this.close();
        if (!dev.opened) await dev.open();
        this.device = dev;
        dev.oninputreport = (e) => this._onInputReport(e);
        localStorage.setItem('flask-last-device',
            `${dev.vendorId.toString(16).padStart(4, '0')}:${dev.productId.toString(16).padStart(4, '0')}`);
        diag.log('hid-open', `${dev.vendorId.toString(16)}:${dev.productId.toString(16)} ${dev.productName ?? ''}`);
        this.dispatchEvent(new Event('connect'));
    }

    async close() {
        const dev = this.device;
        this.device = null;
        this._rejectPending(new HIDError('notConnected', 'Device closed'));
        if (dev?.opened) { try { await dev.close(); } catch { /* already gone */ } }
    }

    _handleDisconnect() {
        this.device = null;
        diag.log('hid-disconnect', 'device gone (event, or dead handle after a failed write)');
        this._rejectPending(new HIDError('notConnected', 'Device disconnected'));
        this.dispatchEvent(new Event('disconnect'));
    }

    _rejectPending(err) {
        if (this._pending) {
            clearTimeout(this._pending.timer);
            const p = this._pending;
            this._pending = null;
            p.reject(err);
        }
    }

    _onInputReport(e) {
        const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
        // No pending, or not the answer we're waiting for (late reply after a
        // timeout, Vial-GUI traffic) → drop silently. This drop-while-idle is
        // what makes the retry drain window work.
        if (!this._pending || bytes.length < 5 || !this._pending.matches(bytes)) return;
        clearTimeout(this._pending.timer);
        const p = this._pending;
        this._pending = null;
        if (isPollFrame(bytes)) diag.pollOk(); else diag.rxOk();
        p.resolve(Array.from(bytes));
    }

    /**
     * Pause/resume: advisory flag ONLY — the HUD poll loop checks `paused`
     * and skips ticks. It must never block the queue itself (a queued op
     * waiting on unpause would deadlock everything behind it, including the
     * unlock transaction that needs to run while paused).
     */
    pause() { this._pauseCount++; }
    resume() { this._pauseCount = Math.max(0, this._pauseCount - 1); }
    get paused() { return this._pauseCount > 0; }

    /** FIFO queue: one request in flight, ever. */
    _enqueue(fn) {
        const run = this._chain.then(fn, fn);
        // Keep the chain alive through rejections.
        this._chain = run.then(() => {}, () => {});
        return run;
    }

    _sendOnce(prefix, matches, timeoutMs = 500) {
        return new Promise((resolve, reject) => {
            if (!this.device?.opened) {
                reject(new HIDError('notConnected', 'Device not connected'));
                return;
            }
            const report = new Uint8Array(REPORT_SIZE);
            report.set(prefix.slice(0, REPORT_SIZE));
            const isPoll = isPollFrame(report);
            const t0 = performance.now();
            if (!isPoll) diag.log('tx', diagHex(report, 10));
            this._pending = {
                matches,
                resolve: (bytes) => {
                    diag.lat(report[1], performance.now() - t0);
                    resolve(bytes);
                },
                reject,
                timer: setTimeout(() => {
                    if (this._pending) {
                        const p = this._pending;
                        this._pending = null;
                        diag.timeout((isPoll ? 'status poll ' : '') + diagHex(report, 10));
                        p.reject(new HIDError('timeout', 'Device did not answer in time'));
                    }
                }, timeoutMs),
            };
            this.device.sendReport(0, report).catch(async (e) => {
                diag.log('write-failed', `${e.message} — tearing the connection down`);
                this._rejectPending(new HIDError('writeFailed', `HID write failed: ${e.message}`));
                // A failed WRITE means the OS handle is dead — this happens
                // when the keyboard re-enumerates (power cycle) and the
                // embedder never delivered a disconnect event, leaving a
                // stale device that still claims .opened (bench 2026-07-12:
                // every op after a power cycle failed forever). Tear the
                // connection down so the reconnect logic can take over.
                const dev = this.device;
                this._handleDisconnect();
                if (dev?.opened) {
                    try { await dev.close(); } catch { /* already gone */ }
                }
            });
        });
    }

    // Retry wrapper (port of HIDClient.swift:213-229, comment preserved):
    // a single dropped/late report used to poison the whole session — the
    // 0.5 s timeout fires, the device's late answer is then consumed as the
    // NEXT command's response (rawCommand matches any report), and every
    // reply after that is shifted by one. The sleep before each retry is the
    // fix's core: while nothing is pending, _onInputReport drops stray
    // reports, so the gap absorbs a late answer before it can desync the
    // stream.
    async _send(prefix, matches, { timeoutMs = 500, retries = 2 } = {}) {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await this._sendOnce(prefix, matches, timeoutMs);
            } catch (e) {
                if (e.kind !== 'timeout') throw e;
                await new Promise((r) => setTimeout(r, 250)); // drain window
            }
        }
        return this._sendOnce(prefix, matches, timeoutMs);
    }

    /** Tuning frame: response matched on echoed (channel, value_id).
     * `echoBytes` extends the match into the payload — the first N payload
     * bytes must echo the request (Flask payload-addressed frames echo
     * their address prefix: combo/leader slot, macro step, RGB layer+led).
     * Without it a LATE reply for slot 3 (after its request timed out)
     * satisfies the in-flight slot-4 request — same (channel, value) — and
     * every table read after that is shifted by one. */
    request(prefix, echoBytes = 0, opts = undefined) {
        const channel = prefix[1] ?? 0;
        const valueID = prefix[2] ?? 0;
        const echo = prefix.slice(3, 3 + echoBytes);
        return this._enqueue(() =>
            this._send(prefix, (r) => r[1] === channel && r[2] === valueID
                && echo.every((b, i) => r[3 + i] === b), opts));
    }

    /**
     * Raw VIA/Vial command: matches the NEXT report. Correct only because
     * requests are strictly serialized and QMK answers every report exactly
     * once — do not run the Vial GUI alongside; its responses interleave.
     */
    rawCommand(prefix) {
        return this._enqueue(() => this._send(prefix, () => true));
    }

    /** Run several operations as one uninterruptible sequence (bulk fetch). */
    transaction(fn) {
        return this._enqueue(async () => {
            // Inside a transaction, ops must bypass the queue (we're already
            // holding it) — hand the callback direct-send primitives.
            const direct = {
                request: (prefix) => this._send(prefix,
                    (r) => r[1] === (prefix[1] ?? 0) && r[2] === (prefix[2] ?? 0)),
                rawCommand: (prefix) => this._send(prefix, () => true),
            };
            return fn(direct);
        });
    }
}
