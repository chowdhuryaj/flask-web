// Minimal preload (sandboxed, contextIsolation on). Exposes one read-only
// object; the page needs no Node, no fs, no generic IPC (only the named
// channels below).
const { contextBridge, ipcRenderer } = require('electron');

let bleListener = null;     // the current bleStudio session's onEvent
ipcRenderer.on('ble-studio-event', (_e, ev) => bleListener?.(ev));

contextBridge.exposeInMainWorld('totemFlask', Object.freeze({
    desktop: true,
    /** Resolves true while the native Flask.app (com.aj.flask) is running. */
    nativeFlaskRunning: () => ipcRenderer.invoke('native-flask-running'),
    // HUD overlay (desktop/main.js owns the window, hud.js paints it).
    hudSettings: () => ipcRenderer.invoke('hud-settings'),
    setHudShown: (v) => ipcRenderer.send('hud-set-shown', !!v),
    hudFit: (h) => ipcRenderer.send('hud-fit', Number(h)),
    hudOpacity: (v) => ipcRenderer.send('hud-opacity', Number(v)),
    hudInteractive: (on) => ipcRenderer.send('hud-interactive', !!on),
    hudDrag: (kind, phase, dx, dy) => ipcRenderer.send('hud-drag', String(kind), String(phase), Number(dx), Number(dy)),
    onHudSet: (cb) => { ipcRenderer.on('hud-set', (_e, v) => cb(!!v)); },
    onHudSettings: (cb) => { ipcRenderer.on('hud-settings', (_e, s) => cb(s)); },
    // ZMK Studio over BLE through the CoreBluetooth helper (macOS only; main.js
    // bleOpen). open() starts a session and replaces the previous listener;
    // events: {type: 'ready'|'data'|'error'|'closed', ...}.
    ...(process.platform === 'darwin' ? { bleStudio: Object.freeze({
        open: (name, onEvent) => { bleListener = onEvent; ipcRenderer.send('ble-studio-open', String(name ?? '')); },
        write: (bytes) => ipcRenderer.send('ble-studio-write', Uint8Array.from(bytes)),
        close: () => { bleListener = null; ipcRenderer.send('ble-studio-close'); },
    }) } : {}),
}));

window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('totem-desktop');
});
