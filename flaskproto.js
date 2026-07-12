// Flask raw-HID tuning protocol constants + typed operations.
// Port of AdeptCompanion Sources/AdeptCore/AdeptProtocol.swift — that file
// and the firmware handlers (vial-qmk keyboards/*/keymaps/*/keymap.c
// raw_hid_receive_kb) are the source of truth; every constant cites them.
//
// Frame shape: [cmd, channel, value_id, payload...]. u16 payloads are
// BIG-endian at bytes [3],[4] — opposite of Vial's little-endian structs.
// Setters CLAMP firmware-side and echo the applied value; callers must
// adopt the echo (see ui.js sliderRow).

// QMK families only — ZMK identity/versions live in zmk.js (different
// firmware language; only the frame vocabulary below is shared).
export const VIDPID = {
    adept: { vid: 0x5043, pid: 0x5C47 },
    svalboard: { vid: 0x303A, pid: 0x4044 },
    nlkb16: { vid: 0xD020, pid: 0x1603 },
};

// Per-family protocol version lines — INDEPENDENT; never compare across.
export const EXPECTED_PROTOCOL = { adept: 11, svalboard: 11, nlkb16: 8 };

// VIA custom-value command IDs (routed to the keymap by VIA_CUSTOM_LIGHTING_ENABLE).
export const CMD = { set: 0x07, get: 0x08, save: 0x09, unhandled: 0xFF };

export const CH = {
    meta: 0x00,
    accel: 0x10, gestures: 0x11, wiggle: 0x12, smoothing: 0x13,
    dpi: 0x14, dragScroll: 0x15,
    customShift: 0x16, selectWord: 0x17, sentenceCase: 0x18, leader: 0x19,
    autoscroll: 0x1A, autoMouse: 0x1B, wheelChords: 0x1C, os: 0x1D,
    numWord: 0x1E, diag: 0x1F, comboLayers: 0x20, rgbMap: 0x21, display: 0x22,
    keyState: 0x23, // ZMK line v5+: pressed-position bitmap (HUD press feed)
    combos: 0x24,   // ZMK line v7+: flask_combos runtime combo slots
    macros: 0x25,   // ZMK line v8+: flask_macros runtime macro steps
    scrollSnap: 0x26, // ZMK line v9+: flask_scrollsnap axis snap/lock
    ballSwap: 0x27, // ZMK line v11+: flask_ballswap trackball role swap
};

export const V = {
    // meta
    metaProtocolVersion: 0x01,
    metaActiveLayer: 0x02, // v10 RO: highest active layer (HUD feed)
    metaFamily: 0x03,      // ZMK line only: numeric family code (zmk.js ZMK_FAMILY_CODES)
    metaResetCause: 0x04,  // ZMK line RO: hwinfo reset-cause bits at boot (crash forensics)
    // accel (x100-scaled floats on the wire; offset is SIGNED)
    accelEnabled: 0x01, accelTakeoff: 0x02, accelGrowth: 0x03,
    accelOffset: 0x04, accelLimit: 0x05,
    // gestures — 0x01/0x02 shared with QMK; 0x03/0x04/0x50 are ZMK-line
    // v10 additions (flask_gestures: typed-output slot frames at 0x50,
    // clear of the QMK families' u16 slot table 0x10-0x4F)
    gesturesRatchetStep: 0x01, gesturesActiveSet: 0x02,
    gesturesEnabled: 0x03, gesturesSetCount: 0x04,
    gesturesSlot: 0x50,
    // wiggle
    wiggleInterval: 0x01, wiggleCooldown: 0x02, wiggleThreshold: 0x03,
    wiggleEnabled: 0x04, wiggleAction: 0x05, wiggleSet: 0x06, wiggleSource: 0x07,
    // smoothing
    smoothingEnabled: 0x01, smoothingFactor: 0x02, smoothingTimeout: 0x03,
    // dpi
    dpiIndex: 0x01,
    dpiCpi: 0x02,          // v10 Adept: raw CPI [200,4000] step 50; 0 = table mode
    svalDpiLeft: 0x02, svalDpiRight: 0x03,        // Sval: per-side table index
    svalDpiLeftCpi: 0x04, svalDpiRightCpi: 0x05,  // v10 Sval: raw per-side CPI
    // drag scroll
    dragDivH: 0x01, dragDivV: 0x02, dragInverted: 0x03,
    dragActive: 0x04, // live: GET diagnostic, SET force on/off — never persisted
    dragInterval: 0x06, dragMaxNotches: 0x07, // Sval extensions
    dragInvertX: 0x0A, // retired (was ZMK-line only; no current family exposes it)
    // custom shift keys
    cskEnabled: 0x01, cskSlotCount: 0x02,
    // select word
    selectWordMac: 0x01,
    // sentence case
    sentenceCaseEnabled: 0x01,
    // leader — 0x01 shared with QMK (NLKB16 fw v5+: live timeout ms);
    // 0x02-0x04/0x50 are ZMK-line v10 additions (flask_leader: typed-output
    // sequence frames at 0x50, clear of QMK's u16 slot table 0x10-0x4D)
    leaderTimeout: 0x01,
    leaderSlotCount: 0x02, leaderKeys: 0x03, leaderEnabled: 0x04,
    leaderSlot: 0x50,
    // autoscroll
    asInverted: 0x01, asSpeedScale: 0x02, asDeadzone: 0x03, asRange: 0x04,
    asState: 0x05,     // live: GET signed level / ±100 jogging; SET force-stops
    asStopOnKey: 0x06, // trackballs v11+, NLKB16 v4+
    // auto-mouse — 0x01-0x04 shared with QMK; 0x05 is a ZMK-line v13
    // addition (flask_automouse: timeout 0 = latch until a transparent
    // key, extend re-arms the timeout on non-transparent keys)
    amEnabled: 0x01, amTimeout: 0x02, amThreshold: 0x03, amLayer: 0x04,
    amExtend: 0x05,
    // wheel chords
    wcEnabled: 0x01, wcStep: 0x02, wcHoldMs: 0x03,
    // OS shortcuts
    osFollow: 0x01, osMac: 0x02, osDetected: 0x03,
    // num word
    nwTimeout: 0x01, nwLayer: 0x02, nwActive: 0x03,
    // freeze diagnostic
    diagMaxGap: 0x01, diagUptime: 0x02,
    // combo layer masks
    clCount: 0x01,
    // RGB map (0x21) — enabled/layers/leds are u16; led/bulk/fill are
    // PAYLOAD-ADDRESSED byte frames (getBytes/setBytes, never u16 helpers).
    // 0x04-0x08: ZMK-line effect engine (v9) — whole-strip animation
    // underneath the painted map (painted keys overlay the effect).
    rgbmapEnabled: 0x01, rgbmapLayers: 0x02, rgbmapLeds: 0x03,
    rgbmapEffect: 0x04, rgbmapEffectSpeed: 0x05,
    rgbmapEffectHue: 0x06, rgbmapEffectSat: 0x07, rgbmapEffectVal: 0x08,
    rgbmapSplitLink: 0x09, // ZMK line RO: central found the peripheral's rgb GATT char
    // v12: chunked runtime LED→keymap-position table [start, count, pos...]
    // (0xFF = no key / underglow) — the wizard's measured order, on-device.
    rgbmapLedOrder: 0x0A,
    rgbmapLed: 0x10, rgbmapBulk: 0x11, rgbmapFill: 0x12,
    // display (0x22)
    dispHoldMs: 0x01, dispActive: 0x02, dispPushAge: 0x03,
    dispI2CFails: 0x04, dispI2CRecovers: 0x05, dispI2CScan: 0x06,
    dispRawCmd: 0x07, dispReinit: 0x08, dispWidgetCount: 0x09,
    dispSleepS: 0x0A, dispOverlayMs: 0x0B,
    dispLine: 0x0C, // fw v6: rendered-line mirror — HUD OLED tile feed
    dispPush: 0x10, dispRelease: 0x11,
    // key state (0x23) — PAYLOAD-ADDRESSED byte frame (getBytes):
    // payload byte N/8 bit N%8 = key position N pressed. Read-only.
    keyStateBitmap: 0x01,
    // combos (0x24, ZMK line) — enabled/count/timeout/keys are u16; slot is
    // a PAYLOAD-ADDRESSED byte frame [slot, pos x KEYS (0xFF empty), usage
    // u32 BE]. KEYS = combosKeys on v9+ (RO), 4 on v7/v8 firmware.
    combosEnabled: 0x01, combosSlotCount: 0x02, combosTimeout: 0x03,
    combosKeys: 0x04,
    combosSlot: 0x10,
    // v12 typed slot: [slot, pos x KEYS, action, behavior_id u16 BE,
    // param1 u32 BE, param2 u32 BE] — action 0 none / 1 usage-hold /
    // 2 play-macro / 3 invoke-behavior (Studio local id + two params).
    combosSlotV2: 0x11,
    // macros (0x25, ZMK line) — enabled/counts/pacing are u16; state is
    // live-only (GET = playing slot+1 or 0; SET v>0 plays v-1, 0 stops);
    // step is a PAYLOAD-ADDRESSED byte frame [slot, step, action, param u32 BE]
    macrosEnabled: 0x01, macrosSlotCount: 0x02, macrosStepCount: 0x03,
    macrosTapMs: 0x04, macrosWaitMs: 0x05, macrosState: 0x06,
    macrosStep: 0x10,
    // scroll snap (0x26, ZMK line v9) — all u16
    snapEnabled: 0x01, snapThreshold: 0x02, snapSamples: 0x03,
    snapImmediate: 0x04, snapLockMs: 0x05, snapLockEvents: 0x06,
    snapIdleReset: 0x07,
    // ball swap (0x27, ZMK line v11) — u16. swapped = persisted base state
    // (SET applies live; SAVE or the &bswap 0 key persists); effective is
    // RO = base XOR momentary &bswap 1 holds.
    bswapSwapped: 0x01, bswapEffective: 0x02,
};

// Slot value-id helpers (append-only wire ids).
export const slot = {
    // Gestures: cardinals kept v2 ids, diagonals in a new block (protocol v3).
    // Internal direction order 0-7: E SE S SW W NW N NE.
    gesture(set, dir) {
        return dir % 2 === 0 ? 0x10 + set * 4 + dir / 2 : 0x30 + set * 4 + (dir - 1) / 2;
    },
    cskKey(i) { return 0x10 + i; },
    cskShift(i) { return 0x30 + i; },
    leader(seq, pos) { return 0x10 + seq * 8 + pos; }, // pos 0-4 keys, 5 output
    wheelChord(button, dir) { return 0x10 + button * 8 + dir; },
    comboMask(i) { return 0x10 + i; },
    dispWidget(line) { return 0x20 + line; },
    dispCustom(line) { return 0x30 + line; },
};

export const GESTURE_DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
export const GESTURE_SETS = 8;
export const CSK_SLOTS = 16;
export const LEADER_SEQS = 8;
export const LEADER_KEYS = 5;
export const WC_BUTTONS = 8;

// Mirrors MADROMYS_DPI_OPTIONS (Adept keymap config.h).
export const ADEPT_DPI_OPTIONS = [400, 600, 800, 1200, 1600];
// Mirrors dpi_choices[] (keyboards/svalboard/svalboard.c).
export const SVAL_DPI_OPTIONS = [200, 400, 600, 800, 1200, 1600, 2400, 3200, 4800, 6400, 12000];
// Mirrors mh_timer_choices[] (svalboard.c); -1 = never (∞).
export const SVAL_AUTOMOUSE_TIMEOUTS = [200, 300, 400, 500, 800, -1];
export const CPI_MIN = 200, CPI_MAX = 4000, CPI_STEP = 50;

export function osName(raw) {
    return { 1: 'Linux', 2: 'Windows', 3: 'macOS', 4: 'iOS' }[raw] || 'not detected yet';
}

// NLKB16 display/RGB geometry (mirrors NLK_DISPLAY_* / keyboard.json).
export const NLKB = {
    ledCount: 23, rgbLayers: 8, keyLeds: 16,
    bigLines: 4, visibleCols: 5,
    widgetNames: [
        'Blank', 'Layer', 'Uptime', 'Mods held', 'One-shot mods',
        'One-shot layer', 'Locks (C N S)', 'Caps Lock', 'Num Lock',
        'Scroll Lock', 'RGB map on', 'Num word on', 'Sentence case on',
        'Custom text', 'Layer name',
    ],
    widgetCustom: 13,
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
        // Clamp in wire-width (u16) space BEFORE any narrowing — the Swift app
        // shipped a bug where a bare i8 cast wrapped 200 → −56 on hardware.
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

    /** Payload-addressed GET (RGB map led, display line mirror). Returns
     * frame bytes 3+. `echoBytes` = how many leading payload bytes the reply
     * must echo (the frame's address prefix) — pass it for every slot-table
     * frame so a stale late reply for another slot can't be adopted. */
    async getBytes(channel, valueID, payload, echoBytes = 0) {
        const r = await this.hid.request([CMD.get, channel, valueID, ...payload], echoBytes);
        if (r[0] !== CMD.get) throw new Error('unhandled');
        return r.slice(3);
    }

    /** Payload-addressed SET (RGB paint/fill, display push, combo/macro
     * slots). Returns the echoed payload — the firmware answers in place
     * with what actually stuck (normalized slots), and the ZMK combo/macro
     * tabs adopt that echo. `echoBytes` as in getBytes. */
    async setBytes(channel, valueID, payload, echoBytes = 0) {
        const r = await this.hid.request([CMD.set, channel, valueID, ...payload], echoBytes);
        if (r[0] !== CMD.set) throw new Error('unhandled');
        return r.slice(3);
    }

    /** Flask handshake: protocol version, or null if firmware is plain Vial. */
    async handshake() {
        try {
            return await this.getU16(CH.meta, V.metaProtocolVersion);
        } catch {
            return null; // timeout or unhandled → no Flask surface
        }
    }
}
