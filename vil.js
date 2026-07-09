// Vial .vil layout-file interop. Port of AdeptCompanion LayoutFile.swift +
// AppModel.rawTuningDump()/applyTuningDump().
//
// Schema follows vial-gui save_layout/restore_layout. Flask writes INT
// keycodes (vial-gui's restore passes ints through), so files save/load in
// both this app and the Vial GUI. Two Flask extension keys ride along,
// invisible to vial-gui: "flask_tunings" ("channel.valueID" → raw u16) and
// "flask_rgbmap" ([layer][led][h,s,v]). This is the NLKB16
// bootloader-erase restore path — don't rename the keys.
//
// Import keycode form: ints and "0x…" strings parse; QMK-name strings
// ("KC_A") are skipped and counted (no qmk_id table here).

import { CH, V, slot, GESTURE_SETS, CSK_SLOTS, LEADER_SEQS, LEADER_KEYS,
         WC_BUTTONS, NLKB } from './flaskproto.js?v=6';
import { QMK_SETTINGS, MacroCodec, TapDance, Combo, KeyOverride, AltRepeat } from './vialproto.js?v=6';
import { encoderCount } from './profiles.js?v=6';

// ---------- tuning dump spec (mirrors AppModel.tuningDumpSpec) ----------
// Replayed in THIS order on restore: DPI index ids come before raw-CPI ids
// so a nonzero CPI re-arms raw mode last and wins.

function dumpSpec() {
    const spec = [];
    spec.push([CH.accel, [1, 2, 3, 4, 5]]);
    const gestures = [V.gesturesRatchetStep];
    for (let set = 0; set < GESTURE_SETS; set++)
        for (let dir = 0; dir < 8; dir++) gestures.push(slot.gesture(set, dir));
    spec.push([CH.gestures, gestures]);
    spec.push([CH.wiggle, [1, 2, 3, 4, 5, 6, 7]]);
    spec.push([CH.smoothing, [1, 2, 3]]);
    spec.push([CH.dpi, [V.dpiIndex, V.svalDpiLeft, V.svalDpiRight, V.dpiCpi, V.svalDpiLeftCpi, V.svalDpiRightCpi]]);
    spec.push([CH.dragScroll, [V.dragDivH, V.dragDivV, V.dragInverted, V.dragInterval, V.dragMaxNotches]]);
    const csk = [V.cskEnabled];
    for (let s = 0; s < CSK_SLOTS; s++) csk.push(slot.cskKey(s), slot.cskShift(s));
    spec.push([CH.customShift, csk]);
    spec.push([CH.selectWord, [V.selectWordMac]]);
    spec.push([CH.sentenceCase, [V.sentenceCaseEnabled]]);
    const leader = [V.leaderTimeout];
    for (let seq = 0; seq < LEADER_SEQS; seq++)
        for (let pos = 0; pos <= LEADER_KEYS; pos++) leader.push(slot.leader(seq, pos));
    spec.push([CH.leader, leader]);
    spec.push([CH.autoscroll, [V.asInverted, V.asSpeedScale, V.asDeadzone, V.asRange, V.asStopOnKey]]);
    spec.push([CH.autoMouse, [V.amEnabled, V.amTimeout, V.amThreshold, V.amLayer]]);
    const chords = [V.wcEnabled, V.wcStep, V.wcHoldMs];
    for (let b = 0; b < WC_BUTTONS; b++)
        for (let d = 0; d < 8; d++) chords.push(slot.wheelChord(b, d));
    spec.push([CH.wheelChords, chords]);
    spec.push([CH.os, [V.osFollow, V.osMac]]);
    spec.push([CH.numWord, [V.nwTimeout, V.nwLayer]]);
    const cl = [];
    for (let i = 0; i < 64; i++) cl.push(slot.comboMask(i));
    spec.push([CH.comboLayers, cl]);
    spec.push([CH.rgbMap, [V.rgbmapEnabled]]);
    const disp = [V.dispHoldMs, V.dispSleepS, V.dispOverlayMs];
    for (let line = 0; line < NLKB.bigLines; line++) disp.push(slot.dispWidget(line));
    spec.push([CH.display, disp]);
    return spec;
}

const QSID_WIDTH = Object.fromEntries(QMK_SETTINGS.map((d) => [d.qsid, d.width]));

// ---------- export ----------

export async function exportVil(app) {
    const rows = app.profile.matrixRows, cols = app.profile.matrixCols;
    const keymap = app.keymap ?? await app.vial.readKeymap(app.layerCount, rows, cols);
    const encs = encoderCount(app.profile);
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
        for (const [ch, ids] of dumpSpec()) {
            for (const id of ids) {
                try { tunings[`${ch}.${id}`] = await app.flask.getU16(ch, id); }
                catch { /* id not served */ }
            }
        }
    }
    if (Object.keys(tunings).length) data.flask_tunings = tunings;

    // RGB map (NLKB16).
    if (app.caps.rgbMap) {
        try {
            const map = [];
            for (let layer = 0; layer < NLKB.rgbLayers; layer++) {
                const leds = [];
                for (let led = 0; led < NLKB.ledCount; led++) {
                    const r = await app.flask.getBytes(CH.rgbMap, V.rgbmapLed, [layer, led]);
                    leds.push([r[2] ?? 0, r[3] ?? 0, r[4] ?? 0]);
                }
                map.push(leds);
            }
            data.flask_rgbmap = map;
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
    const encs = encoderCount(app.profile);
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
        for (const [ch, ids] of dumpSpec()) {
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
        for (const ch of touched) { try { await app.flask.save(ch); } catch { /* no-op */ } }
    }

    // RGB map.
    if (Array.isArray(json.flask_rgbmap) && (app.caps.rgbMap || app.offline)) {
        let any = false;
        for (let layer = 0; layer < Math.min(json.flask_rgbmap.length, NLKB.rgbLayers); layer++) {
            const leds = json.flask_rgbmap[layer] ?? [];
            for (let led = 0; led < Math.min(leds.length, NLKB.ledCount); led++) {
                const hsv = leds[led];
                if (!Array.isArray(hsv) || hsv.length < 3) continue;
                try {
                    await app.flask.setBytes(CH.rgbMap, V.rgbmapLed,
                        [layer, led, hsv[0] & 0xFF, hsv[1] & 0xFF, hsv[2] & 0xFF]);
                    any = true;
                    stats.applied++;
                } catch { /* not served */ }
            }
        }
        if (any) { try { await app.flask.save(CH.rgbMap); } catch { /* no-op */ } }
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
