// TOTEM physical layout — ONE source for every path that draws a Totem:
// the connected profile (zmk.js zmkProfile) and the offline Studio stand-in
// (zmk-offline.js getPhysicalLayouts). A connected board's Studio layout
// replaces this once loaded; both paths read these same 38 positions so the
// offline preview can't drift from the online one. Pure data, imports nothing.
//
// 38 keys, Studio position order (row-major, left half then right half per
// row): row 0: 5+5, row 1: 5+5, row 2: 6+6 (outer pinky key), thumbs 3+3.
// Key units; the right half mirrors the left about x = 6.5 (1-key gap).
// Column stagger is cosmetic (pinky and ring/index sit lower than middle).

const STAGGER = [0.5, 0.25, 0, 0.25, 0.5];   // by left-half column x = 1..5 (outer key x = 0 uses the pinky's)
const mirror = (x) => 12 - x;

function build() {
    const keys = [];
    const rows = [
        { y: 0, cols: [1, 2, 3, 4, 5] },
        { y: 1, cols: [1, 2, 3, 4, 5] },
        { y: 2, cols: [0, 1, 2, 3, 4, 5] },
    ];
    for (const { y, cols } of rows) {
        const stag = (x) => (x === 0 ? STAGGER[1] : STAGGER[x - 1]);
        for (const x of cols) keys.push({ x, y: y + stag(x) });
        for (const x of cols.slice().reverse()) keys.push({ x: mirror(x), y: y + stag(x) });
    }
    const thumbs = [3.5, 4.5, 5.5];
    for (const x of thumbs) keys.push({ x, y: 3.4 });
    for (const x of thumbs.slice().reverse()) keys.push({ x: mirror(x), y: 3.4 });
    return keys;
}

export const TOTEM_GEOM = build();
export const TOTEM_POSITIONS = TOTEM_GEOM.length;   // 38
