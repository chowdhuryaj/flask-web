// Totem-Flask desktop: Electron wrapper around the flask-web configurator.
//
// Installs as /Applications/Totem-Flask.app (dev.aj.totem-flask) next to the
// native Flask.app (com.aj.flask). WebHID (Flask tuning protocol) and
// WebSerial (ZMK Studio RPC) only ship in Chromium, so this bundles one.
//
// Security model (reviewed as a unit, keep these together):
//  - contextIsolation on, nodeIntegration off, renderer sandbox on, webview off;
//    the only preload (preload.js) exposes two frozen members;
//  - no remote content: the app is served from the privileged scheme
//    totem-flask://app/, every other network request is cancelled, every
//    navigation off the app origin is blocked, a CSP is sent with each file;
//  - device access is scoped to the known keyboard VID/PIDs below, for both
//    the chooser (select-hid-device / select-serial-port) and the stored
//    grants (setDevicePermissionHandler); other permissions are denied.
//
// Storage origin: totem-flask://app is fixed, so localStorage (offline
// workspaces, Modes, theme, auto-restore snapshots) survives updates and is
// shared between `npm start` and the packaged app.
//
// Env: FLASK_DESKTOP_SMOKE=1  smoke run (implies no devices), prints probes, exits
//      FLASK_NO_DEVICE=1      refuse every device grant (safe to launch with a keyboard plugged in)
//      TOTEM_NO_PANEL=1       HUD as a plain focusable:false window instead of type:'panel'

const { app, BrowserWindow, Menu, protocol, session, screen, dialog, shell, ipcMain, globalShortcut } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const SCHEME = 'totem-flask';
const ORIGIN = `${SCHEME}://app`;
const SMOKE = !!process.env.FLASK_DESKTOP_SMOKE;
const NO_DEVICE = SMOKE || !!process.env.FLASK_NO_DEVICE;

// Dev serves the checkout (this file's parent). The packaged app carries the
// web files as extraResources under Resources/web (__dirname is inside asar).
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');

// Keyboards this app may talk to (vendor:product, lower-case hex).
const HID_ALLOW = new Set([
    '1d50:615e', // stock ZMK (Totem, Imprint)
]);
const SERIAL_ALLOW = new Set(['1d50:615e']); // ZMK Studio RPC (CDC)
// HID ids arrive as numbers, serial ids as decimal strings ('7504') — Number() takes both.
const vp = (v, p) => `${(Number(v) || 0).toString(16).padStart(4, '0')}:${(Number(p) || 0).toString(16).padStart(4, '0')}`;

const NATIVE_BUNDLE_ID = 'com.aj.flask';
const OLD_PROFILE = path.join(app.getPath('appData'), 'Flask'); // desktop 1.x
const LEGACY_ORIGIN_PORT = 8137;                                // desktop 1.x served here

protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

/** Read one file under ROOT. Returns {status, headers, body}. */
async function readAsset(pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return { status: 400 }; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return { status: 403 };
    try {
        const body = await fs.promises.readFile(file);
        return {
            status: 200,
            body,
            headers: {
                'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                // Same rationale as serve.py: force revalidation so edits show up.
                'Cache-Control': 'no-cache, must-revalidate',
                'Content-Security-Policy': CSP,
            },
        };
    } catch { return { status: 404 }; }
}

function registerAppProtocol() {
    protocol.handle(SCHEME, async (req) => {
        const u = new URL(req.url);
        if (u.host !== 'app') return new Response(null, { status: 404 });
        const r = await readAsset(u.pathname);
        return new Response(r.body ?? null, { status: r.status, headers: r.headers });
    });
}

// ---- device access ---------------------------------------------------------

/** Exact-origin test: a prefix match would also pass `totem-flask://app.evil/`. */
function isAppUrl(u) {
    // protocol+host, not .origin: non-special schemes report origin "null".
    try { const x = new URL(u); return x.protocol === `${SCHEME}:` && x.host === 'app'; } catch { return false; }
}

/** One candidate auto-picks; several bring up a native chooser (first 8). */
function pickDevice(list, kind, nameOf) {
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const names = list.slice(0, 8).map((d, i) => nameOf(d) || `${kind} device ${i + 1}`);
    const idx = dialog.showMessageBoxSync({
        type: 'question',
        title: `Select ${kind} device`,
        message: `Several ${kind} devices match. Which one?`,
        buttons: [...names, 'Cancel'],
        cancelId: names.length,
    });
    return idx < names.length ? list[idx] : null;
}

function wireSecurity(ses) {
    // Only the app origin and local plumbing may load anything.
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
        let scheme = '';
        try { scheme = new URL(details.url).protocol; } catch { /* cancel */ }
        cb({ cancel: ![`${SCHEME}:`, 'devtools:', 'blob:', 'data:', 'about:'].includes(scheme) });
    });

    // WebHID: Flask tuning protocol (raw HID 0xFF60/0x61). The chooser only
    // ever sees allow-listed keyboards.
    ses.on('select-hid-device', (event, details, callback) => {
        event.preventDefault();
        if (NO_DEVICE) { callback(undefined); return; }
        const list = details.deviceList.filter((d) => HID_ALLOW.has(vp(d.vendorId, d.productId)));
        const d = pickDevice(list, 'HID', (x) => x.name || vp(x.vendorId, x.productId));
        callback(d ? d.deviceId : undefined);
    });
    // WebSerial: ZMK Studio RPC.
    ses.on('select-serial-port', (event, portList, wc, callback) => {
        event.preventDefault();
        if (NO_DEVICE) { callback(''); return; }
        const list = portList.filter((p) => SERIAL_ALLOW.has(vp(p.vendorId, p.productId)));
        const p = pickDevice(list, 'serial', (x) => x.displayName || x.portName || x.portId);
        callback(p ? p.portId : '');
    });

    // Stored grants: previously chosen keyboards reappear in getDevices()
    // without a chooser, but only allow-listed ones, only for the app origin.
    ses.setDevicePermissionHandler((d) => {
        if (NO_DEVICE) return false;
        if (d.origin !== ORIGIN) return false;
        const dev = d.device || {};
        if (d.deviceType === 'hid') return HID_ALLOW.has(vp(dev.vendorId, dev.productId));
        // Serial grants carry Chromium's port dict (vendor_id), not the chooser's vendorId.
        if (d.deviceType === 'serial') return SERIAL_ALLOW.has(vp(dev.vendorId ?? dev.vendor_id, dev.productId ?? dev.product_id));
        return false;
    });

    const allowed = (permission) => ['hid', 'serial', 'clipboard-sanitized-write'].includes(permission);
    ses.setPermissionCheckHandler((wc, permission, origin) =>
        isAppUrl(origin) && allowed(permission) && !(NO_DEVICE && ['hid', 'serial'].includes(permission)));
    ses.setPermissionRequestHandler((wc, permission, cb, details) =>
        cb(isAppUrl(details.requestingUrl) && allowed(permission)
            && !(NO_DEVICE && ['hid', 'serial'].includes(permission))));
}

app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
});

// ---- HUD overlay -----------------------------------------------------------
//
// The renderer opens the HUD as a same-origin popup (hud.js:
// window.open('about:blank', 'flask-hud')) and paints the live keymap into it
// from its own single device connection; this process owns the window: flags,
// corner placement on the cursor's display, menu, global shortcut, settings.

const hudPrefs = require('./hud-prefs');
const HUD_SHORTCUT = 'Control+Alt+Command+K';
const usePanel = process.platform === 'darwin' && !process.env.TOTEM_NO_PANEL;
const hudPrefsFile = () => path.join(app.getPath('userData'), 'hud.json');
let hudSettings = null;   // loaded in start()
let hudWin = null;
let hudPlacedOn = '';     // display id + workArea the HUD was last placed on
let hudFollow = null;

/** Move the HUD to its corner of the display under the cursor. Re-places only
 * when that display (or its workArea: dock, resolution, add/remove) changed,
 * unless forced. */
function placeHud(force) {
    if (!hudWin || hudWin.isDestroyed()) return;
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const key = `${d.id}:${JSON.stringify(d.workArea)}`;
    if (!force && key === hudPlacedOn) return;
    hudPlacedOn = key;
    const [, height] = hudWin.getSize();
    hudWin.setBounds(hudPrefs.cornerBounds(d.workArea, { width: hudSettings.width, height }, hudSettings.corner));
}

function hudWindowOptions() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = hudPrefs.cornerBounds(d.workArea, { width: hudSettings.width, height: Math.round(hudSettings.width * 0.55) },
        hudSettings.corner);
    return {
        ...b,
        show: false,              // shown inactive in wireHud: never steals focus
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        title: 'Totem-Flask HUD',
        // Non-activating NSPanel: the level that can sit over full-screen apps.
        ...(usePanel ? { type: 'panel' } : {}),
        alwaysOnTop: true,
        webPreferences: { backgroundThrottling: false },
    };
}

function wireHud(win) {
    hudWin = win;
    hudPlacedOn = '';
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });   // click-through
    win.setOpacity(hudSettings.opacity);
    placeHud(true);
    win.showInactive();
    // ponytail: 200 ms cursor poll; Electron has no cursor-moved-display event.
    hudFollow = setInterval(() => placeHud(false), 200);
    win.on('closed', () => { clearInterval(hudFollow); hudFollow = null; hudWin = null; });
}

function saveHudSettings(patch) {
    Object.assign(hudSettings, patch);
    hudPrefs.save(hudPrefsFile(), hudSettings);
    if (hudWin && !hudWin.isDestroyed()) {
        hudWin.setOpacity(hudSettings.opacity);
        placeHud(true);
    }
}

/** Show HUD on/off. From the menu or shortcut the renderer is told to open
 * or close it; from the renderer (its Pop out button) only the setting moves. */
function setHudShown(shown, mainWin, fromRenderer) {
    saveHudSettings({ shown });
    for (const id of ['hud-show', 'hud-show-app']) {
        const item = Menu.getApplicationMenu()?.getMenuItemById(id);
        if (item) item.checked = shown;
    }
    if (!fromRenderer && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('hud-set', shown);
}

function hudMenu(getWin) {
    const radio = (label, key, value) => ({
        label, type: 'radio', checked: hudSettings[key] === value,
        click: () => saveHudSettings({ [key]: value }),
    });
    const title = (c) => c.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    return {
        label: 'HUD',
        submenu: [
            { id: 'hud-show', label: 'Show HUD', type: 'checkbox', checked: hudSettings.shown,
                accelerator: HUD_SHORTCUT, registerAccelerator: false,   // the global shortcut owns it
                click: (item) => setHudShown(item.checked, getWin(), false) },
            { type: 'separator' },
            { label: 'Corner', submenu: hudPrefs.CORNERS.map((c) => radio(title(c), 'corner', c)) },
            { label: 'Size', submenu: Object.entries(hudPrefs.SIZES).map(([n, w]) => radio(`${n} (${w} px)`, 'width', w)) },
            { label: 'Opacity', submenu: hudPrefs.OPACITIES.map((o) => radio(`${Math.round(o * 100)}%`, 'opacity', o)) },
        ],
    };
}

// ---- native Flask.app check, legacy import ----------------------------------

function nativeFlaskRunning() {
    return new Promise((resolve) => {
        if (process.platform !== 'darwin') { resolve(false); return; }
        execFile('/usr/bin/lsappinfo', ['find', `bundleid=${NATIVE_BUNDLE_ID}`], (err, out) =>
            resolve(!err && /ASN:/.test(out)));
    });
}

const legacyMarker = () => path.join(app.getPath('userData'), 'legacy-import.json');
const legacyAvailable = () => fs.existsSync(path.join(OLD_PROFILE, 'Local Storage'));

/** Desktop 1.x kept its data under http://localhost:8137. A child run of this
 * binary on the old profile (TOTEM_LEGACY_DUMP=<out.json>) loads that origin
 * hidden and dumps the flask-* localStorage keys; see runLegacyDump(). */
function dumpLegacy(profileDir) {
    // The child never opens the real old profile: it runs on a temp copy of
    // just its Local Storage, so nothing it does can rewrite the 1.x data.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'totem-flask-legacy-'));
    const out = path.join(tmp, 'dump.json');
    try {
        fs.cpSync(path.join(profileDir, 'Local Storage'), path.join(tmp, 'profile', 'Local Storage'), { recursive: true });
    } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [`--user-data-dir=${path.join(tmp, 'profile')}`], {
            env: { ...process.env, TOTEM_LEGACY_DUMP: out }, timeout: 30000,
        }, (err) => {
            let data;
            try { data = JSON.parse(fs.readFileSync(out, 'utf8')); }
            catch (e) { data = { __error: (err || e).message }; }
            fs.rmSync(tmp, { recursive: true, force: true });
            if (data.__error) reject(new Error(data.__error)); else resolve(data);
        });
    });
}

async function importLegacy(win) {
    try {
        const data = await dumpLegacy(OLD_PROFILE);
        const keys = Object.keys(data);
        if (!keys.length) {
            dialog.showMessageBox(win, { type: 'info', message: 'Nothing to import from Flask (desktop 1.x).' });
            return;
        }
        // Never overwrite what this app already has.
        const added = await win.webContents.executeJavaScript(
            `((d) => { let n = 0; for (const [k, v] of Object.entries(d)) {`
            + ` if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); n++; } } return n; })(${JSON.stringify(data)})`);
        fs.writeFileSync(legacyMarker(), JSON.stringify({ at: new Date().toISOString(), added }));
        await dialog.showMessageBox(win, { type: 'info', message: `Imported ${added} item(s) from Flask (desktop 1.x).`,
            detail: 'Existing Totem-Flask data was kept.' });
        win.reload();
    } catch (e) {
        dialog.showMessageBox(win, { type: 'warning', message: 'Import failed.',
            detail: `${e.message || e}\nIf the old Flask desktop app is open, quit it and try again from the Flask menu.` });
    }
}

async function offerLegacyImport(win) {
    if (SMOKE || !legacyAvailable() || fs.existsSync(legacyMarker())) return;
    const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        message: 'Import workspaces and Modes from Flask (desktop 1.x)?',
        detail: 'Totem-Flask keeps its data separately. Existing data here is never overwritten.',
        buttons: ['Import', 'Not now', 'Do not ask again'],
        defaultId: 0, cancelId: 1,
    });
    if (response === 0) await importLegacy(win);
    else if (response === 2) fs.writeFileSync(legacyMarker(), JSON.stringify({ declined: true }));
}

/** Does the server on `port` answer index.html byte-for-byte like ours
 * (e.g. serve.py on this checkout)? Anything else must not be loaded. */
async function servesOurApp(port) {
    const mine = await readAsset('/index.html');
    if (mine.status !== 200) return false;
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/index.html', timeout: 3000 }, (res) => {
            const chunks = [];
            let n = 0;
            res.on('data', (c) => { n += c.length; if (n > 4 * mine.body.length) req.destroy(); else chunks.push(c); });
            res.on('end', () => resolve(res.statusCode === 200 && Buffer.concat(chunks).equals(mine.body)));
            res.on('error', () => resolve(false));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
    });
}

/** Child mode: load the old origin hidden, print its flask-* localStorage. */
async function runLegacyDump(outFile) {
    await app.whenReady();
    const srv = http.createServer(async (req, res) => {
        const r = await readAsset(new URL(req.url, 'http://localhost').pathname);
        res.writeHead(r.status, r.headers);
        res.end(r.body);
    });
    const busy = await new Promise((resolve) => {
        srv.once('error', () => resolve(true));        // port busy: reuse only if it serves our files
        srv.listen(LEGACY_ORIGIN_PORT, '127.0.0.1', () => resolve(false));
    });
    if (busy && !(await servesOurApp(LEGACY_ORIGIN_PORT))) {
        fs.writeFileSync(outFile, JSON.stringify({ __error:
            `Port ${LEGACY_ORIGIN_PORT} is in use by another program. Quit it and try again.` }));
        app.exit(0);
        return;
    }
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL(`http://localhost:${LEGACY_ORIGIN_PORT}/`);
    const data = await win.webContents.executeJavaScript(
        `Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('flask')).map((k) => [k, localStorage.getItem(k)]))`);
    fs.writeFileSync(outFile, JSON.stringify(data));
    app.exit(0);
}

// ---- update check (packaged builds) ---------------------------------------
//
// The app is UNSIGNED, and electron-updater refuses to install updates into an
// unsigned mac app, so: compare against the newest GitHub release and open its
// page for a manual download. Everyday path on the build Mac: `npm run install-app`.
const RELEASES_API = 'https://api.github.com/repos/chowdhuryaj/flask-web/releases/latest';
const RELEASES_URL = 'https://github.com/chowdhuryaj/flask-web/releases/latest';

function fetchLatestVersion() {
    return new Promise((resolve, reject) => {
        const req = https.get(RELEASES_API, {
            headers: { 'User-Agent': 'totem-flask-desktop', Accept: 'application/vnd.github+json' },
            timeout: 10000,
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`GitHub answered HTTP ${res.statusCode}`));
                return;
            }
            let body = '';
            res.on('data', (c) => {
                body += c;
                if (body.length > 1 << 20) req.destroy(new Error('release response too large'));
            });
            res.on('end', () => {
                try { resolve((JSON.parse(body).tag_name || '').replace(/^v/, '')); } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
    });
}

function newerThan(a, b) { // semver-ish: is a newer than b
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
}

async function checkForUpdates(interactive) {
    try {
        const latest = await fetchLatestVersion();
        if (latest && newerThan(latest, app.getVersion())) {
            const { response } = await dialog.showMessageBox({
                type: 'info',
                message: `Totem-Flask ${latest} is available (you have ${app.getVersion()}).`,
                detail: 'Download the new DMG from the releases page and replace the app.',
                buttons: ['Open releases page', 'Later'],
            });
            if (response === 0) shell.openExternal(RELEASES_URL);
        } else if (interactive) {
            dialog.showMessageBox({ type: 'info', message: `Totem-Flask ${app.getVersion()} is up to date.` });
        }
    } catch (e) {
        if (interactive) dialog.showMessageBox({ type: 'warning', message: `Update check failed: ${e.message}` });
    }
}

function buildMenu(getWin) {
    // hide/hideOthers/unhide are macOS-only roles and Windows has no app menu,
    // so Windows gets the same items under File (keeps "Check for Updates…").
    const isMac = process.platform === 'darwin';
    const updates = { label: 'Check for Updates…', click: () => checkForUpdates(true) };
    const imp = legacyAvailable()
        ? [{ label: 'Import from Flask (desktop 1.x)…', click: () => importLegacy(getWin()) }] : [];
    const template = [
        isMac ? {
            label: app.name,
            submenu: [
                { role: 'about' }, updates, ...imp,
                { type: 'separator' },
                { id: 'hud-show-app', label: 'Show HUD', type: 'checkbox', checked: hudSettings.shown,
                    accelerator: HUD_SHORTCUT, registerAccelerator: false,
                    click: (item) => setHudShown(item.checked, getWin(), false) },
                { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        } : {
            label: '&File',
            submenu: [updates, ...imp, { type: 'separator' }, { role: 'quit' }],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        hudMenu(getWin),
        { role: 'windowMenu' },
        ...(isMac ? [] : [{ role: 'help', submenu: [{ role: 'about' }] }]),
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- start ------------------------------------------------------------------

async function start() {
    if (process.env.TOTEM_LEGACY_DUMP) return runLegacyDump(process.env.TOTEM_LEGACY_DUMP);
    // Two instances would fight over one keyboard.
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }

    await app.whenReady();
    app.setAboutPanelOptions({ applicationName: 'Totem-Flask', applicationVersion: app.getVersion() });
    let win = null;
    hudSettings = hudPrefs.load(hudPrefsFile());
    if (!process.env.FLASK_SKIP_MENU) buildMenu(() => win);
    registerAppProtocol();
    wireSecurity(session.defaultSession);
    ipcMain.handle('native-flask-running', (e) => (isAppUrl(e.senderFrame.url) ? nativeFlaskRunning() : false));
    ipcMain.handle('hud-shown', (e) => isAppUrl(e.senderFrame.url) && hudSettings.shown);
    ipcMain.on('hud-set-shown', (e, v) => { if (isAppUrl(e.senderFrame.url)) setHudShown(!!v, win, true); });
    // The popup reports its content height at the current width; fit to it.
    ipcMain.on('hud-fit', (e, h) => {
        if (!isAppUrl(e.senderFrame.url) || !hudWin || hudWin.isDestroyed() || !Number.isFinite(h)) return;
        hudWin.setSize(hudSettings.width, Math.max(60, Math.ceil(h)));
        placeHud(true);   // cornerBounds clamps a too-tall HUD to the display
    });
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
        screen.on(ev, () => placeHud(true));
    }
    if (!SMOKE) {
        const ok = globalShortcut.register(HUD_SHORTCUT, () => setHudShown(!hudSettings.shown, win, false));
        if (!ok) console.warn(`HUD shortcut ${HUD_SHORTCUT} is taken by another app`);
        app.on('will-quit', () => globalShortcut.unregisterAll());
    }

    win = new BrowserWindow({
        width: 1480,
        height: 940,
        minWidth: 640,
        minHeight: 560,
        title: 'Totem-Flask',
        backgroundColor: '#2b2b2b', // keybr Dark bg
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 14 },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
            // The HUD poll runs in this window's JS context; throttling would
            // drop it to ~1 Hz while the main window is minimized.
            backgroundThrottling: false,
        },
    });
    // Electron shows no beforeunload dialog: without this a page that cancels
    // unload (save-state.js, unsaved edits) silently ignores close/quit/reload.
    win.webContents.on('will-prevent-unload', (e) => {
        const choice = dialog.showMessageBoxSync(win, {
            type: 'warning', buttons: ['Cancel', 'Discard'], defaultId: 0, cancelId: 0,
            message: 'Discard unsaved changes?',
            detail: 'The keyboard has changes that are not saved yet.',
        });
        if (choice === 1) e.preventDefault();   // preventDefault = go ahead and unload
    });
    app.on('second-instance', () => {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    win.on('closed', () => app.quit());

    // The HUD opens `window.open('about:blank', 'flask-hud', …)`: a same-origin
    // popup, so it shares this renderer's HID/serial session (no second
    // connection). Styled as a click-through always-on-top panel (HUD overlay
    // above). Anything else is refused; plain https links go to the browser.
    win.webContents.setWindowOpenHandler(({ frameName, url }) => {
        if (frameName === 'flask-hud') return { action: 'allow', overrideBrowserWindowOptions: hudWindowOptions() };
        if (/^https:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('did-create-window', (child, details) => {
        if (details.frameName !== 'flask-hud') return;
        wireHud(child);
        child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    });
    // A reload drops the renderer's handle on the popup; don't leave it orphaned.
    win.webContents.on('did-start-loading', () => { if (hudWin && !hudWin.isDestroyed()) hudWin.close(); });

    win.loadURL(`${ORIGIN}/`);

    win.webContents.once('did-finish-load', async () => {
        if (!SMOKE && await nativeFlaskRunning()) {
            dialog.showMessageBox(win, { type: 'warning', message: 'Flask (native) is open.',
                detail: 'Close it before connecting: two editors on one keyboard interleave responses.' });
        }
        offerLegacyImport(win);
    });

    // Quiet startup update check: packaged builds only, never in smoke runs.
    if (app.isPackaged && !SMOKE) setTimeout(() => checkForUpdates(false), 4000);

    if (SMOKE) smoke(win);
}

/** Smoke mode: prove the page loads on the app origin with the device APIs
 * present, the HUD overlay opens in its corner, and nothing logs a console error. Prints probe
 * lines and exits. Never grants a device (NO_DEVICE). */
function smoke(win) {
    const errors = [];
    const note = (wc) => wc.on('console-message', (e, lvl, msg) => {
        // Electron 33: (event, level, message); newer: details object on the event. Level 3 = error.
        const level = e.level ?? lvl;
        if (level === 3 || level === 'error') errors.push(String(e.message ?? msg).slice(0, 200));
    });
    note(win.webContents);
    win.webContents.on('did-create-window', (child) => note(child.webContents));
    win.webContents.on('render-process-gone', (_e, d) => errors.push(`render-process-gone ${d.reason}`));
    win.webContents.on('did-fail-load', (_e, code, desc, u) => errors.push(`did-fail-load ${code} ${desc} ${u}`));

    win.webContents.on('did-finish-load', async () => {
        const probe = await win.webContents.executeJavaScript(
            'JSON.stringify({hid: "hid" in navigator, serial: "serial" in navigator,'
            + ' secure: isSecureContext, origin: location.origin,'
            + ' electronUA: navigator.userAgent.includes("Electron"),'
            + ' bridge: typeof window.totemFlask, title: document.title,'
            + ' scripts: document.querySelectorAll("script[src]").length})');
        // HID only: navigator.serial.getPorts() makes Chromium enumerate
        // Bluetooth serial ports (IOBluetooth), which aborts a binary whose
        // Info.plist has no NSBluetoothAlwaysUsageDescription (crash 2026-10-01).
        const devices = await win.webContents.executeJavaScript(
            'navigator.hid.getDevices().then((h) => JSON.stringify({hid: h.length}))');
        await win.webContents.executeJavaScript('localStorage.setItem("flask-smoke","1")');
        const hudOpened = await win.webContents.executeJavaScript(
            '!!window.open("about:blank", "flask-hud", "popup,width=460,height=300")');
        setTimeout(async () => {
            const hud = BrowserWindow.getAllWindows().find((w) => w !== win);
            // Corner placement on the cursor's display (12 px in).
            let corner = null;
            if (hud) {
                const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
                const nb = hud.getBounds();
                const want = hudPrefs.cornerBounds(wa, nb, hudSettings.corner);
                corner = { at: hudSettings.corner, ok: nb.x === want.x && nb.y === want.y, width: nb.width };
            }
            const hudProbe = JSON.stringify({
                opened: hudOpened,
                window: !!hud,
                alwaysOnTop: hud ? hud.isAlwaysOnTop() : false,
                panel: !!hud && usePanel,
                focusable: hud ? hud.isFocusable() : null,
                hudFocused: hud ? hud.isFocused() : null,
                title: hud ? hud.getTitle() : null,
                corner,
            });
            console.log(`FLASK_DESKTOP_SMOKE ${ORIGIN}/ ${probe}`);
            console.log(`FLASK_DESKTOP_SMOKE devices ${devices}`);
            console.log(`FLASK_DESKTOP_SMOKE hud ${hudProbe}`);
            console.log(`FLASK_DESKTOP_SMOKE console-errors ${errors.length}${errors.length ? ' ' + JSON.stringify(errors) : ''}`);
            app.exit(errors.length ? 2 : 0);
        }, 1500);
    });
    setTimeout(() => { console.error('FLASK_DESKTOP_SMOKE timeout'); app.exit(1); }, 25000);
}

start().catch((e) => {
    console.error('totem-flask failed to start:', e);
    app.exit(1);
});
