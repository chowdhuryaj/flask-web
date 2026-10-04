// Offline workspaces: edit a device's configuration with no keyboard
// attached; every edit is journaled (last-write-wins per address) and the
// queue auto-applies on the next real connect.
//
// Model: a workspace per device family in localStorage holds a display
// snapshot plus a dirty journal. Offline mode swaps app.flask for the fake
// below (zmk-offline.js extends it) — the tabs are unchanged and don't know
// the device is missing. Sync applies ONLY dirty entries, never the whole
// snapshot, so a template workspace can't wipe a real keymap.
//
// This file is the shared core: storage, the tunable/RGB journal and its
// replay. Everything ZMK-shaped (keymap, combo/macro slots, templates) is in
// zmk-offline.js. The Svalboard (QMK line) uses this core alone: tunables
// journal, no keymap simulator. Its corner chords (0x28) are read-only
// offline and never SAVEd on replay (a 0x28 SAVE wedged the board).

import { el, modal, toast } from './ui.js?v=78';
import { CH_ZMK, CH_QMK, V, V_QMK } from './flaskproto.js?v=78';
import { isZmkFamily } from './zmk.js?v=78';
import { isQmkFamily } from './boards.js?v=78';

const LS_PREFIX = 'flask-offline-';
const AUTO_KEY = 'flask-offline-autoapply';
// Baseline for "Discard queued" (written by zmk-offline.js). Not under
// LS_PREFIX so listWorkspaces never mistakes it for a workspace.
export const BASE_PREFIX = 'flask-offline-base:';

// Live-state value ids (SET is a transient action, not a setting) — never
// journal these offline. '<ch>:<id>' decimal, per firmware line (the
// channel numbers are double-booked across lines).
const LIVE_SET = {
    zmk: new Set([
        `${CH_ZMK.autoscroll}:5`,   // asState force-stop
    ]),
    qmk: new Set([
        `${CH_QMK.mouseButtons}:${V_QMK.mbLockMask}`, // any SET releases latched buttons
        `${CH_QMK.numWord}:${V_QMK.nwActive}`,        // SET forces num word off
        `${CH_QMK.diag}:${V_QMK.diagMaxGap}`,         // SET resets the watermark
        `${CH_QMK.corner}:${V_QMK.ccMisfires}`,       // SET resets the counter
    ]),
};
const lineOfWs = (ws) => (isQmkFamily(ws?.family) ? 'qmk' : 'zmk');

// ---------- storage ----------

export function workspaceKey(family, device) {
    return family === 'generic' && device
        ? `generic-${device.vendorId.toString(16)}:${device.productId.toString(16)}`
        : family;
}

export function loadWorkspace(key) {
    try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw ? normalize(JSON.parse(raw)) : null;
    } catch { return null; }
}

/** Fill fields older stored workspaces don't have (append-only schema). */
function normalize(ws) {
    ws.dirty ??= {};
    const d = ws.dirty;
    for (const k of ['tun', 'rgb']) d[k] ??= {};
    d.saves ??= [];
    ws.tunables ??= {};
    return ws;
}

export function saveWorkspace(ws) {
    localStorage.setItem(LS_PREFIX + ws.key, JSON.stringify(ws));
    ws._notify?.();
}

export function deleteWorkspace(key) {
    localStorage.removeItem(LS_PREFIX + key);
    localStorage.removeItem(BASE_PREFIX + key);
}

/** Saved workspaces for ZMK boards and the Svalboard (anything else in storage is ignored). */
export function listWorkspaces() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(LS_PREFIX) && k !== AUTO_KEY) {
            const ws = loadWorkspace(k.slice(LS_PREFIX.length));
            if (ws?.key && (isZmkFamily(ws.family) || isQmkFamily(ws.family))) out.push(ws);
        }
    }
    return out;
}

export function pendingCount(ws) {
    const d = ws.dirty;
    return Object.keys(d.tun).length + Object.keys(d.rgb).length;
}

export function clearDirty(ws) {
    ws.dirty = {};
    normalize(ws);
    saveWorkspace(ws);
}

// ---------- offline stand-in for FlaskProto ----------

const tk = (ch, id) => `${ch}:${id}`;

export class OfflineFlask {
    constructor(ws) { this.ws = ws; }

    async getU16(ch, id) {
        return this.ws.tunables[tk(ch, id)]?.val ?? 0;
    }
    async getI16(ch, id) { return ((await this.getU16(ch, id)) << 16) >> 16; }

    async setU16(ch, id, value) {
        const v = Math.max(0, Math.min(0xFFFF, Math.round(value))) & 0xFFFF;
        this._journal(ch, id, 'u16', v);
        return v;
    }

    async setI16(ch, id, value) {
        const v = Math.round(value);
        this._journal(ch, id, 'i16', v);
        return v;
    }

    _journal(ch, id, op, val) {
        const k = tk(ch, id);
        const line = lineOfWs(this.ws);
        if (line === 'qmk' && ch === CH_QMK.corner) throw new Error('corner chords (0x28) are read-only offline');
        if (LIVE_SET[line].has(k) || ch === CH_ZMK.meta) return; // transient — drop
        this.ws.tunables[k] = { op, val };
        this.ws.dirty.tun[k] = { op, val };
        saveWorkspace(this.ws);
    }

    async save(ch) {
        if (!this.ws.dirty.saves.includes(ch)) {
            this.ws.dirty.saves.push(ch);
            saveWorkspace(this.ws);
        }
    }

    // Payload-addressed frames have no journal in the core (zmk-offline.js
    // simulates the ZMK ones). A Svalboard's corner chords are read-only.
    async getBytes() { throw new Error('unhandled'); }
    async setBytes(ch) {
        if (lineOfWs(this.ws) === 'qmk' && ch === CH_QMK.corner) throw new Error('corner chords (0x28) are read-only offline');
        throw new Error('unhandled');
    }

    async handshake() { return this.ws.protocolVersion; }
}

// ---------- sync: replay the journal onto a real device ----------

const CH_NAMES = {
    zmk: Object.fromEntries(Object.entries(CH_ZMK).map(([k, v]) => [v, k])),
    qmk: Object.fromEntries(Object.entries(CH_QMK).map(([k, v]) => [v, k])),
};

/** Human-readable change list for the confirm modal. */
export function describeChanges(ws) {
    const names = CH_NAMES[lineOfWs(ws)];
    const lines = [];
    for (const [k, t] of Object.entries(ws.dirty.tun)) {
        const [ch, id] = k.split(':').map(Number);
        lines.push(`${names[ch] ?? `ch ${ch}`} value 0x${id.toString(16)} = ${t.val}`);
    }
    for (const k of Object.keys(ws.dirty.rgb)) {
        const [l, led] = k.split(',');
        lines.push(`RGB L${l} led ${led} = hsv(${ws.dirty.rgb[k].join(',')})`);
    }
    return lines;
}

/**
 * Apply every dirty entry to the connected device. Applied entries leave
 * the journal; failures stay queued for the next connect. Clamp-echo rule:
 * the snapshot adopts what the firmware echoed, not what we sent.
 */
export async function syncWorkspace(app, ws) {
    const fail = [];
    // Entries the DEVICE does not serve — dropped rather than retried forever.
    const dropped = [];
    let applied = 0;
    // SAVE is the commit point: a SET only changes RAM, so an entry leaves
    // the journal after its channel's SAVE lands, never before.
    const pending = new Map();      // ch → [journal keys SET but not yet saved]
    const clampedKeys = new Set();
    const names = CH_NAMES[lineOfWs(ws)];
    const label = (ch, id) => `${names[ch] ?? ch}/0x${id.toString(16)}`;
    // QMK line: corner chords persist on SET; their channel SAVE wedged the
    // Svalboard. The device's own line wins; an unset line falls back to the
    // workspace family (fail-safe for old workspaces that journaled 0x28).
    const line = app.flask?.line ?? lineOfWs(ws);
    const noSave = (ch) => line !== 'zmk' && ch === CH_QMK.corner;

    for (const [k, t] of Object.entries(ws.dirty.tun)) {
        const [ch, id] = k.split(':').map(Number);
        try {
            const echo = t.op === 'i16'
                ? await app.flask.setI16(ch, id, t.val)
                : await app.flask.setU16(ch, id, t.val);
            if (echo !== t.val) clampedKeys.add(k);
            ws.tunables[k] = { op: t.op, val: echo };
            if (!pending.has(ch)) pending.set(ch, []);
            pending.get(ch).push(k);
        } catch (e) {
            // "unhandled" means the DEVICE does not serve this id — the
            // firmware answered id_unhandled. Retrying it on every connect
            // forever is pointless, and it leaves a pending count that can
            // never reach zero. Drop those and report them separately. A
            // timeout or transport error is a DIFFERENT failure and stays
            // queued, because that one is transient.
            if (e.message === 'unhandled') {
                delete ws.dirty.tun[k];
                dropped.push(label(ch, id));
            } else {
                fail.push(`${label(ch, id)}: ${e.message}`);
            }
        }
    }

    const keepSaves = [];
    for (const ch of new Set([...ws.dirty.saves, ...pending.keys()])) {
        const keys = pending.get(ch) ?? [];
        try {
            if (!noSave(ch)) await app.flask.save(ch);
        } catch (e) {
            // A channel with no persistence answers unhandled: nothing to
            // lose, treat as saved. Anything else (timeout, transport) means
            // the values are RAM-only: keep them queued and say so.
            if (e.message !== 'unhandled') {
                keepSaves.push(ch);
                for (const k of keys) fail.push(`${names[ch] ?? ch} ${k}: SAVE failed (${e.message})`);
                if (!keys.length) fail.push(`${names[ch] ?? ch}: SAVE failed (${e.message})`);
                continue;
            }
        }
        for (const k of keys) {
            delete ws.dirty.tun[k]; applied++;
        }
    }
    ws.dirty.saves = keepSaves;
    const clamped = [...clampedKeys].filter((k) => !ws.dirty.tun[k]).length;   // committed ones only

    // RGB map paints (payload-addressed), committed by one rgbMap SAVE.
    const rgbDone = [];
    for (const [k, hsv] of Object.entries(ws.dirty.rgb)) {
        const [l, led] = k.split(',').map(Number);
        try {
            await app.flask.setBytes(CH_ZMK.rgbMap, V.rgbmapLed, [l, led, ...hsv]);
            rgbDone.push(k);
        } catch (e) { fail.push(`rgb ${k}: ${e.message}`); }
    }
    if (rgbDone.length) {
        try {
            await app.flask.save(CH_ZMK.rgbMap);
            for (const k of rgbDone) { delete ws.dirty.rgb[k]; applied++; }
        } catch (e) {
            if (e.message === 'unhandled') for (const k of rgbDone) { delete ws.dirty.rgb[k]; applied++; }
            else fail.push(`rgb: SAVE failed (${e.message})`);
        }
    }

    saveWorkspace(ws);
    return { applied, clamped, failures: fail, dropped };
}

/**
 * Connect-time hook: if a workspace for this device has queued changes,
 * apply them (silently when auto-apply is on, else after a confirm modal).
 * Resolves when the decision is made; loadDevice awaits this before
 * building tabs so they render post-sync state.
 *
 * `ext` lets the ZMK layer join the SAME decision (offline.js cannot import
 * zmk-offline.js): {count(ws), describe(ws) → lines, apply(app, ws) (does its
 * own toasts), clear(ws) (drops everything queued)}. Apply now runs both
 * halves, Discard clears both, Later / closing the dialog leaves both queued
 * and sends nothing.
 *
 * Returns 'none' | 'applied' | 'later' | 'discarded' | 'aborted' (the
 * keyboard went away while the dialog was open: nothing was sent).
 */
export async function maybeSyncOffline(app, device, ext = {}) {
    const ws = loadWorkspace(workspaceKey(app.family, device));
    if (!ws) return 'none';
    const extra = () => ext.count?.(ws) ?? 0;
    if (!pendingCount(ws) && !extra()) return 'none';

    const run = async () => {
        const { applied, clamped, failures, dropped } = await syncWorkspace(app, ws);
        let msg = `Applied ${applied} offline change${applied === 1 ? '' : 's'}`;
        if (clamped) msg += ` (${clamped} clamped by firmware)`;
        // Dropped is not a failure: the firmware simply no longer has that
        // feature (a workspace journaled before the board lost a channel).
        // Say so once and clear them, rather than reporting the same
        // never-appliable entries on every single connect.
        if (dropped.length) {
            console.info('offline sync dropped (device no longer serves):', dropped);
            msg += ` (${dropped.length} dropped — firmware no longer has them)`;
        }
        if (failures.length) {
            console.warn('offline sync failures:', failures);
            toast(`${msg} — ${failures.length} failed, still queued`, true);
        } else if (applied || !extra()) {
            toast(msg);
        }
        await ext.apply?.(app, ws);
    };

    if (localStorage.getItem(AUTO_KEY) === '1') { await run(); return 'applied'; }

    const lines = [...describeChanges(ws), ...(ext.describe?.(ws) ?? [])];
    return new Promise((resolve) => {
        const autoCb = el('input', { type: 'checkbox' });
        const body = el('div', {},
            el('p', { class: 'muted', text: `Queued while ${ws.label} was disconnected:` }),
            el('div', { class: 'mono', style: 'max-height:240px; overflow-y:auto; font-size:12px; line-height:1.6' },
                ...lines.slice(0, 15).map((l) => el('div', { text: l })),
                lines.length > 15 ? el('div', { class: 'faint', text: `…and ${lines.length - 15} more` }) : null),
            el('label', { style: 'display:flex; gap:6px; align-items:center; margin-top:10px' },
                autoCb, 'Apply automatically from now on'));
        let settled = false;
        const finish = (r) => {
            if (settled) return;
            settled = true;
            app.hid?.removeEventListener?.('disconnect', onGone);
            back.remove();
            resolve(r);
        };
        // Unplugged with the dialog open: close it, send nothing, keep the queue.
        const onGone = () => finish('aborted');
        app.hid?.addEventListener?.('disconnect', onGone);
        let busy = false;
        const done = (result, fn) => async () => {
            if (settled || busy) return;
            busy = true;
            back.remove();
            if (autoCb.checked && result === 'applied') localStorage.setItem(AUTO_KEY, '1');
            try { await fn?.(); } finally { finish(result); }
        };
        const back = modal(`Apply ${lines.length} offline change${lines.length === 1 ? '' : 's'}?`, body, [
            el('button', { class: 'btn primary', text: 'Apply now', onclick: done('applied', run) }),
            el('button', { class: 'btn', text: 'Later', onclick: done('later') }),
            el('button', {
                class: 'btn danger', text: 'Discard',
                onclick: done('discarded', async () => {
                    if (ext.clear) ext.clear(ws); else clearDirty(ws);
                    toast('Offline changes discarded');
                }),
            }),
        ]);
        // Backdrop click = "Later" (modal removes itself; don't hang loadDevice).
        back.addEventListener('click', (e) => { if (e.target === back) finish('later'); });
    });
}
