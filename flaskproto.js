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
};

export const V = {
    // meta
    metaProtocolVersion: 0x01,
    metaActiveLayer: 0x02, // v10 RO: highest active layer (HUD feed)
    metaFamily: 0x03,      // ZMK line only: numeric family code (zmk.js ZMK_FAMILY_CODES)
    // accel (x100-scaled floats on the wire; offset is SIGNED)
    accelEnabled: 0x01, accelTakeoff: 0x02, accelGrowth: 0x03,
    accelOffset: 0x04, accelLimit: 0x05,
    // gestures
    gesturesRatchetStep: 0x01, gesturesActiveSet: 0x02,
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
    // leader
    leaderTimeout: 0x01, // NLKB16 fw v5+: live timeout ms, clamped 100..2000
    // autoscroll
    asInverted: 0x01, asSpeedScale: 0x02, asDeadzone: 0x03, asRange: 0x04,
    asState: 0x05,     // live: GET signed level / ±100 jogging; SET force-stops
    asStopOnKey: 0x06, // trackballs v11+, NLKB16 v4+
    // auto-mouse
    amEnabled: 0x01, amTimeout: 0x02, amThreshold: 0x03, amLayer: 0x04,
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
    // PAYLOAD-ADDRESSED byte frames (getBytes/setBytes, never u16 helpers)
    rgbmapEnabled: 0x01, rgbmapLayers: 0x02, rgbmapLeds: 0x03,
    rgbmapLed: 0x10, rgbmapBulk: 0x11, rgbmapFill: 0x12,
    // display (0x22)
    dispHoldMs: 0x01, dispActive: 0x02, dispPushAge: 0x03,
    dispI2CFails: 0x04, dispI2CRecovers: 0x05, dispI2CScan: 0x06,
    dispRawCmd: 0x07, dispReinit: 0x08, dispWidgetCount: 0x09,
    dispSleepS: 0x0A, dispOverlayMs: 0x0B,
    dispLine: 0x0C, // fw v6: rendered-line mirror — HUD OLED tile feed
    dispPush: 0x10, dispRelease: 0x11,
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
        const r = await this.hid.request([CMD.save, channel, 0]);
        if (r[0] !== CMD.save) throw new Error('unhandled');
    }

    /** Payload-addressed GET (RGB map led, display line mirror). Returns frame bytes 3+. */
    async getBytes(channel, valueID, payload) {
        const r = await this.hid.request([CMD.get, channel, valueID, ...payload]);
        if (r[0] !== CMD.get) throw new Error('unhandled');
        return r.slice(3);
    }

    /** Payload-addressed SET (RGB paint/fill, display push). */
    async setBytes(channel, valueID, payload) {
        const r = await this.hid.request([CMD.set, channel, valueID, ...payload]);
        if (r[0] !== CMD.set) throw new Error('unhandled');
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
