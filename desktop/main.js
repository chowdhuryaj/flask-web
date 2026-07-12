// Flask desktop — Electron wrapper around the flask-web configurator.
//
// Why this exists: flask-web needs WebHID (Flask tuning protocol) and
// WebSerial (ZMK Studio RPC), which only Chromium ships. This wrapper
// bundles its own Chromium so no Chrome install is needed.
//
// What it does:
//  - serves the repo root (the parent directory) over 127.0.0.1 with
//    no-cache headers, exactly like serve.py — or, if something is already
//    listening on 8137 (serve.py), just points at that so both entries see
//    the same origin;
//  - answers Chromium's HID/serial device-selection requests, which
//    Electron does not render as Chrome's picker: a single candidate is
//    auto-picked, several bring up a native chooser dialog;
//  - grants device permissions for the app origin so previously connected
//    keyboards reappear without a prompt (the page still filters to Flask
//    devices by usage page).
//
// Run: cd desktop && npm install && npm start

const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8137; // serve.py's port — shared origin keeps things consistent

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

function serveStatic(req, res) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400);
        res.end();
        return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            // Same rationale as serve.py: Chromium heuristically caches ES
            // modules aggressively; force revalidation so edits show up.
            'Cache-Control': 'no-cache, must-revalidate',
        });
        res.end(data);
    });
}

function portInUse(port) {
    return new Promise((resolve) => {
        const probe = net.connect({ port, host: '127.0.0.1' });
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
    });
}

/** Serve the app: reuse serve.py when it's already on 8137, else bind our
 * own server there (fall back to an ephemeral port if the bind races). */
async function ensureServer() {
    if (await portInUse(PORT)) {
        console.log(`flask-desktop: reusing the server already on :${PORT} (serve.py)`);
        return PORT;
    }
    const srv = http.createServer(serveStatic);
    return new Promise((resolve) => {
        srv.once('error', () => {
            srv.removeAllListeners('listening');
            srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
        });
        srv.listen(PORT, '127.0.0.1', () => resolve(PORT));
    });
}

/** Native chooser for Chromium's HID/serial selection events. One candidate
 * auto-picks; otherwise a message box lists them (first 8). Returns the
 * chosen entry or null for cancel/none. */
function pickDevice(list, kind, nameOf) {
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const names = list.slice(0, 8).map((d, i) => nameOf(d) || `${kind} device ${i + 1}`);
    const cancelId = names.length;
    const idx = dialog.showMessageBoxSync({
        type: 'question',
        title: `Select ${kind} device`,
        message: `Several ${kind} devices match — which one?`,
        buttons: [...names, 'Cancel'],
        cancelId,
    });
    return idx < names.length ? list[idx] : null;
}

function wireDeviceSelection(ses) {
    // WebHID — the Flask tuning protocol (raw HID 0xFF60/0x61).
    ses.on('select-hid-device', (event, details, callback) => {
        event.preventDefault();
        const d = pickDevice(details.deviceList, 'HID',
            (x) => x.name || `${x.vendorId?.toString(16)}:${x.productId?.toString(16)}`);
        callback(d ? d.deviceId : undefined);
    });

    // WebSerial — ZMK Studio RPC (studio-rpc-usb-uart CDC port).
    ses.on('select-serial-port', (event, portList, webContents, callback) => {
        event.preventDefault();
        const p = pickDevice(portList, 'serial',
            (x) => x.displayName || x.portName || x.portId);
        callback(p ? p.portId : '');
    });

    // Local single-user tool: allow the web-device APIs outright, and
    // auto-grant device-level permission so already-known keyboards show
    // up via navigator.hid.getDevices() without a chooser round-trip.
    ses.setPermissionCheckHandler(() => true);
    ses.setPermissionRequestHandler((wc, permission, callback) => callback(true));
    ses.setDevicePermissionHandler(() => true);
}

async function start() {
    await app.whenReady();

    wireDeviceSelection(session.defaultSession);

    const port = await ensureServer();
    const url = `http://localhost:${port}/`;

    const win = new BrowserWindow({
        width: 1480,
        height: 940,
        title: 'Flask',
        backgroundColor: '#1a1a1a',
    });

    // The HUD opens `window.open('about:blank', 'flask-hud', …)` here
    // (Document PiP's requestWindow never settles under Electron). Style
    // that popup into what Chrome's PiP window gives for free: frameless,
    // always-on-top, resizable, out of the Dock/taskbar. Size/position come
    // from the renderer's window features (it persists the last frame).
    win.webContents.setWindowOpenHandler(({ frameName }) => {
        if (frameName === 'flask-hud') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    frame: false,
                    alwaysOnTop: true,
                    resizable: true,
                    minimizable: false,
                    maximizable: false,
                    fullscreenable: false,
                    skipTaskbar: true,
                    title: 'Flask HUD',
                    backgroundColor: '#1a1a1a',
                },
            };
        }
        return { action: 'allow' };
    });
    win.webContents.on('did-create-window', (child, details) => {
        if (details.frameName !== 'flask-hud') return;
        // Float above fullscreen apps and follow across Spaces — the two
        // Chrome-PiP behaviors a plain alwaysOnTop flag doesn't cover.
        child.setAlwaysOnTop(true, 'floating');
        child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    });

    win.loadURL(url);

    // Smoke mode (FLASK_DESKTOP_SMOKE=1): prove the page loads with the
    // device APIs present, print a line, and exit — used by scripted tests.
    if (process.env.FLASK_DESKTOP_SMOKE) {
        win.webContents.on('did-finish-load', async () => {
            const probe = await win.webContents.executeJavaScript(
                'JSON.stringify({hid: "hid" in navigator, serial: "serial" in navigator,'
                + ' electronUA: navigator.userAgent.includes("Electron"),'   // HUD opens a popup on this
                + ' title: document.title})');
            // Prove the HUD window path: open the named popup the HUD uses
            // and confirm the window-open handler styled it always-on-top.
            const hudOpened = await win.webContents.executeJavaScript(
                '!!window.open("about:blank", "flask-hud", "popup,width=120,height=90")');
            setTimeout(() => {
                const hud = BrowserWindow.getAllWindows().find((w) => w !== win);
                const hudProbe = JSON.stringify({
                    opened: hudOpened,
                    window: !!hud,
                    alwaysOnTop: hud ? hud.isAlwaysOnTop() : false,
                });
                console.log(`FLASK_DESKTOP_SMOKE ${url} ${probe}`);
                console.log(`FLASK_DESKTOP_SMOKE hud ${hudProbe}`);
                app.quit();
            }, 400);
        });
        setTimeout(() => { console.error('FLASK_DESKTOP_SMOKE timeout'); app.exit(1); }, 20000);
    }
}

app.on('window-all-closed', () => app.quit());

start().catch((e) => {
    console.error('flask-desktop failed to start:', e);
    app.exit(1);
});
