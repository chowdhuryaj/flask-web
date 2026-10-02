// Minimal preload (sandboxed, contextIsolation on). Exposes one read-only
// object; the page needs no Node, no fs, no generic IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('totemFlask', Object.freeze({
    desktop: true,
    /** Resolves true while the native Flask.app (com.aj.flask) is running. */
    nativeFlaskRunning: () => ipcRenderer.invoke('native-flask-running'),
}));

window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('totem-desktop');
});
