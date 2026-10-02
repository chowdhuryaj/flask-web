// The native editor frame (spec §0.1, §1.2): status bar, left rail, layer
// bar + board, palette (group chips, tab strip, content, caption bar).
//
// WP0 STUB. mount() only records the regions; the current header + full-page
// tabs layout stays until WP1 builds the frame here.
//
// Contract (stable for Phase 1):
//   shell.mount({statusBar, rail, layerBar, board, palette})
//       Elements for each region; any may be omitted. WP1 places them,
//       WP2 fills layerBar/board, WP6 fills the status bar's save segment.
//   shell.regions            the last mounted regions
//   shell.setCaption(text|null)   → caption.js setCaption
//   shell.selectedKey()      → board.selectedKey() (for ⌘K "assign to key")
//   shell.board              the board.js singleton

import { setCaption } from './caption.js?v=1';
import { board } from './board.js?v=1';

export const shell = {
    regions: {},
    board,
    mount({ statusBar, rail, layerBar, board: boardEl, palette } = {}) {
        this.regions = { statusBar, rail, layerBar, board: boardEl, palette };
    },
    setCaption,
    selectedKey: () => board.selectedKey(),
};
