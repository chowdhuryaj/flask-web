// "Mac shortcuts on Windows" preset pack: author in Mac terms, the board sends
// the Windows shortcut while its OS mode is PC (oskeys-contract.md). Every row
// is OS = Windows with "count keymap mods" on. Names resolve through
// usageFromName (zmk-keycodes.js); mods are the trigger/replacement bit sets
// (⌃ 1, ⇧ 2, ⌥ 4, ⌘ 8). One wildcard + specific exceptions; specifics win.
// Left out on purpose: ⌥← ⌥→ (the PC swapper holds Alt itself, slk_wleft/wright
// already send Ctrl+arrows) and ⌘⌫ (the wildcard gives Ctrl+⌫).

import { usageFromName } from './zmk-keycodes.js?v=70';
import { MOD_CTL, MOD_SFT, MOD_ALT, MOD_GUI, OS_PC, WILD_KEY } from './zmk-csk-codec.js?v=70';

const C = MOD_CTL, S = MOD_SFT, A = MOD_ALT, G = MOD_GUI;
// [trigger mods, base, replacement, replacement mods, source note]
const SPECIFIC = [
    [G, 'Q', 'F4', A, 'Quit: Windows closes the window with Alt+F4'],
    [G, 'Tab', 'Tab', A, 'App switcher: Alt+Tab (the ⌘ is masked, Alt rides the Tab)'],
    [G | S, 'Z', 'Y', C, 'Redo: Windows uses Ctrl+Y'],
    [G, 'Left Arrow', 'Home', 0, 'Line start'],
    [G, 'Right Arrow', 'End', 0, 'Line end'],
    [G, 'Up Arrow', 'Home', C, 'Document start'],
    [G, 'Down Arrow', 'End', C, 'Document end'],
    [G | S, 'Left Arrow', 'Home', S, 'Select to line start'],
    [G | S, 'Right Arrow', 'End', S, 'Select to line end'],
    [G | S, 'Up Arrow', 'Home', C | S, 'Select to document start'],
    [G | S, 'Down Arrow', 'End', C | S, 'Select to document end'],
    [A, 'Backspace', 'Backspace', C, 'Delete word back'],
    [A, 'Delete', 'Delete', C, 'Delete word forward'],
    [G, 'Space', 'Escape', C, 'Spotlight becomes Ctrl+Esc (opens Start; a bare GUI replacement would be masked)'],
    [C | G, 'Q', 'L', G, 'Lock screen: Win+L'],
    [G | A, 'Escape', 'Escape', C | S, 'Force quit becomes Task Manager: Ctrl+Shift+Esc'],
    [G | S, '4', 'S', G | S, 'Screenshot region: Win+Shift+S'],
    [G | S, '3', 'Print Screen', 0, 'Full screenshot: PrintScreen'],
    [G, 'M', 'Down Arrow', G, 'Minimize: Win+Down'],
    [G, 'H', 'Down Arrow', G, 'Hide is closest to minimize: Win+Down'],
    [C | G, 'F', 'F11', 0, 'Full screen: F11'],
];

const row = (mods, base, repl, rmods, src, extra = {}) => {
    const b = usageFromName(base), r = usageFromName(repl);
    if (b == null || r == null) throw new Error(`os-pack: unknown key ${base}/${repl}`);
    return { mods, base: b >>> 0, shifted: (((rmods << 24) | r) >>> 0), keep: false, os: OS_PC, count: true, src, ...extra };
};

/** The pack as ready-to-write slot objects ({base, shifted, mods, keep, os, wild, count, src}). */
export const OS_PACK = [
    { mods: G, base: WILD_KEY, shifted: ((C << 24) | WILD_KEY) >>> 0, keep: false, os: OS_PC, wild: true, count: true,
        src: 'Any ⌘ shortcut (C V X Z A S F N T W P B I O, ⌘⇧T, ⌘, ...) becomes the ⌃ shortcut' },
    ...SPECIFIC.map((e) => row(...e)),
];

export const OS_PACK_LABEL = 'Mac shortcuts on Windows';
