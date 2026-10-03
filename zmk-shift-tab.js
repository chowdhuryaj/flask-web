// ZMK Mod Morph tab — flask_csk, the QMK custom_shift_keys analog grown into a
// full mod-morph table (channel 0x16, proto v14; trigger sets need MORPH_CAPS).
// While the slot's trigger modifiers (any non-empty subset of ⌃⇧⌥⌘, matched
// EXACTLY, side-agnostic) are held, a key whose BASE usage matches sends the
// REPLACEMENT instead; the trigger mods are masked out of the report unless
// "keep mods" is on (ZMK mod-morph keep-mods). Tab id stays 'zmk-shift'.
//
//   ⇧ , → ;        shift-comma types ;       (shift masked)
//   ⇧ ⌫ → ⌦        shift-backspace deletes forward
//   ⌥ ⌫ → ⌦ keep   alt-backspace sends alt-delete (word delete forward)
//   ⌃⇧ , → ;       ctrl+shift+comma types ;  (a different slot from ⇧ ,)
//
// The replacement picker's modifier row encodes into the replacement (bits
// 24-31); the base is matched by page+id (its mod bits are ignored by the
// firmware). Firmware without MORPH_CAPS is Shift-only: the same UI minus the
// trigger chips and keep toggle. Same slot-list pattern as the Leader tab.
//
// OS-aware rows (OSK_CAPS firmware): each slot can be conditioned on the board's
// OS mode (Any / Mac / Windows), match ANY key ("Any key" wildcard: only the
// trigger and replacement mods matter), and count keymap mods. The "Mac
// shortcuts on Windows" pack (zmk-os-pack.js) loads ⌘→⌃ and its exceptions.

import { el, card, toggleRow, toast, reloadBar } from './ui.js?v=68';
import { CH, V } from './flaskproto.js?v=68';
import { usageFromName, usageCap } from './zmk-keycodes.js?v=68';
import { blurClicks, pickOutput, outText, outCell, installSlotSummary, onSlotsChanged, dim } from './zmk-behaviour-common.js?v=68';
import { decodeCskSlot, encodeCskSlot, cskSlotIsEmpty, cskMorphCaps, cskNeedsMorph, cskDuplicateOf,
    cskSummary, trigText, TRIGGER_MODS, MOD_CTL, MOD_SFT, MOD_ALT, MOD_SHIFT_ONLY,
    cskNeedsOs, cskOskCaps, cskOsMode, cskClash, OS_ANY, OS_MAC, OS_PC, OS_NAMES, WILD_KEY } from './zmk-csk-codec.js?v=68';
import { OS_PACK, OS_PACK_LABEL } from './zmk-os-pack.js?v=68';

// One-click starters. Encodings ride usageFromName so the table stays data —
// names must exist in zmk-keycodes.js. shiftedMods = implicit-modifier bits
// for the replacement (0x02 = ⇧, MODS table). mods = trigger set (default ⇧).
const PRESETS = [
    { label: '⇧ ⌫ → ⌦', base: 'Backspace', shifted: 'Delete', hint: 'shift-backspace deletes forward' },
    { label: '⇧ , → ;', base: 'Comma', shifted: 'Semicolon', hint: 'shift-comma types a semicolon' },
    { label: '⇧ . → :', base: 'Dot', shifted: 'Semicolon', shiftedMods: 0x02, hint: 'shift-dot types a colon' },
    { label: '⌥ ⌫ → ⌦ keep', base: 'Backspace', shifted: 'Delete', mods: MOD_ALT, keep: true,
        hint: 'alt-backspace sends alt-delete (word delete forward)' },
    { label: '⌃⇧ , → ;', base: 'Comma', shifted: 'Semicolon', mods: MOD_CTL | MOD_SFT,
        hint: 'ctrl-shift-comma types a semicolon (separate from shift-comma)' },
];

export class ZmkShiftTab {
    constructor(app) {
        this.app = app;
        this.root = blurClicks(el('div'));
        this.drafts = new Set();
        this.morph = false;
        this.osk = false;       // OSK_CAPS: firmware takes OS condition / wildcard / count-mods
        this.osMode = null;     // board's current OS (OS_MAC / OS_PC) or null
        onSlotsChanged(CH.customShift, this, () => { if (this.slots) this.load().catch(() => {}); });
        installSlotSummary(app);
    }

    async load() {
        const { flask, hid } = this.app;
        hid?.pause?.();
        try {
            this.morph = await cskMorphCaps(flask);
            this.osk = this.morph && await cskOskCaps(flask);
            this.osMode = this.osk ? await cskOsMode(flask) : null;
            this.enabled = await flask.getU16(CH.customShift, V.cskEnabled);
            this.slotCount = await dim(this.app, CH.customShift, V.cskSlotCount);
            this.slots = [];
            for (let i = 0; i < this.slotCount; i++) {
                const r = await flask.getBytes(CH.customShift, V.cskSlot, [i], 1);
                this.slots.push(decodeCskSlot(r));
            }
        } finally {
            hid?.resume?.();
        }
        this.bar ??= reloadBar(CH.customShift, {
            label: 'Mod morphs',
            save: () => this.app.flask.save(CH.customShift),
            reload: () => this.load(),
        });
        this.render();
    }

    async writeSlot(i, before = null) {
        try {
            const s = this.slots[i];
            if (!this.osk && cskNeedsOs(s)) {
                if (before) this.slots[i] = before;
                toast('This firmware has no OS-aware shortcuts; update it to use OS, any-key or count-mods rows', true);
                this.render();
                return;
            }
            // Shift-only firmware cannot carry another trigger set: refuse rather than
            // silently rewrite a ⌃/⌥/⌘ or keep slot as plain Shift.
            if (!this.morph && cskNeedsMorph(s)) {
                if (before) this.slots[i] = before;
                toast('This firmware is Shift-only; update it to write ⌃ ⌥ ⌘ triggers or keep-mods', true);
                this.render();
                return;
            }
            const r = await this.app.flask.setBytes(CH.customShift, V.cskSlot,
                encodeCskSlot(i, s), 1);
            this.slots[i] = decodeCskSlot(r); // adopt the echo
            this.bar?.markEdited();
        } catch (e) {
            if (before) this.slots[i] = before;
            toast(`Mod-morph write failed: ${e.message}`, true);
        }
        this.render();
    }

    freeSlot() {
        return this.slots.findIndex((s, idx) =>
            cskSlotIsEmpty(s) && !this.drafts.has(idx));
    }

    addPair(patch = null) {
        const i = this.freeSlot();
        if (i < 0) { toast(`All ${this.slotCount} mod-morph slots are in use`, true); return; }
        this.slots[i] = { slot: i, base: 0, shifted: 0, mods: MOD_SHIFT_ONLY, keep: false, ...(patch || {}) };
        if (patch) this.writeSlot(i);
        else { this.drafts.add(i); this.render(); }
    }

    addPreset(p) {
        const mods = p.mods ?? MOD_SHIFT_ONLY;
        if (!this.morph && mods !== MOD_SHIFT_ONLY) {
            toast('This firmware only supports Shift triggers; update it for other modifiers', true);
            return;
        }
        const base = usageFromName(p.base);
        let shifted = usageFromName(p.shifted);
        if (base == null || shifted == null) { toast('Preset keycode missing', true); return; }
        if (p.shiftedMods) shifted = (((p.shiftedMods & 0xFF) << 24) | shifted) >>> 0;
        // Same base under the same trigger set (any OS) → don't duplicate.
        if (this.slots.some((s) => !cskSlotIsEmpty(s) && !s.os && !s.wild
            && (s.base & 0xFFFFFF) === (base & 0xFFFFFF) && s.mods === mods)) {
            toast(`${trigText(mods)} on that base key is already mapped`, true);
            return;
        }
        this.addPair({ base: base >>> 0, shifted: shifted >>> 0, mods, keep: !!p.keep });
    }

    /** Load the "Mac shortcuts on Windows" pack into free slots, skipping rows that already exist. */
    async addPack() {
        const empty = (i) => ({ slot: i, base: 0, shifted: 0, mods: MOD_SHIFT_ONLY, keep: false });
        // Specifics first, the wildcard last (it only catches what they miss).
        const rows = [...OS_PACK].sort((a, b) => !!a.wild - !!b.wild)
            .filter((r) => !this.slots.some((s) => !cskSlotIsEmpty(s) && s.shifted && cskClash(s, r)));
        const existing = OS_PACK.length - rows.length;
        const free = this.slots.filter((s, idx) => cskSlotIsEmpty(s) && !this.drafts.has(idx)).length;
        if (rows.length > free) {
            toast(`${OS_PACK_LABEL} needs ${rows.length} free slots, only ${free} free. Delete some slots and load it again`, true);
            return;
        }
        let added = 0;
        for (const { src, ...row } of rows) {
            const i = this.freeSlot();
            this.slots[i] = { slot: i, ...row };
            await this.writeSlot(i, empty(i));
            if (cskSlotIsEmpty(this.slots[i])) return;     // write failed: its toast already says why
            added++;
        }
        toast(`${OS_PACK_LABEL}: added ${added} of ${OS_PACK.length}${existing ? `, ${existing} already there` : ''}`);
    }

    async clearSlot(i) {
        this.slots[i] = { slot: i, base: 0, shifted: 0, mods: MOD_SHIFT_ONLY, keep: false };
        this.drafts.delete(i);
        await this.writeSlot(i);
    }

    toggleMod(i, bit) {
        const s = this.slots[i];
        const mods = s.mods ^ bit;
        if (!mods) { toast('A mod morph needs at least one trigger modifier', true); return; }
        const before = { ...s };
        s.mods = mods;
        this.writeSlot(i, before);
    }

    /** Set OS condition; picking an OS turns count-keymap-mods on (the point of an OS row). */
    setOs(i, os) {
        const before = { ...this.slots[i] };
        const s = this.slots[i];
        s.os = os;
        if (os && !before.os) s.count = true;
        this.writeSlot(i, before);
    }

    toggleCount(i) {
        const before = { ...this.slots[i] };
        this.slots[i].count = !before.count;
        this.writeSlot(i, before);
    }

    /** Any key on: base and replacement key become the placeholder (only mods matter).
     * Off: both sides go back to "pick a key". */
    toggleWild(i) {
        const s = this.slots[i];
        const before = { ...s };
        if (!s.wild) {
            s.wild = true;
            s.base = WILD_KEY;
            s.shifted = (((s.shifted >>> 24) << 24) | WILD_KEY) >>> 0;
        } else {
            s.wild = false;
            s.base = 0;
            s.shifted = 0;
        }
        this.writeSlot(i, before);
    }

    toggleReplMod(i, bit) {
        const s = this.slots[i];
        const before = { ...s };
        s.shifted = ((((s.shifted >>> 24) ^ bit) << 24) | WILD_KEY) >>> 0;
        this.writeSlot(i, before);
    }

    toggleKeep(i) {
        const before = { ...this.slots[i] };
        this.slots[i].keep = !before.keep;
        this.writeSlot(i, before);
    }

    pickSide(i, side) {
        const s = this.slots[i];
        const trig = trigText(s.mods);
        const title = side === 'base'
            ? `Slot ${i}: base key (what you press)`
            : `Slot ${i}: replacement (what ${trig}+key types)`;
        pickOutput({
            app: this.app, surface: side === 'base' ? 'zmk.cskBase' : 'zmk.cskShifted', title,
            value: s[side] ? { action: 1, param1: s[side] } : null,
            onPick: (v) => {
                const usage = (v.action === 1 ? v.param1 : 0) >>> 0;
                const before = { ...s };
                this.slots[i][side] = usage;
                this.writeSlot(i, before);
            },
        });
    }

    pairCard(i) {
        const s = this.slots[i];
        const live = !cskSlotIsEmpty(s) && s.base !== 0 && s.shifted !== 0;
        const osRow = !!(s.os || s.wild);
        const label = osRow ? (u) => usageCap(u) : (u) => outText({ action: 1, param1: u }, 'zmk.cskShifted');
        const trig = trigText(s.mods);
        const tile = (side, value, hint) => el('div', {},
            el('div', { class: 'note faint', text: hint }),
            el('button', {
                class: 'code',
                style: 'min-width:72px; min-height:44px; font-size:1.05em',
                title: value ? label(value) : `pick the ${hint}`,
                onclick: () => this.pickSide(i, side),
            }, value ? outCell({ action: 1, param1: value }, side === 'base' ? 'zmk.cskBase' : 'zmk.cskShifted') : `${hint}…`));

        const dup = cskDuplicateOf(this.slots, i);
        const wild = this.osk && s.wild;
        const rmods = (s.shifted >>> 24) & 0x0F;
        const anyKeyTile = el('div', {},
            el('div', { class: 'note faint', text: 'base key' }),
            el('div', { class: 'code', style: 'min-width:72px; min-height:44px; font-size:1.05em; display:flex; align-items:center; justify-content:center; padding:0 10px',
                text: 'any key' }));
        const replMods = el('div', {},
            el('div', { class: 'note faint', text: 'replacement mods + same key' }),
            el('div', { style: 'display:flex; gap:4px', role: 'group', 'aria-label': `Slot ${i} replacement modifiers` },
                ...TRIGGER_MODS.map((t) => el('button', {
                    class: 'chip' + (rmods & t.bit ? ' on' : ''),
                    style: 'min-height:44px; min-width:44px; font-size:1.05em',
                    title: t.name, 'aria-pressed': String(!!(rmods & t.bit)),
                    text: t.glyph,
                    onclick: () => this.toggleReplMod(i, t.bit),
                }))));
        const osSel = this.osk ? el('label', { class: 'note', style: 'display:flex; flex-direction:column; gap:2px' },
            'OS',
            el('select', {
                'aria-label': `Slot ${i} OS condition`, 'data-os': String(s.os || 0),
                style: 'min-height:44px',
                onchange: (e) => this.setOs(i, Number(e.target.value)),
            }, ...[[OS_ANY, 'Any OS'], [OS_MAC, 'Mac'], [OS_PC, 'Windows']].map(([v, t]) =>
                el('option', { value: String(v), selected: (s.os || 0) === v, text: t })))) : null;
        const anyKey = this.osk ? el('label', {
            class: 'note', style: 'display:flex; gap:6px; align-items:center; padding-bottom:12px',
            title: 'match every key under the trigger modifiers; only the modifiers change, the pressed key is kept',
        }, el('input', { type: 'checkbox', checked: !!s.wild, onchange: () => this.toggleWild(i) }),
        'any key') : null;
        const countMods = this.osk ? el('label', {
            class: 'note', style: 'display:flex; gap:6px; align-items:center; padding-bottom:12px',
            title: 'Makes &kp ⌘C keys and combo outputs count as the trigger, not just held mods. On by default for OS rows.',
        }, el('input', { type: 'checkbox', checked: !!s.count, onchange: () => this.toggleCount(i) }),
        'count keymap mods') : null;
        const chips = this.morph ? el('div', {},
            el('div', { class: 'note faint', text: 'trigger (held exactly)' }),
            el('div', { style: 'display:flex; gap:4px', role: 'group', 'aria-label': `Slot ${i} trigger modifiers` },
                ...TRIGGER_MODS.map((t) => el('button', {
                    class: 'chip' + (s.mods & t.bit ? ' on' : ''),
                    style: 'min-height:44px; min-width:44px; font-size:1.05em',
                    title: t.name, 'aria-pressed': String(!!(s.mods & t.bit)),
                    text: t.glyph,
                    onclick: () => this.toggleMod(i, t.bit),
                })))) : null;
        const keep = this.morph ? el('label', {
            class: 'note', style: 'display:flex; gap:6px; align-items:center; padding-bottom:12px',
            title: 'leave the trigger modifiers pressed alongside the replacement (ZMK keep-mods)',
        }, el('input', { type: 'checkbox', checked: s.keep, onchange: () => this.toggleKeep(i) }),
        'keep mods') : null;

        return el('div', { class: 'card', style: live ? '' : 'opacity:0.75' },
            el('div', { class: 'row' },
                el('span', { class: 'lbl' }, el('b', { text: `Slot ${i}` }),
                    el('span', {
                        class: 'hint',
                        text: live ? cskSummary(s, label) : 'incomplete: pick both sides',
                    })),
                el('span', { style: 'flex:1' }),
                el('button', {
                    class: 'btn small', text: 'Delete', title: 'empty this slot',
                    onclick: () => this.clearSlot(i),
                })),
            el('div', { style: 'display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap' },
                osSel,
                chips,
                wild ? anyKeyTile : tile('base', s.base, 'base key'),
                el('span', { style: 'font-size:1.4em; padding-bottom:10px', text: `${trig}→` }),
                wild ? replMods : tile('shifted', s.shifted, 'replacement'),
                anyKey,
                countMods,
                keep),
            dup >= 0 ? el('div', {
                class: 'note', role: 'alert', 'data-dup': String(dup),
                text: s.wild
                    ? `Duplicate: slot ${dup} already maps ${trig} + any key${s.os ? ` on ${OS_NAMES[s.os]}` : ''}, so one of them never fires. Change the trigger or the OS.`
                    : `Duplicate: slot ${dup} already maps ${trig} + this base key${s.os ? ` on ${OS_NAMES[s.os]}` : ''}, so one of them never fires. Change the trigger, the OS or the key.`,
            }) : null);
    }

    osNote() {
        if (!this.osk) {
            return el('div', { class: 'note faint', 'data-os-note': 'none',
                text: 'This firmware has no OS-aware shortcuts (OSK_CAPS); update it for Mac/Windows rows, any-key rows and the Mac shortcuts pack.' });
        }
        const mode = this.osMode === OS_MAC ? 'Mac' : this.osMode === OS_PC ? 'Windows (PC)' : 'unknown (no switch-layout module)';
        return el('div', { class: 'note', 'data-os-note': 'on',
            text: `Board OS mode: ${mode}. The Control layer's &sw_layout key toggles it. Author rows in Mac terms (⌘C); a Windows row only fires while the board is in PC mode. On Windows ⌘Tab gives a single Alt+Tab (last window); use the app-switcher key to cycle.` });
    }

    render() {
        const { flask } = this.app;
        const visible = this.slots.map((s, i) => i)
            .filter((i) => !cskSlotIsEmpty(this.slots[i]) || this.drafts.has(i));
        const used = this.slots.filter((s) => !cskSlotIsEmpty(s)).length;

        const controls = card('Mod morph',
            this.morph
                ? 'remap what any modifier combination + key types, no hand-written mod-morph behaviors'
                : 'remap what ⇧+key types (this firmware is Shift-only; update it for ⌃ ⌥ ⌘ triggers)',
            toggleRow({
                label: 'Mod morphs enabled',
                hint: 'master switch; slots stay stored while off',
                value: this.enabled,
                onChange: async (val) => {
                    this.enabled = await flask.setU16(CH.customShift, V.cskEnabled, val ? 1 : 0);
                    return this.enabled;
                },
            }),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn small primary', text: '＋ New slot',
                    onclick: () => this.addPair(),
                }),
                ...PRESETS.filter((p) => this.morph || !p.mods).map((p) => el('button', {
                    class: 'btn small', text: p.label, title: p.hint,
                    onclick: () => this.addPreset(p),
                })),
                this.osk ? el('button', {
                    class: 'btn small primary', text: OS_PACK_LABEL, 'data-os-pack': '1',
                    title: `${OS_PACK.length} slots: ⌘ + any key → ⌃ + same key, plus Windows exceptions (⌘Q → Alt+F4, ⌘← → Home, ...). Skips rows already present.`,
                    onclick: () => this.addPack(),
                }) : null,
                el('span', { class: 'note faint', text: `${used}/${this.slotCount} slots used` }),
                ),
            this.bar,
            this.morph ? this.osNote() : null,
            el('div', { class: 'note faint',
                text: 'A slot fires only when exactly its trigger modifiers are held, so ⇧ , and ⌃⇧ , are separate slots. '
                    + 'The replacement picker\'s modifier row rides the replacement, e.g. pick R with ⇧ for h→R. '
                    + (this.morph ? 'Keep mods leaves the trigger pressed with the replacement. ' : '')
                    + 'With ⌃ or ⌘ triggers the trigger stays masked until the morphed key is released, so roll-then-shortcut (⌃H then ⌃C) sends a plain key: release first. '
                    + 'Edits are live.' }));

        this.root.replaceChildren(controls,
            ...visible.map((i) => this.pairCard(i)),
            visible.length ? el('span') : el('div', {
                class: 'note faint',
                text: 'No slots yet. Use a preset or ＋ New slot, then pick the trigger, the base key and its replacement.',
            }));
    }
}
