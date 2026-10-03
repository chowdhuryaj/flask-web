// HUD: live layer + keymap + pressed keys, floating over other apps. In the
// Totem-Flask desktop app it is a click-through always-on-top popup that
// desktop/main.js pins to a corner of the cursor's display; in a browser,
// Document Picture-in-Picture (Chromium 116+), with an in-page draggable
// corner-snapping overlay as fallback. Poll cadences: ~15 Hz layer + key
// state, status chips every 4th tick. All data comes over the page's own
// device connection; the popup never opens one.

import { el } from './ui.js?v=73';
import { CH, V } from './flaskproto.js?v=73';
import { renderKeyboardSVG } from './board.js?v=73';
import { appearance } from './themes.js?v=73';

const SNAP = 32;   // px — snap-to-corner distance (HUDController parity)
const MARGIN = 12;

export class HUD {
    constructor(app) {
        this.app = app;      // { hid, flask, profile, caps, keymap, layerCount, readKeyState }
        appearance.addEventListener('appearance', () => this._syncTheme());
        // Desktop app: HUD settings (shown, opacity, …) live in the main
        // process; mirror them for the toolbar slider and the header button.
        this.desk = null;
        this.onChange = null;   // main.js: repaint the header toggle
        const tf = window.totemFlask;
        if (tf?.hudSettings) {
            const take = (st) => {
                this.desk = st;
                if (this.opacityEl && st) this.opacityEl.value = String(Math.round(st.opacity * 100));
                this.onChange?.();
            };
            tf.hudSettings().then(take, () => {});
            tf.onHudSettings?.(take);
        }
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
    }

    /** User toggle (Pop out, palette): also remembered by the desktop app. */
    async toggle() {
        await this.setOpen(!this.open);
        window.totemFlask?.setHudShown?.(this.open);
        this.onChange?.();
    }

    async setOpen(v) {
        if (v === this.open) return;
        if (!v) { this.close(); return; }
        this.open = true;
        this.rootEl = this._buildRoot();
        // Document PiP needs real browser UI. Electron exposes the global
        // but requestWindow never settles — the await hung forever and the
        // HUD "did not even open" (bench 2026-07-12). There the HUD opens a
        // plain named popup instead; desktop/main.js's window-open handler
        // styles it frameless + always-on-top + resizable (the Chrome-PiP
        // feel, bench 5 ask). The in-page overlay stays the last fallback.
        if (navigator.userAgent.includes('Electron')) {
            try {
                // Frame (size, corner, display, opacity) is owned by the
                // main process; these features are placeholders.
                const feats = 'popup,width=460,height=300';
                const w = window.open('about:blank', 'flask-hud', feats);
                if (w) {
                    this.win = w;
                    this._electronWin = true;
                    this._dressWindow(w);
                    w.document.title = 'Totem-Flask HUD';
                    // Click-through overlay: compact look (css/hud.css), and
                    // the window height follows the content at its width.
                    w.document.body.classList.add('hud-electron');
                    this._buildBar(w);
                    this._fit = new w.ResizeObserver(() =>
                        window.totemFlask?.hudFit?.(this.rootEl.getBoundingClientRect().height));
                    this._fit.observe(this.rootEl);
                }
            } catch {
                this.win = null;
                this._electronWin = false;
            }
        } else if ('documentPictureInPicture' in window) {
            try {
                const req = documentPictureInPicture.requestWindow({ width: 460, height: 300 });
                this.win = await Promise.race([
                    req,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('PiP timeout')), 1500)),
                ]);
                // If the request settles late after the timeout won, close
                // the stray window instead of leaking it.
                req.then((w) => { if (this.win !== w) { try { w.close(); } catch { /* gone */ } } },
                    () => {});
                this._dressWindow(this.win);
            } catch {
                this.win = null;
            }
        }
        if (!this.win) this._openOverlay();
        this._startPoll();
        this.render();
    }

    /** Clone the app's styles + theme into a bare window (PiP or Electron
     * popup) and move the HUD root in. */
    _dressWindow(win) {
        // One linked stylesheet → one clone (styles.css is deliberately the only sheet).
        for (const sheet of document.styleSheets) {
            if (sheet.href) {
                const link = win.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = sheet.href;
                win.document.head.append(link);
            } else if (sheet.ownerNode) {
                win.document.head.append(sheet.ownerNode.cloneNode(true));
            }
        }
        this._syncTheme();
        win.document.body.className = 'hud-pip';
        win.document.body.append(this.rootEl);
        win.addEventListener('pagehide', () => { if (this.open) this.close(); });
    }

    /** Desktop overlay chrome. The window ignores the mouse except over the
     * toolbar (drag to move, opacity slider, hide) and the corner grip
     * (resize); both appear only while the pointer is over the HUD, which
     * the forwarded mouse moves tell us. Move/resize run in the main process
     * (hud-drag), fed screen deltas from here. */
    _buildBar(w) {
        const tf = window.totemFlask;
        const body = w.document.body;
        let dragging = false;
        const hot = (node) => {
            node.addEventListener('mouseenter', () => tf.hudInteractive(true));
            node.addEventListener('mouseleave', () => { if (!dragging) tf.hudInteractive(false); });
            return node;
        };
        const draggable = (node, kind) => node.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('input, button')) return;
            e.preventDefault();
            dragging = true;
            const x0 = e.screenX, y0 = e.screenY;
            node.setPointerCapture(e.pointerId);
            tf.hudDrag(kind, 'start', 0, 0);
            const move = (ev) => tf.hudDrag(kind, 'move', ev.screenX - x0, ev.screenY - y0);
            const up = (ev) => {
                node.removeEventListener('pointermove', move);
                node.removeEventListener('pointerup', up);
                node.removeEventListener('pointercancel', up);
                dragging = false;
                tf.hudDrag(kind, 'end', ev.screenX - x0, ev.screenY - y0);
                if (!node.matches(':hover')) tf.hudInteractive(false);   // main keeps an unlocked HUD live
            };
            node.addEventListener('pointermove', move);
            node.addEventListener('pointerup', up);
            node.addEventListener('pointercancel', up);
        });
        this.opacityEl = el('input', {
            type: 'range', min: 30, max: 100, step: 5, 'aria-label': 'HUD opacity', title: 'Opacity',
            value: String(Math.round((this.desk?.opacity ?? 0.85) * 100)),
            oninput: (e) => tf.hudOpacity(Number(e.target.value) / 100),
        });
        const bar = hot(el('div', { class: 'hud-bar', title: 'Drag to move' },
            el('span', { class: 'hud-grip', text: '⠿' }),
            el('span', { style: 'flex:1' }),
            this.opacityEl,
            el('button', { class: 'hud-x', text: '✕', title: 'Hide HUD (Ctrl+Opt+Cmd+K)', onclick: () => this.toggle() })));
        const grip = hot(el('div', { class: 'hud-resize', title: 'Drag to resize' }));
        draggable(bar, 'move');
        draggable(grip, 'resize');
        this.rootEl.prepend(bar);
        this.rootEl.append(grip);
        const root = w.document.documentElement;
        root.addEventListener('mouseenter', () => body.classList.add('hud-hover'));
        root.addEventListener('mouseleave', () => { if (!dragging) body.classList.remove('hud-hover'); });
    }

    /** Mirror the theme vars + mode pinned on the main document root. */
    _syncTheme() {
        const root = this.win?.document?.documentElement;
        if (!root) return;
        root.style.cssText = document.documentElement.style.cssText;
        if (document.documentElement.dataset.theme) root.dataset.theme = document.documentElement.dataset.theme;
    }

    close() {
        this.open = false;
        this.opacityEl = null;
        this._fit?.disconnect();
        this._fit = null;
        clearInterval(this._timer);
        this._timer = null;
        try { this.win?.close(); } catch { /* already closed */ }
        this.win = null;
        this._electronWin = false;
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
        // backs off entirely while hid.paused (bulk transfers).
        this._timer = setInterval(() => this._pollTick(), 66);
    }

    async _pollTick() {
        const { app } = this;
        if (this._busy || !this.open || app.hid.paused || !app.hid.connected) return;
        this._busy = true;
        let dirty = false;
        try {
            // Key bitmap first: a layer change needs a key press or release, so
            // the layer GET only follows a changed bitmap, plus once a second
            // for timed changes (one-shot, combo, tap dance). Halves the wire.
            let changed = true;
            if (app.readKeyState) {
                // ZMK key-state bitmap, polled whenever the device offers it.
                const next = await app.readKeyState();
                changed = this._pressedDiffers(next);
                if (changed) { this.pressed = next; dirty = true; }
            }
            const now = performance.now();
            if (app.caps.hudLayer && (changed || now - (this._layerAt ?? 0) >= 1000)) {
                this._layerAt = now;
                const layer = await app.flask.getU16(CH.meta, V.metaActiveLayer);
                if (layer !== this.liveLayer) {
                    this.liveLayer = layer;
                    if (!this.peek) this.shownLayer = layer;
                    dirty = true;
                }
            }
            if (dirty) this.render();
            const tick = this._tick++;
            // Live-action chips at ~4 Hz (every 4th tick, cheap GETs):
            // autoscroll level (0x1A/0x05 signed)
            // and flask_macros playback (0x25/0x06, ZMK line).
            if ((tick % 4) === 1 && (app.caps.autoscroll || app.caps.macros || app.caps.ballSwap)) {
                const status = {};
                if (app.caps.autoscroll) {
                    status.autoscroll = await app.flask.getI16(CH.autoscroll, V.asState);
                }
                if (app.caps.macros) {
                    status.macro = await app.flask.getU16(CH.macros, V.macrosState);
                }
                if (app.caps.ballSwap) {
                    status.bswap = await app.flask.getU16(CH.ballSwap, V.bswapEffective);
                }
                if (JSON.stringify(status) !== JSON.stringify(this._liveStatus)) {
                    this._liveStatus = status;
                    this.renderStatus();
                }
            }
        } catch (e) {
            if (dirty) this.render();   // bitmap already swapped in; don't lose the repaint
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

    _pressedDiffers(next) {
        return next.size !== this.pressed.size || [...next].some((k) => !this.pressed.has(k));
    }

    // ---------- rendering ----------

    _buildRoot() {
        this.stripEl = el('div', { class: 'layer-strip' });
        this.boardEl = el('div', { class: 'kb-wrap' });
        this.statusEl = el('div', { style: 'display:flex; gap:6px; margin-top:2px; min-height:0' });
        this.hintEl = el('span', { class: 'hint' });
        return el('div', { class: 'hud' },
            el('div', { class: 'hud-top' },
                el('span', { class: 'pill connected' }, el('span', { class: 'dot' }), this.app.profile.name),
                el('span', { style: 'flex:1' }),
                el('button', { class: 'btn small', text: '✕', onclick: () => this.close() })),
            this.stripEl, this.boardEl, this.statusEl, this.hintEl);
    }

    /** Live-action chips: what the firmware is DOING right now (autoscroll
     * level, macro playback). Empty div when idle. */
    renderStatus() {
        const s = this._liveStatus ?? {};
        const chips = [];
        if (s.autoscroll) {
            const dir = s.autoscroll > 0 ? '▼' : '▲';
            chips.push(el('span', { class: 'pill',
                text: `${dir} autoscroll ${Math.abs(s.autoscroll)}` }));
        }
        if (s.macro) {
            chips.push(el('span', { class: 'pill',
                text: `▶ macro ${s.macro - 1} playing` }));
        }
        if (s.bswap) {
            chips.push(el('span', { class: 'pill',
                text: '🖲 balls swapped' }));
        }
        this.statusEl.replaceChildren(...chips);
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
            pressed: this.pressed,
            // Mirror the flask_rgb painted map (ZMK line; published by the
            // RGB tab). Pressed keys keep the press highlight — an inline
            // fill would override the .pressed class. Hardened: a tint
            // throw must never take the whole HUD render down (a dead
            // render reads as "HUD frozen" on the bench).
            fillFor: app.zmkRgbTint
                ? (key) => {
                    if (this.pressed.has(`${key.row},${key.col}`)) return null;
                    try { return app.zmkRgbTint(this.shownLayer, key); }
                    catch { return null; }
                }
                : undefined,
            scale: 0.62,
        }));
        this.hintEl.textContent = app.readKeyState
            ? 'Live: layer follows the board; keys light on press.'
            : (app.caps.hudLayer ? 'Live: layer follows the board.' : '');
    }
}
