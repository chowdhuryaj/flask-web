// Minimal preload (sandboxed, contextIsolation on). Exposes one read-only
// object; the page needs no Node, no fs, no generic IPC (only the named
// channels below).
const { contextBridge, ipcRenderer } = require('electron');

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
}));

window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('totem-desktop');
});
