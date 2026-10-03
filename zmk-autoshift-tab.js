// ZMK Auto Shift tab — flask_autoshift runtime global auto shift + retro shift
// (channel 0x2C, proto v19, Totem). The QMK / Vial "Auto Shift" settings: hold a
// key past the timeout and it types its shifted character. Global switches only,
// no per-key reassigning. Every SET adopts the echoed (clamped) value; edits are
// live and the top bar's Save writes flash (reloadBar, source 0x2C).

import { el, card, toggleRow, toast, reloadBar } from './ui.js?v=76';
import { CH_ZMK, V } from './flaskproto.js?v=76';
import { blurClicks } from './zmk-behaviour-common.js?v=76';
import {
    ASH_GROUPS, ASH_DEFAULTS, ASH_TIMEOUT, ASH_RETRO_LIMIT, clampAshTimeout, clampRetroLimit,
} from './zmk-autoshift-codec.js?v=76';

const IDS = {
    enabled: V.ashEnabled, timeout: V.ashTimeout, groups: V.ashGroups, modifiers: V.ashModifiers,
    repeat: V.ashRepeat, noAutoRepeat: V.ashNoAutoRepeat, retro: V.ashRetro, retroLimit: V.ashRetroLimit,
};

const note = (text) => el('div', { class: 'note faint', text });

const GROUP_ROWS = [
    ['alpha', 'Letters', 'A to Z'],
    ['numeric', 'Numbers', '1 to 0 on the number row'],
    ['symbols', 'Symbols', '- = [ ] \\ ; \' ` , . /'],
    ['tab', 'Tab', 'Tab types Shift+Tab'],
    ['enter', 'Enter', 'Enter types Shift+Enter'],
];

export class ZmkAutoshiftTab {
    constructor(app) {
        this.app = app;
        this.root = blurClicks(el('div'));
        this.v = { ...ASH_DEFAULTS };
    }

    async load() {
        const { flask, hid } = this.app;
        hid?.pause?.();
        try {
            for (const [k, id] of Object.entries(IDS)) this.v[k] = await flask.getU16(CH_ZMK.autoShift, id);
        } finally {
            hid?.resume?.();
        }
        this.bar ??= reloadBar(CH_ZMK.autoShift, {
            label: 'Auto Shift',
            save: () => this.app.flask.save(CH_ZMK.autoShift),
            reload: () => this.load(),
        });
        this.render();
    }

    /** SET one value, adopt the echo, mark the channel edited. Throws on failure. */
    async put(key, value) {
        const echo = await this.app.flask.setU16(CH_ZMK.autoShift, IDS[key], value);
        this.v[key] = echo;
        this.bar?.markEdited();
        this.sync();
        return echo;
    }

    /** put() for rows that own their error toast. Resolves to the echo or null. */
    async tryPut(key, value) {
        try { return await this.put(key, value); }
        catch (e) { toast(`Auto Shift write failed: ${e.message}`, true); return null; }
    }

    /** Dependent states: nothing applies while off; keyrepeat sub-option and
     * the retro window follow their switches. */
    sync() {
        const u = this.ui;
        if (!u) return;
        u.dim.forEach((c) => { c.style.opacity = this.v.enabled ? '' : '0.6'; });
        u.noAuto.querySelector('button.toggle').disabled = !this.v.repeat;
        u.noAuto.style.opacity = this.v.repeat ? '' : '0.55';
        u.limit.disabled = !this.v.retro;
    }

    toggle(key, label, hint) {
        return toggleRow({
            label, hint, value: this.v[key],
            onChange: async (on) => !!(await this.put(key, on ? 1 : 0)),
        });
    }

    /** Range slider + number box, both writing through `key` (release / Enter). */
    timeoutRow() {
        const { min, max } = ASH_TIMEOUT;
        const slider = el('input', { type: 'range', min, max, step: 5, value: this.v.timeout, 'aria-label': 'Auto Shift timeout (ms)' });
        const num = el('input', { type: 'number', min, max, value: this.v.timeout, style: 'width:72px', 'aria-label': 'Auto Shift timeout (ms)' });
        const paint = (v) => { slider.value = v; num.value = v; };
        const commit = async (raw) => {
            const echo = await this.tryPut('timeout', clampAshTimeout(raw));
            paint(echo ?? this.v.timeout);
        };
        slider.addEventListener('input', () => { num.value = slider.value; });
        slider.addEventListener('change', () => commit(slider.value));
        num.addEventListener('change', () => commit(num.value));
        return el('div', { class: 'row' },
            el('span', { class: 'lbl' }, 'Timeout',
                el('span', { class: 'hint', text: 'Hold a key this long to get its shifted character.' })),
            slider, num, el('span', { class: 'faint', text: 'ms' }));
    }

    groupRow([name, label, sample]) {
        const bit = ASH_GROUPS[name];
        const cb = el('input', { type: 'checkbox', checked: !!(this.v.groups & bit), 'aria-label': label });
        cb.addEventListener('change', async () => {
            const next = cb.checked ? (this.v.groups | bit) : (this.v.groups & ~bit);
            const echo = await this.tryPut('groups', next);
            cb.checked = !!((echo ?? this.v.groups) & bit);
        });
        return el('label', { class: 'row', style: 'cursor:pointer' },
            el('span', { class: 'lbl' }, label, el('span', { class: 'hint', text: sample })), cb);
    }

    limitRow() {
        const { min, max } = ASH_RETRO_LIMIT;
        const input = el('input', {
            type: 'number', min: 0, max, value: this.v.retroLimit || '', placeholder: 'no limit',
            style: 'width:84px', 'aria-label': 'Retro shift window end (ms)',
            title: `blank or 0 = no limit; otherwise ${min} to ${max} ms`,
        });
        input.addEventListener('change', async () => {
            const echo = await this.tryPut('retroLimit', clampRetroLimit(input.value));
            input.value = (echo ?? this.v.retroLimit) || '';
        });
        this.ui.limit = input;
        return el('div', { class: 'row' },
            el('span', { class: 'lbl' }, 'Shift window ends at',
                el('span', { class: 'hint', text: 'Blank or 0 means no limit: any release after the tapping term shifts.' })),
            input, el('span', { class: 'faint', text: 'ms' }));
    }

    render() {
        this.ui = { dim: [] };
        const enable = card('Auto Shift', 'hold a key to type its shifted character',
            this.toggle('enabled', 'Enable',
                'Off by default. Once on, a quick tap types the plain key and a hold past the timeout types the shifted one.'),
            this.timeoutRow(), this.bar);

        const keys = card('Keys', 'which keys auto shift applies to',
            ...GROUP_ROWS.map((g) => this.groupRow(g)),
            note('Combos that type one of these count too. Only plain key presses are shifted; macros, tap dances and adaptive keys are not.'));

        this.ui.noAuto = this.toggle('noAutoRepeat', 'Disable keyrepeat when timeout is exceeded',
            'Holding past the timeout types the shifted key once, with no repeat. Tap then hold within 200 ms still repeats.');
        const extras = card('Modifiers and repeat', 'edge cases',
            this.toggle('modifiers', 'Enable for modifiers',
                'Ctrl+A held past the timeout sends Ctrl+Shift+A. Off: holding Ctrl, Alt or Cmd skips auto shift.'),
            this.toggle('repeat', 'Enable keyrepeat',
                'Keep holding past the timeout and the shifted key repeats. Tap then hold within 200 ms repeats the plain key.'),
            this.ui.noAuto);

        const retroRow = this.toggle('retro', 'Enable retro shift',
            'Release a held tap-hold key before the window ends and you get the shifted tap instead of the hold.');
        const retro = card('Retro shift', 'shifted tap from a mod-tap or layer-tap',
            retroRow, this.limitRow(),
            note('Hold a mod-tap or layer-tap past its tapping term and let go before this, with no other key pressed: you get the shifted tap. Hold longer: only the hold. Applies to live hold-taps (Hold timing) whose tap is a key ticked above.'));

        this.ui.dim.push(keys, extras, retro);
        this.sync();
        this.root.replaceChildren(enable, keys, extras, retro);
    }
}
