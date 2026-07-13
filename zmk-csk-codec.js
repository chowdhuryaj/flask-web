// flask_csk slot-frame codec (ZMK line, channel 0x16 = QMK customShift) —
// pure functions, no imports, so zmk-studio-test.mjs exercises the exact
// bytes the Shift tab writes. ZMK slot frame at 0x50 (payload-addressed;
// QMK's u16 pair tables at 0x10+/0x30+ cannot carry 32-bit ZMK usages):
//
//   [slot, base_b3, base_b2, base_b1, base_b0, sh_b3, sh_b2, sh_b1, sh_b0]
//
// base/shifted are ZMK keymap encodings (usage id bits 0-15, page 16-23,
// modifier bits 24-31), big-endian. The firmware matches base by PAGE+ID
// (its modifier bits are ignored); the shifted encoding's modifiers apply
// to the replacement. A slot is live when both are nonzero.

export function decodeCskSlot(bytes) {
    const u32 = (o) =>
        (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    return { slot: bytes[0], base: u32(1), shifted: u32(5) };
}

export function encodeCskSlot(slot, { base = 0, shifted = 0 }) {
    base = base >>> 0;
    shifted = shifted >>> 0;
    return [slot & 0xFF,
        (base >>> 24) & 0xFF, (base >>> 16) & 0xFF, (base >>> 8) & 0xFF, base & 0xFF,
        (shifted >>> 24) & 0xFF, (shifted >>> 16) & 0xFF, (shifted >>> 8) & 0xFF, shifted & 0xFF];
}

export function cskSlotIsEmpty({ base = 0, shifted = 0 }) {
    return base === 0 && shifted === 0;
}
