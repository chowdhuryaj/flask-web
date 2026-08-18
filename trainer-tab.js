// Typing trainer — the adaptive practice surface.
//
// A clone of keybr.com's guided trainer, wired to this app's devices. The
// engine lives in trainer-model / trainer-stats / trainer-lesson /
// trainer-textinput; this file is the UI and the device integration:
//
//   - the alphabet comes off the connected keymap (trainer-keyboard.js), so a
//     remapped board is described correctly with no configuration;
//   - the per-key heatmap is painted onto the real board geometry, which is the
//     thing a browser typing test cannot do and a keyboard configurator can.
//
// Works with no device connected at all — the trainer is reachable from the
// landing page, where it behaves like any other typing site over a-z.

import { el, svgEl, card, toast, sliderRow, toggleRow, selectRow } from './ui.js?v=44';
import { PhoneticModel, randomSeed } from './trainer-model.js?v=44';
import {
    TrainerStore, makeResult, makeKeyStatsMap, learningRate, dailyStats,
    summaryStats, cpmToWpm, wpmToCpm, timeToSpeed,
} from './trainer-stats.js?v=44';
import { DEFAULT_SETTINGS, LESSON_TYPES, makeLesson, Target } from './trainer-lesson.js?v=44';
import { TypingSession, Attr, Feedback, liveStats } from './trainer-textinput.js?v=44';
import { keyboardFromKeymap } from './trainer-keyboard.js?v=44';
import { renderKeyboardSVG } from './keymap-tab.js?v=44';

/** Attr → the class that colours one character of the lesson text. */
const ATTR_CLASS = {
    [Attr.Normal]: 'tr-ch',
    [Attr.Hit]: 'tr-ch hit',
    [Attr.Miss]: 'tr-ch miss',
    [Attr.Garbage]: 'tr-ch garbage',
    [Attr.Cursor]: 'tr-ch cursor',
};

const WHITESPACE_GLYPH = { space: ' ', bar: '|', bullet: '·' };

/**
 * Confidence → colour, mixed between the theme's own danger/warn/ok inks so a
 * repainted palette repaints the heatmap with it. `t` is confidence clamped to
 * 0..1, where 1 means "at or above the target speed".
 */
function heatColor(t) {
    const x = Math.max(0, Math.min(1, t));
    return x < 0.5
        ? `color-mix(in oklab, var(--warn) ${x * 200}%, var(--danger))`
        : `color-mix(in oklab, var(--ok) ${(x - 0.5) * 200}%, var(--warn))`;
}

const fmtWpm = (cpm) => (cpm > 0 ? cpmToWpm(cpm).toFixed(0) : '—');
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtDur = (ms) => (ms >= 60000
    ? `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`
    : `${(ms / 1000).toFixed(1)}s`);

export class TrainerTab {
    constructor(app) {
        this.app = app;
        this.root = el('div', { class: 'trainer' });
        this.store = new TrainerStore();
        this.settings = this.store.loadSettings(DEFAULT_SETTINGS);
        this.model = null;
        this.keyboard = null;
        this.session = null;
        this.lesson = null;
        this.lastResult = null;
        this.previousAlphabet = 0;
        this.unlocked = null;
        this.showProfile = false;
        this.showSettings = false;
    }

    async load() {
        // ~25 ms to build the 4-gram table; do it before first paint so the
        // first lesson is never an empty box.
        this.model = PhoneticModel.shared();
        await this.#readKeyboard();
        this.render();
        this.newLesson();
    }

    /**
     * Read the keymap for the alphabet and the heatmap.
     *
     * Reuses the keymap the Keymap tab already read when there is one — a full
     * re-read is hundreds of HID round trips and both tabs want the same bytes.
     */
    async #readKeyboard() {
        const { app } = this;
        if (app?.profile?.keys == null || app.vial == null) return;
        try {
            if (app.keymap == null) {
                app.keymap = await app.vial.readKeymap(
                    app.layerCount, app.profile.matrixRows, app.profile.matrixCols);
            }
            this.keyboard = keyboardFromKeymap(app.profile, app.keymap);
        } catch (e) {
            // A trainer that refuses to open because a keymap read failed would
            // be worse than one without a heatmap.
            console.warn('trainer: keymap unavailable', e);
        }
    }

    // ------------------------------------------------------------ lesson flow

    get keyStatsMap() {
        return makeKeyStatsMap(this.model.letters, this.store.results);
    }

    newLesson() {
        // Recomputed here, not just at load: the Keymap tab writes remapped
        // keycodes straight into app.keymap, and a snapshot taken once would
        // keep teaching letters the board no longer has. Pure arithmetic over
        // the cached keymap — no device traffic.
        if (this.app?.keymap && this.app?.profile?.keys) {
            this.keyboard = keyboardFromKeymap(this.app.profile, this.app.keymap);
        }
        const keyStatsMap = this.keyStatsMap;
        this.lesson = makeLesson({
            settings: this.settings,
            model: this.model,
            keyboard: this.keyboard,
            keyStatsMap,
            seed: randomSeed(),
        });
        this.session = new TypingSession(this.lesson.text, this.settings);
        this.renderText();
        this.renderKeys();
        this.renderLive();
    }

    /** Esc, or the toolbar button: throw the current text away for a new one. */
    restart() {
        this.unlocked = null;
        this.newLesson();
        this.textEl?.focus();
    }

    #finish() {
        const result = makeResult({ steps: this.session.steps, lessonType: this.settings.lessonType });
        if (result == null) { this.newLesson(); return; }

        const before = this.lesson.keys.included().length;
        this.lastResult = result;
        this.store.append(result);

        // What changed as a result of this lesson is the one thing worth
        // announcing: the alphabet grew, or it did not.
        const after = makeLesson({
            settings: this.settings, model: this.model, keyboard: this.keyboard,
            keyStatsMap: this.keyStatsMap, seed: randomSeed(),
        });
        const grown = after.keys.included().length > before;
        this.unlocked = grown
            ? after.keys.included()[after.keys.included().length - 1].letter.label
            : null;
        this.previousAlphabet = before;

        this.lesson = after;
        this.session = new TypingSession(this.lesson.text, this.settings);
        this.renderText();
        this.renderKeys();
        this.renderLive();
        this.renderResult();
        if (this.showProfile) this.renderProfile();
    }

    // ------------------------------------------------------------ input

    #onKeyDown(e) {
        if (e.metaKey || e.ctrlKey) {
            // Ctrl-Backspace is the one modifier combination the trainer owns.
            if (e.key === 'Backspace') {
                e.preventDefault();
                this.session.onInput(0, 'clearWord', e.timeStamp);
                this.renderText();
                return;
            }
            return;     // ⌘R, ⌘L, copy/paste: still the browser's
        }
        if (e.key === 'Escape') { e.preventDefault(); this.restart(); return; }
        if (e.key === 'Tab') return;    // focus must always be able to leave

        let control = null;
        let codePoint = 0;
        if (e.key === 'Backspace') {
            control = 'clearChar';
        } else if (e.key === 'Enter') {
            codePoint = 32;             // a line break inside a lesson is a space
            control = 'char';
        } else if ([...e.key].length === 1) {
            codePoint = e.key.codePointAt(0);
            control = 'char';
        } else {
            return;                     // arrows, F-keys, modifiers alone
        }
        e.preventDefault();

        const feedback = this.session.onInput(codePoint, control, e.timeStamp);
        if (feedback === Feedback.Failed && this.settings.errorSound) this.#beep();
        this.renderText();
        this.renderLive();
        if (this.session.completed) this.#finish();
    }

    #beep() {
        try {
            const ctx = (this.audio ??= new AudioContext());
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 220;
            gain.gain.value = 0.06;
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.05);
        } catch { /* audio is a nicety, never a failure */ }
    }

    // ------------------------------------------------------------ render

    render() {
        this.textEl = el('div', {
            class: 'tr-text', tabindex: '0', role: 'textbox',
            'aria-label': 'Typing practice text',
            onkeydown: (e) => this.#onKeyDown(e),
            onfocus: () => this.textEl.classList.add('focused'),
            onblur: () => this.textEl.classList.remove('focused'),
        });
        this.progressEl = el('div', { class: 'tr-progress' }, el('span'));
        this.liveEl = el('div', { class: 'tr-live' });
        this.keysEl = el('div', { class: 'tr-keys' });
        this.resultEl = el('div', { class: 'tr-result-slot' });
        this.profileEl = el('div', { class: 'tr-profile-slot' });
        this.settingsEl = el('div', { class: 'tr-settings-slot' });

        this.root.replaceChildren(
            this.#toolbar(),
            el('div', { class: 'tr-stage' },
                this.textEl,
                this.progressEl,
                this.liveEl),
            this.keysEl,
            this.resultEl,
            this.settingsEl,
            this.profileEl);
        this.#syncToolbar();
    }

    #toolbar() {
        this.typeStrip = el('div', { class: 'layer-strip tr-types' },
            ...LESSON_TYPES.map((t) => el('button', {
                'data-type': t.id, text: t.label, title: t.hint,
                onclick: () => this.#set('lessonType', t.id),
            })));
        this.targetEl = el('span', {
            class: 'tr-target',
            title: 'A letter unlocks once you type it at this speed. The one knob that makes the whole trainer harder.',
        });
        this.settingsBtn = el('button', {
            class: 'btn small', text: 'Settings',
            onclick: () => this.#toggle('showSettings'),
        });
        this.profileBtn = el('button', {
            class: 'btn small', text: 'Progress',
            onclick: () => this.#toggle('showProfile'),
        });
        return el('div', { class: 'tr-bar' },
            this.typeStrip,
            el('span', { class: 'tr-bar-gap' }),
            this.targetEl,
            // Only in the standalone trainer: with a keyboard connected the
            // other tabs are the way out.
            this.app?.trainerOnly
                ? el('button', {
                    class: 'btn small', text: 'Close trainer',
                    title: 'Back to the device list',
                    onclick: () => this.app.exitTrainer?.(),
                }) : null,
            el('button', {
                class: 'btn small', text: 'New text', title: 'Esc does the same',
                onclick: () => this.restart(),
            }),
            this.settingsBtn,
            this.profileBtn);
    }

    /**
     * Open or close a panel WITHOUT rebuilding the practice box — a rebuild
     * drops keyboard focus, and losing focus mid-lesson means the next
     * keystroke goes nowhere.
     */
    #toggle(which) {
        this[which] = !this[which];
        this.#syncToolbar();
        if (which === 'showSettings') {
            if (this.showSettings) this.renderSettings(); else this.settingsEl.replaceChildren();
        } else if (this.showProfile) {
            this.renderProfile();
        } else {
            this.profileEl.replaceChildren();
        }
    }

    #syncToolbar() {
        for (const b of this.typeStrip.children) {
            b.classList.toggle('shown', b.dataset.type === this.settings.lessonType);
        }
        this.targetEl.textContent = `target ${fmtWpm(this.settings.targetSpeed)} wpm`;
        this.settingsBtn.classList.toggle('primary', this.showSettings);
        this.profileBtn.classList.toggle('primary', this.showProfile);
    }

    #set(key, value) {
        this.settings[key] = value;
        this.store.saveSettings(this.settings);
        this.lastResult = null;
        this.unlocked = null;
        this.#syncToolbar();
        this.newLesson();
        this.renderResult();
        if (this.showSettings) this.renderSettings();
        if (this.showProfile) this.renderProfile();
        this.textEl.focus();
    }

    // ---- the text itself

    renderText() {
        const chars = this.session.chars;
        const glyph = WHITESPACE_GLYPH[this.settings.whitespace] ?? ' ';
        const caret = `caret-${this.settings.caret}`;
        // Characters are grouped into word boxes rather than emitted as one
        // long run of spans: a browser will happily break a line between two
        // adjacent inline spans, so a flat span-per-character layout rewraps
        // words mid-word as you type. The word box is inline-block/nowrap, so
        // lines break at spaces the way text is supposed to.
        //
        // The whole block is rebuilt per keystroke on purpose. A lesson is ~200
        // characters; a node-diffing scheme here measured no faster and got the
        // garbage-buffer insert wrong in three different ways.
        const nodes = [];
        let word = null;
        for (const c of chars) {
            if (c.codePoint === 32) {
                word = null;
                const pendingWs = c.attr === Attr.Cursor && this.session.input.typo ? ' typo' : '';
                nodes.push(el('span', { class: `${ATTR_CLASS[c.attr]} ws${pendingWs}` }, glyph));
                continue;
            }
            if (word == null) nodes.push((word = el('span', { class: 'tr-word' })));
            // With "stop on error" on, a wrong key advances nothing and buffers
            // nothing visible — without this the only feedback for a mistake is
            // that the caret stopped moving, which reads as a dropped keystroke.
            const pending = c.attr === Attr.Cursor && this.session.input.typo ? ' typo' : '';
            word.append(el('span', { class: `${ATTR_CLASS[c.attr]}${pending}` },
                String.fromCodePoint(c.codePoint)));
        }
        this.textEl.className = `tr-text ${caret}${this.textEl.classList.contains('focused') ? ' focused' : ''}`;
        this.textEl.replaceChildren(...nodes);
        this.progressEl.firstChild.style.transform = `scaleX(${this.session.progress.toFixed(4)})`;
    }

    renderLive() {
        const s = liveStats(this.session.steps);
        const stat = (label, value, title) => el('span', { class: 'tr-stat', title },
            el('b', { text: value }), el('i', { text: label }));
        const idle = this.session.startedAt == null;
        this.liveEl.replaceChildren(
            stat('wpm', idle ? '—' : fmtWpm(s.speed), 'Words per minute, five characters to a word'),
            stat('accuracy', idle ? '—' : fmtPct(s.accuracy), 'Correct keystrokes out of all keystrokes'),
            stat('errors', idle ? '—' : String(s.errors)),
            stat('elapsed', idle ? '—' : fmtDur(s.time)),
            el('span', { class: 'tr-bar-gap' }),
            el('span', {
                class: 'tr-hint',
                text: idle
                    ? 'Click the text and start typing. Esc for new text.'
                    : `${this.lesson.keys.focused() ? `drilling ${this.lesson.keys.focused().letter.label}` : ''}`,
            }));
    }

    // ---- keys in play

    renderKeys() {
        const target = new Target(this.settings.targetSpeed);
        const included = this.lesson.keys.included();
        const next = this.lesson.keys.excluded()[0] ?? null;
        const guided = this.settings.lessonType === 'guided';

        const chip = (key, muted) => {
            const conf = (this.settings.recoverKeys ? key.confidence : key.bestConfidence) ?? 0;
            const pct = Math.max(0, Math.min(1, conf)) * 100;
            const wpm = key.timeToType ? fmtWpm(timeToSpeed(key.timeToType)) : '—';
            const chipEl = el('div', {
                class: `tr-key${key.isFocused ? ' focused' : ''}${key.isForced ? ' forced' : ''}${muted ? ' muted' : ''}`,
                title: muted
                    ? `${key.letter.label} — not unlocked yet`
                    : `${key.letter.label} — ${wpm} wpm, confidence ${conf.toFixed(2)}`
                        + `${key.isFocused ? ', being drilled now' : ''}`
                        + `${key.isForced ? ', in play because of the alphabet-size slider' : ''}`,
            },
                el('span', { class: 'tr-key-fill' }),
                el('span', { class: 'tr-key-label', text: key.letter.label }));
            chipEl.firstChild.style.transform = `scaleY(${(pct / 100).toFixed(3)})`;
            chipEl.firstChild.style.background = heatColor(conf);
            return chipEl;
        };

        this.keysEl.replaceChildren(
            el('span', { class: 'tr-keys-label', text: guided ? 'letters in play' : 'keys tracked' }),
            ...included.map((k) => chip(k, false)),
            ...(guided && next
                ? [el('span', { class: 'tr-keys-next', text: 'next' }), chip(next, true)]
                : []),
            el('span', { class: 'tr-bar-gap' }),
            el('span', {
                class: 'tr-hint',
                title: 'Confidence is the target speed divided by your actual speed on that key. Every letter in play has to reach 1.00 before a new one joins.',
                text: guided
                    ? `${included.length} of ${this.lesson.keys.keys.length} · confidence ${
                        included.filter((k) => ((this.settings.recoverKeys ? k.confidence : k.bestConfidence) ?? 0) >= 1).length
                    }/${included.length} at target`
                    : `target ${(target.time).toFixed(0)} ms per key`,
            }));
    }

    // ---- the result of the lesson just finished

    renderResult() {
        const r = this.lastResult;
        if (r == null) { this.resultEl.replaceChildren(); return; }
        const prior = this.store.results.slice(-6, -1);
        const priorSpeed = prior.length
            ? prior.reduce((a, b) => a + b.speed, 0) / prior.length : null;
        const delta = priorSpeed == null ? null : cpmToWpm(r.speed - priorSpeed);

        const stat = (label, value, extra) => el('div', { class: 'tr-rstat' },
            el('b', { text: value }), el('i', { text: label }), extra ?? null);

        this.resultEl.replaceChildren(el('div', { class: 'tr-result' },
            stat('wpm', fmtWpm(r.speed), delta == null ? null : el('em', {
                class: delta >= 0 ? 'up' : 'down',
                text: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs last five`,
            })),
            stat('accuracy', fmtPct(r.accuracy)),
            stat('errors', String(r.errors)),
            stat('time', fmtDur(r.time)),
            el('span', { class: 'tr-bar-gap' }),
            this.unlocked
                ? el('div', { class: 'tr-unlock' },
                    el('b', { text: this.unlocked }),
                    el('span', { text: `unlocked — ${this.previousAlphabet} letters became ${this.previousAlphabet + 1}` }))
                : el('div', { class: 'tr-hint tr-unlock-none' },
                    noUnlockReason(this.lesson, this.settings))));
    }

    // ---- settings

    renderSettings() {
        const s = this.settings;
        const set = (key) => async (v) => {
            s[key] = v;
            this.store.saveSettings(s);
            // Text-shape settings change the next lesson, not this one; input
            // behaviour applies immediately to the session in progress.
            if (['stopOnError', 'forgiveErrors', 'spaceSkipsWords'].includes(key)) {
                this.session.input[key] = v;
            } else if (['whitespace', 'caret', 'errorSound', 'dailyGoal'].includes(key)) {
                this.renderText();
            } else {
                this.newLesson();
            }
            this.renderKeys();
            return v;
        };

        const lessonRows = [
            sliderRow({
                label: 'Target speed', hint: 'A letter unlocks when you reach this speed on it',
                min: 15, max: 150, step: 1, value: Math.round(cpmToWpm(s.targetSpeed)),
                format: (v) => `${v} wpm`,
                onChange: async (v) => { await set('targetSpeed')(wpmToCpm(v)); return v; },
            }),
            sliderRow({
                label: 'Lesson length', hint: 'Characters of text per lesson',
                min: 0, max: 100, step: 5, value: Math.round(s.lessonLength * 100),
                format: (v) => `${100 + v} chars`,
                onChange: async (v) => { await set('lessonLength')(v / 100); return v; },
            }),
        ];

        if (s.lessonType === 'guided') {
            lessonRows.push(
                sliderRow({
                    label: 'Alphabet size',
                    hint: 'Force extra letters in before you have earned them',
                    min: 0, max: 100, step: 5, value: Math.round(s.alphabetSize * 100),
                    format: (v) => (v === 0 ? 'earned only' : `+${v}%`),
                    onChange: async (v) => { await set('alphabetSize')(v / 100); return v; },
                }),
                toggleRow({
                    label: 'Natural words',
                    hint: 'Mix real words in once the unlocked letters can spell some',
                    value: s.naturalWords, onChange: set('naturalWords'),
                }),
                toggleRow({
                    label: 'Keyboard order',
                    hint: this.keyboard
                        ? 'Unlock the keys your fingers rest on first, instead of the most frequent letters'
                        : 'Needs a connected keyboard — no layout to read positions from',
                    value: s.keyboardOrder, onChange: set('keyboardOrder'),
                }),
                toggleRow({
                    label: 'Judge current speed',
                    hint: 'Off: a letter stays unlocked once it has ever hit the target. On: it must hold the target now.',
                    value: s.recoverKeys, onChange: set('recoverKeys'),
                }));
        }
        if (s.lessonType === 'words') {
            lessonRows.push(
                sliderRow({
                    label: 'Word list size', hint: 'How far down the frequency list to draw from',
                    min: 50, max: 4000, step: 50, value: s.wordListSize,
                    format: (v) => `${v} words`, onChange: set('wordListSize'),
                }),
                toggleRow({
                    label: 'Long words only', hint: 'Six characters and up',
                    value: s.longWordsOnly, onChange: set('longWordsOnly'),
                }));
        }
        if (s.lessonType === 'numbers') {
            lessonRows.push(toggleRow({
                label: "Benford's law",
                hint: 'Weight leading digits the way real-world numbers do',
                value: s.numbersBenford, onChange: set('numbersBenford'),
            }));
        }
        if (s.lessonType === 'custom') {
            const area = el('textarea', {
                class: 'tr-custom', rows: '4', spellcheck: 'false',
                placeholder: 'Paste the text you want to practise',
            });
            area.value = s.customText;
            area.addEventListener('change', () => set('customText')(area.value));
            lessonRows.push(
                el('div', { class: 'row tr-row-block' },
                    el('span', { class: 'lbl' }, 'Text',
                        el('span', { class: 'hint', text: 'Typed in order, or shuffled below' })),
                    area),
                toggleRow({ label: 'Lowercase', value: s.customLowercase, onChange: set('customLowercase') }),
                toggleRow({ label: 'Shuffle words', value: s.customRandomize, onChange: set('customRandomize') }));
        }
        if (s.lessonType !== 'numbers') {
            lessonRows.push(
                sliderRow({
                    label: 'Capitals', hint: 'Chance a word starts with a capital',
                    min: 0, max: 100, step: 5, value: Math.round(s.capitals * 100),
                    format: (v) => `${v}%`,
                    onChange: async (v) => { await set('capitals')(v / 100); return v; },
                }),
                sliderRow({
                    label: 'Punctuation', hint: 'Chance a word gains punctuation',
                    min: 0, max: 100, step: 5, value: Math.round(s.punctuators * 100),
                    format: (v) => `${v}%`,
                    onChange: async (v) => { await set('punctuators')(v / 100); return v; },
                }),
                sliderRow({
                    label: 'Repeat words', hint: 'Type each word this many times in a row',
                    min: 1, max: 5, step: 1, value: s.repeatWords,
                    format: (v) => (v === 1 ? 'once' : `${v}×`), onChange: set('repeatWords'),
                }));
        }

        const inputRows = [
            toggleRow({
                label: 'Stop on error',
                hint: 'Hold at the character you got wrong instead of collecting wrong characters',
                value: s.stopOnError, onChange: set('stopOnError'),
            }),
            toggleRow({
                label: 'Forgive errors',
                hint: 'Recover from one wrong or skipped character instead of failing the rest of the word',
                value: s.forgiveErrors, onChange: set('forgiveErrors'),
            }),
            toggleRow({
                label: 'Space skips words', hint: 'Space jumps to the next word, marking the rest wrong',
                value: s.spaceSkipsWords, onChange: set('spaceSkipsWords'),
            }),
            selectRow({
                label: 'Caret', value: s.caret, onChange: set('caret'),
                options: [
                    { value: 'underline', label: 'Underline' },
                    { value: 'block', label: 'Block' },
                    { value: 'line', label: 'Line' },
                ],
            }),
            selectRow({
                label: 'Spaces', value: s.whitespace, onChange: set('whitespace'),
                options: [
                    { value: 'bullet', label: 'Middle dot' },
                    { value: 'bar', label: 'Bar' },
                    { value: 'space', label: 'Blank' },
                ],
            }),
            toggleRow({ label: 'Sound on error', value: s.errorSound, onChange: set('errorSound') }),
            sliderRow({
                label: 'Daily goal', hint: 'Minutes of typing that count as a day practised',
                min: 0, max: 120, step: 5, value: s.dailyGoal,
                format: (v) => (v === 0 ? 'off' : `${v} min`), onChange: set('dailyGoal'),
            }),
        ];

        this.settingsEl.replaceChildren(el('div', { class: 'cards-row' },
            card('Lesson', LESSON_TYPES.find((t) => t.id === s.lessonType)?.label, ...lessonRows),
            card('Typing', 'How keystrokes are judged and drawn', ...inputRows),
            card('Progress data', `${this.store.results.length} lessons stored in this browser`,
                el('p', { class: 'faint', style: 'font-size:var(--fs-sm)' },
                    'Progress lives in this browser only. Export it to carry it to the Flask desktop app, which reads the same file.'),
                el('div', { class: 'savebar toolbar' },
                    el('button', { class: 'btn small', text: 'Export progress', onclick: () => this.#export() }),
                    el('button', { class: 'btn small', text: 'Import progress', onclick: () => this.#import() }),
                    el('button', {
                        class: 'btn small danger', text: 'Reset progress',
                        onclick: () => {
                            if (!confirm(`Delete all ${this.store.results.length} stored lessons? Every letter goes back to locked.`)) return;
                            this.store.clear();
                            this.lastResult = null;
                            this.unlocked = null;
                            this.newLesson();
                            this.renderResult();
                            if (this.showProfile) this.renderProfile();
                            this.renderSettings();
                            toast('Trainer progress reset');
                        },
                    })))));
    }

    #export() {
        const blob = new Blob([this.store.exportJSON(this.settings)], { type: 'application/json' });
        const a = el('a', {
            href: URL.createObjectURL(blob),
            download: `flask-trainer-${new Date().toISOString().slice(0, 10)}.json`,
        });
        a.click();
        URL.revokeObjectURL(a.href);
    }

    #import() {
        const input = el('input', { type: 'file', accept: '.json,application/json' });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (file == null) return;
            try {
                const { added, settings } = this.store.importJSON(await file.text());
                if (settings) {
                    this.settings = { ...this.settings, ...settings };
                    this.store.saveSettings(this.settings);
                }
                toast(added > 0 ? `Imported ${added} lessons` : 'Nothing new in that file');
                this.render();
                this.newLesson();
                this.renderSettings();
                if (this.showProfile) this.renderProfile();
            } catch (e) {
                toast(`Import failed: ${e.message}`, true);
            }
        });
        input.click();
    }

    // ---- progress

    renderProfile() {
        const results = this.store.results;
        if (results.length === 0) {
            this.profileEl.replaceChildren(card('Progress', 'nothing recorded yet',
                el('p', { class: 'faint' },
                    'Finish a lesson and this fills with your speed history, a per-letter breakdown, and — with a keyboard connected — a heatmap on the real board.')));
            return;
        }
        const sum = summaryStats(results);
        const daily = dailyStats(results, this.settings.dailyGoal);
        const keys = this.lesson.keys;

        this.profileEl.replaceChildren(
            el('div', { class: 'cards-row' },
                card('Speed', `${results.length} lessons · best ${fmtWpm(sum.bestSpeed)} wpm`,
                    this.#speedChart(results),
                    el('div', { class: 'tr-live' },
                        el('span', { class: 'tr-stat' }, el('b', { text: fmtWpm(sum.speed) }), el('i', { text: 'wpm overall' })),
                        el('span', { class: 'tr-stat' }, el('b', { text: fmtPct(sum.accuracy) }), el('i', { text: 'accuracy' })),
                        el('span', { class: 'tr-stat' }, el('b', { text: fmtDur(sum.time) }), el('i', { text: 'typing time' })),
                        el('span', { class: 'tr-stat' }, el('b', { text: String(sum.chars) }), el('i', { text: 'characters' })))),
                card('Practice', daily.streak > 0
                    ? `${daily.streak}-day streak`
                    : (this.settings.dailyGoal > 0 ? 'no streak yet' : 'daily goal off'),
                    this.#dailyChart(daily),
                    this.settings.dailyGoal > 0
                        ? el('div', {},
                            el('div', { class: 'tr-progress tr-goal' }, el('span')),
                            el('div', { class: 'tr-hint', text: `${fmtDur(daily.today.time)} of ${this.settings.dailyGoal} min today` }))
                        : null)),
            card('Letters', 'confidence 1.00 is the target speed — the gate a new letter waits behind',
                this.#keyTable(keys)),
            ...(this.keyboard && this.app?.profile
                ? [card('On the board', 'per-key speed painted onto your layout',
                    this.#heatmap())]
                : []));

        if (this.settings.dailyGoal > 0) {
            const bar = this.profileEl.querySelector('.tr-goal span');
            if (bar) {
                bar.style.transform = `scaleX(${daily.goalProgress.toFixed(4)})`;
                bar.style.background = daily.goalProgress >= 1 ? 'var(--ok)' : 'var(--accent)';
            }
        }
    }

    /** Speed per lesson, with a five-lesson mean over the top. */
    #speedChart(results) {
        const W = 520;
        const H = 150;
        const pad = { l: 30, r: 6, t: 8, b: 16 };
        const wpms = results.map((r) => cpmToWpm(r.speed));
        const targetWpm = cpmToWpm(this.settings.targetSpeed);
        const maxY = Math.max(targetWpm * 1.15, ...wpms) * 1.05;
        const x = (i) => pad.l + (W - pad.l - pad.r) * (results.length < 2 ? 0.5 : i / (results.length - 1));
        const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);

        const mean = [];
        for (let i = 0; i < wpms.length; i++) {
            const from = Math.max(0, i - 4);
            const slice = wpms.slice(from, i + 1);
            mean.push(slice.reduce((a, b) => a + b, 0) / slice.length);
        }
        const path = (vals) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

        return svgEl('svg', { class: 'tr-chart', viewBox: `0 0 ${W} ${H}` },
            // The target line is the only gridline that means anything here.
            svgEl('line', {
                class: 'tr-chart-target', x1: pad.l, x2: W - pad.r, y1: y(targetWpm), y2: y(targetWpm),
            }),
            svgEl('text', { class: 'tr-chart-label', x: 2, y: y(targetWpm) + 3 }, String(Math.round(targetWpm))),
            // The baseline label is dropped when the target line has sunk close
            // to it (one freak-fast lesson can rescale the axis), rather than
            // letting two numbers overprint each other.
            y(targetWpm) < H - pad.b - 12
                ? svgEl('text', { class: 'tr-chart-label', x: 2, y: H - pad.b + 4 }, '0')
                : null,
            svgEl('polyline', { class: 'tr-chart-dots', points: wpms.map((v, i) => `${x(i)},${y(v)}`).join(' ') }),
            svgEl('path', { class: 'tr-chart-line', d: path(mean) }));
    }

    /** Minutes practised per day, last 30 days. */
    #dailyChart(daily) {
        const days = daily.days.slice(-30);
        const W = 520;
        const H = 150;
        const maxT = Math.max(daily.goalMs || 0, ...days.map((d) => d.time), 1);
        const bw = (W - 4) / Math.max(days.length, 10);
        return svgEl('svg', { class: 'tr-chart', viewBox: `0 0 ${W} ${H}` },
            ...(daily.goalMs > 0 ? [svgEl('line', {
                class: 'tr-chart-target', x1: 0, x2: W, y1: H * (1 - daily.goalMs / maxT), y2: H * (1 - daily.goalMs / maxT),
            })] : []),
            ...days.map((d, i) => {
                const h = Math.max(2, (H - 4) * (d.time / maxT));
                return svgEl('rect', {
                    class: `tr-chart-bar${d.time >= daily.goalMs && daily.goalMs > 0 ? ' met' : ''}`,
                    x: (2 + i * bw).toFixed(1), y: (H - h).toFixed(1),
                    width: Math.max(1, bw - 2).toFixed(1), height: h.toFixed(1),
                });
            }));
    }

    #keyTable(keys) {
        const rows = keys.keys.filter((k) => k.samples.length > 0 || k.isIncluded);
        const grid = el('div', { class: 'tr-table' },
            el('span', { class: 'tr-th', text: 'key' }),
            el('span', { class: 'tr-th', text: 'confidence' }),
            el('span', { class: 'tr-th num', text: 'wpm' }),
            el('span', { class: 'tr-th num', text: 'best' }),
            el('span', { class: 'tr-th num', text: 'hits' }),
            el('span', { class: 'tr-th num', text: 'misses' }),
            el('span', { class: 'tr-th', text: 'trend' }));
        for (const k of rows) {
            const conf = (this.settings.recoverKeys ? k.confidence : k.bestConfidence) ?? 0;
            const rate = learningRate(k.samples, this.settings.targetSpeed);
            const bar = el('span', { class: 'tr-tbar' }, el('span'));
            bar.firstChild.style.transform = `scaleX(${Math.min(1, conf).toFixed(3)})`;
            bar.firstChild.style.background = heatColor(conf);
            grid.append(
                el('span', {
                    class: `tr-tkey${k.isFocused ? ' focused' : ''}${k.isIncluded ? '' : ' muted'}`,
                    text: k.letter.label,
                }),
                el('span', { class: 'tr-tcell' }, bar, el('em', { text: conf > 0 ? conf.toFixed(2) : '—' })),
                el('span', { class: 'tr-tcell num', text: k.timeToType ? fmtWpm(timeToSpeed(k.timeToType)) : '—' }),
                el('span', { class: 'tr-tcell num', text: k.bestTimeToType ? fmtWpm(timeToSpeed(k.bestTimeToType)) : '—' }),
                el('span', { class: 'tr-tcell num', text: String(k.hitCount) }),
                el('span', { class: 'tr-tcell num', text: String(k.missCount) }),
                el('span', {
                    class: 'tr-tcell tr-trend',
                    title: rate ? `fit certainty ${(rate.certainty * 100).toFixed(0)}%` : 'not enough lessons to fit a trend',
                    text: rate == null ? '—'
                        : rate.remainingLessons != null
                            ? `${rate.remainingLessons} lesson${rate.remainingLessons === 1 ? '' : 's'} to target`
                            : `${rate.learningRate >= 0 ? '+' : ''}${cpmToWpm(rate.learningRate).toFixed(2)} wpm/lesson`,
                }));
        }
        return grid;
    }

    /** The heatmap — per-key speed on the real board geometry. */
    #heatmap() {
        const { app } = this;
        const keyStatsMap = this.keyStatsMap;
        const target = new Target(this.settings.targetSpeed);
        const wrap = el('div', { class: 'kb-wrap' }, renderKeyboardSVG({
            profile: app.profile,
            keycodeAt: (row, col) => app.keymap?.[0]?.[row]?.[col] ?? 0,
            fillFor: (key) => {
                const cp = this.keyboard.charAt(key.row, key.col);
                if (cp == null) return null;
                const stats = keyStatsMap.get(cp);
                const conf = target.confidence(
                    this.settings.recoverKeys ? stats?.timeToType : stats?.bestTimeToType);
                if (conf == null) return null;   // untyped keys keep the plain keycap
                return heatColor(conf);
            },
        }));
        return el('div', {},
            wrap,
            el('div', { class: 'tr-legend' },
                el('span', { class: 'tr-swatch', style: `background:${heatColor(0)}` }),
                el('span', { class: 'tr-hint', text: 'below target' }),
                el('span', { class: 'tr-swatch', style: `background:${heatColor(1)}` }),
                el('span', { class: 'tr-hint', text: 'at target' }),
                el('span', { class: 'tr-swatch plain' }),
                el('span', { class: 'tr-hint', text: 'not typed yet' })));
    }
}

/** Why no letter was unlocked — the answer people actually want. */
function noUnlockReason(lesson, settings) {
    if (settings.lessonType !== 'guided') return 'Switch to Guided to unlock letters as you improve.';
    const included = lesson.keys.included();
    const behind = included.filter((k) => ((settings.recoverKeys ? k.confidence : k.bestConfidence) ?? 0) < 1);
    if (behind.length === 0) return 'Every letter is at target — the next one joins on the next lesson.';
    if (behind.length === 1) return `${behind[0].letter.label} is the only letter still short of the target.`;
    return `${behind.length} letters still short of the target: ${behind.slice(0, 6).map((k) => k.letter.label).join(' ')}`;
}
