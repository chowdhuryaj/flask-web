// flask-web boot + app state. Owns the singleton transport and client,
// runs the post-connect load sequence per firmware line (ZMK: handshake,
// family confirm, offline replay; Svalboard: Vial identity, handshake, board
// meta, unlock state, tunables replay), drives capability-gated tabs, themes,
// and the HUD.

import { el, toast, modal } from './ui.js?v=76';
import { diag } from './diag.js?v=76';
import { FlaskHID } from './webhid.js?v=76';
import { renderPreflight } from './preflight.js?v=76';
import { FlaskProto, CH_ZMK, V } from './flaskproto.js?v=76';
import { isZmkFamily, zmkProfile, confirmZmkFamily, ZMK_FAMILY_UNRESOLVED_MSG,
         zmkReadKeyState, zmkReportResetCause } from './zmk.js?v=76';
import { familyOf, familyLabel, capabilities, expectedProtocol, pickReconnectDevice,
         isQmkFamily, lineOf, qmkProfile, readBoardMeta } from './boards.js?v=76';
import { VialClient } from './vialclient.js?v=76';
import { runUnlockFlow } from './unlock.js?v=76';
import * as vil from './vil.js?v=76';
import { CommandPalette } from './command-palette.js?v=76';
import { HUD } from './hud.js?v=76';
import { ZMK_TEMPLATE_FAMILIES, createZmkTemplate, attachZmkOffline,
         zmkSyncExtras, zmkPendingCount, offlineQueued, discardOfflineQueued,
         seedWorkspaceFromSnapshot, zmkDescribeChanges, dropJournals } from './zmk-offline.js?v=76';
import { saveWorkspace, deleteWorkspace, listWorkspaces, maybeSyncOffline, loadWorkspace, OfflineFlask } from './offline.js?v=76';
import { zmkLiveKeymapTab } from './zmk-keymap-tab.js?v=76';
import { TAB_GROUPS, tabsFor, groupOf, screensFor, screenOf, BOARD_TABS, SIDE_TABS } from './tab-registry.js?v=76';
import { shell } from './app-shell.js?v=76';
import { installCaptions, setCaptionGroup } from './caption.js?v=76';
import { saveState, discardMessage } from './save-state.js?v=76';
import { board } from './board.js?v=76';
import { attachHoldtap } from './behavior-catalog.js?v=76';
import { initAppearance, appearance, applyBoardZoom, currentBoardZoom, BOARD_ZOOM } from './themes.js?v=76';

function downloadText(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---------- app state ----------

const app = {
    hid: new FlaskHID(),
    flask: null,
    family: 'generic',
    protocolVersion: null,
    caps: capabilities('generic', null),
    profile: null,
    layerCount: 0,
    keymap: null,
    hud: null,
    offline: false,
    offlineWs: null,
    // Standalone typing trainer: opened from the landing page with no keyboard
    // attached. Suppresses every device tab (see buildTabs).
    trainerOnly: false,
    /// Which tab group's row is showing (see TAB_GROUPS).
    tabGroup: 'keys',
};
app.flask = new FlaskProto(app.hid);
app.hud = new HUD(app);
// Redesign contracts (WP0): reachable from every tab via `app`.
app.shell = shell;
app.saveState = saveState;
app.showTab = (id) => showTab(id);
app.tabInstance = (id) => TABS.find((t) => t.id === id)?.instance ?? null;
// ⌘K. Installed at module scope, not per-device: navigating is exactly what
// you want when nothing is connected yet.
app.palette = new CommandPalette(app, {
    tabs: () => TABS,
    showTab: (id) => showTab(id),
    groupLabel: (id) => TAB_GROUPS.find((g) => g.id === groupOf(id))?.label ?? '',
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
// Bumped by disconnectUI. A load that resumes after an await (the offline
// dialog, the replay) compares it and walks away instead of repainting
// "Connected" on a dead transport.
let connectGen = 0;

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
            // The keyboard going away mid-load already announced itself.
            if (!app.hid.connected) return;
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
let ambiguousReconnectShown = false;
function reconnectCandidate(devices) {
    const { device, ambiguous } = pickReconnectDevice(devices, {
        last: localStorage.getItem('flask-last-device'),
        lastName: localStorage.getItem('flask-last-name'),
        offlineFamily: app.offline ? app.offlineWs?.family : null,
    });
    if (ambiguous && !ambiguousReconnectShown) toast('Multiple matching keyboards found, choose one with Connect', true);
    ambiguousReconnectShown = ambiguous;
    return device;
}

async function loadDevice(device) {
    app.family = familyOf(device.vendorId, device.productId);
    // Route by family. The chooser is filtered to the known VID/PIDs
    // (boards.js HID_IDS); 'generic' is only reachable from a stale grant.
    if (isZmkFamily(app.family)) return loadZmkDevice(device);
    if (isQmkFamily(app.family)) return loadQmkDevice(device);
    throw new Error(`not a supported keyboard (${familyLabel(app.family)})`);
}

/** QMK line (Svalboard): Vial identity, then the Flask handshake on the same
 * raw-HID interface. The VID/PID is the Svalboard's own; the meta channel
 * answering the handshake confirms the Flask firmware. Vial writes are
 * immediate (no Save step); Flask tunables save per channel, and corner
 * chords (0x28) never save. */
async function loadQmkDevice(device) {
    app.keymap = null;      // the QMK keymap tab publishes it (Vial readKeymap)
    app.readKeyState = null;
    const gen = connectGen;
    const stale = () => gen !== connectGen || !app.hid.connected;

    app.flask = new FlaskProto(app.hid);
    app.flask.line = 'qmk';
    app.vial = new VialClient(app.hid);
    app.viaVersion = await app.vial.viaProtocolVersion();
    app.vialVersion = (await app.vial.vialKeyboardID()).version;
    app.layerCount = await app.vial.layerCount();
    // Picker slot ranges for M n / TD(n) before the Macros / Tap Dance tabs load.
    app.macroCount = await app.vial.macroCount();
    app.tapDanceCount = (await app.vial.dynamicEntryCounts()).tapDance;
    if (stale()) return;

    app.protocolVersion = await app.flask.handshake();
    if (stale()) return;
    app.familyUnresolved = false;   // 303a:4044 is unique to the Svalboard
    if (app.protocolVersion == null) toast('No Flask protocol on this Svalboard (stock firmware?): Vial tabs only', true);
    app.caps = capabilities(app.family, app.protocolVersion);
    app.board = await readBoardMeta(app.flask, app.caps);
    app.profile = qmkProfile(app.family, app.layerCount, app.board);
    try { app.unlocked = (await app.vial.unlockStatus()).unlocked; }
    catch { app.unlocked = false; }
    app.onHudLockClick = () => runUnlockFlow(app, (u) => { app.unlocked = u; });
    if (stale()) return;

    // Unplugged queue (tunables only) → device.
    if (app.caps.flask) {
        await maybeSyncOffline(app, device);
        if (stale()) return;
    }

    setMode('device');
    $('layout-save').style.display = $('layout-load').style.display = '';
    updateStatus(device);
    buildTabs();
    if (TABS.length) await showTab(TABS[0].id);
    // Refresh the tunables snapshot the Unplugged workspace shows, after the
    // first tab so its reads do not queue behind ~240 GETs.
    if (!stale() && app.caps.flask) {
        vil.snapshotQmkWorkspace(app).then(renderOfflineList, (e) => console.warn('snapshot failed:', e));
    }
}

/** Load: Flask handshake only. The keymap lives in ZMK Studio, so every
 * tab is Flask-protocol or Studio RPC. */
async function loadZmkDevice(device) {
    app.keymap = null;  // ZMK keymap tab publishes the real one post-Studio-load
    const gen = connectGen;
    const stale = () => gen !== connectGen || !app.hid.connected;

    app.vial = null;    // no Vial surface on the ZMK line
    app.board = null;
    app.unlocked = false;
    // Fresh client per connection: slot counts and hold-tap probes are memoized per client.
    app.flask = new FlaskProto(app.hid);
    app.flask.line = 'zmk';   // 0x28 is tap dance here: SAVE allowed
    app.protocolVersion = await app.flask.handshake();
    if (stale()) return;
    if (app.protocolVersion == null) {
        throw new Error('ZMK device without the Flask protocol — is raw_hid_adapter + CONFIG_ZMK_FLASK_PROTO in the firmware?');
    }

    // The stock ZMK VID/PID is shared by every ZMK board — confirm the
    // family from meta 0x03 (pre-family firmware keeps the VID/PID guess).
    const confirmed = await confirmZmkFamily(app.flask, app.family);
    if (stale()) return;
    app.familyUnresolved = confirmed == null;   // keymap import / Mode apply / Studio writes stay blocked
    if (app.familyUnresolved) toast(ZMK_FAMILY_UNRESOLVED_MSG, true);
    else app.family = confirmed;

    app.caps = capabilities(app.family, app.protocolVersion);
    app.profile = zmkProfile(app.family);
    app.layerCount = app.profile.layerNames.length;
    // HUD press highlight rides the key-state bitmap (hud.js polls this
    // generically when caps.keyState).
    app.readKeyState = app.caps.keyState ? () => zmkReadKeyState(app.flask) : null;
    // Crash forensics: log the boot reset cause; toast on fault bits.
    zmkReportResetCause(app.flask, toast);

    // Offline preview queue → device. ONE decision (apply / later / discard)
    // covers tunables, RGB, slot edits and the queued keymap. Unresolved
    // family = guessed board: never replay another board's queue onto it.
    app.zmkQueuedWs = null;   // never let a prior connect's queue leak across
    if (!app.familyUnresolved) {
        await maybeSyncOffline(app, device, {
            count: zmkPendingCount, describe: zmkDescribeChanges,
            apply: applyZmkExtras, clear: dropJournals,
        });
        if (stale()) return;
    }

    setMode('device');
    $('layout-save').style.display = $('layout-load').style.display = '';
    updateStatus(device);
    await probeHoldtap();
    await probeAdaptive();
    if (stale()) return;
    buildTabs();
    if (TABS.length) await showTab(TABS[0].id);
    // Desktop: bring the HUD back if it was showing last time.
    if (!stale() && (await window.totemFlask?.hudSettings?.())?.shown) { await app.hud.setOpen(true); syncHudBtn(); }
}

/** Replay the ZMK-shaped half of the offline queue (slot edits + queued keymap). */
async function applyZmkExtras(a, ws) {
    if (!zmkPendingCount(ws)) return;
    const { applied, failures, keymapSkipped, keymapReview } = await zmkSyncExtras(a, ws);
    if (keymapSkipped) toast('Unplugged template keymap edits were not applied to your keyboard (the template is not your keymap)', true);
    if (keymapReview) toast('Unplugged keymap edits changed the layer list, so they were not applied. They stay queued for review.', true);
    if (failures.length) {
        console.warn('zmk offline sync failures:', failures);
        toast(`Applied ${applied} offline slot edits — ${failures.length} failed, still queued`, true);
    } else if (applied) {
        toast(`Applied ${applied} offline combo/macro slot edits`);
    }
}

function updateStatus(device) {
    const pill = $('status-pill');
    pill.classList.remove('offline');
    pill.classList.add('connected');
    const fam = familyLabel(app.family);
    const proto = app.protocolVersion != null ? ` · Flask v${app.protocolVersion}` : (app.vial ? ' · plain Vial' : '');
    saveState.setLine?.(lineOf(app.family));   // 0x28 never registers on the QMK line
    $('device-name').textContent = app.profile?.name ?? device.productName ?? 'Keyboard';
    $('status-text').textContent = 'Connected';
    pill.title = `${fam}${proto} — ${device.vendorId.toString(16)}:${device.productId.toString(16)}`;

    const warn = $('proto-warn');
    const expected = expectedProtocol(app.family);
    if (app.protocolVersion != null && expected && app.protocolVersion !== expected) {
        warn.style.display = '';
        warn.textContent = `protocol v${app.protocolVersion} ≠ app v${expected} — reflash`;
    } else {
        warn.style.display = 'none';
    }
}

function disconnectUI() {
    connectGen++;
    app.familyUnresolved = false;   // a stale flag would block every Unplugged edit
    app.hud.close();
    app.protocolVersion = null;
    app.profile = null;
    app.vial = null;
    app.board = null;
    app.unlocked = false;
    app.trainerOnly = false;
    saveState.reset?.();    // drop dirty sources
    saveState.setLine?.(null);
    $('status-pill').classList.remove('connected', 'offline');
    $('status-text').textContent = 'Disconnected';
    $('device-name').textContent = 'Flask';
    $('proto-warn').style.display = 'none';
    $('layout-save').style.display = 'none';
    $('layout-load').style.display = 'none';
    $('offline-seg').style.display = 'none';
    $('panels').replaceChildren();
    $('main-tabs').replaceChildren();
    $('subtabs')?.replaceChildren();
    setMode('landing');
    refreshDeviceList();
    renderOfflineList();
}

// ---------- offline mode ----------

async function startOffline(key, family) {
    if (isQmkFamily(family)) return startQmkOffline(key);
    app.trainerOnly = false;    // same trap as connectFlow's
    // No real keymap captured yet? Seed from a stored keymap snapshot of a
    // keyboard of this family (a template stays the fallback).
    let ws = null;
    try { ws = seedWorkspaceFromSnapshot(family); } catch (e) { console.warn('snapshot seed failed:', e); }
    ws ??= loadWorkspace(key) ?? createZmkTemplate(family);
    ws._notify = updateOfflineBanner; // dropped by JSON.stringify on persist
    saveWorkspace(ws);
    app.offline = true;
    app.offlineWs = ws;
    attachZmkOffline(app, ws);      // flask sim + Studio sim + caps/profile
    saveState.setLine?.('zmk');
    setMode('offline');   // no HUD: it is live device state
    $('layout-save').style.display = $('layout-load').style.display = '';
    $('proto-warn').style.display = 'none';
    $('status-pill').classList.remove('connected');
    $('status-pill').classList.add('offline');
    $('status-text').textContent = 'Unplugged';
    $('device-name').textContent = ws.label;
    $('offline-seg').style.display = '';
    updateOfflineBanner();
    await probeHoldtap();
    await probeAdaptive();
    buildTabs();
    showTab('zmk-keymap');
}

/** Svalboard Unplugged: the tunables journal only (offline.js core). No Vial
 * surface (no keymap, macros, entries or QMK settings) and no corner chords
 * (0x28 is read-only offline). Edits replay on the next connect. */
async function startQmkOffline(key) {
    const ws = loadWorkspace(key);
    if (!ws) { toast('Connect the Svalboard once first: Unplugged starts from its last read', true); return; }
    app.trainerOnly = false;
    ws._notify = updateOfflineBanner;
    app.offline = true;
    app.offlineWs = ws;
    app.family = ws.family;
    app.flask = new OfflineFlask(ws);
    app.vial = null;
    app.board = null;
    app.keymap = null;
    app.protocolVersion = ws.protocolVersion;
    app.layerCount = ws.layerCount;
    app.caps = { ...capabilities(ws.family, ws.protocolVersion), vial: false, cornerCombos: false };
    app.profile = qmkProfile(ws.family, ws.layerCount);
    saveState.setLine?.('qmk');

    setMode('offline');
    $('layout-save').style.display = $('layout-load').style.display = 'none';
    $('proto-warn').style.display = 'none';
    $('status-pill').classList.remove('connected');
    $('status-pill').classList.add('offline');
    $('status-text').textContent = 'Unplugged';
    $('device-name').textContent = ws.label;
    $('offline-seg').style.display = '';
    updateOfflineBanner();
    buildTabs();
    if (TABS.length) await showTab(TABS[0].id);
}

function updateOfflineBanner() {
    if (!app.offline || !app.offlineWs) return;
    const n = offlineQueued(app.offlineWs);
    $('offline-msg').textContent = n ? `${n} queued` : '';
    $('offline-discard').hidden = !n;
    $('offline-seg').title = n ? `${n} changes queued for ${app.offlineWs.label}` : 'Edits queue until the keyboard connects (unplugged)';
}

function exitOffline() {
    if (app.offlineWs) delete app.offlineWs._notify;
    app.offline = false;
    app.offlineWs = null;
    app.flask = new FlaskProto(app.hid);
    app.zmkStudioSim = null;    // keymap tab falls back to the real serial client
    app.vial = null;
    app.readKeyState = null;
    disconnectUI();
}

function renderOfflineList() {
    const list = $('offline-list');
    if (!list) return;
    const saved = new Map(listWorkspaces().map((w) => [w.key, w]));
    const entries = [];
    for (const fam of ZMK_TEMPLATE_FAMILIES) {
        if (!saved.has(fam)) entries.push({ key: fam, family: fam, label: familyLabel(fam), pending: 0, saved: false });
    }
    for (const ws of saved.values()) {
        entries.push({
            key: ws.key, family: ws.family, label: ws.label,
            pending: offlineQueued(ws), saved: true,
            fromDevice: ws.source === 'device', savedAt: ws.savedAt,
        });
    }
    list.replaceChildren(...entries.map((e) => el('button', {
        class: 'dev-item', onclick: () => startOffline(e.key, e.family),
        title: isQmkFamily(e.family) ? 'Tunables as last read from the Svalboard (no keymap offline)'
            : e.fromDevice ? 'Your keymap, as last read from the keyboard' : 'Firmware template, not your keymap',
    },
        `✈️ ${e.label}`,
        e.pending ? el('span', { class: 'badge', text: `${e.pending} queued` }) : null,
        el('span', { class: 'badge faint', text: e.fromDevice
            ? `${isQmkFamily(e.family) ? 'tunables' : 'your keymap'} · ${new Date(e.savedAt).toLocaleDateString()}` : 'template' }),
        e.saved ? el('span', {
            class: 'badge', text: '✕', title: 'Delete this unplugged workspace',
            onclick: (ev) => {
                ev.stopPropagation();
                if (confirm(`Delete the unplugged workspace for ${e.label}? Queued changes are lost.`)) {
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

/** caps.holdtap for the Behaviour › Hold timing row: proto >= 17 and
 * channel 0x2A answers GET SLOT_COUNT (attachHoldtap, memoized per client). */
async function probeHoldtap() {
    if (!app.caps || !isZmkFamily(app.family)) return;
    try { app.caps.holdtap = !!(await attachHoldtap(app)); }
    catch { app.caps.holdtap = false; }
}

/** caps.adaptive for Behaviour › Adaptive: proto >= 18 and channel 0x2B
 * answers GET SET_COUNT (0xFF echo = module not compiled in: Imprint, older
 * Totem images). */
async function probeAdaptive() {
    if (!app.caps || !isZmkFamily(app.family)) return;
    app.caps.adaptive = false;
    if ((app.protocolVersion ?? 0) < 18) return;
    try { app.caps.adaptive = !!(await app.flask.getU16(CH_ZMK.adaptive, V.akSetCount)); }
    catch { app.caps.adaptive = false; }
}

function buildTabs() {
    TABS.length = 0;
    TABS.push(...tabsFor(app));
    renderTabStrip();
}

/**
 * The nav only: the top bar's second row (look-shell), one button per screen,
 * a sub-strip for screens with several tabs. Deliberately separate from
 * renderTabStrip: that one re-instantiates every panel, and a screen click
 * must not throw away the state of every open tab.
 */
function renderTabNav(active = app.activeTab ?? TABS[0]?.id) {
    shell.renderTabs({ tabs: TABS, active, onSelect: showTab, app,
        registry: { screensFor, screenOf, BOARD_TABS, SIDE_TABS } });
}

/** Nav + one panel per tab, instantiated but not yet loaded. */
function renderTabStrip() {
    renderTabNav();
    const panels = $('panels');
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
    app.activeTab = id;
    setCaptionGroup(app.tabGroup);
    renderTabNav(id);
    $('palette-body').scrollTop = 0;
    for (const t of TABS) {
        t.panel.classList.toggle('active', t.id === id);
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
    const granted = await FlaskHID.grantedDevices().catch(() => []);   // policy-blocked WebHID rejects
    list.replaceChildren(...granted.map((d) => {
        const family = familyOf(d.vendorId, d.productId);
        const hex = (n) => n.toString(16).padStart(4, '0');
        return el('button', { class: 'dev-item', onclick: () => connectFlow(d) },
            d.productName || familyLabel(family),
            el('span', { class: 'vidpid mono', text: `${hex(d.vendorId)}:${hex(d.productId)}` }));
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
        // Electron has no chooser for 0 devices (and auto-picks 1): an instant
        // empty result there means "no keyboard", not "blocked".
        if (IS_DESKTOP && e.kind === 'cancelled' && ms < 400 && !refused) {
            toast('No keyboard found. Plug it in and try again.', true);
            return;
        }
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
    const mode = $('app-frame').dataset.mode;
    const live = mode === 'device';
    b.style.display = live ? '' : 'none';
    b.textContent = app.hud.open ? 'Floating' : 'Pop out';
    b.classList.toggle('on', !!app.hud.open);
    // Header toggle: the live HUD while connected; on the desktop app while
    // unplugged it shows (and flips) whether the HUD comes up on connect.
    const t = $('hud-toggle');
    t.hidden = !(live || (IS_DESKTOP && mode === 'offline'));
    const on = live ? !!app.hud.open : !!app.hud.desk?.shown;
    t.setAttribute('aria-pressed', String(on));
}

async function hudToggleClick() {
    if ($('app-frame').dataset.mode === 'device') {
        await app.hud.toggle();
    } else if (window.totemFlask?.setHudShown) {
        const v = !app.hud.desk?.shown;
        window.totemFlask.setHudShown(v);
        if (v) toast('The HUD shows once the keyboard is connected.');
    }
    syncHudBtn();
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
    // mode as running another Flask app alongside).
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
    $('hud-toggle').addEventListener('click', hudToggleClick);
    app.hud.onChange = syncHudBtn;
    setInterval(syncHudBtn, 1000);   // the HUD can close itself (its own ✕, pagehide)
    // Desktop menu / global shortcut (Show HUD). The HUD is live device
    // state, so with no keyboard it waits for the next connect.
    window.totemFlask?.onHudSet?.(async (on) => {
        if (on && $('app-frame').dataset.mode !== 'device') {
            toast('The HUD shows once the keyboard is connected.');
            return;
        }
        await app.hud.setOpen(on);
        syncHudBtn();
    });
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
    // Save layout / Load: the ZMK keymap tab names and downloads its own file;
    // the Svalboard writes/reads a .vil (vil.js).
    $('layout-save').addEventListener('click', async () => {
        if (isQmkFamily(app.family)) {
            try { const r = await vil.saveLayoutFile(app); toast(`Saved ${r.filename}`); }
            catch (e) { toast(`Export failed: ${e.message}`, true); }
            return;
        }
        try {
            const kt = zmkLiveKeymapTab();
            if (!kt?.keymap) throw new Error('the keymap is still loading');
            await kt.exportKeymap();
        } catch (e) { toast(`Export failed: ${e.message}`, true); }
    });
    $('layout-load').addEventListener('click', () => $('layout-file').click());
    $('layout-file').addEventListener('change', async () => {
        const file = $('layout-file').files[0];
        $('layout-file').value = '';
        if (!file) return;
        if (isQmkFamily(app.family)) {
            try {
                const r = await vil.loadLayoutFile(app, file);
                toast(r.message, r.warn);
                buildTabs();
                if (TABS.length) await showTab(TABS[0].id);
            } catch (e) { toast(`Import failed: ${e.message}`, true); }
            return;
        }
        try {
            const kt = zmkLiveKeymapTab();
            if (!kt?.keymap) throw new Error('the keymap is still loading');
            await kt.importKeymap(file);
            buildTabs();          // tabs re-read post-import state
            if (TABS.length) await showTab(TABS[0].id);
        } catch (e) { toast(`Import failed: ${e.message}`, true); }
    });
    $('offline-exit').addEventListener('click', exitOffline);
    $('offline-discard').addEventListener('click', () => {
        const ws = app.offlineWs;
        if (!ws) return;
        const n = offlineQueued(ws);
        if (!n) { toast('Nothing queued'); return; }
        if (!confirm(`Discard ${n} queued change${n === 1 ? '' : 's'}? They have not reached the keyboard yet.`)) return;
        discardOfflineQueued(ws);
        toast('Queued changes discarded');
        buildTabs();    // tabs re-read the restored workspace
        showTab(isQmkFamily(app.family) ? TABS[0]?.id : 'zmk-keymap');
        updateOfflineBanner();
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
        try {
            const match = reconnectCandidate(await FlaskHID.grantedDevices());   // whole list, so a second board is seen
            if (match) {
                diag.log('reconnect', 'replug event — reattaching');
                toast('Reconnecting…');
                await connectFlow(match);
            }
        } catch (err) { console.warn('Hotplug reconnect failed:', err); }
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
        board: $('board-slot'), palette: $('app-frame'),   // holds the caption bar
    });
    $('menu-diag')?.addEventListener('click', () => app.openDiagnostics?.());
    $('menu-palette')?.addEventListener('click', () => app.palette.toggle());
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
        // The primary Save is always on the bar (look-shell): lime when there is
        // something to save, a quiet "Saved" when there is not.
        $('save-btn').textContent = dirty.length ? (saveState.summary?.() || `Save ${dirty.length} unsaved`) : 'Saved';
        $('save-btn').disabled = !dirty.length;
        $('save-btn').title = dirty.map((d) => d.label).join(', ');
        // ONE Discard (look-extras' flaskDiscardAll covers keymap edits and the
        // offline queue); shown while there is anything to throw away.
        // Queued Unplugged edits are SAVED (they replay on connect): the top-bar
        // Discard never touches them. "Discard queued" is its own confirmed action.
        $('discard-btn').style.display = saveState.canDiscard() ? '' : 'none';
    };
    saveState.addEventListener('change', renderSave);
    renderSave();
    $('save-btn').addEventListener('click', async () => {
        const r = await saveState.saveAll();
        if (r.failed) toast(`Save failed (${r.failed.source}): ${r.failed.error?.message ?? r.failed.error}`, true);
        else toast('Saved');
    });
    $('discard-btn').addEventListener('click', async () => {
        if (typeof window.flaskDiscardAll === 'function') {
            try {
                const r = await window.flaskDiscardAll();
                const m = discardMessage(r, saveState.dirty().map((d) => d.label || d.source));
                toast(m.text, m.bad);
            } catch (e) { toast(`Discard failed: ${e.message}`, true); }
            renderSave();
            return;
        }
        if (!saveState.discard) { toast('Discard is not available in this build', true); return; }
        const r = await saveState.discard();
        if (r.failed) toast(`Discard failed (${r.failed.source}): ${r.failed.error?.message ?? r.failed.error}`, true);
    });

    // Silent reconnect to the remembered device on page load.
    renderOfflineList();
    (async () => {
        await refreshDeviceList();
        if (!localStorage.getItem('flask-last-device')) return;
        const match = reconnectCandidate(await FlaskHID.grantedDevices());
        if (match) await connectFlow(match);
    })().catch((e) => {
        console.error('Startup reconnect failed:', e);
        toast(`Startup reconnect failed: ${e.message}`, true);
    });
}

init();
