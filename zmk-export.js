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

import { CH, V } from './flaskproto.js?v=10';
import { encodeComboSlot, decodeComboSlot, COMBO_MAX_KEYS } from './zmk-combos-codec.js?v=10';
import { encodeMacroStep, decodeMacroStep } from './zmk-macros-codec.js?v=10';
import { encodeLeaderSlot, decodeLeaderSlot, encodeGestureSlot, decodeGestureSlot }
    from './zmk-output-codec.js?v=10';

/** Read everything the device's capabilities advertise. Returns the
 * `flask` section for the export file. */
export async function exportFlaskState(app) {
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
    if (caps.ballSwap) {
        out.ballSwap = { swapped: await g(CH.ballSwap, V.bswapSwapped) };
    }
    if (caps.rgbMap) {
        const layers = await g(CH.rgbMap, V.rgbmapLayers);
        const leds = await g(CH.rgbMap, V.rgbmapLeds);
        const map = [];
        for (let l = 0; l < layers; l++) {
            const row = [];
            for (let led = 0; led < leds; led++) {
                const r = await flask.getBytes(CH.rgbMap, V.rgbmapLed, [l, led]);
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
    }
    if (caps.combos) {
        const count = await g(CH.combos, V.combosSlotCount);
        const keys = caps.combosKeys
            ? (await g(CH.combos, V.combosKeys) || COMBO_MAX_KEYS) : COMBO_MAX_KEYS;
        const slots = [];
        for (let i = 0; i < count; i++) {
            const r = await flask.getBytes(CH.combos, V.combosSlot, [i]);
            const { positions, usage } = decodeComboSlot(r, keys);
            slots.push({ positions, usage });
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
                const r = await flask.getBytes(CH.macros, V.macrosStep, [m, s]);
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
            const r = await flask.getBytes(CH.leader, V.leaderSlot, [i]);
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
                const r = await flask.getBytes(CH.gestures, V.gesturesSlot, [s, d]);
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
    return out;
}

/** Apply an export's `flask` section to the connected device: write-through
 * everything the device's caps accept, SAVE each touched channel. Returns
 * { applied, failures } — a failure skips that section, the rest land. */
export async function applyFlaskState(app, data) {
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

    await section('ballSwap', caps.ballSwap, async (s) => {
        if (s.swapped != null) await setU(CH.ballSwap, V.bswapSwapped, s.swapped);
    }, CH.ballSwap);

    await section('rgb', caps.rgbMap, async (s) => {
        const layers = await flask.getU16(CH.rgbMap, V.rgbmapLayers);
        const leds = await flask.getU16(CH.rgbMap, V.rgbmapLeds);
        for (let l = 0; l < Math.min(layers, s.map?.length ?? 0); l++) {
            for (let led = 0; led < Math.min(leds, s.map[l].length); led++) {
                const [h, sa, v] = s.map[l][led];
                await flask.setBytes(CH.rgbMap, V.rgbmapLed, [l, led, h, sa, v]);
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
    }, CH.rgbMap);

    await section('combos', caps.combos, async (s) => {
        const count = await flask.getU16(CH.combos, V.combosSlotCount);
        const keys = caps.combosKeys
            ? (await flask.getU16(CH.combos, V.combosKeys) || COMBO_MAX_KEYS) : COMBO_MAX_KEYS;
        for (let i = 0; i < Math.min(count, s.slots?.length ?? 0); i++) {
            await flask.setBytes(CH.combos, V.combosSlot, encodeComboSlot(i, s.slots[i], keys));
            applied++;
        }
        if (s.enabled != null) await setU(CH.combos, V.combosEnabled, s.enabled);
        if (s.timeout != null) await setU(CH.combos, V.combosTimeout, s.timeout);
    }, CH.combos);

    await section('macros', caps.macros, async (s) => {
        const count = await flask.getU16(CH.macros, V.macrosSlotCount);
        const stepCap = await flask.getU16(CH.macros, V.macrosStepCount);
        for (let m = 0; m < Math.min(count, s.slots?.length ?? 0); m++) {
            const slot = s.slots[m];
            for (let st = 0; st < stepCap; st++) {
                const step = slot[st] ?? { action: 0, param: 0 };
                await flask.setBytes(CH.macros, V.macrosStep,
                    encodeMacroStep(m, st, step));
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
                encodeLeaderSlot(i, s.slots[i], keys));
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
                    encodeGestureSlot(st, d, s.sets[st][d]));
                applied++;
            }
        }
        if (s.enabled != null) await setU(CH.gestures, V.gesturesEnabled, s.enabled);
        if (s.ratchetStep != null) await setU(CH.gestures, V.gesturesRatchetStep, s.ratchetStep);
        if (s.activeSet != null) await setU(CH.gestures, V.gesturesActiveSet, s.activeSet);
    }, CH.gestures);

    for (const ch of saves) {
        try { await flask.save(ch); } catch (e) { failures.push(`save 0x${ch.toString(16)}: ${e.message}`); }
    }
    return { applied, failures };
}
