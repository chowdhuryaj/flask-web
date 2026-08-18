// Typing-trainer statistics: per-key speed, confidence, learning rate, daily
// goal, and the localStorage record of every completed lesson.
//
// This is the half of the keybr algorithm that decides what you practise next.
// The rule, in one line: a key's CONFIDENCE is the target speed divided by how
// long you actually take to type it, and the guided lesson unlocks a new letter
// only once every letter already in play has been at confidence 1.
//
// KEEP IN SYNC with AdeptCompanion's Sources/AdeptCore/TrainerStats.swift.

/** Characters per minute → milliseconds per character, and back. */
export const speedToTime = (cpm) => 60000 / cpm;
export const timeToSpeed = (ms) => 60000 / ms;

/** CPM → WPM, the unit everybody actually quotes. Five characters per word. */
export const cpmToWpm = (cpm) => cpm / 5;
export const wpmToCpm = (wpm) => wpm * 5;

/**
 * Smoothing applied to a key's per-lesson time-to-type before it is compared
 * against the target. One bad lesson must not un-unlock a letter, and one
 * lucky lesson must not unlock the next.
 */
const FILTER_ALPHA = 0.1;

/** Lessons kept per key for the learning-rate fit. */
const LEARNING_WINDOW = 30;

/** Completed lessons retained in localStorage. */
const MAX_RESULTS = 4000;

const KEY_RESULTS = 'flask.trainer.results.v1';
const KEY_SETTINGS = 'flask.trainer.settings.v1';

// ---------------------------------------------------------------- histogram

/**
 * Per-codepoint hit/miss/mean-time for ONE lesson, built from the keystroke
 * steps. `timeToType` is the mean over the hits of that character, so a lesson
 * contributes one number per key however many times the key appeared.
 *
 * The first step of a lesson is dropped by the caller: its time-to-type is
 * measured from "user decided to start", not from a previous keystroke.
 */
export function makeHistogram(steps) {
    const acc = new Map();
    for (const { codePoint, timeToType, typo } of steps) {
        let s = acc.get(codePoint);
        if (s == null) acc.set(codePoint, (s = { hit: 0, miss: 0, time: 0, n: 0 }));
        if (typo) {
            s.miss += 1;
        } else {
            s.hit += 1;
            // A zero time-to-type is a synthesised step (a skipped word), not
            // a keystroke — counting it would make the key look instant.
            if (timeToType > 0) { s.time += timeToType; s.n += 1; }
        }
    }
    const out = [];
    for (const [codePoint, s] of acc) {
        out.push({
            codePoint,
            hitCount: s.hit,
            missCount: s.miss,
            timeToType: s.n > 0 ? s.time / s.n : 0,
        });
    }
    return out.sort((a, b) => a.codePoint - b.codePoint);
}

// ---------------------------------------------------------------- results

/** One completed lesson. `histogram` is the per-key detail above. */
export function makeResult({ steps, lessonType, timeStamp }) {
    // Two steps is the minimum that spans any time at all.
    if (steps.length < 2) return null;
    const time = Math.round(steps[steps.length - 1].timeStamp - steps[0].timeStamp);
    const length = steps.length;
    let errors = 0;
    for (const s of steps) if (s.typo) errors += 1;
    return {
        timeStamp: timeStamp ?? Date.now(),
        lessonType,
        time,
        length,
        errors,
        accuracy: (length - errors) / length,
        speed: time > 0 ? (length / (time / 1000)) * 60 : 0,
        histogram: makeHistogram(steps.slice(1)),
    };
}

/** Compact wire form — localStorage holds thousands of these. */
const packResult = (r) => ({
    t: r.timeStamp, k: r.lessonType, d: r.time, n: r.length, e: r.errors,
    s: Math.round(r.speed * 10) / 10,
    h: r.histogram.map((s) => [s.codePoint, s.hitCount, s.missCount, Math.round(s.timeToType)]),
});

const unpackResult = (o) => ({
    timeStamp: o.t, lessonType: o.k, time: o.d, length: o.n, errors: o.e,
    accuracy: o.n > 0 ? (o.n - o.e) / o.n : 0, speed: o.s,
    histogram: (o.h || []).map(([codePoint, hitCount, missCount, timeToType]) => ({
        codePoint, hitCount, missCount, timeToType,
    })),
});

// ---------------------------------------------------------------- key stats

/**
 * Per-key history assembled by replaying every stored lesson in order.
 *
 * `timeToType` is the smoothed current estimate, `bestTimeToType` the best that
 * estimate has ever been. The guided lesson reads BEST by default, so a letter
 * that has once been fast stays unlocked through a bad day — keybr's
 * "recoverKeys" setting is what switches it to the current value instead.
 */
export function makeKeyStatsMap(letters, results) {
    const map = new Map();
    for (const letter of letters) {
        map.set(letter.codePoint, {
            letter, samples: [], timeToType: null, bestTimeToType: null,
            hitCount: 0, missCount: 0,
        });
    }
    const ema = new Map();
    let index = 0;
    for (const result of results) {
        for (const sample of result.histogram) {
            const stats = map.get(sample.codePoint);
            if (stats == null) continue;    // a key this keyboard cannot type
            stats.hitCount += sample.hitCount;
            stats.missCount += sample.missCount;
            if (!(sample.timeToType > 0)) continue;
            const prev = ema.get(sample.codePoint);
            const filtered = prev == null
                ? sample.timeToType
                : FILTER_ALPHA * sample.timeToType + (1 - FILTER_ALPHA) * prev;
            ema.set(sample.codePoint, filtered);
            stats.samples.push({
                index,
                timeStamp: result.timeStamp,
                hitCount: sample.hitCount,
                missCount: sample.missCount,
                timeToType: sample.timeToType,
                filteredTimeToType: filtered,
            });
            stats.timeToType = filtered;
            stats.bestTimeToType = Math.min(stats.bestTimeToType ?? Infinity, filtered);
        }
        index += 1;
    }
    return map;
}

// ---------------------------------------------------------------- learning rate

/** Least-squares polynomial fit, returned as coefficients [c0, c1, ...]. */
function polyFit(xs, ys, degree) {
    const n = degree + 1;
    // Normal equations: (XᵀX)c = Xᵀy, solved by Gaussian elimination. Degree
    // never exceeds 3, so the conditioning of the Vandermonde matrix is fine.
    const a = Array.from({ length: n }, () => new Array(n + 1).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            let sum = 0;
            for (let k = 0; k < xs.length; k++) sum += Math.pow(xs[k], i + j);
            a[i][j] = sum;
        }
        let sum = 0;
        for (let k = 0; k < xs.length; k++) sum += ys[k] * Math.pow(xs[k], i);
        a[i][n] = sum;
    }
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        }
        if (Math.abs(a[pivot][col]) < 1e-12) return null;
        [a[col], a[pivot]] = [a[pivot], a[col]];
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = a[r][col] / a[col][col];
            for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
        }
    }
    return a.map((row, i) => row[n] / a[i][i]);
}

const polyEval = (c, x) => c.reduce((sum, ci, i) => sum + ci * Math.pow(x, i), 0);
const polyDeriv = (c) => c.slice(1).map((ci, i) => ci * (i + 1));

/**
 * The most recent unbroken run of lessons for a key.
 *
 * A "learning session" ends at an hour-long gap, or where speed started
 * regressing — fitting a curve across a week-old plateau and today's warm-up
 * predicts nonsense.
 */
function findSession(samples) {
    for (let i = samples.length - 1; i > 0; i--) {
        const a = samples[i - 1];
        const b = samples[i];
        if (b.timeStamp - a.timeStamp > 3600000) return samples.slice(i);
        if (b.filteredTimeToType > a.filteredTimeToType && samples.length - i + 1 >= 5) {
            return samples.slice(i);
        }
    }
    return samples.slice(0);
}

/**
 * Speed trend for one key: how fast it is improving per lesson, and how many
 * more lessons until it hits the target. `null` when the samples do not fit a
 * curve well enough (r² < 0.5) to say anything honest.
 */
export function learningRate(samples, targetSpeed) {
    let recent = samples.slice(-LEARNING_WINDOW);
    if (recent.length < 5) return null;
    const session = findSession(recent);
    if (session.length >= 5) recent = session;

    const xs = recent.map((s) => s.index + 1);
    const ys = recent.map((s) => timeToSpeed(s.filteredTimeToType));
    const degree = recent.length > 20 ? 3 : recent.length > 10 ? 2 : 1;
    const coef = polyFit(xs, ys, degree);
    if (coef == null) return null;

    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    let ssTot = 0;
    let ssRes = 0;
    for (let i = 0; i < xs.length; i++) {
        ssTot += Math.pow(ys[i] - mean, 2);
        ssRes += Math.pow(ys[i] - polyEval(coef, xs[i]), 2);
    }
    const certainty = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    if (!(certainty >= 0.5)) return null;

    const last = xs[xs.length - 1];
    let remainingLessons = null;
    for (let i = 1; i <= 50; i++) {
        if (polyEval(coef, last + i) >= targetSpeed) { remainingLessons = i; break; }
    }
    return {
        certainty,
        learningRate: polyEval(polyDeriv(coef), last),
        remainingLessons,
        points: xs.map((x, i) => ({ x, y: ys[i], fit: polyEval(coef, x) })),
    };
}

// ---------------------------------------------------------------- daily

const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Per-day totals, oldest first, plus today's progress against the goal. */
export function dailyStats(results, goalMinutes) {
    const days = new Map();
    for (const r of results) {
        const key = dayKey(r.timeStamp);
        let d = days.get(key);
        if (d == null) days.set(key, (d = { key, time: 0, lessons: 0, chars: 0, errors: 0, speedSum: 0 }));
        d.time += r.time;
        d.lessons += 1;
        d.chars += r.length;
        d.errors += r.errors;
        d.speedSum += r.speed;
    }
    const list = [...days.values()]
        .map((d) => ({ ...d, speed: d.lessons > 0 ? d.speedSum / d.lessons : 0 }))
        .sort((a, b) => (a.key < b.key ? -1 : 1));

    const today = list.find((d) => d.key === dayKey(Date.now()));
    const goalMs = goalMinutes * 60000;
    // Streak counts back from today, and from yesterday when today is still
    // empty — an unfinished today must not read as a broken streak.
    // A day counts only against a goal that exists. Without the `goalMs > 0`
    // half, every day with any practice at all met a zero goal, so the card
    // reported an N-day streak directly under the words "daily goal off" — and
    // disagreed with the desktop app, which reads the same file.
    const met = new Set(list.filter((d) => goalMs > 0 && d.time >= goalMs).map((d) => d.key));
    let streak = 0;
    const cursor = new Date();
    if (!met.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
    while (met.has(dayKey(cursor.getTime()))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
    }
    return {
        days: list,
        today: today ?? { key: dayKey(Date.now()), time: 0, lessons: 0, chars: 0, errors: 0, speed: 0 },
        goalMs,
        goalProgress: goalMs > 0 ? Math.min(1, (today?.time ?? 0) / goalMs) : 1,
        streak,
    };
}

/** Headline numbers for the profile view. */
export function summaryStats(results) {
    if (results.length === 0) {
        return { lessons: 0, time: 0, chars: 0, errors: 0, accuracy: 0, speed: 0, bestSpeed: 0, speeds: [] };
    }
    let time = 0;
    let chars = 0;
    let errors = 0;
    let best = 0;
    const speeds = [];
    for (const r of results) {
        time += r.time;
        chars += r.length;
        errors += r.errors;
        best = Math.max(best, r.speed);
        speeds.push(r.speed);
    }
    return {
        lessons: results.length,
        time,
        chars,
        errors,
        accuracy: chars > 0 ? (chars - errors) / chars : 0,
        speed: time > 0 ? (chars / (time / 1000)) * 60 : 0,
        bestSpeed: best,
        speeds,
    };
}

// ---------------------------------------------------------------- store

/**
 * The trainer's persistence. Results and settings are per-browser (there is no
 * backend and there will not be one); `exportJSON`/`importJSON` move a profile
 * between this app and the macOS Flask app, which writes the same shape.
 */
export class TrainerStore {
    constructor() {
        this.results = [];
        this.load();
    }

    load() {
        try {
            const raw = localStorage.getItem(KEY_RESULTS);
            this.results = raw ? JSON.parse(raw).map(unpackResult) : [];
        } catch {
            this.results = [];
        }
    }

    save() {
        try {
            localStorage.setItem(KEY_RESULTS,
                JSON.stringify(this.results.slice(-MAX_RESULTS).map(packResult)));
        } catch (e) {
            // A full quota must not eat the lesson the user just finished; the
            // in-memory list stays authoritative for this session.
            console.warn('trainer: results not persisted', e);
        }
    }

    append(result) {
        this.results.push(result);
        if (this.results.length > MAX_RESULTS) {
            this.results.splice(0, this.results.length - MAX_RESULTS);
        }
        this.save();
    }

    clear() {
        this.results = [];
        try { localStorage.removeItem(KEY_RESULTS); } catch { /* ignore */ }
    }

    loadSettings(defaults) {
        try {
            const raw = localStorage.getItem(KEY_SETTINGS);
            return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
        } catch {
            return { ...defaults };
        }
    }

    saveSettings(settings) {
        try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); }
        catch { /* ignore */ }
    }

    exportJSON(settings) {
        return JSON.stringify({
            format: 'flask-trainer', version: 1, exported: Date.now(),
            settings, results: this.results.map(packResult),
        }, null, 1);
    }

    /** Merges by timestamp so importing the same file twice is a no-op. */
    importJSON(text) {
        const data = JSON.parse(text);
        if (data.format !== 'flask-trainer') throw new Error('not a Flask trainer profile');
        const seen = new Set(this.results.map((r) => r.timeStamp));
        let added = 0;
        for (const packed of data.results || []) {
            const r = unpackResult(packed);
            if (seen.has(r.timeStamp)) continue;
            seen.add(r.timeStamp);
            this.results.push(r);
            added += 1;
        }
        this.results.sort((a, b) => a.timeStamp - b.timeStamp);
        this.save();
        return { added, settings: data.settings ?? null };
    }
}
