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

import { CH, V } from './flaskproto.js?v=18';
import { zmkAllSlotNames, zmkApplySlotNames } from './zmk.js?v=18';
import { encodeComboSlot, decodeComboSlot, COMBO_MAX_KEYS,
         encodeComboSlotV2, decodeComboSlotV2, comboSlotToTyped,
         encodeComboSlotV3, decodeComboSlotV3,
         comboTypedToLegacy } from './zmk-combos-codec.js?v=18';
import { encodeMacroStep, decodeMacroStep } from './zmk-macros-codec.js?v=18';
import { encodeLeaderSlot, decodeLeaderSlot, encodeGestureSlot, decodeGestureSlot }
    from './zmk-output-codec.js?v=18';
import { encodeCskSlot, decodeCskSlot } from './zmk-csk-codec.js?v=18';
import { encodeTdStep, decodeTdStep, encodeTdCfg, decodeTdCfg }
    from './zmk-tapdance-codec.js?v=18';

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
            const { base, shifted } = decodeCskSlot(r);
            slots.push({ base, shifted });
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
            for (let t = 0; t < tapCap; t++) {
                const d = decodeTdStep(await flask.getBytes(CH.tapDance, V.tdStep, [i, t], 2));
                taps.push({ action: d.action, behaviorId: d.behaviorId,
                    param1: d.param1, param2: d.param2 });
            }
            slots.push({ termMs: cfg.termMs, taps });
        }
        out.tapDance = {
            enabled: await g(CH.tapDance, V.tdEnabled),
            slots,
        };
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
                slots.push({ positions, action, behaviorId, param1, param2,
                    timeoutMs, priorIdleMs, layer });
            } else if (caps.combosTyped) {
                const r = await flask.getBytes(CH.combos, V.combosSlotV2, [i], 1);
                const { positions, action, behaviorId, param1, param2 } =
                    decodeComboSlotV2(r, keys);
                slots.push({ positions, action, behaviorId, param1, param2 });
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
        for (let i = 0; i < Math.min(count, s.slots?.length ?? 0); i++) {
            // File slots may be legacy {usage}, typed (v12) or timed (v14);
            // device may be any of those too — bridge every direction.
            const typed = s.slots[i].action != null
                ? s.slots[i] : comboSlotToTyped(s.slots[i]);
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
        for (let i = 0; i < Math.min(count, s.slots?.length ?? 0); i++) {
            await flask.setBytes(CH.customShift, V.cskSlot,
                encodeCskSlot(i, s.slots[i]), 1);
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
            for (let t = 0; t < Math.min(tapCap, slot.taps?.length ?? 0); t++) {
                await flask.setBytes(CH.tapDance, V.tdStep,
                    encodeTdStep(i, t, slot.taps[t]), 2);
                applied++;
            }
        }
        if (s.enabled != null) await setU(CH.tapDance, V.tdEnabled, s.enabled);
    }, CH.tapDance);

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
    return { applied, failures, saved: save ? saves.length : 0 };
}
