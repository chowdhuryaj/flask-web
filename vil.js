// Vial .vil layout-file interop for the QMK line (Svalboard). Port of
// AdeptCompanion LayoutFile.swift + AppModel.rawTuningDump()/applyTuningDump().
//
// Schema follows vial-gui save_layout/restore_layout. Flask writes INT
// keycodes (vial-gui's restore passes ints through), so files save/load in
// both this app and the Vial GUI. Flask extension keys ride along, invisible
// to vial-gui: "flask_tunings" ("channel.valueID" -> raw u16), "flask_corner"
// ([def, layer, keycode]) and "flask_family". Older files may also carry
// flask_rgbmap / flask_snippets (NLKB16, Svalboard <v18): ignored now.
//
// Import keycode form: ints and "0x..." strings parse; QMK-name strings
// ("KC_A") are skipped and counted (no qmk_id table here).

import { CH_QMK, V_QMK, slot, CSK_SLOTS, SL_SEQS, SL_OUT_POS, CYCLOTAB_KEYS,
         CC, ccRetired } from './flaskproto.js?v=79';
import { QMK_SETTINGS, MacroCodec, KeyOverride } from './vialproto.js?v=79';
import { familyLabel, isQmkFamily } from './boards.js?v=79';
import { isZmkFamily } from './zmk.js?v=79';
import { saveWorkspace, loadWorkspace } from './offline.js?v=79';

const encoderCount = (profile) => profile.encoderKeys.reduce((m, e) => Math.max(m, e.index + 1), 0);

// ---------- tuning dump spec (Svalboard, protocol v27) ----------
// Replayed in THIS order on restore: DPI index ids come before raw-CPI ids
// so a nonzero CPI re-arms raw mode last and wins. Only channels the board
// serves at v27; removed channels (accel, smoothing, wiggle, autoscroll,
// gestures, ball gestures, snippets, teleport) are gone, and a file that
// still carries them just has those keys skipped. Live-only ids (dragHires
// active, nwActive, mbLockMask, diag) and the TOLD board variant stay out.

/** Combo layer-mask slots: what 0x20/0x01 reports, else the firmware's
 * VIAL_COMBO_ENTRIES (keymaps/flask/config.h: 128). */
export const COMBO_MASKS_DEFAULT = 128;
export async function comboMaskCount(flask) {
    const n = await flask.getU16(CH_QMK.comboLayers, V_QMK.clCount).catch(() => null);
    return n > 0 ? n : COMBO_MASKS_DEFAULT;
}

export function dumpSpec(caps = {}, comboMasks = COMBO_MASKS_DEFAULT) {
    const spec = [];
    spec.push([CH_QMK.dpi, [V_QMK.dpiLeft, V_QMK.dpiRight,
        ...(caps.rawCpi ? [V_QMK.dpiLeftCpi, V_QMK.dpiRightCpi] : [])]]);
    spec.push([CH_QMK.dragScroll, [V_QMK.dragDivisor, V_QMK.dragInverted, V_QMK.dragInterval,
        V_QMK.dragMaxNotches, ...(caps.hiresScroll ? [V_QMK.dragHiresMode] : [])]]);
    if (caps.typing) {
        const csk = [V_QMK.cskEnabled];
        for (let s = 0; s < CSK_SLOTS; s++) csk.push(slot.cskKey(s), slot.cskShift(s));
        spec.push([CH_QMK.customShift, csk]);
        spec.push([CH_QMK.selectWord, [V_QMK.selectWordMac]]);
        spec.push([CH_QMK.sentenceCase, [V_QMK.sentenceCaseEnabled]]);
    }
    if (caps.superLeader) {
        const leader = [V_QMK.slTimeout];
        for (let seq = 0; seq < SL_SEQS; seq++)
            for (let pos = 0; pos <= SL_OUT_POS; pos++) leader.push(slot.superLeader(seq, pos));
        spec.push([CH_QMK.leader, leader]);
    }
    if (caps.autoMouse) {
        spec.push([CH_QMK.autoMouse, [V_QMK.amEnabled, V_QMK.amTimeout, V_QMK.amThreshold, V_QMK.amLayer,
            ...(caps.autoMouseSources ? [V_QMK.amSources] : [])]]);
    }
    if (caps.cyclotab) {
        const cyc = [V_QMK.cycEnabled, V_QMK.cycTimeout];
        for (let i = 0; i < CYCLOTAB_KEYS; i++) cyc.push(slot.cyclotabKey(i));
        spec.push([CH_QMK.cyclotab, cyc]);
    }
    if (caps.altRepeatBehaviour) spec.push([CH_QMK.altRepeat, [V_QMK.arepChain, V_QMK.arepStaleMs, V_QMK.arepDefaultOut]]);
    if (caps.mouseButtons) spec.push([CH_QMK.mouseButtons, [V_QMK.mbDoubleGap]]);
    // Geometry is firmware-baked and outputs are payload-addressed (flask_corner).
    if (caps.cornerCombos) spec.push([CH_QMK.corner, [V_QMK.ccEnabled, V_QMK.ccTerm]]);
    if (caps.osShortcuts) spec.push([CH_QMK.os, [V_QMK.osFollow, V_QMK.osMac]]);
    if (caps.numWord) spec.push([CH_QMK.numWord, [V_QMK.nwTimeout, V_QMK.nwLayer]]);
    if (caps.comboLayerMasks) {
        const cl = [];
        for (let i = 0; i < comboMasks; i++) cl.push(slot.comboMask(i));
        spec.push([CH_QMK.comboLayers, cl]);
    }
    return spec;
}

/** Read every tunable the spec names ('ch:id' -> {op, val}); ids the board
 * does not serve are skipped. */
export async function readTunings(app, flask = app.flask) {
    const out = {};
    let asked = 0;
    const masks = app.caps.comboLayerMasks ? await comboMaskCount(flask) : 0;
    for (const [ch, ids] of dumpSpec(app.caps, masks)) {
        for (const id of ids) {
            asked++;
            try { out[`${ch}:${id}`] = { op: 'u16', val: await flask.getU16(ch, id) }; }
            catch { /* id not served */ }
        }
    }
    Object.defineProperty(out, 'asked', { value: asked });   // non-enumerable: callers spread/iterate `out`
    return out;
}

/** Refresh the Svalboard's Unplugged workspace (tunables journal only) from
 * the connected board. Keeps anything still queued. */
export async function snapshotQmkWorkspace(app) {
    // Pin the connection: an unplug or a reconnect (to another board) during
    // the ~240 background GETs must not write an empty or foreign snapshot.
    const { flask, family } = app;
    if (!isQmkFamily(family) || !app.caps.flask) return;
    const tunables = await readTunings(app, flask);
    // A plain unplug replaces neither app.flask nor app.family: the read fails into
    // the catches above, so also require a live link and a complete read.
    if (app.flask !== flask || app.family !== family || !app.hid?.connected) return;
    if (Object.keys(tunables).length < tunables.asked) return;
    const prev = loadWorkspace(family);
    const ws = prev ?? { v: 1, key: family, family, dirty: { tun: {}, rgb: {}, saves: [] } };
    Object.assign(ws, {
        label: familyLabel(family), source: 'device', savedAt: Date.now(),
        protocolVersion: app.protocolVersion, layerCount: app.layerCount,
        // Queued values win over the fresh read until they replay.
        tunables: { ...tunables, ...Object.fromEntries(Object.entries(ws.dirty?.tun ?? {})) },
    });
    saveWorkspace(ws);
}

const QSID_WIDTH = Object.fromEntries(QMK_SETTINGS.map((d) => [d.qsid, d.width]));

// ---------- export ----------

export async function exportVil(app) {
    const rows = app.profile.matrixRows, cols = app.profile.matrixCols;
    const keymap = app.keymap ?? await app.vial.readKeymap(app.layerCount, rows, cols);
    const encs = (app.profile.encoderKeys?.length ? encoderCount(app.profile) : 0);
    const encoders = [];
    for (let l = 0; l < app.layerCount; l++) {
        const layer = [];
        for (let i = 0; i < encs; i++) {
            const e = await app.vial.encoderGet(l, i);
            layer.push([e.ccw, e.cw]);
        }
        encoders.push(layer);
    }

    const data = {
        version: 1,
        uid: 0,
        layout: keymap,
        // Per-layer shape even with no encoders — vial-gui's restore loop
        // trips otherwise.
        encoder_layout: encoders.length && encs ? encoders : keymap.map(() => []),
        layout_options: -1,
        vial_protocol: app.vialVersion ?? 6,
        via_protocol: app.viaVersion ?? 9,
        // Flask extension: which board family wrote this, so an Adept file
        // is refused on a Svalboard (vial-gui ignores unknown keys).
        flask_family: app.family ?? 'generic',
    };

    // QMK settings (supported ∩ catalog).
    const settings = {};
    try {
        for (const qsid of await app.vial.qmkSettingsQSIDs()) {
            const width = QSID_WIDTH[qsid];
            if (!width) continue;
            try { settings[String(qsid)] = await app.vial.qmkSettingGet(qsid, width); } catch { /* skip */ }
        }
    } catch { /* plain boards without settings */ }
    data.settings = settings;

    // Dynamic entries.
    try {
        const counts = await app.vial.dynamicEntryCounts();
        const td = [], combo = [], ko = [], ar = [];
        for (let i = 0; i < counts.tapDance; i++) {
            const e = await app.vial.tapDanceGet(i);
            td.push([e.onTap, e.onHold, e.onDoubleTap, e.onTapHold, e.tappingTerm]);
        }
        for (let i = 0; i < counts.combo; i++) {
            const e = await app.vial.comboGet(i);
            combo.push([...e.inputs, e.output]);
        }
        for (let i = 0; i < counts.keyOverride; i++) {
            const e = await app.vial.keyOverrideGet(i);
            ko.push({ trigger: e.trigger, replacement: e.replacement, layers: e.layers,
                trigger_mods: e.triggerMods, negative_mod_mask: e.negativeModMask,
                suppressed_mods: e.suppressedMods, options: e.options });
        }
        for (let i = 0; i < counts.altRepeat; i++) {
            const e = await app.vial.altRepeatGet(i);
            ar.push({ keycode: e.keycode, alt_keycode: e.altKeycode,
                allowed_mods: e.allowedMods, options: e.options });
        }
        data.tap_dance = td; data.combo = combo;
        data.key_override = ko; data.alt_repeat_key = ar;
    } catch { /* very old vial — leave lists out */ }

    // Macros.
    try {
        const count = await app.vial.macroCount();
        const size = await app.vial.macroBufferSize();
        const macros = MacroCodec.decode(await app.vial.readMacroBuffer(size), count);
        data.macro = macros.map((m) => m.map((a) =>
            a.t === 'text' ? ['text', a.s]
            : a.t === 'delay' ? ['delay', a.ms]
            : [a.t, a.kc]));
    } catch { /* no macro support */ }

    // Flask tunings: offline dumps the journal/snapshot (reading would
    // return zeros for untouched values); online sweeps the spec — ids the
    // firmware doesn't serve just fail and are skipped, like the Swift app.
    const tunings = {};
    if (app.offline) {
        for (const [k, t] of Object.entries(app.offlineWs?.tunables ?? {}))
            tunings[k.replace(':', '.')] = t.val;
    } else if (app.caps.flask) {
        const masks = app.caps.comboLayerMasks ? await comboMaskCount(app.flask) : 0;
        for (const [ch, ids] of dumpSpec(app.caps, masks)) {
            for (const id of ids) {
                try { tunings[`${ch}.${id}`] = await app.flask.getU16(ch, id); }
                catch { /* id not served */ }
            }
        }
    }
    if (Object.keys(tunings).length) data.flask_tunings = tunings;

    // Corner-chord outputs as [def, layer, keycode] triples. Universal since
    // v19 (one binding per chord, layer byte ignored): one triple per bound
    // live chord, layer 0. Retired defs (48-59) are never exported.
    if (app.caps.cornerCombos && !app.offline) {
        try {
            const defCount = await app.flask.getU16(CH_QMK.corner, V_QMK.ccDefCount);
            const outputs = [];
            for (let def = 0; def < defCount; def++) {
                if (ccRetired(def)) continue;
                const r = await app.flask.getBytes(CH_QMK.corner, V_QMK.ccOut, [def, 0], 2);
                const kc = ((r[2] ?? 0) << 8) | (r[3] ?? 0);
                if (kc) outputs.push([def, 0, kc]);
            }
            if (outputs.length) data.flask_corner = outputs;
        } catch { /* leave out */ }
    }

    // NOTE: no replacer array here — a key-list replacer filters keys at
    // EVERY depth, which emptied key_override entries and flask_tunings.
    return JSON.stringify(data, null, 1);
}

// ---------- import ----------

function kcOf(any, stats) {
    if (typeof any === 'number') return any >= 0 && any <= 0xFFFF ? any : null;
    if (typeof any === 'string' && any.toLowerCase().startsWith('0x')) {
        const v = parseInt(any.slice(2), 16);
        return Number.isFinite(v) && v <= 0xFFFF ? v : null;
    }
    if (any != null && any !== -1 && stats) stats.skipped++;
    return null;
}

/** Applies a parsed .vil onto the current device/workspace via app.vial /
 *  app.flask — the exact same paths the tabs use, so offline mode journals
 *  everything automatically. Returns a summary. */
export async function importVil(app, text) {
    const json = JSON.parse(text);
    if (!Array.isArray(json.layout)) throw new Error('not a .vil file (no layout)');
    const stats = { applied: 0, skipped: 0, notes: [] };
    const fam = app.family ?? 'generic';
    if (typeof json.flask_family === 'string' && json.flask_family !== fam) {
        throw new Error(`this file is for a ${familyLabel(json.flask_family) ?? json.flask_family}, not a ${familyLabel(fam) ?? fam}; nothing was changed`);
    }
    if (json.flask_family == null) {
        stats.notes.push('file has no keyboard family (older export), so check it came from this board');
    }

    // Keymap — only slots that parse; shape-clamped to the device.
    const rows = app.profile.matrixRows, cols = app.profile.matrixCols;
    for (let l = 0; l < Math.min(json.layout.length, app.layerCount); l++) {
        for (let r = 0; r < Math.min(json.layout[l]?.length ?? 0, rows); r++) {
            for (let c = 0; c < Math.min(json.layout[l][r]?.length ?? 0, cols); c++) {
                const kc = kcOf(json.layout[l][r][c], stats);
                if (kc == null) continue;
                await app.vial.setKeycode(l, r, c, kc);
                if (app.keymap?.[l]?.[r]) app.keymap[l][r][c] = kc;
                stats.applied++;
            }
        }
    }

    // Encoders — [layer][encoder][ccw, cw].
    const encs = (app.profile.encoderKeys?.length ? encoderCount(app.profile) : 0);
    if (Array.isArray(json.encoder_layout) && encs) {
        for (let l = 0; l < Math.min(json.encoder_layout.length, app.layerCount); l++) {
            for (let i = 0; i < Math.min(json.encoder_layout[l]?.length ?? 0, encs); i++) {
                const pair = json.encoder_layout[l][i];
                for (const cw of [0, 1]) {
                    const kc = kcOf(pair?.[cw], stats);
                    if (kc == null) continue;
                    await app.vial.encoderSet(l, i, !!cw, kc);
                    stats.applied++;
                }
            }
        }
    }

    // Dynamic entries.
    let counts = null;
    try { counts = await app.vial.dynamicEntryCounts(); } catch { /* none */ }
    if (counts) {
        const tds = json.tap_dance ?? [];
        for (let i = 0; i < Math.min(tds.length, counts.tapDance); i++) {
            const t = tds[i];
            if (!Array.isArray(t) || t.length < 5) continue;
            const kcs = t.slice(0, 4).map((x) => kcOf(x, stats));
            if (kcs.some((k) => k == null)) continue;
            await app.vial.tapDanceSet(i, {
                onTap: kcs[0], onHold: kcs[1], onDoubleTap: kcs[2], onTapHold: kcs[3],
                tappingTerm: Number(t[4]) || 200,
            });
            stats.applied++;
        }
        const combos = json.combo ?? [];
        for (let i = 0; i < Math.min(combos.length, counts.combo); i++) {
            const t = combos[i];
            if (!Array.isArray(t) || t.length < 5) continue;
            const kcs = t.slice(0, 5).map((x) => kcOf(x, stats));
            if (kcs.some((k) => k == null)) continue;
            await app.vial.comboSet(i, { inputs: kcs.slice(0, 4), output: kcs[4] });
            stats.applied++;
        }
        const kos = json.key_override ?? [];
        for (let i = 0; i < Math.min(kos.length, counts.keyOverride); i++) {
            const t = kos[i];
            const trigger = kcOf(t?.trigger, stats), replacement = kcOf(t?.replacement, stats);
            if (trigger == null || replacement == null) continue;
            await app.vial.keyOverrideSet(i, {
                trigger, replacement,
                layers: (t.layers ?? 0xFFFF) & 0xFFFF,
                triggerMods: (t.trigger_mods ?? 0) & 0xFF,
                negativeModMask: (t.negative_mod_mask ?? 0) & 0xFF,
                suppressedMods: (t.suppressed_mods ?? 0) & 0xFF,
                options: (t.options ?? KeyOverride.defaultOptions) & 0xFF,
            });
            stats.applied++;
        }
        const ars = json.alt_repeat_key ?? [];
        for (let i = 0; i < Math.min(ars.length, counts.altRepeat); i++) {
            const t = ars[i];
            const keycode = kcOf(t?.keycode, stats), alt = kcOf(t?.alt_keycode, stats);
            if (keycode == null || alt == null) continue;
            await app.vial.altRepeatSet(i, {
                keycode, altKeycode: alt,
                allowedMods: (t.allowed_mods ?? 0) & 0xFF,
                options: (t.options ?? 0) & 0xFF,
            });
            stats.applied++;
        }
    }

    // Macros — unlock-gated on a live device.
    if (Array.isArray(json.macro)) {
        const list = json.macro.map((m) => (Array.isArray(m) ? m : []).flatMap((a) => {
            const [tag, ...rest] = a;
            if (tag === 'text' && typeof rest[0] === 'string') return [{ t: 'text', s: rest[0] }];
            if (tag === 'delay' && typeof rest[0] === 'number') return [{ t: 'delay', ms: rest[0] }];
            if (tag === 'tap' || tag === 'down' || tag === 'up') {
                // vial-gui packs whole key sequences into one action — expand.
                return rest.map((slotKc) => {
                    const kc = kcOf(slotKc, stats);
                    return kc == null ? null : { t: tag, kc };
                }).filter(Boolean);
            }
            return [];
        }));
        if (!app.offline && !app.unlocked) {
            stats.notes.push('macros skipped — keyboard locked');
        } else {
            const img = MacroCodec.encode(list);
            const size = await app.vial.macroBufferSize();
            if (img && img.length <= size) {
                await app.vial.writeMacroBuffer(img, size);
                stats.applied++;
            } else {
                stats.notes.push('macros skipped — too big or unencodable');
            }
        }
    }

    // QMK settings.
    for (const [key, value] of Object.entries(json.settings ?? {})) {
        const qsid = Number(key), width = QSID_WIDTH[qsid];
        if (!width || typeof value !== 'number') continue;
        try { await app.vial.qmkSettingSet(qsid, width, value >>> 0); stats.applied++; }
        catch { /* unsupported here */ }
    }

    // Flask tunings — spec order (DPI re-arm rule), then persist per channel.
    const tunings = json.flask_tunings ?? {};
    if (Object.keys(tunings).length && (app.caps.flask || app.offline)) {
        const touched = new Set();
        for (const [ch, ids] of dumpSpec(app.caps)) {
            for (const id of ids) {
                const value = tunings[`${ch}.${id}`];
                if (typeof value !== 'number') continue;
                try {
                    await app.flask.setU16(ch, id, value);
                    touched.add(ch);
                    stats.applied++;
                } catch { /* id not served */ }
            }
        }
        // NEVER save the corner channel. Its SETs persist themselves, and a
        // channel save writes the whole ~1.9 KB corner block — on the RP2040
        // that window (flash writes run with XIP disabled) hard-wedged the
        // board on 2026-08-14. Same rule as corner-tab.js.
        touched.delete(CH_QMK.corner);
        for (const ch of touched) { try { await app.flask.save(ch); } catch { /* no-op */ } }
    }

    // Corner-chord outputs. A file written by pre-v19 per-layer firmware can
    // carry several rows for one chord; universal firmware keeps one binding,
    // so take the LOWEST layer's row (the old inheritance base).
    if (Array.isArray(json.flask_corner) && app.caps.cornerCombos && !app.offline) {
        const lowest = new Map();
        for (const e of json.flask_corner) {
            if (!Array.isArray(e) || e.length < 3) continue;
            const [def, layer] = [Number(e[0]), Number(e[1])];
            const prev = lowest.get(def);
            if (!prev || layer < Number(prev[1])) lowest.set(def, e);
        }
        for (const entry of lowest.values()) {
            if (!Array.isArray(entry) || entry.length < 3) continue;
            const [def, layer, kc] = entry.map(Number);
            if (!Number.isFinite(def) || def >= CC.total || ccRetired(def) || layer > 15) continue;
            try {
                // No save — the SET persists this entry itself (see above).
                await app.flask.setBytes(CH_QMK.corner, V_QMK.ccOut,
                    [def, layer, (kc >> 8) & 0xFF, kc & 0xFF], 2);
                stats.applied++;
            } catch { /* def not served */ }
        }
    }

    return stats;
}

// ---------- file helpers ----------

export function downloadText(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---------- top bar "Save layout" / "Load" ----------
// One pair of buttons, two file formats: .vil (QMK) and the ZMK keymap JSON v2
// (the ZMK keymap tab names, downloads and imports its own file).

/** Which file format the connected (or offline) board speaks. */
export function layoutLine(app) {
    return isZmkFamily(app.profile?.family ?? app.family) ? 'zmk' : 'qmk';
}

/** Save layout. Returns {line, filename|null}. Throws on failure. */
export async function saveLayoutFile(app) {
    const line = layoutLine(app);
    if (line === 'qmk') {
        if (!app.vial) throw new Error('a .vil needs the keyboard connected (Unplugged has no keymap)');
        const text = await exportVil(app);
        const filename = `${(app.profile?.name ?? 'layout').replace(/[^\w-]+/g, '_')}.vil`;
        downloadText(filename, text);
        return { line, filename };
    }
    const { zmkLiveKeymapTab } = await import('./zmk-keymap-tab.js?v=79');
    const kt = zmkLiveKeymapTab();
    if (!kt?.keymap) throw new Error('the keymap is still loading');
    await kt.exportKeymap();
    return { line, filename: null };
}

/** Load. Returns {line, message, warn}; message is null when the target
 * module already toasted (ZMK). Throws on failure. */
export async function loadLayoutFile(app, file) {
    const line = layoutLine(app);
    if (line === 'qmk') {
        if (!app.vial) throw new Error('a .vil needs the keyboard connected (Unplugged has no keymap)');
        const stats = await importVil(app, await file.text());
        let message = `Applied ${stats.applied} items`;
        if (stats.skipped) message += `, ${stats.skipped} named keycodes skipped`;
        if (stats.notes.length) message += ` — ${stats.notes.join('; ')}`;
        return { line, message, warn: stats.notes.length > 0 };
    }
    const { zmkLiveKeymapTab } = await import('./zmk-keymap-tab.js?v=79');
    const kt = zmkLiveKeymapTab();
    if (!kt?.keymap) throw new Error('the keymap is still loading');
    await kt.importKeymap(file);
    return { line, message: null, warn: false };
}
