// Lesson generation for the typing trainer — which letters are in play, which
// one is being drilled, and the text that comes out.
//
// The guided algorithm is keybr.com's, reimplemented from its published
// behaviour:
//
//   1. Letters are ordered by frequency (or by keyboard position).
//   2. The first six are always in play.
//   3. A seventh letter joins only once every letter already in play has hit
//      confidence 1 — i.e. has been typed at or above the target speed.
//   4. Whichever key in play is furthest from the target becomes the FOCUS,
//      and every generated word contains it.
//
// KEEP IN SYNC with AdeptCompanion's Sources/AdeptCore/TrainerLesson.swift.

import {
    Filter, findWords, makeRNG, randomSample, weightedSample, SPACE,
} from './trainer-model.js?v=41';
import { WORDS } from './trainer-words.js?v=41';
import { speedToTime, wpmToCpm } from './trainer-stats.js?v=41';

/** Letters always in play, however badly they are going. keybr's floor. */
const MIN_ALPHABET = 6;

/** Lesson text length, in characters, at lessonLength 0 and 1. */
const LENGTH_MIN = 100;
const LENGTH_SPAN = 100;

export const LESSON_TYPES = [
    { id: 'guided', label: 'Guided', hint: 'Adaptive — unlocks letters as you earn them' },
    { id: 'words', label: 'Word list', hint: 'The 4000 most common English words' },
    { id: 'numbers', label: 'Numbers', hint: 'Digit runs, Benford-weighted' },
    { id: 'custom', label: 'Custom text', hint: 'Your own text' },
];

export const DEFAULT_SETTINGS = {
    lessonType: 'guided',
    /** Characters per minute. 175 CPM = 35 WPM, keybr's default. */
    targetSpeed: 175,
    /** 0 = the minimum six letters, 1 = the whole alphabet. */
    alphabetSize: 0,
    /** Judge letters on their CURRENT speed rather than their best-ever. */
    recoverKeys: false,
    /** Mix real words in once the unlocked letters can spell some. */
    naturalWords: true,
    /** Unlock in keyboard-position order instead of language-frequency order. */
    keyboardOrder: false,
    /** Probability a word gets capitalised / gains punctuation. */
    capitals: 0,
    punctuators: 0,
    /** 0..1 → 100..200 characters of text. */
    lessonLength: 0,
    /** Type each word this many times in a row. */
    repeatWords: 1,
    numbersBenford: true,
    wordListSize: 1000,
    longWordsOnly: false,
    customText: 'The quick brown fox jumps over the lazy dog.',
    customLowercase: true,
    customRandomize: false,
    // Text input behaviour — see trainer-textinput.js.
    stopOnError: true,
    forgiveErrors: true,
    spaceSkipsWords: false,
    // Presentation.
    whitespace: 'bullet',
    caret: 'underline',
    errorSound: false,
    /** Minutes of typing that count as a day's practice. */
    dailyGoal: 30,
};

/** Punctuation keybr can sprinkle in, with rough English frequencies. */
const PUNCTUATORS = [
    { codePoint: 0x2e, f: 10 },  // .
    { codePoint: 0x2c, f: 10 },  // ,
    { codePoint: 0x27, f: 4 },   // '
    { codePoint: 0x22, f: 3 },   // "
    { codePoint: 0x3f, f: 2 },   // ?
    { codePoint: 0x21, f: 2 },   // !
    { codePoint: 0x3b, f: 1 },   // ;
    { codePoint: 0x3a, f: 1 },   // :
    { codePoint: 0x2d, f: 1 },   // -
];

// ---------------------------------------------------------------- target

/**
 * How a key's measured speed becomes a 0..1+ progress number.
 *
 * confidence = time the target allows per character / time you actually take.
 * 1.0 means "at target". Everything in the guided algorithm is a comparison
 * against 1.0, which is why the target speed is the single knob that makes the
 * whole trainer easier or harder.
 */
export class Target {
    constructor(targetSpeed) {
        this.targetSpeed = targetSpeed;
        this.time = speedToTime(targetSpeed);
    }

    confidence(timeToType) {
        if (timeToType == null || !Number.isFinite(timeToType) || timeToType <= 0) return null;
        return this.time / timeToType;
    }
}

// ---------------------------------------------------------------- lesson keys

/**
 * The letters of a lesson, each tagged with how it is being treated.
 *
 *   included — may appear in the text
 *   forced   — included only to satisfy the alphabet-size slider, not earned
 *   focused  — the weakest included key; appears in EVERY word
 */
export class LessonKeys {
    constructor(keys) {
        this.keys = keys;
        this.byCodePoint = new Map(keys.map((k) => [k.letter.codePoint, k]));
    }

    get(codePoint) { return this.byCodePoint.get(codePoint) ?? null; }
    included() { return this.keys.filter((k) => k.isIncluded); }
    excluded() { return this.keys.filter((k) => !k.isIncluded); }
    focused() { return this.keys.find((k) => k.isFocused) ?? null; }

    include(key) { key.isIncluded = true; }
    force(key) { key.isIncluded = true; key.isForced = true; }
    focus(key) { key.isIncluded = true; key.isFocused = true; }
}

function lessonKey(stats, target) {
    return {
        letter: stats.letter,
        samples: stats.samples,
        hitCount: stats.hitCount,
        missCount: stats.missCount,
        timeToType: stats.timeToType,
        bestTimeToType: stats.bestTimeToType,
        confidence: target.confidence(stats.timeToType),
        bestConfidence: target.confidence(stats.bestTimeToType),
        isIncluded: false,
        isForced: false,
        isFocused: false,
    };
}

/**
 * Decide the alphabet for the next guided lesson.
 *
 * `letters` must already be in unlock order — the caller chooses frequency or
 * keyboard order. Everything past the alphabet-size window is excluded, and the
 * first letter that fails the confidence gate stops the unlocking there.
 */
export function guidedKeys(letters, keyStatsMap, settings) {
    const target = new Target(settings.targetSpeed);
    const maxSize = MIN_ALPHABET
        + Math.round((letters.length - MIN_ALPHABET) * settings.alphabetSize);
    const keys = new LessonKeys(letters.map((letter) => lessonKey(
        keyStatsMap.get(letter.codePoint)
            ?? { letter, samples: [], hitCount: 0, missCount: 0, timeToType: null, bestTimeToType: null },
        target)));
    const confidenceOf = (k) => (settings.recoverKeys
        ? (k.confidence ?? 0) : (k.bestConfidence ?? 0));

    for (const key of keys.keys) {
        const included = keys.included();
        if (included.length < MIN_ALPHABET) { keys.include(key); continue; }
        if (included.length < maxSize) { keys.force(key); continue; }
        // A key that has ever been at target stays in play — dropping it would
        // let the alphabet shrink under a bad day.
        if ((key.bestConfidence ?? 0) >= 1) { keys.include(key); continue; }
        if (included.every((k) => confidenceOf(k) >= 1)) { keys.include(key); continue; }
    }

    const weakest = keys.included()
        .filter((k) => confidenceOf(k) < 1)
        .sort((a, b) => confidenceOf(a) - confidenceOf(b))[0];
    if (weakest != null) keys.focus(weakest);
    return keys;
}

/** Word-list, numbers and custom-text lessons still report per-key stats. */
export function allKeys(letters, keyStatsMap, settings) {
    const target = new Target(settings.targetSpeed);
    const keys = new LessonKeys(letters.map((letter) => lessonKey(
        keyStatsMap.get(letter.codePoint)
            ?? { letter, samples: [], hitCount: 0, missCount: 0, timeToType: null, bestTimeToType: null },
        target)));
    for (const key of keys.keys) keys.include(key);
    return keys;
}

// ---------------------------------------------------------------- letter order

/**
 * Unlock order. Frequency order is keybr's default and gives ETAOIN…; keyboard
 * order weights each letter by where it sits on THIS keyboard, so the Svalboard
 * teaches the cluster centres first — the eight keys your fingers rest on —
 * before the up/down/side directions.
 */
export function orderLetters(model, keyboard, keyboardOrder) {
    const letters = model.lettersIn(keyboard?.codePoints ?? null);
    if (!keyboardOrder || keyboard?.weightOf == null) return letters;
    return [...letters].sort((a, b) => (
        (keyboard.weightOf(b.codePoint) * b.f) - (keyboard.weightOf(a.codePoint) * a.f)));
}

// ---------------------------------------------------------------- text

const capitalise = (w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1));

/** Wraps a word generator so the same word never lands twice in a row. */
function uniqueWords(nextWord) {
    let last = '';
    return () => {
        for (let n = 0; n < 3; n++) {
            const word = nextWord();
            if (!word) return null;
            if (word !== last) { last = word; return word; }
        }
        // Three collisions in a row means the alphabet is genuinely tiny —
        // repeating beats stalling.
        return last;
    };
}

/** Applies the capitals / punctuation sliders to a word stream. */
function mangledWords(nextWord, { capitals, punctuators }, rng) {
    return () => {
        let word = nextWord();
        if (!word) return null;
        if (capitals > 0 && capitals >= rng()) word = capitalise(word);
        if (punctuators > 0 && punctuators >= rng()) {
            const { codePoint } = weightedSample(PUNCTUATORS, (p) => p.f, rng);
            switch (codePoint) {
                case 0x21: word = `${word}!`; break;
                case 0x22: word = `"${word}"`; break;
                case 0x27: word = `'${word}'`; break;
                case 0x2c: word = `${word},`; break;
                case 0x2d: word = `${word}-${nextWord() || 'and'}`; break;
                case 0x2e: word = `${word}.`; break;
                case 0x3a: word = `${word}:`; break;
                case 0x3b: word = `${word};`; break;
                case 0x3f: word = `${word}?`; break;
            }
        }
        return word;
    };
}

/** Pulls words until the text is long enough. */
function fragment(nextWord, { lessonLength, repeatWords }) {
    const limit = LENGTH_MIN + Math.round(lessonLength * LENGTH_SPAN);
    const words = [];
    let length = 0;
    // A generator that has run dry would spin here forever; the attempt cap is
    // the backstop for a filter nothing can satisfy.
    for (let guard = 0; guard < 1000 && length < limit; guard++) {
        const word = nextWord() || '?';
        for (let i = 0; i < repeatWords && length < limit; i++) {
            words.push(word);
            length += word.length + 1;
        }
    }
    return words.join(' ');
}

/** Benford's law: leading digits are not uniform, and neither are real numbers. */
function benfordDigit(rng) {
    const weights = [];
    for (let d = 1; d <= 9; d++) weights.push({ d, f: Math.log10(1 + 1 / d) });
    return weightedSample(weights, (w) => w.f, rng).d;
}

function numberWords(settings, rng) {
    return () => {
        const digits = 1 + Math.floor(rng() * 5);
        let out = settings.numbersBenford
            ? String(benfordDigit(rng))
            : String(Math.floor(rng() * 10));
        for (let i = 1; i < digits; i++) out += String(Math.floor(rng() * 10));
        return out;
    };
}

/**
 * Build the text for one lesson.
 *
 * Returns `{ text, keys, filter }`: the text to type, the per-letter state the
 * UI shows underneath it, and the filter that produced it.
 */
export function makeLesson({ settings, model, keyboard, keyStatsMap, seed }) {
    const rng = makeRNG(seed);
    const letters = orderLetters(model, keyboard, settings.keyboardOrder);

    if (settings.lessonType === 'guided') {
        const keys = guidedKeys(letters, keyStatsMap, settings);
        const included = keys.included();
        const focused = keys.focused();
        const filter = new Filter(
            included.map((k) => k.letter.codePoint),
            focused?.letter.codePoint ?? null);

        let nextWord = () => model.nextWord(filter, rng);
        if (settings.naturalWords) {
            const real = findWords(filter, { limit: 1000 });
            // Under about fifteen real words the stream reads as the same
            // handful on repeat, so top it up with pseudo-words.
            while (real.length < 15) {
                const word = model.nextWord(filter, rng);
                if (!word) break;
                real.push(word);
            }
            if (real.length > 0) nextWord = () => randomSample(real, rng);
        }
        return {
            text: fragment(mangledWords(uniqueWords(nextWord), settings, rng), settings),
            keys, filter,
        };
    }

    const keys = allKeys(letters, keyStatsMap, settings);

    if (settings.lessonType === 'numbers') {
        return { text: fragment(numberWords(settings, rng), settings), keys, filter: Filter.empty };
    }

    if (settings.lessonType === 'custom') {
        const source = (settings.customLowercase
            ? settings.customText.toLowerCase() : settings.customText)
            .split(/\s+/).filter(Boolean);
        if (source.length === 0) return { text: '?', keys, filter: Filter.empty };
        let i = 0;
        const nextWord = settings.customRandomize
            ? () => randomSample(source, rng)
            : () => source[i++ % source.length];
        return { text: fragment(nextWord, settings), keys, filter: Filter.empty };
    }

    // Word list: the corpus head, optionally long words only, in random order.
    const pool = [];
    const codePoints = keyboard?.codePoints ?? null;
    for (const word of WORDS) {
        if (pool.length >= settings.wordListSize) break;
        if (settings.longWordsOnly && word.length < 6) continue;
        if (codePoints != null && ![...word].every((c) => codePoints.has(c.codePointAt(0)))) continue;
        pool.push(word);
    }
    const nextWord = pool.length > 0 ? () => randomSample(pool, rng) : () => 'the';
    return {
        text: fragment(mangledWords(uniqueWords(nextWord), settings, rng), settings),
        keys, filter: Filter.empty,
    };
}

export { SPACE, wpmToCpm };
