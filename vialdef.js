// XZ decode + vial.json / KLE parsing. Port of AdeptCompanion
// Sources/AdeptCore/VialDefinition.swift, hard-won rules preserved.
//
// The firmware serves vial.json XZ-compressed (vial-qmk
// util/vial_generate_definition.py: Python lzma.compress defaults = XZ
// container, LZMA2, CRC64). Decoder: vendor/xz-decompress.js, loaded as a
// classic script in index.html (UMD) → window['xz-decompress'].

export async function decompressXZ(bytes) {
    const { XzReadableStream } = window['xz-decompress'];
    // Sanity-check the XZ magic so a garbage fetch fails loudly.
    const magic = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];
    if (!magic.every((m, i) => bytes[i] === m)) {
        throw new Error('definition payload is not XZ (bad magic)');
    }
    const stream = new Blob([bytes]).stream();
    const buf = await new Response(new XzReadableStream(stream)).arrayBuffer();
    return new Uint8Array(buf);
}

/**
 * Parse a fetched (compressed) definition into
 * { name, vendorProductID, matrixRows, matrixCols, keys, encoderKeys,
 *   customKeycodes, raw }.
 */
export async function parseDefinition(compressed) {
    const jsonBytes = await decompressXZ(compressed);
    const obj = JSON.parse(new TextDecoder().decode(jsonBytes));
    const matrix = obj.matrix || {};
    let keys = [], encoderKeys = [];
    if (obj.layouts?.keymap) {
        ({ keys, encoderKeys } = parseKLE(obj.layouts.keymap));
    }
    return {
        name: obj.name || 'Vial keyboard',
        vendorProductID: `${obj.vendorId ?? '?'}:${obj.productId ?? '?'}`,
        matrixRows: matrix.rows || 0,
        matrixCols: matrix.cols || 0,
        keys,
        encoderKeys,
        customKeycodes: (obj.customKeycodes || []).map((e, i) => ({
            index: i,
            name: e.name || `Custom ${i}`,
            shortName: e.shortName || e.name || `C${i}`,
            title: e.title || null,
        })),
        raw: obj,
    };
}

/**
 * Minimal KLE walk: rows of items; a string is a key whose FIRST legend line
 * is "row,col", a dict carries position/size adjustments (and the decal flag)
 * for the NEXT key.
 *
 * Hard-won rules (from the Swift app, hardware-debugged):
 * - Legend split must KEEP empty lines: a Vial layout-option decal legend
 *   "\n\n\n1,0" must NOT collapse to "1,0" — that minted a phantom key at
 *   matrix (1,0) drawn on top of real keys (Svalboard, 2026-07-03).
 *   JS String.split keeps empty strings natively, but never "optimize" this
 *   into a filtered split.
 * - d:true marks a decal — never a key, skip entirely.
 * - Legend line index 9 === 'e' marks an ENCODER rotation cap whose first
 *   legend is "encoderIndex,direction" (dir 0=CCW 1=CW), NOT "row,col"
 *   (NLKB16, 2026-07-06 — parsed as keys they mint phantoms on the matrix).
 */
export function parseKLE(rows) {
    const keys = [], encoderKeys = [];
    let y = 0;
    for (const row of rows) {
        if (!Array.isArray(row)) continue; // KLE metadata object rows
        let x = 0, w = 1, h = 1, decal = false;
        for (const item of row) {
            if (typeof item === 'object' && item !== null) {
                if (typeof item.x === 'number') x += item.x;
                if (typeof item.y === 'number') y += item.y;
                if (typeof item.w === 'number') w = item.w;
                if (typeof item.h === 'number') h = item.h;
                if (typeof item.d === 'boolean') decal = item.d;
                continue;
            }
            if (typeof item !== 'string') continue;
            const lines = item.split('\n'); // keeps empty lines — load-bearing
            const parts = (lines[0] || '').split(',');
            const isEncoder = lines.length > 9 && lines[9] === 'e';
            if (!decal && parts.length === 2) {
                const a = parseInt(parts[0], 10), b = parseInt(parts[1], 10);
                if (Number.isInteger(a) && Number.isInteger(b)) {
                    if (isEncoder) {
                        encoderKeys.push({ index: a, clockwise: b !== 0, x, y, w, h });
                    } else {
                        keys.push({ row: a, col: b, x, y, w, h });
                    }
                }
            }
            x += w;
            w = 1; h = 1; decal = false;
        }
        y += 1;
    }
    return { keys, encoderKeys };
}
