// Window keyboard capture → ZMK usage params. Shared by the settings-tab
// key pickers (press-to-pick, so every Flask tab that assigns a keycode
// gets the keymap editor's type-to-assign convenience) and the macro
// recorder. `window` is touched ONLY inside the armed handlers, so this
// file is import-safe in node (the vector suite never arms capture).
//
// The keymap editor keeps its own inline capture (it assigns to a selected
// board position and auto-advances — a different lifecycle); the shared
// primitives here cover the modal/streaming cases.

import { eventToUsageParam } from './zmk-keycodes.js?v=18';

/** True when a usage param is a bare modifier key (LC/LS/…): keyboard-page
 * usage id 0xE0–0xE7. Mirrors the keymap editor's own test. */
export function isModifierUsage(param) {
    return param != null && (param & 0xFFFF) >= 0xE0 && (param & 0xFFFF) <= 0xE7;
}

/** The base usage without folded implicit modifiers (top byte cleared) —
 * what a macro step wants when the modifier is its own Press/Release. */
export function bareUsage(param) {
    return (param & 0x00FFFFFF) >>> 0;
}

/** Low-level: arm window key capture and return a `stop()` function.
 * keydown/keyup are swallowed at the capture phase (so ⌘S/Tab/Space etc.
 * never reach the browser), repeats are dropped, Escape stops. `isActive`
 * (optional) is checked on each event — return false to auto-stop when the
 * owning panel is no longer visible. */
export function armCapture({ onDown, onUp, isActive, onStop } = {}) {
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        window.removeEventListener('keydown', down, true);
        window.removeEventListener('keyup', up, true);
        onStop?.();
    };
    const down = (e) => {
        if (isActive && !isActive()) { stop(); return; }
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stop(); return; }
        if (e.repeat) return;
        const param = eventToUsageParam(e);
        if (param != null) onDown?.(param, e);
    };
    const up = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const param = eventToUsageParam(e);
        if (param != null) onUp?.(param, e);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return stop;
}

/** One-shot: capture a single keypress and hand back its usage param (with
 * implicit modifiers folded, so a chord like ⌃C assigns as one modified
 * usage). A lone modifier assigns on its solo release — so ⌃ on the way to
 * ⌃C is treated as a prefix, but ⌃ tapped by itself assigns Left Ctrl.
 * Returns a `stop()` to cancel. onStop fires on both fire and cancel. */
export function captureOneKey(onKey, { onStop } = {}) {
    let modPending = null;
    let done = false;
    let stop = () => {};
    const fire = (param) => {
        if (done) return;
        done = true;
        stop();
        onKey(param);
    };
    stop = armCapture({
        onStop,
        onDown: (param) => {
            if (isModifierUsage(param)) { modPending = param; return; }
            modPending = null;      // consumed as a chord prefix
            fire(param);
        },
        onUp: (param) => {
            if (modPending != null && isModifierUsage(param)) fire(modPending);
        },
    });
    return stop;
}
