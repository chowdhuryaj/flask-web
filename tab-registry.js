// Tab registry: which palette tabs a device gets, in what order, under which
// group. One declarative table instead of the old buildTabs if-chain in
// main.js. Ids are unchanged from before the redesign (main.js, ⌘K and
// saved state key off them); groups follow spec §1.3.
//
// Contract (WP0, stable for Phase 1):
//   TAB_GROUPS            [{id, label}] in display order
//   TAB_TABLE             [{id, label, group, when(app) → bool, ctor}]
//                         An id may have several rows with mutually exclusive
//                         `when` (gestures, rgb: QMK vs ZMK constructor).
//   tabsFor(app)          → [{id, label, group, ctor}] for this app state, in
//                         table order, each id at most once
//   groupOf(id)           → group id ('device' for unknown ids)
//
// WP1 added `keyboard` (Device › Keyboard, last in table order).
//
// `app` needs only {trainerOnly, family, caps}. Constructors are called as
// `new ctor(app)` by main.js; nothing here touches the DOM.

import { isZmkFamily } from './zmk.js?v=60';
import { NapeKeymapTab } from './nape-keymap-tab.js?v=60';
import { NapeSettingsTab } from './nape-settings-tab.js?v=60';
import { NapeMacrosTab } from './nape-macros-tab.js?v=60';
import { KeymapTab } from './keymap-tab.js?v=60';
import { ZmkKeymapTab } from './zmk-keymap-tab.js?v=60';
import { ZmkRgbTab } from './zmk-rgb-tab.js?v=60';
import { ZmkCombosTab } from './zmk-combos-tab.js?v=60';
import { ZmkMacrosTab } from './zmk-macros-tab.js?v=60';
import { ZmkLeaderTab } from './zmk-leader-tab.js?v=60';
import { ZmkGesturesTab } from './zmk-gestures-tab.js?v=60';
import { ZmkShiftTab } from './zmk-shift-tab.js?v=60';
import { ZmkTapDanceTab } from './zmk-tapdance-tab.js?v=60';
import { ZmkTestTab } from './zmk-test-tab.js?v=60';
import { ZmkModesTab } from './zmk-modes-tab.js?v=60';
import { MouseTab } from './mouse-tab.js?v=60';
import { TypingTab } from './typing-tab.js?v=60';
import { QmkLeaderTab } from './qmk-leader-tab.js?v=60';
import { QmkShiftTab } from './qmk-shift-tab.js?v=60';
import { SettingsTab } from './settings-tab.js?v=60';
import { MacrosTab } from './macros-tab.js?v=60';
import { TapDanceTab, ComboTab, KeyOverrideTab } from './entries-tab.js?v=60';
import { GesturesTab, ChordsTab } from './gestures-tab.js?v=60';
import { CornerTab } from './corner-tab.js?v=60';
import { RgbTab } from './rgb-tab.js?v=60';
import { DisplayTab } from './display-tab.js?v=60';
import { TrainerTab } from './trainer-tab.js?v=60';
import { KeyboardTab } from './app-shell.js?v=60';

/**
 * What KIND of thing a tab is. Mirrors AdeptCompanion's PaletteGroup, so the
 * two apps group the same way and muscle memory carries between them.
 * keys = pasting a keycode; behaviour = what a key or chord DOES;
 * device = tuning or administering the board; trainer = practising.
 */
export const TAB_GROUPS = [
    { id: 'keys', label: 'Keys' },
    { id: 'behaviour', label: 'Behaviour' },
    { id: 'device', label: 'Device' },
    { id: 'trainer', label: 'Trainer' },
];

const zmk = (app) => isZmkFamily(app.family);

// Order = today's tab order (the first visible row is the landing tab).
// AJ-Q1 (answered): no GMK70 rows; the GMK70 stays native-only.
// AJ-Q2 (answered): no Build / Bench / bake / Tap Calibrator / Teleport
//        rows; those stay native-only.
export const TAB_TABLE = [
    { id: 'zmk-keymap', label: 'Keymap', group: 'keys', when: (a) => a.caps.zmkStudio, ctor: ZmkKeymapTab },
    { id: 'nape-keymap', label: 'Keymap', group: 'keys', when: (a) => a.caps.nape, ctor: NapeKeymapTab },
    { id: 'nape-macros', label: 'Macros', group: 'behaviour', when: (a) => a.caps.nape, ctor: NapeMacrosTab },
    { id: 'nape-settings', label: 'Settings', group: 'device', when: (a) => a.caps.nape, ctor: NapeSettingsTab },
    { id: 'keymap', label: 'Keymap', group: 'keys', when: (a) => a.caps.vial, ctor: KeymapTab },
    { id: 'macros', label: 'Macros', group: 'behaviour', when: (a) => a.caps.vial, ctor: MacrosTab },
    { id: 'tapdance', label: 'Tap Dance', group: 'behaviour', when: (a) => a.caps.vial, ctor: TapDanceTab },
    { id: 'combos', label: 'Combos', group: 'behaviour', when: (a) => a.caps.vial, ctor: ComboTab },
    { id: 'overrides', label: 'Key Overrides', group: 'behaviour', when: (a) => a.caps.vial, ctor: KeyOverrideTab },
    { id: 'gestures', label: 'Gestures', group: 'device', when: (a) => a.caps.gestures && !zmk(a), ctor: GesturesTab },
    { id: 'gestures', label: 'Gestures', group: 'device', when: (a) => a.caps.gestures && zmk(a), ctor: ZmkGesturesTab },
    // §1.3: Device › Mouse Chords (was Behaviour). Sibling of Mouse so
    // mouse-tab.js stays untouched.
    { id: 'chords', label: 'Mouse Chords', group: 'device', when: (a) => a.caps.wheelChords, ctor: ChordsTab },
    // Positional chords (0x28, Svalboard v17+). Called "Chords", not "Combos":
    // 'combos' is Vial's keycode-matched feature and this one matches switch
    // POSITIONS. Sharing the word cost real debugging time, twice.
    { id: 'corner', label: 'Chords', group: 'behaviour', when: (a) => a.caps.cornerCombos, ctor: CornerTab },
    // AJ-Q3: QMK Super Leader and custom shift keys, out of Typing (WP4b).
    { id: 'qmk-leader', label: 'Leader', group: 'behaviour', when: (a) => a.caps.typing && !zmk(a), ctor: QmkLeaderTab },
    { id: 'qmk-shift', label: 'Shift Keys', group: 'behaviour', when: (a) => a.caps.typing && !zmk(a), ctor: QmkShiftTab },
    { id: 'mouse', label: 'Mouse', group: 'device', when: (a) => a.caps.mouse, ctor: MouseTab },
    // AJ-Q3: Super Leader / shift keys left Typing; see qmk-leader / qmk-shift above.
    { id: 'typing', label: 'Typing', group: 'device', when: (a) => a.caps.typing, ctor: TypingTab },
    // Needs no capability: it runs on browser key events.
    { id: 'trainer', label: 'Trainer', group: 'trainer', when: () => true, ctor: TrainerTab },
    { id: 'rgb', label: 'RGB', group: 'device', when: (a) => a.caps.rgbMap && !zmk(a), ctor: RgbTab },
    { id: 'rgb', label: 'RGB', group: 'device', when: (a) => a.caps.rgbMap && zmk(a), ctor: ZmkRgbTab },
    // ZMK line: caps.combos/macros/tapDance/leader come from zmkCapabilities.
    { id: 'zmk-combos', label: 'Combos', group: 'behaviour', when: (a) => a.caps.combos, ctor: ZmkCombosTab },
    { id: 'zmk-macros', label: 'Macros', group: 'behaviour', when: (a) => a.caps.macros, ctor: ZmkMacrosTab },
    { id: 'zmk-tapdance', label: 'Tap Dance', group: 'behaviour', when: (a) => a.caps.tapDance, ctor: ZmkTapDanceTab },
    // §1.3: renamed "Shift" → "Shift Keys" (native label).
    { id: 'zmk-shift', label: 'Shift Keys', group: 'behaviour', when: (a) => a.caps.customShift && zmk(a), ctor: ZmkShiftTab },
    { id: 'zmk-leader', label: 'Leader', group: 'behaviour', when: (a) => a.caps.leader, ctor: ZmkLeaderTab },
    // Modes are app-side snapshots, so any ZMK board has them.
    { id: 'zmk-modes', label: 'Modes', group: 'device', when: zmk, ctor: ZmkModesTab },
    { id: 'zmk-test', label: 'Test', group: 'device', when: zmk, ctor: ZmkTestTab },
    { id: 'display', label: 'Display', group: 'device', when: (a) => a.caps.display, ctor: DisplayTab },
    { id: 'settings', label: 'QMK Settings', group: 'device', when: (a) => a.caps.vial, ctor: SettingsTab },
    // §1.3: Device › Keyboard, on every device and offline workspace (the
    // header leftovers: appearance, diagnostics, lock, device info).
    { id: 'keyboard', label: 'Keyboard', group: 'device', when: () => true, ctor: KeyboardTab },
];

/** @returns {{id:string,label:string,group:string,ctor:Function}[]} */
export function tabsFor(app) {
    // Standalone trainer: an explicit gate, because caps.vial is true for
    // every QMK family (the placeholder 'generic' included), so the Vial
    // tabs would otherwise appear over a null client.
    if (app.trainerOnly) return [{ id: 'trainer', label: 'Typing trainer', group: 'trainer', ctor: TrainerTab }];
    const seen = new Set();
    const out = [];
    for (const { id, label, group, when, ctor } of TAB_TABLE) {
        if (seen.has(id) || !when(app)) continue;
        seen.add(id);
        out.push({ id, label, group, ctor });
    }
    return out;
}

export const groupOf = (id) => TAB_TABLE.find((t) => t.id === id)?.group ?? 'device';
