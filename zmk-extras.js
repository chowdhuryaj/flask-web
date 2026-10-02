// window.flaskExportKeymap() and window.flaskPrintLayers(): app-side glue for the
// .keymap exporter (zmk-dt-export.js) and the printable layer sheet. Loaded by a
// side-effect import at the end of zmk-export.js (index.html is not touched).
// Everything that needs the keymap tab is imported lazily: the tab imports
// zmk-export.js, so a static import here would be a cycle.

import { exportKeymapText } from './zmk-dt-export.js?v=62';
import { exportFlaskState } from './zmk-export.js?v=62';
import { zmkBehaviors } from './zmk-keycodes.js?v=62';
import { TOTEM_DEFAULT } from './zmk-totem-default.js?v=62';
import { board, layoutOf, capPartsOf, htPartsOf, fitText } from './board.js?v=62';
import { decodeHoldtapSlot, decodeHoldtapInfo } from './zmk-holdtap-codec.js?v=62';

const say = (msg, bad = false) => {
    if (typeof document === 'undefined') return;
    import('./ui.js?v=62').then((m) => m.toast(msg, bad)).catch(() => {});
};

// Hold timing for EVERY flask_holdtap slot (channel 0x2A): what the firmware
// answers is the compiled default until a slot is customised, so reading all of
// them exports the defaults too. Offline preview answers the same reads from its
// default catalog (zmk-offline.js holdtapDefaults). A slot that cannot be read goes
// to `unreadable` and ends up in the not-exported block. Empty when the board
// has no flask_holdtap.
export async function readHoldtap(app) {
    const f = app.flask, slots = [], unreadable = [];
    if (!f || (app.protocolVersion ?? 0) < 17) return { slots, unreadable };
    let n;
    try { n = await f.getU16(0x2A, 0x01); } catch (e) { return { slots, unreadable: [{ slot: 'count', error: e?.message ?? String(e) }] }; }
    for (let slot = 0; slot < n; slot++) {
        try {
            const s = decodeHoldtapSlot(await f.getBytes(0x2A, 0x50, [slot], 1));
            const i = decodeHoldtapInfo(await f.getBytes(0x2A, 0x52, [slot], 1));
            slots.push({ ...s, slot, kind: i.kind, name: i.name });
        } catch (e) { unreadable.push({ slot, error: e?.message ?? String(e) }); }
    }
    return { slots, unreadable };
}

/** The Totem firmware's own node names for behaviors that carry no display name,
 * when the catalog id/shape matches the default keymap this build was generated from. */
function totemNodeById(app) {
    if (app?.profile?.family !== 'totem') return null;
    const cat = zmkBehaviors();
    return (id, meta) => {
        const d = TOTEM_DEFAULT.behaviors.find((b) => b.id === id);
        if (!d?.node) return null;
        const same = (meta?.displayName ?? '') === d.displayName
            && JSON.stringify(meta?.metadata ?? []) === JSON.stringify(d.metadata);
        return same && cat.get(id) ? d.node : null;
    };
}

/** Build the .keymap text from the live keymap tab. Returns { text, notExported, filename }. */
export async function buildKeymapExport({ combos = 'flask' } = {}) {
    const { zmkLiveKeymapTab } = await import('./zmk-keymap-tab.js?v=62');
    const kt = zmkLiveKeymapTab();
    if (!kt?.keymap) throw new Error('open a keyboard and its keymap first');
    const app = kt.app;
    const family = app?.profile?.family ?? app?.family ?? 'zmk';
    const behaviors = zmkBehaviors();
    const data = {
        family,
        device: kt.deviceName,
        layers: kt.keymap.layers.map((l) => ({
            id: l.id, name: l.name,
            bindings: l.bindings.map((b) => ({
                behavior: behaviors.get(b.behaviorId)?.displayName ?? null,
                behaviorId: b.behaviorId, param1: b.param1, param2: b.param2,
            })),
        })),
    };
    if (app?.flask && app?.caps?.flask) {
        data.flask = await exportFlaskState(app);
        const ht = await readHoldtap(app);
        data.holdtap = ht.slots;
        data.holdtapUnreadable = ht.unreadable;
    }
    // Totem: a slot still on its firmware default keys keeps the firmware's node name.
    const comboNameFor = family === 'totem'
        ? (i, pos) => { const d = TOTEM_DEFAULT.combos[i]; return d && d.positions.join() === pos.join() ? d.name : ''; }
        : null;
    const r = exportKeymapText(data, { behaviors, nodeById: totemNodeById(app), combos, comboNameFor });
    return { ...r, filename: `${family}-flask-export.keymap` };
}

function download(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

/** Export the current state as a ZMK devicetree <board>.keymap. Pass
 * { download: false } to get the result without saving a file,
 * { combos: 'zmk' } for stock zmk,combos instead of flask,combos-defaults. */
export async function flaskExportKeymap(opts = {}) {
    try {
        const r = await buildKeymapExport(opts);
        if (opts.download !== false) {
            download(r.filename, r.text);
            say(`${r.filename} exported${r.notExported.length ? ` (${r.notExported.length} note(s) in the not-exported block)` : ''}`);
        }
        return r;
    } catch (e) {
        say(`Export .keymap failed: ${e.message}`, true);
        if (opts.download === false) throw e;
        return null;
    }
}

// ---------------------------------------------------------------- print sheet

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** One layer as an SVG string: board outline, tap legend big, hold legend small. */
export function layerSvg(adapter, layer) {
    const profile = adapter.profile;
    const L = layoutOf(profile.keys, 1);
    const radius = 6, mainFs = 24, smallFs = 12;
    const cells = profile.keys.map((key) => {
        const f = L.frame(key);
        const sel = adapter.selOf(adapter.posOf({ kind: 'key', row: key.row, col: key.col }));
        const value = sel ? adapter.bindingAt(layer, sel) : null;
        const mid = f.x + f.w / 2, innerW = f.w - 8;
        const ht = value ? htPartsOf(value, profile) : null;
        const parts = value && !ht ? capPartsOf(value, profile) : { top: '', main: '' };
        let body = '';
        if (ht) {
            const bandH = f.h * 0.4;
            const hold = fitText(`${ht.hold}`, innerW, smallFs, { minScale: 0.6, maxLines: 1 });
            const tap = fitText(ht.tap, innerW, mainFs, { minScale: 0.5, maxLines: 1 });
            body = `<path d="M${f.x},${f.y + bandH} V${f.y + radius} Q${f.x},${f.y} ${f.x + radius},${f.y} H${f.x + f.w - radius} Q${f.x + f.w},${f.y} ${f.x + f.w},${f.y + radius} V${f.y + bandH} Z" fill="#e6e6e6"/>`
                + `<text x="${mid}" y="${f.y + bandH * 0.7}" text-anchor="middle" font-size="${hold.fs}" fill="#444">${esc(hold.lines[0])}</text>`
                + `<text x="${mid}" y="${f.y + bandH + (f.h - bandH) * 0.66}" text-anchor="middle" font-size="${tap.fs}" font-weight="600">${esc(tap.lines[0])}</text>`;
        } else if (parts.main || parts.top) {
            const main = fitText(parts.main || parts.top, innerW, mainFs, { minScale: 0.45, maxLines: 2 });
            const my = parts.top && parts.main ? f.y + f.h * 0.68 : f.y + f.h / 2 - (main.lines.length - 1) * main.fs * 0.5 + main.fs * 0.35;
            if (parts.top && parts.main) {
                const top = fitText(parts.top, innerW, smallFs, { minScale: 0.6, maxLines: 1 });
                body += `<text x="${mid}" y="${f.y + f.h * 0.3}" text-anchor="middle" font-size="${top.fs}" fill="#444">${esc(top.lines[0])}</text>`;
            }
            body += main.lines.map((ln, i) => `<text x="${mid}" y="${my + i * main.fs * 1.05}" text-anchor="middle" font-size="${main.fs}" font-weight="600">${esc(ln)}</text>`).join('');
        }
        const tr = f.r ? ` transform="rotate(${f.r} ${f.cx} ${f.cy})"` : '';
        return `<g${tr}><rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="${radius}" fill="#fff" stroke="#222" stroke-width="1.5"/>${body}</g>`;
    });
    return `<svg viewBox="0 0 ${L.width} ${L.height}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, Helvetica, Arial, sans-serif">${cells.join('')}</svg>`;
}

/** The full printable document: two layers per page, always light. */
export function printHtml(adapter, { title = 'Keymap' } = {}) {
    const layers = adapter.layers().filter((l, i) => i === 0 || !l.empty);
    const sheets = layers.map((l) => `<section class="layer"><h2>${esc(l.name)} <small>layer ${l.index}</small></h2>${layerSvg(adapter, l.index)}</section>`);
    const pages = [];
    for (let i = 0; i < sheets.length; i += 2) pages.push(`<div class="page">${sheets.slice(i, i + 2).join('')}</div>`);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: letter portrait; margin: 12mm; }
html, body { background: #fff; color: #000; margin: 0; }
body { font-family: -apple-system, Helvetica, Arial, sans-serif; }
.page { height: 250mm; display: flex; flex-direction: column; justify-content: space-around; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.layer { break-inside: avoid; }
h2 { font-size: 15pt; margin: 0 0 4mm; } h2 small { font-weight: 400; color: #555; font-size: 10pt; margin-left: 6px; }
@media screen { body { padding: 12mm; } .page { margin-bottom: 20mm; } }
</style></head><body>${pages.join('')}</body></html>`;
}

/** Open a print-friendly layer sheet and print it. { print: false } returns the
 * HTML without opening anything (tests, previews). */
export function flaskPrintLayers(opts = {}) {
    const adapter = board.adapter;
    if (!adapter) { say('Open a keyboard with a keymap first', true); return null; }
    const html = printHtml(adapter, { title: `${adapter.profile?.family ?? 'Keymap'} layers` });
    if (opts.print === false) return html;
    const w = window.open('', '_blank');
    if (w) {
        w.document.open(); w.document.write(html); w.document.close();
        setTimeout(() => { w.focus(); w.print(); }, 250);
        return html;
    }
    // Popup blocked: print from a hidden frame instead.
    const fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    fr.onload = () => { fr.contentWindow.focus(); fr.contentWindow.print(); setTimeout(() => fr.remove(), 2000); };
    fr.srcdoc = html;
    document.body.append(fr);
    return html;
}

if (typeof window !== 'undefined') {
    window.flaskExportKeymap = flaskExportKeymap;
    window.flaskPrintLayers = flaskPrintLayers;
}
