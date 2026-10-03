// Minimal preload (sandboxed, contextIsolation on). Exposes one read-only
// object; the page needs no Node, no fs, no generic IPC (only the named
// channels below).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('totemFlask', Object.freeze({
    desktop: true,
    /** Resolves true while the native Flask.app (com.aj.flask) is running. */
    nativeFlaskRunning: () => ipcRenderer.invoke('native-flask-running'),
    // HUD overlay (desktop/main.js owns the window, hud.js paints it).
    hudShown: () => ipcRenderer.invoke('hud-shown'),
    setHudShown: (v) => ipcRenderer.send('hud-set-shown', !!v),
    hudFit: (h) => ipcRenderer.send('hud-fit', Number(h)),
    onHudSet: (cb) => { ipcRenderer.on('hud-set', (_e, v) => cb(!!v)); },
}));

window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('totem-desktop');
});
