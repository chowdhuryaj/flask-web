// Offline workspaces: edit a device's configuration with no keyboard
// attached; every edit is journaled (last-write-wins per address) and the
// queue auto-applies on the next real connect.
//
// Model: a workspace per device family in localStorage holds a display
// snapshot (keymap/encoders/tunables/QSIDs) plus a dirty journal. Offline
// mode swaps app.flask/app.vial for the fakes below — the tabs are
// unchanged and don't know the device is missing. Sync applies ONLY dirty
// entries, never the whole snapshot, so a template workspace can't wipe a
// real keymap.

import { el, modal, toast } from './ui.js?v=3';
import { CH, EXPECTED_PROTOCOL } from './flaskproto.js?v=3';
import { QMK_SETTINGS } from './vialproto.js?v=3';
import { buildProfile, familyLabel, keyName, encoderCount } from './profiles.js?v=3';
import { describe } from './keycodes.js?v=3';

const LS_PREFIX = 'flask-offline-';
const AUTO_KEY = 'flask-offline-autoapply';

// Live-state value ids (SET is a transient action, not a setting) — never
// journal these offline. '<ch>:<id>' decimal.
const LIVE_SET = new Set([
    `${CH.dragScroll}:4`,   // dragActive force on/off
    `${CH.autoscroll}:5`,   // asState force-stop
    `${CH.diag}:1`,         // watermark reset
    `${CH.numWord}:3`,      // nwActive
    `${CH.gestures}:2`,     // active-set latch toggle
]);

// ---------- storage ----------

export function workspaceKey(family, device) {
    return family === 'generic' && device
        ? `generic-${device.vendorId.toString(16)}:${device.productId.toString(16)}`
        : family;
}

export function loadWorkspace(key) {
    try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

export function saveWorkspace(ws) {
    localStorage.setItem(LS_PREFIX + ws.key, JSON.stringify(ws));
    ws._notify?.();
}

export function deleteWorkspace(key) { localStorage.removeItem(LS_PREFIX + key); }

export function listWorkspaces() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(LS_PREFIX) && k !== AUTO_KEY) {
            const ws = loadWorkspace(k.slice(LS_PREFIX.length));
            if (ws?.key) out.push(ws);
        }
    }
    return out;
}

export function pendingCount(ws) {
    const d = ws.dirty;
    return Object.keys(d.km).length + Object.keys(d.enc).length
        + Object.keys(d.tun).length + Object.keys(d.qsid).length;
}

export function clearDirty(ws) {
    ws.dirty = { km: {}, enc: {}, tun: {}, qsid: {}, saves: [] };
    saveWorkspace(ws);
}

// ---------- templates (never-connected editing / beta testing) ----------

// Families with curated geometry in profiles.js — a template needs no
// served definition. Svalboard renders from its definition only, so it
// gets a workspace the first time the real board connects.
export const TEMPLATE_FAMILIES = ['adept', 'nlkb16'];

const TEMPLATE_DIMS = {
    adept: { rows: 1, cols: 6, layers: 8, encoders: 0 },
    nlkb16: { rows: 4, cols: 5, layers: 8, encoders: 3 },
};

function templateDefinition(family) {
    const t = TEMPLATE_DIMS[family];
    const keys = [];
    if (family === 'nlkb16') {
        // 4×4 grid + the three col-4 matrix slots buildProfile's curated
        // branch expects (knob pushes; (2,4) is filtered out there).
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
            keys.push({ row: r, col: c, x: c, y: r, w: 1, h: 1 });
        for (let r = 0; r < 3; r++) keys.push({ row: r, col: 4, x: 5, y: r, w: 1, h: 1 });
    }
    return {
        name: familyLabel(family), matrixRows: t.rows, matrixCols: t.cols,
        keys, encoderKeys: [], customKeycodes: [],
    };
}

export function createTemplate(family) {
    const t = TEMPLATE_DIMS[family];
    const profile = buildProfile(family, templateDefinition(family), t.layers);
    const keymap = Array.from({ length: t.layers }, () =>
        Array.from({ length: t.rows }, () => Array(t.cols).fill(0)));
    const encoders = Array.from({ length: t.layers }, () =>
        Array.from({ length: t.encoders }, () => ({ ccw: 0, cw: 0 })));
    return {
        v: 1, key: family, family, label: familyLabel(family),
        source: 'template', savedAt: Date.now(),
        protocolVersion: EXPECTED_PROTOCOL[family] ?? null,
        layerCount: t.layers, profile, keymap, encoders,
        tunables: {}, qsids: {},
        dirty: { km: {}, enc: {}, tun: {}, qsid: {}, saves: [] },
    };
}

// ---------- offline stand-ins for FlaskProto / VialClient ----------

const tk = (ch, id) => `${ch}:${id}`;

export class OfflineFlask {
    constructor(ws) { this.ws = ws; }

    async getU16(ch, id) { return this.ws.tunables[tk(ch, id)]?.val ?? 0; }
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
        if (LIVE_SET.has(k) || ch === CH.meta) return; // transient — drop
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

    // Payload-addressed ops (RGB/display) are transient pushes or reads of
    // live hardware state — no offline meaning. Reads return zeros.
    async getBytes() { return new Array(29).fill(0); }
    async setBytes() {}
    async handshake() { return this.ws.protocolVersion; }
}

export class OfflineVial {
    constructor(ws) { this.ws = ws; }

    async readKeymap() { return this.ws.keymap; }

    async setKeycode(layer, row, col, kc) {
        this.ws.keymap[layer][row][col] = kc;
        this.ws.dirty.km[`${layer},${row},${col}`] = kc;
        saveWorkspace(this.ws);
    }

    async encoderGet(layer, index) {
        return this.ws.encoders?.[layer]?.[index] ?? { ccw: 0, cw: 0 };
    }

    async encoderSet(layer, index, clockwise, kc) {
        const e = this.ws.encoders[layer][index];
        e[clockwise ? 'cw' : 'ccw'] = kc;
        this.ws.dirty.enc[`${layer},${index},${clockwise ? 1 : 0}`] = kc;
        saveWorkspace(this.ws);
    }

    async layerCount() { return this.ws.layerCount; }
    async unlockStatus() { return { unlocked: false, inProgress: false }; }

    // Both Flask firmwares compile the full vial-qmk QMK-settings catalog;
    // for a device-sourced workspace the snapshot narrows this on sync
    // failure anyway (unsupported QSIDs just fail and stay queued).
    async qmkSettingsQSIDs() { return QMK_SETTINGS.map((d) => d.qsid); }
    async qmkSettingGet(qsid) { return this.ws.qsids[qsid]?.val ?? 0; }

    async qmkSettingSet(qsid, width, val) {
        this.ws.qsids[qsid] = { width, val };
        this.ws.dirty.qsid[qsid] = { width, val };
        saveWorkspace(this.ws);
    }

    async qmkSettingsReset() {
        this.ws.qsids = {};
        this.ws.dirty.qsid = {};
        saveWorkspace(this.ws);
    }
}

// ---------- sync: replay the journal onto a real device ----------

const CH_NAMES = Object.fromEntries(Object.entries(CH).map(([k, v]) => [v, k]));

/** Human-readable change list for the confirm modal. */
export function describeChanges(ws, profile) {
    const lines = [];
    for (const [k, kc] of Object.entries(ws.dirty.km)) {
        const [l, r, c] = k.split(',').map(Number);
        lines.push(`L${l} ${keyName(profile ?? ws.profile, r, c)} → ${describe(kc)}`);
    }
    for (const [k, kc] of Object.entries(ws.dirty.enc)) {
        const [l, i, cw] = k.split(',').map(Number);
        lines.push(`L${l} encoder ${i} ${cw ? '↻' : '↺'} → ${describe(kc)}`);
    }
    for (const [k, t] of Object.entries(ws.dirty.tun)) {
        const [ch, id] = k.split(':').map(Number);
        lines.push(`${CH_NAMES[ch] ?? `ch ${ch}`} value 0x${id.toString(16)} = ${t.val}`);
    }
    for (const [qsid, e] of Object.entries(ws.dirty.qsid)) {
        const desc = QMK_SETTINGS.find((d) => d.qsid === Number(qsid));
        lines.push(`QMK setting ${desc?.label ?? qsid} = ${e.val}`);
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
    let applied = 0, clamped = 0;

    for (const [k, kc] of Object.entries(ws.dirty.km)) {
        const [l, r, c] = k.split(',').map(Number);
        try {
            await app.vial.setKeycode(l, r, c, kc);
            if (app.keymap?.[l]?.[r] != null) app.keymap[l][r][c] = kc;
            delete ws.dirty.km[k]; applied++;
        } catch (e) { fail.push(`key ${k}: ${e.message}`); }
    }

    for (const [k, kc] of Object.entries(ws.dirty.enc)) {
        const [l, i, cw] = k.split(',').map(Number);
        try {
            await app.vial.encoderSet(l, i, !!cw, kc);
            delete ws.dirty.enc[k]; applied++;
        } catch (e) { fail.push(`encoder ${k}: ${e.message}`); }
    }

    const touched = new Set(ws.dirty.saves);
    for (const [k, t] of Object.entries(ws.dirty.tun)) {
        const [ch, id] = k.split(':').map(Number);
        try {
            const echo = t.op === 'i16'
                ? await app.flask.setI16(ch, id, t.val)
                : await app.flask.setU16(ch, id, t.val);
            if (echo !== t.val) clamped++;
            ws.tunables[k] = { op: t.op, val: echo };
            touched.add(ch);
            delete ws.dirty.tun[k]; applied++;
        } catch (e) { fail.push(`${CH_NAMES[ch] ?? ch}/0x${id.toString(16)}: ${e.message}`); }
    }
    for (const ch of touched) {
        try { await app.flask.save(ch); } catch { /* DPI-style no-op channels */ }
    }
    ws.dirty.saves = [];

    for (const [qsid, e] of Object.entries(ws.dirty.qsid)) {
        try {
            await app.vial.qmkSettingSet(Number(qsid), e.width, e.val);
            delete ws.dirty.qsid[qsid]; applied++;
        } catch (err) { fail.push(`QSID ${qsid}: ${err.message}`); }
    }

    saveWorkspace(ws);
    return { applied, clamped, failures: fail };
}

/**
 * Connect-time hook: if a workspace for this device has queued changes,
 * apply them (silently when auto-apply is on, else after a confirm modal).
 * Resolves when the decision is made; loadDevice awaits this before
 * building tabs so they render post-sync state.
 */
export async function maybeSyncOffline(app, device) {
    const ws = loadWorkspace(workspaceKey(app.family, device));
    if (!ws || !pendingCount(ws)) return;

    const run = async () => {
        const { applied, clamped, failures } = await syncWorkspace(app, ws);
        let msg = `Applied ${applied} offline change${applied === 1 ? '' : 's'}`;
        if (clamped) msg += ` (${clamped} clamped by firmware)`;
        if (failures.length) {
            console.warn('offline sync failures:', failures);
            toast(`${msg} — ${failures.length} failed, still queued`, true);
        } else {
            toast(msg);
        }
    };

    if (localStorage.getItem(AUTO_KEY) === '1') { await run(); return; }

    const lines = describeChanges(ws, app.profile);
    await new Promise((resolve) => {
        const autoCb = el('input', { type: 'checkbox' });
        const body = el('div', {},
            el('p', { class: 'muted', text: `Queued while ${ws.label} was disconnected:` }),
            el('div', { class: 'mono', style: 'max-height:240px; overflow-y:auto; font-size:12px; line-height:1.6' },
                ...lines.slice(0, 15).map((l) => el('div', { text: l })),
                lines.length > 15 ? el('div', { class: 'faint', text: `…and ${lines.length - 15} more` }) : null),
            el('label', { style: 'display:flex; gap:6px; align-items:center; margin-top:10px' },
                autoCb, 'Apply automatically from now on'));
        const done = (fn) => async () => {
            if (autoCb.checked) localStorage.setItem(AUTO_KEY, '1');
            back.remove();
            await fn?.();
            resolve();
        };
        const back = modal(`Apply ${lines.length} offline change${lines.length === 1 ? '' : 's'}?`, body, [
            el('button', { class: 'btn primary', text: 'Apply now', onclick: done(run) }),
            el('button', { class: 'btn', text: 'Later', onclick: done() }),
            el('button', {
                class: 'btn danger', text: 'Discard',
                onclick: done(async () => { clearDirty(ws); toast('Offline changes discarded'); }),
            }),
        ]);
        // Backdrop click = "Later" (modal removes itself; don't hang loadDevice).
        back.addEventListener('click', (e) => { if (e.target === back) resolve(); });
    });
}

/**
 * After a successful real connect, snapshot the device so the next offline
 * session starts from real state (geometry, custom keycodes, keymap).
 * Keeps any still-queued journal entries.
 */
export async function captureSnapshot(app, device) {
    const key = workspaceKey(app.family, device);
    const prev = loadWorkspace(key);
    const ws = prev ?? {
        v: 1, key, family: app.family,
        tunables: {}, qsids: {},
        dirty: { km: {}, enc: {}, tun: {}, qsid: {}, saves: [] },
    };
    ws.source = 'device';
    ws.savedAt = Date.now();
    ws.label = app.profile.name;
    ws.protocolVersion = app.protocolVersion;
    ws.layerCount = app.layerCount;
    ws.profile = app.profile;
    ws.keymap = await app.vial.readKeymap(app.layerCount, app.profile.matrixRows, app.profile.matrixCols);
    const encs = encoderCount(app.profile);
    ws.encoders = [];
    for (let l = 0; l < app.layerCount; l++) {
        const layer = [];
        for (let i = 0; i < encs; i++) layer.push(await app.vial.encoderGet(l, i));
        ws.encoders.push(layer);
    }
    saveWorkspace(ws);
}
