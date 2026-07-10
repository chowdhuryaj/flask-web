// ZMK keymap editor tab — live keymap editing over ZMK Studio RPC
// (WebSerial). ZMK-line module: the Vial-for-ZMK surface. The device is the
// source of truth for everything rendered here — key geometry
// (get_physical_layouts), layers/bindings (get_keymap), and the behavior
// catalog (behaviors subsystem) all arrive over the wire on connect.
//
// Reuses the shared renderKeyboardSVG via profile-carried label functions
// (bindings are {behaviorId,param1,param2} objects, not QMK ints).

import { el, toast, card } from './ui.js?v=9';
import { renderKeyboardSVG } from './keymap-tab.js?v=9';
import { StudioClient, StudioError, LOCK_UNLOCKED } from './zmk-studio.js?v=9';
import { zmkApplyPendingKeymap } from './zmk-offline.js?v=9';
import { exportFlaskState, applyFlaskState } from './zmk-export.js?v=9';
import { ZMK_VIDPID } from './zmk.js?v=9';
import { basicKeys, navKeys, fKeys, numpadKeys, intlKeys } from './keycodes.js?v=9';
import {
    consumerUsages, kpParam, cpParam, usageFromName, eventToUsageParam,
    setZmkContext, zmkBehaviors, zmkLayers, layerName,
    bindingCap, bindingHover, bindingDescribe,
} from './zmk-keycodes.js?v=9';

// One serial client for the whole page: tab instances are discarded on HID
// disconnect/reconnect (main.js rebuilds all panels) with no dtor hook, so
// a per-instance client would leak an open port and block the next connect.
let sharedClient = null;
let activeTabAbort = null;      // event listeners of the superseded instance

function studioClient() {
    if (!sharedClient) sharedClient = new StudioClient();
    return sharedClient;
}

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
        this.layer = 0;         // ARRAY index into keymap.layers
        this.selected = null;   // key position (col) or null
        this.unsaved = false;
        this.keyPressId = null;
        this.renaming = false;
        this.removedLayers = [];    // session undo stack for remove-layer

        // Rebind client events to THIS instance (abort the previous one's).
        activeTabAbort?.abort();
        activeTabAbort = new AbortController();
        const signal = activeTabAbort.signal;
        this.client.addEventListener('lockstate', (e) => this._onLockState(e.detail), { signal });
        this.client.addEventListener('unsaved', (e) => this._setUnsaved(e.detail), { signal });
        this.client.addEventListener('disconnect', () => this._onSerialDisconnect(), { signal });

        this._beforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
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
            this.geomKeys = layout.keys.map((k, i) => ({
                row: 0, col: i, pos: i, label: `Key ${i}`,
                x: k.x, y: k.y, w: k.w, h: k.h,
            }));

            this.statusMsg = 'Reading keymap…';
            this.render();
            this.keymap = await this.client.getKeymap();
            if (this.layer >= this.keymap.layers.length) this.layer = 0;

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
            this._applyUnloadGuard();
            this._publishToApp();
            this.state = 'ready';
            this.render();
            await this._applyQueuedOfflineKeymap();
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

    _setUnsaved(v) {
        this.unsaved = v;
        this._applyUnloadGuard();
        this._updateSaveBar?.();
    }

    _applyUnloadGuard() {
        window.removeEventListener('beforeunload', this._beforeUnload);
        if (this.unsaved) window.addEventListener('beforeunload', this._beforeUnload);
    }

    // ---- editing ----

    get currentLayer() { return this.keymap.layers[this.layer]; }

    async assign(binding) {
        if (this.selected == null) { toast('Click a key first'); return; }
        const pos = this.selected;
        const layer = this.currentLayer;
        try {
            await this.client.setLayerBinding(layer.id, pos, binding);
            layer.bindings[pos] = binding;
            this._setUnsaved(true);     // optimistic; the notification confirms
            // Vial-style auto-advance to the next key position.
            this.selected = pos + 1 < this.geomKeys.length ? pos + 1 : null;
            this.renderBoard();
            // app.keymap shares this layer's bindings array — repaint the HUD.
            this.app.hud?.open && this.app.hud.render();
            toast(`Key ${pos} → ${bindingDescribe(binding)}`);
        } catch (e) {
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return; }
            toast(`Write failed: ${e.message}`, true);
        }
    }

    async saveChanges() {
        try {
            await this.client.saveChanges();
            this._setUnsaved(false);
            toast('Saved to keyboard');
        } catch (e) {
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return; }
            toast(`Save failed: ${e.message}`, true);
        }
    }

    async discardChanges() {
        try {
            await this.client.discardChanges();
            this.keymap = await this.client.getKeymap();
            if (this.layer >= this.keymap.layers.length) this.layer = 0;
            this.removedLayers = [];    // structure reverted device-side
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
        this.selected = null;
        this._setUnsaved(true);     // optimistic; the notification confirms
        this._setContextFromCurrent();
        this._publishToApp();
        this.render();
    }

    async addLayerOp() {
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

    async exportKeymap() {
        const behaviors = zmkBehaviors();
        const data = {
            kind: 'flask-zmk-keymap',
            version: 2,
            device: this.deviceName,
            exported: new Date().toISOString(),
            layers: this.keymap.layers.map((l) => ({
                name: l.name,
                bindings: l.bindings.map((b) => ({
                    // Display name first-class: behavior ids can shift across
                    // firmware builds, names are stable.
                    behavior: behaviors.get(b.behaviorId)?.displayName ?? null,
                    behaviorId: b.behaviorId,
                    param1: b.param1,
                    param2: b.param2,
                })),
            })),
        };
        // v2: full-device backup — tunables + RGB map/effect + every runtime
        // slot table ride along (the ZMK .vil equivalent; a re-flash wipes
        // the settings partition, this file restores it).
        if (this.app?.flask && this.app?.caps?.flask) {
            try {
                toast('Reading module state…');
                data.flask = await exportFlaskState(this.app);
            } catch (e) {
                toast(`Module state skipped: ${e.message}`, true);
            }
        }
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
        await this.applyKeymapData(data);
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
        if (data?.kind !== 'flask-zmk-keymap' || !Array.isArray(data.layers)) {
            toast('Not a flask ZMK keymap export', true);
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

    async renameLayer(newName) {
        const layer = this.currentLayer;
        const name = newName.trim().slice(0, this.keymap.maxLayerNameLength || 20);
        if (!name || name === layer.name) { this.renaming = false; this.render(); return; }
        try {
            await this.client.setLayerProps(layer.id, name);
            layer.name = name;
            this._setContextFromCurrent();      // picker layer dropdowns update
            this._publishToApp();               // HUD layer strip names
            this._setUnsaved(true);
            this.renaming = false;
            this.render();
        } catch (e) {
            this.renaming = false;
            if (e.kind === 'unlockRequired') { this.state = 'locked'; this.render(); return; }
            toast(`Rename failed: ${e.message}`, true);
            this.render();
        }
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
        case 'locked':
            this.root.replaceChildren(card(this.deviceName ?? 'Keymap', 'ZMK Studio — locked',
                el('p', { class: 'muted', html: '' },
                    'Keymap is locked. Press the ',
                    el('b', { text: 'Studio Unlock' }),
                    ' key on the board (Control layer, right-inner thumb) — editing resumes automatically.'),
                this.keymap ? this._buildBoardCardBody(true) : null));
            return;
        case 'ready':
            this.root.replaceChildren(card(this.deviceName ?? 'Keymap',
                `${this.keymap.layers.length} layers · ZMK Studio`,
                this._buildBoardCardBody(false)));
            return;
        }
    }

    _buildBoardCardBody(readOnly) {
        this.strip = el('div', { class: 'layer-strip' });
        this.boardWrap = el('div', { class: 'kb-wrap' });
        const bits = el('div', {});
        if (!readOnly) bits.append(this._buildToolbar());
        bits.append(this.strip, this.boardWrap);
        this.renderStrip(readOnly);
        this.renderBoard(readOnly);
        if (!readOnly) {
            bits.append(
                el('div', { class: 'faint', style: 'margin-top:6px; font-size:12px' },
                    'Click a key, then pick a binding. Writes apply immediately; Save makes them survive power-off.'),
                buildZmkPicker({
                    keyPressId: this.keyPressId,
                    onPick: (binding) => this.assign(binding),
                }),
            );
        }
        return bits;
    }

    /** Top toolbar, always visible next to the board: Save/Discard (disabled
     * until there's something unsaved) + keymap file export/import. */
    _buildToolbar() {
        const save = el('button', {
            class: 'btn small primary', text: 'Save to keyboard',
            onclick: () => this.saveChanges(),
        });
        const discard = el('button', {
            class: 'btn small', text: 'Discard',
            onclick: () => this.discardChanges(),
        });
        const note = el('span', { class: 'note' });
        const file = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
        file.addEventListener('change', () => {
            const f = file.files?.[0];
            file.value = '';
            if (f) this.importKeymap(f);
        });
        // Type-to-assign: while armed, physical keypresses assign to the
        // selected key (and auto-advance) instead of reaching the browser —
        // preventDefault at window capture phase keeps ⌘S/⌘W/Tab etc from
        // firing. Esc disarms. Modifier-only presses assign the bare mod;
        // mod+key assigns the modified usage (ZMK implicit-mod bits).
        const capture = el('button', { class: 'btn small', text: '⌨ Type-to-assign' });
        capture.addEventListener('click', () => this._setCapture(!this._captureOn, capture));
        this._captureBtn = capture;

        const bar = el('div', { class: 'savebar', style: 'margin: 0 0 10px' },
            save, discard, note,
            el('span', { style: 'flex:1' }),
            capture,
            el('button', {
                class: 'btn small', text: 'Export…',
                title: 'Download the current keymap (incl. unsaved edits) as a JSON file',
                onclick: () => this.exportKeymap(),
            }),
            el('button', {
                class: 'btn small', text: 'Import…',
                title: 'Apply a keymap JSON file live — then Save to persist',
                onclick: () => file.click(),
            }),
            file);
        this._updateSaveBar = () => {
            save.disabled = discard.disabled = !this.unsaved;
            note.textContent = this.unsaved
                ? 'Unsaved — live now, reverts on power-off.'
                : 'No unsaved changes.';
        };
        this._updateSaveBar();
        return bar;
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

    renderStrip(readOnly = false) {
        const buttons = this.keymap.layers.map((l, i) => el('button', {
            class: i === this.layer ? 'shown' : '',
            text: l.name || `Layer ${i}`,
            onclick: () => {
                if (i === this.layer && !readOnly) { this.renaming = true; this.render(); return; }
                this.layer = i;
                this.selected = null;
                this.renaming = false;
                this.renderStrip(readOnly);
                this.renderBoard(readOnly);
            },
            title: i === this.layer && !readOnly ? 'Click again to rename' : null,
        }));
        this.strip.replaceChildren(...buttons);
        if (!readOnly) this.strip.append(...this._stripOps());
        if (this.renaming && !readOnly) this._appendRenameInput();
    }

    /** Layer structure controls, appended to the strip: move ◀▶, remove −,
     * add ＋ (needs a freed slot), restore ↩ (session undo of remove). */
    _stripOps() {
        const avail = this.keymap.availableLayers ?? 0;
        const ops = [
            el('button', {
                text: '◀', title: 'Move this layer left (lower priority)',
                disabled: this.layer === 0,
                onclick: () => this.moveLayerOp(-1),
            }),
            el('button', {
                text: '▶', title: 'Move this layer right (higher priority)',
                disabled: this.layer >= this.keymap.layers.length - 1,
                onclick: () => this.moveLayerOp(1),
            }),
            el('button', {
                text: '−', title: 'Remove this layer (frees a slot; undo with ↩)',
                disabled: this.keymap.layers.length <= 1,
                onclick: () => this.removeLayerOp(),
            }),
            el('button', {
                text: '＋',
                title: avail > 0
                    ? `Add a layer (${avail} free slot${avail === 1 ? '' : 's'})`
                    : 'No free slots — remove a layer first (total capacity is compiled into the firmware)',
                disabled: avail === 0,
                onclick: () => this.addLayerOp(),
            }),
        ];
        if (this.removedLayers.length) {
            const last = this.removedLayers[this.removedLayers.length - 1];
            ops.push(el('button', {
                text: '↩', title: `Restore removed layer "${last.name}"`,
                onclick: () => this.restoreLayerOp(),
            }));
        }
        return ops;
    }

    _appendRenameInput() {
        const input = el('input', {
            type: 'text', value: this.currentLayer.name,
            maxlength: this.keymap.maxLayerNameLength || 20, size: 10,
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.renameLayer(input.value);
            if (e.key === 'Escape') { this.renaming = false; this.render(); }
        });
        input.addEventListener('blur', () => this.renameLayer(input.value));
        this.strip.append(input);
        queueMicrotask(() => { input.focus(); input.select(); });
    }

    renderBoard(readOnly = false) {
        const profile = {
            keys: this.geomKeys,
            encoderKeys: [],
            displayTile: null,
            labelFor: bindingCap,
            hoverFor: bindingHover,
            keyName: (k) => String(k.pos),
        };
        this.boardWrap.replaceChildren(renderKeyboardSVG({
            profile,
            keycodeAt: (row, col) => this.currentLayer.bindings[col] ?? null,
            selected: this.selected != null ? { kind: 'key', row: 0, col: this.selected } : null,
            onSelect: readOnly ? null : (sel) => { this.selected = sel.col; this.renderBoard(); },
        }));
    }
}

// ---------------------------------------------------------------------------
// ZMK binding picker — same DOM shape/CSS as the QMK picker (.picker/.cats/
// .codes/.composer), but emits {behaviorId, param1, param2} objects and
// drives composers from device behavior METADATA instead of QMK bit math.

const USAGE_CATEGORIES = [
    { id: 'basic', label: 'Basic', keys: basicKeys, toParam: kpParam },
    { id: 'nav', label: 'Nav', keys: navKeys, toParam: kpParam },
    { id: 'fkeys', label: 'F-keys', keys: fKeys, toParam: kpParam },
    { id: 'numpad', label: 'Numpad', keys: numpadKeys, toParam: kpParam },
    { id: 'intl', label: 'Intl', keys: intlKeys, toParam: kpParam },
    { id: 'media', label: 'Media', keys: consumerUsages, toParam: cpParam },
];

export function buildZmkPicker({ keyPressId, onPick }) {
    const behaviors = zmkBehaviors();
    let category = keyPressId != null ? 'basic' : 'behaviors';
    let query = '';

    const root = el('div', { class: 'picker' });
    const cats = el('div', { class: 'cats' });
    const search = el('input', { type: 'search', placeholder: 'Search keys…' });
    const codes = el('div', { class: 'codes' });

    search.addEventListener('input', () => { query = search.value.toLowerCase(); renderCodes(); });

    const byName = (name) =>
        [...behaviors.values()].find((d) => d.displayName === name) ?? null;

    // Layer-parameter behaviors (MO/TO/TG/SL… discovered by metadata shape).
    const layerBehaviors = [...behaviors.values()].filter((d) => {
        const p1 = d.metadata?.[0]?.param1 ?? [];
        return p1.some((x) => x.kind === 'layer_id');
    });

    function renderCats() {
        const chips = [];
        if (keyPressId != null) {
            chips.push(...USAGE_CATEGORIES.map((c) => ({ id: c.id, label: c.label })));
        }
        if (layerBehaviors.length) chips.push({ id: 'layers', label: 'Layers' });
        chips.push({ id: 'behaviors', label: 'Behaviors' });
        cats.replaceChildren(...chips.map((c) => el('button', {
            class: c.id === category ? 'active' : '',
            text: c.label,
            onclick: () => { category = c.id; renderCats(); renderCodes(); },
        })));
    }

    function usageButton(key, toParam) {
        return el('button', {
            class: 'code', title: key.label,
            onclick: () => onPick({ behaviorId: keyPressId, param1: toParam(key.code), param2: 0 }),
        }, key.cap || '·', el('span', { class: 'full', text: key.label }));
    }

    function specialButtons() {
        const out = [];
        for (const name of ['Transparent', 'None']) {
            const d = byName(name);
            if (d) {
                out.push(el('button', {
                    class: 'code', title: name,
                    onclick: () => onPick({ behaviorId: d.id, param1: 0, param2: 0 }),
                }, name === 'Transparent' ? '▽' : '∅', el('span', { class: 'full', text: name })));
            }
        }
        return out;
    }

    function renderCodes() {
        root.querySelector('.composer')?.remove();
        codes.replaceChildren();
        if (query && keyPressId != null) {
            const hits = USAGE_CATEGORIES.flatMap((c) =>
                c.keys.filter((k) => k.label.toLowerCase().includes(query)
                    || k.cap.toLowerCase().includes(query))
                    .map((k) => usageButton(k, c.toParam)));
            codes.append(...hits);
            return;
        }
        if (category === 'layers') { renderLayerComposer(); return; }
        if (category === 'behaviors') { renderBehaviorComposer(); return; }
        const cat = USAGE_CATEGORIES.find((c) => c.id === category);
        if (!cat) return;
        codes.append(...cat.keys.map((k) => usageButton(k, cat.toParam)));
        if (category === 'basic') codes.append(...specialButtons());
    }

    function layerSelect() {
        return el('select', {}, ...zmkLayers().map((l) =>
            el('option', { value: l.id, text: l.name || `Layer#${l.id}` })));
    }

    function renderLayerComposer() {
        const sel = layerSelect();
        const rows = [el('label', { text: 'Layer:' }), sel];
        for (const d of layerBehaviors) {
            const p2 = d.metadata?.[0]?.param2 ?? [];
            const wantsKey = p2.some((x) => x.kind === 'hid_usage');
            if (!wantsKey) {
                rows.push(el('button', {
                    class: 'code', title: d.displayName,
                    onclick: () => onPick({ behaviorId: d.id, param1: Number(sel.value), param2: 0 }),
                }, d.displayName));
            } else {
                // &lt-style: layer + tap key.
                const kcInput = el('input', { type: 'text', placeholder: 'tap key, e.g. A', size: 10 });
                rows.push(el('button', {
                    class: 'code', title: `${d.displayName}: hold for the layer, tap for the key`,
                    onclick: () => {
                        const usage = usageFromName(kcInput.value);
                        if (usage == null) { toast('Type a tap key first (e.g. A)', true); return; }
                        onPick({ behaviorId: d.id, param1: Number(sel.value), param2: usage });
                    },
                }, d.displayName), kcInput);
            }
        }
        codes.append(el('div', { class: 'composer' }, ...rows));
    }

    function renderBehaviorComposer() {
        // Universal fallback: every device behavior, params driven by its
        // metadata descriptors — zero curation needed.
        const list = [...behaviors.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
        const bhvSel = el('select', {}, ...list.map((d) =>
            el('option', { value: d.id, text: d.displayName })));
        const paramsBox = el('span', {});
        const assign = el('button', { class: 'code', text: 'Assign' });
        let readParams = () => [0, 0];

        function buildParamEditors() {
            const d = behaviors.get(Number(bhvSel.value));
            const editors = [];
            const readers = [];
            for (const which of ['param1', 'param2']) {
                const descs = d?.metadata?.[0]?.[which] ?? [];
                const used = descs.some((x) => x.kind !== 'nil');
                if (!used) { readers.push(() => 0); continue; }
                const hid = descs.find((x) => x.kind === 'hid_usage');
                const layer = descs.find((x) => x.kind === 'layer_id');
                const range = descs.find((x) => x.kind === 'range');
                const constants = descs.filter((x) => x.kind === 'constant');
                if (constants.length) {
                    const sel = el('select', {}, ...constants.map((c) =>
                        el('option', { value: c.constant, text: c.name || String(c.constant) })));
                    editors.push(sel);
                    readers.push(() => Number(sel.value) >>> 0);
                } else if (layer) {
                    const sel = layerSelect();
                    editors.push(sel);
                    readers.push(() => Number(sel.value));
                } else if (hid) {
                    const input = el('input', { type: 'text', placeholder: descs[0]?.name || 'key, e.g. A', size: 10 });
                    editors.push(input);
                    readers.push(() => usageFromName(input.value));
                } else if (range) {
                    // Bounded param from behavior metadata → slider + live value
                    // (GUI controls pass: no bare number boxes for bounded ints).
                    const val = el('span', { class: 'val', text: String(Math.max(0, range.min)) });
                    const input = el('input', {
                        type: 'range', min: range.min, max: range.max, value: Math.max(0, range.min),
                        title: `${range.min}–${range.max}`,
                    });
                    input.addEventListener('input', () => { val.textContent = input.value; });
                    editors.push(input, val);
                    readers.push(() => Number(input.value) | 0);
                } else {
                    const input = el('input', { type: 'number', value: 0, size: 6 });
                    editors.push(input);
                    readers.push(() => Number(input.value) >>> 0);
                }
            }
            paramsBox.replaceChildren(...editors);
            readParams = () => readers.map((r) => r());
        }

        bhvSel.addEventListener('change', buildParamEditors);
        buildParamEditors();
        assign.addEventListener('click', () => {
            const [p1, p2] = readParams();
            if (p1 == null || p2 == null) { toast('Fill in the key name first (e.g. A)', true); return; }
            onPick({ behaviorId: Number(bhvSel.value), param1: (p1 ?? 0) >>> 0, param2: (p2 ?? 0) >>> 0 });
        });
        codes.append(el('div', { class: 'composer' },
            el('label', { text: 'Behavior:' }), bhvSel, paramsBox, assign));
    }

    root.append(cats, search, codes);
    renderCats();
    renderCodes();
    return root;
}
