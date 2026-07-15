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

import { el, modal, toast } from './ui.js?v=15';
import { CH, V, EXPECTED_PROTOCOL, NLKB } from './flaskproto.js?v=15';
import { QMK_SETTINGS, MacroCodec, TapDance, Combo, KeyOverride, AltRepeat } from './vialproto.js?v=15';
import { buildProfile, familyLabel, keyName, encoderCount } from './profiles.js?v=15';
import { describe } from './keycodes.js?v=15';

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
    `${CH.display}:7`,      // raw panel cmd inject
    `${CH.display}:8`,      // panel re-init
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
        return raw ? normalize(JSON.parse(raw)) : null;
    } catch { return null; }
}

/** Fill fields older stored workspaces don't have (append-only schema). */
function normalize(ws) {
    ws.dirty ??= {};
    const d = ws.dirty;
    for (const k of ['km', 'enc', 'tun', 'qsid', 'td', 'combo', 'ko', 'ar', 'rgb', 'dispText']) d[k] ??= {};
    d.saves ??= [];
    d.macros ??= false;
    ws.tunables ??= {};
    ws.qsids ??= {};
    ws.entries ??= { counts: { tapDance: 32, combo: 32, keyOverride: 32, altRepeat: 0 }, td: {}, combo: {}, ko: {}, ar: {} };
    ws.macros ??= { count: 16, bufferSize: 900, list: null };
    ws.rgbmap ??= null;   // [8][23][h,s,v], created on first paint
    ws.dispText ??= {};
    return ws;
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
        + Object.keys(d.tun).length + Object.keys(d.qsid).length
        + Object.keys(d.td).length + Object.keys(d.combo).length
        + Object.keys(d.ko).length + Object.keys(d.ar).length
        + Object.keys(d.rgb).length + Object.keys(d.dispText).length
        + (d.macros ? 1 : 0);
}

export function clearDirty(ws) {
    ws.dirty = {};
    normalize(ws);
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
    return normalize({
        v: 1, key: family, family, label: familyLabel(family),
        source: 'template', savedAt: Date.now(),
        protocolVersion: EXPECTED_PROTOCOL[family] ?? null,
        layerCount: t.layers, profile, keymap, encoders,
    });
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

    // Payload-addressed ops: RGB paints and display custom text journal;
    // pushes/raw-cmd/reinit are transient live actions and drop offline.
    async getBytes(ch, id, payload = []) {
        if (ch === CH.rgbMap && id === V.rgbmapLed) {
            const [layer, led] = payload;
            const hsv = this.ws.rgbmap?.[layer]?.[led] ?? [0, 0, 0];
            return [layer, led, ...hsv];
        }
        if (ch === CH.display && id >= 0x30 && id <= 0x33) {
            return [...new TextEncoder().encode(this.ws.dispText[id - 0x30] ?? '')];
        }
        return new Array(29).fill(0);
    }

    async setBytes(ch, id, payload) {
        if (ch === CH.rgbMap) {
            const put = (layer, led, h, s, v) => {
                this.ws.rgbmap ??= Array.from({ length: NLKB.rgbLayers },
                    () => Array.from({ length: NLKB.ledCount }, () => [0, 0, 0]));
                this.ws.rgbmap[layer][led] = [h, s, v];
                this.ws.dirty.rgb[`${layer},${led}`] = [h, s, v];
            };
            if (id === V.rgbmapLed) {
                put(payload[0], payload[1], payload[2], payload[3], payload[4]);
            } else if (id === V.rgbmapFill) {
                for (let led = 0; led < NLKB.ledCount; led++)
                    put(payload[0], led, payload[1], payload[2], payload[3]);
            } else if (id === V.rgbmapBulk) {
                const [layer, start, count] = payload;
                for (let k = 0; k < count; k++)
                    put(layer, start + k, payload[3 + k * 3], payload[4 + k * 3], payload[5 + k * 3]);
            } else return;
            saveWorkspace(this.ws);
            return;
        }
        if (ch === CH.display && id >= 0x30 && id <= 0x33) {
            this.ws.dispText[id - 0x30] =
                new TextDecoder().decode(new Uint8Array(payload)).replace(/\0+$/, '');
            this.ws.dirty.dispText[id - 0x30] = true;
            saveWorkspace(this.ws);
        }
    }

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

    // ---- dynamic entries (tap dance / combos / key overrides / alt-repeat) ----

    async dynamicEntryCounts() { return { ...this.ws.entries.counts }; }

    _entrySet(kind, i, entry) {
        this.ws.entries[kind][i] = entry;
        this.ws.dirty[kind][i] = true;
        saveWorkspace(this.ws);
    }

    async tapDanceGet(i) { return this.ws.entries.td[i] ?? TapDance.empty(); }
    async tapDanceSet(i, e) { this._entrySet('td', i, e); }
    async comboGet(i) { return this.ws.entries.combo[i] ?? Combo.empty(); }
    async comboSet(i, e) { this._entrySet('combo', i, e); }
    async keyOverrideGet(i) { return this.ws.entries.ko[i] ?? KeyOverride.empty(); }
    async keyOverrideSet(i, e) { this._entrySet('ko', i, e); }
    async altRepeatGet(i) { return this.ws.entries.ar[i] ?? AltRepeat.empty(); }
    async altRepeatSet(i, e) { this._entrySet('ar', i, e); }

    // ---- macros: stored decoded; the codec round-trips at the edges ----

    async macroCount() { return this.ws.macros.count; }
    async macroBufferSize() { return this.ws.macros.bufferSize; }

    async readMacroBuffer(size) {
        const img = this.ws.macros.list ? (MacroCodec.encode(this.ws.macros.list) ?? []) : [];
        while (img.length < size) img.push(0);
        return img.slice(0, size);
    }

    async writeMacroBuffer(buffer) {
        this.ws.macros.list = MacroCodec.decode(buffer, this.ws.macros.count);
        this.ws.dirty.macros = true;
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
    for (const i of Object.keys(ws.dirty.td)) lines.push(`Tap dance ${i} → ${describe(ws.entries.td[i]?.onTap ?? 0)}…`);
    for (const i of Object.keys(ws.dirty.combo)) lines.push(`Combo ${i} → ${describe(ws.entries.combo[i]?.output ?? 0)}`);
    for (const i of Object.keys(ws.dirty.ko)) lines.push(`Key override ${i}: ${describe(ws.entries.ko[i]?.trigger ?? 0)} → ${describe(ws.entries.ko[i]?.replacement ?? 0)}`);
    for (const i of Object.keys(ws.dirty.ar)) lines.push(`Alt-repeat ${i}`);
    if (ws.dirty.macros) lines.push('Macros (whole buffer — needs unlock)');
    for (const k of Object.keys(ws.dirty.rgb)) {
        const [l, led] = k.split(',');
        lines.push(`RGB L${l} led ${led} = hsv(${ws.dirty.rgb[k].join(',')})`);
    }
    for (const line of Object.keys(ws.dirty.dispText)) lines.push(`Display line ${line} text "${ws.dispText[line] ?? ''}"`);
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

    // Dynamic entries (any Vial board).
    const entryKinds = [
        ['td', 'tap dance', (i, e) => app.vial.tapDanceSet(i, e)],
        ['combo', 'combo', (i, e) => app.vial.comboSet(i, e)],
        ['ko', 'key override', (i, e) => app.vial.keyOverrideSet(i, e)],
        ['ar', 'alt-repeat', (i, e) => app.vial.altRepeatSet(i, e)],
    ];
    for (const [kind, name, set] of entryKinds) {
        for (const i of Object.keys(ws.dirty[kind])) {
            try {
                await set(Number(i), ws.entries[kind][i]);
                delete ws.dirty[kind][i]; applied++;
            } catch (e) { fail.push(`${name} ${i}: ${e.message}`); }
        }
    }

    // Macros — unlock-gated; firmware silently ignores writes while locked,
    // so verify by re-reading and keep queued on mismatch.
    if (ws.dirty.macros && ws.macros.list) {
        try {
            if (!app.unlocked) throw new Error('keyboard locked — unlock, then replug');
            const size = await app.vial.macroBufferSize();
            const img = MacroCodec.encode(ws.macros.list);
            if (!img) throw new Error('a macro keycode cannot be encoded');
            if (img.length > size) throw new Error(`macros too big (${img.length} > ${size} bytes)`);
            await app.vial.writeMacroBuffer(img, size);
            const back = await app.vial.readMacroBuffer(Math.min(img.length, size));
            if (!img.every((b, i) => back[i] === b)) throw new Error('verify failed (still locked?)');
            ws.dirty.macros = false; applied++;
        } catch (e) { fail.push(`macros: ${e.message}`); }
    }

    // RGB map paints + display custom text (payload-addressed).
    let rgbTouched = false;
    for (const [k, hsv] of Object.entries(ws.dirty.rgb)) {
        const [l, led] = k.split(',').map(Number);
        try {
            await app.flask.setBytes(CH.rgbMap, V.rgbmapLed, [l, led, ...hsv]);
            delete ws.dirty.rgb[k]; applied++; rgbTouched = true;
        } catch (e) { fail.push(`rgb ${k}: ${e.message}`); }
    }
    if (rgbTouched) { try { await app.flask.save(CH.rgbMap); } catch { /* no-op */ } }
    let dispTouched = false;
    for (const line of Object.keys(ws.dirty.dispText)) {
        try {
            await app.flask.setBytes(CH.display, 0x30 + Number(line),
                [...new TextEncoder().encode(ws.dispText[line] ?? '')]);
            delete ws.dirty.dispText[line]; applied++; dispTouched = true;
        } catch (e) { fail.push(`display line ${line}: ${e.message}`); }
    }
    if (dispTouched) { try { await app.flask.save(CH.display); } catch { /* no-op */ } }

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
    normalize(ws);

    // Dynamic entries + macros (any Vial board). Indices still dirty (a
    // failed sync) keep their queued values — don't clobber desired state.
    try {
        const counts = await app.vial.dynamicEntryCounts();
        const ent = { counts, td: {}, combo: {}, ko: {}, ar: {} };
        const kinds = [
            ['td', counts.tapDance, (i) => app.vial.tapDanceGet(i), TapDance.isEmpty],
            ['combo', counts.combo, (i) => app.vial.comboGet(i), Combo.isEmpty],
            ['ko', counts.keyOverride, (i) => app.vial.keyOverrideGet(i), KeyOverride.isEmpty],
            ['ar', counts.altRepeat, (i) => app.vial.altRepeatGet(i), AltRepeat.isEmpty],
        ];
        for (const [kind, count, get, isEmpty] of kinds) {
            for (let i = 0; i < count; i++) {
                if (ws.dirty[kind][i]) { ent[kind][i] = ws.entries[kind][i]; continue; }
                const e = await get(i);
                if (!isEmpty(e)) ent[kind][i] = e;
            }
        }
        ws.entries = ent;
    } catch (e) { console.warn('entry snapshot failed:', e); }
    try {
        if (!ws.dirty.macros) {
            const count = await app.vial.macroCount();
            const bufferSize = await app.vial.macroBufferSize();
            ws.macros = { count, bufferSize,
                list: MacroCodec.decode(await app.vial.readMacroBuffer(bufferSize), count) };
        }
    } catch (e) { console.warn('macro snapshot failed:', e); }

    saveWorkspace(ws);
}
