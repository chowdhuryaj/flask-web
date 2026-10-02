// ZMK devicetree (.keymap) generator. Pure: no DOM, no imports, node-testable.
//
//   exportKeymapText(data, opts) -> { text, notExported: string[] }
//
// data  (the shape zmk-keymap-tab buildExportData() already produces, plus
//        layer ids and a holdtap section):
//   { family, device, layers: [{ id?, name, bindings: [{ behavior, behaviorId, param1, param2 }] }],
//     flask?: { combos, macros, tapDance, leader, customShift, gestures, slotNames, ... },
//     holdtap?: [{ slot, term, quick, idle, flavor, custom, kind, name }] }
// opts  { behaviors: Map|array of { id, displayName, metadata, node? },   catalog (ids -> params)
//         nodeById?: (id) => devicetree node name for a behavior that has no
//                    display name (compiled slk_*, leader, ...),
//         comboNameFor?: (slot, positions) => default node name for a slot,
//         combos: 'flask' (default, flask,combos-defaults) | 'zmk' (stock zmk,combos),
//         date? }
//
// What is written as devicetree: layers, every binding, combos, macros (flask
// runtime slots become zmk,behavior-macro nodes), tap dance (become
// zmk,behavior-tap-dance nodes), custom per-key hold timing
// (flask,holdtap-defaults). Behaviors the FIRMWARE defines (&fht_l, &slk_paste,
// &leader ...) are referenced by node name and listed in a comment; the app only
// knows their display names. Everything else lands in a `not exported` block.

const MODS = [[0x01, 'LC'], [0x02, 'LS'], [0x04, 'LA'], [0x08, 'LG'],
    [0x10, 'RC'], [0x20, 'RS'], [0x40, 'RA'], [0x80, 'RG']];

// HID keyboard page (0x07) usage id -> dt-bindings/zmk/keys.h name.
const KB = (() => {
    const m = new Map();
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => m.set(0x04 + i, c));
    for (let i = 1; i <= 9; i++) m.set(0x1D + i, `N${i}`);
    m.set(0x27, 'N0');
    for (let i = 1; i <= 12; i++) m.set(0x39 + i, `F${i}`);
    for (let i = 13; i <= 24; i++) m.set(0x68 + i - 13, `F${i}`);
    for (let i = 1; i <= 9; i++) m.set(0x58 + i, `KP_N${i}`);
    Object.entries({
        0x28: 'ENTER', 0x29: 'ESC', 0x2A: 'BSPC', 0x2B: 'TAB', 0x2C: 'SPACE', 0x2D: 'MINUS',
        0x2E: 'EQUAL', 0x2F: 'LBKT', 0x30: 'RBKT', 0x31: 'BSLH', 0x32: 'NUHS', 0x33: 'SEMI',
        0x34: 'SQT', 0x35: 'GRAVE', 0x36: 'COMMA', 0x37: 'DOT', 0x38: 'FSLH', 0x39: 'CAPS',
        0x46: 'PSCRN', 0x47: 'SLCK', 0x48: 'PAUSE_BREAK', 0x49: 'INS', 0x4A: 'HOME',
        0x4B: 'PG_UP', 0x4C: 'DEL', 0x4D: 'END', 0x4E: 'PG_DN',
        0x4F: 'RIGHT', 0x50: 'LEFT', 0x51: 'DOWN', 0x52: 'UP',
        0x53: 'KP_NUMLOCK', 0x54: 'KP_DIVIDE', 0x55: 'KP_MULTIPLY', 0x56: 'KP_MINUS',
        0x57: 'KP_PLUS', 0x58: 'KP_ENTER', 0x62: 'KP_N0', 0x63: 'KP_DOT', 0x64: 'NON_US_BSLH',
        0x65: 'K_APP', 0x67: 'KP_EQUAL', 0x85: 'KP_COMMA',
        0xE0: 'LCTRL', 0xE1: 'LSHFT', 0xE2: 'LALT', 0xE3: 'LGUI',
        0xE4: 'RCTRL', 0xE5: 'RSHFT', 0xE6: 'RALT', 0xE7: 'RGUI',
    }).forEach(([k, v]) => m.set(Number(k), v));
    return m;
})();

// HID consumer page (0x0C).
const CONSUMER = new Map(Object.entries({
    0xE9: 'C_VOL_UP', 0xEA: 'C_VOL_DN', 0xE2: 'C_MUTE', 0xCD: 'C_PP', 0xB5: 'C_NEXT',
    0xB6: 'C_PREV', 0xB7: 'C_STOP', 0xB3: 'C_FF', 0xB4: 'C_RW', 0x6F: 'C_BRI_UP',
    0x70: 'C_BRI_DN', 0x30: 'C_PWR', 0x32: 'C_SLEEP', 0xB8: 'C_EJECT', 0x192: 'C_AL_CALC',
    0x18A: 'C_AL_EMAIL', 0x221: 'C_AC_SEARCH', 0x223: 'C_AC_HOME', 0x224: 'C_AC_BACK',
    0x225: 'C_AC_FORWARD', 0x226: 'C_AC_STOP', 0x227: 'C_AC_REFRESH', 0x22A: 'C_AC_BOOKMARKS',
}).map(([k, v]) => [Number(k), v]));

// dt-bindings/zmk/keys.h names for plain Shift+key (US layout), as the firmware keymap writes them.
const SHIFTED = new Map(Object.entries({
    0x1E: 'EXCL', 0x1F: 'AT', 0x20: 'HASH', 0x21: 'DLLR', 0x22: 'PRCNT', 0x23: 'CARET', 0x24: 'AMPS',
    0x25: 'STAR', 0x26: 'LPAR', 0x27: 'RPAR', 0x2D: 'UNDER', 0x2E: 'PLUS', 0x2F: 'LBRC', 0x30: 'RBRC',
    0x31: 'PIPE', 0x33: 'COLON', 0x34: 'DQT', 0x35: 'TILDE', 0x36: 'LT', 0x37: 'GT', 0x38: 'QMARK',
}).map(([k, v]) => [Number(k), v]));

/** HID usage param ((mods<<24)|(page<<16)|id) -> `LC(LS(A))`, `C_VOL_UP`, ... */
export function usageToDt(param) {
    const p = param >>> 0;
    const mods = p >>> 24, page = (p >>> 16) & 0xFF, id = p & 0xFFFF;
    if (page === 0x07 && mods === 0x02 && SHIFTED.has(id)) return SHIFTED.get(id);
    const base = page === 0x07 ? KB.get(id) : page === 0x0C ? CONSUMER.get(id) : null;
    let s = base ?? `ZMK_HID_USAGE(0x${page.toString(16).toUpperCase()}, 0x${id.toString(16).toUpperCase()})`;
    for (const [bit, name] of [...MODS].reverse()) if (mods & bit) s = `${name}(${s})`;
    return s;
}

// displayName -> node + how params print: u usage, l layer, n number, - none.
const STOCK = {
    'Key Press': ['kp', 'u'], 'Transparent': ['trans'], 'None': ['none'],
    'Momentary Layer': ['mo', 'l'], 'To Layer': ['to', 'l'], 'Toggle Layer': ['tog', 'l'],
    'Sticky Layer': ['sl', 'l'], 'Layer-Tap': ['lt', 'l', 'u'], 'Mod-Tap': ['mt', 'u', 'u'],
    'Sticky Key': ['sk', 'u'], 'Key Toggle': ['kt', 'u'], 'Caps Word': ['caps_word'],
    'Key Repeat': ['key_repeat'], 'Reset': ['sys_reset'], 'Bootloader': ['bootloader'],
    'Output Selection': ['out', 'out'], 'Bluetooth': ['bt', 'bt', 'n'], 'Studio Unlock': ['studio_unlock'],
    'Mouse Key Press': ['mkp', 'mb'],
};
// Flask / Totem firmware nodes whose display name is stable (Totem-ZMK config/totem.keymap).
const FIRMWARE = {
    'Hold-Tap L (live)': ['fht_l', 'u', 'u'], 'Hold-Tap R (live)': ['fht_r', 'u', 'u'],
    'Hold-Tap (live)': ['fht', 'u', 'u'],
    'Layer-Tap Control combo (live)': ['flt_ctl', 'l', 'u'], 'Layer-Tap Fn combo (live)': ['flt_fn', 'l', 'u'],
    'Mod-Tap copy/cut combo (live)': ['fmt_copy', 'u', 'u'], 'Mod-Tap undo/redo combo (live)': ['fmt_undo', 'u', 'u'],
    'Mod-Tap Fn arrows (live)': ['fmt_nav', 'u', 'u'], 'Autoshift (live)': ['fas_ht', 'u', 'u'],
    'Mod-Tap (fast 150)': ['mt_fast', 'u', 'u'], 'Mod-Tap (slow 300)': ['mt_slow', 'u', 'u'],
    'Layer-Tap (fast 150)': ['lt_fast', 'l', 'u'], 'Layer-Tap (slow 300)': ['lt_slow', 'l', 'u'],
    'Sticky Mod (smart)': ['skm', 'u'], 'Smart Mod': ['smart_mod', 'u', 'u'],
    'Sticky Layer (smart)': ['skl', 'l'], 'Smart Layer': ['smart_layer', 'l', 'l'],
    'Num Word': ['num_word', 'l'], 'Flask Leader': ['fled'],
};
// bt.h: BT_SEL and BT_DISC take a profile index (second cell); the rest take none.
const BT = { 0: 'BT_CLR', 1: 'BT_NXT', 2: 'BT_PRV', 3: 'BT_SEL', 4: 'BT_CLR_ALL', 5: 'BT_DISC' };
const BT_WITH_PROFILE = new Set([3, 5]);
const OUT = { 0: 'OUT_TOG', 1: 'OUT_USB', 2: 'OUT_BLE' };

const KIND = { hid_usage: 'u', layer_id: 'l', constant: 'n', range: 'n' };
const kindsFromMeta = (meta) => {
    const m = meta?.[0];
    return ['param1', 'param2'].map((k) => KIND[m?.[k]?.[0]?.kind] ?? '-');
};

// Rows (public key positions) per family, for the human-shaped binding grid.
const ROWS = {
    totem: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
        [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], [32, 33, 34, 35, 36, 37]],
};
const SPLIT = { totem: [5, 5, 6, 3] };   // left-hand count per row (gap printed after it)

const ident = (s, fallback) => {
    const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return /^[a-z]/.test(t) ? t : fallback;
};
/** Quoted devicetree string body: escape \\ and ", drop control characters. */
export const dtStr = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\"]/g, (c) => '\\' + c);
const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase()}`;

export function exportKeymapText(data, opts = {}) {
    const notExported = [];
    const family = data.family ?? 'zmk';
    const layers = data.layers ?? [];
    const catalog = new Map();
    for (const b of (opts.behaviors instanceof Map ? [...opts.behaviors.values()] : opts.behaviors ?? [])) catalog.set(b.id, b);

    // ---- layer names: L_BASE-style defines, unique
    const used = new Set();
    const layerDef = layers.map((l, i) => {
        let n = `L_${ident(l.name, `${i}`).toUpperCase()}`;
        while (used.has(n)) n += `_${i}`;
        used.add(n);
        return n;
    });
    const idToIndex = new Map(layers.map((l, i) => [l.id ?? i, i]));
    const layerRef = (v) => {
        const i = idToIndex.get(v);
        return i == null ? String(v) : layerDef[i];
    };

    // ---- slot content that becomes nodes (filled while walking bindings)
    const flask = data.flask ?? {};
    const macroSlots = flask.macros?.slots ?? [];
    const tdSlots = flask.tapDance?.slots ?? [];
    const macroNode = new Map(), tdNode = new Map();    // slot -> node name, once referenced/non-empty
    const firmwareRefs = new Map();                     // node -> display name
    let usesSwitchLayout = false, usesPointing = false;
    const slotName = (kind, i) => data.flask?.slotNames?.[kind]?.[i] ?? '';

    const macroLive = (i) => (macroSlots[i] ?? []).filter((s) => s.action !== 0);
    const tdLive = (i) => (tdSlots[i]?.taps ?? []).filter((t) => t.action !== 0);
    const macroRef = (i) => { if (!macroLive(i).length) return null; macroNode.set(i, macroNode.get(i) ?? `fmac_${i}`); return `&${macroNode.get(i)}`; };
    const tdRef = (i) => { if (!tdLive(i).length) return null; tdNode.set(i, tdNode.get(i) ?? `ftd_${i}`); return `&${tdNode.get(i)}`; };

    // ---- bindings
    const val = (kind, p, ctxName) => {
        const v = p >>> 0;
        if (kind === 'u') return usageToDt(v);
        if (kind === 'l') return layerRef(v);
        if (kind === 'out') return OUT[v] ?? String(v);
        if (kind === 'mb') return v && !(v & (v - 1)) ? `MB${Math.log2(v) + 1}` : hex(v);
        if (kind === 'bt') return BT[v] ?? String(v);
        if (kind === 'raw' && v === 0xFFFF) { usesSwitchLayout = true; return 'OS_NEXT'; }
        return kind === 'raw' ? hex(v) : String(v);
    };
    /** One binding -> `&node a b` text, or null when it cannot be written. */
    const binding = (behaviorId, behavior, p1, p2, where) => {
        const meta = catalog.get(behaviorId);
        const name = behavior ?? meta?.displayName ?? '';
        let node, kinds;
        if (STOCK[name]) [node, ...kinds] = STOCK[name];
        else if (name === 'Flask Macro' || name === 'Tap Dance') {
            const ref = name === 'Tap Dance' ? tdRef(p1 >>> 0) : macroRef(p1 >>> 0);
            if (!ref) { notExported.push(`${where}: ${name} slot ${p1 >>> 0} is empty, written as &none`); return '&none'; }
            return ref;
        } else if (FIRMWARE[name]) {
            [node, ...kinds] = FIRMWARE[name];
            firmwareRefs.set(node, name);
        } else {
            const n = opts.nodeById?.(behaviorId, meta);
            if (!n) {
                notExported.push(`${where}: behavior #${behaviorId}${name ? ` "${name}"` : ' (no display name)'} p1=${hex(p1)} p2=${hex(p2)} has no known devicetree node, written as &none`);
                return '&none';
            }
            node = n;
            kinds = kindsFromMeta(meta?.metadata);
            firmwareRefs.set(node, name || 'firmware-defined, no display name');
        }
        if (node === 'mkp') usesPointing = true;
        const args = [];
        let k1 = kinds[0] ?? '-', k2 = kinds[1] ?? '-';
        // A parameter the app has no metadata for must not vanish: print it raw.
        if (k1 === '-' && p1 >>> 0) { k1 = 'raw'; if (p1 >>> 0 !== 0xFFFF) notExported.push(`${where}: &${node} parameter ${hex(p1)} has no metadata, written as a raw number`); }
        if (k2 === '-' && p2 >>> 0) { k2 = 'raw'; notExported.push(`${where}: &${node} second parameter ${hex(p2)} has no metadata, written as a raw number`); }
        if (k1 !== '-') args.push(val(k1, p1));
        if (k2 !== '-' && !(k1 === 'bt' && !BT_WITH_PROFILE.has(p1 >>> 0))) args.push(val(k2, p2));
        return `&${node}${args.length ? ' ' + args.join(' ') : ''}`;
    };
    const typedOut = (o, where) => {   // combo / tap-dance output {action,behaviorId,param1,param2}
        if (o.action === 1) return `&kp ${usageToDt(o.param1)}`;
        if (o.action === 2) return macroRef(o.param1 >>> 0) ?? (notExported.push(`${where}: empty macro slot ${o.param1}`), null);
        if (o.action === 3) return binding(o.behaviorId, null, o.param1, o.param2, where);
        return null;
    };

    // ---- layers
    const usedIds = new Set();
    const layerBlocks = layers.map((l, li) => {
        const cells = l.bindings.map((b, pos) => binding(b.behaviorId, b.behavior, b.param1 ?? 0, b.param2 ?? 0, `layer ${li} "${l.name}" key ${pos}`));
        let id = ident(l.name, `layer_${li}`);
        while (usedIds.has(id)) id += `_${li}`;
        usedIds.add(id);
        return { name: l.name, id, cells };
    });
    const grid = (cells) => {
        const rows = ROWS[family]?.filter((r) => r.every((p) => p < cells.length));
        const covered = rows ? rows.flat().length : 0;
        const lines = [];
        const w = Math.max(...cells.map((c) => c.length));
        const pad = (c) => c.padEnd(w);
        if (rows && covered === cells.length) {
            const maxLeft = Math.max(...rows.map((r, ri) => SPLIT[family]?.[ri] ?? r.length));
            rows.forEach((r, ri) => {
                const split = SPLIT[family]?.[ri] ?? r.length;
                const indent = ' '.repeat((maxLeft - split) * (w + 1));
                const left = r.slice(0, split).map((p) => pad(cells[p])).join(' ');
                const right = r.slice(split).map((p) => pad(cells[p])).join(' ');
                lines.push(`${indent}${left}${right ? '   ' + right : ''}`.trimEnd());
            });
        } else {
            for (let i = 0; i < cells.length; i += 10) lines.push(cells.slice(i, i + 10).map(pad).join(' ').trimEnd());
        }
        return lines;
    };

    // ---- combos
    const comboOut = [];
    const combos = flask.combos?.slots ?? [];
    combos.forEach((s, i) => {
        if (!s.positions?.length) return;
        let b = null;
        if (s.action != null) b = typedOut(s, `combo ${i}`);
        else if (s.usage) b = `&kp ${usageToDt(s.usage)}`;   // pre-v12 slot
        if (b === '&none') { notExported.push(`combo ${i} (keys ${s.positions.join(' ')}) skipped: its output could not be written`); return; }
        if (!b || s.positions.length < 2) {
            if (s.positions.length) notExported.push(`combo ${i} (keys ${s.positions.join(' ')}) is incomplete (needs two keys and an output), skipped`);
            return;
        }
        const nm = ident(slotName('combos', i), '') || ident(opts.comboNameFor?.(i, s.positions), '') || `combo_${i}`;
        const lines = [`        ${nm} {`,
            `            bindings = <${b}>;`,
            `            key-positions = <${s.positions.join(' ')}>;`];
        const t = s.timeoutMs || flask.combos?.timeout;
        if (t) lines.push(`            timeout-ms = <${t}>;`);
        if (s.priorIdleMs) lines.push(`            require-prior-idle-ms = <${s.priorIdleMs}>;`);
        if (s.layer != null && s.layer !== 0xFF) lines.push(`            layers = <${layerRef(s.layer)}>;`);
        lines.push('        };');
        comboOut.push(lines.join('\n'));
    });
    if (flask.combos && flask.combos.enabled === 0) notExported.push('combos master switch is OFF in the app (runtime setting, not a devicetree property)');

    // ---- macro / tap dance nodes (all non-empty slots, referenced or not)
    macroSlots.forEach((_, i) => { if (macroLive(i).length) macroRef(i); });
    tdSlots.forEach((_, i) => { if (tdLive(i).length) tdRef(i); });
    const macroText = [...macroNode].sort((a, b) => a[0] - b[0]).map(([i, node]) => {
        const steps = macroLive(i).map((s) => {
            if (s.action === 4) return `&macro_wait_time ${s.param}`;
            const op = { 1: 'macro_tap', 2: 'macro_press', 3: 'macro_release' }[s.action];
            return `&${op} &kp ${usageToDt(s.param)}`;
        });
        return [`        ${node}: ${node} {`,
            '            compatible = "zmk,behavior-macro";',
            '            #binding-cells = <0>;',
            `            display-name = "${dtStr(slotName('macros', i) || `Flask macro ${i}`)}";`,
            ...(flask.macros?.waitMs ? [`            wait-ms = <${flask.macros.waitMs}>;`] : []),
            ...(flask.macros?.tapMs ? [`            tap-ms = <${flask.macros.tapMs}>;`] : []),
            `            bindings = <${steps.join(' ')}>;`,
            '        };'].join('\n');
    });
    const tdText = [...tdNode].sort((a, b) => a[0] - b[0]).map(([i, node]) => {
        const bs = tdLive(i).map((t) => typedOut(t, `tap dance ${i}`) ?? '&none');
        return [`        ${node}: ${node} {`,
            '            compatible = "zmk,behavior-tap-dance";',
            '            #binding-cells = <0>;',
            `            display-name = "Flask tap dance ${i}";`,
            `            tapping-term-ms = <${tdSlots[i].termMs || 200}>;`,
            `            bindings = ${bs.map((b) => `<${b}>`).join(', ')};`,
            '        };'].join('\n');
    });

    // ---- hold timing: EVERY slot is written (the compiled default for slots the
    // user never touched, the custom value for the rest); a slot that could not
    // be read is listed, never dropped silently.
    const FLAV = ['hold-preferred', 'balanced', 'tap-preferred', 'tap-unless-interrupted'];
    for (const u of data.holdtapUnreadable ?? []) notExported.push(`hold timing slot ${u.slot ?? u}${u.error ? ` could not be read (${u.error})` : ' could not be read'}, not written`);
    const htText = (data.holdtap ?? []).map((s) => {
        const virtual = s.kind === 'virtual';
        const nm = virtual ? ident(s.name, `slot_${s.slot}`) : `key_${s.slot}`;
        return [`        ht_${nm} {`,
            ...(virtual ? [`            /* virtual slot ${s.slot}${s.name ? ': ' + String(s.name).replace(/\*\//g, '* /') : ''} (no key position) */`]
                : [`            key-positions = <${s.slot}>;`]),
            `            tapping-term-ms = <${s.term}>;`,
            ...(s.quick ? [`            quick-tap-ms = <${s.quick}>;`] : []),
            ...(s.idle ? [`            require-prior-idle-ms = <${s.idle}>;`] : []),
            `            flavor = "${FLAV[s.flavor] ?? 'balanced'}";`,
            '        };'].join('\n');
    });

    // ---- what the app holds that devicetree cannot
    const leaderLive = (flask.leader?.slots ?? []).filter((s) => s.positions?.length && s.action).length;
    if (leaderLive) notExported.push(`leader: ${leaderLive} flask_leader sequence(s) (position-based runtime slots; urob's leader-key nodes are key-code based). Re-create them in the firmware's leader node or keep the app's JSON export.`);
    const cskLive = (flask.customShift?.slots ?? []).filter((s) => s.base || s.shifted).length;
    if (cskLive) notExported.push(`shift keys: ${cskLive} custom-shift pair(s) (flask_csk is a global runtime table; model them as mod-morph nodes by hand).`);
    const gestLive = (flask.gestures?.sets ?? []).flat().filter((g) => g.action).length;
    if (gestLive) notExported.push(`gestures: ${gestLive} gesture binding(s) (Imprint trackball runtime table).`);
    const settings = ['autoscroll', 'accel', 'scrollSnap', 'scrollSpeed', 'ballSwap', 'autoMouse', 'rgb']
        .filter((k) => flask[k]);
    if (settings.length) notExported.push(`device settings (runtime, Kconfig/devicetree-less): ${settings.join(', ')}.`);

    // ---- assemble
    const out = [];
    out.push('/*');
    out.push(` * ${data.device ?? 'ZMK board'} (${family}) keymap, exported from Totem-Flask ${opts.date ?? new Date().toISOString().slice(0, 10)}.`);
    out.push(` * ${layers.length} layers, ${layers[0]?.bindings.length ?? 0} keys each.`);
    out.push(' *');
    out.push(' * NOT a drop-in replacement for the firmware\'s own .keymap: behaviours the firmware');
    out.push(' * defines (&fht_l, &slk_*, &fled, ...) are only referenced by node name and must come');
    out.push(' * from the config repo; this file carries the app\'s layers, combos, macros and timing.');
    if (family === 'totem') {
        out.push(' *');
        out.push(' * Key positions (transform order):');
        out.push(' *          0  1  2  3  4      5  6  7  8  9');
        out.push(' *         10 11 12 13 14     15 16 17 18 19');
        out.push(' *      20 21 22 23 24 25     26 27 28 29 30 31');
        out.push(' *               32 33 34     35 36 37');
    }
    out.push(' */');
    out.push('');
    out.push('#include <behaviors.dtsi>');
    out.push('#include <dt-bindings/zmk/bt.h>');
    out.push('#include <dt-bindings/zmk/keys.h>');
    out.push('#include <dt-bindings/zmk/outputs.h>');
    if (usesPointing) out.push('#include <dt-bindings/zmk/pointing.h>');
    if (usesSwitchLayout) out.push('#include <dt-bindings/zmk-switch-layout/switch-layout.h>');
    const osDefine = usesSwitchLayout ? ['', '#define OS_NEXT ZMK_SWITCH_LAYOUT_NEXT'] : [];
    out.push(...osDefine);
    out.push('');
    layerDef.forEach((n, i) => out.push(`#define ${n.padEnd(Math.max(...layerDef.map((x) => x.length)))} ${i}`));
    out.push('');
    if (firmwareRefs.size) {
        out.push('/* Defined by the firmware repo, referenced here by node name (the app only knows their');
        out.push(' * display names; copy their nodes from your config/*.keymap if building elsewhere):');
        for (const [node, dn] of [...firmwareRefs].sort()) out.push(` *   &${node}  "${String(dn).replace(/\*\//g, '* /')}"`);
        out.push(' */');
        out.push('');
    }
    out.push('/ {');
    if (tdText.length) {
        out.push('    /* Flask tap dance slots (&ftd N) written as stock zmk,behavior-tap-dance nodes. */');
        out.push('    behaviors {');
        out.push(tdText.join('\n\n'));
        out.push('    };');
        out.push('');
    }
    if (macroText.length) {
        out.push('    /* Flask macro slots (&fmac N) written as stock zmk,behavior-macro nodes. */');
        out.push('    macros {');
        out.push(macroText.join('\n\n'));
        out.push('    };');
        out.push('');
    }
    if (comboOut.length) {
        const flaskCombos = (opts.combos ?? 'flask') === 'flask';
        out.push(flaskCombos
            ? '    /* Runtime combo slots seeded from this node (flask_combos). Pass {combos:"zmk"} for stock zmk,combos. */'
            : '    /* Stock ZMK combos. */');
        out.push(flaskCombos ? '    flask_combos_defaults {' : '    combos {');
        out.push(`        compatible = "${flaskCombos ? 'flask,combos-defaults' : 'zmk,combos'}";`);
        out.push('');
        out.push(comboOut.join('\n\n'));
        out.push('    };');
        out.push('');
    }
    if (htText.length) {
        out.push('    /* Per-key hold timing (flask_holdtap slots: compiled defaults plus any changed in the app; slot index = key position). */');
        out.push('    flask_holdtap_defaults {');
        out.push('        compatible = "flask,holdtap-defaults";');
        out.push('');
        out.push(htText.join('\n\n'));
        out.push('    };');
        out.push('');
    }
    out.push('    keymap {');
    out.push('        compatible = "zmk,keymap";');
    layerBlocks.forEach((lb, i) => {
        out.push('');
        out.push(`        ${lb.id} {`);
        out.push(`            display-name = "${dtStr(lb.name)}";`);
        const g = grid(lb.cells);
        out.push('            bindings = <');
        g.forEach((line) => out.push(`                ${line}`));
        out.push('            >;');
        out.push('        };');
    });
    out.push('    };');
    out.push('};');
    out.push('');
    out.push('/* not exported:');
    if (!notExported.length) out.push(' *   (nothing: every app setting that has a devicetree form was written)');
    for (const n of notExported) out.push(` *   - ${n.replace(/\*\//g, '* /')}`);
    out.push(' */');
    out.push('');
    return { text: out.join('\n'), notExported };
}
