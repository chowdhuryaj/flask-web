// The right-hand context panel of the Keymap screen (look-shell).
//
//   nothing selected → Details, Shortcuts, and the Layers reverse index with a
//                      small lint ("NAV: activated by BASE key 52 &mo"; click
//                      jumps to and selects that key)
//   key selected     → the key inspector: TAP and HOLD boxes always visible,
//                      "Hold does" Modifiers / Layer / Key, modifier chips,
//                      the per-key timing card. Tapping a chip applies at once
//                      (one undo step); no Apply button, no popover.
//
// The inspector never advances the selection (it edits THIS key). A plain pick
// from the palette still auto-advances; that is board.assign's default.

import { el, toast } from './ui.js?v=65';
import { board } from './board.js?v=65';
import { legendOf } from './legend.js?v=65';
import { layerIndex } from './keymap-layers.js?v=65';
import { surfaceEntries } from './binding-picker.js?v=65';
import { keyTimingCard } from './zmk-holdtiming-card.js?v=65';
import { zmkBehaviors } from './zmk-keycodes.js?v=65';
import { timingBackendNow, TIMING_PARAM, HOLDTAP, decode, encode, composeTapHold, tapHoldSpecOf,
    homeRowPlan, holdTapParts, modsText } from './behavior-catalog.js?v=65';

const ADAPTER = 'zmk-studio';
const MODS = [['Ctl', '⌃', 0x01], ['Sft', '⇧', 0x02], ['Alt', '⌥', 0x04], ['Gui', '⌘', 0x08]];
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
export const SHORTCUTS = [
    [[IS_MAC ? '⌘' : 'Ctrl', 'K'], 'Command palette: jump anywhere, assign to the selected key'],
    [[IS_MAC ? '⌘' : 'Ctrl', 'Z'], 'Undo the last key assignment'],
    [[IS_MAC ? '⌘' : 'Ctrl', 'Shift', 'Z'], 'Redo'],
    [['Esc'], 'Deselect the key, disarm modifiers and any "set the tap / hold key" mode'],
    [['Del'], 'Make the selected key pass through (▽)'],
];

const mods4Of = (m = 0) => (m & 0xF) || ((m >> 4) & 0xF);

/** What a key's inspector shows, from its binding. Pure. */
export function inspectorModel(binding, adapter = ADAPTER) {
    const spec = tapHoldSpecOf(binding, adapter);
    const lg = legendOf(binding, adapter);
    let kind = 'mods', right = false, mods = 0, layer = null, holdKey = null;
    if (spec?.hold) {
        kind = spec.hold.kind;
        if (kind === 'mods') { mods = mods4Of(spec.hold.mods); right = !!(spec.hold.mods & 0xF0); }
        if (kind === 'layer') layer = spec.hold.layer;
        if (kind === 'key') holdKey = { key: spec.hold.key, mods: spec.hold.mods ?? 0 };
    }
    return { spec, legend: lg, plain: !!spec && !spec.hold, hasHold: !!spec?.hold, kind, right, mods, layer, holdKey, tap: spec?.tap ?? null };
}

export function createInspector({ app, dock }) {
    const ac = new AbortController();     // board listeners die with the inspector
    const root = el('div', { class: 'insp', 'data-view': 'default' });
    // Local UI state that is not (yet) in the binding.
    let local = { pos: null, layer: null, kind: null, right: null };
    let preset = null;                 // home-row mods sub-panel state
    let stopPick = null;
    let timing = { pos: null, el: null, live: null, token: 0 };
    let msg = '';

    const adapter = () => board.adapter;
    const sel = () => board.selectedKey();
    const layerName = (i) => adapter()?.layers().find((l) => l.index === i)?.name ?? `Layer ${i}`;
    const entries = () => surfaceEntries('zmk.key', app);
    const hasEntry = (id) => entries().some((e) => e.id === id);
    const layerChoices = () => {
        const e = entries().find((x) => x.id === 'layer-tap');
        const p = e?.params.find((x) => x.kind === 'layer');
        return (p?.options ?? []).map((id) => ({ id, name: p.labels?.[id] ?? `Layer ${id}` }));
    };

    // ---- applying ----

    /** Write a binding to the selected key as ONE undo step; stay on the key. */
    const put = (value) => board.assign(value, { advance: false });

    async function applyHold(next) {
        const m = inspectorModel(board.bindingOf());
        if (!m.tap) { msg = 'Pick the tap key first: click a key tile, or use Press a key.'; render(); return; }
        const pos = sel()?.pos;
        if (!next || (next.kind === 'mods' && !next.mods)) {
            await put(encode('key', { key: m.tap.key, mods: m.tap.mods ?? 0 }, ADAPTER));
            return;
        }
        const hold = next.kind === 'mods' ? { kind: 'mods', mods: next.right ? next.mods << 4 : next.mods }
            : next.kind === 'layer' ? { kind: 'layer', layer: next.layer } : { kind: 'key', key: next.key, mods: next.mods ?? 0 };
        const r = composeTapHold({ tap: m.tap, hold, hand: board.handOf(pos), timing: m.spec?.timing ?? TIMING_PARAM.default }, ADAPTER);
        if (!r.ok) { msg = r.message; render(); return; }
        msg = '';
        await put(r.value);
    }

    async function setTap(k) {
        const m = inspectorModel(board.bindingOf());
        const tap = { key: k.key, mods: k.mods ?? 0 };
        if (m.hasHold) {
            const hold = m.kind === 'mods' ? { kind: 'mods', mods: m.right ? m.mods << 4 : m.mods }
                : m.kind === 'layer' ? { kind: 'layer', layer: m.layer } : { kind: 'key', ...m.holdKey };
            const r = composeTapHold({ tap, hold, hand: board.handOf(sel()?.pos), timing: m.spec?.timing }, ADAPTER);
            if (r.ok) { await put(r.value); return; }
        }
        await put(encode('key', { key: tap.key, mods: tap.mods }, ADAPTER));
    }

    const sideNow = (m) => (local.right ?? (m.hasHold && m.kind === 'mods' ? m.right : board.handOf(sel()?.pos) === 'right'));
    const kindNow = (m) => (m.hasHold ? m.kind : local.kind ?? 'mods');

    function toggleMod(bit) {
        const m = inspectorModel(board.bindingOf());
        const right = sideNow(m);
        const cur = m.hasHold && m.kind === 'mods' ? m.mods : 0;
        applyHold({ kind: 'mods', mods: cur ^ bit, right });
    }

    function toggleSide(right) {
        const m = inspectorModel(board.bindingOf());
        if (m.hasHold && m.kind === 'mods' && m.mods) applyHold({ kind: 'mods', mods: m.mods, right });
        else { local.right = right; render(); }
    }

    function armTarget(which) {
        if (dock.target?.which === which) { dock.setTarget(null); render(); return; }
        dock.setTarget({
            which, label: which === 'tap' ? 'TAP key of this key' : 'HOLD key of this key',
            set: async (k) => { dock.setTarget(null); if (which === 'tap') await setTap(k); else await applyHold({ kind: 'key', key: k.key, mods: k.mods }); },
        });
        render();
    }

    // ---- key inspector ----

    function slotBox(which, label, text, sub, tone, on, onclick, disabled) {
        return el('button', { class: `slot s-${which}${on ? ' on' : ''}${text ? '' : ' empty'}${tone ? ' t-' + tone : ''}`, type: 'button',
            'data-slot': which, 'aria-pressed': String(on), disabled,
            'data-caption': which === 'tap' ? 'TAP: what a quick press types. Click, then pick a key tile or press it, to change it.'
                : 'HOLD: what the key does while held. Pick modifiers, a layer or a key below.',
            onclick },
        el('span', { class: 'slot-lbl', text: label }),
        el('span', { class: 'slot-val', text: text || '—' }),
        el('span', { class: 'slot-sub mono', text: sub }));
    }

    function holdText(m) {
        if (!m.hasHold) return '';
        if (m.kind === 'mods') return modsText(m.right ? m.mods << 4 : m.mods);
        if (m.kind === 'layer') return layerChoices().find((c) => c.id === m.layer)?.name ?? `Layer ${m.layer}`;
        return holdTapParts(board.bindingOf(), ADAPTER)?.hold ?? '';
    }

    function keyPanel(s) {
        const b = board.bindingOf();
        const m = inspectorModel(b);
        const lg = m.legend;
        const kind = kindNow(m), right = sideNow(m);
        const layerNameNow = layerName(s.layer);
        const tapKnown = !!m.tap;
        const head = el('header', { class: 'insp-head' },
            el('span', { class: `insp-cap k-${lg.kind}` }, el('b', { text: lg.main }), lg.sub ? el('i', { class: 'mono', text: lg.sub }) : null),
            el('div', { class: 'insp-title' }, el('strong', { text: `Key ${s.pos}` }), el('span', { class: 'mono', text: layerNameNow })),
            el('button', { class: 'btn small ghost', type: 'button', text: 'Done', 'aria-label': 'Deselect the key',
                onclick: () => board.select(null) }));

        const tapLg = tapKnown ? legendOf(encode('key', { key: m.tap.key, mods: m.tap.mods ?? 0 }, ADAPTER), ADAPTER) : lg;
        const slots = el('div', { class: 'insp-slots' },
            slotBox('tap', 'TAP', tapKnown ? tapLg.main : lg.main, tapKnown ? 'quick press' : 'not a plain key', tapKnown ? '' : lg.kind === 'plain' ? '' : lg.kind,
                dock.target?.which === 'tap', () => armTarget('tap')),
            el('span', { class: 'slot-plus', 'aria-hidden': 'true', text: '+' }),
            slotBox('hold', 'HOLD', holdText(m), 'long press', m.hasHold ? (m.kind === 'layer' ? 'layer' : 'hold') : '',
                dock.target?.which === 'hold', () => { if (kind === 'key') armTarget('hold'); else root.querySelector('.insp-hold')?.scrollIntoView({ block: 'nearest' }); }));

        const kinds = [];
        if (hasEntry('mod-tap')) kinds.push(['mods', 'Modifiers']);
        if (hasEntry('layer-tap')) kinds.push(['layer', 'Layer']);
        if (hasEntry('mod-tap')) kinds.push(['key', 'Key']);
        const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Hold does' },
            ...kinds.map(([k, label]) => el('button', { class: kind === k ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(kind === k), text: label, 'data-kind': k,
                onclick: () => { local.kind = k; if (k !== 'key') dock.setTarget(null); render(); } })));

        let pane;
        if (kind === 'mods') {
            const on = m.hasHold && m.kind === 'mods' ? m.mods : 0;
            pane = el('div', { class: 'insp-mods' },
                el('div', { class: 'chips', role: 'group', 'aria-label': 'Hold modifiers' },
                    ...MODS.map(([n, g, bit]) => el('button', { class: 'chip big' + (on & bit ? ' on' : ''), type: 'button', 'aria-pressed': String(!!(on & bit)),
                        'data-mod': n, disabled: !tapKnown, title: tapKnown ? '' : 'Pick the tap key first',
                        'data-caption': `Hold ${n}${right ? ' (right-hand)' : ''}: applies right away, one undo step.`,
                        onclick: () => toggleMod(bit) }, el('span', { class: 'g', text: g }), n))),
                el('div', { class: 'seg small', role: 'radiogroup', 'aria-label': 'Side' },
                    ...[['L', false, 'Left'], ['R', true, 'Right']].map(([t, v, n]) => el('button', { class: right === v ? 'on' : '', type: 'button', role: 'radio',
                        'aria-checked': String(right === v), 'data-side': t, text: n, 'data-caption': `${n}-hand modifiers.`, onclick: () => toggleSide(v) }))));
        } else if (kind === 'layer') {
            pane = el('div', { class: 'chips layers', role: 'group', 'aria-label': 'Hold layer' },
                ...layerChoices().map((c) => el('button', { class: 'chip big' + (m.kind === 'layer' && m.layer === c.id ? ' on' : ''), type: 'button',
                    'data-layer': c.id, disabled: !tapKnown, text: c.name, 'data-caption': `Hold for ${c.name}. Applies right away.`,
                    onclick: () => applyHold({ kind: 'layer', layer: c.id }) })));
        } else {
            pane = el('div', { class: 'insp-holdkey' },
                el('p', { class: 'hint', text: m.holdKey ? 'Click the HOLD box, then a key tile, to change it.' : 'Click the HOLD box, then a key tile (or Press a key) for the key to hold.' }),
                el('button', { class: 'btn small' + (dock.target?.which === 'hold' ? ' primary' : ''), type: 'button', text: dock.target?.which === 'hold' ? 'Waiting for a key…' : 'Pick the hold key',
                    disabled: !tapKnown, onclick: () => armTarget('hold') }));
        }
        const holdBlock = el('div', { class: 'insp-hold' }, el('div', { class: 'insp-row' }, el('span', { class: 'insp-lbl', text: 'Hold does' }), seg), pane,
            tapKnown ? null : el('p', { class: 'hint', text: 'This key is not a plain key. Pick the tap key first: a key tile, or Press a key.' }),
            msg ? el('p', { class: 'hint warn', role: 'status', text: msg }) : null);

        const kids = [head, slots, holdBlock];
        if (m.hasHold) kids.push(timingHost(s.pos, b));
        else timing = { pos: null, el: null, live: null, token: timing.token };
        const quick = el('div', { class: 'insp-actions' },
            el('button', { class: 'btn small', type: 'button', text: '▽ Pass through', 'data-caption': 'Use the key from the layer below.', onclick: () => put(encode('trans', {}, ADAPTER)) }),
            el('button', { class: 'btn small', type: 'button', text: '✕ Nothing', 'data-caption': 'Does nothing.', onclick: () => put(encode('none', {}, ADAPTER)) }),
            hasEntry('mod-tap') ? el('button', { class: 'btn small', type: 'button', text: 'Home-row mods…', 'data-act': 'hrm',
                'data-caption': 'Make the 8 home keys tap-holds with modifiers in one step.', onclick: () => startPreset() }) : null);
        kids.push(quick, el('p', { class: 'insp-src mono', 'data-caption': 'The raw binding.', text: source(b) }));
        return kids;
    }

    function source(b) {
        if (!b) return '';
        const name = zmkBehaviors().get(b.behaviorId)?.displayName ?? `behavior #${b.behaviorId}`;
        const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase()}`;
        return `${name} · ${hex(b.param1)} · ${hex(b.param2)}`;
    }

    /** One timing card per selected key, reused across chip taps. */
    function timingHost(pos, b) {
        const be = timingBackendNow();
        const live = decode(b, ADAPTER).params.live;
        const isLive = !!(be.runtime && live && live !== 'off');
        const fixed = live === 'fixed';   // virtual-slot node: no key position, so no same-hand rule
        if (timing.pos === pos && timing.el && timing.live === isLive && timing.fixed === fixed) return timing.el;
        const host = el('div', { class: 'ht-host' });
        timing = { pos, el: host, live: isLive, fixed, token: timing.token + 1 };
        const token = timing.token;
        if (!isLive) {
            host.append(el('p', { class: 'hint', text: be.runtime
                ? 'This hold-tap has its timing compiled into the keymap.'
                : `Timing is compiled into the keymap. Per-key timing needs firmware protocol ${HOLDTAP.minProto}.` }));
            return host;
        }
        host.append(el('p', { class: 'hint', text: 'Reading this key’s timing…' }));
        keyTimingCard(app, pos, { positional: !fixed }).then((card) => {
            if (token !== timing.token) return;
            host.replaceChildren(card ?? el('p', { class: 'hint', text: 'This keyboard has no live hold-tap timing.' }));
        }).catch((e) => { if (token === timing.token) host.replaceChildren(el('p', { class: 'hint warn', text: `Timing unavailable: ${e.message}` })); });
        return host;
    }

    // ---- home-row mods preset (was the picker's second composer view) ----

    const QWERTY = [0x04, 0x16, 0x07, 0x09, 0x0D, 0x0E, 0x0F, 0x33];
    const COLEMAK = [0x04, 0x15, 0x16, 0x17, 0x11, 0x08, 0x0C, 0x12];
    function guessHome() {
        const all = board.positions();
        for (const want of [QWERTY, COLEMAK]) {
            const got = want.map((k) => all.find((p) => { const s = tapHoldSpecOf(p.binding, ADAPTER); return s?.tap?.key === k && !s.tap.mods; })?.pos);
            if (got.every((p) => p != null)) return got;
        }
        return [];
    }
    function startPreset() {
        stopPick?.();
        dock.setTarget(null);
        preset = { order: 'GACS', timing: 280, picked: guessHome() };
        stopPick = board.pickPositions({ initial: preset.picked, max: 8, label: 'Home-row mods: click the 8 home keys',
            onChange: (p) => { if (preset) { preset.picked = p; render(); } } });
        render();
    }
    function endPreset() { stopPick?.(); stopPick = null; preset = null; render(); }

    function presetPanel() {
        const be = timingBackendNow();
        const keys = board.positions().filter((p) => preset.picked.some((q) => JSON.stringify(q) === JSON.stringify(p.pos)));
        const plan = homeRowPlan(keys, preset.order, ADAPTER, { timing: preset.timing });
        const ORDERS = { GACS: '⌘ ⌥ ⌃ ⇧', CAGS: '⌃ ⌥ ⌘ ⇧' };
        const kids = [
            el('header', { class: 'insp-head' }, el('div', { class: 'insp-title' }, el('strong', { text: 'Home-row mods' }),
                el('span', { class: 'hint', text: 'Each home key keeps its letter as TAP and holds a modifier, pinky to index, mirrored on the right hand.' }))),
            el('div', { class: 'insp-row' }, el('span', { class: 'insp-lbl', text: 'Order' }),
                el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Order' }, ...Object.entries(ORDERS).map(([o, g]) => el('button', {
                    class: preset.order === o ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(preset.order === o), 'data-order': o, text: `${o} · ${g}`,
                    onclick: () => { preset.order = o; render(); } })))),
        ];
        if (be.runtime) {
            const val = el('output', { class: 'ht-term mono', text: `${preset.timing} ms` });
            const slider = el('input', { type: 'range', min: TIMING_PARAM.min, max: TIMING_PARAM.max, step: TIMING_PARAM.step, value: preset.timing, 'aria-label': 'Shared tapping term for the 8 keys' });
            slider.addEventListener('input', () => { preset.timing = Number(slider.value); val.textContent = `${preset.timing} ms`; });
            kids.push(el('div', { class: 'insp-row' }, el('span', { class: 'insp-lbl', text: 'Tapping term (all 8)' }), el('div', { class: 'ht-term-row' }, slider, val)));
        }
        kids.push(el('p', { class: 'hint' + (plan.ok ? '' : ' warn'), role: 'status',
            text: plan.ok ? plan.plan.map((p) => { const h = holdTapParts(p.value, ADAPTER); return `${h.tap}=${h.hold}`; }).join('  ')
                : `${preset.picked.length} of 8 keys picked on the board. ${preset.picked.length === 8 ? plan.message : ''}` }),
        el('div', { class: 'insp-actions' },
            el('button', { class: 'btn small primary', type: 'button', text: 'Apply to 8 keys', 'data-act': 'hrm-apply', disabled: !plan.ok,
                onclick: async () => {
                    stopPick?.(); stopPick = null;
                    const done = await board.assignMany(plan.plan.map((p) => ({ pos: p.pos, value: p.value })));
                    if (done && be.runtime) {
                        for (const p of plan.plan) {
                            const lv = decode(p.value, ADAPTER).params;
                            if (!lv.live || lv.live === 'off' || lv.live === 'fixed' || lv.variant != null) continue;
                            try { await be.write(p.pos, preset.timing); } catch (err) { toast(`Timing not written: ${err.message}`, true); }
                        }
                    }
                    preset = null;
                    toast(done ? 'Home-row mods applied. One undo reverts all 8.' : 'Some keys were not written.', !done);
                    render();
                } }),
            el('button', { class: 'btn small', type: 'button', text: 'Cancel', 'data-act': 'hrm-cancel', onclick: endPreset })));
        return kids;
    }

    // ---- default panel: details, shortcuts, layers ----

    /** Combos whose output turns a layer on: the offline workspace's table, or
     * the Combos tab's slots once it has loaded. Typed outputs (action 3 = a
     * behavior) become Studio bindings. */
    function combosNow() {
        const slots = app.offlineWs?.zmk?.combos ?? app.tabInstance?.('zmk-combos')?.slots ?? [];
        return slots.filter((c) => c?.action === 3 && c.positions?.length >= 2)
            .map((c) => ({ positions: c.positions, binding: { behaviorId: c.behaviorId, param1: c.param1 >>> 0, param2: c.param2 >>> 0 } }));
    }

    function layersCard() {
        const a = adapter();
        const idx = layerIndex({ layers: a.layers(), keys: a.profile.keys, bindingAt: (l, s) => a.bindingAt(l, s), combos: combosNow(), adapter: ADAPTER });
        const rows = idx.rows.filter((r) => r.always || r.activators.length || !a.layers()[r.index].empty);
        return el('section', { class: 'insp-card', 'data-card': 'layers' },
            el('h4', {}, 'Layers', el('span', { class: 'sub', text: 'what turns each layer on' })),
            idx.problems.length
                ? el('ul', { class: 'lint warn' }, ...idx.problems.map((p) => el('li', { 'data-problem': p.index, text: p.message })),
                    idx.unnamed ? el('li', { class: 'note', text: `${idx.unnamed} keys use firmware behaviours with no name, which Flask cannot read; one of them may do it.` }) : null)
                : el('p', { class: 'lint ok', text: 'No layer problems found.' }),
            ...rows.map((r) => el('div', { class: 'lyr', 'data-layer': r.index },
                el('button', { class: 'lyr-name', type: 'button', text: r.name, onclick: () => board.setLayer(r.index) }),
                r.always ? el('span', { class: 'lyr-always', text: 'Always on' })
                    : r.activators.length ? el('span', { class: 'lyr-acts' }, ...r.activators.map((x) => (x.combo ? el('button', {
                        class: 'lyr-chip mono', type: 'button', 'data-combo': x.positions.join('+'),
                        'data-caption': 'A combo turns this layer on. Open the Combos screen.',
                        onclick: () => app.showTab?.('zmk-combos'),
                    }, `combo ${x.positions.join('+')} `, el('b', { text: `&${x.code}` })) : el('button', {
                        class: 'lyr-chip mono', type: 'button', 'data-pos': x.pos, 'data-from': x.layer,
                        'data-caption': `Go to key ${x.pos} on ${x.layerName} and select it`,
                        onclick: () => board.jumpTo(x.layer, x.pos),
                    }, `${x.layerName} key ${x.pos} `, el('b', { text: `&${x.code}` })))))
                        : el('span', { class: 'lyr-none', text: 'Nothing turns this on' }))));
    }

    function defaultPanel() {
        return [
            el('section', { class: 'insp-card' }, el('h4', { text: 'Details' }),
                el('p', { class: 'hint', text: 'Select a key to edit it, or drag a tile from the palette onto a key. Double-click a layer to rename it.' })),
            el('section', { class: 'insp-card', 'data-card': 'shortcuts' }, el('h4', { text: 'Shortcuts' }),
                ...SHORTCUTS.map(([keys, what]) => el('div', { class: 'sc' },
                    el('span', { class: 'sc-keys' }, ...keys.map((k) => el('kbd', { text: k }))), el('span', { class: 'sc-what', text: what })))),
            layersCard(),
        ];
    }

    // ---- render ----

    function render() {
        if (!adapter()) { root.replaceChildren(); return; }
        const s = sel();
        const key = s ? `${s.layer}:${s.pos}` : null;
        if (key !== local.key) {
            local = { key, pos: s?.pos ?? null, layer: s?.layer ?? null, kind: null, right: null };
            msg = '';
            dock.setTarget(null);
        }
        if (preset) { root.dataset.view = 'preset'; root.replaceChildren(...presetPanel()); return; }
        if (!s) { root.dataset.view = 'default'; timing = { pos: null, el: null, live: null, token: timing.token }; root.replaceChildren(...defaultPanel()); return; }
        root.dataset.view = 'key';
        root.replaceChildren(...keyPanel(s));
    }

    for (const ev of ['select', 'change', 'layer', 'history']) board.addEventListener(ev, render, { signal: ac.signal });
    // An edit changes what the bindings are; the timing card is per key, keep it,
    // but a new key or a layer jump clears it (render() resets via local.key).
    board.addEventListener('select', () => { if (timing.pos !== sel()?.pos) timing = { pos: null, el: null, live: null, token: timing.token }; }, { signal: ac.signal });

    return {
        root, render,
        /** Esc: leave the preset, then the armed target, then the selection. */
        escape() {
            if (preset) { endPreset(); return true; }
            if (dock.target) { dock.setTarget(null); render(); return true; }
            if (dock.armedMods()) { dock.clearMods(); return true; }
            if (sel()) { board.select(null); return true; }
            return false;
        },
        stop() { stopPick?.(); },
        dispose() { stopPick?.(); ac.abort(); },
    };
}
