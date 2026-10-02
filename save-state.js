// One Save for the whole app (spec §3.2). Every unsaved thing registers
// here; the status bar shows "Save N unsaved" and runs saveAll().
//
// WP0: the registry works as specified. Nothing registers yet, so the UI is
// unchanged; WP6 wires the status bar, reloadBar, the unload guard and the
// never-register list.
//
// Contract (stable for Phase 1; WP0 shapes kept, new members are additive):
//   saveState.markDirty(source, label, saveFn, opts?)  register or refresh a source
//       opts: {discard: async fn, line: 'qmk'|'zmk'|'nape'}. `discard` makes the
//       source discardable (Studio keymap). `line` overrides setLine() for the
//       never-register check.
//   saveState.clean(source)                      drop it (saved or discarded)
//   saveState.dirty() → [{source, label, canDiscard}]  in save order
//   saveState.saveAll() → {saved: source[], failed: {source, error} | null}
//   saveState.discard() → {discarded: source[], failed: {source, error} | null}
//       runs every discard fn (same order); sources without one are left alone.
//   saveState.canDiscard()                       any dirty source can be discarded
//   saveState.summary() → 'Save 3 unsaved' | ''  the status bar text
//   saveState.setLine(line)                      firmware line of the connected
//       board ('qmk' | 'zmk' | 'nape' | null); call on connect and on exit
//   saveState.reset()                            drop everything (disconnect)
//   saveState.addEventListener('change', …)      fires on every change
//   assertRegistrable(line, source)              the never-register check, exported
//
// source: 'studio-keymap', or a Flask channel id (number). Save order is
// 'studio-keymap' first, then channels ascending, then any other string
// alphabetically. saveAll stops at the first failure and leaves it and
// everything after it dirty.
//
// Never-register (spec 3.2): channels with no save step. Svalboard (QMK line)
// corner chords 0x28: "a channel save wedges the board". 0x28 is double-booked
// (ZMK tap dance is 0x28 and does save), so the check is per firmware line,
// never per number alone. A line that is not set is not checked.

export const NEVER_REGISTER = { qmk: new Set([0x28]) };

export function assertRegistrable(line, source) {
    if (line && NEVER_REGISTER[line]?.has(source))
        throw new Error(`channel 0x${source.toString(16)} has no save step on the ${line} line; never register it`);
}

const rank = (s) => (s === 'studio-keymap' ? [0, 0, ''] : typeof s === 'number' ? [1, s, ''] : [2, 0, String(s)]);
const order = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
};

class SaveState extends EventTarget {
    #sources = new Map();   // source → {label, save, discard}
    #line = null;

    setLine(line) { this.#line = line || null; }

    markDirty(source, label, saveFn, opts = {}) {
        if (typeof saveFn !== 'function') throw new Error(`markDirty(${source}): saveFn required`);
        assertRegistrable(opts.line ?? this.#line, source);
        this.#sources.set(source, { label, save: saveFn, discard: opts.discard || null });
        this.#changed();
    }

    reset() {
        if (!this.#sources.size) return;
        this.#sources.clear();
        this.#changed();
    }

    canDiscard() { return [...this.#sources.values()].some((e) => e.discard); }

    summary() {
        const n = this.#sources.size;
        return n ? `Save ${n} unsaved` : '';
    }

    async discard() {
        const discarded = [];
        for (const { source } of this.dirty()) {
            const entry = this.#sources.get(source);
            if (!entry?.discard) continue;
            try {
                await entry.discard();
            } catch (error) {
                return { discarded, failed: { source, error } };
            }
            if (this.#sources.get(source) === entry) this.clean(source);
            discarded.push(source);
        }
        return { discarded, failed: null };
    }

    clean(source) {
        if (this.#sources.delete(source)) this.#changed();
    }

    dirty() {
        return [...this.#sources.keys()].sort(order).map((source) => ({ source, label: this.#sources.get(source).label, canDiscard: !!this.#sources.get(source).discard }));
    }

    async saveAll() {
        const saved = [];
        for (const { source } of this.dirty()) {
            const entry = this.#sources.get(source);
            if (!entry) continue;   // cleaned while an earlier save ran
            try {
                await entry.save();
            } catch (error) {
                return { saved, failed: { source, error } };
            }
            // Keep it dirty if it was re-marked (a new edit) during its save.
            if (this.#sources.get(source) === entry) this.clean(source);
            saved.push(source);
        }
        return { saved, failed: null };
    }

    #changed() {
        this.dispatchEvent(new Event('change'));
        guardUnload(this.#sources.size > 0);
    }
}

// Warn before closing the tab or the Electron window while anything is
// dirty. One listener for the whole registry; absent in Node.
const unloadGuard = (e) => { e.preventDefault(); e.returnValue = ''; };
let guarded = false;
function guardUnload(on) {
    if (typeof window === 'undefined' || on === guarded) return;
    guarded = on;
    window[on ? 'addEventListener' : 'removeEventListener']('beforeunload', unloadGuard);
}

export const saveState = new SaveState();
export { SaveState };   // tests make their own instance
