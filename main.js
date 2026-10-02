// flask-web boot + app state. Owns the singleton transport and clients,
// runs the post-connect load sequence (handshake → definition → keymap),
// drives capability-gated tabs, themes, and the HUD.

import { el, toast, modal } from './ui.js?v=60';
import { diag } from './diag.js?v=60';
import { FlaskHID } from './webhid.js?v=60';
import { renderPreflight } from './preflight.js?v=60';
import { FlaskProto, EXPECTED_PROTOCOL, CH, V } from './flaskproto.js?v=60';
import { isZmkFamily, zmkProfile, confirmZmkFamily, ZMK_FAMILY_UNRESOLVED_MSG, ZMK_EXPECTED_PROTOCOL,
         zmkReadKeyState, zmkReportResetCause } from './zmk.js?v=60';
import { VialClient } from './vialclient.js?v=60';
import { parseDefinition } from './vialdef.js?v=60';
import { buildProfile, familyOf, familyLabel } from './profiles.js?v=60';
import { loadNapeDevice, isNapeFamily } from './nape.js?v=60';
import { capabilities } from './caps.js?v=60';
import { setDeviceCustomKeys, setDeviceMacroCount } from './keycodes.js?v=60';
import { CommandPalette } from './command-palette.js?v=60';
import { HUD } from './hud.js?v=60';
import { runUnlockFlow, lockKeyboard } from './unlock.js?v=60';
import { ZMK_TEMPLATE_FAMILIES, createZmkTemplate, attachZmkOffline,
         zmkSyncExtras, zmkPendingCount, zmkClearDirty } from './zmk-offline.js?v=60';
import { OfflineFlask, OfflineVial, TEMPLATE_FAMILIES, createTemplate, loadWorkspace,
         saveWorkspace, deleteWorkspace, listWorkspaces, pendingCount, clearDirty,
         maybeSyncOffline, captureSnapshot, workspaceKey } from './offline.js?v=60';
import * as vil from './vil.js?v=60';
import * as zmkOffline from './zmk-offline.js?v=60';
const { exportVil, importVil, downloadText } = vil;
// WP6 (not yet on this branch) adds vil.saveLayoutFile / loadLayoutFile, the
// per-line Save layout / Load dispatch. Namespace access is undefined until
// then, so each use below falls back to the .vil path.
const HAS_LAYOUT_DISPATCH = typeof vil.saveLayoutFile === 'function';
import { TAB_GROUPS, tabsFor, groupOf } from './tab-registry.js?v=60';
import { shell } from './app-shell.js?v=60';
import { installCaptions, setCaptionGroup } from './caption.js?v=60';
import { saveState } from './save-state.js?v=60';
import { board } from './board.js?v=60';
import { attachHoldtap } from './behavior-catalog.js?v=60';
import { initAppearance, appearance, applyBoardZoom, currentBoardZoom, BOARD_ZOOM } from './themes.js?v=60';

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
    // Standalone typing trainer: opened from the landing page with no keyboard
    // attached. Suppresses every device tab (see buildTabs).
    trainerOnly: false,
    /// Which tab group's row is showing (see TAB_GROUPS).
    tabGroup: 'keys',
};
app.flask = new FlaskProto(app.hid);
app.vial = new VialClient(app.hid);
app.hud = new HUD(app);
// Redesign contracts (WP0): reachable from every tab via `app`.
app.shell = shell;
app.saveState = saveState;
app.showTab = (id) => showTab(id);   // Typing's links to Behaviour › Leader / Shift Keys
// ⌘K. Installed at module scope, not per-device: navigating is exactly what
// you want when nothing is connected yet.
app.palette = new CommandPalette(app, {
    tabs: () => TABS,
    showTab: (id) => showTab(id),
    groupLabel: (id) => TAB_GROUPS.find((g) => g.id === groupOf(id))?.label ?? '',
    unlock: () => app.onHudLockClick?.(),
    diagnostics: () => app.openDiagnostics?.(),
});

const $ = (id) => document.getElementById(id);
const TABS = [];

/** landing | device | offline | trainer. One switch for what is on screen. */
function setMode(mode) {
    const inApp = mode !== 'landing';
    $('landing-main').style.display = inApp ? 'none' : '';
    $('app-frame').style.display = inApp ? '' : 'none';
    $('app-frame').dataset.mode = mode;
    document.body.classList.toggle('in-app', inApp);
    syncHudBtn();
    syncRail();
}

const IS_DESKTOP = navigator.userAgent.includes('Electron');
// Set by the ⇄ device button so the reconnect poll does not undo the switch.
let manualSwitch = false;

// ---------- connect / load ----------

let connecting = false; // re-entrancy guard: events + the reconnect poll race

async function connectFlow(device) {
    if (connecting) return;
    connecting = true;
    manualSwitch = false;
    try {
        if (app.offline) exitOffline(); // restore the real clients first
        // Leaving the standalone trainer: without this, buildTabs takes its
        // trainer-only early return and a fully connected keyboard comes up
        // with the Trainer tab and nothing else.
        app.trainerOnly = false;
        try {
            await app.hid.open(device);
        } catch (e) {
            toast(`Open failed: ${e.message}`, true);
            return;
        }
        $('status-text').textContent = 'Loading…';
        $('device-name').textContent = device.productName || 'Keyboard';
        try {
            await loadDevice(device);
        } catch (e) {
            console.error(e);
            toast(`Load failed: ${e.message}`, true);
            $('status-text').textContent = 'Load failed';
        }
    } finally {
        connecting = false;
    }
}

/** Reconnect target: the remembered device, or (while editing offline) any
 * device of the workspace's family — shared by the hotplug event and the
 * poll below. */
function reconnectCandidate(devices) {
    const last = localStorage.getItem('flask-last-device');
    return devices.find((d) => {
        const key = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
        const offlineMatch = app.offline
            && familyOf(d.vendorId, d.productId) === app.offlineWs?.family;
        return last === key || offlineMatch;
    });
}

async function loadDevice(device) {
    app.family = familyOf(device.vendorId, device.productId);
    // flaskproto save() refuses 0x28 unless the line is ZMK (corner wedge).
    if (app.flask instanceof FlaskProto) app.flask.line = isZmkFamily(app.family) ? 'zmk' : 'qmk';

    // ZMK line: a different firmware language — no Vial surface at all,
    // Flask protocol only. Everything ZMK-specific lives in zmk.js.
    if (isZmkFamily(app.family)) return loadZmkDevice(device);

    // Keychron Nape Pro: ZMK firmware speaking VIA. No Vial definition to
    // fetch and no Flask channel — everything lives in nape.js.
    if (isNapeFamily(app.family)) {
        await loadNapeDevice(app, device);
        setMode('device');
        $('vil-save').style.display = $('vil-load').style.display = HAS_LAYOUT_DISPATCH ? '' : 'none';
        updateStatus(device);
        buildTabs();
        if (TABS.length) await showTab(TABS[0].id);
        return;
    }

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
    // Macro keycodes are only offerable once we know how many slots the board
    // actually has — QK_MACRO is 128 wide and boards serve a fraction of it.
    try { app.tapDanceCount = (await app.vial.dynamicEntryCounts()).tapDance; }
    catch { app.tapDanceCount = 0; }   // WP3 picker: TD slot range
    try { setDeviceMacroCount(await app.vial.macroCount()); }
    catch { setDeviceMacroCount(0); }

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
    setMode('device');
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
    const confirmed = await confirmZmkFamily(app.flask, app.family);
    app.familyUnresolved = confirmed == null;   // keymap import / Mode apply / Studio writes stay blocked
    if (app.familyUnresolved) toast(ZMK_FAMILY_UNRESOLVED_MSG, true);
    else app.family = confirmed;

    app.caps = capabilities(app.family, app.protocolVersion);
    app.profile = zmkProfile(app.family);
    app.layerCount = app.profile.layerNames.length;
    app.unlocked = false;
    // HUD press highlight rides the key-state bitmap instead of the Vial
    // matrix read (hud.js polls this generically when caps.keyState).
    app.readKeyState = app.caps.keyState ? () => zmkReadKeyState(app.flask) : null;
    // Crash forensics: log the boot reset cause; toast on fault bits.
    zmkReportResetCause(app.flask, toast);

    // Offline preview queue → device (tunables + RGB ride the shared
    // journal; combo slots + macro steps are ZMK-shaped extras).
    await maybeSyncOffline(app, device);
    const ws = loadWorkspace(workspaceKey(app.family, device));
    app.zmkQueuedWs = null;   // never let a prior connect's queue leak across
    if (ws && zmkPendingCount(ws) && !app.familyUnresolved) {
        const { applied, failures } = await zmkSyncExtras(app, ws);
        if (failures.length) {
            console.warn('zmk offline sync failures:', failures);
            toast(`Applied ${applied} offline slot edits — ${failures.length} failed, still queued`, true);
        } else if (applied) {
            toast(`Applied ${applied} offline combo/macro slot edits`);
        }
    }

    // Save layout / Load on ZMK need WP6's dispatch (keymap JSON, spec §3.10).
    setMode('device');
    $('vil-save').style.display = $('vil-load').style.display = HAS_LAYOUT_DISPATCH ? '' : 'none';
    updateStatus(device);
    await probeHoldtap();
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
    $('device-name').textContent = app.profile?.name ?? device.productName ?? 'Keyboard';
    $('status-text').textContent = 'Connected';
    saveState.setLine?.(isZmkFamily(app.family) ? 'zmk' : app.caps?.nape ? 'nape' : 'qmk');   // WP6
    pill.title = `${fam}${proto} — ${device.vendorId.toString(16)}:${device.productId.toString(16)}`;

    const warn = $('proto-warn');
    const expected = isZmkFamily(app.family)
        ? ZMK_EXPECTED_PROTOCOL[app.family] : EXPECTED_PROTOCOL[app.family];
    if (app.protocolVersion != null && expected && app.protocolVersion !== expected) {
        warn.style.display = '';
        warn.textContent = `protocol v${app.protocolVersion} ≠ app v${expected} — reflash`;
    } else {
        warn.style.display = 'none';
    }
    updateLockButton();
}

function updateLockButton() {
    const b = $('lock-btn');
    b.textContent = app.unlocked ? 'Unlocked' : 'Locked';
    b.classList.toggle('warn', app.unlocked);
}

function disconnectUI() {
    app.hud.close();
    app.protocolVersion = null;
    app.profile = null;
    app.trainerOnly = false;
    saveState.reset?.();    // WP6: drop dirty sources and the line
    $('status-pill').classList.remove('connected', 'offline');
    $('status-text').textContent = 'Disconnected';
    $('device-name').textContent = 'Flask';
    $('proto-warn').style.display = 'none';
    $('lock-btn').style.display = 'none';
    $('vil-save').style.display = 'none';
    $('vil-load').style.display = 'none';
    $('offline-seg').style.display = 'none';
    $('panels').replaceChildren();
    $('main-tabs').replaceChildren();
    setMode('landing');
    refreshDeviceList();
    renderOfflineList();
}

// ---------- offline mode ----------

async function startOffline(key, family) {
    app.trainerOnly = false;    // same trap as connectFlow's
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
    setDeviceMacroCount(ws.macros?.count ?? 0);
    app.tapDanceCount = zmk ? undefined : ws.entries?.counts?.tapDance;

    setMode('offline');   // no HUD: it is live device state
    $('lock-btn').style.display = 'none';
    $('vil-save').style.display = $('vil-load').style.display = zmk && !HAS_LAYOUT_DISPATCH ? 'none' : '';
    saveState.setLine?.(zmk ? 'zmk' : 'qmk');
    $('proto-warn').style.display = 'none';
    $('status-pill').classList.remove('connected');
    $('status-pill').classList.add('offline');
    $('status-text').textContent = `Offline — ${ws.label}`;
    $('device-name').textContent = ws.label;
    $('offline-seg').style.display = '';
    updateOfflineBanner();
    await probeHoldtap();
    buildTabs();
    showTab(zmk ? 'zmk-keymap' : 'keymap');
}

function updateOfflineBanner() {
    if (!app.offline || !app.offlineWs) return;
    const n = zmkOffline.offlineQueued?.(app.offlineWs) ?? pendingCount(app.offlineWs) + zmkPendingCount(app.offlineWs);
    $('offline-msg').textContent = n
        ? `${n} queued for ${app.offlineWs.label}`
        : 'Edits queue until the next connect';
}

function exitOffline() {
    if (app.offlineWs) delete app.offlineWs._notify;
    app.offline = false;
    app.offlineWs = null;
    app.flask = new FlaskProto(app.hid);
    app.vial = new VialClient(app.hid);
    app.zmkStudioSim = null;    // keymap tab falls back to the real serial client
    app.readKeyState = null;
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

const GROUP_CAPTION = {
    keys: 'Keys: keycodes you paste onto the selected key.',
    behaviour: 'Behaviour: what a key or chord does (macros, tap dance, combos).',
    device: 'Device: tune and administer this keyboard.',
    trainer: 'Trainer: practise typing.',
};

/** caps.holdtap for the Behaviour › Hold timing row: ZMK proto >= 17 and
 * channel 0x2A answers GET SLOT_COUNT (attachHoldtap, memoized per client). */
async function probeHoldtap() {
    if (!app.caps || !isZmkFamily(app.family)) return;
    try { app.caps.holdtap = !!(await attachHoldtap(app)); }
    catch { app.caps.holdtap = false; }
}

function buildTabs() {
    TABS.length = 0;
    TABS.push(...tabsFor(app));
    renderTabStrip();
}

/**
 * The nav only. Deliberately separate from renderTabStrip: that one
 * re-instantiates every panel, and a group click must not throw away the
 * state of every open tab to change which row of buttons is showing.
 */
function renderTabNav() {
    const nav = $('main-tabs');
    // Groups present on THIS device — an empty chip would be a dead end.
    const present = new Set(TABS.map((t) => groupOf(t.id)));
    const groups = TAB_GROUPS.filter((g) => present.has(g.id));
    if (!groups.some((g) => g.id === app.tabGroup)) {
        app.tabGroup = groups[0]?.id ?? 'keys';
    }
    const inGroup = TABS.filter((t) => groupOf(t.id) === app.tabGroup);

    const groupRow = el('div', { class: 'tab-groups' },
        ...groups.map((g) => el('button', {
            class: g.id === app.tabGroup ? 'active' : '',
            text: g.label,
            'data-caption': GROUP_CAPTION[g.id],
            onclick: () => {
                const first = TABS.find((t) => groupOf(t.id) === g.id);
                if (first) showTab(first.id);
            },
        })));
    // A group of one is its own tab — a single-item strip under a chip that
    // already says the same word is pure noise.
    const tabRow = inGroup.length > 1
        ? el('div', { class: 'tab-row' }, ...inGroup.map((t) =>
            el('button', { text: t.label, 'data-tab': t.id, onclick: () => showTab(t.id) })))
        : null;
    nav.replaceChildren(...[groupRow, tabRow].filter(Boolean));
}

/** Nav + one panel per tab, instantiated but not yet loaded. */
function renderTabStrip() {
    renderTabNav();
    const panels = $('panels');
    // Every panel is about to be replaced: an overlay a dead tab painted
    // (corner chord boxes, bar note) must not outlive it.
    board.setChordBoxes(null);
    board.setLayerBarNote(null);
    panels.replaceChildren(...TABS.map((t) => {
        t.instance = new t.ctor(app);
        t.panel = el('div', { class: 'panel', 'data-panel': t.id }, t.instance.root);
        return t.panel;
    }));
}

/** Landing → trainer, with no keyboard involved. */
async function startTrainer() {
    app.trainerOnly = true;
    // The landing is hidden and there is no offline banner here, so without a
    // way out the trainer is a dead end that only a page reload escapes.
    app.exitTrainer = () => { app.trainerOnly = false; disconnectUI(); };
    app.family = 'generic';
    app.caps = capabilities('generic', null);
    app.profile = null;
    app.keymap = null;
    setMode('trainer');
    $('status-pill').classList.remove('connected', 'offline');
    $('status-text').textContent = 'Typing trainer';
    $('device-name').textContent = 'Typing trainer';
    buildTabs();
    await showTab('trainer');
}

async function showTab(id) {
    // The chip row follows the tab, never the other way round: a tab opened
    // from anywhere else (startTrainer, a group click) must not leave its own
    // group chip unlit.
    app.tabGroup = groupOf(id);
    setCaptionGroup(app.tabGroup);
    renderTabNav();
    $('palette-body').scrollTop = 0;
    for (const t of TABS) {
        t.panel.classList.toggle('active', t.id === id);
    }
    for (const b of $('main-tabs').querySelectorAll('button[data-tab]')) {
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
        const hex = (n) => n.toString(16).padStart(4, '0');
        return el('button', { class: 'dev-item', onclick: () => connectFlow(d) },
            d.productName || 'Vial keyboard',
            el('span', { class: 'vidpid mono', text: `${hex(d.vendorId)}:${hex(d.productId)}` }),
            el('span', { class: 'badge', text: family !== 'generic' ? 'full tuning' : 'Vial editor' }));
    }));
}

// ---------- wiring ----------

async function connectClick() {
    if (!FlaskHID.supported()) return;
    const t0 = performance.now();
    try {
        const device = await app.hid.requestDevice();
        await connectFlow(device);
    } catch (e) {
        const ms = Math.round(performance.now() - t0);
        // A policy block and a user cancel BOTH surface as an empty device
        // list. The tell is the clock: nobody dismisses a chooser in 400ms,
        // so an instant "cancel" means the chooser never opened. Same for a
        // SecurityError/NotAllowedError off a real click. Send those to the
        // preflight instead of swallowing them as a cancel.
        const refused = e.name === 'SecurityError' || e.name === 'NotAllowedError';
        if (refused || (e.kind === 'cancelled' && ms < 400)) {
            diag.log('connect-refused', `${e.name ?? e.kind} after ${ms}ms — chooser likely never opened`);
            toast('The device chooser never opened — WebHID may be blocked here. '
                + 'Run the compatibility check on the landing page.', true);
            return;
        }
        if (e.kind !== 'cancelled') toast(e.message, true);
    }
}

function syncHudBtn() {
    const b = $('hud-btn');
    const live = $('app-frame').dataset.mode === 'device';
    b.style.display = live ? '' : 'none';
    b.textContent = app.hud.open ? 'Floating' : 'Pop out';
    b.classList.toggle('on', !!app.hud.open);
}

function syncRail() {
    const has = (f) => typeof board[f] === 'function';
    $('undo-btn').disabled = !has('undo') || board.canUndo === false;
    $('redo-btn').disabled = !has('redo') || board.canRedo === false;
}

function init() {
    installCaptions();
    // The preflight panel: the only thing that separates "no WebHID" from
    // "WebHID blocked by policy" from "device not found". Reachable always,
    // because a policy block leaves navigator.hid in place and Connect just
    // silently does nothing.
    let preflightShown = false;
    const showPreflight = () => {
        const host = $('preflight');
        host.style.display = '';
        if (!preflightShown) { preflightShown = true; renderPreflight(host); }
        host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    $('preflight-btn').addEventListener('click', showPreflight);
    $('trainer-btn').addEventListener('click', startTrainer);
    $('unsupported-why').addEventListener('click', showPreflight);

    // No WebHID (Firefox/Safari, or a non-HTTPS origin): connecting is off,
    // but offline editing still works — the queue applies later from a
    // Chromium browser.
    if (!FlaskHID.supported()) {
        if (!window.isSecureContext) {
            $('unsupported-msg').textContent =
                'This page is not on HTTPS, so the browser hides WebHID entirely. '
                + 'Load the https:// address — this looks identical to an unsupported browser.';
        }
        $('unsupported').style.display = '';
        $('landing-connect').disabled = true;
    }

    // Single-tab guard: two tabs would interleave responses (same failure
    // mode as running the Vial GUI alongside).
    navigator.locks?.request('flask-web-hid', { ifAvailable: true }, (lock) => {
        if (!lock) {
            toast('Flask is already open in another tab — close it first.', true);
            $('landing-connect').disabled = true;
            return;
        }
        return new Promise(() => {}); // hold the lock for the page lifetime
    });

    $('landing-connect').addEventListener('click', connectClick);
    $('hud-btn').addEventListener('click', async () => { await app.hud.toggle(); syncHudBtn(); });
    setInterval(syncHudBtn, 1000);   // the HUD can close itself (its own ✕, pagehide)
    // Black-box diagnostics: live transport/Studio event log + export —
    // the no-reflash crash-capture path (bench 5 ask). The ring runs
    // unconditionally from page load; this is just the window onto it.
    app.diag = diag;
    app.openDiagnostics = () => {
        const pre = el('pre', {
            style: 'max-height:55vh; overflow:auto; font-size:11px; white-space:pre-wrap;'
                + ' user-select:text; margin:0',
            text: diag.report(),
        });
        const refresh = () => { pre.textContent = diag.report(); pre.scrollTop = pre.scrollHeight; };
        diag.addEventListener('log', refresh);
        const prev = diag.previousSnapshot();
        const back = modal('Diagnostics', el('div', {},
            el('div', { class: 'note faint',
                text: 'Everything the app observed: HID frames, timeouts, write failures,'
                    + ' reconnects, Studio assignments, boot reset-cause. Key-state polls are'
                    + ' counted, not listed. If the board dies, the moment + last exchange are'
                    + ' in here — snapshot auto-saves on death.' }),
            pre), [
            el('button', {
                class: 'btn primary', text: 'Copy report',
                onclick: () => navigator.clipboard.writeText(diag.report())
                    .then(() => toast('Diagnostics copied'), () => toast('Copy failed', true)),
            }),
            el('button', {
                class: 'btn', text: 'Download',
                onclick: () => downloadText(
                    `flask-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
                    diag.report()),
            }),
            ...(prev ? [el('button', {
                class: 'btn', text: 'Copy previous snapshot',
                title: 'The report auto-saved the last time the device went unresponsive',
                onclick: () => navigator.clipboard.writeText(prev)
                    .then(() => toast('Previous snapshot copied'), () => toast('Copy failed', true)),
            })] : []),
        ]);
        back.addEventListener('click', (e) => {
            if (e.target === back) diag.removeEventListener('log', refresh);
        });
        refresh();
    };
    $('vil-save').addEventListener('click', async () => {
        try {
            toast('Reading layout…');
            if (HAS_LAYOUT_DISPATCH) {
                const r = await vil.saveLayoutFile(app);
                if (r.filename) toast(`Saved ${r.filename}`);
                return;
            }
            const text = await exportVil(app);
            const name = (app.profile?.name ?? 'layout').replace(/[^\w-]+/g, '_');
            downloadText(`${name}.vil`, text);
            toast('Layout saved');
        } catch (e) { toast(`Export failed: ${e.message}`, true); }
    });
    $('vil-load').addEventListener('click', () => $('vil-file').click());
    $('vil-file').addEventListener('change', async () => {
        const file = $('vil-file').files[0];
        $('vil-file').value = '';
        if (!file) return;
        try {
            toast('Applying layout…');
            if (HAS_LAYOUT_DISPATCH) {
                const r = await vil.loadLayoutFile(app, file);
                if (r.message) toast(r.message, !!r.warn);
            } else {
                const stats = await importVil(app, await file.text());
                let msg = `Applied ${stats.applied} items`;
                if (stats.skipped) msg += `, ${stats.skipped} named keycodes skipped`;
                if (stats.notes.length) msg += ` — ${stats.notes.join('; ')}`;
                toast(msg, stats.notes.length > 0);
            }
            buildTabs();          // tabs re-read post-import state
            if (TABS.length) await showTab(TABS[0].id);
        } catch (e) { toast(`Import failed: ${e.message}`, true); }
    });
    $('offline-exit').addEventListener('click', exitOffline);
    $('offline-discard').addEventListener('click', () => {
        const ws = app.offlineWs;
        if (!ws) return;
        if (zmkOffline.discardOfflineQueued) {          // WP6
            if (!zmkOffline.discardOfflineQueued(ws)) { toast('Nothing queued'); return; }
        } else {
            if (!(pendingCount(ws) + zmkPendingCount(ws))) { toast('Nothing queued'); return; }
            clearDirty(ws);
            zmkClearDirty(ws);
        }
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
        if (app.hid.connected || connecting || manualSwitch) return;
        if (reconnectCandidate([e.detail])) {
            diag.log('reconnect', 'replug event — reattaching');
            toast('Reconnecting…');
            await connectFlow(e.detail);
        }
    });

    // Event-independent reconnect: an unclean re-enumeration (keyboard
    // power cycle) can eat the disconnect/connect events entirely — some
    // embedders (Electron) also deliver them unreliably — so poll the
    // granted list while nothing is connected and reattach to the
    // remembered device (bench 2026-07-12: after a power cycle every HID
    // op failed until a manual reconnect nobody asked for). A failed
    // attempt backs off 30 s so a broken device can't toast-spam.
    let lastAutoAttempt = 0;
    setInterval(async () => {
        if (app.hid.connected || connecting || manualSwitch || !FlaskHID.supported()) return;
        if (Date.now() - lastAutoAttempt < 30000) return;
        try {
            const match = reconnectCandidate(await FlaskHID.grantedDevices());
            if (match) {
                lastAutoAttempt = Date.now();
                diag.log('reconnect', 'granted-list poll reattach (no hotplug events seen)');
                toast('Reconnecting…');
                await connectFlow(match);
            }
        } catch { /* next tick retries */ }
    }, 2500);

    // Frame wiring: appearance, device switch, rail, save segment.
    initAppearance();
    if (IS_DESKTOP) {
        document.title = 'Totem-Flask';
        $('landing-title').textContent = 'Totem-Flask';
    }
    shell.mount({
        statusBar: $('statusbar'), rail: $('rail'), layerBar: $('layerbar-slot'),
        board: $('board-slot'), palette: $('palette'),
    });
    setCaptionGroup(app.tabGroup);

    $('device-btn').addEventListener('click', async () => {
        if (app.offline) { exitOffline(); return; }
        if (app.trainerOnly) { app.exitTrainer?.(); return; }
        manualSwitch = true;
        await app.hid.close();
        disconnectUI();
    });

    const readout = $('zoom-readout');
    const syncZoom = () => { readout.textContent = `${currentBoardZoom()}%`; };
    $('zoom-in').addEventListener('click', () => applyBoardZoom(currentBoardZoom() + BOARD_ZOOM.step));
    $('zoom-out').addEventListener('click', () => applyBoardZoom(currentBoardZoom() - BOARD_ZOOM.step));
    appearance.addEventListener('appearance', syncZoom);
    syncZoom();
    // Undo/redo belong to the board (WP2); until it provides them the rail
    // buttons stay disabled.
    $('undo-btn').addEventListener('click', () => board.undo?.());
    $('redo-btn').addEventListener('click', () => board.redo?.());
    for (const ev of ['select', 'change', 'history']) board.addEventListener(ev, syncRail);

    // One Save (spec §3.2): the registry is WP6's; this is only its window.
    const renderSave = () => {
        const dirty = saveState.dirty();
        $('save-seg').style.display = dirty.length ? '' : 'none';
        $('save-btn').textContent = saveState.summary?.() || `Save ${dirty.length} unsaved`;
        $('save-btn').title = dirty.map((d) => d.label).join(', ');
        const canDiscard = saveState.canDiscard?.() ?? dirty.some((d) => d.source === 'studio-keymap');
        $('discard-btn').style.display = canDiscard ? '' : 'none';
    };
    saveState.addEventListener('change', renderSave);
    renderSave();
    $('save-btn').addEventListener('click', async () => {
        const r = await saveState.saveAll();
        if (r.failed) toast(`Save failed (${r.failed.source}): ${r.failed.error?.message ?? r.failed.error}`, true);
        else toast('Saved');
    });
    $('discard-btn').addEventListener('click', async () => {
        if (!saveState.discard) { toast('Discard arrives with WP6', true); return; }
        const r = await saveState.discard();
        if (r.failed) toast(`Discard failed (${r.failed.source}): ${r.failed.error?.message ?? r.failed.error}`, true);
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
