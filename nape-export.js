// Keychron Nape Pro — whole-device config export / import.
//
// Captures everything the editor can reach: keymap (all 9 layers x 7 columns,
// INCLUDING hidden columns so a restore is faithful), macros, combos, tap-holds,
// gestures, and angle snap. Firmware is recorded for provenance but never
// enforced — Keychron shuffles the keymap between releases, so a restore across
// versions is the user's call, made with the mismatch shown to them.

import { NAPE_KEYS, NAPE_LAYERS, NAPE_COMBO_SLOTS } from './nape-proto.js?v=37';

export const NAPE_EXPORT_VERSION = 1;

export async function buildNapeExport(app) {
    const nape = app.nape;
    app.hid.pause();
    try {
        const keymap = await nape.readKeymap();
        const macros = await nape.readMacros();
        const combos = await nape.combos(NAPE_COMBO_SLOTS);
        const tapholds = [];
        for (let l = 0; l < NAPE_LAYERS; l++) {
            for (let c = 0; c < NAPE_KEYS; c++) {
                const t = await nape.taphold(l, c);
                if (t.tap || t.held) tapholds.push({ layer: l, col: c, tap: t.tap, held: t.held });
            }
        }
        return {
            format: 'flask-nape',
            version: NAPE_EXPORT_VERSION,
            device: 'Keychron Nape Pro',
            firmware: app.napeFirmware,
            keymap,
            macros: macros.macros.map((m) => Array.from(m)),
            macroBufferSize: macros.bufferSize,
            combos: combos.map((c) => ({
                index: c.index, timeout: c.timeout, layer: c.layer,
                cols: c.cols, tap: c.tap, held: c.held,
            })),
            tapholds,
            gestures: await nape.gestures(),
            angleSnap: await nape.angleSnap(),
            layerAngleSnaps: await nape.layerAngleSnaps(),
        };
    } finally {
        app.hid.resume();
    }
}

/** Validate before touching the device — a partial restore is worse than none. */
export function validateNapeExport(data) {
    if (!data || data.format !== 'flask-nape') throw new Error('not a Flask Nape export');
    if (data.version > NAPE_EXPORT_VERSION) {
        throw new Error(`export is version ${data.version}, this build understands ${NAPE_EXPORT_VERSION}`);
    }
    if (!Array.isArray(data.keymap) || data.keymap.length !== NAPE_LAYERS) {
        throw new Error(`keymap must have ${NAPE_LAYERS} layers`);
    }
    for (const row of data.keymap) {
        if (!Array.isArray(row) || row.length !== NAPE_KEYS) {
            throw new Error(`each layer must have ${NAPE_KEYS} columns`);
        }
    }
    return true;
}

/**
 * Apply an export. Returns a per-section report; a section that throws is
 * recorded and the rest still applies, because a half-restored device with an
 * accurate account beats an abort halfway through with none.
 */
export async function applyNapeImport(app, data, { onProgress } = {}) {
    validateNapeExport(data);
    const nape = app.nape;
    const report = [];
    const step = async (name, fn) => {
        onProgress?.(name);
        try {
            const n = await fn();
            report.push({ name, ok: true, detail: n });
        } catch (e) {
            report.push({ name, ok: false, detail: e.message });
        }
    };

    app.hid.pause();
    try {
        await step('keymap', async () => {
            let n = 0;
            for (let l = 0; l < NAPE_LAYERS; l++) {
                for (let c = 0; c < NAPE_KEYS; c++) {
                    const want = data.keymap[l][c];
                    if (await nape.getKeycode(l, c) === want) continue;
                    await nape.setKeycode(l, c, want);
                    n++;
                }
            }
            return `${n} keys changed`;
        });

        if (Array.isArray(data.macros)) {
            await step('macros', async () => {
                const size = data.macroBufferSize
                    || (await nape.macroInfo()).bufferSize;
                await nape.writeMacros(data.macros, size);
                return `${data.macros.filter((m) => m.length).length} set`;
            });
        }

        if (Array.isArray(data.combos)) {
            await step('combos', async () => {
                for (const c of data.combos) await nape.setCombo(c);
                return `${data.combos.length} slots`;
            });
        }

        if (Array.isArray(data.tapholds)) {
            await step('tap-holds', async () => {
                for (const t of data.tapholds) await nape.setTaphold(t);
                return `${data.tapholds.length} entries`;
            });
        }

        if (data.gestures) {
            await step('gestures', async () => {
                await nape.setGestures(data.gestures);
                return 'set';
            });
        }

        if (typeof data.angleSnap === 'number') {
            await step('angle snap', async () => {
                await nape.setAngleSnap(data.angleSnap);
                return `${data.angleSnap}°`;
            });
        }

        app.napeKeymap = await nape.readKeymap();
        app.keymap = app.napeKeymap.map((l) => [l.slice()]);
    } finally {
        app.hid.resume();
    }
    return report;
}

export function downloadNapeExport(data) {
    const stamp = (data.firmware || 'nape').replace(/[^\w.-]+/g, '-').slice(0, 24);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nape-config-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
