// Keycode picker: category chips + search + click-to-assign, plus the
// LT()/MT()/layer-op composer. Pattern from AlooMapper's renderPicker;
// data from keycodes.js.

import { el, toast } from './ui.js?v=18';
import { PICKER_CATEGORIES, compose, MODS, hoverText, describe, capLabel } from './keycodes.js?v=18';

/**
 * Build a picker panel. onPick(keycode) is called when the user chooses.
 * layerCount drives the layer-op composer. Returns the root element.
 */
export function buildPicker({ layerCount, onPick }) {
    let category = 'basic';
    let query = '';

    const root = el('div', { class: 'picker' });
    const cats = el('div', { class: 'cats' });
    const search = el('input', { type: 'search', placeholder: 'Search keycodes…' });
    const codes = el('div', { class: 'codes' });

    search.addEventListener('input', () => { query = search.value.toLowerCase(); renderCodes(); });

    function renderCats() {
        cats.replaceChildren(
            ...PICKER_CATEGORIES
                .filter((c) => c.id !== 'custom' || c.keys().length)
                .map((c) => el('button', {
                    class: c.id === category ? 'active' : '',
                    text: c.label,
                    onclick: () => { category = c.id; renderCats(); renderCodes(); },
                })),
            el('button', {
                class: category === 'layers' ? 'active' : '',
                text: 'Layers',
                onclick: () => { category = 'layers'; renderCats(); renderCodes(); },
            }),
        );
    }

    function keyButton(key) {
        return el('button', {
            class: 'code', title: hoverText(key.code),
            onclick: () => onPick(key.code),
        }, key.cap || '·', el('span', { class: 'full', text: key.label }));
    }

    function renderCodes() {
        codes.replaceChildren();
        if (category === 'layers') { renderLayerComposer(); return; }
        let list;
        if (query) {
            // Search across every category.
            list = PICKER_CATEGORIES.flatMap((c) => c.keys())
                .filter((key) => key.label.toLowerCase().includes(query)
                    || key.cap.toLowerCase().includes(query));
        } else {
            list = PICKER_CATEGORIES.find((c) => c.id === category)?.keys() ?? [];
        }
        codes.append(...list.map(keyButton));
        if (category === 'basic' && !query) codes.after(buildComposer());
        else root.querySelector('.composer')?.remove();
    }

    function renderLayerComposer() {
        const layerSel = el('select', {},
            ...Array.from({ length: layerCount }, (_, i) => el('option', { value: i, text: `Layer ${i}` })));
        const ops = [
            ['MO', 'Momentary (while held)', compose.momentary],
            ['TO', 'Switch to', compose.to],
            ['TG', 'Toggle', compose.toggleLayer],
            ['TT', 'Tap-toggle', compose.layerTapToggle],
            ['OSL', 'One-shot', compose.oneShotLayer],
            ['DF', 'Set default', compose.defLayer],
        ];
        codes.append(el('div', { class: 'composer' },
            el('label', { text: 'Layer:' }), layerSel,
            ...ops.map(([name, hint, fn]) => el('button', {
                class: 'code', title: hint,
                onclick: () => onPick(fn(Number(layerSel.value))),
            }, name)),
        ));
    }

    /** LT()/MT() composer under the Basic grid. */
    function buildComposer() {
        root.querySelector('.composer')?.remove();
        const kcInput = el('input', { type: 'text', placeholder: 'e.g. A', size: 4 });
        let baseKc = 0;
        kcInput.addEventListener('input', () => {
            const q = kcInput.value.trim().toLowerCase();
            const match = PICKER_CATEGORIES.flatMap((c) => c.keys())
                .find((key) => key.code <= 0xFF
                    && (key.label.toLowerCase() === q || key.cap.toLowerCase() === q));
            baseKc = match?.code ?? 0;
            kcInput.style.borderColor = baseKc || !q ? '' : 'var(--danger)';
        });
        const layerSel = el('select', {},
            ...Array.from({ length: Math.min(layerCount, 16) }, (_, i) => el('option', { value: i, text: `L${i}` })));
        // Toggle chips, not checkboxes — same visual as the ZMK combos tab's
        // modifier buttons (GUI controls pass).
        let modState = 0;
        const modChecks = MODS.map((m) => {
            const node = el('button', {
                class: 'btn small', text: m.label, title: `hold ${m.label} with the tap key`,
                onclick: () => {
                    modState ^= m.bit;
                    node.classList.toggle('primary', !!(modState & m.bit));
                },
            });
            return { m, node };
        });
        const modBits = () => modState;
        // Guard with feedback — the old silent `baseKc && …` short-circuits
        // made a missing tap key / unchecked mods look like a dead button.
        const need = (wantKc, wantMods) => {
            if (wantKc && !baseKc) { toast('Type the tap key first (e.g. A)', true); return false; }
            if (wantMods && !modBits()) { toast('Toggle at least one modifier first', true); return false; }
            return true;
        };
        return el('div', { class: 'composer' },
            el('label', { text: 'Compose: tap' }), kcInput,
            el('button', {
                class: 'code', title: 'Layer-tap: tap for the key, hold for the layer',
                onclick: () => need(true, false) && onPick(compose.layerTap(Number(layerSel.value), baseKc)),
            }, 'LT'), layerSel,
            ...modChecks.map((c) => c.node),
            el('button', {
                class: 'code', title: 'Mod-tap: tap for the key, hold for the modifiers',
                onclick: () => need(true, true) && onPick(compose.modTap(modBits(), baseKc)),
            }, 'MT'),
            el('button', {
                class: 'code', title: 'Key with the checked modifiers held',
                onclick: () => need(true, true) && onPick(compose.modsWrap(modBits(), baseKc)),
            }, 'Mods+key'),
            el('button', {
                class: 'code', title: 'One-shot modifier',
                onclick: () => need(false, true) && onPick(compose.oneShotMod(modBits() >> 8)),
            }, 'OSM'),
        );
    }

    // Attach children BEFORE the first renderCodes() — buildComposer is
    // inserted via codes.after(), which is a silent no-op while codes has
    // no parent (this hid the LT/MT composer on every fresh picker).
    root.append(cats, search, codes);
    renderCats();
    renderCodes();
    return root;
}

export { describe };

/** Small keycode cell button — shared by every slot-grid tab. */
export function kcCell(kc, onClick, title) {
    return el('button', {
        class: 'code', title: title ?? describe(kc),
        text: kc ? capLabel(kc) : '·',
        onclick: onClick,
    });
}

/**
 * One hidden picker card shared by all slots in a tab (typing-tab pattern).
 * request(onSet) shows the card and routes the next pick; restrict(kc) can
 * veto (with note toasted) — used by gestures/chords whose slots fire via
 * tap_code16 (basic keycodes + C()/S()/A()/G() combos only).
 */
export function makePickerHost({ layerCount, restrict, note }) {
    let target = null;
    const card = el('div', { class: 'card' },
        el('h3', { text: 'Assign keycode' },
            el('span', { class: 'sub', text: 'click a slot above, then pick' })));
    card.append(buildPicker({
        layerCount,
        onPick: async (kc) => {
            if (!target) return;
            if (restrict && !restrict(kc)) {
                toast(note || 'That keycode is not allowed in this slot', true);
                return;
            }
            const t = target;
            target = null;
            card.style.display = 'none';
            await t(kc);
        },
    }));
    card.style.display = 'none';
    return {
        card,
        request(onSet) {
            target = onSet;
            card.style.display = '';
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
        cancel() { target = null; card.style.display = 'none'; },
    };
}
