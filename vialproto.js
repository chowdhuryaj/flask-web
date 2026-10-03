// Vial / VIA wire-protocol constants and codecs. Port of AdeptCompanion
// Sources/AdeptCore/VialProtocol.swift; the firmware sources
// (quantum/via.h, quantum/vial.h, quantum/vial.c, quantum/dynamic_keymap.c,
// quantum/qmk_settings.c) are the single source of truth.
//
// Framing recap:
// - All packets 32 bytes. VIA commands: byte 0 = command id; device echoes
//   the buffer back with response fields filled in.
// - Vial commands: byte 0 = 0xFE, byte 1 = sub-command. Responses OVERWRITE
//   the buffer from byte 0 — match by ordering, not header.
// - Keymap keycodes are BIG-endian on the wire; dynamic-entry structs are
//   LITTLE-endian raw struct copies.

export const VIA = {
    getProtocolVersion: 0x01,
    getKeyboardValue: 0x02,
    setKeyboardValue: 0x03,
    dynamicKeymapGetKeycode: 0x04,
    dynamicKeymapSetKeycode: 0x05,
    dynamicKeymapReset: 0x06,
    // 0x07-0x09 = the Flask custom-value channel (flaskproto.js CMD)
    bootloaderJump: 0x0B, // unlock-gated in vial builds
    macroGetCount: 0x0C,
    macroGetBufferSize: 0x0D,
    macroGetBuffer: 0x0E,
    macroSetBuffer: 0x0F, // unlock-gated (quantum/via.c)
    macroReset: 0x10,
    keymapGetLayerCount: 0x11,
    keymapGetBuffer: 0x12,
    keymapSetBuffer: 0x13,
    vialPrefix: 0xFE,
};

export const VIA_KB_VALUE = {
    uptime: 0x01,
    layoutOptions: 0x02,
    switchMatrixState: 0x03, // unlock-gated "wannabe keylogger" guard
};

export const VIAL = {
    getKeyboardID: 0x00,
    getDefinitionSize: 0x01,
    getDefinition: 0x02,
    getEncoder: 0x03,
    setEncoder: 0x04,
    getUnlockStatus: 0x05,
    unlockStart: 0x06,
    unlockPoll: 0x07,
    lock: 0x08,
    qmkSettingsQuery: 0x09,
    qmkSettingsGet: 0x0A,
    qmkSettingsSet: 0x0B,
    qmkSettingsReset: 0x0C,
    dynamicEntryOp: 0x0D,
};

export const DYNAMIC_OP = {
    getNumberOfEntries: 0x00,
    tapDanceGet: 0x01, tapDanceSet: 0x02,
    comboGet: 0x03, comboSet: 0x04,
    keyOverrideGet: 0x05, keyOverrideSet: 0x06,
    altRepeatKeyGet: 0x07, altRepeatKeySet: 0x08,
};

// Max payload per keymap/macro buffer chunk (quantum/via.c: size <= 28).
export const BUFFER_CHUNK = 28;

// ---------- dynamic entry codecs (little-endian raw struct copies) ----------

const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const le = (v) => [v & 0xFF, (v >> 8) & 0xFF];

/** vial_tap_dance_entry_t — 10 bytes LE. */
export const TapDance = {
    decode(b) {
        return {
            onTap: u16le(b, 0), onHold: u16le(b, 2),
            onDoubleTap: u16le(b, 4), onTapHold: u16le(b, 6),
            tappingTerm: u16le(b, 8),
        };
    },
    encode(e) {
        return [...le(e.onTap), ...le(e.onHold), ...le(e.onDoubleTap),
                ...le(e.onTapHold), ...le(e.tappingTerm)];
    },
    empty() { return { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }; },
    isEmpty(e) { return !e.onTap && !e.onHold && !e.onDoubleTap && !e.onTapHold; },
};

/** vial_combo_entry_t — 10 bytes LE: 4 trigger keys + output. */
export const Combo = {
    decode(b) {
        return {
            inputs: [u16le(b, 0), u16le(b, 2), u16le(b, 4), u16le(b, 6)],
            output: u16le(b, 8),
        };
    },
    encode(e) { return [...e.inputs.flatMap(le), ...le(e.output)]; },
    empty() { return { inputs: [0, 0, 0, 0], output: 0 }; },
    isEmpty(e) { return e.inputs.every((k) => !k) && !e.output; },
};

/** vial_key_override_entry_t — 10 bytes LE. Mod masks are 8-bit real-mod
 *  format (LCTL 1, LSFT 2, LALT 4, LGUI 8, RCTL 16, RSFT 32, RALT 64, RGUI 128). */
export const KeyOverride = {
    opt: {
        activationTriggerDown: 1 << 0,
        activationRequiredModDown: 1 << 1,
        activationNegativeModUp: 1 << 2,
        oneMod: 1 << 3,
        noReregisterTrigger: 1 << 4,
        noUnregisterOnOtherKeyDown: 1 << 5,
        enabled: 1 << 7,
    },
    // vial-gui's defaults for a fresh override: three activation bits + enabled.
    defaultOptions: 0b10000111,
    decode(b) {
        return {
            trigger: u16le(b, 0), replacement: u16le(b, 2), layers: u16le(b, 4),
            triggerMods: b[6], negativeModMask: b[7], suppressedMods: b[8], options: b[9],
        };
    },
    encode(e) {
        return [...le(e.trigger), ...le(e.replacement), ...le(e.layers),
                e.triggerMods, e.negativeModMask, e.suppressedMods, e.options];
    },
    empty() {
        return { trigger: 0, replacement: 0, layers: 0xFFFF,
                 triggerMods: 0, negativeModMask: 0, suppressedMods: 0,
                 options: KeyOverride.defaultOptions };
    },
    isEmpty(e) { return !e.trigger && !e.replacement; },
};

/** vial_alt_repeat_key_entry_t — 6 bytes LE. */
export const AltRepeat = {
    opt: { defaultToThisAltKey: 1, bidirectional: 2, ignoreModHandedness: 4, enabled: 8 },
    decode(b) {
        return { keycode: u16le(b, 0), altKeycode: u16le(b, 2), allowedMods: b[4], options: b[5] };
    },
    encode(e) { return [...le(e.keycode), ...le(e.altKeycode), e.allowedMods, e.options]; },
    empty() { return { keycode: 0, altKeycode: 0, allowedMods: 0, options: 0 }; },
    isEmpty(e) { return !e.keycode && !e.altKeycode; },
};

// ---------- macro codec ----------
// Mirrors dynamic_keymap_macro_send (quantum/dynamic_keymap.c) + Vial's
// 16-bit extensions. Actions: {t:'text',s} {t:'tap'|'down'|'up',kc} {t:'delay',ms}

const SS = { prefix: 1, tap8: 1, down8: 2, up8: 3, delay: 4, tap16: 5, down16: 6, up16: 7 };
export const MACRO_MAX_DELAY = 254 + 254 * 255;

export const MacroCodec = {
    decode(buffer, count) {
        const macros = [];
        let current = [], text = [];
        const flushText = () => {
            if (text.length) {
                current.push({ t: 'text', s: new TextDecoder().decode(new Uint8Array(text)) });
                text = [];
            }
        };
        const endMacro = () => { flushText(); macros.push(current); current = []; };
        let i = 0;
        while (i < buffer.length && macros.length < count) {
            const byte = buffer[i];
            if (byte === 0) { endMacro(); i++; continue; }
            if (byte === SS.prefix && i + 1 < buffer.length) {
                const op = buffer[i + 1];
                if (op === SS.tap8 || op === SS.down8 || op === SS.up8) {
                    if (i + 2 >= buffer.length || buffer[i + 2] === 0) break;
                    flushText();
                    const t = op === SS.tap8 ? 'tap' : op === SS.down8 ? 'down' : 'up';
                    current.push({ t, kc: buffer[i + 2] });
                    i += 3;
                } else if (op === SS.tap16 || op === SS.down16 || op === SS.up16) {
                    if (i + 3 >= buffer.length || buffer[i + 2] === 0 || buffer[i + 3] === 0) break;
                    flushText();
                    // LE, with the firmware's zero-byte escape:
                    // wire 0xFF01 => keycode 0x0100 (decode_keycode in dynamic_keymap.c).
                    let kc = buffer[i + 2] | (buffer[i + 3] << 8);
                    if (kc > 0xFF00) kc = (kc & 0xFF) << 8;
                    const t = op === SS.tap16 ? 'tap' : op === SS.down16 ? 'down' : 'up';
                    current.push({ t, kc });
                    i += 4;
                } else if (op === SS.delay) {
                    if (i + 3 >= buffer.length || buffer[i + 2] === 0 || buffer[i + 3] === 0) break;
                    flushText();
                    current.push({ t: 'delay', ms: (buffer[i + 2] - 1) + (buffer[i + 3] - 1) * 255 });
                    i += 4;
                } else {
                    break; // unknown op after prefix = end-of-parse (firmware behavior)
                }
                continue;
            }
            text.push(byte);
            i++;
        }
        if (current.length || text.length) endMacro();
        while (macros.length < count) macros.push([]);
        return macros;
    },

    /** Encodes ALL macros into one buffer image; null if a keycode can't be
     *  represented (collides with the 0xFF00 escape range). */
    encode(macros) {
        const out = [];
        for (const macro of macros) {
            for (const a of macro) {
                if (a.t === 'text') {
                    for (const ch of new TextEncoder().encode(a.s)) {
                        if (ch !== 0 && ch < 0x80 && ch !== SS.prefix) out.push(ch);
                    }
                } else if (a.t === 'delay') {
                    const ms = Math.min(Math.max(a.ms, 0), MACRO_MAX_DELAY);
                    out.push(SS.prefix, SS.delay, (ms % 255) + 1, Math.floor(ms / 255) + 1);
                } else {
                    const kc = a.kc;
                    if (!kc) continue;
                    const [small, wide] = a.t === 'tap' ? [SS.tap8, SS.tap16]
                        : a.t === 'down' ? [SS.down8, SS.down16] : [SS.up8, SS.up16];
                    if (kc <= 0xFF) {
                        out.push(SS.prefix, small, kc);
                    } else {
                        let wire = kc;
                        if ((kc & 0xFF) === 0) wire = 0xFF00 | (kc >> 8);
                        if (wire > 0xFF00 && (kc & 0xFF) !== 0) return null;
                        out.push(SS.prefix, wide, wire & 0xFF, wire >> 8);
                    }
                }
            }
            out.push(0);
        }
        return out;
    },
};

// ---------- QMK Settings catalog ----------
// Curated map of the QSIDs compiled into this firmware family
// (quantum/qmk_settings.c protos[] + widths in qmk_settings.h). The device's
// qmkSettingsQuery decides what actually shows; unknown QSIDs render raw.
// kind: {bool:true} | {min,max} | {bits:[[bit,label],...]}

export const QMK_SETTINGS = [
    { qsid: 1, label: 'Grave Escape overrides', group: 'Grave Escape', width: 1, bits: [
        [0, 'Always send Escape if Alt is pressed'],
        [1, 'Always send Escape if Ctrl is pressed'],
        [2, 'Always send Escape if GUI is pressed'],
        [3, 'Always send Escape if Shift is pressed'],
    ] },
    { qsid: 2, label: 'Combo term (ms)', group: 'Combo', width: 2, min: 5, max: 500 },
    // Bits mirror quantum/qmk_settings.h QS_auto_shift_*. Retro Shift
    // (Svalboard) needs bit 0 here AND Retro tapping (QSID 24) ON.
    { qsid: 3, label: 'Auto Shift', group: 'Auto Shift', width: 1, bits: [
        [0, 'Enable Auto Shift (also gates Retro Shift)'],
        [1, 'Auto Shift the modifiers'],
        [2, "Don't Auto Shift special keys"],
        [3, "Don't Auto Shift numeric keys"],
        [4, "Don't Auto Shift alpha keys"],
        [5, 'Auto Shift repeat'],
        [6, 'Auto Shift no auto-repeat'],
    ] },
    { qsid: 4, label: 'Auto Shift timeout (ms)', group: 'Auto Shift', width: 2, min: 50, max: 1000 },
    { qsid: 5, label: 'One Shot tap toggle count', group: 'One Shot Keys', width: 1, min: 0, max: 20 },
    { qsid: 6, label: 'One Shot timeout (ms)', group: 'One Shot Keys', width: 2, min: 0, max: 5000 },
    { qsid: 7, label: 'Tapping term (ms)', group: 'Tapping', width: 2, min: 50, max: 1000 },
    { qsid: 9, label: 'Mouse keys delay (ms)', group: 'Mouse Keys', width: 2, min: 0, max: 1000 },
    { qsid: 10, label: 'Mouse keys interval (ms)', group: 'Mouse Keys', width: 2, min: 1, max: 255 },
    { qsid: 11, label: 'Mouse keys move delta', group: 'Mouse Keys', width: 2, min: 1, max: 100 },
    { qsid: 12, label: 'Mouse keys max speed', group: 'Mouse Keys', width: 2, min: 1, max: 255 },
    { qsid: 13, label: 'Mouse keys time to max (ms)', group: 'Mouse Keys', width: 2, min: 0, max: 255 },
    { qsid: 14, label: 'Mouse wheel delay (ms)', group: 'Mouse Keys', width: 2, min: 0, max: 1000 },
    { qsid: 15, label: 'Mouse wheel interval (ms)', group: 'Mouse Keys', width: 2, min: 1, max: 255 },
    { qsid: 16, label: 'Mouse wheel max speed', group: 'Mouse Keys', width: 2, min: 1, max: 255 },
    { qsid: 17, label: 'Mouse wheel time to max (ms)', group: 'Mouse Keys', width: 2, min: 0, max: 255 },
    { qsid: 18, label: 'Tap code delay (ms)', group: 'Tapping', width: 2, min: 0, max: 100 },
    { qsid: 19, label: 'Tap-hold Caps delay (ms)', group: 'Tapping', width: 2, min: 0, max: 200 },
    { qsid: 20, label: 'Tapping toggle count', group: 'Tapping', width: 1, min: 0, max: 20 },
    // u32 keymap_config bitfield (magic_settings_get/set in qmk_settings.c).
    { qsid: 21, label: 'Magic', group: 'Magic', width: 4, bits: [
        [0, 'Swap Ctrl and Caps Lock'],
        [1, 'Treat Caps Lock as Ctrl'],
        [2, 'Swap Left Alt and GUI'],
        [3, 'Swap Right Alt and GUI'],
        [4, 'Disable the GUI keys'],
        [5, 'Swap ` and Escape'],
        [6, 'Swap \\ and Backspace'],
        [7, 'N-key rollover'],
        [8, 'Swap Left Ctrl and GUI'],
        [9, 'Swap Right Ctrl and GUI'],
    ] },
    { qsid: 22, label: 'Permissive hold', group: 'Tapping', width: 1, bool: true },
    { qsid: 23, label: 'Hold on other key press', group: 'Tapping', width: 1, bool: true },
    { qsid: 24, label: 'Retro tapping', group: 'Tapping', width: 1, bool: true },
    { qsid: 25, label: 'Quick tap term (ms)', group: 'Tapping', width: 2, min: 0, max: 500 },
    { qsid: 26, label: 'Chordal hold', group: 'Tapping', width: 1, bool: true },
    { qsid: 27, label: 'Flow tap term (ms)', group: 'Tapping', width: 2, min: 0, max: 500 },
];
