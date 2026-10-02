// Legacy ZMK binding picker, moved verbatim out of zmk-keymap-tab.js (WP0).
// WP3 replaces it with binding-picker.js and deletes this file (WP7).
// Callers keep importing buildZmkPicker from zmk-keymap-tab.js, which
// re-exports it, so no other file changed.

import { el, toast } from './ui.js?v=49';
import { basicKeys, navKeys, fKeys, numpadKeys, intlKeys } from './keycodes.js?v=49';
import {
    consumerUsages, kpParam, cpParam, zmkBehaviors, zmkLayers, usageCap, usageLabel,
} from './zmk-keycodes.js?v=49';
// Circular with zmk-combos-tab (it imports buildZmkPicker via
// zmk-keymap-tab) — safe: both sides export hoisted declarations and
// neither calls the other at module-eval time.
import { pickUsage, MODS } from './zmk-combos-tab.js?v=49';

// ---------------------------------------------------------------------------
// ZMK binding picker — same DOM shape/CSS as the QMK picker (.picker/.cats/
// .codes/.composer), but emits {behaviorId, param1, param2} objects and
// drives composers from device behavior METADATA instead of QMK bit math.

const USAGE_CATEGORIES = [
    { id: 'basic', label: 'Basic', keys: basicKeys, toParam: kpParam },
    { id: 'nav', label: 'Nav', keys: navKeys, toParam: kpParam },
    { id: 'fkeys', label: 'F-keys', keys: fKeys, toParam: kpParam },
    { id: 'numpad', label: 'Numpad', keys: numpadKeys, toParam: kpParam },
    { id: 'intl', label: 'Intl', keys: intlKeys, toParam: kpParam },
    { id: 'media', label: 'Media', keys: consumerUsages, toParam: cpParam },
];

export function buildZmkPicker({ keyPressId, onPick }) {
    const behaviors = zmkBehaviors();
    let category = keyPressId != null ? 'basic' : 'behaviors';
    let query = '';
    // Sticky implicit-modifier chips (Vial parity): while set, every usage
    // pick wraps in these mods (ZMK LS()/LC()… bits at >= bit 24).
    let pickMods = 0;

    const root = el('div', { class: 'picker' });
    const cats = el('div', { class: 'cats' });
    const search = el('input', { type: 'search', placeholder: 'Search keys…' });
    const codes = el('div', { class: 'codes' });

    search.addEventListener('input', () => { query = search.value.toLowerCase(); renderCodes(); });

    const byName = (name) =>
        [...behaviors.values()].find((d) => d.displayName === name) ?? null;

    const descsOf = (d, which) => d.metadata?.[0]?.[which] ?? [];
    const hasKind = (d, which, kind) => descsOf(d, which).some((x) => x.kind === kind);

    // Layer-parameter behaviors (MO/TO/TG/SL… discovered by metadata shape).
    const layerBehaviors = [...behaviors.values()].filter((d) => hasKind(d, 'param1', 'layer_id'));

    // Tap-hold behaviors (Mod-Tap, Smart Mod…) by shape: a hold usage in
    // param1 AND a tap usage in param2. Mod-Tap sorts first (the plain one).
    const tapHoldBehaviors = [...behaviors.values()]
        .filter((d) => d.displayName
            && hasKind(d, 'param1', 'hid_usage') && hasKind(d, 'param2', 'hid_usage'))
        .sort((a, b) => (a.displayName.startsWith('Mod-Tap') ? -1 : 1)
            - (b.displayName.startsWith('Mod-Tap') ? -1 : 1)
            || a.displayName.localeCompare(b.displayName));

    // Flask Macro slots as first-class picker chips (AJ's ask, bench
    // 2026-07-11): "Macros" category assigns &fmac <slot> in one click.
    // The slot count rides the behavior's own range metadata.
    const macroBehavior = byName('Flask Macro');
    const macroRange = macroBehavior?.metadata?.[0]?.param1?.find((x) => x.kind === 'range');

    // Tap Dance slots the same way (v14): "Tap dance" category assigns
    // &ftd <slot> in one click; edit the dances in the Tap Dance tab.
    const tdBehavior = byName('Tap Dance');
    const tdRange = tdBehavior?.metadata?.[0]?.param1?.find((x) => x.kind === 'range');

    function renderCats() {
        const chips = [];
        if (keyPressId != null) {
            chips.push(...USAGE_CATEGORIES.map((c) => ({ id: c.id, label: c.label })));
        }
        if (keyPressId != null && tapHoldBehaviors.length) {
            chips.push({ id: 'taphold', label: 'Tap-hold' });
        }
        if (layerBehaviors.length) chips.push({ id: 'layers', label: 'Layers' });
        if (macroBehavior && macroRange) chips.push({ id: 'macros', label: 'Macros' });
        if (tdBehavior && tdRange) chips.push({ id: 'tapdance', label: 'Tap dance' });
        chips.push({ id: 'behaviors', label: 'Behaviors' });
        cats.replaceChildren(...chips.map((c) => el('button', {
            class: c.id === category ? 'active' : '',
            text: c.label,
            onclick: () => { category = c.id; renderCats(); renderCodes(); },
        })));
    }

    const withMods = (param) => ((pickMods << 24) | param) >>> 0;

    function usageButton(key, toParam) {
        return el('button', {
            class: 'code', title: key.label,
            onclick: () => onPick({ behaviorId: keyPressId, param1: withMods(toParam(key.code)), param2: 0 }),
        }, key.cap || '·', el('span', { class: 'full', text: key.label }));
    }

    /** Modifier chip row for the usage categories: toggled mods wrap every
     * key pick (LS(A) in one click — the Vial checkbox flow). */
    function modChipsRow() {
        const row = el('div', {
            class: 'composer',
            style: 'display:flex; gap:4px; align-items:center; flex-wrap:wrap',
        }, el('span', { class: 'note faint', text: 'held with the key:' }));
        for (const m of MODS) {
            const btn = el('button', {
                class: 'btn small' + ((pickMods & m.bit) ? ' primary' : ''),
                text: `${m.glyph} ${m.label}`,
                title: `wrap picks in left ${m.label} (ZMK implicit modifier)`,
                onclick: () => {
                    pickMods ^= m.bit;
                    btn.classList.toggle('primary', !!(pickMods & m.bit));
                },
            });
            row.append(btn);
        }
        return row;
    }

    function specialButtons() {
        const out = [];
        for (const name of ['Transparent', 'None']) {
            const d = byName(name);
            if (d) {
                out.push(el('button', {
                    class: 'code', title: name,
                    onclick: () => onPick({ behaviorId: d.id, param1: 0, param2: 0 }),
                }, name === 'Transparent' ? '▽' : '∅', el('span', { class: 'full', text: name })));
            }
        }
        return out;
    }

    function renderCodes() {
        root.querySelector('.composer')?.remove();
        codes.replaceChildren();
        if (query && keyPressId != null) {
            codes.append(modChipsRow());
            const hits = USAGE_CATEGORIES.flatMap((c) =>
                c.keys.filter((k) => k.label.toLowerCase().includes(query)
                    || k.cap.toLowerCase().includes(query))
                    .map((k) => usageButton(k, c.toParam)));
            codes.append(...hits);
            return;
        }
        if (category === 'taphold') { renderTapHoldComposer(); return; }
        if (category === 'layers') { renderLayerComposer(); return; }
        if (category === 'macros') { renderMacroChips(); return; }
        if (category === 'tapdance') { renderTapDanceChips(); return; }
        if (category === 'behaviors') { renderBehaviorComposer(); return; }
        const cat = USAGE_CATEGORIES.find((c) => c.id === category);
        if (!cat) return;
        codes.append(modChipsRow());
        codes.append(...cat.keys.map((k) => usageButton(k, cat.toParam)));
        if (category === 'basic') codes.append(...specialButtons());
    }

    /** Tap-hold composer (Vial MT parity): hold = a modifier chip or any
     * key, tap = any key; behavior list is shape-driven (Mod-Tap, Smart
     * Mod…). Core Mod-Tap carries none of the home-row gates, so holds
     * always work — the GUI answer to "my tap-hold hold does nothing". */
    function renderTapHoldComposer() {
        let holdUsage = 0;
        let tapUsage = 0;

        const bhvSel = el('select', {}, ...tapHoldBehaviors.map((d) =>
            el('option', { value: d.id, text: d.displayName })));

        // Timing chips (v14, AJ's "behavior modification settings" ask):
        // core hold-tap params are const devicetree, so timing choices are
        // precompiled Mod-Tap variants — the chips just flip the behavior
        // dropdown between them (Fast 150 / Standard 200 / Slow 300).
        const mtVariants = tapHoldBehaviors.filter((d) => /^Mod-Tap/.test(d.displayName));
        const timingRow = mtVariants.length > 1
            ? el('div', { style: 'display:flex; gap:4px; align-items:center; flex-wrap:wrap' },
                el('span', { class: 'note faint', text: 'timing:' }),
                ...mtVariants.map((d) => {
                    const m = d.displayName.match(/\((\w+) (\d+)\)/);
                    const label = m ? `${m[1]} ${m[2]}` : 'standard 200';
                    return el('button', {
                        class: 'btn small', text: label,
                        title: `${d.displayName} — tapping term ${m ? m[2] : 200} ms (a compiled variant; core hold-tap timing is fixed at build)`,
                        onclick: () => { bhvSel.value = d.id; },
                    });
                }))
            : null;

        const holdBtn = el('button', { class: 'code', text: 'hold…' });
        const tapBtn = el('button', { class: 'code', text: 'tap…' });
        const refresh = () => {
            holdBtn.textContent = holdUsage ? usageCap(holdUsage) : 'hold…';
            holdBtn.title = holdUsage ? usageLabel(holdUsage) : 'what holding does';
            tapBtn.textContent = tapUsage ? usageCap(tapUsage) : 'tap…';
            tapBtn.title = tapUsage ? usageLabel(tapUsage) : 'what tapping types';
        };

        // Quick chips: the 8 bare modifiers straight into HOLD (the common
        // case); "any key…" opens the full picker for both slots.
        const modChip = (id, cap, label) => el('button', {
            class: 'btn small', text: cap, title: `hold = ${label}`,
            onclick: () => { holdUsage = kpParam(id); refresh(); },
        });
        const holdChips = el('div', { style: 'display:flex; gap:4px; flex-wrap:wrap' },
            modChip(0xE0, '⌃', 'Left Ctrl'), modChip(0xE1, '⇧', 'Left Shift'),
            modChip(0xE2, '⌥', 'Left Alt'), modChip(0xE3, '⌘', 'Left GUI'),
            modChip(0xE4, 'R⌃', 'Right Ctrl'), modChip(0xE5, 'R⇧', 'Right Shift'),
            modChip(0xE6, 'R⌥', 'Right Alt'), modChip(0xE7, 'R⌘', 'Right GUI'));

        holdBtn.addEventListener('click', () => {
            pickUsage('Tap-hold — hold', holdUsage, (u) => { holdUsage = u >>> 0; refresh(); });
        });
        tapBtn.addEventListener('click', () => {
            pickUsage('Tap-hold — tap', tapUsage, (u) => { tapUsage = u >>> 0; refresh(); });
        });

        const assign = el('button', {
            class: 'code', text: 'Assign',
            onclick: () => {
                if (!holdUsage || !tapUsage) { toast('Pick both a hold and a tap first', true); return; }
                onPick({ behaviorId: Number(bhvSel.value), param1: holdUsage, param2: tapUsage });
            },
        });

        refresh();
        codes.append(el('div', { class: 'composer', style: 'display:flex; flex-direction:column; gap:6px; align-items:flex-start' },
            el('div', { style: 'display:flex; gap:6px; align-items:center; flex-wrap:wrap' },
                el('label', { text: 'Behavior:' }), bhvSel,
                el('label', { text: 'Hold:' }), holdBtn,
                el('label', { text: 'Tap:' }), tapBtn,
                assign),
            holdChips,
            timingRow,
            el('div', { class: 'note faint',
                text: 'Hold past the tapping term = the hold key; quick press = the tap key. The compiled home-row mods (HM_*) gate holds on idle/cross-hand by design — this composes the ungated core behavior. Timing picks a compiled variant (Layer-Tap variants live under Layers).' })));
    }

    /** Tap Dance slot chips (v14): assign &ftd <slot> in one click — the
     * dances themselves are edited in the Tap Dance tab. */
    function renderTapDanceChips() {
        const max = Math.min(tdRange.max, 63);
        codes.append(el('div', { class: 'note faint',
            text: 'Assign a runtime tap dance (build them in the Tap Dance tab — 🪄 New tap dance).' }));
        for (let slot = tdRange.min; slot <= max; slot++) {
            codes.append(el('button', {
                class: 'code', title: `Tap dance slot ${slot} (&ftd ${slot})`,
                onclick: () => onPick({ behaviorId: tdBehavior.id, param1: slot, param2: 0 }),
            }, `TD${slot}`, el('span', { class: 'full', text: `Tap dance ${slot}` })));
        }
    }

    function layerSelect() {
        return el('select', {}, ...zmkLayers().map((l) =>
            el('option', { value: l.id, text: l.name || `Layer#${l.id}` })));
    }

    function renderLayerComposer() {
        const sel = layerSelect();
        const rows = [el('label', { text: 'Layer:' }), sel];
        for (const d of layerBehaviors) {
            const p2 = d.metadata?.[0]?.param2 ?? [];
            const wantsKey = p2.some((x) => x.kind === 'hid_usage');
            // smart_layer shape: the layer goes in BOTH params (hold =
            // sticky layer, tap = toggle).
            const wantsLayer2 = p2.some((x) => x.kind === 'layer_id');
            if (!wantsKey) {
                rows.push(el('button', {
                    class: 'code', title: d.displayName,
                    onclick: () => onPick({ behaviorId: d.id, param1: Number(sel.value),
                        param2: wantsLayer2 ? Number(sel.value) : 0 }),
                }, d.displayName));
            } else {
                // &lt-style: layer + tap key, via the keycap picker.
                let tapUsage = 0;
                const tapBtn = el('button', { class: 'code', text: 'tap key…' });
                tapBtn.addEventListener('click', () => {
                    pickUsage(`${d.displayName} — tap key`, tapUsage, (u) => {
                        tapUsage = u >>> 0;
                        tapBtn.textContent = tapUsage ? usageCap(tapUsage) : 'tap key…';
                        tapBtn.title = tapUsage ? usageLabel(tapUsage) : '';
                    });
                });
                rows.push(el('button', {
                    class: 'code', title: `${d.displayName}: hold for the layer, tap for the key`,
                    onclick: () => {
                        if (!tapUsage) { toast('Pick a tap key first', true); return; }
                        onPick({ behaviorId: d.id, param1: Number(sel.value), param2: tapUsage });
                    },
                }, d.displayName), tapBtn);
            }
        }
        codes.append(el('div', { class: 'composer' }, ...rows));
    }

    function renderMacroChips() {
        const max = Math.min(macroRange.max, 63);
        codes.append(el('div', { class: 'note faint',
            text: 'Play a runtime macro slot (edit the slots in the Macros tab).' }));
        for (let slot = macroRange.min; slot <= max; slot++) {
            codes.append(el('button', {
                class: 'code', title: `Play runtime macro slot ${slot} (&fmac ${slot})`,
                onclick: () => onPick({ behaviorId: macroBehavior.id, param1: slot, param2: 0 }),
            }, `M${slot}`, el('span', { class: 'full', text: `Macro ${slot}` })));
        }
    }

    function renderBehaviorComposer() {
        // Universal fallback: every ASSIGNABLE device behavior, params driven
        // by its metadata descriptors — zero curation needed. Behaviors with
        // no display name ship no Studio metadata (urob's &leader) and the
        // firmware rejects assigning them with INVALID PARAMETERS no matter
        // the params — worse, the blank name sorted FIRST and became the
        // dropdown's default selection (bench 5's "leader still fails").
        //
        // Grouped since 2026-07-12 ("reconcile the behaviors selection"):
        // one flat alphabetical list interleaved Flask modules, layer ops
        // and system keys — the dropdown now buckets by what the behavior
        // IS (shape first, then well-known names), same order every device.
        const all = [...behaviors.values()];
        // Dedupe by display name (2026-07-12, "reconcile the duplicates"):
        // a keymap can compile several instances that Studio reports under
        // the SAME name (identical variants, re-included nodes) — two
        // "Mod-Tap" rows assign identically, so only the first (lowest id)
        // is listed. DIFFERENT behaviors keep distinct display-names by
        // convention (the timing variants carry theirs in parentheses).
        const seen = new Set();
        const list = all.filter((d) => {
            if (!d.displayName || seen.has(d.displayName)) return false;
            seen.add(d.displayName);
            return true;
        }).sort((a, b) => a.displayName.localeCompare(b.displayName));
        const hidden = all.length - list.length;

        const SYSTEM_NAMES = new Set(['Reset', 'Bootloader', 'Output Selection',
            'Bluetooth', 'External Power', 'Studio Unlock', 'Soft Off',
            'RGB Underglow', 'Backlight']);
        const groupOf = (d) => {
            if (/^Flask /.test(d.displayName) || d.displayName === 'Ball Swap') return 'Flask modules';
            if (hasKind(d, 'param1', 'layer_id') || hasKind(d, 'param2', 'layer_id')) return 'Layers';
            if (/Mouse/.test(d.displayName)) return 'Mouse';
            if (SYSTEM_NAMES.has(d.displayName)) return 'System';
            if (hasKind(d, 'param1', 'hid_usage') || hasKind(d, 'param2', 'hid_usage')
                || /Key|Caps|Swapper|Sticky/.test(d.displayName)) return 'Keys & mods';
            return 'Other';
        };
        const GROUP_ORDER = ['Keys & mods', 'Layers', 'Mouse', 'Flask modules', 'System', 'Other'];
        const grouped = new Map(GROUP_ORDER.map((gr) => [gr, []]));
        for (const d of list) grouped.get(groupOf(d)).push(d);
        const bhvSel = el('select', {}, ...GROUP_ORDER
            .filter((gr) => grouped.get(gr).length)
            .map((gr) => el('optgroup', { label: gr }, ...grouped.get(gr).map((d) =>
                el('option', { value: d.id, text: d.displayName })))));
        const paramsBox = el('span', {});
        const assign = el('button', { class: 'code', text: 'Assign' });
        let readParams = () => [0, 0];

        function buildParamEditors() {
            const d = behaviors.get(Number(bhvSel.value));
            // Layer-in-BOTH-params shape (smart_layer: hold = sticky layer,
            // tap = toggle — the hold-tap needs the layer twice): one picker
            // fills both params. Shape-driven, not name-driven.
            const p1descs = d?.metadata?.[0]?.param1 ?? [];
            const p2descs = d?.metadata?.[0]?.param2 ?? [];
            if (p1descs.some((x) => x.kind === 'layer_id')
                && p2descs.some((x) => x.kind === 'layer_id')) {
                const sel = layerSelect();
                paramsBox.replaceChildren(el('label', { text: 'Layer:' }), sel);
                readParams = () => [Number(sel.value), Number(sel.value)];
                return;
            }
            const editors = [];
            const readers = [];
            for (const which of ['param1', 'param2']) {
                const descs = d?.metadata?.[0]?.[which] ?? [];
                const used = descs.some((x) => x.kind !== 'nil');
                if (!used) { readers.push(() => 0); continue; }
                const hid = descs.find((x) => x.kind === 'hid_usage');
                const layer = descs.find((x) => x.kind === 'layer_id');
                const range = descs.find((x) => x.kind === 'range');
                const constants = descs.filter((x) => x.kind === 'constant');
                if (constants.length) {
                    const sel = el('select', {}, ...constants.map((c) =>
                        el('option', { value: c.constant, text: c.name || String(c.constant) })));
                    editors.push(sel);
                    readers.push(() => Number(sel.value) >>> 0);
                } else if (layer) {
                    const sel = layerSelect();
                    editors.push(sel);
                    readers.push(() => Number(sel.value));
                } else if (hid) {
                    // Keycap picker popup — no more manual key-name typing
                    // (bench 5: tap-hold hold/tap params were bare text
                    // boxes). The picker carries implicit modifiers, so a
                    // Mod-Tap hold can be ⇧/⌃/⌥/⌘ directly.
                    let usage = 0;
                    const idle = `${hid.name || which}…`;
                    const btn = el('button', { class: 'code', text: idle });
                    btn.addEventListener('click', () => {
                        pickUsage(`${d?.displayName ?? 'Behavior'} — ${hid.name || which}`,
                            usage, (u) => {
                                usage = u >>> 0;
                                btn.textContent = usage ? usageCap(usage) : idle;
                                btn.title = usage ? usageLabel(usage) : '';
                            });
                    });
                    editors.push(btn);
                    readers.push(() => (usage || null));
                } else if (range) {
                    // Bounded param from behavior metadata → slider + live value
                    // (GUI controls pass: no bare number boxes for bounded ints).
                    const val = el('span', { class: 'val', text: String(Math.max(0, range.min)) });
                    const input = el('input', {
                        type: 'range', min: range.min, max: range.max, value: Math.max(0, range.min),
                        title: `${range.min}–${range.max}`,
                    });
                    input.addEventListener('input', () => { val.textContent = input.value; });
                    editors.push(input, val);
                    readers.push(() => Number(input.value) | 0);
                } else {
                    const input = el('input', { type: 'number', value: 0, size: 6 });
                    editors.push(input);
                    readers.push(() => Number(input.value) >>> 0);
                }
            }
            paramsBox.replaceChildren(...editors);
            readParams = () => readers.map((r) => r());
        }

        bhvSel.addEventListener('change', buildParamEditors);
        buildParamEditors();
        assign.addEventListener('click', () => {
            const [p1, p2] = readParams();
            if (p1 == null || p2 == null) { toast('Fill in the key name first (e.g. A)', true); return; }
            onPick({ behaviorId: Number(bhvSel.value), param1: (p1 ?? 0) >>> 0, param2: (p2 ?? 0) >>> 0 });
        });
        codes.append(el('div', { class: 'composer' },
            el('label', { text: 'Behavior:' }), bhvSel, paramsBox, assign));
        if (hidden > 0) {
            codes.append(el('div', { class: 'note faint',
                text: `${hidden} firmware behavior${hidden === 1 ? '' : 's'} hidden — duplicates of a listed name, or no Studio metadata (the firmware rejects assigning those with INVALID PARAMETERS).` }));
        }
    }

    root.append(cats, search, codes);
    renderCats();
    renderCodes();
    return root;
}
