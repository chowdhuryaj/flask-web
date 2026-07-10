// flask-web boot + app state. Owns the singleton transport and clients,
// runs the post-connect load sequence (handshake → definition → keymap),
// drives capability-gated tabs, themes, and the HUD.

import { el, toast } from './ui.js?v=7';
import { FlaskHID } from './webhid.js?v=7';
import { FlaskProto, EXPECTED_PROTOCOL, CH, V } from './flaskproto.js?v=7';
import { isZmkFamily, zmkProfile, confirmZmkFamily, ZMK_EXPECTED_PROTOCOL,
         zmkReadKeyState } from './zmk.js?v=7';
import { VialClient } from './vialclient.js?v=7';
import { parseDefinition } from './vialdef.js?v=7';
import { buildProfile, familyOf, familyLabel } from './profiles.js?v=7';
import { capabilities } from './caps.js?v=7';
import { setDeviceCustomKeys } from './keycodes.js?v=7';
import { KeymapTab } from './keymap-tab.js?v=7';
import { ZmkKeymapTab } from './zmk-keymap-tab.js?v=7';
import { ZmkRgbTab } from './zmk-rgb-tab.js?v=7';
import { ZmkCombosTab } from './zmk-combos-tab.js?v=7';
import { ZmkMacrosTab } from './zmk-macros-tab.js?v=7';
import { MouseTab } from './mouse-tab.js?v=7';
import { TypingTab } from './typing-tab.js?v=7';
import { SettingsTab } from './settings-tab.js?v=7';
import { HUD } from './hud.js?v=7';
import { runUnlockFlow, lockKeyboard } from './unlock.js?v=7';
import { ZMK_TEMPLATE_FAMILIES, createZmkTemplate, attachZmkOffline,
         zmkSyncExtras, zmkPendingCount, zmkClearDirty } from './zmk-offline.js?v=7';
import { OfflineFlask, OfflineVial, TEMPLATE_FAMILIES, createTemplate, loadWorkspace,
         saveWorkspace, deleteWorkspace, listWorkspaces, pendingCount, clearDirty,
         maybeSyncOffline, captureSnapshot, workspaceKey } from './offline.js?v=7';
import { MacrosTab } from './macros-tab.js?v=7';
import { TapDanceTab, ComboTab, KeyOverrideTab } from './entries-tab.js?v=7';
import { GesturesTab, ChordsTab } from './gestures-tab.js?v=7';
import { RgbTab } from './rgb-tab.js?v=7';
import { DisplayTab } from './display-tab.js?v=7';
import { exportVil, importVil, downloadText } from './vil.js?v=7';

// ---------- themes (AlooMapper pattern; classic = stylesheet auto light/dark) ----------

const THEME_VARS = ['bg', 'surface', 'surface2', 'text', 'muted', 'faint', 'border', 'border2',
    'accent', 'accent-bg', 'accent-text', 'ok', 'ok-bg', 'warn', 'warn-bg', 'danger', 'danger-bg',
    'keycap', 'keycap-border'];
const THEMES = {
    classic: { label: 'Classic (auto light/dark)' },
    light: {
        label: 'Light',
        vars: { bg: '#f5f5f4', surface: '#ffffff', surface2: '#fafaf9', text: '#1c1c1a', muted: '#6b6b66', faint: '#9a9a93', border: '#e2e2dd', border2: '#cfcfc8', accent: '#2563eb', 'accent-bg': '#e8f0fe', 'accent-text': '#14458a', ok: '#15803d', 'ok-bg': '#e7f6ec', danger: '#b42318', 'danger-bg': '#fdeceb', keycap: '#ffffff', 'keycap-border': '#cfcfc8' },
    },
    dark: {
        label: 'Dark',
        vars: { bg: '#1a1a18', surface: '#242422', surface2: '#2c2c29', text: '#ececea', muted: '#a3a39d', faint: '#76766f', border: '#36352f', border2: '#45443d', accent: '#5b9aff', 'accent-bg': '#1c2a44', 'accent-text': '#bcd4ff', ok: '#69d28c', 'ok-bg': '#15301f', danger: '#f1857c', 'danger-bg': '#3a1714', keycap: '#2c2c29', 'keycap-border': '#45443d' },
    },
    nord: {
        label: 'Nord',
        vars: { bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', text: '#eceff4', muted: '#aeb8cc', faint: '#7b869c', border: '#4c566a', border2: '#596580', accent: '#88c0d0', 'accent-bg': '#274552', 'accent-text': '#c8e4ec', ok: '#a3be8c', 'ok-bg': '#33402c', danger: '#bf616a', 'danger-bg': '#40272b', keycap: '#434c5e', 'keycap-border': '#596580' },
    },
    dracula: {
        label: 'Dracula',
        vars: { bg: '#282a36', surface: '#313342', surface2: '#3a3d4f', text: '#f8f8f2', muted: '#b6b8c8', faint: '#7e8195', border: '#44475a', border2: '#565a72', accent: '#bd93f9', 'accent-bg': '#3b3354', 'accent-text': '#e3d3ff', ok: '#50fa7b', 'ok-bg': '#1f4030', danger: '#ff5555', 'danger-bg': '#4a2020', keycap: '#3a3d4f', 'keycap-border': '#565a72' },
    },
    solarized: {
        label: 'Solarized Light',
        vars: { bg: '#fdf6e3', surface: '#fefbf0', surface2: '#f5efdc', text: '#073642', muted: '#657b83', faint: '#93a1a1', border: '#e6dfc8', border2: '#d3cbb0', accent: '#268bd2', 'accent-bg': '#e0eef8', 'accent-text': '#0d5a8f', ok: '#859900', 'ok-bg': '#eef0d8', danger: '#dc322f', 'danger-bg': '#fbe3e2', keycap: '#fefbf0', 'keycap-border': '#d3cbb0' },
    },
};

function applyTheme(name) {
    const theme = THEMES[name] || THEMES.classic;
    const root = document.documentElement;
    for (const v of THEME_VARS) root.style.removeProperty('--' + v);
    if (theme.vars) for (const [k, val] of Object.entries(theme.vars)) root.style.setProperty('--' + k, val);
    localStorage.setItem('flask-theme', name);
}

// ---------- app state ----------

const app = {
    hid: new FlaskHID(),
    flask: null, vial: null,
    family: 'generic',
    protocolVersion: null,
    caps: capabilities('generic', null),
    profile: null,
    layerCount: 0,
    keymap: null,
    unlocked: false,
    hud: null,
    onHudLockClick: null,
    offline: false,
    offlineWs: null,
};
app.flask = new FlaskProto(app.hid);
app.vial = new VialClient(app.hid);
app.hud = new HUD(app);

const $ = (id) => document.getElementById(id);
const TABS = [];

// ---------- connect / load ----------

async function connectFlow(device) {
    if (app.offline) exitOffline(); // restore the real clients first
    try {
        await app.hid.open(device);
    } catch (e) {
        toast(`Open failed: ${e.message}`, true);
        return;
    }
    $('status-text').textContent = 'Loading…';
    try {
        await loadDevice(device);
    } catch (e) {
        console.error(e);
        toast(`Load failed: ${e.message}`, true);
        $('status-text').textContent = 'Load failed';
    }
}

async function loadDevice(device) {
    app.family = familyOf(device.vendorId, device.productId);

    // ZMK line: a different firmware language — no Vial surface at all,
    // Flask protocol only. Everything ZMK-specific lives in zmk.js.
    if (isZmkFamily(app.family)) return loadZmkDevice(device);

    // 1. Vial identity + definition (any Vial keyboard).
    const via = await app.vial.viaProtocolVersion();
    const kbId = await app.vial.vialKeyboardID();
    console.log(`VIA v${via}, Vial v${kbId.version}, uid`, kbId.uid);
    app.viaVersion = via;
    app.vialVersion = kbId.version;
    const definition = await parseDefinition(await app.vial.definition());
    app.layerCount = await app.vial.layerCount();

    // 2. Flask handshake — per-family version line; timeout → plain Vial.
    app.protocolVersion = await app.flask.handshake();
    app.caps = capabilities(app.family, app.protocolVersion);

    // 3. Profile + keycode overlay.
    app.profile = buildProfile(app.family, definition, app.layerCount);
    setDeviceCustomKeys(definition.customKeycodes);

    // 4. Unlock state (for HUD pressed keys + macro editing later).
    try { app.unlocked = (await app.vial.unlockStatus()).unlocked; }
    catch { app.unlocked = false; }
    app.readKeyState = null;    // QMK presses ride the Vial matrix read

    // 5. Offline queue → device (awaited so tabs render post-sync state),
    // then refresh the stored snapshot in the background (FIFO-safe).
    await maybeSyncOffline(app, device);
    captureSnapshot(app, device)
        .then(() => renderOfflineList())
        .catch((e) => console.warn('snapshot failed:', e));

    // UI
    $('landing').style.display = 'none';
    $('main-tabs').style.display = '';
    $('hud-btn').style.display = '';
    $('lock-btn').style.display = '';
    $('vil-save').style.display = '';
    $('vil-load').style.display = '';
    updateStatus(device);
    buildTabs();
    await showTab(TABS[0].id);
}

/** ZMK-line load: Flask handshake only. The keymap lives in git + ZMK
 * Studio, so vil import/export and all Vial tabs stay hidden. */
async function loadZmkDevice(device) {
    app.viaVersion = null;
    app.vialVersion = null;
    app.vial = null;    // no Vial surface — a stale client from a prior QMK
                        // connect must not leak into HUD/unlock paths
    app.keymap = null;  // ZMK keymap tab publishes the real one post-Studio-load

    app.protocolVersion = await app.flask.handshake();
    if (app.protocolVersion == null) {
        throw new Error('ZMK device without the Flask protocol — is raw_hid_adapter + CONFIG_ZMK_FLASK_PROTO in the firmware?');
    }

    // The stock ZMK VID/PID is shared by every ZMK board — confirm the
    // family from meta 0x03 (pre-family firmware keeps the VID/PID guess).
    app.family = await confirmZmkFamily(app.flask, app.family);

    app.caps = capabilities(app.family, app.protocolVersion);
    app.profile = zmkProfile(app.family);
    app.layerCount = app.profile.layerNames.length;
    app.unlocked = false;
    // HUD press highlight rides the key-state bitmap instead of the Vial
    // matrix read (hud.js polls this generically when caps.keyState).
    app.readKeyState = app.caps.keyState ? () => zmkReadKeyState(app.flask) : null;

    // Offline preview queue → device (tunables + RGB ride the shared
    // journal; combo slots + macro steps are ZMK-shaped extras).
    await maybeSyncOffline(app, device);
    const ws = loadWorkspace(workspaceKey(app.family, device));
    app.zmkQueuedWs = null;   // never let a prior connect's queue leak across
    if (ws && zmkPendingCount(ws)) {
        const { applied, failures } = await zmkSyncExtras(app, ws);
        if (failures.length) {
            console.warn('zmk offline sync failures:', failures);
            toast(`Applied ${applied} offline slot edits — ${failures.length} failed, still queued`, true);
        } else if (applied) {
            toast(`Applied ${applied} offline combo/macro slot edits`);
        }
    }

    $('landing').style.display = 'none';
    $('main-tabs').style.display = '';
    $('hud-btn').style.display = '';
    updateStatus(device);
    buildTabs();
    // Pre-autoscroll (v<2) firmware can yield a single empty Mouse tab but
    // never zero tabs; guard anyway — TABS[0] on [] is a connect crash.
    if (TABS.length) await showTab(TABS[0].id);
}

function updateStatus(device) {
    const pill = $('status-pill');
    pill.classList.remove('offline');
    pill.classList.add('connected');
    const fam = familyLabel(app.family);
    const proto = app.protocolVersion != null ? ` · Flask v${app.protocolVersion}` : ' · plain Vial';
    $('status-text').textContent = `${app.profile?.name ?? device.productName}${proto}`;
    pill.title = `${fam} — ${device.vendorId.toString(16)}:${device.productId.toString(16)}`;

    const warn = $('proto-warn');
    const expected = isZmkFamily(app.family)
        ? ZMK_EXPECTED_PROTOCOL[app.family] : EXPECTED_PROTOCOL[app.family];
    if (app.protocolVersion != null && expected && app.protocolVersion !== expected) {
        warn.style.display = '';
        warn.textContent = `firmware protocol v${app.protocolVersion}, app expects v${expected}`;
    } else {
        warn.style.display = 'none';
    }
    updateLockButton();
}

function updateLockButton() {
    $('lock-btn').textContent = app.unlocked ? '🔓 Unlocked' : '🔒 Locked';
}

function disconnectUI() {
    app.hud.close();
    app.protocolVersion = null;
    app.profile = null;
    $('status-pill').classList.remove('connected');
    $('status-text').textContent = 'Not connected';
    $('proto-warn').style.display = 'none';
    $('main-tabs').style.display = 'none';
    $('hud-btn').style.display = 'none';
    $('lock-btn').style.display = 'none';
    $('vil-save').style.display = 'none';
    $('vil-load').style.display = 'none';
    $('panels').replaceChildren();
    $('landing').style.display = '';
    refreshDeviceList();
    renderOfflineList();
}

// ---------- offline mode ----------

function startOffline(key, family) {
    const zmk = isZmkFamily(family);
    const ws = loadWorkspace(key) ?? (zmk ? createZmkTemplate(family) : createTemplate(family));
    ws._notify = updateOfflineBanner; // dropped by JSON.stringify on persist
    saveWorkspace(ws);
    app.offline = true;
    app.offlineWs = ws;
    if (zmk) {
        attachZmkOffline(app, ws);      // flask sim + Studio sim + caps/profile
    } else {
        app.flask = new OfflineFlask(ws);
        app.vial = new OfflineVial(ws);
        app.family = ws.family;
        app.protocolVersion = ws.protocolVersion;
        app.caps = capabilities(ws.family, ws.protocolVersion);
        app.profile = ws.profile;
        app.layerCount = ws.layerCount;
        app.keymap = null;
        app.unlocked = false;
    }
    setDeviceCustomKeys(ws.profile.customKeycodes || []);

    $('landing').style.display = 'none';
    $('main-tabs').style.display = '';
    $('hud-btn').style.display = 'none';   // HUD is live device state
    $('lock-btn').style.display = 'none';
    $('vil-save').style.display = zmk ? 'none' : '';   // .vil is a Vial format
    $('vil-load').style.display = zmk ? 'none' : '';
    $('proto-warn').style.display = 'none';
    $('status-pill').classList.add('offline');
    $('status-text').textContent = `Offline — ${ws.label}`;
    $('offline-banner').style.display = 'flex';
    updateOfflineBanner();
    buildTabs();
    showTab(zmk ? 'zmk-keymap' : 'keymap');
}

function updateOfflineBanner() {
    if (!app.offline || !app.offlineWs) return;
    const n = pendingCount(app.offlineWs) + zmkPendingCount(app.offlineWs);
    $('offline-msg').textContent = n
        ? `Offline — ${n} change${n === 1 ? '' : 's'} queued for ${app.offlineWs.label}; they apply on the next connect.`
        : `Offline — edits queue here and apply when ${app.offlineWs.label} is next connected.`;
}

function exitOffline() {
    if (app.offlineWs) delete app.offlineWs._notify;
    app.offline = false;
    app.offlineWs = null;
    app.flask = new FlaskProto(app.hid);
    app.vial = new VialClient(app.hid);
    app.zmkStudioSim = null;    // keymap tab falls back to the real serial client
    app.readKeyState = null;
    $('offline-banner').style.display = 'none';
    $('status-pill').classList.remove('offline');
    disconnectUI();
}

function renderOfflineList() {
    const list = $('offline-list');
    if (!list) return;
    const saved = new Map(listWorkspaces().map((w) => [w.key, w]));
    const entries = [];
    for (const fam of TEMPLATE_FAMILIES) {
        if (!saved.has(fam)) entries.push({ key: fam, family: fam, label: familyLabel(fam), pending: 0, saved: false });
    }
    for (const fam of ZMK_TEMPLATE_FAMILIES) {
        if (!saved.has(fam)) entries.push({ key: fam, family: fam, label: familyLabel(fam), pending: 0, saved: false });
    }
    for (const ws of saved.values()) {
        entries.push({
            key: ws.key, family: ws.family, label: ws.label,
            pending: pendingCount(ws) + zmkPendingCount(ws), saved: true,
            fromDevice: ws.source === 'device',
        });
    }
    list.replaceChildren(...entries.map((e) => el('button', {
        class: 'dev-item', onclick: () => startOffline(e.key, e.family),
        title: e.fromDevice ? 'Workspace from the last real connect' : 'Blank template — geometry only',
    },
        `✈️ ${e.label}`,
        e.pending ? el('span', { class: 'badge', text: `${e.pending} queued` }) : null,
        el('span', { class: 'badge faint', text: e.fromDevice ? 'snapshot' : 'template' }),
        e.saved ? el('span', {
            class: 'badge', text: '✕', title: 'Delete this offline workspace',
            onclick: (ev) => {
                ev.stopPropagation();
                if (confirm(`Delete the offline workspace for ${e.label}? Queued changes are lost.`)) {
                    deleteWorkspace(e.key);
                    renderOfflineList();
                }
            },
        }) : null)));
}

// ---------- tabs ----------

function buildTabs() {
    TABS.length = 0;
    if (app.caps.zmkStudio) TABS.push({ id: 'zmk-keymap', label: 'Keymap', ctor: ZmkKeymapTab });
    if (app.caps.vial) {
        TABS.push({ id: 'keymap', label: 'Keymap', ctor: KeymapTab });
        TABS.push({ id: 'macros', label: 'Macros', ctor: MacrosTab });
        TABS.push({ id: 'tapdance', label: 'Tap Dance', ctor: TapDanceTab });
        TABS.push({ id: 'combos', label: 'Combos', ctor: ComboTab });
        TABS.push({ id: 'overrides', label: 'Key Overrides', ctor: KeyOverrideTab });
    }
    if (app.caps.gestures) TABS.push({ id: 'gestures', label: 'Gestures', ctor: GesturesTab });
    if (app.caps.wheelChords) TABS.push({ id: 'chords', label: 'Mouse Chords', ctor: ChordsTab });
    if (app.caps.mouse) TABS.push({ id: 'mouse', label: 'Mouse', ctor: MouseTab });
    if (app.caps.typing) TABS.push({ id: 'typing', label: 'Typing', ctor: TypingTab });
    if (app.caps.rgbMap) {
        TABS.push({ id: 'rgb', label: 'RGB',
            ctor: isZmkFamily(app.family) ? ZmkRgbTab : RgbTab });
    }
    // ZMK-line only: caps.combos/caps.macros come from zmkCapabilities
    // (v7+/v8+). QMK combos and macros are Vial dynamic entries and ride
    // caps.vial above.
    if (app.caps.combos) TABS.push({ id: 'zmk-combos', label: 'Combos', ctor: ZmkCombosTab });
    if (app.caps.macros) TABS.push({ id: 'zmk-macros', label: 'Macros', ctor: ZmkMacrosTab });
    if (app.caps.display) TABS.push({ id: 'display', label: 'Display', ctor: DisplayTab });
    if (app.caps.vial) TABS.push({ id: 'settings', label: 'QMK Settings', ctor: SettingsTab });

    const nav = $('main-tabs');
    nav.replaceChildren(...TABS.map((t) =>
        el('button', { text: t.label, 'data-tab': t.id, onclick: () => showTab(t.id) })));

    const panels = $('panels');
    panels.replaceChildren(...TABS.map((t) => {
        t.instance = new t.ctor(app);
        t.panel = el('div', { class: 'panel', 'data-panel': t.id }, t.instance.root);
        return t.panel;
    }));
}

async function showTab(id) {
    for (const t of TABS) {
        t.panel.classList.toggle('active', t.id === id);
    }
    for (const b of $('main-tabs').children) {
        b.classList.toggle('active', b.dataset.tab === id);
    }
    const tab = TABS.find((t) => t.id === id);
    if (tab && !tab.loaded) {
        tab.loaded = true;
        try { await tab.instance.load(); }
        catch (e) {
            console.error(e);
            tab.panel.append(el('p', { class: 'muted', text: `Load failed: ${e.message}` }));
            tab.loaded = false;
        }
    }
}

// ---------- device list (landing) ----------

async function refreshDeviceList() {
    const list = $('dev-list');
    const granted = await FlaskHID.grantedDevices();
    list.replaceChildren(...granted.map((d) => {
        const family = familyOf(d.vendorId, d.productId);
        return el('button', { class: 'dev-item', onclick: () => connectFlow(d) },
            d.productName || 'Vial keyboard',
            family !== 'generic' ? el('span', { class: 'badge', text: 'Flask' }) : null);
    }));
}

// ---------- wiring ----------

async function connectClick() {
    if (!FlaskHID.supported()) return;
    try {
        const device = await app.hid.requestDevice();
        await connectFlow(device);
    } catch (e) {
        if (e.kind !== 'cancelled') toast(e.message, true);
    }
}

function init() {
    // No WebHID (Firefox/Safari): connecting is off, but offline editing
    // still works — the queue applies later from a Chromium browser.
    if (!FlaskHID.supported()) {
        $('unsupported').style.display = '';
        $('connect-btn').disabled = true;
        $('landing-connect').disabled = true;
    }

    // Single-tab guard: two tabs would interleave responses (same failure
    // mode as running the Vial GUI alongside).
    navigator.locks?.request('flask-web-hid', { ifAvailable: true }, (lock) => {
        if (!lock) {
            toast('Flask is already open in another tab — close it first.', true);
            $('connect-btn').disabled = true;
            $('landing-connect').disabled = true;
            return;
        }
        return new Promise(() => {}); // hold the lock for the page lifetime
    });

    $('connect-btn').addEventListener('click', connectClick);
    $('landing-connect').addEventListener('click', connectClick);
    $('hud-btn').addEventListener('click', () => app.hud.toggle());
    $('vil-save').addEventListener('click', async () => {
        try {
            toast('Reading layout…');
            const text = await exportVil(app);
            const name = (app.profile?.name ?? 'layout').replace(/[^\w-]+/g, '_');
            downloadText(`${name}.vil`, text);
            toast('.vil saved');
        } catch (e) { toast(`Export failed: ${e.message}`, true); }
    });
    $('vil-load').addEventListener('click', () => $('vil-file').click());
    $('vil-file').addEventListener('change', async () => {
        const file = $('vil-file').files[0];
        $('vil-file').value = '';
        if (!file) return;
        try {
            toast('Applying layout…');
            const stats = await importVil(app, await file.text());
            let msg = `Applied ${stats.applied} items`;
            if (stats.skipped) msg += `, ${stats.skipped} named keycodes skipped`;
            if (stats.notes.length) msg += ` — ${stats.notes.join('; ')}`;
            toast(msg, stats.notes.length > 0);
            buildTabs();          // tabs re-read post-import state
            await showTab('keymap');
        } catch (e) { toast(`Import failed: ${e.message}`, true); }
    });
    $('offline-exit').addEventListener('click', exitOffline);
    $('offline-discard').addEventListener('click', () => {
        const ws = app.offlineWs;
        if (!ws || !(pendingCount(ws) + zmkPendingCount(ws))) { toast('Nothing queued'); return; }
        clearDirty(ws);
        zmkClearDirty(ws);
        toast('Queued changes discarded');
    });

    app.onHudLockClick = () => $('lock-btn').click();
    $('lock-btn').addEventListener('click', async () => {
        if (app.unlocked) {
            await lockKeyboard(app, () => { app.unlocked = false; updateLockButton(); app.hud.render(); });
        } else {
            await runUnlockFlow(app, () => { app.unlocked = true; updateLockButton(); app.hud.render(); });
        }
    });

    app.hid.addEventListener('disconnect', () => {
        toast('Keyboard disconnected', true);
        disconnectUI();
    });
    app.hid.addEventListener('deviceavailable', async (e) => {
        // Replug of a previously-granted device: silent reconnect if it's
        // the one we were using (or nothing is connected). While editing
        // offline, a plug-in of the SAME family also connects — that's the
        // moment the queued changes apply.
        if (app.hid.connected) return;
        const last = localStorage.getItem('flask-last-device');
        const key = `${e.detail.vendorId.toString(16).padStart(4, '0')}:${e.detail.productId.toString(16).padStart(4, '0')}`;
        const offlineMatch = app.offline
            && familyOf(e.detail.vendorId, e.detail.productId) === app.offlineWs?.family;
        if (last === key || offlineMatch) {
            toast('Reconnecting…');
            await connectFlow(e.detail);
        }
    });

    // Theme + zoom.
    const themeSel = $('theme-sel');
    themeSel.replaceChildren(...Object.entries(THEMES).map(([id, t]) =>
        el('option', { value: id, text: t.label })));
    const savedTheme = localStorage.getItem('flask-theme') || 'classic';
    themeSel.value = savedTheme;
    applyTheme(savedTheme);
    themeSel.addEventListener('change', () => applyTheme(themeSel.value));

    const zoomSel = $('zoom-sel');
    const savedZoom = localStorage.getItem('flask-zoom') || '100';
    zoomSel.value = savedZoom;
    document.body.style.zoom = Number(savedZoom) / 100;
    zoomSel.addEventListener('change', () => {
        document.body.style.zoom = Number(zoomSel.value) / 100;
        localStorage.setItem('flask-zoom', zoomSel.value);
    });

    // Silent reconnect to the remembered device on page load.
    renderOfflineList();
    (async () => {
        await refreshDeviceList();
        const last = localStorage.getItem('flask-last-device');
        if (!last) return;
        const granted = await FlaskHID.grantedDevices();
        const match = granted.find((d) =>
            `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}` === last);
        if (match) await connectFlow(match);
    })();
}

init();
