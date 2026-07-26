// Keychron Nape Pro — wire protocol.
//
// The Nape runs ZMK underneath, but it speaks VIA on the wire (a VIA dynamic
// keymap grafted onto ZMK by Keychron's launcher layer), plus a Keychron
// user-command envelope on 0xA7. So this device belongs to the QMK/VIA side of
// the app, NOT the ZMK side — nothing here may import zmk*.js, and zmk*.js must
// never learn about it. See ~/ZMK-Flask/Nape-Pro/NAPE-PROTOCOL.md for the full
// derivation (live probe + Keychron/zmk@rtl8762g source + Launcher bundle).
//
// Everything below is config written into the device's own settings store.
// Nothing here flashes firmware, so the 2.4 GHz link, BLE, OctaShift
// orientation detection, gestures and DPI all keep working untouched.

export const NAPE_VIDPID = { vid: 0x3434, pid: 0x0440 };

// Geometry is fixed: 1 row x 7 keys, 9 layers.
//
// CORRECTION (2026-07-26, from AJ at the bench): layers and angles are NOT the
// same axis. An earlier reading of this protocol treated getLayerOri as "the
// orientation this layer is bound to" and rendered layers as orientations —
// wrong. The 45-degree-step value is ANGLE SNAP (the ball's direction lock),
// getLayerOri is the per-layer angle-snap setting, and layers are ordinary
// layers selected by layer keys. Current layer comes from KC_GET_CURRENT_LAYER.
export const NAPE_KEYS = 7;
export const NAPE_LAYERS = 9;

// Combo slots. The firmware echoes ANY index you send (no bounds check), so this
// cannot be probed from the device — 30 is what Keychron's Launcher exposes.
export const NAPE_COMBO_SLOTS = 30;

/** VIA command ids actually implemented by this firmware. */
export const VIA = {
    getProtocolVersion: 0x01,
    getKeyboardValue: 0x02,
    getKeycode: 0x04,
    setKeycode: 0x05,
    macroGetCount: 0x0C,
    macroGetBufferSize: 0x0D,
    macroGetBuffer: 0x0E,
    macroSetBuffer: 0x0F,
    getLayerCount: 0x11,
    getBuffer: 0x12,
    setBuffer: 0x13,
    kcProtocolVersion: 0xA0,
    kcFirmwareVersion: 0xA1,
    kcSupportFeature: 0xA2,
    kcDefaultLayer: 0xA3,
};

// NOTE: the Launcher's simulated-device table answers KC_GET_CURRENT_LAYER as
// [0xA3, 0x02, layer], but real 1.2.6 hardware IGNORES the sub-byte — both
// [0xA3] and [0xA3,0x02] return [0xA3, layer]. Matching on an echoed 0x02
// therefore never matches and times out the whole connect. Verified on device
// 2026-07-26. Anything taken from that fake table must be re-verified.

/** Keychron user-command envelope: [0xA7, sub, args...]. */
export const KC_MISC = 0xA7;

export const NAPE = {
    getOri: 0x20,
    getDpi: 0x21, setDpi: 0x22,
    setDpiValue: 0x23, getDpiValue: 0x24,
    setTapholds: 0x25, getTapholds: 0x26,
    setCombos: 0x27, getCombos: 0x28,
    setGesture: 0x29, getGesture: 0x2A,
    setProfile: 0x2B, getProfile: 0x2C,
    setLayer: 0x2D,
    delCombos: 0x2E, delTapholds: 0x2F,
    batReport: 0x30, getBatReport: 0x31,
    setForceGestureScroll: 0x32, getForceGestureScroll: 0x33,
    setOri: 0x34,
    getLayerOri: 0x38, setLayerOri: 0x39,
};

// Deliberately NOT exposed, at any layer of this app:
//   VIA 0x06 dynamic_keymap_reset, 0x0A eeprom_reset, 0x0B bootloader_jump
//   the whole FACTORY_TEST group — 3 = JUMP_TO_BL, 7 = RADIO_CARRIER, which
//   would disturb the radio the user explicitly wants left alone.
const FORBIDDEN_VIA = new Set([0x06, 0x0A, 0x0B]);
// Combo/taphold delete (0x2E/0x2F) is ordinary editing — one slot, re-addable —
// so it is allowed. Only whole-device wipes and the bootloader stay blocked.
const FORBIDDEN_NAPE = new Set();

// ---------- keycodes ----------

export const KC = {
    none: 0x0000,
    btn1: 0x00D1, btn2: 0x00D2, btn3: 0x00D3, btn4: 0x00D4, btn5: 0x00D5,
    tapHold: 0x7E29,      // CUSTOM(41) — behaviour comes from the tap/hold table
    scrollHold: 0x522A,   // MO(10)
    scrollToggle: 0x526A, // TG(10)
    gestureHold: 0x5229,  // MO(9)
};

export const QK = { to: 0x5200, mo: 0x5220, df: 0x5240, tg: 0x5260, osl: 0x5280, kb: 0x7E00 };

// Label table lifted from the Launcher bundle's own keycode->i18n map, which is
// the only published description of this device's CUSTOM(n) space.
const CUSTOM_LABELS = {
    28: 'Angle snap 0°', 29: 'Angle snap 45°', 30: 'Angle snap 90°',
    31: 'Angle snap 135°', 32: 'Angle snap 180°', 33: 'Angle snap 225°',
    34: 'Angle snap 270°', 35: 'Angle snap 315°',
    37: 'Next DPI', 38: 'Prev DPI',
    39: 'Prev polling rate', 40: 'Next polling rate',
    41: 'Tap / hold key', 43: 'Ball direction', 44: 'DPI loop', 45: 'Polling-rate loop',
    46: 'Double left-click', 47: 'Custom DPI',
};

const BASE_LABELS = {
    0x0000: 'None',
    0x00D1: 'Left click', 0x00D2: 'Right click', 0x00D3: 'Middle click',
    0x00D4: 'Back', 0x00D5: 'Forward',
};

/** Human label for a Nape keycode. */
export function napeKeyLabel(kc) {
    if (kc in BASE_LABELS) return BASE_LABELS[kc];
    if (kc === KC.gestureHold) return 'Gesture (hold)';
    if (kc === KC.scrollHold) return 'Scroll (hold)';
    if (kc === KC.scrollToggle) return 'Scroll (toggle)';
    for (const [base, fmt] of [[QK.to, 'Layer %d (switch)'], [QK.mo, 'Layer %d (hold)'],
        [QK.df, 'Layer %d (default)'], [QK.tg, 'Layer %d (toggle)'],
        [QK.osl, 'Layer %d (one-shot)']]) {
        if (kc >= base && kc <= base + 0x1F) return fmt.replace('%d', kc - base);
    }
    if (kc >= QK.kb && kc <= QK.kb + 0xFF) {
        const n = kc - QK.kb;
        return CUSTOM_LABELS[n] ?? `Device key ${n}`;
    }
    return `0x${kc.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Keycodes offered in the picker, grouped. */
export function napeKeycodeGroups() {
    const custom = (n) => QK.kb + n;
    return [
        { name: 'Buttons', codes: [KC.btn1, KC.btn2, KC.btn3, KC.btn4, KC.btn5, custom(46)] },
        { name: 'Ball modes', codes: [KC.scrollHold, KC.scrollToggle, KC.gestureHold, custom(43)] },
        { name: 'Tap / hold', codes: [KC.tapHold] },
        { name: 'DPI', codes: [custom(37), custom(38), custom(44), custom(47)] },
        { name: 'Polling rate', codes: [custom(39), custom(40), custom(45)] },
        { name: 'Angle snap', codes: [28, 29, 30, 31, 32, 33, 34, 35].map(custom) },
        { name: 'Layers', codes: Array.from({ length: NAPE_LAYERS }, (_, i) => QK.mo + i)
            .concat(Array.from({ length: NAPE_LAYERS }, (_, i) => QK.tg + i)) },
        { name: 'None', codes: [KC.none] },
    ];
}

// ---------- client ----------

export class NapeClient {
    constructor(hid) { this.hid = hid; }

    _via(prefix, echoBytes = 0) {
        if (FORBIDDEN_VIA.has(prefix[0])) {
            throw new Error(`refusing VIA command 0x${prefix[0].toString(16)} (destructive)`);
        }
        return this.hid.viaCommand(prefix, echoBytes);
    }

    /**
     * Keychron envelope. The reply echoes [0xA7, sub]; SLOT-ADDRESSED reads
     * echo their address after that, and those bytes MUST be matched on:
     * combo slot reads all share (0xA7,0x28), so a late reply for slot 1 —
     * arriving after its own request timed out — would otherwise satisfy the
     * in-flight slot-2 read and shift every slot after it by one.
     *
     * Verified echo widths on 1.2.6 hardware:
     *   combo get  [A7,28,index]          -> index at r[2]        echo 2
     *   taphold    [A7,26,layer,0,col]    -> layer/row/col r[2:4] echo 4
     *   layer angle[A7,38,layer]          -> r[2] is the ANGLE,
     *                                        the layer is NOT echoed  echo 1
     */
    _kc(sub, args = [], echoBytes = 1) {
        if (FORBIDDEN_NAPE.has(sub)) {
            throw new Error(`refusing Nape command 0x${sub.toString(16)} (destructive)`);
        }
        return this._via([KC_MISC, sub, ...args], echoBytes);
    }

    // --- identity ---

    async protocolVersion() {
        const r = await this._via([VIA.getProtocolVersion]);
        return (r[1] << 8) | r[2];
    }

    async firmwareVersion() {
        const r = await this._via([VIA.kcFirmwareVersion]);
        const end = r.indexOf(0, 1);
        return String.fromCharCode(...r.slice(1, end < 0 ? r.length : end));
    }

    async featureBits() { return (await this._via([VIA.kcSupportFeature]))[1]; }

    async layerCount() { return (await this._via([VIA.getLayerCount]))[1]; }

    // --- keymap ---

    async getKeycode(layer, col) {
        const r = await this._via([VIA.getKeycode, layer, 0, col], 3);
        return (r[4] << 8) | r[5];
    }

    async setKeycode(layer, col, keycode) {
        await this._via([VIA.setKeycode, layer, 0, col, (keycode >> 8) & 0xFF, keycode & 0xFF], 3);
    }

    /** Whole keymap as [layer][col]. One 28-byte buffer read per ~2 layers
     * instead of 63 single-key reads — connect-time read storms are the
     * documented way to starve this FIFO. */
    async readKeymap() {
        const total = NAPE_LAYERS * NAPE_KEYS * 2;
        const bytes = [];
        for (let off = 0; off < total; off += 28) {
            const len = Math.min(28, total - off);
            const r = await this._via([VIA.getBuffer, (off >> 8) & 0xFF, off & 0xFF, len], 3);
            bytes.push(...r.slice(4, 4 + len));
        }
        const map = [];
        for (let l = 0; l < NAPE_LAYERS; l++) {
            map.push(Array.from({ length: NAPE_KEYS },
                (_, c) => (bytes[(l * NAPE_KEYS + c) * 2] << 8) | bytes[(l * NAPE_KEYS + c) * 2 + 1]));
        }
        return map;
    }

    // --- macros ---

    async macroInfo() {
        const count = (await this._via([VIA.macroGetCount]))[1];
        const s = await this._via([VIA.macroGetBufferSize]);
        return { count, bufferSize: (s[1] << 8) | s[2] };
    }

    async readMacroBuffer(size) {
        const bytes = [];
        for (let off = 0; off < size; off += 28) {
            const len = Math.min(28, size - off);
            const r = await this._via([VIA.macroGetBuffer, (off >> 8) & 0xFF, off & 0xFF, len], 3);
            bytes.push(...r.slice(4, 4 + len));
        }
        return bytes;
    }

    // --- Nape user commands ---

    /** Active layer. See the KC_GET_CURRENT_LAYER note above. */
    async currentLayer() { return (await this._via([VIA.kcDefaultLayer]))[1]; }

    /** Angle snap: the ball's direction lock, in 45° steps. */
    async angleSnap() { return 45 * (await this._kc(NAPE.getOri))[2]; }

    async setAngleSnap(deg) {
        if (deg % 45 || deg < 0 || deg >= 360) throw new Error('angle snap must be a 45° step');
        await this._kc(NAPE.setOri, [deg / 45]);
    }

    /** Per-layer angle-snap setting. */
    async layerAngleSnap(layer) { return 45 * (await this._kc(NAPE.getLayerOri, [layer]))[2]; }

    async layerAngleSnaps() {
        const out = [];
        for (let l = 0; l < NAPE_LAYERS; l++) out.push(await this.layerAngleSnap(l));
        return out;
    }

    async dpi() {
        const stage = (await this._kc(NAPE.getDpi))[2];
        const v = await this._kc(NAPE.getDpiValue);
        return { stage, value: v[2] | (v[3] << 8) };
    }

    async battery() {
        const r = await this._kc(NAPE.getBatReport);
        return { percent: r[2], state: r[3] };
    }

    async profile() { return (await this._kc(NAPE.getProfile))[2]; }

    /** Persistent "ball is always gesture / always scroll" mode flags. */
    async forceGestureScroll() {
        const r = await this._kc(NAPE.getForceGestureScroll);
        return { gesture: r[2], scroll: r[3] };
    }

    async setForceGestureScroll({ gesture = 0, scroll = 0 }) {
        const r = await this._kc(NAPE.setForceGestureScroll, [gesture, scroll]);
        if (r[2] !== 0) throw new Error('device rejected force gesture/scroll');
    }

    /** Switch the device to a layer (Launcher's switchLayer). */
    async switchLayer(layer) { await this._kc(NAPE.setLayer, [layer]); }

    /**
     * Ball gestures: four directions, each a 16-bit HID keycode, LE.
     * Frame verified against the Launcher bundle's own setter/getter:
     *   set [0xA7,0x29, up.lo,up.hi, down.lo,down.hi, left.lo,left.hi, right.lo,right.hi]
     *   get -> the same layout starting at byte 2
     */
    async gestures() {
        const r = await this._kc(NAPE.getGesture);
        return {
            up: r[2] | (r[3] << 8), down: r[4] | (r[5] << 8),
            left: r[6] | (r[7] << 8), right: r[8] | (r[9] << 8),
        };
    }

    async setGestures({ up, down, left, right }) {
        const lo = (v) => v & 0xFF, hi = (v) => (v >> 8) & 0xFF;
        await this._kc(NAPE.setGesture, [
            lo(up), hi(up), lo(down), hi(down), lo(left), hi(left), lo(right), hi(right),
        ]);
    }

    /**
     * Combos. Frames verified against the Launcher's own get/set:
     *   get [0xA7,0x28, index]
     *       -> {index b2, timeout b3|b4<<8, layer b5, cols b6, tap b7|b8<<8, held b9|b10<<8}
     *   set [0xA7,0x27, index, timeout.lo, timeout.hi, layer, cols, tap.lo, tap.hi,
     *        held.lo, held.hi]
     * `cols` is a bitmask of the matrix columns pressed together; tap/held are
     * QMK keycodes including modifier bits (stock slot 0 = LCTL(V) / LCTL(Z)).
     */
    async combo(index) {
        const r = await this._kc(NAPE.getCombos, [index], 2);
        return {
            index: r[2], timeout: r[3] | (r[4] << 8), layer: r[5], cols: r[6],
            tap: r[7] | (r[8] << 8), held: r[9] | (r[10] << 8),
        };
    }

    async combos(count = NAPE_COMBO_SLOTS) {
        const out = [];
        for (let i = 0; i < count; i++) {
            try { out.push(await this.combo(i)); } catch { break; }
        }
        return out;
    }

    async setCombo({ index, timeout = 200, layer = 0, cols, tap = 0, held = 0 }) {
        await this._kc(NAPE.setCombos, [
            index, timeout & 0xFF, (timeout >> 8) & 0xFF, layer, cols,
            tap & 0xFF, (tap >> 8) & 0xFF, held & 0xFF, (held >> 8) & 0xFF,
        ]);
    }

    async deleteCombo(index) { await this._kc(NAPE.delCombos, [index]); }

    /**
     * Tap-holds, addressed per (layer, column):
     *   get [0xA7,0x26, layer, 0, col] -> {layer b2, row b3, col b4,
     *                                      tap b5|b6<<8, held b7|b8<<8}
     *   set [0xA7,0x25, layer, 0, col, tap.lo, tap.hi, held.lo, held.hi]
     *   del [0xA7,0x2F, layer, 0, col]
     */
    async taphold(layer, col) {
        const r = await this._kc(NAPE.getTapholds, [layer, 0, col], 4);
        return { layer: r[2], col: r[4], tap: r[5] | (r[6] << 8), held: r[7] | (r[8] << 8) };
    }

    async setTaphold({ layer, col, tap = 0, held = 0 }) {
        await this._kc(NAPE.setTapholds, [
            layer, 0, col, tap & 0xFF, (tap >> 8) & 0xFF, held & 0xFF, (held >> 8) & 0xFF,
        ]);
    }

    async deleteTaphold(layer, col) { await this._kc(NAPE.delTapholds, [layer, 0, col]); }

    // --- macros (VIA dynamic-keymap macro buffer) ---
    //
    // The buffer holds `count` macros laid end to end, each terminated by 0x00.
    // QMK encodes tap/down/up and delays with 0x01-prefixed escapes; this editor
    // handles plain typed text and PRESERVES any escape bytes it does not
    // understand, so a macro recorded in Keychron's app is never silently
    // rewritten by opening it here.

    async readMacros() {
        const { count, bufferSize } = await this.macroInfo();
        const bytes = await this.readMacroBuffer(bufferSize);
        const macros = [];
        let start = 0;
        for (let i = 0; i < count; i++) {
            let end = bytes.indexOf(0, start);
            if (end < 0) end = bytes.length;
            macros.push(bytes.slice(start, end));
            start = end + 1;
            if (start > bytes.length) start = bytes.length;
        }
        return { count, bufferSize, macros, bytes };
    }

    async writeMacros(macros, bufferSize) {
        const out = [];
        for (const m of macros) {
            out.push(...m, 0);
        }
        if (out.length > bufferSize) {
            throw new Error(`macros need ${out.length} bytes, device has ${bufferSize}`);
        }
        while (out.length < bufferSize) out.push(0);
        for (let off = 0; off < bufferSize; off += 28) {
            const len = Math.min(28, bufferSize - off);
            await this._via([VIA.macroSetBuffer, (off >> 8) & 0xFF, off & 0xFF, len,
                ...out.slice(off, off + len)], 3);
        }
    }
}

/** Convert every scroll key between hold and toggle. Returns the edits made. */
export async function setScrollMode(client, keymap, mode, { layers }) {
    const want = mode === 'toggle' ? KC.scrollToggle : KC.scrollHold;
    const other = mode === 'toggle' ? KC.scrollHold : KC.scrollToggle;
    const edits = [];
    for (const l of layers) {
        for (let c = 0; c < NAPE_KEYS; c++) {
            if (keymap[l][c] !== other) continue;
            await client.setKeycode(l, c, want);
            const back = await client.getKeycode(l, c);
            edits.push({ layer: l, col: c, ok: back === want });
            if (back === want) keymap[l][c] = want;
        }
    }
    return edits;
}


// ---------- macro text codec ----------

/** Bytes -> editable text. Unknown escapes survive as \xNN so nothing is lost. */
export function macroToText(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x01 && i + 2 < bytes.length) {
            // QMK escape: 0x01 <action> <keycode> — keep it verbatim.
            out += `\\x01\\x${bytes[i + 1].toString(16).padStart(2, '0')}`
                + `\\x${bytes[i + 2].toString(16).padStart(2, '0')}`;
            i += 2;
        } else if (b >= 0x20 && b < 0x7F) {
            out += String.fromCharCode(b);
        } else {
            out += `\\x${b.toString(16).padStart(2, '0')}`;
        }
    }
    return out;
}

/** Text -> bytes. Throws on a malformed escape rather than writing garbage. */
export function macroFromText(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && text[i + 1] === 'x') {
            const hex = text.slice(i + 2, i + 4);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`bad escape at position ${i}`);
            out.push(parseInt(hex, 16));
            i += 3;
        } else {
            const c = text.charCodeAt(i);
            if (c > 0x7E) throw new Error(`"${text[i]}" is not typeable — use \\xNN`);
            out.push(c);
        }
    }
    if (out.includes(0)) throw new Error('a macro cannot contain \\x00 (it terminates the macro)');
    return out;
}
