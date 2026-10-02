// One Save for the whole app (spec §3.2). Every unsaved thing registers
// here; the status bar shows "Save N unsaved" and runs saveAll().
//
// WP0: the registry works as specified. Nothing registers yet, so the UI is
// unchanged; WP6 wires the status bar, reloadBar, the unload guard and the
// never-register list.
//
// Contract (stable for Phase 1):
//   saveState.markDirty(source, label, saveFn)   register or refresh a source
//   saveState.clean(source)                      drop it (saved or discarded)
//   saveState.dirty() → [{source, label}]        in save order
//   saveState.saveAll() → {saved: source[], failed: {source, error} | null}
//   saveState.addEventListener('change', …)      fires on every change
//
// source: 'studio-keymap', or a Flask channel id (number). Save order is
// 'studio-keymap' first, then channels ascending, then any other string
// alphabetically. saveAll stops at the first failure and leaves it and
// everything after it dirty.
//
// WP6 must make registering a channel with no save step throw in dev:
// Svalboard corner chords 0x28 ("a channel save wedges the board"). 0x28 is
// double-booked (ZMK tap dance is 0x28 and does save), so that check is per
// firmware line, not per number.

const rank = (s) => (s === 'studio-keymap' ? [0, 0, ''] : typeof s === 'number' ? [1, s, ''] : [2, 0, String(s)]);
const order = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
};

class SaveState extends EventTarget {
    #sources = new Map();   // source → {label, save}

    markDirty(source, label, saveFn) {
        if (typeof saveFn !== 'function') throw new Error(`markDirty(${source}): saveFn required`);
        this.#sources.set(source, { label, save: saveFn });
        this.#changed();
    }

    clean(source) {
        if (this.#sources.delete(source)) this.#changed();
    }

    dirty() {
        return [...this.#sources.keys()].sort(order).map((source) => ({ source, label: this.#sources.get(source).label }));
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

    #changed() { this.dispatchEvent(new Event('change')); }
}

export const saveState = new SaveState();
export { SaveState };   // tests make their own instance
