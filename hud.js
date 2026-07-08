// HUD: live layer + keymap + pressed keys, floating over other apps via
// Document Picture-in-Picture (Chromium 116+), with an in-page draggable
// corner-snapping overlay as fallback. Port of AdeptCompanion
// HUDWindow.swift (poll cadences preserved: ~15 Hz layer/matrix, OLED
// mirror every 4th tick).

import { el } from './ui.js?v=4';
import { CH, V, NLKB } from './flaskproto.js?v=4';
import { renderKeyboardSVG } from './keymap-tab.js?v=4';

const SNAP = 32;   // px — snap-to-corner distance (HUDController parity)
const MARGIN = 12;

export class HUD {
    constructor(app) {
        this.app = app;      // { hid, flask, vial, profile, caps, keymap, layerCount, unlocked }
        this.open = false;
        this.win = null;     // PiP Window or null (fallback overlay)
        this.overlay = null;
        this.shownLayer = 0; // peeked layer (click on strip)
        this.liveLayer = 0;
        this.peek = false;
        this.pressed = new Set();
        this._timer = null;
        this._tick = 0;
        this._busy = false;
        this.oledLines = null;
    }

    async toggle() {
        if (this.open) { this.close(); return; }
        this.open = true;
        this.rootEl = this._buildRoot();
        if ('documentPictureInPicture' in window) {
            try {
                this.win = await documentPictureInPicture.requestWindow({ width: 460, height: 300 });
                // One linked stylesheet → one clone (styles.css is deliberately the only sheet).
                for (const sheet of document.styleSheets) {
                    if (sheet.href) {
                        const link = this.win.document.createElement('link');
                        link.rel = 'stylesheet';
                        link.href = sheet.href;
                        this.win.document.head.append(link);
                    } else if (sheet.ownerNode) {
                        this.win.document.head.append(sheet.ownerNode.cloneNode(true));
                    }
                }
                // Mirror any theme vars pinned on the main document root.
                this.win.document.documentElement.style.cssText =
                    document.documentElement.style.cssText;
                this.win.document.body.className = 'hud-pip';
                this.win.document.body.append(this.rootEl);
                this.win.addEventListener('pagehide', () => { if (this.open) this.close(); });
            } catch {
                this.win = null;
            }
        }
        if (!this.win) this._openOverlay();
        this._startPoll();
        this.render();
    }

    close() {
        this.open = false;
        clearInterval(this._timer);
        this._timer = null;
        try { this.win?.close(); } catch { /* already closed */ }
        this.win = null;
        this.overlay?.remove();
        this.overlay = null;
    }

    // ---------- fallback overlay (drag + corner snap, frame persisted) ----------

    _openOverlay() {
        this.overlay = el('div', { class: 'hud-overlay' }, this.rootEl);
        const saved = JSON.parse(localStorage.getItem('flask-hud-frame') || 'null');
        this.overlay.style.left = (saved?.x ?? window.innerWidth - 480) + 'px';
        this.overlay.style.top = (saved?.y ?? MARGIN) + 'px';
        document.body.append(this.overlay);

        let drag = null;
        this.overlay.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            drag = { dx: e.clientX - this.overlay.offsetLeft, dy: e.clientY - this.overlay.offsetTop };
            this.overlay.setPointerCapture(e.pointerId);
        });
        this.overlay.addEventListener('pointermove', (e) => {
            if (!drag) return;
            this.overlay.style.left = (e.clientX - drag.dx) + 'px';
            this.overlay.style.top = (e.clientY - drag.dy) + 'px';
        });
        this.overlay.addEventListener('pointerup', () => {
            if (!drag) return;
            drag = null;
            // Snap to the nearest screen corner when close (HUDController parity).
            const r = this.overlay.getBoundingClientRect();
            let x = r.left, y = r.top;
            if (x < SNAP + MARGIN) x = MARGIN;
            if (y < SNAP + MARGIN) y = MARGIN;
            if (window.innerWidth - r.right < SNAP + MARGIN) x = window.innerWidth - r.width - MARGIN;
            if (window.innerHeight - r.bottom < SNAP + MARGIN) y = window.innerHeight - r.height - MARGIN;
            this.overlay.style.left = x + 'px';
            this.overlay.style.top = y + 'px';
            localStorage.setItem('flask-hud-frame', JSON.stringify({ x, y }));
        });
    }

    // ---------- polling ----------

    _startPoll() {
        // ~15 Hz, skipping ticks while the previous one is still queued;
        // backs off entirely while hid.paused (bulk transfers, unlock).
        this._timer = setInterval(() => this._pollTick(), 66);
    }

    async _pollTick() {
        const { app } = this;
        if (this._busy || !this.open || app.hid.paused || !app.hid.connected) return;
        this._busy = true;
        try {
            if (app.caps.hudLayer) {
                const layer = await app.flask.getU16(CH.meta, V.metaActiveLayer);
                if (layer !== this.liveLayer) {
                    this.liveLayer = layer;
                    if (!this.peek) this.shownLayer = layer;
                    this.render();
                }
            }
            if (app.unlocked) {
                const rows = await app.vial.matrixState(app.profile.matrixRows, app.profile.matrixCols);
                const next = new Set();
                rows.forEach((bits, row) => {
                    for (let col = 0; col < app.profile.matrixCols; col++) {
                        if ((bits >> BigInt(col)) & 1n) next.add(`${row},${col}`);
                    }
                });
                this._applyPressed(next);
            } else if (app.readKeyState) {
                // Non-Vial press feed (ZMK key-state bitmap) — no unlock
                // concept, polled whenever the device offers it.
                this._applyPressed(await app.readKeyState());
            }
            // NLKB16 OLED mirror at ~4 Hz (every 4th tick).
            if (app.caps.displayMirror && (this._tick++ % 4) === 0) {
                const lines = [];
                for (let line = 0; line < NLKB.bigLines; line++) {
                    const r = await app.flask.getBytes(CH.display, V.dispLine, [line]);
                    // [line, invert mask, 5 chars, panel_on]
                    lines.push({
                        invert: r[1],
                        text: String.fromCharCode(...r.slice(2, 2 + NLKB.visibleCols)),
                        panelOn: r[7] !== 0,
                    });
                }
                this.oledLines = lines;
                this.renderOled();
            }
        } catch (e) {
            // Transient — next tick retries. But log each DISTINCT failure
            // once: a silently-swallowed permanent error looks like a frozen
            // HUD (bench 2026-07-08: "layer stopped updating" was
            // undiagnosable without this).
            if (e?.message !== this._lastPollErr) {
                this._lastPollErr = e?.message;
                console.warn('HUD poll error (retrying):', e);
            }
        }
        this._busy = false;
    }

    _applyPressed(next) {
        if (next.size !== this.pressed.size || [...next].some((k) => !this.pressed.has(k))) {
            this.pressed = next;
            this.render();
        }
    }

    // ---------- rendering ----------

    _buildRoot() {
        this.stripEl = el('div', { class: 'layer-strip' });
        this.boardEl = el('div', { class: 'kb-wrap' });
        this.oledEl = el('div', { class: 'mono', style: 'margin-top:4px' });
        this.lockEl = el('button', { class: 'btn small' });
        this.hintEl = el('span', { class: 'hint' });
        this.lockEl.addEventListener('click', () => this.app.onHudLockClick?.());
        return el('div', { class: 'hud' },
            el('div', { class: 'hud-top' },
                el('span', { class: 'pill connected' }, el('span', { class: 'dot' }), this.app.profile.name),
                el('span', { style: 'flex:1' }),
                this.lockEl,
                el('button', { class: 'btn small', text: '✕', onclick: () => this.close() })),
            this.stripEl, this.boardEl, this.oledEl, this.hintEl);
    }

    render() {
        if (!this.open) return;
        const { app } = this;
        this.stripEl.replaceChildren(...app.profile.layerNames.slice(0, app.layerCount).map((name, i) =>
            el('button', {
                class: (i === this.shownLayer ? 'shown ' : '') + (i === this.liveLayer ? 'live' : ''),
                text: name,
                onclick: () => {
                    this.peek = i !== this.liveLayer;
                    this.shownLayer = i;
                    this.render();
                },
            })));
        this.boardEl.replaceChildren(renderKeyboardSVG({
            profile: app.profile,
            keycodeAt: (row, col) => app.keymap?.[this.shownLayer]?.[row]?.[col] ?? 0,
            encoderAt: null,
            pressed: this.pressed,
            scale: 0.62,
        }));
        // Pressed-key display rides the Vial matrix-state read — devices
        // without a Vial surface (caps.vial false) have no unlock and no
        // matrix poll, so the button and its hint would only mislead.
        if (app.caps.vial) {
            this.lockEl.style.display = '';
            this.lockEl.textContent = app.unlocked ? '🔓 Lock' : '🔒 Unlock';
            this.hintEl.textContent = app.unlocked
                ? (app.caps.hudLayer ? 'Live: layer follows the board; keys light on press.' : 'Keys light on press.')
                : 'Unlock to see live key presses.';
        } else {
            this.lockEl.style.display = 'none';
            this.hintEl.textContent = app.readKeyState
                ? 'Live: layer follows the board; keys light on press.'
                : (app.caps.hudLayer ? 'Live: layer follows the board.' : '');
        }
    }

    renderOled() {
        if (!this.oledLines) return;
        this.oledEl.replaceChildren(
            el('span', { class: 'faint', text: this.oledLines[0]?.panelOn === false ? 'OLED 🌙 ' : 'OLED ' }),
            ...this.oledLines.map((l) => el('span', {
                style: l.invert ? 'background:var(--text); color:var(--bg); margin-right:6px' : 'margin-right:6px',
                text: l.text,
            })));
    }
}
