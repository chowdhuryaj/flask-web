// The one board in the frame: selection, assignment, position picking
// (spec §3.1, §3.4). WP0 STUB of the contract other packages call; WP2 owns
// this file, moves renderKeyboardSVG here and fills the bodies.
//
// Contract (stable for Phase 1):
//   board.selectedKey() → {layer, pos} | null   (QMK: pos = {row, col} or
//                         {encoder, dir}; ZMK/Nape: pos = position index)
//   board.assign(binding, {advance = true}) → Promise<boolean>
//                         write `binding` (adapter-typed, see
//                         binding-picker.js) to the selected key; advances
//                         the selection unless it is an encoder
//   board.pickPositions({initial = [], max, label, onChange}) → stop()
//                         position-pick mode for combos/leader: the board
//                         toggles positions, calls onChange(positions[]) on
//                         each toggle; stop() leaves the mode
//   board.addEventListener('select', …)   detail = selectedKey()
//
// Stubs: today each keymap tab keeps its own selection, so there is no
// shared selection yet.

class Board extends EventTarget {
    selectedKey() { return null; }
    async assign(binding, { advance = true } = {}) { return false; } // eslint-disable-line no-unused-vars
    pickPositions({ initial = [], max, label, onChange } = {}) { return () => {}; } // eslint-disable-line no-unused-vars
}

export const board = new Board();
