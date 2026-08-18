// The typing state machine: what happens to the text as keys arrive.
//
// Ported from keybr.com's published input behaviour, which is more forgiving
// than a naive "wrong key = wrong character" model in two specific ways worth
// keeping:
//
//   - REPLACED character: you typed `x` where `a` was expected and then carried
//     on correctly (`xbcd` against `abcd`). Once three following characters
//     match, the input recovers — one error, not five.
//   - SKIPPED character: you missed `a` entirely and typed `bcd`. Same deal.
//
// Without that, a single early slip turns the rest of a lesson into garbage and
// the per-key statistics record nonsense for keys you actually typed correctly.
//
// KEEP IN SYNC with AdeptCompanion's Sources/AdeptCore/TrainerTextInput.swift.

export const Feedback = { Succeeded: 0, Recovered: 1, Failed: 2 };

/** Render state of one character of the lesson text. */
export const Attr = {
    Normal: 0,   // not yet typed
    Hit: 1,      // typed correctly first time
    Miss: 2,     // typed correctly, but only after a typo here
    Garbage: 3,  // a wrong character the user has not cleared yet
    Cursor: 4,   // the character to type next
};

export const SPACE = 32;

/** Characters that must match before a replace/skip counts as recovered. */
const RECOVER_BUFFER = 3;

/** Wrong characters kept on screen before further ones are dropped. */
const GARBAGE_BUFFER = 10;

/**
 * Typographic characters a keyboard cannot produce, mapped to what it can.
 * Custom text pasted from a document is full of these, and failing a learner
 * for not owning an em-dash key would be absurd.
 */
const NORMALIZE = new Map([
    [0x2018, 0x27], [0x2019, 0x27],                 // ‘ ’ → '
    [0x201c, 0x22], [0x201d, 0x22],                 // “ ” → "
    [0x2013, 0x2d], [0x2014, 0x2d], [0x2212, 0x2d], // – — − → -
    [0x00a0, 0x20], [0x2009, 0x20], [0x202f, 0x20], // nbsp, thin spaces → space
    [0x2026, 0x2e],                                 // … → .
]);

const normalize = (codePoint) => NORMALIZE.get(codePoint) ?? codePoint;

export class TextInput {
    /**
     * @param text lesson text
     * @param settings { stopOnError, forgiveErrors, spaceSkipsWords }
     */
    constructor(text, settings) {
        this.text = text;
        this.codePoints = [...text].map((c) => c.codePointAt(0));
        this.stopOnError = settings.stopOnError !== false;
        this.forgiveErrors = settings.forgiveErrors !== false;
        this.spaceSkipsWords = settings.spaceSkipsWords === true;
        this.reset();
    }

    reset() {
        /** Committed keystrokes, one per character of text consumed. */
        this.steps = [];
        /** Wrong characters typed at the current position. */
        this.garbage = [];
        /** Whether the character at the cursor has already been fumbled. */
        this.typo = false;
    }

    get length() { return this.codePoints.length; }
    get pos() { return this.steps.length; }
    get completed() { return this.pos >= this.length; }
    at(index) { return this.codePoints[index]; }

    /**
     * Characters with render attributes, in display order: committed steps,
     * then any uncleared garbage, then the cursor and the remaining text.
     */
    chars() {
        const out = [];
        for (const step of this.steps) {
            out.push({ codePoint: step.charCodePoint, attr: step.typo ? Attr.Miss : Attr.Hit });
        }
        if (!this.stopOnError) {
            for (const g of this.garbage) out.push({ codePoint: g.codePoint, attr: Attr.Garbage });
        }
        for (let i = this.pos; i < this.length; i++) {
            out.push({ codePoint: this.codePoints[i], attr: i === this.pos ? Attr.Cursor : Attr.Normal });
        }
        return out;
    }

    /** Backspace: drops one uncleared wrong character, and marks the fumble. */
    clearChar() {
        this.garbage.pop();
        this.typo = true;
        return Feedback.Succeeded;
    }

    /** Ctrl-Backspace: back to the start of the current word. */
    clearWord() {
        this.garbage = [];
        while (this.pos > 0 && this.at(this.pos - 1) !== SPACE) this.steps.pop();
        this.typo = true;
        return Feedback.Succeeded;
    }

    /**
     * Feed one typed character. `timeToType` is the gap since the previous
     * keystroke in milliseconds — the number every per-key statistic is built
     * from, so it must come from the key event, never from a render tick.
     */
    appendChar(timeStamp, codePoint0, timeToType) {
        if (this.completed) return Feedback.Failed;
        const codePoint = normalize(codePoint0);
        const expected = this.at(this.pos);

        // Space in the middle of a word: either skip the rest of the word, or
        // ignore it as an over-eager space between clean words.
        if (expected !== SPACE && codePoint === SPACE) {
            if (this.spaceSkipsWords
                && ((this.pos > 0 && this.at(this.pos - 1) !== SPACE) || this.typo)) {
                this.#skipWord(timeStamp);
                return Feedback.Recovered;
            }
            if (this.garbage.length === 0 && !this.typo) return Feedback.Succeeded;
        }

        if ((expected === codePoint || normalize(expected) === codePoint)
            && (this.forgiveErrors || this.garbage.length === 0)) {
            const { typo } = this;
            this.#addStep({ timeStamp, codePoint, timeToType, typo }, expected);
            this.garbage = [];
            this.typo = false;
            return typo ? Feedback.Recovered : Feedback.Succeeded;
        }

        this.typo = true;
        if (!this.stopOnError || this.forgiveErrors) {
            if (this.garbage.length < GARBAGE_BUFFER) {
                this.garbage.push({ timeStamp, codePoint, timeToType, typo: false });
            }
        }
        if (this.forgiveErrors && (this.#recoverReplaced() || this.#recoverSkipped())) {
            return Feedback.Recovered;
        }
        return Feedback.Failed;
    }

    #addStep(step, charCodePoint) {
        this.steps.push({ ...step, charCodePoint });
    }

    /** Space past the rest of a word, marking every skipped character wrong. */
    #skipWord(timeStamp) {
        while (this.pos < this.length && this.at(this.pos) !== SPACE) {
            this.#addStep({ timeStamp, codePoint: this.at(this.pos), timeToType: 0, typo: true },
                this.at(this.pos));
        }
        if (this.pos < this.length && this.at(this.pos) === SPACE) {
            this.#addStep({ timeStamp, codePoint: SPACE, timeToType: 0, typo: false }, SPACE);
        }
        this.garbage = [];
        this.typo = false;
    }

    /** text: abcd, typed: xbcd — one wrong character, then back on track. */
    #recoverReplaced() {
        if (this.pos + RECOVER_BUFFER + 1 > this.length
            || this.garbage.length < RECOVER_BUFFER + 1) return false;
        for (let i = 0; i < RECOVER_BUFFER; i++) {
            if (this.at(this.pos + i + 1) !== this.garbage[i + 1].codePoint) return false;
        }
        this.#commitRecovery(1);
        return true;
    }

    /** text: abcd, typed: bcd — a character skipped, then back on track. */
    #recoverSkipped() {
        if (this.pos + RECOVER_BUFFER + 1 > this.length
            || this.garbage.length < RECOVER_BUFFER) return false;
        for (let i = 0; i < RECOVER_BUFFER; i++) {
            if (this.at(this.pos + i + 1) !== this.garbage[i].codePoint) return false;
        }
        this.#commitRecovery(0);
        return true;
    }

    /**
     * Bank a recovery: the expected character is recorded as one error, then
     * the buffered keystrokes from `from` onward are accepted as they were
     * typed. `timeToType` of the error step is zero — nobody typed it, so it
     * must not enter that key's speed history.
     */
    #commitRecovery(from) {
        this.#addStep({
            timeStamp: this.garbage[0].timeStamp,
            codePoint: this.at(this.pos), timeToType: 0, typo: true,
        }, this.at(this.pos));
        for (let i = from; i < this.garbage.length; i++) {
            const g = this.garbage[i];
            this.#addStep(g, g.codePoint);
        }
        this.garbage = [];
        this.typo = false;
    }
}

/**
 * A lesson in progress: turns key events into TextInput calls, keeps the clock,
 * and answers the live stat readout.
 *
 * The clock starts on the FIRST keystroke, not when the lesson is displayed —
 * otherwise reading the text costs you speed.
 */
export class TypingSession {
    constructor(text, settings) {
        this.input = new TextInput(text, settings);
        this.settings = settings;
        this.startedAt = null;
        this.lastAt = null;
    }

    get completed() { return this.input.completed; }
    get steps() { return this.input.steps; }
    get chars() { return this.input.chars(); }

    /** Fraction of the text consumed, for the progress bar. */
    get progress() {
        return this.input.length > 0 ? this.input.pos / this.input.length : 0;
    }

    /** Milliseconds since the first keystroke. */
    get elapsed() {
        return this.startedAt == null ? 0 : (this.lastAt ?? this.startedAt) - this.startedAt;
    }

    /**
     * @param codePoint the character typed
     * @param control 'char' | 'clearChar' | 'clearWord'
     * @param timeStamp performance.now() of the key event
     */
    onInput(codePoint, control, timeStamp) {
        if (control === 'clearChar') return this.input.clearChar();
        if (control === 'clearWord') return this.input.clearWord();
        if (this.startedAt == null) {
            this.startedAt = timeStamp;
            this.lastAt = timeStamp;
            // The first keystroke has no predecessor to be timed against. It
            // is still recorded (the lesson has to start somewhere) but the
            // statistics layer drops step 0 for exactly this reason.
            return this.input.appendChar(timeStamp, codePoint, 0);
        }
        const timeToType = Math.max(0, Math.round(timeStamp - this.lastAt));
        this.lastAt = timeStamp;
        return this.input.appendChar(timeStamp, codePoint, timeToType);
    }
}

/** Live speed/accuracy from a partial step list — the same maths as the result. */
export function liveStats(steps) {
    if (steps.length < 2) return { speed: 0, accuracy: 1, errors: 0, length: steps.length, time: 0 };
    const time = steps[steps.length - 1].timeStamp - steps[0].timeStamp;
    let errors = 0;
    for (const s of steps) if (s.typo) errors += 1;
    return {
        time,
        length: steps.length,
        errors,
        accuracy: (steps.length - errors) / steps.length,
        speed: time > 0 ? (steps.length / (time / 1000)) * 60 : 0,
    };
}
