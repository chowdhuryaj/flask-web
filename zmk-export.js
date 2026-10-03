// Flask module state export/import (ZMK line) — the sections that make the
// keymap JSON a full-device backup, the ZMK equivalent of the QMK .vil:
// tunables, the RGB map + effect, and every runtime slot table. Gathered
// straight off the Flask channels (works identically against the offline
// sim), applied back write-through + SAVE per channel.
//
// A re-flash wipes the settings partition on layout changes; export-then-
// import is the restore path. Sections are optional and capability-gated
// both ways — importing a v9 export into a v10 device just skips nothing,
// importing v10 into v9 skips leader/gestures.

import { CH, V } from './flaskproto.js?v=68';
import { zmkBehaviors } from './zmk-keycodes.js?v=68';
import { isRecursiveOutput } from './behavior-catalog.js?v=68';
import { zmkAllSlotNames, zmkApplySlotNames } from './zmk.js?v=68';
import { encodeComboSlot, decodeComboSlot, COMBO_MAX_KEYS,
         encodeComboSlotV2, decodeComboSlotV2, comboSlotToTyped,
         encodeComboSlotV3, decodeComboSlotV3,
         comboTypedToLegacy, findDuplicateCombo, comboSlotV2IsEmpty } from './zmk-combos-codec.js?v=68';
import { TOTEM_DEFAULT } from './zmk-totem-default.js?v=68';
import { encodeMacroStep, decodeMacroStep } from './zmk-macros-codec.js?v=68';
import { encodeLeaderSlot, decodeLeaderSlot, encodeGestureSlot, decodeGestureSlot }
    from './zmk-output-codec.js?v=68';
import { encodeCskSlot, decodeCskSlot, cskMorphCaps, cskNeedsMorph, cskNeedsOs, cskOskCaps, MOD_SHIFT_ONLY } from './zmk-csk-codec.js?v=68';
import { encodeTdStep, decodeTdStep, encodeTdCfg, decodeTdCfg }
    from './zmk-tapdance-codec.js?v=68';
import { encodeAkRule, decodeAkRule, encodeAkStep, decodeAkStep, encodeAkFallback, decodeAkFallback }
    from './zmk-adaptive-codec.js?v=68';

/** Behavior ids shift between firmware builds and differ from the offline sim,
 * so a behavior output (action 3) is exported with its display name beside the
 * id, exactly as the keymap half does (WB-05). */
export function namedOut(o) {
    const behavior = o.action === 3 ? zmkBehaviors()?.get(o.behaviorId)?.displayName : undefined;
    return behavior ? { ...o, behavior } : o;
}

/** Apply side of namedOut: the name wins; the id is used only when the file
 * has no name (or this session has no behavior list to look names up in).
 * Returns null when the file names a behavior this firmware does not have. */
export function resolveOut(o, behaviors = zmkBehaviors()) {
    if (!o || o.action !== 3 || !o.behavior || !behaviors?.size) return o;
    for (const [id, d] of behaviors) if (d.displayName === o.behavior) return { ...o, behaviorId: id };
    return null;
}

const NO_OUT = { action: 0, behaviorId: 0, param1: 0, param2: 0 };

/** Read everything the device's capabilities advertise. Returns the
 * `flask` section for the export file. */
export async function exportFlaskState(app) {
    // HUD poll backs off for the whole bulk read (hundreds of frames on a
    // 10-layer RGB map) — see the combos tab note.
    app.hid?.pause?.();
    try { return await exportFlaskStateInner(app); }
    finally { app.hid?.resume?.(); }
}

async function exportFlaskStateInner(app) {
    const { flask, caps } = app;
    const g = (ch, id) => flask.getU16(ch, id);
    const out = { protocol: app.protocolVersion };

    if (caps.autoscroll) {
        out.autoscroll = {
            inverted: await g(CH.autoscroll, V.asInverted),
            speedScale: await g(CH.autoscroll, V.asSpeedScale),
            stopOnKey: await g(CH.autoscroll, V.asStopOnKey),
        };
    }
    if (caps.accel) {
        out.accel = {
            enabled: await g(CH.accel, V.accelEnabled),
            takeoff: await g(CH.accel, V.accelTakeoff),
            growth: await g(CH.accel, V.accelGrowth),
            offset: await flask.getI16(CH.accel, V.accelOffset),
            limit: await g(CH.accel, V.accelLimit),
        };
    }
    if (caps.scrollSnap) {
        out.scrollSnap = {
            enabled: await g(CH.scrollSnap, V.snapEnabled),
            threshold: await g(CH.scrollSnap, V.snapThreshold),
            samples: await g(CH.scrollSnap, V.snapSamples),
            immediate: await g(CH.scrollSnap, V.snapImmediate),
            lockMs: await g(CH.scrollSnap, V.snapLockMs),
            lockEvents: await g(CH.scrollSnap, V.snapLockEvents),
            idleReset: await g(CH.scrollSnap, V.snapIdleReset),
        };
    }
    if (caps.scrollSpeed) {
        out.scrollSpeed = { speedPct: await g(CH.scrollScale, V.scrollSpeedPct) };
    }
    if (caps.ballSwap) {
        out.ballSwap = { swapped: await g(CH.ballSwap, V.bswapSwapped) };
    }
    if (caps.autoMouse) {
        out.autoMouse = {
            enabled: await g(CH.autoMouse, V.amEnabled),
            timeout: await g(CH.autoMouse, V.amTimeout),
            threshold: await g(CH.autoMouse, V.amThreshold),
            layer: await g(CH.autoMouse, V.amLayer),
            extend: await g(CH.autoMouse, V.amExtend),
        };
    }
    if (caps.rgbMap) {
        const layers = await g(CH.rgbMap, V.rgbmapLayers);
        const leds = await g(CH.rgbMap, V.rgbmapLeds);
        const map = [];
        for (let l = 0; l < layers; l++) {
            const row = [];
            for (let led = 0; led < leds; led++) {
                const r = await flask.getBytes(CH.rgbMap, V.rgbmapLed, [l, led], 2);
                row.push([r[2] ?? 0, r[3] ?? 0, r[4] ?? 0]);
            }
            map.push(row);
        }
        out.rgb = { enabled: await g(CH.rgbMap, V.rgbmapEnabled), map };
        if (caps.rgbEffects) {
            out.rgb.effect = await g(CH.rgbMap, V.rgbmapEffect);
            out.rgb.effectSpeed = await g(CH.rgbMap, V.rgbmapEffectSpeed);
            out.rgb.effectHsv = [
                await g(CH.rgbMap, V.rgbmapEffectHue),
                await g(CH.rgbMap, V.rgbmapEffectSat),
                await g(CH.rgbMap, V.rgbmapEffectVal),
            ];
        }
        if (caps.rgbBrightness) {
            out.rgb.brightness = await g(CH.rgbMap, V.rgbmapBrightness);
        }
        if (caps.rgbIdleTimeout) {
            out.rgb.idleTimeout = await g(CH.rgbMap, V.rgbmapIdleTimeout);
        }
    }
    if (caps.customShift) {
        const count = await g(CH.customShift, V.cskSlotCount);
        const slots = [];
        for (let i = 0; i < count; i++) {
            const r = await flask.getBytes(CH.customShift, V.cskSlot, [i], 1);
            const { base, shifted, mods, keep, os, wild, count } = decodeCskSlot(r);
            // Trigger/keep only when not the Shift default, and os/wild/count only
            // when set, so old exports stay byte-identical and old files (no
            // fields) import as plain Shift slots.
            const osBits = os || wild || count ? { os: os || 0, wild: !!wild, count: !!count } : null;
            slots.push(mods === MOD_SHIFT_ONLY && !keep && !osBits ? { base, shifted }
                : { base, shifted, mods, keep, ...osBits });
        }
        out.customShift = {
            enabled: await g(CH.customShift, V.cskEnabled),
            slots,
        };
    }
    if (caps.tapDance) {
        const count = await g(CH.tapDance, V.tdSlotCount);
        const tapCap = await g(CH.tapDance, V.tdTaps) || 4;
        const slots = [];
        for (let i = 0; i < count; i++) {
            const cfg = decodeTdCfg(await flask.getBytes(CH.tapDance, V.tdCfg, [i], 1));
            const taps = [];
            // A dance is its contiguous prefix: stop at the first NONE (apply pads the rest).
            // A Tap Dance / Adaptive Key step would recurse in the firmware: not exported.
            for (let t = 0; t < tapCap; t++) {
                const d = decodeTdStep(await flask.getBytes(CH.tapDance, V.tdStep, [i, t], 2));
                if (!d.action || isRecursiveOutput(d)) break;
                taps.push(namedOut({ action: d.action, behaviorId: d.behaviorId,
                    param1: d.param1, param2: d.param2 }));
            }
            slots.push({ termMs: cfg.termMs, taps });
        }
        out.tapDance = {
            enabled: await g(CH.tapDance, V.tdEnabled),
            slots,
        };
    }
    if (caps.adaptive) {
        // Live rules only (trigger and an output); pool index kept, it is the priority order.
        const sets = await g(CH.adaptive, V.akSetCount);
        const ruleCap = await g(CH.adaptive, V.akRuleCount);
        const stepCap = await g(CH.adaptive, V.akStepCount) || 6;
        const out1 = (d) => (isRecursiveOutput(d) ? { ...NO_OUT }
            : namedOut({ action: d.action, behaviorId: d.behaviorId, param1: d.param1, param2: d.param2 }));
        const fallback = [];
        for (let st = 0; st < sets; st++) {
            fallback.push(out1(decodeAkFallback(await flask.getBytes(CH.adaptive, V.akFallback, [st], 1))));
        }
        const rules = [];
        for (let i = 0; i < ruleCap; i++) {
            const h = decodeAkRule(await flask.getBytes(CH.adaptive, V.akRule, [i], 1));
            if (!h.trigger) continue;
            const steps = [];
            for (let s = 0; s < stepCap; s++) {
                const d = decodeAkStep(await flask.getBytes(CH.adaptive, V.akStep, [i, s], 2));
                if (!d.action || isRecursiveOutput(d)) break;
                steps.push(out1(d));
            }
            if (steps.length) rules.push({ index: i, set: h.set, trigger: h.trigger, maxIdleMs: h.maxIdleMs, strict: h.strict, steps });
        }
        out.adaptive = { enabled: await g(CH.adaptive, V.akEnabled), fallback, rules };
    }
    if (caps.combos) {
        const count = await g(CH.combos, V.combosSlotCount);
        const keys = caps.combosKeys
            ? (await g(CH.combos, V.combosKeys) || COMBO_MAX_KEYS) : COMBO_MAX_KEYS;
        const slots = [];
        for (let i = 0; i < count; i++) {
            // v14: timed slots carry per-combo timeout/prior-idle/layer;
            // v12: TYPED slots (behavior outputs survive a backup);
            // pre-v12 exports keep the legacy {positions, usage}.
            if (caps.combosTimed) {
                const r = await flask.getBytes(CH.combos, V.combosSlotV3, [i], 1);
                const { positions, action, behaviorId, param1, param2,
                    timeoutMs, priorIdleMs, layer } = decodeComboSlotV3(r, keys);
                slots.push({ positions, ...namedOut({ action, behaviorId, param1, param2 }),
                    timeoutMs, priorIdleMs, layer });
            } else if (caps.combosTyped) {
                const r = await flask.getBytes(CH.combos, V.combosSlotV2, [i], 1);
                const { positions, action, behaviorId, param1, param2 } =
                    decodeComboSlotV2(r, keys);
                slots.push({ positions, ...namedOut({ action, behaviorId, param1, param2 }) });
            } else {
                const r = await flask.getBytes(CH.combos, V.combosSlot, [i], 1);
                const { positions, usage } = decodeComboSlot(r, keys);
                slots.push({ positions, usage });
            }
        }
        out.combos = {
            enabled: await g(CH.combos, V.combosEnabled),
            timeout: await g(CH.combos, V.combosTimeout),
            keys, slots,
        };
    }
    if (caps.macros) {
        const count = await g(CH.macros, V.macrosSlotCount);
        const steps = await g(CH.macros, V.macrosStepCount);
        const slots = [];
        for (let m = 0; m < count; m++) {
            const slot = [];
            for (let s = 0; s < steps; s++) {
                const r = await flask.getBytes(CH.macros, V.macrosStep, [m, s], 2);
                const d = decodeMacroStep(r);
                if (d.action === 0) break;      // steps end at the first empty
                slot.push({ action: d.action, param: d.param });
            }
            slots.push(slot);
        }
        out.macros = {
            enabled: await g(CH.macros, V.macrosEnabled),
            tapMs: await g(CH.macros, V.macrosTapMs),
            waitMs: await g(CH.macros, V.macrosWaitMs),
            slots,
        };
    }
    if (caps.leader) {
        const count = await g(CH.leader, V.leaderSlotCount);
        const keys = await g(CH.leader, V.leaderKeys) || 8;
        const slots = [];
        for (let i = 0; i < count; i++) {
            const r = await flask.getBytes(CH.leader, V.leaderSlot, [i], 1);
            const d = decodeLeaderSlot(r, keys);
            slots.push({ positions: d.positions, action: d.action, param: d.param });
        }
        out.leader = {
            enabled: await g(CH.leader, V.leaderEnabled),
            timeout: await g(CH.leader, V.leaderTimeout),
            keys, slots,
        };
    }
    if (caps.gestures) {
        const setCount = await g(CH.gestures, V.gesturesSetCount) || 8;
        const sets = [];
        for (let s = 0; s < setCount; s++) {
            const dirs = [];
            for (let d = 0; d < 8; d++) {
                const r = await flask.getBytes(CH.gestures, V.gesturesSlot, [s, d], 2);
                const o = decodeGestureSlot(r);
                dirs.push({ action: o.action, param: o.param });
            }
            sets.push(dirs);
        }
        out.gestures = {
            enabled: await g(CH.gestures, V.gesturesEnabled),
            ratchetStep: await g(CH.gestures, V.gesturesRatchetStep),
            activeSet: await g(CH.gestures, V.gesturesActiveSet),
            sets,
        };
    }
    // Client-side slot names (combo/macro renames) — the firmware has no
    // name storage, so the backup carries them alongside the device state.
    const names = zmkAllSlotNames(app.profile?.family ?? 'imprint');
    if (Object.keys(names).length) out.slotNames = names;
    return out;
}

/** Apply an export's `flask` section to the connected device: write-through
 * everything the device's caps accept, SAVE each touched channel. Returns
 * { applied, failures } — a failure skips that section, the rest land.
 *
 * `save: false` writes everything LIVE and skips the SAVE pass — the Modes
 * switch. Values are on the device immediately and revert on power-off, which
 * is the wanted semantics for a mode you carry in the app: the device keeps
 * ONE saved baseline (the environment where you have no app), and alternates
 * are applied live from the environment where you do. It also writes nothing
 * to a 32 KB settings partition and never enters the SAVE path.
 * Restores (import, auto-restore) keep the default and DO save. */
export async function applyFlaskState(app, data, { save = true } = {}) {
    // Bulk write-through: HUD backs off until every section + SAVE landed.
    app.hid?.pause?.();
    try { return await applyFlaskStateInner(app, data, save); }
    finally { app.hid?.resume?.(); }
}

async function applyFlaskStateInner(app, data, save = true) {
    const { flask, caps } = app;
    let applied = 0;
    const failures = [];
    const saves = [];
    const setU = async (ch, id, v) => { await flask.setU16(ch, id, v); applied++; };
    // Behavior outputs resolve by display name; one this firmware lacks becomes empty.
    let unresolved = 0;
    const out = (o) => {
        const r = resolveOut(o);
        if (r) return r;
        unresolved++;
        return { ...o, ...NO_OUT };
    };


    const section = async (name, cond, fn, ch) => {
        if (!cond || !data[name]) return;
        try {
            await fn(data[name]);
            saves.push(ch);
        } catch (e) {
            failures.push(`${name}: ${e.message}`);
        }
    };

    await section('autoscroll', caps.autoscroll, async (s) => {
        if (s.inverted != null) await setU(CH.autoscroll, V.asInverted, s.inverted);
        if (s.speedScale != null) await setU(CH.autoscroll, V.asSpeedScale, s.speedScale);
        if (s.stopOnKey != null) await setU(CH.autoscroll, V.asStopOnKey, s.stopOnKey);
    }, CH.autoscroll);

    await section('accel', caps.accel, async (s) => {
        if (s.enabled != null) await setU(CH.accel, V.accelEnabled, s.enabled);
        if (s.takeoff != null) await setU(CH.accel, V.accelTakeoff, s.takeoff);
        if (s.growth != null) await setU(CH.accel, V.accelGrowth, s.growth);
        if (s.offset != null) { await flask.setI16(CH.accel, V.accelOffset, s.offset); applied++; }
        if (s.limit != null) await setU(CH.accel, V.accelLimit, s.limit);
    }, CH.accel);

    await section('scrollSnap', caps.scrollSnap, async (s) => {
        const ids = [['enabled', V.snapEnabled], ['threshold', V.snapThreshold],
            ['samples', V.snapSamples], ['immediate', V.snapImmediate],
            ['lockMs', V.snapLockMs], ['lockEvents', V.snapLockEvents],
            ['idleReset', V.snapIdleReset]];
        for (const [k, id] of ids) {
            if (s[k] != null) await setU(CH.scrollSnap, id, s[k]);
        }
    }, CH.scrollSnap);

    await section('scrollSpeed', caps.scrollSpeed, async (s) => {
        if (s.speedPct != null) await setU(CH.scrollScale, V.scrollSpeedPct, s.speedPct);
    }, CH.scrollScale);

    await section('ballSwap', caps.ballSwap, async (s) => {
        if (s.swapped != null) await setU(CH.ballSwap, V.bswapSwapped, s.swapped);
    }, CH.ballSwap);

    await section('autoMouse', caps.autoMouse, async (s) => {
        if (s.enabled != null) await setU(CH.autoMouse, V.amEnabled, s.enabled);
        if (s.timeout != null) await setU(CH.autoMouse, V.amTimeout, s.timeout);
        if (s.threshold != null) await setU(CH.autoMouse, V.amThreshold, s.threshold);
        if (s.layer != null) await setU(CH.autoMouse, V.amLayer, s.layer);
        if (s.extend != null) await setU(CH.autoMouse, V.amExtend, s.extend);
    }, CH.autoMouse);

    await section('rgb', caps.rgbMap, async (s) => {
        const layers = await flask.getU16(CH.rgbMap, V.rgbmapLayers);
        const leds = await flask.getU16(CH.rgbMap, V.rgbmapLeds);
        for (let l = 0; l < Math.min(layers, s.map?.length ?? 0); l++) {
            for (let led = 0; led < Math.min(leds, s.map[l].length); led++) {
                const [h, sa, v] = s.map[l][led];
                await flask.setBytes(CH.rgbMap, V.rgbmapLed, [l, led, h, sa, v], 2);
                applied++;
            }
        }
        if (s.enabled != null) await setU(CH.rgbMap, V.rgbmapEnabled, s.enabled);
        if (caps.rgbEffects && s.effect != null) {
            await setU(CH.rgbMap, V.rgbmapEffect, s.effect);
            await setU(CH.rgbMap, V.rgbmapEffectSpeed, s.effectSpeed ?? 128);
            const [h, sa, v] = s.effectHsv ?? [0, 255, 120];
            await setU(CH.rgbMap, V.rgbmapEffectHue, h);
            await setU(CH.rgbMap, V.rgbmapEffectSat, sa);
            await setU(CH.rgbMap, V.rgbmapEffectVal, v);
        }
        if (caps.rgbBrightness && s.brightness != null) {
            await setU(CH.rgbMap, V.rgbmapBrightness, s.brightness);
        }
        if (caps.rgbIdleTimeout && s.idleTimeout != null) {
            await setU(CH.rgbMap, V.rgbmapIdleTimeout, s.idleTimeout);
        }
    }, CH.rgbMap);

    await section('combos', caps.combos, async (s) => {
        const count = await flask.getU16(CH.combos, V.combosSlotCount);
        const keys = caps.combosKeys
            ? (await flask.getU16(CH.combos, V.combosKeys) || COMBO_MAX_KEYS) : COMBO_MAX_KEYS;
        // File slots may be legacy {usage}, typed (v12) or timed (v14);
        // device may be any of those too — bridge every direction.
        const file = (s.slots ?? []).slice(0, count)
            .map((x) => out(x.action != null ? x : comboSlotToTyped(x)));
        // Two live combos on one key set freeze the board on press: refuse
        // the whole section before any write. Pre-v14 Totem firmware keeps
        // its compiled combos outside the runtime table, so check those too.
        const defaults = !caps.combosTimed && app.profile?.family === 'totem' ? TOTEM_DEFAULT.combos : [];
        for (let i = 0; i < file.length; i++) {
            if (comboSlotV2IsEmpty(file[i])) continue;
            const dup = findDuplicateCombo(file.slice(0, i), -1, file[i].positions ?? [], defaults);
            if (dup) {
                throw new Error(`combo ${i} uses the same keys as ${dup.kind === 'default'
                    ? `the keymap's compiled combo ${dup.index}` : `combo ${dup.index}`} in this file `
                    + '(two combos on one key set freeze the board); no combos were written');
            }
        }
        for (let i = 0; i < file.length; i++) {
            const typed = file[i];
            if (caps.combosTimed) {
                await flask.setBytes(CH.combos, V.combosSlotV3,
                    encodeComboSlotV3(i, typed, keys), 1); // missing timing encodes as 0/ANY
            } else if (caps.combosTyped) {
                await flask.setBytes(CH.combos, V.combosSlotV2,
                    encodeComboSlotV2(i, typed, keys), 1);
            } else {
                await flask.setBytes(CH.combos, V.combosSlot,
                    encodeComboSlot(i, comboTypedToLegacy(typed), keys), 1);
            }
            applied++;
        }
        if (s.enabled != null) await setU(CH.combos, V.combosEnabled, s.enabled);
        if (s.timeout != null) await setU(CH.combos, V.combosTimeout, s.timeout);
    }, CH.combos);

    await section('customShift', caps.customShift, async (s) => {
        const count = await flask.getU16(CH.customShift, V.cskSlotCount);
        const morph = await cskMorphCaps(flask);
        let osk;   // probed once, only if a slot needs it
        const extra = (s.slots ?? []).slice(count).filter((x) => x.base || x.shifted).length;
        if (extra) failures.push(`customShift: ${extra} slot(s) past this board's ${count}, not written`);
        for (let i = 0; i < Math.min(count, s.slots?.length ?? 0); i++) {
            const slot = s.slots[i];
            // Shift-only firmware cannot hold another trigger set or keep-mods.
            if (!morph && cskNeedsMorph(slot)) {
                failures.push(`customShift slot ${i}: needs mod-morph firmware, skipped`);
                continue;
            }
            if (cskNeedsOs(slot)) {
                osk ??= morph && await cskOskCaps(flask);
                if (!osk) {
                    failures.push(`customShift slot ${i}: needs OS-aware firmware, skipped`);
                    continue;
                }
            }
            await flask.setBytes(CH.customShift, V.cskSlot, encodeCskSlot(i, slot), 1);
            applied++;
        }
        if (s.enabled != null) await setU(CH.customShift, V.cskEnabled, s.enabled);
    }, CH.customShift);

    await section('tapDance', caps.tapDance, async (s) => {
        const count = await flask.getU16(CH.tapDance, V.tdSlotCount);
        const tapCap = await flask.getU16(CH.tapDance, V.tdTaps) || 4;
        for (let i = 0; i < Math.min(count, s.slots?.length ?? 0); i++) {
            const slot = s.slots[i];
            await flask.setBytes(CH.tapDance, V.tdCfg,
                encodeTdCfg(i, slot.termMs ?? 0), 1);
            applied++;
            // Pad with NONE: an export lists only the live prefix, and a stale tap
            // behind it on the device would come alive with the next edit.
            for (let t = 0; t < tapCap; t++) {
                const o = slot.taps?.[t];
                await flask.setBytes(CH.tapDance, V.tdStep,
                    encodeTdStep(i, t, o ? ((x) => (isRecursiveOutput(x) ? NO_OUT : x))(out(o)) : NO_OUT), 2);
                applied++;
            }
        }
        if (s.enabled != null) await setU(CH.tapDance, V.tdEnabled, s.enabled);
    }, CH.tapDance);

    await section('adaptive', caps.adaptive, async (s) => {
        const sets = await flask.getU16(CH.adaptive, V.akSetCount);
        const ruleCap = await flask.getU16(CH.adaptive, V.akRuleCount);
        const stepCap = await flask.getU16(CH.adaptive, V.akStepCount) || 6;
        for (let st = 0; st < Math.min(sets, s.fallback?.length ?? 0); st++) {
            await flask.setBytes(CH.adaptive, V.akFallback, encodeAkFallback(st, ((x) => (isRecursiveOutput(x) ? NO_OUT : x))(out(s.fallback[st]))), 1);
            applied++;
        }
        // Device rules the file does not list are deleted, so the file is the whole table
        // (this is how a default the backup had deleted stays deleted).
        const listed = new Set((s.rules ?? []).map((r) => r.index));
        for (let i = 0; i < ruleCap; i++) {
            if (listed.has(i)) continue;
            const h = decodeAkRule(await flask.getBytes(CH.adaptive, V.akRule, [i], 1));
            if (!h.trigger) continue;
            await flask.setBytes(CH.adaptive, V.akRule, encodeAkRule(i, {}), 1);
            applied++;
        }
        for (const r of s.rules ?? []) {
            if (r.index >= ruleCap || r.set >= sets) continue;
            await flask.setBytes(CH.adaptive, V.akRule, encodeAkRule(r.index, r), 1);
            for (let st = 0; st < stepCap; st++) {
                await flask.setBytes(CH.adaptive, V.akStep, encodeAkStep(r.index, st, r.steps?.[st] ? ((x) => (isRecursiveOutput(x) ? {} : x))(out(r.steps[st])) : {}), 2);
            }
            applied++;
        }
        if (s.enabled != null) await setU(CH.adaptive, V.akEnabled, s.enabled);
    }, CH.adaptive);

    await section('macros', caps.macros, async (s) => {
        const count = await flask.getU16(CH.macros, V.macrosSlotCount);
        const stepCap = await flask.getU16(CH.macros, V.macrosStepCount);
        for (let m = 0; m < Math.min(count, s.slots?.length ?? 0); m++) {
            const slot = s.slots[m];
            for (let st = 0; st < stepCap; st++) {
                const step = slot[st] ?? { action: 0, param: 0 };
                await flask.setBytes(CH.macros, V.macrosStep,
                    encodeMacroStep(m, st, step), 2);
                applied++;
                if (!slot[st]) break;   // wrote the terminating empty — done
            }
        }
        if (s.enabled != null) await setU(CH.macros, V.macrosEnabled, s.enabled);
        if (s.tapMs != null) await setU(CH.macros, V.macrosTapMs, s.tapMs);
        if (s.waitMs != null) await setU(CH.macros, V.macrosWaitMs, s.waitMs);
    }, CH.macros);

    await section('leader', caps.leader, async (s) => {
        const count = await flask.getU16(CH.leader, V.leaderSlotCount);
        const keys = await flask.getU16(CH.leader, V.leaderKeys) || 8;
        for (let i = 0; i < Math.min(count, s.slots?.length ?? 0); i++) {
            await flask.setBytes(CH.leader, V.leaderSlot,
                encodeLeaderSlot(i, s.slots[i], keys), 1);
            applied++;
        }
        if (s.enabled != null) await setU(CH.leader, V.leaderEnabled, s.enabled);
        if (s.timeout != null) await setU(CH.leader, V.leaderTimeout, s.timeout);
    }, CH.leader);

    await section('gestures', caps.gestures, async (s) => {
        const setCount = await flask.getU16(CH.gestures, V.gesturesSetCount) || 8;
        for (let st = 0; st < Math.min(setCount, s.sets?.length ?? 0); st++) {
            for (let d = 0; d < Math.min(8, s.sets[st].length); d++) {
                await flask.setBytes(CH.gestures, V.gesturesSlot,
                    encodeGestureSlot(st, d, s.sets[st][d]), 2);
                applied++;
            }
        }
        if (s.enabled != null) await setU(CH.gestures, V.gesturesEnabled, s.enabled);
        if (s.ratchetStep != null) await setU(CH.gestures, V.gesturesRatchetStep, s.ratchetStep);
        if (s.activeSet != null) await setU(CH.gestures, V.gesturesActiveSet, s.activeSet);
    }, CH.gestures);

    if (data.slotNames) {
        zmkApplySlotNames(app.profile?.family ?? 'imprint', data.slotNames);
        applied++;
    }

    if (save) {
        for (const ch of saves) {
            try { await flask.save(ch); } catch (e) { failures.push(`save 0x${ch.toString(16)}: ${e.message}`); }
        }
    }
    return { applied, failures, unresolved, saved: save ? saves.length : 0, channels: saves };
}

/** Save module channels in order, stopping at the first failure (Make
 * baseline: a partial flash write must not continue past an error). */
export async function saveFlaskChannels(app, channels) {
    app.hid?.pause?.();
    try {
        for (const ch of channels) {
            try { await app.flask.save(ch); }
            catch (e) { return { ok: false, failure: `save 0x${ch.toString(16)}: ${e.message}` }; }
        }
        return { ok: true };
    } finally { app.hid?.resume?.(); }
}

// window.flaskExportKeymap / window.flaskPrintLayers (side-effect import; see zmk-extras.js)
import './zmk-extras.js?v=68';
