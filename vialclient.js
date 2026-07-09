// High-level Vial/VIA operations over FlaskHID. Port of AdeptCompanion
// Sources/AdeptCore/VialClient.swift. Stateless; every call is one (or a
// chunked sequence of) 32-byte round trips through the shared queue.
// Byte layouts cite quantum/via.c and quantum/vial.c.

import { VIA, VIAL, VIA_KB_VALUE, DYNAMIC_OP, BUFFER_CHUNK,
         TapDance, Combo, KeyOverride, AltRepeat } from './vialproto.js?v=5';

export class VialClient {
    constructor(hid) { this.hid = hid; }

    _via(cmd, payload = []) { return this.hid.rawCommand([cmd, ...payload]); }
    _vial(cmd, payload = []) { return this.hid.rawCommand([VIA.vialPrefix, cmd, ...payload]); }

    // ---------- identity ----------

    /** VIA protocol version (0x0009 for this fork), BE at data[1..2]. */
    async viaProtocolVersion() {
        const r = await this._via(VIA.getProtocolVersion);
        return (r[1] << 8) | r[2];
    }

    /** Vial protocol version (u32 LE) + 8-byte keyboard UID. */
    async vialKeyboardID() {
        const r = await this._vial(VIAL.getKeyboardID);
        const version = r[0] | (r[1] << 8) | (r[2] << 16) | (r[3] << 24);
        return { version, uid: r.slice(4, 12) };
    }

    // ---------- keyboard definition ----------

    /** Size of the XZ-compressed vial.json the firmware serves (u32 LE). */
    async definitionSize() {
        const r = await this._vial(VIAL.getDefinitionSize);
        return r[0] | (r[1] << 8) | (r[2] << 16) | (r[3] << 24);
    }

    /** Whole compressed definition — full 32-byte pages, LE page index. */
    async definition() {
        const size = await this.definitionSize();
        if (size <= 0 || size >= 1 << 20) throw new Error('bad definition size');
        const out = new Uint8Array(size);
        let got = 0, page = 0;
        while (got < size) {
            const r = await this._vial(VIAL.getDefinition, [page & 0xFF, (page >> 8) & 0xFF]);
            const take = Math.min(32, size - got);
            out.set(r.slice(0, take), got);
            got += take;
            page++;
        }
        return out;
    }

    // ---------- keymap ----------

    async layerCount() {
        return (await this._via(VIA.keymapGetLayerCount))[1];
    }

    /** Whole dynamic keymap: layers×rows×cols BIG-endian u16s, ≤28-byte
     *  chunks with BE offset (quantum/via.c id_dynamic_keymap_get_buffer). */
    async readKeymap(layers, rows, cols) {
        const totalBytes = layers * rows * cols * 2;
        const raw = new Uint8Array(totalBytes);
        let offset = 0;
        while (offset < totalBytes) {
            const size = Math.min(BUFFER_CHUNK, totalBytes - offset);
            const r = await this._via(VIA.keymapGetBuffer, [offset >> 8, offset & 0xFF, size]);
            raw.set(r.slice(4, 4 + size), offset);
            offset += size;
        }
        const keymap = [];
        let i = 0;
        for (let l = 0; l < layers; l++) {
            const layer = [];
            for (let row = 0; row < rows; row++) {
                const rowArr = [];
                for (let c = 0; c < cols; c++) {
                    rowArr.push((raw[i] << 8) | raw[i + 1]);
                    i += 2;
                }
                layer.push(rowArr);
            }
            keymap.push(layer);
        }
        return keymap;
    }

    /** Whole-keymap write in ≤28-byte set_buffer chunks (ungated). */
    async writeKeymap(keymap) {
        const raw = [];
        for (const layer of keymap) for (const row of layer) for (const kc of row) {
            raw.push((kc >> 8) & 0xFF, kc & 0xFF); // BE, same as get_buffer
        }
        let offset = 0;
        while (offset < raw.length) {
            const size = Math.min(BUFFER_CHUNK, raw.length - offset);
            await this._via(VIA.keymapSetBuffer,
                [offset >> 8, offset & 0xFF, size, ...raw.slice(offset, offset + size)]);
            offset += size;
        }
    }

    /** One key position. No unlock needed (matches Vial GUI behavior). */
    setKeycode(layer, row, col, keycode) {
        return this._via(VIA.dynamicKeymapSetKeycode,
            [layer, row, col, (keycode >> 8) & 0xFF, keycode & 0xFF]);
    }

    // ---------- macros ----------

    async macroCount() { return (await this._via(VIA.macroGetCount))[1]; }

    async macroBufferSize() {
        const r = await this._via(VIA.macroGetBufferSize);
        return (r[1] << 8) | r[2];
    }

    async readMacroBuffer(size) {
        const raw = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
            const chunk = Math.min(BUFFER_CHUNK, size - offset);
            const r = await this._via(VIA.macroGetBuffer, [offset >> 8, offset & 0xFF, chunk]);
            raw.set(r.slice(4, 4 + chunk), offset);
            offset += chunk;
        }
        return Array.from(raw);
    }

    /** UNLOCK-GATED: quantum/via.c silently ignores writes while locked —
     *  check unlock first, verify by re-reading. */
    async writeMacroBuffer(buffer, totalSize) {
        const image = [...buffer];
        while (image.length < totalSize) image.push(0);
        let offset = 0;
        while (offset < image.length) {
            const chunk = Math.min(BUFFER_CHUNK, image.length - offset);
            await this._via(VIA.macroSetBuffer,
                [offset >> 8, offset & 0xFF, chunk, ...image.slice(offset, offset + chunk)]);
            offset += chunk;
        }
    }

    // ---------- dynamic entries ----------

    /** Capacities compiled into the firmware (vial.c get_number_of_entries). */
    async dynamicEntryCounts() {
        const r = await this._vial(VIAL.dynamicEntryOp, [DYNAMIC_OP.getNumberOfEntries]);
        return { tapDance: r[0], combo: r[1], keyOverride: r[2], altRepeat: r[3] };
    }

    async _entryGet(op, index, decoder, len) {
        const r = await this._vial(VIAL.dynamicEntryOp, [op, index]);
        if (r[0] !== 0) throw new Error('entry get failed');
        return decoder(r.slice(1, 1 + len));
    }

    /** Frame: [0xFE, 0x0D, op, idx, entry…] — entry at byte 4, NO pad byte
     *  (a pad byte shipped garbage tap dances once — see repo CLAUDE.md). */
    async _entrySet(op, index, bytes) {
        const r = await this._vial(VIAL.dynamicEntryOp, [op, index, ...bytes]);
        if (r[0] !== 0) throw new Error('entry set failed');
    }

    tapDanceGet(i) { return this._entryGet(DYNAMIC_OP.tapDanceGet, i, TapDance.decode, 10); }
    tapDanceSet(i, e) { return this._entrySet(DYNAMIC_OP.tapDanceSet, i, TapDance.encode(e)); }
    comboGet(i) { return this._entryGet(DYNAMIC_OP.comboGet, i, Combo.decode, 10); }
    comboSet(i, e) { return this._entrySet(DYNAMIC_OP.comboSet, i, Combo.encode(e)); }
    keyOverrideGet(i) { return this._entryGet(DYNAMIC_OP.keyOverrideGet, i, KeyOverride.decode, 10); }
    keyOverrideSet(i, e) { return this._entrySet(DYNAMIC_OP.keyOverrideSet, i, KeyOverride.encode(e)); }
    altRepeatGet(i) { return this._entryGet(DYNAMIC_OP.altRepeatKeyGet, i, AltRepeat.decode, 6); }
    altRepeatSet(i, e) { return this._entrySet(DYNAMIC_OP.altRepeatKeySet, i, AltRepeat.encode(e)); }

    // ---------- encoders ----------

    /** Response bytes 0-1 = CCW, 2-3 = CW, BIG-endian (vial.c vial_get_encoder). */
    async encoderGet(layer, index) {
        const r = await this._vial(VIAL.getEncoder, [layer, index]);
        return { ccw: (r[0] << 8) | r[1], cw: (r[2] << 8) | r[3] };
    }

    encoderSet(layer, index, clockwise, keycode) {
        return this._vial(VIAL.setEncoder,
            [layer, index, clockwise ? 1 : 0, (keycode >> 8) & 0xFF, keycode & 0xFF]);
    }

    // ---------- lock / unlock ----------

    async unlockStatus() {
        const r = await this._vial(VIAL.getUnlockStatus);
        const keys = [];
        for (let i = 2; i + 1 < r.length && r[i] !== 0xFF; i += 2) {
            keys.push({ row: r[i], col: r[i + 1] });
        }
        return { unlocked: r[0] !== 0, inProgress: r[1] !== 0, keys };
    }

    unlockStart() { return this._vial(VIAL.unlockStart); }

    /** Counter runs 50 → 0 in firmware (~100 ms ticks). */
    async unlockPoll() {
        const r = await this._vial(VIAL.unlockPoll);
        return { unlocked: r[0] !== 0, inProgress: r[1] !== 0, counter: r[2] };
    }

    lock() { return this._vial(VIAL.lock); }

    // ---------- matrix tester ----------

    /** Live switch state, one bitmask byte per row per 8-col group.
     *  UNLOCK-GATED: while locked the response echoes the request (zeros) —
     *  that's "locked", not an error. quantum/via.c packs ceil(cols/8) bytes
     *  per row, row-major, starting at byte 2. */
    async matrixState(rows, cols) {
        const r = await this._via(VIA.getKeyboardValue, [VIA_KB_VALUE.switchMatrixState]);
        const bytesPerRow = Math.ceil(cols / 8);
        const out = [];
        for (let row = 0; row < rows; row++) {
            let bits = 0n;
            for (let b = 0; b < bytesPerRow; b++) {
                // Bytes arrive high-group-first per row (matches vial-gui).
                bits = (bits << 8n) | BigInt(r[2 + row * bytesPerRow + b] ?? 0);
            }
            out.push(bits);
        }
        return out; // BigInt bitmask per row; bit N = col N pressed
    }

    // ---------- QMK settings ----------

    /** All supported QSIDs by paging qmk_settings_query (u16 LE, 0xFFFF pad). */
    async qmkSettingsQSIDs() {
        const out = [];
        let greaterThan = 0;
        for (;;) {
            const r = await this._vial(VIAL.qmkSettingsQuery, [greaterThan & 0xFF, greaterThan >> 8]);
            let got = false;
            for (let i = 0; i + 1 < r.length; i += 2) {
                const qsid = r[i] | (r[i + 1] << 8);
                if (qsid === 0xFFFF) break;
                out.push(qsid);
                greaterThan = qsid;
                got = true;
            }
            if (!got) break;
        }
        return out;
    }

    async qmkSettingGet(qsid, width) {
        const r = await this._vial(VIAL.qmkSettingsGet, [qsid & 0xFF, qsid >> 8]);
        if (r[0] !== 0) throw new Error('unsupported QSID');
        let value = 0;
        for (let i = 0; i < width; i++) value |= r[1 + i] << (8 * i);
        return value >>> 0;
    }

    /** Persists immediately in firmware (qmk_settings_set → eeprom). */
    async qmkSettingSet(qsid, width, value) {
        const payload = [qsid & 0xFF, qsid >> 8];
        for (let i = 0; i < width; i++) payload.push((value >>> (8 * i)) & 0xFF);
        const r = await this._vial(VIAL.qmkSettingsSet, payload);
        if (r[0] !== 0) throw new Error('set failed');
    }

    qmkSettingsReset() { return this._vial(VIAL.qmkSettingsReset); }

    // ---------- danger zone ----------

    /** Jump to bootloader. Unlock-gated in firmware. */
    bootloaderJump() { return this._via(VIA.bootloaderJump); }
}
