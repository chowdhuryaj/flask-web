// Tab registry: which palette tabs a device gets, in what order, under which
// group. One declarative table instead of the old buildTabs if-chain in
// main.js. Ids are unchanged from before the redesign (main.js, ⌘K and
// saved state key off them); groups follow spec §1.3.
//
// Contract (WP0, stable for Phase 1):
//   TAB_GROUPS            [{id, label}] in display order
//   TAB_TABLE             [{id, label, group, when(app) → bool, ctor}]
//   tabsFor(app)          → [{id, label, group, ctor}] for this app state, in
//                         table order, each id at most once
//   groupOf(id)           → group id ('device' for unknown ids)
//
// WP1 added `keyboard` (Device › Keyboard, last in table order).
//
// `app` needs only {trainerOnly, family, caps}. Constructors are called as
// `new ctor(app)` by main.js; nothing here touches the DOM.

import { isZmkFamily } from './zmk.js?v=62';
import { ZmkKeymapTab } from './zmk-keymap-tab.js?v=62';
import { ZmkRgbTab } from './zmk-rgb-tab.js?v=62';
import { ZmkCombosTab } from './zmk-combos-tab.js?v=62';
import { ZmkMacrosTab } from './zmk-macros-tab.js?v=62';
import { ZmkLeaderTab } from './zmk-leader-tab.js?v=62';
import { ZmkGesturesTab } from './zmk-gestures-tab.js?v=62';
import { ZmkShiftTab } from './zmk-shift-tab.js?v=62';
import { ZmkTapDanceTab } from './zmk-tapdance-tab.js?v=62';
import { ZmkHoldTimingTab } from './zmk-holdtiming-card.js?v=62';
import { ZmkTestTab } from './zmk-test-tab.js?v=62';
import { ZmkModesTab } from './zmk-modes-tab.js?v=62';
import { MouseTab } from './mouse-tab.js?v=62';
import { TrainerTab } from './trainer-tab.js?v=62';
import { KeyboardTab } from './app-shell.js?v=62';

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

// Order = tab order (the first visible row is the landing tab). No Build /
// Bench / bake / Tap Calibrator / Teleport rows; those stay native-only.
export const TAB_TABLE = [
    { id: 'zmk-keymap', label: 'Keymap', group: 'keys', screen: 'keymap', when: (a) => a.caps.zmkStudio, ctor: ZmkKeymapTab },
    { id: 'gestures', label: 'Gestures', group: 'device', screen: 'device', when: (a) => a.caps.gestures, ctor: ZmkGesturesTab },
    { id: 'mouse', label: 'Mouse', group: 'device', screen: 'device', when: (a) => a.caps.mouse, ctor: MouseTab },
    // Needs no capability: it runs on browser key events.
    { id: 'trainer', label: 'Trainer', group: 'trainer', screen: 'trainer', when: () => true, ctor: TrainerTab },
    { id: 'rgb', label: 'RGB', group: 'device', screen: 'device', when: (a) => a.caps.rgbMap, ctor: ZmkRgbTab },
    // caps.combos/macros/tapDance/leader come from zmkCapabilities.
    { id: 'zmk-combos', label: 'Combos', group: 'behaviour', screen: 'combos', when: (a) => a.caps.combos, ctor: ZmkCombosTab },
    { id: 'zmk-macros', label: 'Macros', group: 'behaviour', screen: 'macros', when: (a) => a.caps.macros, ctor: ZmkMacrosTab },
    { id: 'zmk-tapdance', label: 'Tap Dance', group: 'behaviour', screen: 'behaviours', when: (a) => a.caps.tapDance, ctor: ZmkTapDanceTab },
    // §1.3: renamed "Shift" → "Shift Keys" (native label).
    { id: 'zmk-shift', label: 'Shift Keys', group: 'behaviour', screen: 'behaviours', when: (a) => a.caps.customShift, ctor: ZmkShiftTab },
    { id: 'zmk-leader', label: 'Leader', group: 'behaviour', screen: 'behaviours', when: (a) => a.caps.leader, ctor: ZmkLeaderTab },
    // AJ-Q4 / WP7: per-key and virtual-slot hold-tap timing (flask_holdtap,
    // 0x2A). caps.holdtap is set by main.js's async probe: proto >= 17 AND
    // GET 2A 01 answers (Imprint and older Totem images answer 0xFF).
    { id: 'zmk-holdtiming', label: 'Hold timing', group: 'behaviour', screen: 'behaviours', when: (a) => zmk(a) && !!a.caps.holdtap, ctor: ZmkHoldTimingTab },
    // Modes are app-side snapshots, so any ZMK board has them.
    { id: 'zmk-modes', label: 'Modes', group: 'device', screen: 'device', when: zmk, ctor: ZmkModesTab },
    { id: 'zmk-test', label: 'Test', group: 'device', screen: 'test', when: zmk, ctor: ZmkTestTab },
    // §1.3: Device › Keyboard, on every device and offline workspace (the
    // header leftovers: appearance, diagnostics, device info).
    { id: 'keyboard', label: 'Keyboard', group: 'device', screen: 'device', when: () => true, ctor: KeyboardTab },
];

/**
 * Look-shell: the top-level tab row. A screen is one button in the second row
 * of the top bar; a screen with several tabs (Behaviours, Device) shows them
 * as a small segmented strip above its panel. Tab ids and groups are unchanged.
 */
export const SCREENS = [
    { id: 'keymap', label: 'Keymap' },
    { id: 'combos', label: 'Combos' },
    { id: 'behaviours', label: 'Behaviours' },
    { id: 'macros', label: 'Macros' },
    { id: 'device', label: 'Device' },
    { id: 'test', label: 'Test' },
    { id: 'trainer', label: 'Trainer' },
];
// Tabs that need the board (and layer rail) on screen: Keymap edits keys,
// Combos and Leader pick positions on it, Hold timing jumps to a key.
export const BOARD_TABS = new Set(['zmk-keymap', 'zmk-combos', 'zmk-leader', 'zmk-holdtiming']);
export const SIDE_TABS = new Set(['zmk-keymap']);   // the right context panel

/** @returns {{id:string,label:string,group:string,screen:string,ctor:Function}[]} */
export function tabsFor(app) {
    // Standalone trainer: an explicit gate, because there is no device (the
    // placeholder 'generic' family) for the device tabs to talk to.
    if (app.trainerOnly) return [{ id: 'trainer', label: 'Typing trainer', group: 'trainer', screen: 'trainer', ctor: TrainerTab }];
    const seen = new Set();
    const out = [];
    for (const { id, label, group, screen, when, ctor } of TAB_TABLE) {
        if (seen.has(id) || !when(app)) continue;
        seen.add(id);
        out.push({ id, label, group, screen, ctor });
    }
    return out;
}

export const screenOf = (id) => TAB_TABLE.find((t) => t.id === id)?.screen ?? 'device';

/** Screens present for these tabs, in SCREENS order, each with its tabs. */
export function screensFor(tabs) {
    return SCREENS.map((s) => ({ ...s, tabs: tabs.filter((t) => (t.screen ?? screenOf(t.id)) === s.id) }))
        .filter((s) => s.tabs.length);
}

export const groupOf = (id) => TAB_TABLE.find((t) => t.id === id)?.group ?? 'device';
