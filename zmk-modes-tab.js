// ZMK Modes tab — named, app-side snapshots of the whole device.
//
// A mode is the v2 export payload (keymap layers + every module section), held
// in localStorage rather than on the board. See zmk-modes.js for WHY app-side
// (32 KB settings partition) and for the baseline inversion.
//
// Two ways to put a mode on the device, and the difference is the whole point:
//
//   Apply        write-through LIVE, save nothing. Instant, no flash writes,
//                gone on power-off. Reuses the SAME live/saved vocabulary the
//                rest of the app uses, so an applied mode simply reads "Live —
//                reverts on power-off" in the Keymap toolbar.
//   Make baseline  write-through AND persist (flask SAVE per channel + a
//                Studio keymap save). This is what the device boots into where
//                there is no app — i.e. the workstation. Deliberate, rare, and
//                the only path here that touches flash.
//
// The keymap half rides zmk-keymap-tab.js: applyKeymapData() already writes
// bindings live through Studio and only saveChanges() persists them, so the
// live/baseline split needs nothing new there.

import { el, card, toast, modal } from './ui.js?v=16';
import { applyFlaskState } from './zmk-export.js?v=16';
import { zmkLiveKeymapTab } from './zmk-keymap-tab.js?v=16';
import {
    modesStoreKey, emptyStore, normalizeStore, addMode, renameMode,
    deleteMode, setBaseline, getMode, isModePayload, modeSummary,
} from './zmk-modes.js?v=16';

export class ZmkModesTab {
    constructor(app) {
        this.app = app;
        this.root = el('div');
        this.busy = false;
    }

    _family() { return this.app.profile?.family ?? this.app.family ?? 'zmk'; }

    _load() {
        try {
            return normalizeStore(JSON.parse(localStorage.getItem(modesStoreKey(this._family())) || 'null'));
        } catch { return emptyStore(); }
    }

    _save(store) {
        this.store = store;
        try {
            localStorage.setItem(modesStoreKey(this._family()), JSON.stringify(store));
        } catch (e) {
            // Quota is the realistic failure: a mode carries a full RGB map, so
            // a dozen of them is real weight. Say so instead of silently losing
            // the capture the user just took.
            toast(`Couldn't store modes: ${e.message}`, true);
        }
    }

    async load() {
        this.store = this._load();
        this.render();
    }

    /** The keymap tab has to be mounted AND past its Studio load — a mode
     * without layers isn't a mode. */
    _keymapTab() {
        const kt = zmkLiveKeymapTab();
        return (kt && kt.keymap && Array.isArray(kt.keymap.layers)) ? kt : null;
    }

    async _guard(fn) {
        if (this.busy) return;
        this.busy = true;
        this.render();
        try { await fn(); }
        catch (e) { toast(e.message || String(e), true); }
        finally { this.busy = false; this.render(); }
    }

    // ---- operations ----

    captureCurrent() {
        const kt = this._keymapTab();
        if (!kt) { toast('Open the Keymap tab first — a mode needs the keymap loaded', true); return; }

        const input = el('input', { type: 'text', placeholder: 'e.g. Radiology', style: 'width:100%' });
        const go = async () => {
            back.remove();
            await this._guard(async () => {
                const data = await kt.buildExportData({ quiet: true });
                const { store, mode } = addMode(this.store, input.value, data);
                this._save(store);
                toast(`Captured "${mode.name}"`);
            });
        };
        const back = modal('Capture the device as a Mode', el('div', {},
            el('p', { class: 'muted', style: 'margin-top:0',
                text: 'Reads the current keymap and every module section, and stores it here in the app. The device is not changed.' }),
            input), [
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => back.remove() }),
            el('button', { class: 'btn small primary', text: 'Capture', onclick: go }),
        ]);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        input.focus();
    }

    applyLive(id) {
        const mode = getMode(this.store, id);
        const kt = this._keymapTab();
        if (!mode || !kt) { toast('Open the Keymap tab first', true); return; }
        this._guard(async () => {
            const r = await kt.applyKeymapData(mode.data, { quiet: true });
            let note = '';
            if (mode.data.flask && this.app?.flask && this.app?.caps?.flask) {
                // save:false — this is the whole mechanic. Live on the device,
                // zero flash writes, reverts on power-off.
                const f = await applyFlaskState(this.app, mode.data.flask, { save: false });
                if (f.failures.length) note = ` (${f.failures.length} section(s) skipped)`;
            }
            if (r === null) return;   // applyKeymapData already explained why
            toast(`"${mode.name}" applied live — Save to keep it${note}`);
        });
    }

    makeBaseline(id) {
        const mode = getMode(this.store, id);
        const kt = this._keymapTab();
        if (!mode || !kt) { toast('Open the Keymap tab first', true); return; }

        const back = modal('Make this the device baseline?', el('div', {},
            el('p', { style: 'margin-top:0' },
                `"${mode.name}" gets written to the keyboard's flash — it is what the board boots into with no app attached.`),
            el('p', { class: 'muted',
                text: 'This is the only action here that writes to flash. Use it for the mode you need where you cannot run Flask; switch to the others live instead.' })), [
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => back.remove() }),
            el('button', {
                class: 'btn small primary', text: 'Write baseline',
                onclick: () => {
                    back.remove();
                    this._guard(async () => {
                        const r = await kt.applyKeymapData(mode.data, { quiet: true });
                        if (r === null) return;
                        if (mode.data.flask && this.app?.flask && this.app?.caps?.flask) {
                            const f = await applyFlaskState(this.app, mode.data.flask);   // saves
                            if (f.failures.length) toast(`${f.failures.length} section(s) skipped`, true);
                        }
                        await kt.saveChanges();
                        this._save(setBaseline(this.store, id));
                        toast(`"${mode.name}" is now the device baseline`);
                    });
                },
            }),
        ]);
    }

    rename(id) {
        const mode = getMode(this.store, id);
        if (!mode) return;
        const input = el('input', { type: 'text', value: mode.name, style: 'width:100%' });
        const go = () => {
            back.remove();
            this._save(renameMode(this.store, id, input.value));
            this.render();
        };
        const back = modal('Rename mode', input, [
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => back.remove() }),
            el('button', { class: 'btn small primary', text: 'Rename', onclick: go }),
        ]);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        input.focus();
        input.select();
    }

    remove(id) {
        const mode = getMode(this.store, id);
        if (!mode) return;
        const back = modal('Delete mode?', el('p', { style: 'margin:0' },
            `"${mode.name}" is deleted from this browser. The keyboard is not changed.`), [
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => back.remove() }),
            el('button', {
                class: 'btn small danger', text: 'Delete',
                onclick: () => { back.remove(); this._save(deleteMode(this.store, id)); this.render(); },
            }),
        ]);
    }

    exportFile(id) {
        const mode = getMode(this.store, id);
        if (!mode) return;
        // A mode IS the export payload — same file the Keymap tab's Export
        // writes, so these round-trip through each other.
        const blob = new Blob([JSON.stringify(mode.data, null, 2)], { type: 'application/json' });
        const a = el('a', {
            href: URL.createObjectURL(blob),
            download: `${mode.name.replace(/\s+/g, '-').toLowerCase()}-mode.json`,
        });
        a.click();
        URL.revokeObjectURL(a.href);
    }

    importFile(file) {
        this._guard(async () => {
            let data;
            try { data = JSON.parse(await file.text()); }
            catch { throw new Error('Not a JSON file'); }
            if (!isModePayload(data)) throw new Error('Not a Flask ZMK keymap export');
            const name = file.name.replace(/\.json$/i, '').replace(/-mode$/, '');
            const { store, mode } = addMode(this.store, name, data);
            this._save(store);
            toast(`Imported "${mode.name}"`);
        });
    }

    // ---- render ----

    _modeCard(mode) {
        const isBaseline = this.store.baselineId === mode.id;
        const head = el('h3', { text: mode.name });
        if (isBaseline) {
            head.append(el('span', {
                class: 'badge', style: 'margin-left:8px',
                title: 'The keyboard boots into this with no app attached',
                text: 'baseline',
            }));
        }
        head.append(el('span', { class: 'sub', text: modeSummary(mode) }));

        const captured = mode.created
            ? `captured ${new Date(mode.created).toLocaleString()}` : 'captured — unknown';

        return el('div', { class: 'card' }, head,
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn small primary', text: 'Apply',
                    title: 'Write it to the keyboard live — reverts on power-off',
                    disabled: this.busy,
                    onclick: () => this.applyLive(mode.id),
                }),
                el('button', {
                    class: 'btn small', text: 'Make baseline',
                    title: 'Persist it to the keyboard’s flash — what it boots into with no app',
                    disabled: this.busy || isBaseline,
                    onclick: () => this.makeBaseline(mode.id),
                }),
                el('span', { style: 'flex:1' }),
                el('button', { class: 'btn small', text: 'Rename', disabled: this.busy, onclick: () => this.rename(mode.id) }),
                el('button', { class: 'btn small', text: 'Export…', onclick: () => this.exportFile(mode.id) }),
                el('button', { class: 'btn small danger', text: 'Delete', disabled: this.busy, onclick: () => this.remove(mode.id) })),
            el('div', { class: 'muted', style: 'font-size:var(--fs-sm); margin-top:8px', text: captured }));
    }

    render() {
        const file = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
        file.addEventListener('change', () => {
            const f = file.files?.[0];
            file.value = '';
            if (f) this.importFile(f);
        });

        const controls = card('Modes',
            'named snapshots of the whole device — keymap, tunings, RGB and every slot table',
            el('p', { class: 'muted', style: 'margin-top:0' },
                'Apply puts a mode on the keyboard live: instant, and gone on power-off. '
                + 'Make baseline persists one to flash — that is what the board boots into '
                + 'somewhere you cannot run Flask. Modes live in this browser, not on the '
                + 'keyboard, so they cost none of its 32 KB of settings space.'),
            el('div', { class: 'savebar' },
                el('button', {
                    class: 'btn primary', text: 'Capture current device…',
                    disabled: this.busy, onclick: () => this.captureCurrent(),
                }),
                el('button', { class: 'btn small', text: 'Import…', disabled: this.busy, onclick: () => file.click() }),
                file,
                el('span', { class: 'note',
                    text: `${this.store.modes.length} mode${this.store.modes.length === 1 ? '' : 's'}` })));

        const empty = el('div', { class: 'card' },
            el('p', { class: 'muted', style: 'margin:0' },
                'No modes yet. Set the keyboard up the way you want it, then '
                + '“Capture current device” to keep it — a second mode is what makes '
                + 'switching worth anything.'));

        this.root.replaceChildren(controls,
            ...(this.store.modes.length ? this.store.modes.map((m) => this._modeCard(m)) : [empty]));
    }
}
