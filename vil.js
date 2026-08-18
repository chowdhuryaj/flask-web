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
         WC_BUTTONS, NLKB, SL_SEQS, SL_OUT_POS, SNIPPET_COUNT, SNIPPET_KEYS,
         CYCLOTAB_KEYS, TELEPORT_TARGETS, CC } from './flaskproto.js?v=45';
import { QMK_SETTINGS, MacroCodec, TapDance, Combo, KeyOverride, AltRepeat } from './vialproto.js?v=45';
import { encoderCount } from './profiles.js?v=45';

// ---------- tuning dump spec (mirrors AppModel.tuningDumpSpec) ----------
// Replayed in THIS order on restore: DPI index ids come before raw-CPI ids
// so a nonzero CPI re-arms raw mode last and wins.

function dumpSpec(caps = {}) {
    const spec = [];
    spec.push([CH.accel, [1, 2, 3, 4, 5]]);
    const gestures = [V.gesturesRatchetStep];
    for (let set = 0; set < GESTURE_SETS; set++)
        for (let dir = 0; dir < 8; dir++) gestures.push(slot.gesture(set, dir));
    spec.push([CH.gestures, gestures]);
    spec.push([CH.wiggle, [1, 2, 3, 4, 5, 6, 7]]);
    spec.push([CH.smoothing, [1, 2, 3]]);
    spec.push([CH.dpi, [V.dpiIndex, V.svalDpiLeft, V.svalDpiRight, V.dpiCpi, V.svalDpiLeftCpi, V.svalDpiRightCpi]]);
    // dragHiresMode rides here too: it is a persisted per-host preference, and
    // a .vil restored after a reflash should not silently drop it back to the
    // default. The live-only ids (dragActive, dragHiresActive) stay out.
    spec.push([CH.dragScroll, [V.dragDivH, V.dragDivV, V.dragInverted, V.dragInterval,
        V.dragMaxNotches, ...(caps.hiresScroll ? [V.dragHiresMode] : [])]]);
    const csk = [V.cskEnabled];
    for (let s = 0; s < CSK_SLOTS; s++) csk.push(slot.cskKey(s), slot.cskShift(s));
    spec.push([CH.customShift, csk]);
    spec.push([CH.selectWord, [V.selectWordMac]]);
    spec.push([CH.sentenceCase, [V.sentenceCaseEnabled]]);
    // Leader: one channel, two shapes. Super Leader is 16 sequences of 7 slots
    // (5 keys + kind + output); the original is 8 of 6 (5 keys + output). Dump
    // the shape the DEVICE serves — sweeping the wider one on an 8-sequence
    // board would carry ids it answers with garbage rather than a failure.
    const leader = [V.leaderTimeout];
    if (caps.superLeader) {
        for (let seq = 0; seq < SL_SEQS; seq++)
            for (let pos = 0; pos <= SL_OUT_POS; pos++) leader.push(slot.superLeader(seq, pos));
    } else {
        for (let seq = 0; seq < LEADER_SEQS; seq++)
            for (let pos = 0; pos <= LEADER_KEYS; pos++) leader.push(slot.leader(seq, pos));
    }
    spec.push([CH.leader, leader]);
    spec.push([CH.autoscroll, [V.asInverted, V.asSpeedScale, V.asDeadzone, V.asRange, V.asStopOnKey]]);
    spec.push([CH.autoMouse, [V.amEnabled, V.amTimeout, V.amThreshold, V.amLayer]]);
    const ballSlots = (extra) => {
        const ids = [V.wcEnabled, V.wcStep, V.wcHoldMs, ...extra];
        for (let b = 0; b < WC_BUTTONS; b++)
            for (let d = 0; d < 8; d++) ids.push(slot.wheelChord(b, d));
        return ids;
    };
    spec.push([CH.wheelChords, ballSlots(caps.deferredClick ? [V.wcDeferClick] : [])]);
    // 0x23-0x28 are double-booked with the ZMK line (see flaskproto.js CH), so
    // every one of these is gated on a Svalboard-only capability. A blind sweep
    // would read an Imprint's combo/macro tables and file them under keys a
    // Svalboard restore would replay as Cyclotab and snippets.
    if (caps.rightBallGestures) spec.push([CH.ballGesturesRight, ballSlots([])]);
    if (caps.cyclotab) {
        const cyc = [V.cycEnabled, V.cycTimeout];
        for (let i = 0; i < CYCLOTAB_KEYS; i++) cyc.push(slot.cyclotabKey(i));
        spec.push([CH.cyclotab, cyc]);
    }
    if (caps.snippets) {
        // Targets only — the snippet TEXT is payload-addressed and cannot ride
        // a u16 map, so it travels in the flask_snippets extension key below.
        const snip = [];
        for (let k = 0; k < SNIPPET_KEYS; k++) snip.push(slot.snippetTarget(k));
        spec.push([CH.snippets, snip]);
    }
    if (caps.altRepeatBehaviour) {
        spec.push([CH.altRepeat, [V.arepChain, V.arepStaleMs, V.arepDefaultOut]]);
    }
    if (caps.teleport) {
        const tp = [V.tpEnabled, V.tpHoldMs];
        if (caps.teleportHostMode) tp.push(V.tpHostMode);
        for (let t = 0; t < TELEPORT_TARGETS; t++) tp.push(slot.teleportX(t), slot.teleportY(t));
        spec.push([CH.teleport, tp]);
    }
    if (caps.mouseButtons) spec.push([CH.mouseButtons, [V.mbDoubleGap]]);
    if (caps.cornerCombos) {
        // Geometry is firmware-baked and the per-(def, layer) outputs are
        // payload-addressed — those go in flask_corner below.
        spec.push([CH.corner, [V.ccEnabled, V.ccTerm]]);
    }
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
        for (const [ch, ids] of dumpSpec(app.caps)) {
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

    // Snippet text (Svalboard v12+). Payload-addressed and chunked, so it can't
    // ride flask_tunings — its own key, same spirit as flask_rgbmap.
    if (app.caps.snippets && !app.offline) {
        try {
            const texts = [];
            for (let i = 0; i < SNIPPET_COUNT; i++) texts.push(await app.flask.getSnippet(i));
            if (texts.some((t) => t)) data.flask_snippets = texts;
        } catch { /* leave out */ }
    }

    // Corner-combo outputs (Svalboard v17+), as [def, layer, keycode] triples.
    //
    // Two shapes, because v19 made outputs universal. Per-layer firmware
    // exports ONLY the entries a layer owns — the resolved value on an
    // inheriting layer is not a binding, and writing it back would turn every
    // borrowed chord into an explicit override. Universal firmware has one
    // binding per chord, so it exports exactly one triple per bound chord;
    // walking the layer mask there would emit sixteen identical rows, since
    // 0x12 answers 0xFFFF for anything bound.
    if (app.caps.cornerCombos && !app.offline) {
        try {
            const defCount = await app.flask.getU16(CH.corner, V.ccDefCount);
            const outputs = [];
            for (let def = 0; def < defCount; def++) {
                if (app.caps.cornerPerLayer) {
                    const mask = await app.flask.getBytes(CH.corner, V.ccLayers, [def], 1);
                    const own = ((mask[1] ?? 0) << 8) | (mask[2] ?? 0);
                    for (let layer = 0; layer < 16; layer++) {
                        if (!(own & (1 << layer))) continue;
                        const r = await app.flask.getBytes(CH.corner, V.ccOut, [def, layer], 2);
                        outputs.push([def, layer, ((r[2] ?? 0) << 8) | (r[3] ?? 0)]);
                    }
                } else {
                    const r = await app.flask.getBytes(CH.corner, V.ccOut, [def, 0], 2);
                    const kc = ((r[2] ?? 0) << 8) | (r[3] ?? 0);
                    if (kc) outputs.push([def, 0, kc]);
                }
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
        touched.delete(CH.corner);
        for (const ch of touched) { try { await app.flask.save(ch); } catch { /* no-op */ } }
    }

    // Snippet text (own key — payload-addressed, so it never rode flask_tunings).
    if (Array.isArray(json.flask_snippets) && app.caps.snippets && !app.offline) {
        for (let i = 0; i < Math.min(json.flask_snippets.length, SNIPPET_COUNT); i++) {
            const text = json.flask_snippets[i];
            if (typeof text !== 'string') continue;
            try { await app.flask.setSnippet(i, text); stats.applied++; }
            catch { /* leave the slot as it was */ }
        }
        try { await app.flask.save(CH.snippets); } catch { /* no-op */ }
    }

    // Corner-combo outputs. Only owned entries were exported, so replaying them
    // restores the inheritance pattern too — anything not listed stays inherited.
    if (Array.isArray(json.flask_corner) && app.caps.cornerCombos && !app.offline) {
        // A file written by per-layer firmware can carry several rows for one
        // chord. Universal firmware keeps one binding per chord, so replaying
        // them all would let whichever row happened to be last win. Take the
        // LOWEST layer's binding — under the old inheritance model that was the
        // base every other layer fell back to.
        let rows = json.flask_corner;
        if (!app.caps.cornerPerLayer) {
            const lowest = new Map();
            for (const e of rows) {
                if (!Array.isArray(e) || e.length < 3) continue;
                const [def, layer] = [Number(e[0]), Number(e[1])];
                const prev = lowest.get(def);
                if (!prev || layer < Number(prev[1])) lowest.set(def, e);
            }
            rows = [...lowest.values()];
        }
        for (const entry of rows) {
            if (!Array.isArray(entry) || entry.length < 3) continue;
            const [def, layer, kc] = entry.map(Number);
            if (!Number.isFinite(def) || def >= CC.total || layer > 15) continue;
            try {
                // No save — the SET persists this entry itself (see above).
                await app.flask.setBytes(CH.corner, V.ccOut,
                    [def, layer, (kc >> 8) & 0xFF, kc & 0xFF], 2);
                stats.applied++;
            } catch { /* def not served */ }
        }
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
