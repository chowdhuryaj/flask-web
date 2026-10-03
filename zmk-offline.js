// ZMK offline preview — a device-less Cyboard Imprint workspace, so the
// whole ZMK surface (Studio keymap editor, Mouse/RGB/Combos/Macros tabs)
// can be beta-tested with no hardware attached.
//
// Two stand-ins:
//  - ZmkOfflineFlask — the Flask raw-HID frame (channels 0x00/0x1A/0x21/
//    0x23/0x24/0x25) against workspace state, journaling edits for replay
//    on the next real connect (tunables + RGB ride the shared journal
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

import { CH, V } from './flaskproto.js?v=73';
import { ZMK_EXPECTED_PROTOCOL, ZMK_FAMILY_LABELS, ZMK_FAMILY_CODES, ZMK_HARDWARE,
         zmkCapabilities, ZMK_TRACKBALLS } from './zmk.js?v=73';
import { TOTEM_GEOM, TOTEM_LAYOUT } from './zmk-totem-layout.js?v=73';
import { TOTEM_DEFAULT } from './zmk-totem-default.js?v=73';
import { isUnassignable } from './behavior-catalog.js?v=73';
import { OfflineFlask, saveWorkspace, pendingCount, clearDirty, loadWorkspace, workspaceKey,
         describeChanges, BASE_PREFIX } from './offline.js?v=73';
import { saveState } from './save-state.js?v=73';
import { LOCK_UNLOCKED } from './zmk-studio.js?v=73';
import { kpParam, cpParam, usageFromName, layerLabel } from './zmk-keycodes.js?v=73';
import { decodeComboSlot, encodeComboSlot, COMBO_MAX_KEYS, COMBO_POS_NONE,
         COMBO_ACTION, COMBO_LAYER_ANY, decodeComboSlotV2, encodeComboSlotV2,
         decodeComboSlotV3, encodeComboSlotV3,
         comboSlotToTyped, comboTypedToLegacy } from './zmk-combos-codec.js?v=73';
import { decodeCskSlot, encodeCskSlot, cskMorphCaps, cskNeedsMorph, cskNeedsOs, cskOskCaps } from './zmk-csk-codec.js?v=73';
import { TD_ACTION, decodeTdStep, encodeTdStep, decodeTdCfg, encodeTdCfg }
    from './zmk-tapdance-codec.js?v=73';
import { decodeMacroStep, encodeMacroStep, MACRO_ACTION } from './zmk-macros-codec.js?v=73';
import { AK_ACTION, decodeAkRule, encodeAkRule, decodeAkStep, encodeAkStep,
         decodeAkFallback, encodeAkFallback } from './zmk-adaptive-codec.js?v=73';
import { OUTPUT_ACTION, encodeLeaderSlot, decodeLeaderSlot,
         encodeGestureSlot, decodeGestureSlot } from './zmk-output-codec.js?v=73';

export const ZMK_TEMPLATE_FAMILIES = ['imprint', 'totem'];

const IMPRINT = {
    positions: 70,
    rgbLayers: 10,
    rgbLeds: 70,
    // v9/v10 Kconfig defaults (capacities are device-sourced on real
    // hardware; these seed the sim's RO count answers).
    comboSlots: 64,
    comboKeys: 8,
    macroSlots: 32,
    macroSteps: 32,
    leaderSlots: 32, // v14: Kconfig default bumped 16→32 (F-key preset needs 20)
    leaderKeys: 8,
    gestureSets: 8,
    // v14: custom shift keys + runtime tap dances
    cskSlots: 32,
    tdSlots: 16,
    tdTaps: 4,
    // v18 (Totem only; imprint has no flask_adaptive): Kconfig defaults.
    adaptiveSets: 4,
    adaptiveRules: 64,
    adaptiveSteps: 6,
};

// Per-family sizes. TOTEM: 38 positions, no LED strip (rgb 0); the runtime
// slot capacities are Kconfig on real hardware, so the sim keeps imprint's.
const FAMILY_DIMS = {
    imprint: IMPRINT,
    totem: { ...IMPRINT, positions: TOTEM_GEOM.length, rgbLayers: 0, rgbLeds: 0 },
};
const dims = (family) => FAMILY_DIMS[family] ?? IMPRINT;
const geomFor = (family) => (family === 'totem' ? TOTEM_GEOM : IMPRINT_GEOM);
const familyCode = (family) =>
    Number(Object.keys(ZMK_FAMILY_CODES).find((c) => ZMK_FAMILY_CODES[c] === family));

// Firmware-seeded default gesture sets (input_processor_flask_gestures.c
// gesture_set_defaults): E SE S SW W NW N NE. kb page 0x07, consumer 0x0C;
// mods bits 24-31 (LCTL 0x01, LSFT 0x02).
const KB = (id) => ((0x07 << 16) | id) >>> 0;
const CONS = (id) => ((0x0C << 16) | id) >>> 0;
const CTL = (u) => ((0x01 << 24) | u) >>> 0;
const CTLSFT = (u) => ((0x03 << 24) | u) >>> 0;
const GU = (param) => ({ action: 1, param });
const GN = () => ({ action: 0, param: 0 });
const GESTURE_SET_DEFAULTS = [
    [GU(KB(0x4F)), GN(), GU(KB(0x51)), GN(), GU(KB(0x50)), GN(), GU(KB(0x52)), GN()],
    [GU(KB(0x4C)), GN(), GU(KB(0x28)), GN(), GU(KB(0x2A)), GN(), GU(KB(0x29)), GN()],
    [GU(CONS(0xB5)), GN(), GU(CONS(0xEA)), GN(), GU(CONS(0xB6)), GN(), GU(CONS(0xE9)), GN()],
    [GU(CTL(KB(0x2B))), GN(), GU(KB(0x2C)), GN(), GU(CTLSFT(KB(0x2B))), GN(), GU(KB(0x2B)), GN()],
];

function defaultGestureSets() {
    return Array.from({ length: IMPRINT.gestureSets }, (_, s) =>
        Array.from({ length: 8 }, (_, d) =>
            GESTURE_SET_DEFAULTS[s]?.[d] ? { ...GESTURE_SET_DEFAULTS[s][d] } : GN()));
}

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
    add('Flask Leader', nil);
    add('Flask Gesture', range('Gesture set (255 = active)', 0, 255));
    add('Swapper', nil);
    add('Num Word', layer());
    // urob's compiled &leader ships NO behavior-metadata: the real device
    // lists it with an EMPTY display name and no metadata sets, and
    // set_layer_binding rejects it with INVALID_PARAMETERS no matter the
    // params (validate_binding -ENODEV). Mirror that exactly — the old
    // `add('Leader Key', nil)` seeded a named, assignable version and
    // masked the blank-default-option trap for two benches.
    {
        const id = nextId++;
        catalog.set(id, { id, displayName: '', metadata: [] });
        B['(urob leader, metadata-less)'] = id;
    }
    // Smart one-shot/hold round (2026-07-10): hold-tap wrapping sticky —
    // Smart Mod keeps the Mod-Tap shape; Smart Layer is layer-in-BOTH-params
    // since the 2026-07-11 rework (hold = sticky layer, tap = toggle — the
    // composer renders one picker for the layer+layer shape).
    add('Smart Mod', usage('Hold (mod)'), usage('Tap'));
    add('Smart Layer', layer(), layer());
    add('Sticky Mod (smart)', usage('Key'));
    add('Sticky Layer (smart)', layer());
    // Ball swap round (2026-07-11, proto v11).
    add('Ball Swap', constants([['Toggle (saved)', 0], ['While held', 1]]));
    add('External Power', constants([['Off', 0], ['On', 1], ['Toggle', 2]]));
    // v14 round: runtime tap dances (&ftd, slot-range metadata) + the
    // composer's compiled tap-hold timing variants.
    add('Tap Dance', range('Tap dance slot', 0, IMPRINT.tdSlots - 1));
    add('Mod-Tap (fast 150)', usage('Hold'), usage('Tap'));
    add('Mod-Tap (slow 300)', usage('Hold'), usage('Tap'));
    add('Layer-Tap (fast 150)', layer(), usage('Tap'));
    add('Layer-Tap (slow 300)', layer(), usage('Tap'));
    // The keymap's slk_* OS-aware shortcut behaviors (zmk-switch-layout)
    // ship no display-name/metadata — like urob's &leader they list blank
    // and reject assignment. The imported default combos reference them by
    // local id, so the sim needs real (nameless) entries for the combos
    // tab's "behavior #N" rendering path.
    for (const key of ['slk_copycut', 'slk_paste', 'slk_undoredo', 'slk_selall',
        'slk_close', 'slk_ntab']) {
        const id = nextId++;
        catalog.set(id, { id, displayName: '', metadata: [] });
        B[`(${key})`] = id;
    }
    return catalog;
}

const BEHAVIORS = buildBehaviorCatalog();

// ---------------------------------------------------------------------------
// v14 default combos — the keymap's devicetree combos IMPORTED as compiled
// defaults (flask,combos-defaults node, config/imprint.keymap). Firmware
// boots with these in slots 0..27 (settings-tombstoned deletions excepted);
// the sim MUST seed the same table, not an empty one (sim-fidelity rule:
// the clean `positions: []` class of bug). All BEHAVIOR-typed outputs —
// &kp is just Key Press with the usage in param1.

function defaultCombos() {
    const bhv = (name, param1 = 0, param2 = 0) => ({
        action: COMBO_ACTION.behavior, behaviorId: B[name], param1, param2 });
    const kp = (usage) => bhv('Key Press', usage);
    const SFT = (u) => ((0x02 << 24) | u) >>> 0;
    const GUI = (u) => ((0x08 << 24) | u) >>> 0;
    const T = (positions, out, timeoutMs = 35, priorIdleMs = 0, layer = COMBO_LAYER_ANY) =>
        ({ positions, ...out, timeoutMs, priorIdleMs, layer });
    // usages: TAB 0x2B ESC 0x29 ENTER 0x28 DOT 0x37 COMMA 0x36 SEMI 0x33
    // SQT 0x34 FSLH 0x38 LBKT 0x2F RBKT 0x30 N1 0x1E Q 0x14 Z 0x1D X 0x1B
    const table = [
        T([27, 26], bhv('(slk_copycut)'), 35, 150),          // copy_cut
        T([26, 14], kp(SFT(KB(0x2B)))),                       // lbtab ⇧Tab
        T([27, 15], kp(KB(0x2B))),                            // tab
        T([13, 25], kp(KB(0x29))),                            // lesc
        T([28, 27], bhv('(slk_paste)'), 35, 150),             // paste
        T([26, 25], bhv('(slk_undoredo)'), 35, 150),          // undo_redo
        T([29, 17], bhv('(slk_selall)'), 35, 140),            // sel_all
        T([16, 28], kp(KB(0x28))),                            // ent
        T([28, 40], bhv('(slk_close)')),                      // close
        T([27, 39], bhv('(slk_ntab)')),                       // ntab
        T([25, 37], kp(GUI(KB(0x14)))),                       // quit ⌘Q
        T([21, 33], kp(SFT(KB(0x2B)))),                       // rbtab
        T([20, 32], kp(KB(0x2B))),                            // rtab
        T([22, 34], kp(KB(0x29))),                            // resc
        T([19, 31], kp(KB(0x28))),                            // rent
        T([18, 19], kp(SFT(KB(0x1E))), 35, 0, 0),             // excl — layer 0 only
        T([30, 31], kp(KB(0x37))),                            // dot
        T([42, 43], kp(KB(0x36))),                            // comma
        T([42, 30], kp(KB(0x33))),                            // semi
        T([32, 44], kp(KB(0x34))),                            // quote
        T([31, 43], kp(KB(0x38))),                            // fslhq
        T([33, 45], kp(KB(0x2F))),                            // lbkt
        T([34, 46], kp(KB(0x30))),                            // rbkt
        T([51, 50], bhv('Mouse Key Press', 0x08)),            // m4
        T([52, 51], bhv('Mouse Key Press', 0x10)),            // m5
        T([58, 64], bhv('Layer-Tap', 1, KB(0x1D)), 50),       // z — &lt 1 Z
        T([59, 65], bhv('Layer-Tap', 2, KB(0x1B))),           // x — &lt 2 X
        T([63, 69], bhv('Key Repeat')),                       // rrep
    ];
    return Array.from({ length: IMPRINT.comboSlots }, (_, i) => table[i]
        ? { positions: [...table[i].positions], action: table[i].action,
            behaviorId: table[i].behaviorId, param1: table[i].param1,
            param2: table[i].param2 ?? 0, timeoutMs: table[i].timeoutMs,
            priorIdleMs: table[i].priorIdleMs, layer: table[i].layer }
        : emptyComboV3());
}

function emptyComboV3() {
    return { positions: [], action: COMBO_ACTION.none, behaviorId: 0,
        param1: 0, param2: 0, timeoutMs: 0, priorIdleMs: 0, layer: COMBO_LAYER_ANY };
}

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
        ...row(bind(B['Studio Unlock']), KP('F20'), KP('F11'), KP('F12'), KP('Grave'),
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
        // The real Control layer holds urob's compiled &leader here — the
        // METADATA-LESS behavior (empty display name). The old
        // `bind(B['Leader Key'])` referenced a catalog entry deleted in the
        // bench-5 round and produced behaviorId undefined (renders as
        // "#undefined", never assignable) — sim-faithful is the nameless id.
        ...row(TR(), KP('Volume Down'), KP('Left'), KP('Down'), KP('Right'),
            bind(B['(urob leader, metadata-less)']),
            bind(B['Caps Word']), KP('Enter'), KP('Left'), KP('Down'), KP('Right'), KP('Escape')),
        ...row(TR(), KP('Mute'), KP('Play/Pause'), KP('Rewind'), KP('Fast Forward'), bind(B['Ball Swap'], 0),
            bind(B['Ball Swap'], 1), bind(B['Flask RGB'], 1), bind(B['Flask RGB'], 2), bind(B['Flask RGB'], 0), bind(B['External Power'], 2), TR()),
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
        ...row(TR(), MO(4), bind(B['Flask Gesture'], 255), MB(2), MB(1), MB(3),
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

// TOTEM: everything firmware-derived (behavior catalog, layers, default
// combos) comes from gen-totem-default.mjs → zmk-totem-default.js; nothing
// here is hand-written. Bindings are [behaviorId, param1, param2].
const TOTEM_CATALOG = new Map(TOTEM_DEFAULT.behaviors.map((d) => [d.id, d]));
// Family catalog plus the workspace's own extras (device behaviors the
// catalog lacks, ws.zmk.extraBehaviors, see seedWorkspaceFromDevice).
const baseCatalog = (family) => (family === 'totem' ? TOTEM_CATALOG : BEHAVIORS);
const catalogFor = (ws) => {
    const extra = ws.zmk?.extraBehaviors;
    const base = baseCatalog(ws.family);
    return extra ? new Map([...base, ...Object.values(extra).map((d) => [d.id, d])]) : base;
};
const transparentFor = (ws) => (ws.family === 'totem'
    ? [...TOTEM_CATALOG.values()].find((d) => d.displayName === 'Transparent').id
    : B.Transparent);

function buildTotemLayers() {
    const n = TOTEM_GEOM.length;
    return TOTEM_DEFAULT.layers.map((l, id) => {
        const bindings = l.bindings.map(([behaviorId, param1, param2]) => bind(behaviorId, param1, param2));
        if (bindings.length !== n) {
            throw new Error(`zmk-offline: totem layer ${l.name} has ${bindings.length} bindings (want ${n})`);
        }
        return { id, name: l.name, bindings };
    });
}

function totemCombos(family) {
    return Array.from({ length: dims(family).comboSlots }, (_, i) => {
        const c = TOTEM_DEFAULT.combos[i];
        return c
            ? { positions: [...c.positions], action: COMBO_ACTION.behavior, behaviorId: c.behaviorId,
                param1: c.param1, param2: c.param2, timeoutMs: c.timeoutMs,
                priorIdleMs: c.priorIdleMs, layer: c.layer ?? COMBO_LAYER_ANY }
            : emptyComboV3();
    });
}
const defaultCombosFor = (family) => (family === 'totem' ? totemCombos(family) : defaultCombos());

// flask_holdtap (channel 0x2A, proto 17): Totem compiled defaults from
// .workflow/scratch/flask-holdtap-contract.md. Slot = key position, then the
// six virtual slots. Imprint has no module (getU16 answers 0).
const HT_KEYS = 38;
const HT_VIRTUAL = [
    ['Control combo (32+33)', 200, 0, 0, 2], ['Fn combo (33+34)', 200, 0, 0, 2],
    ['Copy/cut combo (11+12)', 200, 150, 0, 2], ['Undo/redo combo (10+11)', 200, 150, 0, 2],
    ['Fn arrows (Fn 6-9)', 200, 150, 0, 2], ['Sym autoshift digits', 200, 0, 0, 2],
];
export function holdtapDefaults() {
    const out = [];
    for (let i = 0; i < HT_KEYS; i++) {
        const hot = [20, 31, 32, 33, 34, 35, 36, 37].includes(i);
        out.push(hot ? { term: 280, quick: 175, idle: 150, flavor: (i === 32 || i === 37) ? 2 : 1 }
            : { term: 200, quick: 0, idle: 0, flavor: 1 });
    }
    for (const [, term, quick, idle, flavor] of HT_VIRTUAL) out.push({ term, quick, idle, flavor });
    return out;
}
const clampMs = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// flask_adaptive (channel 0x2B, proto 18, Totem only). The compiled default
// table comes from gen-totem-default.mjs (TOTEM_DEFAULT.adaptive, parsed from
// the keymap's flask,adaptive-defaults); a keymap without it boots empty.
const akNone = () => ({ action: AK_ACTION.none, behaviorId: 0, param1: 0, param2: 0 });
const akEmptyRule = () => ({ set: 0, trigger: 0, maxIdleMs: 0, strict: false,
    steps: Array.from({ length: IMPRINT.adaptiveSteps }, akNone) });
/** `def` = TOTEM_DEFAULT.adaptive shape: { fallback: [out], rules: [{set,
 * trigger, maxIdleMs, strict, steps: [out]}] }. */
export function adaptiveTable(def) {
    const rules = Array.from({ length: IMPRINT.adaptiveRules }, akEmptyRule);
    (def?.rules ?? []).slice(0, rules.length).forEach((r, i) => {
        rules[i] = { set: r.set, trigger: r.trigger >>> 0, maxIdleMs: r.maxIdleMs ?? 0, strict: !!r.strict,
            steps: Array.from({ length: IMPRINT.adaptiveSteps }, (_, k) => ({ ...akNone(), ...(r.steps[k] ?? {}) })) };
    });
    const fallback = Array.from({ length: IMPRINT.adaptiveSets }, (_, i) => ({ ...akNone(), ...(def?.fallback?.[i] ?? {}) }));
    return { enabled: 1, fallback, rules };
}
/** Firmware normalization for a step / fallback output
 * (flask_tapdance_output_set + &fak's own id -> NONE, no recursion). */
function akNormalizeOut({ action, behaviorId, param1, param2 }, selfId) {
    if (action > AK_ACTION.behavior) action = AK_ACTION.none;
    if (action === AK_ACTION.usage && param1 === 0) action = AK_ACTION.none;
    if (action === AK_ACTION.behavior && selfId != null && behaviorId === selfId) action = AK_ACTION.none;
    if (action === AK_ACTION.none) { behaviorId = 0; param1 = 0; param2 = 0; }
    if (action !== AK_ACTION.behavior) {
        behaviorId = 0;
        if (action !== AK_ACTION.none) param2 = 0;
    }
    return { action, behaviorId, param1, param2 };
}

// ---------------------------------------------------------------------------
// Template workspace

/** Firmware-default tunable values, set-if-absent so a stored older
 * workspace picks up ids added by later protocol versions without
 * clobbering the user's saved values. */
function seedImprintTunables(tun, family = 'imprint') {
    const hw = ZMK_HARDWARE[family] ?? ZMK_HARDWARE.imprint;
    // totem: no pointing/RGB channels — its preview journals none of them.
    const POINTING = [CH.autoscroll, CH.accel, CH.scrollSnap, CH.scrollScale, CH.gestures,
        CH.ballSwap, CH.autoMouse];
    const seed = (ch, id, val) => {
        if (!hw.pointing && POINTING.includes(ch)) return;
        if (!hw.rgb && ch === CH.rgbMap) return;
        tun[`${ch}:${id}`] ??= { op: 'u16', val };
    };
    seed(CH.autoscroll, V.asInverted, 0);
    seed(CH.autoscroll, V.asSpeedScale, 100);
    seed(CH.autoscroll, V.asStopOnKey, 1);
    seed(CH.rgbMap, V.rgbmapEnabled, 1);
    seed(CH.combos, V.combosEnabled, 1);
    seed(CH.combos, V.combosTimeout, 50);
    seed(CH.macros, V.macrosEnabled, 1);
    seed(CH.macros, V.macrosTapMs, 30);
    seed(CH.macros, V.macrosWaitMs, 15);
    // v9: accel (flask_accel firmware defaults — boots disabled, drashna
    // curve params x100; offset is SIGNED but the default is positive)
    seed(CH.accel, V.accelEnabled, 0);
    seed(CH.accel, V.accelTakeoff, 200);
    seed(CH.accel, V.accelGrowth, 25);
    seed(CH.accel, V.accelOffset, 220);
    seed(CH.accel, V.accelLimit, 20);
    // v9: scroll snap (flask_scrollsnap DT defaults)
    seed(CH.scrollSnap, V.snapEnabled, 1);
    seed(CH.scrollSnap, V.snapThreshold, 63);
    seed(CH.scrollSnap, V.snapSamples, 8);
    seed(CH.scrollSnap, V.snapImmediate, 25);
    seed(CH.scrollSnap, V.snapLockMs, 250);
    seed(CH.scrollSnap, V.snapLockEvents, 0);
    seed(CH.scrollSnap, V.snapIdleReset, 300);
    // v15: scroll speed (flask_scrollscale). The firmware boots at 100 —
    // "the keymap's compiled divisors verbatim" — and there is no DT knob to
    // disagree with, so 100 is the real boot state, not an idealized one.
    seed(CH.scrollScale, V.scrollSpeedPct, 100);
    // v9: rgb effect engine (firmware boot state — off, mid speed, teal-ish)
    seed(CH.rgbMap, V.rgbmapEffect, 0);
    seed(CH.rgbMap, V.rgbmapEffectSpeed, 128);
    seed(CH.rgbMap, V.rgbmapEffectHue, 0);
    seed(CH.rgbMap, V.rgbmapEffectSat, 255);
    seed(CH.rgbMap, V.rgbmapEffectVal, 120);
    // v10: leader + gestures firmware defaults
    seed(CH.leader, V.leaderEnabled, 1);
    seed(CH.leader, V.leaderTimeout, 1000);
    seed(CH.gestures, V.gesturesEnabled, 1);
    seed(CH.gestures, V.gesturesRatchetStep, 150);
    seed(CH.gestures, V.gesturesActiveSet, 0);

    // v11: ball swap (boots unswapped; effective is live-only — see the
    // ZmkOfflineFlask getU16 special case).
    seed(CH.ballSwap, V.bswapSwapped, 0);

    // v13: auto-mouse (flask_automouse firmware defaults — the keymap
    // node: enabled, 750 ms, threshold 0 = any motion, Mouse layer 3,
    // extend on non-transparent keys).
    seed(CH.autoMouse, V.amEnabled, 1);
    seed(CH.autoMouse, V.amTimeout, 750);
    seed(CH.autoMouse, V.amThreshold, 0);
    seed(CH.autoMouse, V.amLayer, 3);
    seed(CH.autoMouse, V.amExtend, 1);

    // v14: custom shift keys + tap dances boot enabled (empty tables);
    // rgb global brightness boots 100%.
    seed(CH.customShift, V.cskEnabled, 1);
    seed(CH.tapDance, V.tdEnabled, 1);
    seed(CH.rgbMap, V.rgbmapBrightness, 100);
    // v16: idle blank timeout. The firmware defaults to
    // CONFIG_ZMK_IDLE_TIMEOUT/1000 = 30 s (it is deliberately the pre-v16
    // behaviour), so 30 is the real boot value — not an idealized "never".
    seed(CH.rgbMap, V.rgbmapIdleTimeout, 30);
}

export function createZmkTemplate(family) {
    if (!FAMILY_DIMS[family]) throw new Error(`no ZMK template for family "${family}"`);
    const layers = family === 'totem' ? buildTotemLayers() : buildDefaultLayers();
    const keymap = { layers, availableLayers: 0, maxLayerNameLength: 20 };
    const version = ZMK_EXPECTED_PROTOCOL[family];

    // Firmware defaults, so the tuning cards open with real values.
    const tun = {};
    seedImprintTunables(tun, family);

    return {
        v: 1, key: family, family,
        label: `${ZMK_FAMILY_LABELS[family]} (template)`,
        source: 'template', savedAt: Date.now(),
        protocolVersion: version,
        layerCount: layers.length,
        profile: {
            family,
            name: ZMK_FAMILY_LABELS[family],
            keys: geomFor(family).map((k, i) => ({
                row: 0, col: i, pos: i, label: `Key ${i}`,
                x: k.x, y: k.y, w: k.w ?? 1, h: k.h ?? 1,
            })),
            layerNames: layers.map((l, i) => layerLabel(l.name, i)),
            decorations: ZMK_TRACKBALLS[family] ?? [],
        },
        tunables: tun,
        dirty: { tun: {}, rgb: {}, saves: [] },
        zmk: {
            keymap,
            keymapSaved: structuredClone(keymap),
            pendingKeymap: null, // export-shaped snapshot queued for real connect
            removed: [],        // removed layers waiting for restore
            nextLayerId: layers.length,
            unsaved: false,
            // v14: the imported devicetree combos ARE the boot table.
            combos: defaultCombosFor(family),
            macros: Array.from({ length: dims(family).macroSlots }, () =>
                Array.from({ length: dims(family).macroSteps }, () => ({ action: MACRO_ACTION.empty, param: 0 }))),
            rgb: Array.from({ length: dims(family).rgbLayers }, () =>
                Array.from({ length: dims(family).rgbLeds }, () => [0, 0, 0])),
            leader: Array.from({ length: dims(family).leaderSlots },
                () => ({ positions: [], action: 0, param: 0 })),
            gestures: defaultGestureSets(),
            // v12 runtime LED order (LED index → keymap position).
            ledOrder: Array.from({ length: dims(family).rgbLeds }, (_, i) => i),
            // v14: custom shift pairs + tap dances (boot empty).
            csk: Array.from({ length: dims(family).cskSlots }, () => ({ base: 0, shifted: 0 })),
            tapdance: Array.from({ length: dims(family).tdSlots }, () => ({
                termMs: 0,
                taps: Array.from({ length: dims(family).tdTaps }, () =>
                    ({ action: TD_ACTION.none, behaviorId: 0, param1: 0, param2: 0 })),
            })),
            // v18: adaptive keys. Totem only (no key = the imprint probe answers unhandled).
            ...(family === 'totem' ? { adaptive: adaptiveTable(TOTEM_DEFAULT.adaptive) } : {}),
        },
        zmkDirty: { combo: {}, macroStep: {}, leaderSlot: {}, gestureSlot: {},
            cskSlot: {}, tdStep: {}, akRule: {} },
    };
}

/** Older stored ZMK workspaces: fill fields added later (append-only). */
export function normalizeZmkWorkspace(ws) {
    ws.zmkDirty ??= { combo: {}, macroStep: {}, leaderSlot: {}, gestureSlot: {} };
    ws.zmkDirty.combo ??= {};
    ws.zmkDirty.macroStep ??= {};
    ws.zmkDirty.leaderSlot ??= {};
    ws.zmkDirty.gestureSlot ??= {};
    ws.zmkDirty.cskSlot ??= {};
    ws.zmkDirty.tdStep ??= {};
    ws.zmkDirty.akRule ??= {};
    if (ws.zmk) {
        ws.zmk.pendingKeymap ??= null;
        if (ws.family === 'totem') ws.zmk.holdtap ??= holdtapDefaults();
        if (ws.family === 'totem') ws.zmk.adaptive ??= adaptiveTable(TOTEM_DEFAULT.adaptive);
        // v13: stored older workspaces gain the trackball decorations.
        if (ws.profile) ws.profile.decorations ??= ZMK_TRACKBALLS[ws.family] ?? [];
        // v13→v14: the trackball nudge (left ball off the inner column) —
        // refresh stored coordinates to the current table.
        if (ws.profile?.decorations?.length) {
            ws.profile.decorations = ZMK_TRACKBALLS[ws.family] ?? ws.profile.decorations;
        }
        // The preview tracks the app's expected protocol — a stored older
        // workspace "gets a firmware update" on load: version bumps and
        // newly-added tunable ids seed their firmware defaults (existing
        // saved values untouched).
        const expected = ZMK_EXPECTED_PROTOCOL[ws.family] ?? ws.protocolVersion;
        const storedVersion = ws.protocolVersion ?? 0;
        if (storedVersion < expected) ws.protocolVersion = expected;
        ws.tunables ??= {};
        seedImprintTunables(ws.tunables, ws.family);
        // v14 "firmware update" semantics for combos: the real device DROPS
        // pre-v14 saved slots and boots the imported devicetree defaults —
        // a stored older workspace does the same (mirrors flask_combos
        // settings restore; keeping old slots would shadow the defaults).
        if (storedVersion < 14) {
            ws.zmk.combos = defaultCombosFor(ws.family);
            ws.zmkDirty.combo = {};
        }
        // v12: stored usage-only combos migrate to the typed shape; v14
        // adds the timing/layer fields to whatever survives.
        ws.zmk.combos = ws.zmk.combos.map((c) => {
            const t = c.action != null ? c : comboSlotToTyped(c);
            t.timeoutMs ??= 0;
            t.priorIdleMs ??= 0;
            t.layer ??= COMBO_LAYER_ANY;
            return t;
        });
        while (ws.zmk.combos.length < dims(ws.family).comboSlots) {
            ws.zmk.combos.push(emptyComboV3());
        }
        ws.zmk.ledOrder ??= Array.from({ length: dims(ws.family).rgbLeds }, (_, i) => i);
        while (ws.zmk.macros.length < dims(ws.family).macroSlots) {
            ws.zmk.macros.push([]);
        }
        for (const slot of ws.zmk.macros) {
            while (slot.length < dims(ws.family).macroSteps) {
                slot.push({ action: MACRO_ACTION.empty, param: 0 });
            }
        }
        // v10: leader + gesture tables (gestures seed the firmware defaults
        // — the device ships sets 0-3 populated).
        ws.zmk.leader ??= Array.from({ length: dims(ws.family).leaderSlots },
            () => ({ positions: [], action: 0, param: 0 }));
        while (ws.zmk.leader.length < dims(ws.family).leaderSlots) {
            ws.zmk.leader.push({ positions: [], action: 0, param: 0 });
        }
        ws.zmk.gestures ??= defaultGestureSets();
        while (ws.zmk.gestures.length < dims(ws.family).gestureSets) {
            ws.zmk.gestures.push(Array.from({ length: 8 }, () => ({ action: 0, param: 0 })));
        }
        // v14: leader capacity 16→32 + csk/tapdance tables.
        while (ws.zmk.leader.length < dims(ws.family).leaderSlots) {
            ws.zmk.leader.push({ positions: [], action: 0, param: 0 });
        }
        ws.zmk.csk ??= Array.from({ length: dims(ws.family).cskSlots }, () => ({ base: 0, shifted: 0 }));
        ws.zmk.tapdance ??= Array.from({ length: dims(ws.family).tdSlots }, () => ({
            termMs: 0,
            taps: Array.from({ length: dims(ws.family).tdTaps }, () =>
                ({ action: TD_ACTION.none, behaviorId: 0, param1: 0, param2: 0 })),
        }));
    }
    return ws;
}

export function zmkPendingCount(ws) {
    const d = ws.zmkDirty;
    if (!d) return 0;
    return Object.keys(d.combo).length + Object.keys(d.macroStep).length
        + Object.keys(d.leaderSlot ?? {}).length
        + Object.keys(d.gestureSlot ?? {}).length
        + Object.keys(d.cskSlot ?? {}).length
        + Object.keys(d.tdStep ?? {}).length
        + Object.keys(d.akRule ?? {}).length
        + (ws.zmk?.pendingKeymap ? 1 : 0);
}

/** Drop everything ZMK-shaped queued for replay (the banner's Discard). */
export function zmkClearDirty(ws) {
    ws.zmkDirty = { combo: {}, macroStep: {}, leaderSlot: {}, gestureSlot: {},
        cskSlot: {}, tdStep: {}, akRule: {} };
    if (ws.zmk) ws.zmk.pendingKeymap = null;
    saveWorkspace(ws);
}

/** Everything queued for replay on either line: the number the status bar's
 * "Offline — N queued" segment shows. */
export function offlineQueued(ws) {
    return pendingCount(ws) + zmkPendingCount(ws);
}

// Baseline for "Discard queued": the slot tables and tunables as they were the
// last time nothing was queued (snapshotted on attach). Dropping the journals
// without restoring them would leave the workspace showing values that will
// never reach the keyboard. Separate storage key: written once, not per edit.
const BASE_TABLES = ['combos', 'macros', 'rgb', 'leader', 'gestures', 'ledOrder', 'csk', 'tapdance', 'adaptive'];

export function snapshotBase(ws) {
    try {
        const zmk = {};
        for (const t of BASE_TABLES) if (ws.zmk?.[t] !== undefined) zmk[t] = ws.zmk[t];
        localStorage.setItem(BASE_PREFIX + ws.key, JSON.stringify({ tunables: ws.tunables, zmk }));
    } catch { /* quota: discard then just drops the journals */ }
}

function restoreBase(ws, withKeymap) {
    let b = null;
    try { b = JSON.parse(localStorage.getItem(BASE_PREFIX + ws.key)); } catch { /* none */ }
    if (b) {
        ws.tunables = b.tunables;
        Object.assign(ws.zmk, b.zmk);
    }
    // A device-seeded keymap goes back to the seed too when its edits were the queue.
    const seed = ws.zmk.seedBase;
    if (seed && withKeymap) {
        ws.zmk.keymap = structuredClone(seed);
        ws.zmk.keymapSaved = structuredClone(seed);
        ws.zmk.removed = [];
        ws.zmk.unsaved = false;
        ws.zmk.nextLayerId = Math.max(...seed.layers.map((l) => l.id)) + 1;
    }
}

/** Drop everything queued for replay AND the values it carried. Used by the
 * connect dialog's Discard and the explicit "Discard queued" action; the
 * top-bar Discard never calls this (saved Unplugged edits ARE the queue). */
export function dropJournals(ws) {
    const n = offlineQueued(ws);
    if (!n) return 0;
    const hadKeymap = !!ws.zmk?.pendingKeymap;
    clearDirty(ws);
    zmkClearDirty(ws);
    restoreBase(ws, hadKeymap);
    saveWorkspace(ws);
    return n;
}

/** Offline half of the explicit "Discard queued": drop the queue (with its
 * values) and the unsaved marks that pointed at it. Returns entries dropped. */
export function discardOfflineAll(ws, state = saveState) {
    const hadKeymap = !!ws.zmk?.pendingKeymap;
    let n = dropJournals(ws);
    // The keymap's own unsaved mark stays unless its queued edits were reverted.
    for (const { source, canDiscard } of state.dirty()) {
        if (canDiscard && !hadKeymap) continue;
        state.clean(source); n++;
    }
    return n;
}

/** The status bar's "Discard queued" action (main.js confirms first). Returns
 * how many entries were dropped (0 = nothing queued or unsaved). */
export function discardOfflineQueued(ws, state = saveState) {
    return discardOfflineAll(ws, state);
}

/** One line per queued ZMK entry for the connect dialog. */
export function zmkDescribeChanges(ws) {
    const d = ws.zmkDirty;
    if (!d) return [];
    const lines = [];
    const add = (label, t) => { for (const k of Object.keys(t ?? {})) lines.push(`${label} ${k.replace(',', ' / ')}`); };
    add('combo slot', d.combo); add('macro step', d.macroStep); add('leader sequence', d.leaderSlot);
    add('gesture set/dir', d.gestureSlot); add('shift key slot', d.cskSlot);
    add('tap dance slot/step', d.tdStep); add('adaptive rule', d.akRule);
    if (ws.zmk?.pendingKeymap) lines.push('keymap edits (applied after ZMK Studio connects and unlocks)');
    return lines;
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
            if (id === V.metaFamily) return familyCode(this.ws.family);
            return 0;
        }
        if (ch === 0x2A && id === 0x01) return this.ws.zmk.holdtap?.length ?? 0;
        if (ch === CH.adaptive) {
            const ak = this.ws.zmk.adaptive;
            if (!ak) throw new Error('unhandled');   // 0xFF echo: module not compiled in
            if (id === V.akEnabled) return ak.enabled;
            if (id === V.akSetCount) return ak.fallback.length;
            if (id === V.akRuleCount) return ak.rules.length;
            if (id === V.akStepCount) return ak.rules[0].steps.length;
            throw new Error('unhandled');
        }
        if (ch === CH.rgbMap && id === V.rgbmapLayers) return this.ws.zmk.rgb.length;
        if (ch === CH.rgbMap && id === V.rgbmapLeds) return this.ws.zmk.rgb[0].length;
        if (ch === CH.rgbMap && id === V.rgbmapSplitLink) return 1; // sim halves always linked
        if (ch === CH.combos && id === V.combosSlotCount) return this.ws.zmk.combos.length;
        if (ch === CH.combos && id === V.combosKeys) return dims(this.ws.family).comboKeys;
        if (ch === CH.macros && id === V.macrosSlotCount) return this.ws.zmk.macros.length;
        if (ch === CH.macros && id === V.macrosStepCount) return this.ws.zmk.macros[0].length;
        if (ch === CH.macros && id === V.macrosState) return 0; // never "playing"
        if (ch === CH.leader && id === V.leaderSlotCount) return this.ws.zmk.leader.length;
        if (ch === CH.leader && id === V.leaderKeys) return dims(this.ws.family).leaderKeys;
        if (ch === CH.gestures && id === V.gesturesSetCount) return this.ws.zmk.gestures.length;
        if (ch === CH.customShift && id === V.cskSlotCount) return this.ws.zmk.csk.length;
        if (ch === CH.customShift && id === V.cskMorphCaps) return 1; // the sim speaks the 11-byte frame
        if (ch === CH.customShift && id === V.cskOskCaps) return 1;   // ...and the OS flags (bits 1-4)
        if (ch === CH.customShift && id === V.cskOsMode) return 1;    // the sim board is in Mac mode
        if (ch === CH.tapDance && id === V.tdSlotCount) return this.ws.zmk.tapdance.length;
        if (ch === CH.tapDance && id === V.tdTaps) return dims(this.ws.family).tdTaps;
        // Ball swap "effective" is live-only (base XOR momentary holds) —
        // the sim has no held keys, so it always equals the base state.
        if (ch === CH.ballSwap && id === V.bswapEffective) {
            return super.getU16(ch, V.bswapSwapped);
        }
        return super.getU16(ch, id);
    }

    async setU16(ch, id, value) {
        if (ch === CH.adaptive) {
            const ak = this.ws.zmk.adaptive;
            if (!ak || id !== V.akEnabled) throw new Error('unhandled');   // counts are RO
            const v = value ? 1 : 0;
            ak.enabled = v;
            this.ws.tunables[`${ch}:${id}`] = { op: 'u16', val: v };
            this.ws.dirty.tun[`${ch}:${id}`] = { op: 'u16', val: v };
            saveWorkspace(this.ws);
            return v;
        }
        // Live-state ids — never journal.
        if (ch === CH.meta || (ch === CH.macros && id === V.macrosState)) {
            return Math.max(0, Math.min(0xFFFF, Math.round(value))) & 0xFFFF;
        }
        // The gesture active set is a REAL persisted setting on
        // flask_gestures, so it journals like any tunable.
        // Firmware floor (flask_rgb): 0 means never blank, but any nonzero
        // value below the compiled ZMK idle timeout (30 s) blanks AT that
        // timeout — the activity-idle event is the earliest signal the module
        // gets. Mirror it, or the app shows a setting the device can't honour.
        if (ch === CH.rgbMap && id === V.rgbmapIdleTimeout) {
            const raw = Math.max(0, Math.round(value));
            const v = raw === 0 ? 0 : Math.max(30, raw);
            this.ws.tunables[`${ch}:${id}`] = { op: 'u16', val: v };
            this.ws.dirty.tun[`${ch}:${id}`] = { op: 'u16', val: v };
            saveWorkspace(this.ws);
            return v;
        }
        // Firmware clamp (flask_scrollscale_params_set): 25..400. The device
        // re-GETs after the SET, so the echo carries the clamped value — the
        // sim has to agree or an out-of-range write looks accepted here and
        // gets rejected on hardware.
        if (ch === CH.scrollScale && id === V.scrollSpeedPct) {
            const v = Math.min(Math.max(25, Math.round(value)), 400);
            this.ws.tunables[`${ch}:${id}`] = { op: 'u16', val: v };
            this.ws.dirty.tun[`${ch}:${id}`] = { op: 'u16', val: v };
            saveWorkspace(this.ws);
            return v;
        }
        if (ch === CH.gestures && id === V.gesturesActiveSet) {
            const v = Math.min(Math.max(0, Math.round(value)), this.ws.zmk.gestures.length - 1);
            this.ws.tunables[`${ch}:${id}`] = { op: 'u16', val: v };
            this.ws.dirty.tun[`${ch}:${id}`] = { op: 'u16', val: v };
            saveWorkspace(this.ws);
            return v;
        }
        return super.setU16(ch, id, value);
    }

    // Runtime-only like the real RAM table: no replay journal.
    async save(ch) { if (ch !== 0x2A) return super.save(ch); }

    _holdtapGet(id, slot) {
        const ht = this.ws.zmk.holdtap;
        if (slot >= ht.length) throw new Error('unhandled');
        if (id === 0x50 || id === 0x51) {
            const def = holdtapDefaults()[slot];
            const s = id === 0x50 ? ht[slot] : def;
            const custom = id === 0x50 && JSON.stringify(s) !== JSON.stringify(def);
            return [slot, s.term >> 8, s.term & 0xFF, s.quick >> 8, s.quick & 0xFF,
                s.idle >> 8, s.idle & 0xFF, s.flavor, custom ? 1 : 0, ...new Array(20).fill(0)];
        }
        if (id === 0x52) {
            const virt = slot >= HT_KEYS;
            const name = virt ? HT_VIRTUAL[slot - HT_KEYS][0] : '';
            return [slot, virt ? 1 : 0, virt ? 0xFF : slot,
                ...[...name].map((c) => c.charCodeAt(0)), ...new Array(26 - name.length).fill(0)];
        }
        throw new Error('unhandled');
    }

    _holdtapSet(p) {
        const ht = this.ws.zmk.holdtap;
        const slot = p[0];
        if (slot >= ht.length || p[7] > 3) throw new Error('unhandled');   // 0xFF echo
        const u16 = (i) => (p[i] << 8) | p[i + 1];
        if (u16(1) === 0) ht[slot] = { ...holdtapDefaults()[slot] };   // reset
        else ht[slot] = { term: clampMs(u16(1), 50, 1000), quick: clampMs(u16(3), 0, 1000),
            idle: clampMs(u16(5), 0, 1000), flavor: p[7] };
        saveWorkspace(this.ws);
        return this._holdtapGet(0x50, slot);
    }

    _adaptiveGet(id, payload) {
        const ak = this.ws.zmk.adaptive;
        if (!ak) throw new Error('unhandled');
        if (id === V.akRule) {
            const r = ak.rules[payload[0]];
            if (!r) throw new Error('unhandled');
            return encodeAkRule(payload[0], r);
        }
        if (id === V.akStep) {
            const o = ak.rules[payload[0]]?.steps[payload[1]];
            if (!o) throw new Error('unhandled');
            return encodeAkStep(payload[0], payload[1], o);
        }
        if (id === V.akFallback) {
            const o = ak.fallback[payload[0]];
            if (!o) throw new Error('unhandled');
            return encodeAkFallback(payload[0], o);
        }
        throw new Error('unhandled');
    }

    /** Behavior id of &fak itself in this workspace's catalog (null when the
     * keymap does not define it). */
    _adaptiveSelfId() {
        for (const d of catalogFor(this.ws).values()) {
            if (d.node === 'fak' || d.displayName === 'Adaptive Key') return d.id;
        }
        return null;
    }

    _adaptiveSet(id, payload) {
        const ak = this.ws.zmk.adaptive;
        if (!ak) throw new Error('unhandled');
        const dirty = (key) => { this.ws.zmkDirty.akRule[key] = true; saveWorkspace(this.ws); };
        if (id === V.akRule) {
            const d = decodeAkRule(payload);
            const r = ak.rules[d.rule];
            if (!r) throw new Error('unhandled');
            if (d.trigger === 0) {      // delete: every field and every step zeroed
                ak.rules[d.rule] = akEmptyRule();
            } else {
                if (d.set >= ak.fallback.length) throw new Error('unhandled');
                // Page 0 means the keyboard page.
                const trigger = ((d.trigger >>> 16) & 0xFF) ? d.trigger : (d.trigger | (7 << 16)) >>> 0;
                Object.assign(r, { set: d.set, trigger, maxIdleMs: Math.min(d.maxIdleMs, 10000), strict: d.strict });
            }
            dirty(d.rule);
            return encodeAkRule(d.rule, ak.rules[d.rule]);
        }
        if (id === V.akStep) {
            const d = decodeAkStep(payload);
            if (!ak.rules[d.rule]?.steps[d.step]) throw new Error('unhandled');
            ak.rules[d.rule].steps[d.step] = akNormalizeOut(d, this._adaptiveSelfId());
            dirty(d.rule);
            return encodeAkStep(d.rule, d.step, ak.rules[d.rule].steps[d.step]);
        }
        if (id === V.akFallback) {
            const d = decodeAkFallback(payload);
            if (!ak.fallback[d.set]) throw new Error('unhandled');
            ak.fallback[d.set] = akNormalizeOut(d, this._adaptiveSelfId());
            dirty(`f${d.set}`);
            return encodeAkFallback(d.set, ak.fallback[d.set]);
        }
        throw new Error('unhandled');
    }

    async getBytes(ch, id, payload = []) {
        const { zmk } = this.ws;
        if (ch === 0x2A && zmk.holdtap) return this._holdtapGet(id, payload[0] ?? 0);
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
            const s = zmk.combos[slot] ?? comboSlotToTyped({ positions: [], usage: 0 });
            return encodeComboSlot(slot, comboTypedToLegacy(s), dims(this.ws.family).comboKeys);
        }
        if (ch === CH.combos && id === V.combosSlotV2) {
            const slot = payload[0] ?? 0;
            const s = zmk.combos[slot] ?? emptyComboV3();
            return encodeComboSlotV2(slot, s, dims(this.ws.family).comboKeys);
        }
        if (ch === CH.combos && id === V.combosSlotV3) {
            const slot = payload[0] ?? 0;
            const s = zmk.combos[slot] ?? emptyComboV3();
            return encodeComboSlotV3(slot, s, dims(this.ws.family).comboKeys);
        }
        if (ch === CH.customShift && id === V.cskSlot) {
            const slot = payload[0] ?? 0;
            const s = zmk.csk[slot] ?? { base: 0, shifted: 0 };
            return encodeCskSlot(slot, s, true);
        }
        if (ch === CH.tapDance && id === V.tdStep) {
            const [slot, tap] = payload;
            const o = zmk.tapdance[slot]?.taps[tap]
                ?? { action: TD_ACTION.none, behaviorId: 0, param1: 0, param2: 0 };
            return encodeTdStep(slot, tap, o);
        }
        if (ch === CH.tapDance && id === V.tdCfg) {
            const slot = payload[0] ?? 0;
            return encodeTdCfg(slot, zmk.tapdance[slot]?.termMs ?? 0);
        }
        if (ch === CH.adaptive) return this._adaptiveGet(id, payload);
        if (ch === CH.rgbMap && id === V.rgbmapLedOrder) {
            const [start, count] = payload;
            if (start >= zmk.ledOrder.length || start + count > zmk.ledOrder.length) {
                throw new Error('unhandled');
            }
            return [start, count, ...zmk.ledOrder.slice(start, start + count)];
        }
        if (ch === CH.macros && id === V.macrosStep) {
            const [m, s] = payload;
            const step = zmk.macros[m]?.[s] ?? { action: MACRO_ACTION.empty, param: 0 };
            return encodeMacroStep(m, s, step);
        }
        if (ch === CH.leader && id === V.leaderSlot) {
            const seq = payload[0] ?? 0;
            const s = zmk.leader[seq] ?? { positions: [], action: 0, param: 0 };
            return encodeLeaderSlot(seq, s, dims(this.ws.family).leaderKeys);
        }
        if (ch === CH.gestures && id === V.gesturesSlot) {
            const [set, dir] = payload;
            const o = zmk.gestures[set]?.[dir] ?? { action: 0, param: 0 };
            return encodeGestureSlot(set, dir, o);
        }
        return new Array(29).fill(0);
    }

    async setBytes(ch, id, payload) {
        const { zmk } = this.ws;
        if (ch === 0x2A && zmk.holdtap && id === 0x50) return this._holdtapSet(payload);
        if (ch === CH.adaptive) return this._adaptiveSet(id, payload);
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
            const decoded = decodeComboSlot(payload, dims(this.ws.family).comboKeys);
            const slot = decoded.slot;
            if (!zmk.combos[slot]) return payload;
            // Firmware normalization: positions must exist on the board.
            const positions = decoded.positions
                .filter((p) => p >= 0 && p < dims(this.ws.family).positions)
                .slice(0, dims(this.ws.family).comboKeys);
            zmk.combos[slot] = comboSlotToTyped({ slot, positions, usage: decoded.usage });
            this.ws.zmkDirty.combo[slot] = true;
            saveWorkspace(this.ws);
            return encodeComboSlot(slot, comboTypedToLegacy(zmk.combos[slot]), dims(this.ws.family).comboKeys);
        }
        if (ch === CH.combos && id === V.combosSlotV2) {
            const d = decodeComboSlotV2(payload, dims(this.ws.family).comboKeys);
            if (!zmk.combos[d.slot]) return payload;
            const positions = d.positions
                .filter((p) => p >= 0 && p < dims(this.ws.family).positions)
                .slice(0, dims(this.ws.family).comboKeys);
            // Firmware normalization (flask_combos_slot_set): bad action
            // → none; usage without a usage → none; non-behavior slots
            // zero the behavior id / param2.
            let { action, behaviorId, param1, param2 } = d;
            if (action > COMBO_ACTION.behavior) action = COMBO_ACTION.none;
            if (action === COMBO_ACTION.usage && param1 === 0) action = COMBO_ACTION.none;
            if (action === COMBO_ACTION.none) { behaviorId = 0; param1 = 0; param2 = 0; }
            if (action !== COMBO_ACTION.behavior) {
                behaviorId = 0;
                if (action !== COMBO_ACTION.none) param2 = 0;
            }
            // v2 writes keep the slot's existing timing/layer (a pre-v14
            // app editing a v14 device leaves the knobs alone).
            const keep = zmk.combos[d.slot];
            zmk.combos[d.slot] = { positions, action, behaviorId, param1, param2,
                timeoutMs: keep.timeoutMs ?? 0, priorIdleMs: keep.priorIdleMs ?? 0,
                layer: keep.layer ?? COMBO_LAYER_ANY };
            this.ws.zmkDirty.combo[d.slot] = true;
            saveWorkspace(this.ws);
            return encodeComboSlotV2(d.slot, zmk.combos[d.slot], dims(this.ws.family).comboKeys);
        }
        if (ch === CH.combos && id === V.combosSlotV3) {
            const d = decodeComboSlotV3(payload, dims(this.ws.family).comboKeys);
            if (!zmk.combos[d.slot]) return payload;
            const positions = d.positions
                .filter((p) => p >= 0 && p < dims(this.ws.family).positions)
                .slice(0, dims(this.ws.family).comboKeys);
            // Firmware normalization (flask_combos_slot_set, v14): action
            // rules as v2; timeout clamps to 10..2000 when nonzero; an
            // emptied slot zeroes its timing and resets the layer gate.
            let { action, behaviorId, param1, param2, timeoutMs, priorIdleMs, layer } = d;
            if (action > COMBO_ACTION.behavior) action = COMBO_ACTION.none;
            if (action === COMBO_ACTION.usage && param1 === 0) action = COMBO_ACTION.none;
            if (action === COMBO_ACTION.none) { behaviorId = 0; param1 = 0; param2 = 0; }
            if (action !== COMBO_ACTION.behavior) {
                behaviorId = 0;
                if (action !== COMBO_ACTION.none) param2 = 0;
            }
            if (timeoutMs) timeoutMs = Math.max(10, Math.min(2000, timeoutMs));
            if (action === COMBO_ACTION.none) {
                timeoutMs = 0; priorIdleMs = 0; layer = COMBO_LAYER_ANY;
            }
            zmk.combos[d.slot] = { positions, action, behaviorId, param1, param2,
                timeoutMs, priorIdleMs, layer };
            this.ws.zmkDirty.combo[d.slot] = true;
            saveWorkspace(this.ws);
            return encodeComboSlotV3(d.slot, zmk.combos[d.slot], dims(this.ws.family).comboKeys);
        }
        if (ch === CH.customShift && id === V.cskSlot) {
            const d = decodeCskSlot(payload);
            if (!zmk.csk[d.slot]) return payload;
            zmk.csk[d.slot] = { base: d.base, shifted: d.shifted, mods: d.mods, keep: d.keep };
            for (const k of ['os', 'wild', 'count']) if (d[k]) zmk.csk[d.slot][k] = d[k];
            this.ws.zmkDirty.cskSlot[d.slot] = true;
            saveWorkspace(this.ws);
            return encodeCskSlot(d.slot, zmk.csk[d.slot], true);
        }
        if (ch === CH.tapDance && id === V.tdStep) {
            const d = decodeTdStep(payload);
            if (!zmk.tapdance[d.slot] || d.tap >= dims(this.ws.family).tdTaps) return payload;
            // Firmware normalization (flask_tapdance_output_set).
            let { action, behaviorId, param1, param2 } = d;
            if (action > TD_ACTION.behavior) action = TD_ACTION.none;
            if (action === TD_ACTION.usage && param1 === 0) action = TD_ACTION.none;
            if (action === TD_ACTION.none) { behaviorId = 0; param1 = 0; param2 = 0; }
            if (action !== TD_ACTION.behavior) {
                behaviorId = 0;
                if (action !== TD_ACTION.none) param2 = 0;
            }
            zmk.tapdance[d.slot].taps[d.tap] = { action, behaviorId, param1, param2 };
            this.ws.zmkDirty.tdStep[`${d.slot},${d.tap}`] = true;
            saveWorkspace(this.ws);
            return encodeTdStep(d.slot, d.tap, zmk.tapdance[d.slot].taps[d.tap]);
        }
        if (ch === CH.tapDance && id === V.tdCfg) {
            const d = decodeTdCfg(payload);
            if (!zmk.tapdance[d.slot]) return payload;
            // Firmware clamp: 0 = default, else 50..1000.
            zmk.tapdance[d.slot].termMs = d.termMs
                ? Math.max(50, Math.min(1000, d.termMs)) : 0;
            this.ws.zmkDirty.tdStep[`${d.slot},cfg`] = true;
            saveWorkspace(this.ws);
            return encodeTdCfg(d.slot, zmk.tapdance[d.slot].termMs);
        }
        if (ch === CH.rgbMap && id === V.rgbmapLedOrder) {
            const [start, count, ...pos] = payload;
            if (start >= zmk.ledOrder.length || start + count > zmk.ledOrder.length) {
                throw new Error('unhandled');
            }
            for (let i = 0; i < count; i++) zmk.ledOrder[start + i] = pos[i] ?? 0xFF;
            saveWorkspace(this.ws);
            return payload;
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
        if (ch === CH.leader && id === V.leaderSlot) {
            const d = decodeLeaderSlot(payload, dims(this.ws.family).leaderKeys);
            if (!zmk.leader[d.seq]) return payload;
            // Firmware normalization: valid board positions, leading prefix,
            // unknown actions empty.
            const positions = d.positions
                .filter((p) => p >= 0 && p < dims(this.ws.family).positions)
                .slice(0, dims(this.ws.family).leaderKeys);
            const action = d.action > 2 ? 0 : d.action;
            zmk.leader[d.seq] = { positions, action, param: action ? d.param : 0 };
            this.ws.zmkDirty.leaderSlot[d.seq] = true;
            saveWorkspace(this.ws);
            return encodeLeaderSlot(d.seq, zmk.leader[d.seq], dims(this.ws.family).leaderKeys);
        }
        if (ch === CH.gestures && id === V.gesturesSlot) {
            const d = decodeGestureSlot(payload);
            if (!zmk.gestures[d.set] || d.dir > 7) return payload;
            const action = d.action > 2 ? 0 : d.action;
            zmk.gestures[d.set][d.dir] = { action, param: action ? d.param : 0 };
            this.ws.zmkDirty.gestureSlot[`${d.set},${d.dir}`] = true;
            saveWorkspace(this.ws);
            return encodeGestureSlot(d.set, d.dir, zmk.gestures[d.set][d.dir]);
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
                name: this.ws.family === 'totem' ? TOTEM_LAYOUT.name : 'Imprint',
                keys: geomFor(this.ws.family).map((k) => ({ x: k.x, y: k.y, w: k.w ?? 1, h: k.h ?? 1, r: k.r ?? 0, rx: k.rx ?? 0, ry: k.ry ?? 0 })),
            }],
        };
    }

    async getKeymap() { return structuredClone(this.ws.zmk.keymap); }

    async listAllBehaviors() { return [...catalogFor(this.ws).keys()]; }
    async getBehaviorDetails(id) {
        const d = catalogFor(this.ws).get(id);
        if (!d) throw new Error(`unknown behavior ${id}`);
        return structuredClone(d);
    }

    async setLayerBinding(layerId, keyPosition, binding) {
        const layer = this._layerById(layerId);
        if (!layer || keyPosition < 0 || keyPosition >= layer.bindings.length) {
            throw new Error('invalid location');
        }
        const d = catalogFor(this.ws).get(binding.behaviorId);
        if (!d) throw new Error('INVALID_BEHAVIOR');
        // Firmware-faithful validation (zmk_behavior_validate_binding):
        // a behavior with no metadata at all is rejected outright
        // (-ENODEV → INVALID_PARAMETERS), and an unused param slot only
        // accepts 0. The sim used to accept anything here — which is how
        // the metadata-less urob leader looked assignable for two benches.
        const p1 = (binding.param1 ?? 0) >>> 0;
        const p2 = (binding.param2 ?? 0) >>> 0;
        if (isUnassignable(d)) throw new Error('INVALID_PARAMETERS');   // -ENODEV: no get_parameter_metadata
        if (!d.metadata.length) {
            if (!d.displayName || p1 !== 0 || p2 !== 0) throw new Error('INVALID_PARAMETERS');
        } else {
            const set = d.metadata[0];
            if ((!set.param1.length && p1 !== 0) || (!set.param2.length && p2 !== 0)) {
                throw new Error('INVALID_PARAMETERS');
            }
        }
        layer.bindings[keyPosition] = {
            behaviorId: binding.behaviorId,
            param1: p1,
            param2: p2,
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
        // saved keymap wins" auto-sync, same idea as the keymap export/import).
        // Export shape: behavior display names are the cross-device
        // identity — the real firmware's ids differ from the sim's, and
        // the keymap tab's import applier resolves names against the
        // device's own behavior list.
        this.ws.zmk.pendingKeymap = {
            kind: 'flask-zmk-keymap',
            version: 1,
            family: this.ws.family,
            device: this.ws.deviceName ?? `${ZMK_FAMILY_LABELS[this.ws.family]} (unplugged)`,
            exported: new Date().toISOString(),
            layers: this.ws.zmk.keymapSaved.layers.map((l, i) => {
                // Device-seeded: queue ONLY what changed since the seed.
                // Untouched keys go out as unresolvable placeholders (the
                // applier counts them skipped, never writes them), so a
                // replay can't revert anything done to the board meanwhile.
                const base = this.ws.zmk.seedBase?.layers[i];
                const same = base && base.id === l.id && base.bindings.length === l.bindings.length;
                return {
                    id: l.id,
                    name: same && base.name === l.name ? '' : l.name,
                    bindings: l.bindings.map((b, p) => {
                        const o = same && base.bindings[p];
                        if (o && o.behaviorId === b.behaviorId && o.param1 === b.param1 && o.param2 === b.param2) {
                            return { behavior: null, behaviorId: -1, param1: 0, param2: 0 };
                        }
                        const d = catalogFor(this.ws).get(b.behaviorId);
                        return {
                            behavior: d?.displayName ?? null,
                            // extras: the board's own id is the exact-device fallback
                            behaviorId: d?.deviceId ?? b.behaviorId,
                            param1: b.param1,
                            param2: b.param2,
                        };
                    }),
                };
            }),
        };
        this._persist(false);
    }

    async discardChanges() {
        this.ws.zmk.keymap = structuredClone(this.ws.zmk.keymapSaved);
        this.ws.zmk.removed = [];
        this._persist(false);
    }

    /** A device-seeded workspace replays its keymap by layer INDEX on connect;
     * add/remove/move would overwrite real layers there (WC-02). Rename and
     * key edits are fine. Templates never replay, so they stay editable. */
    _structureGuard() {
        if (this.ws.source === 'device') {
            throw new Error('Adding, removing or reordering layers needs the keyboard connected');
        }
    }

    async moveLayer(startIndex, destIndex) {
        this._structureGuard();
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
        this._structureGuard();
        const km = this.ws.zmk.keymap;
        if ((km.availableLayers ?? 0) <= 0) throw new Error('no free layer slots — remove a layer first');
        const layer = {
            id: this.ws.zmk.nextLayerId++,
            name: '',
            bindings: Array.from({ length: dims(this.ws.family).positions },
                () => bind(transparentFor(this.ws))),
        };
        km.layers.push(layer);
        km.availableLayers -= 1;
        this._persist(true);
        return { index: km.layers.length - 1, layer: structuredClone(layer) };
    }

    async removeLayer(index) {
        this._structureGuard();
        const km = this.ws.zmk.keymap;
        if (index < 0 || index >= km.layers.length) throw new Error('invalid index');
        const [gone] = km.layers.splice(index, 1);
        this.ws.zmk.removed.push(gone);
        km.availableLayers = (km.availableLayers ?? 0) + 1;
        this._persist(true);
    }

    async restoreLayer(layerId, atIndex) {
        this._structureGuard();
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
// Unplugged: seed the workspace from the user's real keymap

const SEED_LABELS = { totem: 'Totem', imprint: 'Imprint' };
const isSame = (a, b) => a.behaviorId === b.behaviorId && a.param1 === b.param1 && a.param2 === b.param2;

/**
 * Make `family`'s workspace start from the REAL keymap read off a device
 * (or a stored snapshot of one): keymap + keymapSaved replaced, source
 * 'device', tunables/combos/etc kept. Behaviors map by display name to the
 * family catalog; names the catalog lacks become ws.zmk.extraBehaviors
 * (ids above the catalog max, deviceId = the board's own id) so they still
 * render and replay by name. layers: [{id, name, bindings:[{behaviorId,
 * param1, param2}]}]; behaviors: Map id → {displayName, metadata}.
 * Returns the workspace, or null when skipped: a workspace holding unsynced
 * keymap edits is never overwritten (unless it is a template, whose edits
 * can't replay anyway; those are kept in zmk.droppedTemplateKeymap).
 */
export function seedWorkspaceFromDevice(family, { layers, behaviors, availableLayers = 0,
    maxLayerNameLength = 20, deviceName } = {}) {
    if (!ZMK_TEMPLATE_FAMILIES.includes(family) || !layers?.length) return null;
    if (layers.some((l) => l.bindings.length !== dims(family).positions)) return null;
    const key = workspaceKey(family);
    const ws = loadWorkspace(key) ?? createZmkTemplate(family);
    normalizeZmkWorkspace(ws);
    const edited = !!(ws.zmk.pendingKeymap || ws.zmk.unsaved);
    if (edited && ws.source === 'device') return null;
    if (edited) ws.zmk.droppedTemplateKeymap = ws.zmk.pendingKeymap ?? ws.zmk.keymap;

    const base = baseCatalog(family);
    const byName = new Map();
    for (const d of base.values()) if (d.displayName && !byName.has(d.displayName)) byName.set(d.displayName, d.id);
    const prev = Object.values(ws.zmk.extraBehaviors ?? {});
    const extra = {};
    let nextId = Math.max(...base.keys(), ...prev.map((d) => d.id)) + 1;
    const used = new Set(layers.flatMap((l) => l.bindings.map((b) => b.behaviorId)));
    const toId = new Map();     // device id → workspace id
    const resolve = (devId) => {
        if (toId.has(devId)) return toId.get(devId);
        const d = behaviors.get(devId);
        const name = d?.displayName || `Behavior #${devId}`;
        let id = d?.displayName ? byName.get(name) : undefined;
        if (id == null) {
            id = prev.find((x) => x.displayName === name)?.id ?? nextId++;
            extra[id] = { id, displayName: name, metadata: structuredClone(d?.metadata ?? []), deviceId: devId };
        }
        toId.set(devId, id);
        return id;
    };
    for (const [devId, d] of behaviors) if (d.displayName && (!byName.has(d.displayName) || used.has(devId))) resolve(devId);
    const out = layers.map((l) => ({
        id: l.id, name: l.name,
        bindings: l.bindings.map((b) => bind(resolve(b.behaviorId), b.param1 >>> 0, b.param2 >>> 0)),
    }));

    const keymap = { layers: out, availableLayers, maxLayerNameLength };
    ws.source = 'device';
    ws.label = `${SEED_LABELS[family]} (unplugged)`;
    ws.deviceName = deviceName ?? ws.deviceName;
    ws.savedAt = Date.now();
    ws.layerCount = out.length;
    ws.profile.layerNames = out.map((l, i) => layerLabel(l.name, i));
    Object.assign(ws.zmk, {
        keymap, keymapSaved: structuredClone(keymap), seedBase: structuredClone(keymap),
        extraBehaviors: Object.keys(extra).length ? extra : undefined,
        pendingKeymap: null, removed: [], unsaved: false,
        nextLayerId: Math.max(...out.map((l) => l.id)) + 1,
    });
    saveWorkspace(ws);
    return ws;
}

/**
 * Bootstrap for a board that is not here: seed `family` from the newest
 * stored zmk-keymap-snapshot:<serial> (written by zmk-keymap-tab on connect
 * and save) whose layers have this family's position count. No-op when the
 * workspace is already device-seeded. Snapshots carry names + ids but no
 * metadata; layer ids are assumed to equal layer index.
 */
export function seedWorkspaceFromSnapshot(family) {
    if (!ZMK_TEMPLATE_FAMILIES.includes(family) || loadWorkspace(workspaceKey(family))?.source === 'device') return null;
    let best = null;
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith('zmk-keymap-snapshot:')) continue;
        try {
            const snap = JSON.parse(localStorage.getItem(k));
            const fits = snap?.layers?.length && snap.layers.every((l) => l.bindings?.length === dims(family).positions);
            if (fits && (!best || String(snap.savedAt) > String(best.savedAt))) best = snap;
        } catch { /* skip a corrupt entry */ }
    }
    if (!best) return null;
    const behaviors = new Map();
    for (const l of best.layers) for (const b of l.bindings) {
        if (!behaviors.has(b.behaviorId)) behaviors.set(b.behaviorId, { displayName: b.behavior ?? '', metadata: [] });
    }
    return seedWorkspaceFromDevice(family, {
        layers: best.layers.map((l, id) => ({ id, name: l.name, bindings: l.bindings })),
        behaviors, deviceName: best.device,
    });
}

// ---------------------------------------------------------------------------
// Attach / sync

/** Swap the app onto the offline imprint workspace (main.js dispatch). */
export function attachZmkOffline(app, ws) {
    normalizeZmkWorkspace(ws);
    app.flask = new ZmkOfflineFlask(ws);
    app.zmkStudioSim = new OfflineStudioClient(ws);
    app.family = ws.family;
    app.protocolVersion = ws.protocolVersion;
    app.caps = zmkCapabilities(ws.family, ws.protocolVersion);
    app.profile = ws.profile;
    app.layerCount = ws.layerCount;
    app.keymap = null;
    app.unlocked = false;
    app.readKeyState = async () => new Set();
    // Unplugged has no board to be unresolved about; a stale flag from the
    // last connect would refuse every keymap write in the sim.
    app.familyUnresolved = false;
    // Baseline for "Discard queued". The top-bar Discard (saveState.discardAll)
    // deliberately does NOT touch the queue: a saved Unplugged edit IS the queue.
    if (!offlineQueued(ws)) snapshotBase(ws);
}

/**
 * Replay combo-slot + macro-step edits onto a real imprint (tunables + RGB
 * ride offline.js syncWorkspace — shared journal shapes). Returns counts;
 * the caller toasts.
 */
export async function zmkSyncExtras(app, ws) {
    // Connect-time replay is a write burst — HUD poll backs off until done.
    app.hid?.pause?.();
    try { return await zmkSyncExtrasInner(app, ws); }
    finally { app.hid?.resume?.(); }
}

async function zmkSyncExtrasInner(app, ws) {
    normalizeZmkWorkspace(ws);
    const fail = [];
    let applied = 0;
    // SAVE is the commit point: entries leave the journal only after their
    // channel's SAVE lands. A SET alone is RAM, gone at power-off.
    const commit = async (ch, table, keys, name) => {
        if (!keys.length) return;
        try { await app.flask.save(ch); } catch (e) {
            if (e.message !== 'unhandled') {     // unhandled = channel has nothing to persist
                fail.push(`${name}: SAVE failed (${e.message}), ${keys.length} still queued`);
                return;
            }
        }
        for (const k of keys) delete table[k];
        applied += keys.length;
    };
    const d = ws.zmkDirty;

    // Slot frame is sized by the DEVICE's keys-per-slot (v9 RO value;
    // pre-v9 firmware is fixed at the codec default of 4).
    let comboKeys = COMBO_MAX_KEYS;
    if (Object.keys(d.combo).length && app.caps?.combosKeys) {
        try { comboKeys = await app.flask.getU16(CH.combos, V.combosKeys) || COMBO_MAX_KEYS; }
        catch { /* keep default */ }
    }

    let ok = [];
    for (const slot of Object.keys(d.combo)) {
        try {
            // Same ladder as zmk-export.js: v14 takes the timed frame (window,
            // idle, layer survive), v12 the typed frame (behavior outputs
            // survive), older firmware the legacy usage-only view.
            if (app.caps?.combosTimed) {
                await app.flask.setBytes(CH.combos, V.combosSlotV3,
                    encodeComboSlotV3(Number(slot), ws.zmk.combos[slot], comboKeys), 1);
            } else if (app.caps?.combosTyped) {
                await app.flask.setBytes(CH.combos, V.combosSlotV2,
                    encodeComboSlotV2(Number(slot), ws.zmk.combos[slot], comboKeys), 1);
            } else {
                await app.flask.setBytes(CH.combos, V.combosSlot,
                    encodeComboSlot(Number(slot), comboTypedToLegacy(ws.zmk.combos[slot]),
                        comboKeys), 1);
            }
            ok.push(slot);
        } catch (e) { fail.push(`combo ${slot}: ${e.message}`); }
    }
    await commit(CH.combos, d.combo, ok, 'combos');

    ok = [];
    for (const key of Object.keys(d.macroStep)) {
        const [m, s] = key.split(',').map(Number);
        try {
            await app.flask.setBytes(CH.macros, V.macrosStep,
                encodeMacroStep(m, s, ws.zmk.macros[m][s]), 2);
            ok.push(key);
        } catch (e) { fail.push(`macro ${key}: ${e.message}`); }
    }
    await commit(CH.macros, d.macroStep, ok, 'macros');

    ok = [];
    for (const seq of Object.keys(d.leaderSlot)) {
        try {
            await app.flask.setBytes(CH.leader, V.leaderSlot,
                encodeLeaderSlot(Number(seq), ws.zmk.leader[seq], dims(ws.family).leaderKeys), 1);
            ok.push(seq);
        } catch (e) { fail.push(`leader ${seq}: ${e.message}`); }
    }
    await commit(CH.leader, d.leaderSlot, ok, 'leader');

    ok = [];
    for (const key of Object.keys(d.gestureSlot)) {
        const [set, dir] = key.split(',').map(Number);
        try {
            await app.flask.setBytes(CH.gestures, V.gesturesSlot,
                encodeGestureSlot(set, dir, ws.zmk.gestures[set][dir]), 2);
            ok.push(key);
        } catch (e) { fail.push(`gesture ${key}: ${e.message}`); }
    }
    await commit(CH.gestures, d.gestureSlot, ok, 'gestures');

    // Custom shift: one slot frame per edited slot (same frame the Shift tab sends).
    ok = [];
    let morph, osk;   // probed once, only if a slot needs them
    for (const slot of Object.keys(d.cskSlot)) {
        try {
            if (!ws.zmk.csk[slot]) throw new Error('unhandled');
            // Firmware without OSK_CAPS would drop the OS/wildcard/count bits.
            if (cskNeedsOs(ws.zmk.csk[slot])) {
                osk ??= await cskOskCaps(app.flask);
                if (!osk) {
                    fail.push(`shift ${slot}: needs OS-aware firmware, still queued`);
                    continue;
                }
            } else if (cskNeedsMorph(ws.zmk.csk[slot])) {   // Shift-only firmware would echo OK but store a plain Shift slot
                morph ??= await cskMorphCaps(app.flask);
                if (!morph) {
                    fail.push(`shift ${slot}: needs mod-morph firmware, still queued`);
                    continue;
                }
            }
            await app.flask.setBytes(CH.customShift, V.cskSlot,
                encodeCskSlot(Number(slot), ws.zmk.csk[slot]), 1);
            ok.push(slot);
        } catch (e) {
            if (e.message === 'unhandled') delete d.cskSlot[slot];
            else fail.push(`shift ${slot}: ${e.message}`);
        }
    }
    await commit(CH.customShift, d.cskSlot, ok, 'shift');

    // Tap dance: keys are "slot,tap" (step frame) or "slot,cfg" (term frame).
    ok = [];
    for (const key of Object.keys(d.tdStep)) {
        const [slot, which] = key.split(',');
        const td = ws.zmk.tapdance[slot];
        try {
            if (!td) throw new Error('unhandled');
            if (which === 'cfg') {
                await app.flask.setBytes(CH.tapDance, V.tdCfg, encodeTdCfg(Number(slot), td.termMs), 1);
            } else {
                await app.flask.setBytes(CH.tapDance, V.tdStep,
                    encodeTdStep(Number(slot), Number(which), td.taps[which]), 2);
            }
            ok.push(key);
        } catch (e) {
            if (e.message === 'unhandled') delete d.tdStep[key];
            else fail.push(`tap dance ${key}: ${e.message}`);
        }
    }
    await commit(CH.tapDance, d.tdStep, ok, 'tap dance');

    // flask_adaptive: header, then every step, per edited rule (a deleted
    // rule is just its zeroed header); fallbacks are keyed f<set>. A device
    // without the module answers unhandled: those entries are dropped.
    ok = [];
    const ak = ws.zmk.adaptive;
    for (const key of Object.keys(d.akRule)) {
        try {
            if (!ak) throw new Error('unhandled');
            if (key.startsWith('f')) {
                const set = Number(key.slice(1));
                await app.flask.setBytes(CH.adaptive, V.akFallback,
                    encodeAkFallback(set, ak.fallback[set]), 1);
            } else {
                const i = Number(key), r = ak.rules[i];
                await app.flask.setBytes(CH.adaptive, V.akRule, encodeAkRule(i, r), 1);
                if (r.trigger) {
                    for (let st = 0; st < r.steps.length; st++) {
                        await app.flask.setBytes(CH.adaptive, V.akStep, encodeAkStep(i, st, r.steps[st]), 2);
                    }
                }
            }
            ok.push(key);
        } catch (e) {
            if (e.message === 'unhandled') delete d.akRule[key];
            else fail.push(`adaptive ${key}: ${e.message}`);
        }
    }
    await commit(CH.adaptive, d.akRule, ok, 'adaptive');

    // A queued keymap can't apply here — Studio RPC needs its own serial
    // connect (user gesture) + physical unlock. Stash the workspace; the
    // keymap tab applies it when it reaches 'ready' on a real device.
    // A TEMPLATE workspace's keymap is the firmware template plus edits,
    // not the user's board: replaying it would overwrite the real keymap.
    // Only a device-seeded workspace queues its keymap; a template one is
    // skipped (left in storage) and reported so the caller can say so.
    // A device-seeded keymap whose layer ids/count drifted from the seed
    // (layer ops, a stale workspace) is replayed BY INDEX, which would
    // overwrite real layers: keep it queued for review instead.
    const keymapSkipped = !!ws.zmk?.pendingKeymap && ws.source !== 'device';
    const keymapReview = !!ws.zmk?.pendingKeymap && !keymapSkipped && layersDrifted(ws);
    app.zmkQueuedWs = ws.zmk?.pendingKeymap && !keymapSkipped && !keymapReview ? ws : null;

    saveWorkspace(ws);
    return { applied, failures: fail, keymapSkipped, keymapReview };
}

/** True when the saved keymap's layer ids/count no longer match the seed. */
function layersDrifted(ws) {
    const ids = (km) => (km?.layers ?? []).map((l) => l.id).join(',');
    const base = ws.zmk.seedBase;
    return !base || ids(ws.zmk.keymapSaved) !== ids(base);
}

/** True when the keyboard's live layers (ids and count) still match the layers
 * the Unplugged workspace was seeded from, so a by-index replay is safe. */
export function queuedLayersMatch(ws, liveLayers) {
    const ids = (ls) => (ls ?? []).map((l) => l.id).join(',');
    const base = ws?.zmk?.seedBase;
    return !!base && ids(base.layers) === ids(liveLayers);
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
