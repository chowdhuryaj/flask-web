// Key legends for the board and the inspector (look-shell). One big centred
// label for what a tap does, one small mono sub-label for the hold / mode
// under it, and a colour kind: layer = blue, hold / modifier = amber, macro =
// violet, transparent / none = dim grey.
//
//   legendOf(value, adapter = 'zmk-studio') → {main, sub, kind, subKind}
//     kind     'plain' | 'layer' | 'hold' | 'mod' | 'macro' | 'dim'
//     subKind  colour of the sub-label: 'layer' | 'hold' | 'dim' | ''
//
// Pure (catalog only), so node tests can pin it.

import { decode, capParts, holdTapParts } from './behavior-catalog.js?v=69';
import { zmkBehaviors } from './zmk-keycodes.js?v=69';

const LAYER_CODE = {
    'hold-layer': 'mo', 'toggle-layer': 'tog', 'to-layer': 'to', 'one-shot-layer': 'sl',
    'smart-layer': 'smart', 'num-word': 'num',
};
const MACRO_LIKE = new Set(['macro', 'tap-dance', 'leader', 'gesture', 'adaptive']);

/** The ZMK-ish short code a layer binding is known by ('mo', 'lt', 'tog' …). */
export const layerCodeOf = (entryId) => (entryId === 'layer-tap' ? 'lt' : LAYER_CODE[entryId] ?? null);

export function legendOf(value, adapter = 'zmk-studio') {
    let d, cp;
    try { d = decode(value, adapter); cp = capParts(value, adapter); } catch { return { main: '?', sub: '', kind: 'plain', subKind: '' }; }
    const { entryId: id, params: p } = d;
    if (id === 'trans') return { main: '▽', sub: '', kind: 'dim', subKind: '' };
    if (id === 'none') return { main: '✕', sub: '', kind: 'dim', subKind: '' };
    if (id === 'key') {
        const isMod = p.key >= 0xE0 && p.key <= 0xE7;
        return { main: `${cp.top}${cp.main}`, sub: '', kind: isMod ? 'mod' : 'plain', subKind: '' };
    }
    if (id === 'mod-tap' || id === 'layer-tap') {
        const ht = holdTapParts(value, adapter);
        if (ht) return { main: ht.tap, sub: ht.hold, kind: 'hold', subKind: id === 'layer-tap' ? 'layer' : 'hold' };
    }
    if (LAYER_CODE[id]) return { main: cp.main, sub: LAYER_CODE[id], kind: 'layer', subKind: 'dim' };
    if (id === 'one-shot-mod') return { main: cp.main, sub: 'osm', kind: 'hold', subKind: 'dim' };
    if (id === 'key-toggle') return { main: cp.main, sub: 'tog', kind: 'hold', subKind: 'dim' };
    if (MACRO_LIKE.has(id)) return { main: cp.main, sub: id === 'tap-dance' ? 'tap dance' : id === 'macro' ? 'macro' : id === 'adaptive' ? 'adaptive' : '', kind: 'macro', subKind: 'dim' };
    let main = cp.main;
    // Unnamed firmware behaviours read "#28"; the catalog's `node` (e.g. fht_l) is the better name when it exists.
    if (id === 'advanced' && /^#\d+$/.test(main)) {
        const node = zmkBehaviors().get(p.raw?.behaviorId)?.node;
        if (node) main = `&${node}`;
    }
    return { main, sub: cp.top && cp.top !== cp.main ? cp.top : '', kind: 'plain', subKind: 'dim' };
}
