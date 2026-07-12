// Black-box diagnostics — a timestamped ring of transport + Studio events,
// exportable as a text report, so a board death is reconstructable from the
// app alone (bench 5 ask: logging without reflashing the logging UF2 and
// babysitting tio). Generic infra: the QMK and ZMK lines both ride it.
//
// What it can and cannot see: everything the HOST observes (frames, echoes,
// timeouts, write failures, re-enumerations, Studio RPC results, boot
// reset-cause) — not firmware-internal log lines. In practice the useful
// crash evidence has been exactly this shape: WHEN the device stopped
// answering, what the last exchange was, and what the reset-cause said on
// the next boot.
//
// Volume: the HUD key-state poll runs ~15 Hz — those frames are COUNTED,
// not listed (their failures always list). Everything else is low-rate by
// construction (single-in-flight transport).

const CAP = 600;

export function diagHex(bytes, n = 12) {
    const arr = Array.from(bytes.slice(0, n), (b) => b.toString(16).padStart(2, '0'));
    return arr.join(' ') + (bytes.length > n ? ' …' : '');
}

class Diag extends EventTarget {
    constructor() {
        super();
        this.events = [];
        this.t0 = Date.now();
        this.polls = { ok: 0, lastAt: 0 };
        this.deadSince = null;
        this._timeouts = [];
    }

    log(kind, detail = '') {
        this.events.push({ t: Date.now(), kind, detail });
        if (this.events.length > CAP) this.events.splice(0, this.events.length - CAP);
        this.dispatchEvent(new Event('log'));
    }

    /** A status poll answered (key-state / meta-layer / HUD chips) — the
     * liveness heartbeat. */
    pollOk() {
        this.polls.ok++;
        this.polls.lastAt = Date.now();
        this._alive();
    }

    /** Any non-poll reply answered. */
    rxOk() { this._alive(); }

    _alive() {
        this._timeouts.length = 0;
        if (this.deadSince) {
            this.log('device-recovered',
                `answering again after ${((Date.now() - this.deadSince) / 1000).toFixed(1)} s`);
            this.deadSince = null;
        }
    }

    /** A request timed out. Three within 6 s with no reply between = the
     * board stopped answering; snapshot the ring right then so the evidence
     * survives even an app restart. */
    timeout(detail) {
        const now = Date.now();
        this._timeouts.push(now);
        this._timeouts = this._timeouts.filter((t) => now - t < 6000);
        this.log('timeout', detail);
        if (!this.deadSince && this._timeouts.length >= 3) {
            this.deadSince = this._timeouts[0];
            const lastOk = this.polls.lastAt
                ? `${((now - this.polls.lastAt) / 1000).toFixed(1)} s ago` : 'never';
            this.log('DEVICE-UNRESPONSIVE', `3+ timeouts in 6 s; last successful poll ${lastOk}`);
            this.snapshot();
        }
    }

    /** Persist the current report — survives an app restart / crash. */
    snapshot() {
        try { localStorage.setItem('flask-diag-snapshot', this.report()); } catch { /* best-effort */ }
    }

    previousSnapshot() {
        try { return localStorage.getItem('flask-diag-snapshot'); } catch { return null; }
    }

    report() {
        const head = [
            `Flask diagnostics — ${new Date().toISOString()}`,
            navigator.userAgent,
            `status polls answered: ${this.polls.ok}`
                + (this.polls.lastAt
                    ? `, last ${((Date.now() - this.polls.lastAt) / 1000).toFixed(1)} s ago` : ''),
            this.deadSince
                ? `DEVICE UNRESPONSIVE since ${new Date(this.deadSince).toISOString()}`
                : 'device answering',
            '',
        ];
        const lines = this.events.map((e) =>
            `[+${((e.t - this.t0) / 1000).toFixed(3).padStart(10)}] ${e.kind}${e.detail ? ' ' + e.detail : ''}`);
        return head.concat(lines).join('\n');
    }
}

export const diag = new Diag();
