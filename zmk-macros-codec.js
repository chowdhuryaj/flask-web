// flask_macros step-frame codec (ZMK line, channel 0x25) — pure functions,
// no imports, so the node offline tests (zmk-studio-test.mjs) exercise the
// exact bytes the tab writes. Wire shape (payload-addressed, like the combo
// slot frames — NOT a u16 frame):
//
//   [slot, step, action, param_b3, param_b2, param_b1, param_b0]
//
// action: 0 empty (ends playback), 1 tap, 2 press, 3 release, 4 wait.
// param: encoded usage (ZMK keymap encoding — usage id bits 0-15, page bits
// 16-23, implicit-modifier bits 24-31) for key actions; milliseconds for
// wait; 0 for empty. Big-endian on the wire.

export const MACRO_ACTION = { empty: 0, tap: 1, press: 2, release: 3, wait: 4 };

export const MACRO_ACTION_LABELS = {
    [MACRO_ACTION.tap]: 'Tap',
    [MACRO_ACTION.press]: 'Press',
    [MACRO_ACTION.release]: 'Release',
    [MACRO_ACTION.wait]: 'Wait',
};

/** Reply payload → { slot, step, action, param }. */
export function decodeMacroStep(bytes) {
    return {
        slot: bytes[0], step: bytes[1], action: bytes[2],
        param: (((bytes[3] << 24) | (bytes[4] << 16) | (bytes[5] << 8) | bytes[6]) >>> 0),
    };
}

/** { action, param } → SET payload for the given slot/step index. Unknown
 * actions and empty steps normalize to action 0 / param 0 (the firmware
 * does the same — keep the round-trip byte-stable). */
export function encodeMacroStep(slot, step, { action = 0, param = 0 }) {
    if (action < MACRO_ACTION.empty || action > MACRO_ACTION.wait) action = MACRO_ACTION.empty;
    if (action === MACRO_ACTION.empty) param = 0;
    param = param >>> 0;
    return [slot & 0xFF, step & 0xFF, action & 0xFF,
        (param >>> 24) & 0xFF, (param >>> 16) & 0xFF, (param >>> 8) & 0xFF, param & 0xFF];
}

/** A macro is empty when its first step is (playback stops at the first
 * empty step, so anything behind one never runs). */
export function macroIsEmpty(steps) {
    return !steps?.length || steps[0].action === MACRO_ACTION.empty;
}

/** Steps that actually play: the prefix up to the first empty step. */
export function macroLiveSteps(steps) {
    const end = steps.findIndex((s) => s.action === MACRO_ACTION.empty);
    return end < 0 ? steps : steps.slice(0, end);
}
