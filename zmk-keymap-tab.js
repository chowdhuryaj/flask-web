// ZMK keymap editor tab — live keymap editing over ZMK Studio RPC
// (WebSerial). ZMK-line module: the Vial-for-ZMK surface. The device is the
// source of truth for everything rendered here — key geometry
// (get_physical_layouts), layers/bindings (get_keymap), and the behavior
// catalog (behaviors subsystem) all arrive over the wire on connect.
//
// The board, layer bar, selection, undo and click-again popover live in
// board.js (spec §3.1, §3.3); this file is the Studio controller behind them:
// it reads/writes the device, owns the layer structure ops, and hands
// Save/Discard to save-state (spec §3.2). Bindings are
// {behaviorId,param1,param2} objects, not QMK ints.

import { el, toast, card, modal, SAVE_STATE } from './ui.js?v=60';
import { board } from './board.js?v=60';
import { openPicker } from './binding-picker.js?v=60';
import { shell } from './app-shell.js?v=60';
import { saveState } from './save-state.js?v=60';
import { StudioClient, StudioError, LOCK_UNLOCKED } from './zmk-studio.js?v=60';
import { zmkApplyPendingKeymap } from './zmk-offline.js?v=60';
import { exportFlaskState, applyFlaskState } from './zmk-export.js?v=60';
import { keymapLayersData, diffKeymapLayers, keymapDiffers, keymapDiffSummary } from './zmk-keymap-sync.js?v=60';
import { ZMK_VIDPID, zmkFamilyMismatch, ZMK_FAMILY_UNRESOLVED_MSG } from './zmk.js?v=60';
import {
    consumerUsages, kpParam, cpParam, usageFromName, eventToUsageParam,
    setZmkContext, zmkBehaviors, zmkLayers, layerName,
    bindingCap, bindingHover, bindingDescribe, usageCap, usageLabel,
} from './zmk-keycodes.js?v=60';
// The picker lives in zmk-picker-legacy.js (WP0 move); re-exported so
// zmk-combos-tab / zmk-tapdance-tab keep importing it from here.
import { buildZmkPicker } from './zmk-picker-legacy.js?v=60';
export { buildZmkPicker };

// One serial client for the whole page: tab instances are discarded on HID
// disconnect/reconnect (main.js rebuilds all panels) with no dtor hook, so
// a per-instance client would leak an open port and block the next connect.
let sharedClient = null;
let activeTabAbort = null;      // event listeners of the superseded instance
let liveTab = null;             // the instance main.js currently has mounted

function studioClient() {
    if (!sharedClient) sharedClient = new StudioClient();
    return sharedClient;
}

/** The mounted keymap tab, or null before one exists. The Modes tab needs it
 * to apply and save the keymap half of a mode; module-scope for the same
 * reason sharedClient is — main.js rebuilds every tab instance on reconnect
 * with no dtor, so the newest constructor simply wins. Reaching for the tab
 * through main.js's TABS array instead would be a circular import AND put ZMK
 * knowledge in a shared file. */
export function zmkLiveKeymapTab() { return liveTab; }

export class ZmkKeymapTab {
    constructor(app) {
        this.app = app;
        // Offline preview: the workspace supplies a simulated Studio client
        // (zmk-offline.js); hardware sessions share the real serial client.
        this.client = app.zmkStudioSim ?? studioClient();
        this.root = el('div');
        this.state = 'idle';    // idle | connecting | loading | locked | ready | error
        this.statusMsg = '';
        this.deviceName = null;
        this.keymap = null;     // { layers:[{id,name,bindings}], ... }
        this.geomKeys = null;   // [{row:0, col:i, pos:i, label, x,y,w,h}]
        this.unsaved = false;
        this.keyPressId = null;
        this.removedLayers = [];    // session undo stack for remove-layer

        liveTab = this;         // newest instance wins (see zmkLiveKeymapTab)
        this.adapter = this._makeAdapter();

        // Rebind client events to THIS instance (abort the previous one's).
        activeTabAbort?.abort();
        activeTabAbort = new AbortController();
        const signal = activeTabAbort.signal;
        this.client.addEventListener('lockstate', (e) => this._onLockState(e.detail), { signal });
        this.client.addEventListener('unsaved', (e) => this._setUnsaved(e.detail), { signal });
        this.client.addEventListener('disconnect', () => this._onSerialDisconnect(), { signal });
    }

    async load() {
        if (!this.app.zmkStudioSim && !StudioClient.supported()) {
            this.state = 'unsupported';
            this.render();
            return;
        }
        this.render();
        if (this.client.connected) {
            // Reconnect of a discarded tab instance — port is still open.
            await this._handshake();
        } else {
            // Silent path: a previously-granted port opens without a gesture.
            try {
                await this._connect(false);
            } catch { /* stay on the connect card */ }
        }
    }

    // ---- connection ----

    async _connect(requestIfNeeded) {
        if (!(await this._acquireTabLock())) {
            toast('ZMK Studio serial is in use by another flask-web tab', true);
            return;
        }
        this.state = 'connecting';
        this.render();
        try {
            await this.client.connect({
                filters: [{ usbVendorId: ZMK_VIDPID.vid, usbProductId: ZMK_VIDPID.pid }],
                requestIfNeeded,
            });
        } catch (e) {
            this.state = 'idle';
            this.render();
            if (e.kind === 'cancelled' && !requestIfNeeded) throw e;   // silent path stays silent
            if (e.kind !== 'cancelled') toast(e.message, true);
            return;
        }
        await this._handshake();
    }

    async _acquireTabLock() {
        if (this._tabLockHeld) return true;
        if (!navigator.locks) return true;
        return new Promise((resolve) => {
            navigator.locks.request('flask-web-serial', { ifAvailable: true }, (lock) => {
                if (!lock) { resolve(false); return; }
                this._tabLockHeld = true;
                resolve(true);
                return new Promise((release) => { this._releaseTabLock = () => { this._tabLockHeld = false; release(); }; });
            }).catch(() => resolve(true));
        });
    }

    async _handshake() {
        // Phase A — unsecured: identity + lock state.
        try {
            this.state = 'loading';
            this.statusMsg = 'Reading device info…';
            this.render();
            const info = await this.client.getDeviceInfo();
            this.deviceName = info.name || 'ZMK device';
            // Snapshot storage key rides the serial so two boards on one
            // machine keep separate saved keymaps.
            this.deviceSerial = info.serialNumber?.length
                ? Array.from(info.serialNumber, (x) => x.toString(16).padStart(2, '0')).join('')
                : '';
            const lock = await this.client.getLockState();
            if (lock !== LOCK_UNLOCKED) {
                this.state = 'locked';
                this.render();
                return;     // lockstate notification resumes phase B
            }
            await this._loadEverything();
        } catch (e) {
            this._handleRpcError(e, 'Handshake failed');
        }
    }

    // Phase B — full read path (may require unlock depending on firmware).
    async _loadEverything() {
        this.state = 'loading';
        try {
            this.statusMsg = 'Reading physical layout…';
            this.render();
            const pl = await this.client.getPhysicalLayouts();
            const layout = pl.layouts[pl.activeLayoutIndex] ?? pl.layouts[0];
            if (!layout?.keys?.length) throw new StudioError('decodeFailed', 'Device reported no key layout');
            // Synthetic (row,col) identity: row 0, col = key position index —
            // exactly the key_position that set_layer_binding wants, and the
            // index into every layer's bindings[].
            // r/rx/ry carry the rotation (TOTEM thumbs, Imprint inner thumbs):
            // the board draws and hit-tests rotated keys.
            this.geomKeys = layout.keys.map((k, i) => ({
                row: 0, col: i, pos: i, label: `Key ${i}`,
                x: k.x, y: k.y, w: k.w, h: k.h, r: k.r || 0, rx: k.rx || 0, ry: k.ry || 0,
            }));

            this.statusMsg = 'Reading keymap…';
            this.render();
            this.keymap = await this.client.getKeymap();

            const ids = await this.client.listAllBehaviors();
            const behaviors = new Map();
            for (let i = 0; i < ids.length; i++) {
                this.statusMsg = `Loading behaviors… ${i + 1}/${ids.length}`;
                this.render();
                try {
                    const d = await this.client.getBehaviorDetails(ids[i]);
                    behaviors.set(d.id, d);
                } catch (e) {
                    console.warn(`behavior ${ids[i]} details failed:`, e.message);
                }
            }
            this._setContext(behaviors);

            this.unsaved = await this.client.checkUnsavedChanges();
            this._setUnsaved(this.unsaved);     // re-register a pending device-side edit
            this._publishToApp();
            this.state = 'ready';
            board.bind(this.adapter);
            this.render();
            await this._applyQueuedOfflineKeymap();
            await this._keymapSyncCheck();
        } catch (e) {
            this._handleRpcError(e, 'Keymap load failed');
        }
    }

    /** Offline-preview keymap auto-sync: the latest keymap SAVED in the
     * device-less workspace replays here — the first moment a real device
     * is connected, unlocked, and fully loaded (Studio RPC can't run any
     * earlier: serial needs a user gesture, unlock is physical). Mirrors
     * the QMK families' .vil queue-apply. Applied by display name, then
     * persisted, so a power-cycle keeps it. */
    async _applyQueuedOfflineKeymap() {
        if (this.app?.zmkStudioSim || !this.app?.zmkQueuedWs) return;
        try {
            // Save INSIDE the consume callback: the queue only clears after
            // apply AND persist both landed — a saveChanges throw leaves it
            // queued (so "still queued" below is never a lie).
            const res = await zmkApplyPendingKeymap(this.app, async (data) => {
                const r = await this.applyKeymapData(data, { quiet: true });
                if (r && !r.stopped && (r.wrote || r.renamed)) await this.saveChanges();
                return r;
            });
            if (!res || res.stopped) return;    // locked/partial: stays queued, applier toasted
            toast(`Offline keymap applied: ${res.wrote} keys, ${res.renamed} renamed — saved to keyboard`);
        } catch (e) {
            toast(`Offline keymap sync failed: ${e.message} — still queued`, true);
        }
    }

    // ---- keymap snapshot: connect check against the last saved copy ----

    _snapKey() {
        return `zmk-keymap-snapshot:${this.deviceSerial || this.deviceName || 'zmk'}`;
    }

    _readSnapshot() {
        try {
            return JSON.parse(localStorage.getItem(this._snapKey()) || 'null');
        } catch {
            return null;
        }
    }

    _writeSnapshot() {
        if (this.app?.zmkStudioSim || !this.keymap) return;
        try {
            localStorage.setItem(this._snapKey(), JSON.stringify({
                savedAt: new Date().toISOString(),
                device: this.deviceName,
                layers: keymapLayersData(this.keymap, zmkBehaviors()),
            }));
        } catch { /* quota/private mode — the snapshot is best-effort */ }
    }

    /** Connect check against Flask's last SAVED copy (the snapshot
     * refreshes on every successful device save). A keyboard that reads
     * back different (remapped elsewhere, settings_reset, fresh board) gets
     * a dialog, never a silent restore: Keep keyboard (default) adopts the
     * board as the new snapshot; Restore saved copy writes it LIVE (the
     * status bar Save persists it, ⟲ undoes); Show differences lists them.
     * Nothing is auto-saved (WP7: the old silent restore + save overwrote
     * AJ's remaps). Closing the dialog decides nothing; it asks again next
     * connect. Skipped in the sim (the workspace has its own persistence). */
    async _keymapSyncCheck() {
        if (this.app?.zmkStudioSim || !this.keymap) return;
        const snap = this._readSnapshot();
        if (!snap?.layers?.length) {
            this._writeSnapshot();      // first contact with this board: adopt it
            return;
        }
        const live = keymapLayersData(this.keymap, zmkBehaviors());
        const d = diffKeymapLayers(snap.layers, live);
        if (!keymapDiffers(d)) return;
        await this._askRestore(snap, live, d);
    }

    /** The restore dialog. Resolves 'keep' | 'restore' | null (dismissed). */
    _askRestore(snap, live, d = diffKeymapLayers(snap.layers, live)) {
        return new Promise((resolve) => {
            const when = snap.savedAt ? new Date(snap.savedAt).toLocaleString() : 'an unknown time';
            const list = el('div', { class: 'restore-diff', 'data-restore-diff': '', hidden: true,
                style: 'max-height:240px; overflow:auto; margin-top:8px; font-size:12px' });
            // Saved bindings name their behavior (ids drift across builds): resolve
            // by name on this device, then describe like the board does.
            const byName = new Map([...zmkBehaviors()].map(([id, d]) => [d.displayName, id]));
            const label = (b) => {
                if (!b) return '—';
                const id = (b.behavior && byName.get(b.behavior)) ?? b.behaviorId;
                try { return bindingDescribe({ behaviorId: id, param1: b.param1 >>> 0, param2: b.param2 >>> 0 }); }
                catch { return b.behavior ?? `#${b.behaviorId}`; }
            };
            for (const c of d.changed) {
                const rows = c.positions.map((p) => el('div', { class: 'mono' },
                    `key ${p}: keyboard ${label(live[c.layer]?.bindings?.[p])} · saved ${label(snap.layers[c.layer]?.bindings?.[p])}`));
                list.append(el('div', { style: 'margin-top:6px' },
                    el('b', { text: `${c.name}${c.renamed ? ` (saved name: ${snap.layers[c.layer]?.name || '—'})` : ''}` }), ...rows));
            }
            let back = null;
            const done = (choice) => {
                if (back?.isConnected) back.remove();
                obs.disconnect();
                resolve(choice);
            };
            // A backdrop click removes the dialog without a choice.
            const obs = new MutationObserver(() => { if (back && !back.isConnected) done(null); });
            const keep = el('button', { class: 'btn primary', 'data-act': 'keep', text: 'Keep keyboard',
                onclick: () => { this._writeSnapshot(); toast('Kept the keyboard\'s keymap; it is now the saved copy'); done('keep'); } });
            const restore = el('button', { class: 'btn', 'data-act': 'restore', text: 'Restore saved copy',
                onclick: async () => { done('restore'); await this._restoreSnapshot(snap, live); } });
            const show = el('button', { class: 'btn', 'data-act': 'diff', text: 'Show differences',
                onclick: () => { list.hidden = !list.hidden; show.textContent = list.hidden ? 'Show differences' : 'Hide differences'; } });
            back = modal('Keymap differs', el('div', { 'data-restore-dialog': '' },
                el('p', { 'data-restore-summary': '', text: keymapDiffSummary(d) + '.' }),
                el('p', { class: 'faint', text: `Saved copy from ${when}. Keep keyboard makes the keyboard's keymap the saved copy. Restore writes the saved copy live; Save in the status bar keeps it.` }),
                list), [keep, restore, show]);
            back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
            obs.observe(document.body, { childList: true });
            keep.focus();
        });
    }

    /** The snapshot is per keyboard, so it is always this board's family
     * (an unlabelled file counts as Imprint in zmkFamilyMismatch). */
    _family() { return this.app?.profile?.family ?? this.app?.family; }

    /** Restore saved copy: write it live, never save; ⟲ undoes. */
    async _restoreSnapshot(snap, live) {
        this._preRestore = { layers: live };
        const res = await this.applyKeymapData(
            { kind: 'flask-zmk-keymap', version: 2, family: this._family(), layers: snap.layers }, { quiet: true });
        if (!res || res.stopped) { this._preRestore = null; return; }   // applier already toasted
        const skipNote = res.skipped ? `, ${res.skipped} unresolvable skipped` : '';
        toast(`Saved copy restored live (${res.wrote} keys, ${res.renamed} names${skipNote}). Save in the status bar keeps it; ⟲ in the toolbar undoes.`);
        this.render();
    }

    /** Put back the keymap the keyboard had before Restore saved copy.
     * Live only, like the restore; nothing is saved. */
    async _undoKeymapRestore() {
        const pre = this._preRestore;
        if (!pre) return;
        const res = await this.applyKeymapData(
            { kind: 'flask-zmk-keymap', version: 2, family: this._family(), layers: pre.layers }, { quiet: true });
        if (!res || res.stopped) return;
        this._preRestore = null;
        toast('Restore undone: the keyboard\'s own keymap is back (live)');
        this.render();
    }

    /** Feed the HUD: publish device-sourced geometry, layer names, and the
     * live keymap onto the shared app state so the HUD board renders ZMK
     * bindings and follows the active layer. ZMK-module-mutates-shared-state
     * is the sanctioned pattern (no QMK code changes). */
    _publishToApp() {
        const { app } = this;
        if (!app?.profile || !this.geomKeys || !this.keymap) return;
        app.profile.keys = this.geomKeys;
        app.profile.labelFor = bindingCap;
        app.profile.hoverFor = bindingHover;
        app.profile.keyName = (k) => String(k.pos);
        app.profile.layerNames = this.keymap.layers.map((l, i) => l.name || `Layer ${i}`);
        app.layerCount = this.keymap.layers.length;
        // HUD reads [layer][row][col]; our rows collapse to row 0.
        app.keymap = this.keymap.layers.map((l) => [l.bindings]);
        app.hud?.open && app.hud.render();
    }

    _setContext(behaviors) {
        setZmkContext({
            behaviors,
            layers: this.keymap.layers.map((l) => ({ id: l.id, name: l.name })),
        });
        // The usage-picker chips need the key-press behavior. Cosmetic name
        // first (stable in ZMK), metadata shape as fallback.
        this.keyPressId = null;
        for (const [id, d] of behaviors) {
            if (d.displayName === 'Key Press') { this.keyPressId = id; break; }
        }
        if (this.keyPressId == null) {
            const candidates = [...behaviors.values()].filter((d) => {
                const p1 = d.metadata?.[0]?.param1 ?? [];
                const p2 = d.metadata?.[0]?.param2 ?? [];
                return p1.some((x) => x.kind === 'hid_usage')
                    && !p2.some((x) => x.kind !== 'nil');
            });
            if (candidates.length === 1) this.keyPressId = candidates[0].id;
            else console.warn('zmk: key-press behavior not resolved; usage chips hidden');
        }
    }

    // ---- lock / disconnect / error plumbing ----

    _onLockState(state) {
        if (state === LOCK_UNLOCKED) {
            if (this.state === 'locked') {
                if (this.keymap) { this.state = 'ready'; this.render(); }
                else this._loadEverything();
            }
        } else if (this.state === 'ready' || this.state === 'loading') {
            this.state = 'locked';
            this.render();
        }
    }

    _onSerialDisconnect() {
        this._releaseTabLock?.();
        this._setUnsaved(false);
        board.unbind(this.adapter);
        this.state = 'idle';
        this.render();
        toast('ZMK Studio serial disconnected', true);
    }

    _handleRpcError(e, prefix) {
        if (e.kind === 'unlockRequired') {
            this.state = 'locked';
            this.render();
            return;
        }
        if (e.kind === 'rpcNotFound') {
            this.state = 'error';
            this.statusMsg = 'This firmware has no ZMK Studio keymap support — rebuild with CONFIG_ZMK_STUDIO=y and the studio-rpc-usb-uart snippet.';
            this.render();
            return;
        }
        if (e.kind === 'notConnected') return;      // disconnect handler owns the UI
        this.state = 'error';
        this.statusMsg = `${prefix}: ${e.message}`;
        this.render();
    }

    /** Unsaved state lives in save-state (spec §3.2): the status bar shows
     * "Save N unsaved" plus Discard, and save-state owns the unload guard. */
    _setUnsaved(v) {
        this.unsaved = v;
        if (v) {
            saveState.markDirty('studio-keymap', 'Keymap', this._saveFn(), { discard: this._discardFn(), line: 'zmk' });
        } else {
            saveState.clean('studio-keymap');
        }
        this._updateSaveBar?.();
    }

    // saveAll() treats a throw as a failed save and a return as success, so
    // both fns throw when the tab reports failure (it has already toasted).
    _saveFn() {
        return (this._saveFnCached ??= async () => {
            if (!(await this.saveChanges())) throw new Error('Keymap not saved');
            return true;
        });
    }

    _discardFn() {
        return (this._discardFnCached ??= async () => {
            await this.discardChanges();
            if (this.unsaved) throw new Error('Discard failed');
            return true;
        });
    }

    // ---- editing ----

    // The current layer is the board's (ARRAY index into keymap.layers).
    get layer() { return board.layer; }
    set layer(i) { board.setLayer(i); }
    get currentLayer() { return this.keymap.layers[this.layer]; }
    get selected() { const k = board.selectedKey(); return k ? k.pos : null; }

    /** True (with a toast) while the board family is unresolved. */
    _familyBlocked() {
        if (!this.app?.familyUnresolved) return false;
        toast(ZMK_FAMILY_UNRESOLVED_MSG, true);
        return true;
    }

    /** Assign to the board's selected key (type-to-assign, picker). */
    assign(binding) { return board.assign(binding); }

    /** The device write behind board.assign / undo / redo. false = refused
     * (already toasted); a throw is a failed write (the board toasts it). */
    async _writeBinding(layerIdx, pos, binding) {
        if (this._familyBlocked()) return false;
        const layer = this.keymap.layers[layerIdx];
        try {
            await this.client.setLayerBinding(layer.id, pos, binding);
        } catch (e) {
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return false; }
            throw e;
        }
        layer.bindings[pos] = binding;
        this._setUnsaved(true);     // optimistic; the notification confirms
        // app.keymap shares this layer's bindings array: repaint the HUD.
        this.app.hud?.open && this.app.hud.render();
        toast(`Key ${pos} → ${bindingDescribe(binding)}`);
        return true;
    }

    _makeAdapter() {
        const tab = this;
        const ops = {
            canMove: (d) => { const to = tab.layer + d; return to >= 0 && to < tab.keymap.layers.length; },
            get canRemove() { return tab.keymap.layers.length > 1; },
            get addReason() {
                const n = tab.keymap.availableLayers ?? 0;
                return n > 0 ? null : 'No free slots — remove a layer first (total capacity is compiled into the firmware)';
            },
            get restoreLabel() { return tab.removedLayers.at(-1)?.name ?? null; },
            move: (d) => tab.moveLayerOp(d),
            remove: () => tab.removeLayerOp(),
            add: () => tab.addLayerOp(),
            restore: () => tab.restoreLayerOp(),
        };
        const emptyBinding = (b) => {
            const name = zmkBehaviors().get(b?.behaviorId)?.displayName;
            return !b || name === 'None' || name === 'Transparent';
        };
        return {
            surface: 'zmk.key',
            get app() { return tab.app; },
            get readOnly() { return tab.state !== 'ready'; },
            get profile() {
                return {
                    family: tab.app?.profile?.family ?? tab.app?.family,
                    keys: tab.geomKeys, encoderKeys: [], displayTile: null,
                    labelFor: bindingCap, hoverFor: bindingHover, capAdapter: 'zmk-studio',
                    keyName: (k) => String(k.pos),
                    decorations: tab.app?.profile?.decorations ?? [],
                };
            },
            layers: () => tab.keymap.layers.map((l, index) => ({
                index, name: l.name || `Layer ${index}`, empty: l.bindings.every(emptyBinding),
            })),
            bindingAt: (layer, sel) => tab.keymap.layers[layer]?.bindings[sel.col] ?? null,
            write: (layer, sel, binding) => tab._writeBinding(layer, sel.col, binding),
            posOf: (sel) => sel.col,
            selOf: (pos) => (Number.isInteger(pos) ? { kind: 'key', row: 0, col: pos } : null),
            renameLayer: (layer, name) => tab.renameLayer(name, layer),
            layerOps: () => ops,
        };
    }

    /** Returns true only when the save landed. */
    async saveChanges() {
        if (this._familyBlocked()) return false;
        try {
            await this.client.saveChanges();
            this._setUnsaved(false);
            // What's saved on the device is Flask's copy of record — the
            // auto-restore snapshot follows every successful save.
            this._writeSnapshot();
            toast('Saved to keyboard');
            return true;
        } catch (e) {
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return false; }
            toast(`Save failed: ${e.message}`, true);
            return false;
        }
    }

    async discardChanges() {
        try {
            await this.client.discardChanges();
            this.keymap = await this.client.getKeymap();
            if (this.layer >= this.keymap.layers.length) this.layer = 0;
            this.removedLayers = [];    // structure reverted device-side
            board.resetHistory();
            this._setContextFromCurrent();
            this._publishToApp();   // discard re-fetched: new arrays, republish
            this._setUnsaved(false);
            this.render();
            toast('Changes discarded');
        } catch (e) {
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return; }
            toast(`Discard failed: ${e.message}`, true);
        }
    }

    // ---- layer structure ops ----

    _layerOpError(e, what) {
        if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return; }
        toast(`${what} failed: ${e.message}`, true);
    }

    _afterLayerStructureChange() {
        board.select(null);
        board.resetHistory();       // history addresses layers by index
        this._setUnsaved(true);     // optimistic; the notification confirms
        this._setContextFromCurrent();
        this._publishToApp();
        this.render();
    }

    async addLayerOp() {
        if (this._familyBlocked()) return;
        try {
            const { index, layer } = await this.client.addLayer();
            if (layer && index >= 0) {
                this.keymap.layers.splice(index, 0, layer);
                this.keymap.availableLayers = Math.max(0, (this.keymap.availableLayers ?? 1) - 1);
                this.layer = index;
            } else {
                this.keymap = await this.client.getKeymap();    // defensive resync
                this.layer = this.keymap.layers.length - 1;
            }
            this._afterLayerStructureChange();
            toast('Layer added');
        } catch (e) { this._layerOpError(e, 'Add layer'); }
    }

    async removeLayerOp() {
        if (this._familyBlocked()) return;
        if (this.keymap.layers.length <= 1) { toast('Cannot remove the last layer', true); return; }
        const idx = this.layer;
        const gone = this.currentLayer;
        try {
            await this.client.removeLayer(idx);
            this.keymap.layers.splice(idx, 1);
            this.keymap.availableLayers = (this.keymap.availableLayers ?? 0) + 1;
            this.removedLayers.push({ id: gone.id, name: gone.name || `Layer ${idx}`, atIndex: idx });
            this.layer = Math.min(idx, this.keymap.layers.length - 1);
            this._afterLayerStructureChange();
            toast(`Removed "${gone.name || idx}" — slot freed for Add layer`);
        } catch (e) { this._layerOpError(e, 'Remove layer'); }
    }

    async restoreLayerOp() {
        if (this._familyBlocked()) return;
        const item = this.removedLayers[this.removedLayers.length - 1];
        if (!item) return;
        const at = Math.min(item.atIndex, this.keymap.layers.length);
        try {
            const layer = await this.client.restoreLayer(item.id, at);
            this.removedLayers.pop();
            if (layer) {
                this.keymap.layers.splice(at, 0, layer);
                this.keymap.availableLayers = Math.max(0, (this.keymap.availableLayers ?? 1) - 1);
            } else {
                this.keymap = await this.client.getKeymap();    // defensive resync
            }
            this.layer = Math.min(at, this.keymap.layers.length - 1);
            this._afterLayerStructureChange();
            toast(`Restored "${item.name}"`);
        } catch (e) { this._layerOpError(e, 'Restore layer'); }
    }

    async moveLayerOp(delta) {
        if (this._familyBlocked()) return;
        const from = this.layer;
        const to = from + delta;
        if (to < 0 || to >= this.keymap.layers.length) return;
        try {
            const km = await this.client.moveLayer(from, to);
            if (km) {
                this.keymap = km;   // device supplied the post-move truth
            } else {
                const [l] = this.keymap.layers.splice(from, 1);
                this.keymap.layers.splice(to, 0, l);
            }
            this.layer = to;
            this._afterLayerStructureChange();
        } catch (e) { this._layerOpError(e, 'Move layer'); }
    }

    // ---- keymap file export / import ----

    /** The v2 export payload: keymap layers + (when the device has Flask HID)
     * every module section. ONE builder on purpose — the Modes tab captures a
     * mode with this exact call, so a mode and an export file can never drift
     * into two shapes. `quiet` skips the progress toasts a background capture
     * shouldn't emit. */
    async buildExportData({ quiet = false } = {}) {
        const data = {
            kind: 'flask-zmk-keymap',
            version: 2,
            family: this.app?.profile?.family ?? this.app?.family,
            device: this.deviceName,
            exported: new Date().toISOString(),
            // Display name first-class: behavior ids can shift across
            // firmware builds, names are stable. Same shape as the
            // auto-restore snapshot (zmk-keymap-sync.js).
            layers: keymapLayersData(this.keymap, zmkBehaviors()),
        };
        // v2: full-device backup — tunables + RGB map/effect + every runtime
        // slot table ride along (the ZMK .vil equivalent; a re-flash wipes
        // the settings partition, this file restores it).
        if (this.app?.flask && this.app?.caps?.flask) {
            try {
                if (!quiet) toast('Reading module state…');
                data.flask = await exportFlaskState(this.app);
            } catch (e) {
                toast(`Module state skipped: ${e.message}`, true);
            }
        }
        return data;
    }

    async exportKeymap() {
        const data = await this.buildExportData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = el('a', {
            href: URL.createObjectURL(blob),
            download: `${(this.deviceName || 'zmk').replace(/\s+/g, '-').toLowerCase()}-keymap.json`,
        });
        a.click();
        URL.revokeObjectURL(a.href);
        toast(data.flask ? 'Keymap + module state exported' : 'Keymap exported');
    }

    async importKeymap(file) {
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch {
            toast('Not a JSON file', true);
            return;
        }
        // null = refused (not a keymap export, or another family's file) —
        // the module state must not land either.
        if (await this.applyKeymapData(data) === null) return;
        // v2 files carry module state (tunables/RGB/slot tables) — apply it
        // through the Flask channels + SAVE. Auto-sync's queued keymaps never
        // carry this section (module edits ride their own journals).
        if (data?.flask && this.app?.flask && this.app?.caps?.flask) {
            try {
                toast('Applying module state…');
                const { applied, failures } = await applyFlaskState(this.app, data.flask);
                toast(failures.length
                    ? `Module state: ${applied} writes, ${failures.length} sections failed (${failures[0]})`
                    : `Module state restored: ${applied} writes, saved`, failures.length > 0);
            } catch (e) {
                toast(`Module state failed: ${e.message}`, true);
            }
        }
    }

    /** Core applier for export-shaped keymap JSON — used by Import… and by
     * the offline-preview auto-sync. Behavior display names are the
     * cross-device identity (ids shift across builds and differ between the
     * offline sim and real firmware); ids are only a same-build fallback.
     * quiet suppresses the success toast (the auto-sync has its own). */
    async applyKeymapData(data, { quiet = false } = {}) {
        if (this._familyBlocked()) return null;
        if (data?.kind !== 'flask-zmk-keymap' || !Array.isArray(data.layers)) {
            toast('Not a flask ZMK keymap export', true);
            return null;
        }
        const mismatch = zmkFamilyMismatch(data.family, this.app?.profile?.family ?? this.app?.family);
        if (mismatch) {
            toast(mismatch, true);
            return null;
        }
        const behaviors = zmkBehaviors();
        const byName = new Map();
        for (const [id, d] of behaviors) byName.set(d.displayName, id);
        const resolve = (fb) => byName.get(fb.behavior)
            ?? (behaviors.has(fb.behaviorId) ? fb.behaviorId : null);

        const layerCount = Math.min(data.layers.length, this.keymap.layers.length);
        let wrote = 0, skipped = 0, renamed = 0, stopped = false;
        try {
            for (let li = 0; li < layerCount; li++) {
                const src = data.layers[li];
                const dst = this.keymap.layers[li];
                const n = Math.min(src.bindings?.length ?? 0, dst.bindings.length);
                for (let pos = 0; pos < n; pos++) {
                    const fb = src.bindings[pos];
                    const id = resolve(fb);
                    if (id == null) { skipped++; continue; }
                    const binding = {
                        behaviorId: id,
                        param1: (fb.param1 ?? 0) >>> 0,
                        param2: (fb.param2 ?? 0) >>> 0,
                    };
                    const cur = dst.bindings[pos];
                    if (cur && cur.behaviorId === id
                        && cur.param1 === binding.param1
                        && cur.param2 === binding.param2) continue;
                    await this.client.setLayerBinding(dst.id, pos, binding);
                    dst.bindings[pos] = binding;
                    wrote++;
                }
                const name = (src.name || '').trim().slice(0, this.keymap.maxLayerNameLength || 20);
                if (name && name !== dst.name) {
                    await this.client.setLayerProps(dst.id, name);
                    dst.name = name;
                    renamed++;
                }
            }
        } catch (e) {
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return null; }
            toast(`Import stopped: ${e.message} (${wrote} keys applied so far)`, true);
            stopped = true;
        }
        if (wrote || renamed) this._setUnsaved(true);
        this._setContextFromCurrent();
        this._publishToApp();
        this.render();
        const layerNote = data.layers.length !== this.keymap.layers.length
            ? ` — file has ${data.layers.length} layers, device ${this.keymap.layers.length}` : '';
        if (!quiet) {
            toast(`Import: ${wrote} keys written, ${renamed} renamed`
                + `${skipped ? `, ${skipped} skipped (unknown behavior)` : ''}${layerNote}. Save to persist.`);
        }
        return { wrote, renamed, skipped, stopped };
    }

    /** Rename a layer on the device (Studio SetLayerProps). Throws on a
     * failed write so the board can say so; locked/blocked just return. */
    async renameLayer(newName, layerIdx = this.layer) {
        if (this._familyBlocked()) return;
        const layer = this.keymap.layers[layerIdx];
        const name = newName.trim().slice(0, this.keymap.maxLayerNameLength || 20);
        if (!name || name === layer.name) return;
        try {
            await this.client.setLayerProps(layer.id, name);
        } catch (e) {
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return; }
            throw e;
        }
        layer.name = name;
        this._setContextFromCurrent();      // picker layer dropdowns update
        this._publishToApp();               // HUD layer strip names
        this._setUnsaved(true);
        this.render();
    }

    _setContextFromCurrent() {
        setZmkContext({
            behaviors: zmkBehaviors(),
            layers: this.keymap.layers.map((l) => ({ id: l.id, name: l.name })),
        });
    }

    // ---- rendering ----

    render() {
        switch (this.state) {
        case 'unsupported':
            this.root.replaceChildren(card('Keymap', 'ZMK Studio',
                el('p', { class: 'muted', text: 'Live keymap editing needs WebSerial, which this browser lacks. Use Chrome or Edge.' })));
            return;
        case 'idle':
            this.root.replaceChildren(card('Keymap', 'ZMK Studio',
                el('p', { class: 'muted', text: 'The keymap is edited live over the ZMK Studio serial port — a separate USB endpoint from the tuning connection.' }),
                el('button', { class: 'btn', text: 'Connect ZMK Studio', onclick: () => this._connect(true) })));
            return;
        case 'connecting':
        case 'loading':
            this.root.replaceChildren(card('Keymap', 'ZMK Studio',
                el('p', { class: 'muted', text: this.statusMsg || 'Connecting…' })));
            return;
        case 'error':
            this.root.replaceChildren(card('Keymap', 'ZMK Studio',
                el('p', { class: 'muted', text: this.statusMsg }),
                el('button', { class: 'btn small', text: 'Retry', onclick: () => this._handshake() })));
            return;
        case 'locked': {
            const boardHost = el('div');
            this.root.replaceChildren(card(this.deviceName ?? 'Keymap', 'ZMK Studio — locked',
                el('p', { class: 'muted', html: '' },
                    'Keymap is locked. Press the ',
                    el('b', { text: 'Studio Unlock' }),
                    ' key on the board (Control layer, right-inner thumb) — editing resumes automatically.'),
                this.keymap ? boardHost : null));
            if (this.keymap) { board.bind(this.adapter); board.place(boardHost, shell.regions); }
            return;
        }
        case 'ready': {
            const boardHost = el('div');
            const rest = el('div', {});
            this.root.replaceChildren(card(this.deviceName ?? 'Keymap',
                `${this.keymap.layers.length} layers · ZMK Studio`, boardHost, rest));
            board.bind(this.adapter);
            board.place(boardHost, shell.regions);
            this._buildKeysBody(rest);
            return;
        }
        }
    }

    /** Keys-group content under the board: state line, type-to-assign, undo
     * restore, hint, docked picker. Save/Discard/Export/Import are the status
     * bar's (save-state, WP6); exportKeymap/importKeymap stay as methods. */
    _buildKeysBody(host) {
        // Type-to-assign: while armed, physical keypresses assign to the
        // selected key (and auto-advance) instead of reaching the browser —
        // preventDefault at window capture phase keeps ⌘S/⌘W/Tab etc from
        // firing. Esc disarms. Modifier-only presses assign the bare mod;
        // mod+key assigns the modified usage (ZMK implicit-mod bits).
        const capture = el('button', { class: 'btn small', text: '⌨ Type-to-assign' });
        capture.addEventListener('click', () => this._setCapture(!this._captureOn, capture));
        this._captureBtn = capture;
        const note = el('span', { class: 'state' });
        const bar = el('div', { class: 'bd-tabbar' },
            note, el('span', { style: 'flex:1' }), capture,
            ...(this._preRestore ? [el('button', {
                class: 'btn small', text: '⟲ Undo restore',
                'data-caption': 'Put back the keymap the keyboard had before Restore saved copy',
                onclick: () => this._undoKeymapRestore(),
            })] : []));
        this._updateSaveBar = () => {
            // Canonical live/saved vocabulary (spec §3.2, ui.js SAVE_STATE).
            bar.dataset.state = this.unsaved ? 'live' : 'saved';
            note.textContent = this.unsaved
                ? 'Live — reverts on power-off · Save is in the status bar'
                : SAVE_STATE.saved;
        };
        this._updateSaveBar();
        const pickerHost = el('div');
        host.replaceChildren(bar,
            el('div', { class: 'faint', style: 'margin-top:6px; font-size:12px' },
                'Click a key, then pick a binding; click it again for a popover. Writes apply immediately.'),
            pickerHost);
        this.closePicker?.();
        this.closePicker = openPicker({
            surface: 'zmk.key', host: 'docked', anchor: pickerHost, app: this.app,
            onPick: (binding) => board.assign(binding),
        });
    }

    _setCapture(on, btn = this._captureBtn) {
        if (this._captureHandler) {
            window.removeEventListener('keydown', this._captureHandler, true);
            this._captureHandler = null;
        }
        if (this._captureUpHandler) {
            window.removeEventListener('keyup', this._captureUpHandler, true);
            this._captureUpHandler = null;
        }
        this._captureOn = on;
        if (btn) {
            btn.classList.toggle('primary', on);
            btn.textContent = on ? '⌨ Capturing… (Esc stops)' : '⌨ Type-to-assign';
        }
        if (!on) return;
        if (this.keyPressId == null) {
            toast('This firmware exposes no Key Press behavior', true);
            this._setCapture(false, btn);
            return;
        }
        let modPending = null; // mod pressed, waiting: solo release = bare mod
        this._captureHandler = (e) => {
            // Auto-disarm if the user navigated away — never swallow keys
            // while another tab is showing.
            if (!this.root.closest('.panel.active')) { this._setCapture(false); return; }
            e.preventDefault();
            e.stopPropagation();
            if (e.repeat) return;
            if (e.key === 'Escape') { this._setCapture(false); return; }
            const param = eventToUsageParam(e);
            if (param == null) return;
            if ((param & 0xFFFF) >= 0xE0) {
                // Modifier down: don't assign yet — it may be a chord prefix
                // (⌃ on the way to ⌃C). Solo release assigns the bare mod.
                modPending = { code: e.code, param };
                return;
            }
            modPending = null; // consumed as a chord
            if (this.selected == null) { toast('Click a key on the board first'); return; }
            this.assign({ behaviorId: this.keyPressId, param1: param, param2: 0 });
        };
        this._captureUpHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (modPending && e.code === modPending.code) {
                if (this.selected != null) {
                    this.assign({ behaviorId: this.keyPressId, param1: modPending.param, param2: 0 });
                }
                modPending = null;
            }
        };
        window.addEventListener('keydown', this._captureHandler, true);
        window.addEventListener('keyup', this._captureUpHandler, true);
        toast('Type-to-assign armed — press keys to fill the selected position; Esc stops');
    }
}
