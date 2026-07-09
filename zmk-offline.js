// ZMK offline preview — a device-less Cyboard Imprint workspace, so the
// whole ZMK surface (Studio keymap editor, Mouse/RGB/Combos/Macros tabs)
// can be beta-tested with no hardware attached. ZMK-line module: main.js
// gets one dispatch branch; nothing QMK imports from here.
//
// Two stand-ins:
//  - ZmkOfflineFlask — the Flask raw-HID frame (channels 0x00/0x1A/0x21/
//    0x23/0x24/0x25) against workspace state, journaling edits for replay
//    on the next real connect (tunables + RGB ride the shared QMK journal
//    shapes so offline.js syncWorkspace applies them; combo slots + macro
//    steps live in ws.zmkDirty and replay via zmkSyncExtras below).
//  - OfflineStudioClient — the ZMK Studio RPC client surface
//    (zmk-keymap-tab duck type) against a stored keymap: full editing,
//    layer ops, rename, save/discard, unlock always open. Keymap edits do
//    NOT queue-sync (export/import JSON is the restore path to a real
//    board); they persist in the workspace for the next preview session.
//
// Geometry + default keymap approximate the real Imprint firmware
// (Cyboard-ZMK config/info.json + imprint.keymap): 70 positions, rows
// 12/12/12/12/10/6/6, layers Base/Control/Fn/Mouse/Snipe/Num + 4 spares.

import { CH, V } from './flaskproto.js?v=6';
import { ZMK_EXPECTED_PROTOCOL, ZMK_FAMILY_LABELS, zmkCapabilities } from './zmk.js?v=6';
import { OfflineFlask, saveWorkspace } from './offline.js?v=6';
import { LOCK_UNLOCKED } from './zmk-studio.js?v=6';
import { kpParam, cpParam, usageFromName } from './zmk-keycodes.js?v=6';
import { decodeComboSlot, encodeComboSlot, COMBO_MAX_KEYS, COMBO_POS_NONE } from './zmk-combos-codec.js?v=6';
import { decodeMacroStep, encodeMacroStep, MACRO_ACTION } from './zmk-macros-codec.js?v=6';

export const ZMK_TEMPLATE_FAMILIES = ['imprint'];

const IMPRINT = {
    positions: 70,
    rgbLayers: 10,
    rgbLeds: 70,
    comboSlots: 32,
    macroSlots: 16,
    macroSteps: 16,
};

// 70 key positions, transform order (Cyboard-ZMK config/info.json — the
// same file the real imprint_physical_layout was generated from).
const IMPRINT_GEOM = [
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 },
    { x: 11.5, y: 1 }, { x: 12.5, y: 1 }, { x: 13.5, y: 1 }, { x: 14.5, y: 1 }, { x: 15.5, y: 1 }, { x: 16.5, y: 1 },
    { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }, { x: 5, y: 2 },
    { x: 11.5, y: 2 }, { x: 12.5, y: 2 }, { x: 13.5, y: 2 }, { x: 14.5, y: 2 }, { x: 15.5, y: 2 }, { x: 16.5, y: 2 },
    { x: 0, y: 3 }, { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 },
    { x: 11.5, y: 3 }, { x: 12.5, y: 3 }, { x: 13.5, y: 3 }, { x: 14.5, y: 3 }, { x: 15.5, y: 3 }, { x: 16.5, y: 3 },
    { x: 0, y: 4 }, { x: 1, y: 4 }, { x: 2, y: 4 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 },
    { x: 11.5, y: 4 }, { x: 12.5, y: 4 }, { x: 13.5, y: 4 }, { x: 14.5, y: 4 }, { x: 15.5, y: 4 }, { x: 16.5, y: 4 },
    { x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 5 }, { x: 4, y: 5 }, { x: 12.5, y: 5 },
    { x: 13.5, y: 5 }, { x: 14.5, y: 5 }, { x: 15.5, y: 5 }, { x: 16.5, y: 5 }, { x: 5.5, y: 5.5 }, { x: 6.5, y: 5.5 },
    { x: 7.5, y: 5.5 }, { x: 9, y: 5.5 }, { x: 10, y: 5.5 }, { x: 11, y: 5.5 }, { x: 5.5, y: 6.5 }, { x: 6.5, y: 6.5 },
    { x: 7.5, y: 6.5 }, { x: 9, y: 6.5 }, { x: 10, y: 6.5 }, { x: 11, y: 6.5 },
];

// ---------------------------------------------------------------------------
// Simulated behavior catalog — ids are sim-local; display names and
// metadata shapes mirror the real device so the picker/composer, keycaps,
// export/import name-resolution, and the &fmac range slider all behave.

const B = {}; // name → id (template author convenience)

function buildBehaviorCatalog() {
    const usage = (name) => [{ name, kind: 'hid_usage' }];
    const layer = () => [{ name: 'Layer', kind: 'layer_id' }];
    const range = (name, min, max) => [{ name, kind: 'range', min, max }];
    const constants = (list) => list.map(([name, value]) => ({ name, kind: 'constant', constant: value }));
    const nil = [];

    let nextId = 1;
    const catalog = new Map();
    const add = (displayName, param1, param2 = nil) => {
        const id = nextId++;
        catalog.set(id, { id, displayName, metadata: [{ param1, param2 }] });
        B[displayName] = id;
        return id;
    };

    add('Key Press', usage('Key'));
    add('Transparent', nil);
    add('None', nil);
    add('Momentary Layer', layer());
    add('To Layer', layer());
    add('Toggle Layer', layer());
    add('Sticky Layer', layer());
    add('Layer-Tap', layer(), usage('Tap'));
    add('Mod-Tap', usage('Hold'), usage('Tap'));
    add('Sticky Key', usage('Key'));
    add('Key Toggle', usage('Key'));
    add('Caps Word', nil);
    add('Key Repeat', nil);
    add('Mouse Key Press', constants([
        ['MB1', 0x01], ['MB2', 0x02], ['MB3', 0x04], ['MB4', 0x08], ['MB5', 0x10],
    ]));
    add('Reset', nil);
    add('Bootloader', nil);
    add('Output Selection', constants([['Toggle', 0], ['USB', 1], ['BLE', 2]]));
    add('Bluetooth', constants([
        ['Clear', 0], ['Next', 1], ['Previous', 2], ['Select', 3],
    ]), range('Profile', 0, 4));
    add('Studio Unlock', nil);
    add('Flask Autoscroll', constants([['Up', 0], ['Down', 1], ['Stop', 2]]));
    add('Flask RGB', constants([['Toggle', 0], ['On', 1], ['Off', 2]]));
    add('Flask Macro', range('Macro slot', 0, IMPRINT.macroSlots - 1));
    add('Swapper', nil);
    add('Num Word', layer());
    add('Leader Key', nil);
    return catalog;
}

const BEHAVIORS = buildBehaviorCatalog();

// ---------------------------------------------------------------------------
// Default keymap — approximates config/imprint.keymap. Layer ids are stable
// small ints (Studio semantics: ids never change, indices do).

const bind = (behaviorId, param1 = 0, param2 = 0) => ({ behaviorId, param1, param2 });
const KP = (name) => {
    const p = usageFromName(name);
    if (p == null) throw new Error(`zmk-offline: unknown key name "${name}"`);
    return bind(B['Key Press'], p);
};
const TR = () => bind(B.Transparent);
const NO = () => bind(B.None);
const MO = (l) => bind(B['Momentary Layer'], l);
const MT = (hold, tap) => bind(B['Mod-Tap'], usageFromName(hold), usageFromName(tap));
const MB = (n) => bind(B['Mouse Key Press'], 1 << (n - 1));

function row(...binds) { return binds; }
const trRow = (n) => Array.from({ length: n }, TR);

function buildDefaultLayers() {
    // Layer ids: Base 0, Control 1, Fn 2, Mouse 3, Snipe 4, Num 5, spares 6-9.
    const base = [
        ...row(TR(), KP('1'), KP('2'), KP('3'), KP('4'), KP('5'),
            KP('6'), KP('7'), KP('8'), KP('9'), KP('0'), TR()),
        ...row(TR(), KP('Q'), KP('W'), KP('E'), KP('R'), KP('T'),
            KP('Y'), KP('U'), KP('I'), KP('O'), KP('P'), TR()),
        ...row(TR(), KP('A'), KP('S'), KP('D'), KP('F'), KP('G'),
            KP('H'), KP('J'), KP('K'), KP('L'), KP('Semicolon'), KP('Quote')),
        ...row(TR(), KP('Z'), KP('X'), KP('C'), KP('V'), KP('B'),
            KP('N'), KP('M'), KP('Comma'), KP('Dot'), KP('Slash'), TR()),
        ...row(TR(), KP('F20'), KP('F11'), KP('F12'), KP('Grave'),
            KP('Down'), KP('Up'), KP('Left'), KP('Right'), TR()),
        ...row(MT('Left GUI', 'H'), MT('Left Shift', 'Space'), MB(1),
            MB(1), MT('Right Shift', 'Space'), MT('Right GUI', 'L')),
        ...row(MT('Left Ctrl', 'T'), MT('Left Ctrl', 'Backspace'), MB(2),
            MB(3), MT('Right Ctrl', 'Delete'), MT('Right Shift', 'R')),
    ];

    const control = [
        ...row(bind(B.Bootloader), TR(), TR(), TR(), TR(), TR(),
            TR(), bind(B['Flask Autoscroll'], 0), bind(B['Flask Autoscroll'], 1),
            bind(B.Swapper), bind(B['Num Word'], 5), KP('Tab')),
        ...row(TR(), KP('Volume Up'), KP('Home'), KP('Up'), KP('End'), TR(),
            TR(), bind(B['Key Repeat']), KP('Tab'), KP('Up'), KP('Tab'), TR()),
        ...row(TR(), KP('Volume Down'), KP('Left'), KP('Down'), KP('Right'), bind(B['Leader Key']),
            bind(B['Caps Word']), KP('Enter'), KP('Left'), KP('Down'), KP('Right'), KP('Escape')),
        ...row(TR(), KP('Mute'), KP('Play/Pause'), KP('Rewind'), KP('Fast Forward'), TR(),
            TR(), bind(B['Flask RGB'], 1), bind(B['Flask RGB'], 2), bind(B['Flask RGB'], 0), TR(), TR()),
        ...trRow(10),
        ...row(TR(), bind(B.Bluetooth, 3, 0), bind(B.Bluetooth, 3, 1),
            bind(B['Output Selection'], 0), bind(B.Reset), bind(B.Bluetooth, 0)),
        ...row(TR(), bind(B.Bluetooth, 3, 2), bind(B.Bluetooth, 3, 3),
            bind(B['Studio Unlock']), TR(), TR()),
    ];

    const fn = [
        ...trRow(12),
        ...row(TR(), KP('F1'), KP('F2'), KP('F3'), KP('F4'), KP('F13'),
            TR(), TR(), TR(), TR(), TR(), TR()),
        ...row(TR(), KP('F5'), KP('F6'), KP('F7'), KP('F8'), KP('F14'),
            KP('F16'), KP('F17'), KP('F18'), KP('F19'), KP('F20'), TR()),
        ...row(TR(), KP('F9'), KP('F10'), KP('F11'), KP('F12'), KP('F15'),
            KP('F21'), KP('F22'), KP('F23'), KP('F24'), NO(), TR()),
        ...row(NO(), TR(), TR(), TR(), TR(), TR(), TR(), TR(), TR(), TR()),
        ...trRow(6), ...trRow(6),
    ];

    const mouse = [
        ...trRow(12), ...trRow(12),
        ...row(TR(), MO(4), NO(), MB(2), MB(1), MB(3),
            MB(3), MB(1), MB(2), TR(), TR(), TR()),
        ...trRow(12), ...trRow(10), ...trRow(6), ...trRow(6),
    ];

    const numRow = [
        ...trRow(12),
        ...row(TR(), TR(), TR(), TR(), TR(), TR(),
            TR(), KP('7'), KP('8'), KP('9'), KP('Slash'), TR()),
        ...row(TR(), TR(), TR(), TR(), TR(), TR(),
            TR(), KP('4'), KP('5'), KP('6'), KP('Keypad *'), KP('Minus')),
        ...row(TR(), TR(), TR(), TR(), TR(), TR(),
            TR(), KP('1'), KP('2'), KP('3'), KP('Keypad +'), KP('Equal')),
        ...row(TR(), TR(), TR(), TR(), TR(),
            KP('0'), KP('Dot'), KP('Comma'), TR(), TR()),
        ...trRow(6), ...trRow(6),
    ];

    const layers = [
        { id: 0, name: 'Base', bindings: base },
        { id: 1, name: 'Control', bindings: control },
        { id: 2, name: 'Fn', bindings: fn },
        { id: 3, name: 'Mouse', bindings: mouse },
        { id: 4, name: 'Snipe', bindings: Array.from({ length: IMPRINT.positions }, TR) },
        { id: 5, name: 'Num', bindings: numRow },
        { id: 6, name: 'spare1', bindings: Array.from({ length: IMPRINT.positions }, TR) },
        { id: 7, name: 'spare2', bindings: Array.from({ length: IMPRINT.positions }, TR) },
        { id: 8, name: 'spare3', bindings: Array.from({ length: IMPRINT.positions }, TR) },
        { id: 9, name: 'spare4', bindings: Array.from({ length: IMPRINT.positions }, TR) },
    ];
    for (const l of layers) {
        if (l.bindings.length !== IMPRINT.positions) {
            throw new Error(`zmk-offline: layer ${l.name} has ${l.bindings.length} bindings (want ${IMPRINT.positions})`);
        }
    }
    return layers;
}

// ---------------------------------------------------------------------------
// Template workspace

export function createZmkTemplate(family) {
    if (family !== 'imprint') throw new Error(`no ZMK template for family "${family}"`);
    const layers = buildDefaultLayers();
    const keymap = { layers, availableLayers: 0, maxLayerNameLength: 20 };
    const version = ZMK_EXPECTED_PROTOCOL[family];

    // Firmware defaults, so the tuning cards open with real values.
    const tun = {};
    const seed = (ch, id, val) => { tun[`${ch}:${id}`] = { op: 'u16', val }; };
    seed(CH.autoscroll, V.asInverted, 0);
    seed(CH.autoscroll, V.asSpeedScale, 100);
    seed(CH.autoscroll, V.asStopOnKey, 1);
    seed(CH.rgbMap, V.rgbmapEnabled, 1);
    seed(CH.combos, V.combosEnabled, 1);
    seed(CH.combos, V.combosTimeout, 50);
    seed(CH.macros, V.macrosEnabled, 1);
    seed(CH.macros, V.macrosTapMs, 30);
    seed(CH.macros, V.macrosWaitMs, 15);

    return {
        v: 1, key: family, family,
        label: `${ZMK_FAMILY_LABELS[family]} preview`,
        source: 'template', savedAt: Date.now(),
        protocolVersion: version,
        layerCount: layers.length,
        profile: {
            family,
            name: ZMK_FAMILY_LABELS[family],
            matrixRows: 0, matrixCols: 0,
            keys: IMPRINT_GEOM.map((k, i) => ({
                row: 0, col: i, pos: i, label: `Key ${i}`,
                x: k.x, y: k.y, w: k.w ?? 1, h: k.h ?? 1,
            })),
            encoderKeys: [], encoderPushKeys: {}, displayTile: null,
            customKeycodes: [],
            layerNames: layers.map((l) => l.name),
        },
        keymap: null,           // QMK field; the ZMK keymap lives under zmk.
        tunables: tun,
        dirty: { km: {}, enc: {}, tun: {}, qsid: {}, td: {}, combo: {}, ko: {}, ar: {}, rgb: {}, dispText: {}, saves: [], macros: false },
        zmk: {
            keymap,
            keymapSaved: structuredClone(keymap),
            pendingKeymap: null, // export-shaped snapshot queued for real connect
            removed: [],        // removed layers waiting for restore
            nextLayerId: layers.length,
            unsaved: false,
            combos: Array.from({ length: IMPRINT.comboSlots }, () => ({ positions: [], usage: 0 })),
            macros: Array.from({ length: IMPRINT.macroSlots }, () =>
                Array.from({ length: IMPRINT.macroSteps }, () => ({ action: MACRO_ACTION.empty, param: 0 }))),
            rgb: Array.from({ length: IMPRINT.rgbLayers }, () =>
                Array.from({ length: IMPRINT.rgbLeds }, () => [0, 0, 0])),
        },
        zmkDirty: { combo: {}, macroStep: {} },
    };
}

/** Older stored ZMK workspaces: fill fields added later (append-only). */
export function normalizeZmkWorkspace(ws) {
    ws.zmkDirty ??= { combo: {}, macroStep: {} };
    ws.zmkDirty.combo ??= {};
    ws.zmkDirty.macroStep ??= {};
    if (ws.zmk) ws.zmk.pendingKeymap ??= null;
    return ws;
}

export function zmkPendingCount(ws) {
    const d = ws.zmkDirty;
    if (!d) return 0;
    return Object.keys(d.combo).length + Object.keys(d.macroStep).length
        + (ws.zmk?.pendingKeymap ? 1 : 0);
}

/** Drop everything ZMK-shaped queued for replay (the banner's Discard). */
export function zmkClearDirty(ws) {
    ws.zmkDirty = { combo: {}, macroStep: {} };
    if (ws.zmk) ws.zmk.pendingKeymap = null;
    saveWorkspace(ws);
}

// ---------------------------------------------------------------------------
// Flask frame stand-in

export class ZmkOfflineFlask extends OfflineFlask {
    constructor(ws) {
        super(ws);
        normalizeZmkWorkspace(ws);
    }

    async getU16(ch, id) {
        if (ch === CH.meta) {
            if (id === V.metaProtocolVersion) return this.ws.protocolVersion;
            if (id === V.metaActiveLayer) return 0;
            if (id === V.metaFamily) return 4; // imprint
            return 0;
        }
        if (ch === CH.rgbMap && id === V.rgbmapLayers) return this.ws.zmk.rgb.length;
        if (ch === CH.rgbMap && id === V.rgbmapLeds) return this.ws.zmk.rgb[0].length;
        if (ch === CH.combos && id === V.combosSlotCount) return this.ws.zmk.combos.length;
        if (ch === CH.macros && id === V.macrosSlotCount) return this.ws.zmk.macros.length;
        if (ch === CH.macros && id === V.macrosStepCount) return this.ws.zmk.macros[0].length;
        if (ch === CH.macros && id === V.macrosState) return 0; // never "playing"
        return super.getU16(ch, id);
    }

    async setU16(ch, id, value) {
        // Live-state ids the QMK LIVE_SET can't know about — never journal.
        if (ch === CH.meta || (ch === CH.macros && id === V.macrosState)) {
            return Math.max(0, Math.min(0xFFFF, Math.round(value))) & 0xFFFF;
        }
        return super.setU16(ch, id, value);
    }

    async getBytes(ch, id, payload = []) {
        const { zmk } = this.ws;
        if (ch === CH.keyState && id === V.keyStateBitmap) {
            return new Array(16).fill(0);
        }
        if (ch === CH.rgbMap && id === V.rgbmapLed) {
            const [layer, led] = payload;
            const hsv = zmk.rgb[layer]?.[led] ?? [0, 0, 0];
            return [layer, led, ...hsv];
        }
        if (ch === CH.combos && id === V.combosSlot) {
            const slot = payload[0] ?? 0;
            const s = zmk.combos[slot] ?? { positions: [], usage: 0 };
            return encodeComboSlot(slot, s);
        }
        if (ch === CH.macros && id === V.macrosStep) {
            const [m, s] = payload;
            const step = zmk.macros[m]?.[s] ?? { action: MACRO_ACTION.empty, param: 0 };
            return encodeMacroStep(m, s, step);
        }
        return new Array(29).fill(0);
    }

    async setBytes(ch, id, payload) {
        const { zmk } = this.ws;
        if (ch === CH.rgbMap && id === V.rgbmapLed) {
            const [layer, led, h, s, v] = payload;
            if (zmk.rgb[layer]?.[led]) {
                zmk.rgb[layer][led] = [h, s, v];
                this.ws.dirty.rgb[`${layer},${led}`] = [h, s, v];
                saveWorkspace(this.ws);
            }
            return payload;
        }
        if (ch === CH.rgbMap && id === V.rgbmapFill) {
            const [layer, h, s, v] = payload;
            if (zmk.rgb[layer]) {
                for (let led = 0; led < zmk.rgb[layer].length; led++) {
                    zmk.rgb[layer][led] = [h, s, v];
                    this.ws.dirty.rgb[`${layer},${led}`] = [h, s, v];
                }
                saveWorkspace(this.ws);
            }
            return payload;
        }
        if (ch === CH.combos && id === V.combosSlot) {
            const decoded = decodeComboSlot(payload);
            const slot = decoded.slot;
            if (!zmk.combos[slot]) return payload;
            // Firmware normalization: positions must exist on the board.
            const positions = decoded.positions
                .filter((p) => p >= 0 && p < IMPRINT.positions)
                .slice(0, COMBO_MAX_KEYS);
            zmk.combos[slot] = { positions, usage: decoded.usage };
            this.ws.zmkDirty.combo[slot] = true;
            saveWorkspace(this.ws);
            return encodeComboSlot(slot, zmk.combos[slot]);
        }
        if (ch === CH.macros && id === V.macrosStep) {
            const step = decodeMacroStep(payload);
            if (!zmk.macros[step.slot] || step.step >= zmk.macros[step.slot].length) return payload;
            const norm = decodeMacroStep(encodeMacroStep(step.slot, step.step, step));
            zmk.macros[step.slot][step.step] = { action: norm.action, param: norm.param };
            this.ws.zmkDirty.macroStep[`${step.slot},${step.step}`] = true;
            saveWorkspace(this.ws);
            return encodeMacroStep(step.slot, step.step, norm);
        }
        return payload;
    }
}

// ---------------------------------------------------------------------------
// ZMK Studio RPC stand-in (zmk-keymap-tab duck type)

export class OfflineStudioClient extends EventTarget {
    constructor(ws) {
        super();
        this.ws = ws;
    }

    get connected() { return true; }

    async connect() { /* nothing to open */ }
    async disconnect() { /* nothing to close */ }

    _persist(unsaved = true) {
        this.ws.zmk.unsaved = unsaved;
        saveWorkspace(this.ws);
        this.dispatchEvent(new CustomEvent('unsaved', { detail: unsaved }));
    }

    _layerById(layerId) {
        return this.ws.zmk.keymap.layers.find((l) => l.id === layerId) ?? null;
    }

    async getDeviceInfo() { return { name: `${this.ws.label}`, serialNumber: 'offline' }; }
    async getLockState() { return LOCK_UNLOCKED; }
    async checkUnsavedChanges() { return !!this.ws.zmk.unsaved; }

    async getPhysicalLayouts() {
        return {
            activeLayoutIndex: 0,
            layouts: [{
                name: 'Imprint',
                keys: IMPRINT_GEOM.map((k) => ({ x: k.x, y: k.y, w: k.w ?? 1, h: k.h ?? 1, r: 0, rx: 0, ry: 0 })),
            }],
        };
    }

    async getKeymap() { return structuredClone(this.ws.zmk.keymap); }

    async listAllBehaviors() { return [...BEHAVIORS.keys()]; }
    async getBehaviorDetails(id) {
        const d = BEHAVIORS.get(id);
        if (!d) throw new Error(`unknown behavior ${id}`);
        return structuredClone(d);
    }

    async setLayerBinding(layerId, keyPosition, binding) {
        const layer = this._layerById(layerId);
        if (!layer || keyPosition < 0 || keyPosition >= layer.bindings.length) {
            throw new Error('invalid location');
        }
        if (!BEHAVIORS.has(binding.behaviorId)) throw new Error('invalid behavior');
        layer.bindings[keyPosition] = {
            behaviorId: binding.behaviorId,
            param1: (binding.param1 ?? 0) >>> 0,
            param2: (binding.param2 ?? 0) >>> 0,
        };
        this._persist(true);
    }

    async setLayerProps(layerId, name) {
        const layer = this._layerById(layerId);
        if (!layer) throw new Error('invalid layer id');
        layer.name = String(name).slice(0, this.ws.zmk.keymap.maxLayerNameLength || 20);
        this._persist(true);
    }

    async saveChanges() {
        this.ws.zmk.keymapSaved = structuredClone(this.ws.zmk.keymap);
        // Queue the saved keymap for the next real connect (the "latest
        // saved keymap wins" auto-sync, same idea as the QMK .vil replay).
        // Export shape: behavior display names are the cross-device
        // identity — the real firmware's ids differ from the sim's, and
        // the keymap tab's import applier resolves names against the
        // device's own behavior list.
        this.ws.zmk.pendingKeymap = {
            kind: 'flask-zmk-keymap',
            version: 1,
            device: 'Cyboard Imprint (ZMK) preview',
            exported: new Date().toISOString(),
            layers: this.ws.zmk.keymapSaved.layers.map((l) => ({
                name: l.name,
                bindings: l.bindings.map((b) => ({
                    behavior: BEHAVIORS.get(b.behaviorId)?.displayName ?? null,
                    behaviorId: b.behaviorId,
                    param1: b.param1,
                    param2: b.param2,
                })),
            })),
        };
        this._persist(false);
    }

    async discardChanges() {
        this.ws.zmk.keymap = structuredClone(this.ws.zmk.keymapSaved);
        this.ws.zmk.removed = [];
        this._persist(false);
    }

    async moveLayer(startIndex, destIndex) {
        const { layers } = this.ws.zmk.keymap;
        if (startIndex < 0 || startIndex >= layers.length
            || destIndex < 0 || destIndex >= layers.length) {
            throw new Error('invalid move');
        }
        const [l] = layers.splice(startIndex, 1);
        layers.splice(destIndex, 0, l);
        this._persist(true);
        // Real firmware returns the full post-move keymap on the ok arm.
        return structuredClone(this.ws.zmk.keymap);
    }

    async addLayer() {
        const km = this.ws.zmk.keymap;
        if ((km.availableLayers ?? 0) <= 0) throw new Error('no free layer slots — remove a layer first');
        const layer = {
            id: this.ws.zmk.nextLayerId++,
            name: '',
            bindings: Array.from({ length: IMPRINT.positions }, TR),
        };
        km.layers.push(layer);
        km.availableLayers -= 1;
        this._persist(true);
        return { index: km.layers.length - 1, layer: structuredClone(layer) };
    }

    async removeLayer(index) {
        const km = this.ws.zmk.keymap;
        if (index < 0 || index >= km.layers.length) throw new Error('invalid index');
        const [gone] = km.layers.splice(index, 1);
        this.ws.zmk.removed.push(gone);
        km.availableLayers = (km.availableLayers ?? 0) + 1;
        this._persist(true);
    }

    async restoreLayer(layerId, atIndex) {
        const km = this.ws.zmk.keymap;
        const i = this.ws.zmk.removed.findIndex((l) => l.id === layerId);
        if (i < 0) throw new Error('invalid id');
        const [layer] = this.ws.zmk.removed.splice(i, 1);
        const at = Math.max(0, Math.min(atIndex, km.layers.length));
        km.layers.splice(at, 0, layer);
        km.availableLayers = Math.max(0, (km.availableLayers ?? 1) - 1);
        this._persist(true);
        return structuredClone(layer);
    }
}

// ---------------------------------------------------------------------------
// Attach / sync

/** Swap the app onto the offline imprint workspace (main.js dispatch). */
export function attachZmkOffline(app, ws) {
    normalizeZmkWorkspace(ws);
    app.flask = new ZmkOfflineFlask(ws);
    app.vial = null;
    app.zmkStudioSim = new OfflineStudioClient(ws);
    app.family = ws.family;
    app.protocolVersion = ws.protocolVersion;
    app.caps = zmkCapabilities(ws.family, ws.protocolVersion);
    app.profile = ws.profile;
    app.layerCount = ws.layerCount;
    app.keymap = null;
    app.unlocked = false;
    app.readKeyState = async () => new Set();
}

/**
 * Replay combo-slot + macro-step edits onto a real imprint (tunables + RGB
 * ride offline.js syncWorkspace — shared journal shapes). Returns counts;
 * the caller toasts.
 */
export async function zmkSyncExtras(app, ws) {
    normalizeZmkWorkspace(ws);
    const fail = [];
    let applied = 0;
    let touched = false;

    for (const slot of Object.keys(ws.zmkDirty.combo)) {
        try {
            await app.flask.setBytes(CH.combos, V.combosSlot,
                encodeComboSlot(Number(slot), ws.zmk.combos[slot]));
            delete ws.zmkDirty.combo[slot];
            applied++; touched = true;
        } catch (e) { fail.push(`combo ${slot}: ${e.message}`); }
    }
    if (touched) { try { await app.flask.save(CH.combos); } catch { /* keep */ } }

    touched = false;
    for (const key of Object.keys(ws.zmkDirty.macroStep)) {
        const [m, s] = key.split(',').map(Number);
        try {
            await app.flask.setBytes(CH.macros, V.macrosStep,
                encodeMacroStep(m, s, ws.zmk.macros[m][s]));
            delete ws.zmkDirty.macroStep[key];
            applied++; touched = true;
        } catch (e) { fail.push(`macro ${key}: ${e.message}`); }
    }
    if (touched) { try { await app.flask.save(CH.macros); } catch { /* keep */ } }

    // A queued keymap can't apply here — Studio RPC needs its own serial
    // connect (user gesture) + physical unlock. Stash the workspace; the
    // keymap tab applies it when it reaches 'ready' on a real device.
    app.zmkQueuedWs = ws.zmk?.pendingKeymap ? ws : null;

    saveWorkspace(ws);
    return { applied, failures: fail };
}

/** Consume the queued offline keymap once a real Studio session is ready:
 * run the tab's applier, clear the queue, persist. Returns the applier's
 * result or null when nothing was queued. */
export async function zmkApplyPendingKeymap(app, apply) {
    const ws = app.zmkQueuedWs;
    const data = ws?.zmk?.pendingKeymap;
    if (!data) return null;
    const res = await apply(data);
    // Locked (null) or stopped-partway applies stay queued for the next
    // connect — the applier diff-skips, so a retry only rewrites the rest.
    if (!res || res.stopped) return res;
    ws.zmk.pendingKeymap = null;
    app.zmkQueuedWs = null;
    saveWorkspace(ws);
    return res;
}
