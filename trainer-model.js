// Phonetic model for the typing trainer — the pseudo-word generator.
//
// A clean-room implementation of keybr.com's guided-lesson text engine. keybr
// itself is AGPL and ships prebuilt binary transition tables per language;
// none of its code or data is used here. What IS reproduced is the published
// algorithm: an order-3 Markov chain over letters plus space, sampled with the
// space character boosted so words come out short, restricted to the letters
// the learner has unlocked, and seeded from a prefix that contains the letter
// the lesson is focusing on.
//
// The table is built at runtime from `trainer-words.js` (4000 frequency-ordered
// English words). Runtime build costs ~25 ms and buys two things a prebuilt
// blob would not: the same file also serves as the natural-word dictionary, and
// AdeptCompanion's Swift port can be verified letter-for-letter against this
// one from the same source.
//
// KEEP IN SYNC with AdeptCompanion's Sources/AdeptCore/TrainerModel.swift.
// Same constants, same sampling order, same RNG — the two apps are meant to
// produce identical lessons from identical settings and seeds.

import { WORDS, rankWeight } from './trainer-words.js?v=45';

export const SPACE = 32;

/** Markov order: a context of 3 letters predicts the 4th (a 4-gram model). */
const ORDER = 3;

/** Generated words stay inside these bounds. keybr's numbers. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 10;

/** How hard to push toward ending a word: space frequency × SPACE_BOOST^len. */
const SPACE_BOOST = 1.3;

/** Word-generation attempts before giving up and returning what we have. */
const MAX_RETRIES = 5;

// ---------------------------------------------------------------- RNG

/**
 * mulberry32 — a seeded 32-bit PRNG. Deterministic streams matter twice here:
 * a lesson can be regenerated exactly (bug reports quote a seed), and the
 * Swift port is testable against this one. Returns floats in [0, 1).
 */
export function makeRNG(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A fresh seed for a lesson nobody asked to reproduce. */
export const randomSeed = () => (Math.random() * 0x100000000) >>> 0;

/** Uniform pick. */
export function randomSample(list, rng) {
    return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/** Frequency-weighted pick. `weightOf` must return non-negative numbers. */
export function weightedSample(list, weightOf, rng) {
    let total = 0;
    for (const item of list) total += weightOf(item);
    if (!(total > 0)) return randomSample(list, rng);
    let r = rng() * total;
    for (const item of list) {
        r -= weightOf(item);
        if (r <= 0) return item;
    }
    return list[list.length - 1];
}

// ---------------------------------------------------------------- filter

/**
 * Which letters a lesson may use, and which one it must exercise.
 *
 * `codePoints === null` means "no restriction" (word-list and custom-text
 * lessons); a Set means guided mode, where only unlocked letters may appear.
 * `focused` is the weakest unlocked key — every generated word contains it.
 */
export class Filter {
    constructor(codePoints = null, focused = null) {
        this.codePoints = codePoints ? new Set(codePoints) : null;
        this.focused = focused ?? null;
    }

    includes(codePoint) {
        return this.codePoints == null || this.codePoints.has(codePoint);
    }
}

Filter.empty = new Filter(null, null);

// ---------------------------------------------------------------- table

/**
 * Letter transition counts keyed by context string.
 *
 * Contexts of EVERY length 0..ORDER are stored, not just length ORDER. keybr
 * can afford fixed-order lookups because its tables come from corpora three
 * orders of magnitude larger than 4000 words; here, a 3-letter context
 * restricted to a 6-letter starting alphabet is often unseen, and keybr's only
 * answer to an empty context is to throw the word away and retry. Storing the
 * shorter contexts lets `segment()` back off instead, which is the difference
 * between "eath tenne heat" and a screen of two-letter stubs on lesson one.
 */
export class TransitionTable {
    constructor() {
        /** @type {Map<string, Map<number, number>>} */
        this.contexts = new Map();
        /** Total mass per codepoint — the letter frequency table. */
        this.totals = new Map();
    }

    /**
     * Build from a frequency-ordered word list. Each word is weighted by
     * `rankWeight(rank)`; see trainer-words.js for why rank is the frequency
     * signal. Words are padded with leading spaces so a word's first letters
     * are predicted from the same "after a space" context that ends one.
     */
    static build(words = WORDS) {
        const table = new TransitionTable();
        const pad = ' '.repeat(ORDER);
        for (let rank = 0; rank < words.length; rank++) {
            const w = words[rank];
            const weight = rankWeight(rank);
            const text = `${pad}${w} `;
            for (let i = ORDER; i < text.length; i++) {
                const cp = text.codePointAt(i);
                table.#add(text.slice(i - ORDER, i), cp, weight);
                table.totals.set(cp, (table.totals.get(cp) ?? 0) + weight);
            }
        }
        return table;
    }

    #add(context, codePoint, weight) {
        // One row per context length so `segment()` can back off.
        for (let n = 0; n <= ORDER; n++) {
            const key = context.slice(ORDER - n);
            let row = this.contexts.get(key);
            if (row == null) this.contexts.set(key, (row = new Map()));
            row.set(codePoint, (row.get(codePoint) ?? 0) + weight);
        }
    }

    /**
     * Continuations of `word` (an array of codepoints) as [{codePoint,
     * frequency}], longest matching context first, backing off until something
     * survives `keep`. Returns [] only when even the unigram row is empty.
     */
    segment(word, keep) {
        const pad = [SPACE, SPACE, SPACE, ...word];
        for (let n = ORDER; n >= 0; n--) {
            const key = String.fromCodePoint(...pad.slice(pad.length - n));
            const row = this.contexts.get(key);
            if (row == null) continue;
            const out = [];
            for (const [codePoint, frequency] of row) {
                if (keep(codePoint)) out.push({ codePoint, frequency });
            }
            // Sorted, not left in Map insertion order: the Swift port walks a
            // dictionary with no stable order of its own, and a seeded stream
            // is only reproducible across the two apps if both sample the
            // candidates in the same sequence.
            if (out.length > 0) return out.sort((a, b) => a.codePoint - b.codePoint);
        }
        return [];
    }

    /**
     * Every WORD-INITIAL letter sequence of length 1..ORDER the corpus
     * contains, as codepoint arrays — the pool a generated word starts from.
     *
     * Walked forward from the after-a-space context rather than read off the
     * context keys: the key set also holds word-interior substrings ("he",
     * "nte"), and seeding from those starts words mid-syllable, which reads as
     * noise instead of as English.
     */
    prefixes() {
        if (this.#prefixes != null) return this.#prefixes;
        const out = [];
        const walk = (word) => {
            const pad = [SPACE, SPACE, SPACE, ...word];
            const row = this.contexts.get(
                String.fromCodePoint(...pad.slice(pad.length - ORDER)));
            if (row == null) return;
            for (const codePoint of [...row.keys()].sort((a, b) => a - b)) {
                if (codePoint === SPACE) continue;
                word.push(codePoint);
                out.push([...word]);
                if (word.length < ORDER) walk(word);
                word.pop();
            }
        };
        walk([]);
        this.#prefixes = out;
        return out;
    }

    #prefixes = null;
}

// ---------------------------------------------------------------- model

/**
 * The letters this corpus knows about, most frequent first, plus pseudo-word
 * generation over any subset of them.
 */
export class PhoneticModel {
    /** Lazily built once per page — the table is immutable and reusable. */
    static shared() {
        if (PhoneticModel.#shared == null) {
            PhoneticModel.#shared = new PhoneticModel(TransitionTable.build());
        }
        return PhoneticModel.#shared;
    }

    static #shared = null;

    constructor(table) {
        this.table = table;
        /** @type {{codePoint: number, f: number, label: string}[]} */
        this.letters = [...table.totals]
            .filter(([cp]) => cp !== SPACE)
            .map(([codePoint, f]) => ({
                codePoint, f, label: String.fromCodePoint(codePoint),
            }))
            .sort((a, b) => b.f - a.f);
    }

    /** Letters restricted to what the keyboard can actually type. */
    lettersIn(codePoints) {
        return codePoints == null
            ? this.letters
            : this.letters.filter((l) => codePoints.has(l.codePoint));
    }

    /**
     * One pseudo-word. Empty string when the filter is too tight to produce
     * anything (a two-letter alphabet with a 3-character minimum, say) — the
     * caller substitutes a placeholder rather than looping forever.
     */
    nextWord(filter, rng) {
        const seeds = this.#seeds(filter);
        let word = [];
        let attempt = 0;

        // Restart from a fresh seed. keybr retries 5 times before conceding.
        const retry = () => {
            if (attempt >= MAX_RETRIES) return false;
            attempt++;
            word = seeds.length > 0 ? [...randomSample(seeds, rng)] : [];
            return true;
        };
        retry();

        for (;;) {
            const entries = this.table.segment(word, (cp) => (cp === SPACE
                // No ending the word before it is long enough.
                ? word.length >= MIN_LENGTH
                : filter.includes(cp)));

            if (entries.length === 0) {
                if (retry()) continue;
                return String.fromCodePoint(...word);
            }

            const pick = weightedSample(entries, ({ codePoint, frequency }) => (
                // Bias toward finishing: the longer the word, the heavier the
                // space. Without this the chain happily runs to MAX_LENGTH.
                codePoint === SPACE
                    ? frequency * Math.pow(SPACE_BOOST, word.length)
                    : frequency), rng);

            if (pick.codePoint === SPACE) return String.fromCodePoint(...word);

            if (word.length >= MAX_LENGTH) {
                if (retry()) continue;
                return String.fromCodePoint(...word);
            }
            word.push(pick.codePoint);
        }
    }

    /**
     * Word seeds for this filter: real corpus prefixes that use only unlocked
     * letters and contain the focused one. Seeding this way is what guarantees
     * the focused key appears in EVERY word — sampling alone would only make
     * it likely.
     */
    #seeds(filter) {
        const { focused } = filter;
        if (focused == null) return [];
        const key = `${focused}:${filter.codePoints ? [...filter.codePoints].sort().join(',') : '*'}`;
        if (this.#seedCache.key === key) return this.#seedCache.seeds;
        const seeds = this.table.prefixes().filter((prefix) => (
            prefix.includes(focused) && prefix.every((cp) => filter.includes(cp))));
        // A focused letter with no usable prefix still has to be practised:
        // start the word with the letter itself.
        this.#seedCache = { key, seeds: seeds.length > 0 ? seeds : [[focused]] };
        return this.#seedCache.seeds;
    }

    #seedCache = { key: null, seeds: [] };
}

// ---------------------------------------------------------------- dictionary

/**
 * Real words filtered to an alphabet — keybr's "natural words" option, which
 * mixes dictionary words into the pseudo-word stream once enough letters are
 * unlocked to spell any.
 */
export function findWords(filter, { minLength = 3, limit = 1000 } = {}) {
    const out = [];
    for (const word of WORDS) {
        if (word.length < minLength) continue;
        let ok = true;
        for (const ch of word) {
            if (!filter.includes(ch.codePointAt(0))) { ok = false; break; }
        }
        if (ok && (filter.focused == null
            || word.includes(String.fromCodePoint(filter.focused)))) {
            out.push(word);
            if (out.length >= limit) break;
        }
    }
    return out;
}
