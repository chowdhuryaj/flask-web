// Flask raw-HID tuning protocol constants + typed operations (ZMK line:
// zmk-flask-modules flask_proto; family identity and versions live in zmk.js).
//
// Frame shape: [cmd, channel, value_id, payload...]. u16 payloads are
// BIG-endian at bytes [3],[4]. Setters CLAMP firmware-side and echo the
// applied value; callers must adopt the echo (see ui.js sliderRow).

// Flask command bytes (VIA custom-value framing).
export const CMD = { set: 0x07, get: 0x08, save: 0x09, unhandled: 0xFF };

// Channel numbers, one per flask_* firmware module. A channel the board does
// not serve answers id_unhandled, which this app reads as "device lacks this
// feature"; the caps gates in zmk.js stop the UI offering what a family
// lacks.
export const CH = {
    meta: 0x00,
    accel: 0x10, gestures: 0x11,
    customShift: 0x16, leader: 0x19,
    autoscroll: 0x1A, autoMouse: 0x1B,
    rgbMap: 0x21,
    keyState: 0x23, // v5+: pressed-position bitmap (HUD press feed)
    combos: 0x24,   // v7+: flask_combos runtime combo slots
    macros: 0x25,   // v8+: flask_macros runtime macro steps
    scrollSnap: 0x26, // v9+: flask_scrollsnap axis snap/lock
    ballSwap: 0x27, // v11+: flask_ballswap trackball role swap
    tapDance: 0x28, // v14+: flask_tapdance runtime tap dances
    scrollScale: 0x29, // v15+: flask_scrollscale live scroll speed
    adaptive: 0x2B, // v18+ (Totem): flask_adaptive runtime adaptive keys (&fak)
};

export const V = {
    // meta
    metaProtocolVersion: 0x01,
    metaActiveLayer: 0x02, // RO: highest active layer (HUD feed)
    metaFamily: 0x03,      // numeric family code (zmk.js ZMK_FAMILY_CODES)
    metaResetCause: 0x04,  // RO: hwinfo reset-cause bits at boot (crash forensics)
    // accel (x100-scaled floats on the wire; offset is SIGNED)
    accelEnabled: 0x01, accelTakeoff: 0x02, accelGrowth: 0x03,
    accelOffset: 0x04, accelLimit: 0x05,
    // gestures (flask_gestures v10: typed-output slot frames at 0x50)
    gesturesRatchetStep: 0x01, gesturesActiveSet: 0x02,
    gesturesEnabled: 0x03, gesturesSetCount: 0x04,
    gesturesSlot: 0x50,
    // custom shift keys (v14): slot frame [slot, base u32 BE, shifted u32 BE]
    cskEnabled: 0x01, cskSlotCount: 0x02,
    cskSlot: 0x50,
    // leader (flask_leader v10): typed-output sequence frames at 0x50
    leaderTimeout: 0x01,
    leaderSlotCount: 0x02, leaderKeys: 0x03, leaderEnabled: 0x04,
    leaderSlot: 0x50,
    // autoscroll
    asInverted: 0x01, asSpeedScale: 0x02, asDeadzone: 0x03, asRange: 0x04,
    asState: 0x05,     // live: GET signed level / ±100 jogging; SET force-stops
    asStopOnKey: 0x06,
    // auto-mouse (flask_automouse: timeout 0 = latch until a transparent
    // key, extend re-arms the timeout on non-transparent keys)
    amEnabled: 0x01, amTimeout: 0x02, amThreshold: 0x03, amLayer: 0x04,
    amExtend: 0x05,
    // scroll speed (flask_scrollscale, v15+). A PERCENT of the keymap's
    // compiled divisors, not an absolute rate: 100 = the firmware's
    // benched default, 200 = twice as fast. One knob drives both axes so
    // their base ratio (16 horizontal : 12 vertical on the Imprint) holds.
    scrollSpeedPct: 0x01,
    // RGB map (0x21) — enabled/layers/leds are u16; led/fill are
    // PAYLOAD-ADDRESSED byte frames (getBytes/setBytes, never u16 helpers).
    // 0x04-0x08: effect engine (v9) — whole-strip animation underneath the
    // painted map (painted keys overlay the effect).
    rgbmapEnabled: 0x01, rgbmapLayers: 0x02, rgbmapLeds: 0x03,
    rgbmapEffect: 0x04, rgbmapEffectSpeed: 0x05,
    rgbmapEffectHue: 0x06, rgbmapEffectSat: 0x07, rgbmapEffectVal: 0x08,
    rgbmapSplitLink: 0x09, // RO: central found the peripheral's rgb GATT char
    // v12: chunked runtime LED→keymap-position table [start, count, pos...]
    // (0xFF = no key / underglow) — the wizard's measured order, on-device.
    rgbmapLedOrder: 0x0A,
    rgbmapLed: 0x10, rgbmapFill: 0x12,
    // key state (0x23) — PAYLOAD-ADDRESSED byte frame (getBytes):
    // payload byte N/8 bit N%8 = key position N pressed. Read-only.
    keyStateBitmap: 0x01,
    // combos (0x24) — enabled/count/timeout/keys are u16; slot is
    // a PAYLOAD-ADDRESSED byte frame [slot, pos x KEYS (0xFF empty), usage
    // u32 BE]. KEYS = combosKeys on v9+ (RO), 4 on v7/v8 firmware.
    combosEnabled: 0x01, combosSlotCount: 0x02, combosTimeout: 0x03,
    combosKeys: 0x04,
    combosSlot: 0x10,
    // v12 typed slot: [slot, pos x KEYS, action, behavior_id u16 BE,
    // param1 u32 BE, param2 u32 BE] — action 0 none / 1 usage-hold /
    // 2 play-macro / 3 invoke-behavior (Studio local id + two params).
    combosSlotV2: 0x11,
    // v14 timed slot: the v2 frame + [timeout u16 BE, prior-idle u16 BE,
    // layer index (0xFF = all)] — the imported devicetree combos' knobs.
    combosSlotV3: 0x12,
    // macros (0x25) — enabled/counts/pacing are u16; state is
    // live-only (GET = playing slot+1 or 0; SET v>0 plays v-1, 0 stops);
    // step is a PAYLOAD-ADDRESSED byte frame [slot, step, action, param u32 BE]
    macrosEnabled: 0x01, macrosSlotCount: 0x02, macrosStepCount: 0x03,
    macrosTapMs: 0x04, macrosWaitMs: 0x05, macrosState: 0x06,
    macrosStep: 0x10,
    // scroll snap (0x26, v9) — all u16
    snapEnabled: 0x01, snapThreshold: 0x02, snapSamples: 0x03,
    snapImmediate: 0x04, snapLockMs: 0x05, snapLockEvents: 0x06,
    snapIdleReset: 0x07,
    // ball swap (0x27, v11) — u16. swapped = persisted base state
    // (SET applies live; SAVE or the &bswap 0 key persists); effective is
    // RO = base XOR momentary &bswap 1 holds.
    bswapSwapped: 0x01, bswapEffective: 0x02,
    // rgb brightness (0x21, v14) — global percent 0-100, scales
    // every rendered pixel on both halves.
    rgbmapBrightness: 0x0B,
    // v16: seconds of KEYBOARD inactivity before the strip blanks; 0 = never.
    // The firmware floors anything below its compiled ZMK idle timeout (30 s)
    // — that event is the earliest signal flask_rgb gets.
    rgbmapIdleTimeout: 0x0C,
    // tap dance (0x28, v14) — enabled/counts u16; step + cfg are
    // PAYLOAD-ADDRESSED byte frames: step [slot, tap, action, behavior u16
    // BE, p1 u32 BE, p2 u32 BE], cfg [slot, term u16 BE (0 = default 200)].
    tdEnabled: 0x01, tdSlotCount: 0x02, tdTaps: 0x03,
    tdStep: 0x50, tdCfg: 0x51,
    // adaptive keys (0x2B, v18) — enabled/counts u16 (counts RO); payload-
    // addressed byte frames: rule [rule, set, trigger u32 BE (id 0-15, page
    // 16-23, mods 24-31; 0 = delete), max idle ms u16 BE, flags (bit0 exact
    // mods)], step [rule, step, action, behavior u16, p1 u32, p2 u32] (the
    // tap-dance step frame), fallback [set, action, behavior u16, p1, p2].
    akEnabled: 0x01, akSetCount: 0x02, akRuleCount: 0x03, akStepCount: 0x04,
    akRule: 0x50, akStep: 0x51, akFallback: 0x52,
};

// ---------- typed operations over a FlaskHID ----------

export class FlaskProto {
    constructor(hid) { this.hid = hid; }

    _u16(r) { return (r[3] << 8) | r[4]; }

    async getU16(channel, valueID) {
        const r = await this.hid.request([CMD.get, channel, valueID]);
        if (r[0] !== CMD.get) throw new Error('unhandled');
        return this._u16(r);
    }

    async getI16(channel, valueID) {
        const v = await this.getU16(channel, valueID);
        return (v << 16) >> 16; // sign-extend
    }

    /** Returns the value the firmware actually applied (clamp-echo). */
    async setU16(channel, valueID, value) {
        // Clamp in wire-width (u16) space BEFORE any narrowing — a bare i8
        // cast once wrapped 200 → −56 on hardware.
        const v = Math.max(0, Math.min(0xFFFF, Math.round(value))) & 0xFFFF;
        const r = await this.hid.request([CMD.set, channel, valueID, v >> 8, v & 0xFF]);
        if (r[0] !== CMD.set) throw new Error('unhandled');
        return this._u16(r);
    }

    async setI16(channel, valueID, value) {
        const wire = value & 0xFFFF;
        const r = await this.hid.request([CMD.set, channel, valueID, wire >> 8, wire & 0xFF]);
        if (r[0] !== CMD.set) throw new Error('unhandled');
        return (this._u16(r) << 16) >> 16;
    }

    async save(channel) {
        // Saves run flash writes device-side and the echo arrives only when
        // they land — a mass slot delete can legitimately take seconds
        // (bench 5: the 500 ms timeout fired, the RETRY then bounced off
        // the firmware's one-save-in-flight guard and echoed unhandled).
        // Wait patiently, never retry a save.
        const r = await this.hid.request([CMD.save, channel, 0], 0,
            { timeoutMs: 6000, retries: 0 });
        if (r[0] !== CMD.save) throw new Error('unhandled');
    }

    /** Payload-addressed GET (RGB map led, combo/macro slots). Returns
     * frame bytes 3+. `echoBytes` = how many leading payload bytes the reply
     * must echo (the frame's address prefix) — pass it for every slot-table
     * frame so a stale late reply for another slot can't be adopted. */
    async getBytes(channel, valueID, payload, echoBytes = 0) {
        const r = await this.hid.request([CMD.get, channel, valueID, ...payload], echoBytes);
        if (r[0] !== CMD.get) throw new Error('unhandled');
        return r.slice(3);
    }

    /** Payload-addressed SET (RGB paint/fill, combo/macro slots). Returns
     * the echoed payload — the firmware answers in place with what actually
     * stuck (normalized slots), and the ZMK combo/macro tabs adopt that
     * echo. `echoBytes` as in getBytes. */
    async setBytes(channel, valueID, payload, echoBytes = 0) {
        const r = await this.hid.request([CMD.set, channel, valueID, ...payload], echoBytes);
        if (r[0] !== CMD.set) throw new Error('unhandled');
        return r.slice(3);
    }

    /** Flask handshake: protocol version, or null if the firmware has no
     * Flask surface. */
    async handshake() {
        try {
            return await this.getU16(CH.meta, V.metaProtocolVersion);
        } catch {
            return null; // timeout or unhandled → no Flask surface
        }
    }
}
