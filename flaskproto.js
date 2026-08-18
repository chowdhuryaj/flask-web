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
// The Svalboard's line left the Adept's at v12 (2026-08-08), ran to v17
// (corner combos), then v18 REMOVED four channels — accel 0x10, smoothing
// 0x13, snippets 0x24, teleport 0x26 — v19 made corner-combo outputs
// universal, v20 added mouse-button behaviours (0x29), and v21 finally
// honoured high-resolution scroll (0x15/0x08). The Adept and NLKB16 are frozen where they are: the desktop app
// dropped both devices, so nothing advances those numbers.
//
// A removed channel answers id_unhandled, which this app already reads as
// "device lacks this feature" — so an older build degrades rather than breaks.
// The caps gates exist so the UI stops OFFERING what the board no longer has.
export const EXPECTED_PROTOCOL = { adept: 11, svalboard: 23, nlkb16: 8 };

// VIA custom-value command IDs (routed to the keymap by VIA_CUSTOM_LIGHTING_ENABLE).
export const CMD = { set: 0x07, get: 0x08, save: 0x09, unhandled: 0xFF };

// ⚠ 0x23-0x28 ARE DOUBLE-BOOKED across the two firmware lines.
//
// The QMK line (Svalboard v12-v17) and the ZMK line (Imprint v5-v15) allocated
// the same channel numbers independently, for unrelated features. Both sets of
// names live here because they never coexist on one device: a connection is one
// family, and every consumer is behind a caps.js gate that only one family can
// pass. The rule that keeps that true —
//
//   NEVER read a channel constant a device's family doesn't serve. Gate the
//   call site on caps, and name the constant from the line you are on
//   (CH.snippets in a Svalboard path, CH.combos in an Imprint path), so the
//   line is legible at the call site and not just in this table.
//
// Anything that enumerates channels generically (vil.js's spec, offline.js's
// LIVE_SET) must therefore be built per-family too — see the caps checks there.
export const CH = {
    meta: 0x00,
    accel: 0x10, gestures: 0x11, wiggle: 0x12, smoothing: 0x13,
    dpi: 0x14, dragScroll: 0x15,
    customShift: 0x16, selectWord: 0x17, sentenceCase: 0x18, leader: 0x19,
    autoscroll: 0x1A, autoMouse: 0x1B, wheelChords: 0x1C, os: 0x1D,
    numWord: 0x1E, diag: 0x1F, comboLayers: 0x20, rgbMap: 0x21, display: 0x22,
    // --- QMK line (Svalboard) ---
    cyclotab: 0x23,     // v12+: Alt-Tab / Cmd-Tab modifier swapper
    snippets: 0x24,     // v12+: 16-slot text pool (Super Leader + SNIP keys)
    altRepeat: 0x25,    // v13+: alt-repeat chaining + stale-input default
    teleport: 0x26,     // v12+: absolute cursor jumps (digitizer or host warp)
    ballGesturesRight: 0x27, // v15+: second ball-gesture table (cursor ball)
    corner: 0x28,       // v17+: positional corner combos
    mouseButtons: 0x29, // v20+: double-click gap + click-lock latch
    // --- ZMK line (Imprint) ---
    keyState: 0x23, // ZMK line v5+: pressed-position bitmap (HUD press feed)
    combos: 0x24,   // ZMK line v7+: flask_combos runtime combo slots
    macros: 0x25,   // ZMK line v8+: flask_macros runtime macro steps
    scrollSnap: 0x26, // ZMK line v9+: flask_scrollsnap axis snap/lock
    ballSwap: 0x27, // ZMK line v11+: flask_ballswap trackball role swap
    tapDance: 0x28, // ZMK line v14+: flask_tapdance runtime tap dances
    scrollScale: 0x29, // ZMK line v15+: flask_scrollscale live scroll speed
};

/// The left/scroll ball's gesture table. Same value ids as
/// CH.ballGesturesRight, so one editor drives either by channel.
export const CH_BALL_LEFT = CH.wheelChords;

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
    // v21: hi-res scroll. A MODE (0 off / 1 on / 2 follow OS) rather than a
    // toggle — the firmware cannot see whether the host enabled the HID
    // Resolution Multiplier, and guessing wrong scrolls 120x too far or 1/120th
    // too little. 0x09 is read-only: what "follow" resolves to right now.
    dragHiresMode: 0x08, dragHiresActive: 0x09,
    dragInvertX: 0x0A, // retired (was ZMK-line only; no current family exposes it)
    // custom shift keys — 0x01/0x02 shared with QMK; 0x50 is the ZMK-line
    // v14 slot frame [slot, base u32 BE, shifted u32 BE] (ZMK keymap
    // encoding — QMK's u16 pair tables at 0x10+/0x30+ can't carry it)
    cskEnabled: 0x01, cskSlotCount: 0x02,
    cskSlot: 0x50,
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
    // Super Leader (Svalboard v12+) — SAME channel 0x19 and the same stride-8
    // slot addressing, but the slots MEAN something else: 16 sequences instead
    // of 8, and pos 5 is an output KIND with the output itself at pos 6. Branch
    // on caps.superLeader before reading either shape; timeout also reclamps
    // (200-10000 here vs 100-2000 on the original).
    slTimeout: 0x01,
    slLiveCount: 0x02, // RO: sequences the firmware considers firable
    // Text snippets (0x24, Svalboard v12+). count/len/keyCount are u16;
    // the per-slot text at 0x10+i is PAYLOAD-ADDRESSED and chunked
    // ([chunk, 16 chars] each way) because 64 bytes exceed one 29-byte payload.
    snipCount: 0x01, snipLen: 0x02, snipChunkSize: 0x03, snipKeyCount: 0x04,
    // Alt-repeat behaviour (0x25, Svalboard v13+). Layered on VIAL'S OWN
    // dynamic alt-repeat table — there is no separate rule table here.
    arepChain: 0x01, arepStaleMs: 0x02, arepDefaultOut: 0x03,
    // Cyclotab (0x23, Svalboard v12+). The hotkey slots hold ordinary mod+key
    // keycodes, so arming it costs no custom keycode — putting one in the
    // layout is what arms it.
    cycEnabled: 0x01, cycTimeout: 0x02,
    // Cursor teleport (0x26, Svalboard v12+).
    tpEnabled: 0x01, tpHoldMs: 0x02, tpCount: 0x03, tpCurrent: 0x04,
    tpHostMode: 0x05,  // v15: prefer a host-side warp while proven
    tpHeartbeat: 0x06, // v15: SET = "a host app is here"; GET = host mode live?
    tpSelfTest: 0x07,  // v16: SET emits one event frame; GET = host proven?
    tpHostAck: 0x08,   // v16: SET acks a received frame (latches host mode)
    // Corner combos (0x28, Svalboard v17+). enabled/term/counts/misfires/
    // capture are u16; def/out/layers are PAYLOAD-ADDRESSED byte frames.
    // Mouse-button behaviours (0x29, Svalboard v20+). The latch mask is LIVE
    // state: GET reads which buttons are held, and ANY set releases them all —
    // the firmware deliberately refuses to latch a button from the host.
    mbDoubleGap: 0x01, mbLockMask: 0x02,
    ccEnabled: 0x01, ccTerm: 0x02, ccDefCount: 0x03, ccOutCount: 0x04,
    ccMisfires: 0x05, ccCapture: 0x06, ccCaptureBase: 0x08,
    // v22 RO: chords that got NO combo slot (the 64-slot budget ran out), and
    // slots in use. Nonzero unplaced means some chord is silently dead.
    // v23: 0x07 was a verbatim duplicate of ccFires (so this read the fire
    // count and the budget alarm fired as soon as a chord was used) and 0x09
    // is corner capture position 1.
    ccUnplaced: 0x0B, ccSlotsUsed: 0x0C,
    ccDef: 0x10, ccOut: 0x11, ccLayers: 0x12,
    // autoscroll
    asInverted: 0x01, asSpeedScale: 0x02, asDeadzone: 0x03, asRange: 0x04,
    asState: 0x05,     // live: GET signed level / ±100 jogging; SET force-stops
    asStopOnKey: 0x06, // trackballs v11+, NLKB16 v4+
    // auto-mouse — 0x01-0x04 shared with QMK; 0x05 is a ZMK-line v13
    // addition (flask_automouse: timeout 0 = latch until a transparent
    // key, extend re-arms the timeout on non-transparent keys)
    amEnabled: 0x01, amTimeout: 0x02, amThreshold: 0x03, amLayer: 0x04,
    amExtend: 0x05,
    // scroll speed (flask_scrollscale, ZMK line v15+). A PERCENT of the
    // keymap's compiled divisors, not an absolute rate: 100 = the firmware's
    // benched default, 200 = twice as fast. One knob drives both axes so
    // their base ratio (16 horizontal : 12 vertical on the Imprint) holds.
    scrollSpeedPct: 0x01,
    // wheel chords / ball gestures (0x1C left ball, 0x27 right ball — identical ids)
    wcEnabled: 0x01, wcStep: 0x02, wcHoldMs: 0x03,
    // v16: withhold a gesture-configured button's press until the hold resolves
    // into click / drag / gesture. NOT per-side despite living on both channels
    // — one physical button cannot defer on one ball and not the other, so both
    // channels back the same flag.
    wcDeferClick: 0x04,
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
    // v14 timed slot: the v2 frame + [timeout u16 BE, prior-idle u16 BE,
    // layer index (0xFF = all)] — the imported devicetree combos' knobs.
    combosSlotV3: 0x12,
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
    // rgb brightness (0x21, ZMK line v14) — global percent 0-100, scales
    // every rendered pixel on both halves.
    rgbmapBrightness: 0x0B,
    // v16: seconds of KEYBOARD inactivity before the strip blanks; 0 = never.
    // The firmware floors anything below its compiled ZMK idle timeout (30 s)
    // — that event is the earliest signal flask_rgb gets.
    rgbmapIdleTimeout: 0x0C,
    // tap dance (0x28, ZMK line v14) — enabled/counts u16; step + cfg are
    // PAYLOAD-ADDRESSED byte frames: step [slot, tap, action, behavior u16
    // BE, p1 u32 BE, p2 u32 BE], cfg [slot, term u16 BE (0 = default 200)].
    tdEnabled: 0x01, tdSlotCount: 0x02, tdTaps: 0x03,
    tdStep: 0x50, tdCfg: 0x51,
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
    // Super Leader shares the stride, so the same arithmetic; pos 5 = output
    // kind, pos 6 = keycode or snippet index.
    superLeader(seq, pos) { return 0x10 + seq * 8 + pos; },
    wheelChord(button, dir) { return 0x10 + button * 8 + dir; },
    comboMask(i) { return 0x10 + i; },
    dispWidget(line) { return 0x20 + line; },
    dispCustom(line) { return 0x30 + line; },
    snippet(i) { return 0x10 + i; },          // payload-addressed text chunks
    snippetTarget(key) { return 0x40 + key; }, // which snippet a SNIP key types
    cyclotabKey(i) { return 0x10 + i; },
    teleportX(t) { return 0x10 + t; },
    teleportY(t) { return 0x20 + t; },
};

export const GESTURE_DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
export const GESTURE_SETS = 8;
export const CSK_SLOTS = 16;
export const LEADER_SEQS = 8;
export const LEADER_KEYS = 5;
export const WC_BUTTONS = 8;

// ---------- Svalboard v12-v17 shapes ----------

export const SL_SEQS = 16;      // Super Leader sequences
export const SL_KEYS = 5;       // keys per sequence
export const SL_KIND_POS = 5;   // slot 5 = output kind
export const SL_OUT_POS = 6;    // slot 6 = keycode, or snippet index
/** Mirrors enum flask_output_kind — shared by Super Leader and alt-repeat rules. */
export const OUTPUT_KIND = { keycode: 0, snippet: 1 };

export const SNIPPET_COUNT = 16;
export const SNIPPET_LEN = 64;   // buffer incl. NUL, so 63 usable characters
export const SNIPPET_CHUNK = 16; // chars per payload-addressed frame
export const SNIPPET_KEYS = 16;  // SNIP keycodes (4 before v15)

export const CYCLOTAB_KEYS = 4;

export const TELEPORT_TARGETS = 8;
/** Full scale: 1000 = right/bottom edge of the VIRTUAL DESKTOP, not one screen. */
export const TELEPORT_SCALE = 1000;
/** Unset sentinel — 0 would read as the top-left corner, a real position. */
export const TELEPORT_UNSET = 0xFFFF;

// Corner-combo def index layout, mirroring the firmware's corner_seed.h. This
// ordering is a wire contract shared with .vil files — never reorder it.
export const CC = {
    maxKeys: 2, // three-key chords were dropped 2026-08-14
    fingerClusters: 8, fingerChords: 6,
    thumbClusters: 2, thumbChords: 6,
    thumbBase: 48, // fingerClusters * fingerChords
    total: 60,
    posNone: 0xFF,
    clusterNames: ['L index', 'L middle', 'L ring', 'L pinky',
        'R index', 'R middle', 'R ring', 'R pinky'],
    fingerChordNames: ['North + East', 'East + South', 'South + West',
        'West + North', 'Center + South', 'South + DblSouth'],
    thumbChordNames: ['L + Esc', 'R + L', 'R + Esc', 'R + Del', 'R + Bspc', 'Del + Bspc'],
};

/** Switch positions pack as (row << 3) | col on the wire. */
export const ccRow = (p) => p >> 3;
export const ccCol = (p) => p & 0x07;

/** Human label for a def index, e.g. "L index · North + East". */
export function ccDefName(def) {
    if (def < CC.thumbBase) {
        const cluster = Math.floor(def / CC.fingerChords), chord = def % CC.fingerChords;
        if (cluster >= CC.clusterNames.length || chord >= CC.fingerChordNames.length) return `Chord ${def}`;
        return `${CC.clusterNames[cluster]} · ${CC.fingerChordNames[chord]}`;
    }
    const t = Math.floor((def - CC.thumbBase) / CC.thumbChords);
    const chord = (def - CC.thumbBase) % CC.thumbChords;
    if (t >= CC.thumbClusters || chord >= CC.thumbChordNames.length) return `Chord ${def}`;
    return `${t === 0 ? 'L thumb' : 'R thumb'} · ${CC.thumbChordNames[chord]}`;
}

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

    /** Reads one text snippet (channel 0x24, Svalboard v12+). A 64-byte buffer
     * does not fit in a 29-byte payload, so this costs SNIPPET_LEN/SNIPPET_CHUNK
     * round trips; each frame is [chunk index, chars...] both ways. Text ends at
     * the first NUL. */
    async getSnippet(index) {
        const bytes = [];
        for (let chunk = 0; chunk < SNIPPET_LEN / SNIPPET_CHUNK; chunk++) {
            const r = await this.getBytes(CH.snippets, slot.snippet(index), [chunk], 1);
            bytes.push(...r.slice(1, 1 + SNIPPET_CHUNK));
        }
        const end = bytes.indexOf(0);
        return new TextDecoder().decode(new Uint8Array(end < 0 ? bytes : bytes.slice(0, end)));
    }

    /** Writes one snippet, NUL-terminated and zero-padded to the full buffer so
     * a shorter string never leaves the old tail behind. */
    async setSnippet(index, text) {
        const utf8 = Array.from(new TextEncoder().encode(text)).slice(0, SNIPPET_LEN - 1);
        while (utf8.length < SNIPPET_LEN) utf8.push(0);
        for (let chunk = 0; chunk < SNIPPET_LEN / SNIPPET_CHUNK; chunk++) {
            const start = chunk * SNIPPET_CHUNK;
            await this.setBytes(CH.snippets, slot.snippet(index),
                [chunk, ...utf8.slice(start, start + SNIPPET_CHUNK)], 1);
        }
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
