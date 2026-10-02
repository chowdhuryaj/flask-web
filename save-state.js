// One Save for the whole app (spec §3.2). Every unsaved thing registers
// here; the status bar shows "Save N unsaved" and runs saveAll().
//
// WP0: the registry works as specified. Nothing registers yet, so the UI is
// unchanged; WP6 wires the status bar, reloadBar and the unload guard.
//
// Contract (stable for Phase 1; WP0 shapes kept, new members are additive):
//   saveState.markDirty(source, label, saveFn, opts?)  register or refresh a source
//       opts: {discard: async fn}. `discard` makes the source discardable
//       (Studio keymap).
//   saveState.clean(source)                      drop it (saved or discarded)
//   saveState.dirty() → [{source, label, canDiscard}]  in save order
//   saveState.saveAll() → {saved: source[], failed: {source, error} | null}
//   saveState.discard() → {discarded: source[], failed: {source, error} | null}
//       runs every discard fn (same order); sources without one are left alone.
//   saveState.canDiscard()                       any dirty source can be discarded
//   saveState.discardAll() → {discarded, failed, queued}   THE one Discard (also
//       window.flaskDiscardAll()): discard() plus every registered hook
//       (offline: drops the queued journal and any unsaved mark that has no
//       device behind it). Safe to call when nothing is dirty.
//   saveState.addDiscardHook(fn) → remove fn     fn() → number of entries dropped
//   saveState.summary() → 'Save 3 unsaved' | ''  the status bar text
//   saveState.reset()                            drop everything (disconnect)
//   saveState.addEventListener('change', …)      fires on every change
//
// source: 'studio-keymap', or a Flask channel id (number). Save order is
// 'studio-keymap' first, then channels ascending, then any other string
// alphabetically. saveAll stops at the first failure and leaves it and
// everything after it dirty.

const rank = (s) => (s === 'studio-keymap' ? [0, 0, ''] : typeof s === 'number' ? [1, s, ''] : [2, 0, String(s)]);
const order = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
};

class SaveState extends EventTarget {
    #sources = new Map();   // source → {label, save, discard}
    #hooks = new Set();     // discardAll extras (offline queue)

    markDirty(source, label, saveFn, opts = {}) {
        if (typeof saveFn !== 'function') throw new Error(`markDirty(${source}): saveFn required`);
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

    addDiscardHook(fn) {
        this.#hooks.add(fn);
        return () => this.#hooks.delete(fn);
    }

    async discardAll() {
        const r = await this.discard();
        r.queued = 0;
        if (r.failed) return r;
        for (const h of [...this.#hooks]) {
            try { r.queued += (await h()) || 0; }
            catch (error) { r.failed = { source: 'hook', error }; break; }
        }
        return r;
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
if (typeof window !== 'undefined') window.flaskDiscardAll = () => saveState.discardAll();
export { SaveState };   // tests make their own instance
