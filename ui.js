// Tiny DOM factories + shared widgets. Pattern lifted from AlooMapper
// (hid-remapper config-tool-vial vial.js) — no framework, direct DOM.

export function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (v === true) e.setAttribute(k, '');
        else if (v !== false) e.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) {
        if (kid == null) continue;
        e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
}

export function svgEl(tag, attrs, ...kids) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === 'class') e.setAttribute('class', v);
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
}

// ---------- toast ----------

let toastTimer = null;
export function toast(msg, isError = false) {
    document.querySelector('.toast')?.remove();
    const t = el('div', { class: 'toast' + (isError ? ' error' : ''), text: msg });
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), isError ? 5000 : 2200);
}

// ---------- modal ----------

export function modal(title, body, buttons) {
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: 'modal' }, el('h2', { text: title }), body);
    if (buttons?.length) {
        box.append(el('div', { class: 'savebar' }, ...buttons));
    }
    back.append(box);
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.body.append(back);
    return back;
}

/** Inline-renameable label: click to edit, commits EXACTLY once on
 * Enter/blur, Escape cancels. The commit-once guard is load-bearing:
 * Enter's re-render detaches the input, whose blur re-fires the commit
 * mid-render (the bench-3 layer-rename toast). `placeholder` is the
 * default label; committing an empty value means "clear the custom name". */
export function renameLabel({ text, placeholder, title = 'click to rename', onCommit }) {
    const b = el('b', { text, title, style: 'cursor: text' });
    b.addEventListener('click', () => {
        const input = el('input', {
            type: 'text', placeholder,
            value: text === placeholder ? '' : text,
        });
        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            onCommit(input.value.trim());
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { committed = true; input.replaceWith(b); }
        });
        input.addEventListener('blur', commit);
        b.replaceWith(input);
        input.focus();
        input.select();
    });
    return b;
}

// ---------- tuning widgets ----------

/**
 * Slider row bound to a firmware value. onChange(value) must return the value
 * the firmware ECHOED (it clamps); the control adopts that echo — never its
 * own value. Same hard-won rule as the Swift app (AdeptProtocol clamp-echo).
 *
 * opts: { label, hint, min, max, step, value, format, onChange }
 */
export function sliderRow(opts) {
    const fmt = opts.format || ((v) => String(v));
    const valEl = el('span', { class: 'val', text: fmt(opts.value) });
    const input = el('input', {
        type: 'range', min: opts.min, max: opts.max, step: opts.step || 1,
        value: opts.value,
    });
    let pendingWrite = null;
    input.addEventListener('input', () => {
        valEl.textContent = fmt(Number(input.value));
        // Debounce drags — one in-flight write, the latest value wins.
        if (pendingWrite) return;
        pendingWrite = (async () => {
            await new Promise((r) => setTimeout(r, 60));
            pendingWrite = null;
            const v = Number(input.value);
            try {
                const echoed = await opts.onChange(v);
                if (echoed != null && echoed !== v && !pendingWrite) {
                    input.value = echoed;
                    valEl.textContent = fmt(echoed);
                }
            } catch (e) {
                toast(`Write failed: ${e.message}`, true);
            }
        })();
    });
    const row = el('div', { class: 'row' },
        el('span', { class: 'lbl' }, opts.label,
            opts.hint ? el('span', { class: 'hint', text: opts.hint }) : null),
        input, valEl);
    row.update = (v) => { input.value = v; valEl.textContent = fmt(v); };
    return row;
}

/** Toggle row. onChange(bool) → echoed bool (or throws). */
export function toggleRow(opts) {
    const btn = el('button', { class: 'toggle' + (opts.value ? ' on' : ''), role: 'switch' });
    btn.addEventListener('click', async () => {
        const want = !btn.classList.contains('on');
        try {
            const echoed = await opts.onChange(want);
            btn.classList.toggle('on', echoed == null ? want : !!echoed);
        } catch (e) {
            toast(`Write failed: ${e.message}`, true);
        }
    });
    const row = el('div', { class: 'row' },
        el('span', { class: 'lbl' }, opts.label,
            opts.hint ? el('span', { class: 'hint', text: opts.hint }) : null),
        el('span', { style: 'flex:1' }), btn);
    row.update = (v) => btn.classList.toggle('on', !!v);
    return row;
}

/** Select row. onChange(value) async. options = [{value, label}] */
export function selectRow(opts) {
    const sel = el('select', {},
        ...opts.options.map((o) => el('option', { value: o.value, text: o.label })));
    sel.value = String(opts.value);
    sel.addEventListener('change', async () => {
        try { await opts.onChange(sel.value); }
        catch (e) { toast(`Write failed: ${e.message}`, true); }
    });
    const row = el('div', { class: 'row' },
        el('span', { class: 'lbl' }, opts.label,
            opts.hint ? el('span', { class: 'hint', text: opts.hint }) : null),
        el('span', { style: 'flex:1' }), sel);
    row.update = (v) => { sel.value = String(v); };
    return row;
}

/** The app's central concept, said one way everywhere: an edit is LIVE on the
 * device the moment you make it, and only a Save survives power-off.
 * `null` is the honest default — at load we know edits apply live, but NOT
 * whether flash currently matches the screen, so the bar claims neither. */
export const SAVE_STATE = {
    null: 'Edits apply live — Save to keep them',
    live: 'Live — reverts on power-off',
    saved: 'Saved to keyboard',
};

/** Per-channel Save bar: snapshots live values into the firmware EEPROM.
 * The dot + label is the canonical live/saved vocabulary (same dot language as
 * the header's connection pill) — pass `note` only for context the dot cannot
 * carry, never to restate live-vs-saved. Call `bar.setState('live'|'saved')`
 * from tabs that actually track dirtiness; tabs that don't stay on the neutral
 * default rather than asserting something they haven't checked. */
export function saveBar(onSave, note) {
    const btn = el('button', { class: 'btn small', text: 'Save to keyboard' });
    const state = el('span', { class: 'state', text: SAVE_STATE.null });
    const bar = el('div', { class: 'savebar' }, btn, state);
    if (note) bar.append(el('span', { class: 'note', text: note }));

    bar.setState = (s) => {
        if (s) bar.dataset.state = s; else delete bar.dataset.state;
        state.textContent = SAVE_STATE[s] || SAVE_STATE.null;
    };
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await onSave(); toast('Saved'); bar.setState('saved'); }
        catch (e) { toast(`Save failed: ${e.message}`, true); }
        btn.disabled = false;
    });
    return bar;
}

export function card(title, sub, ...kids) {
    const h = el('h3', { text: title });
    if (sub) h.append(el('span', { class: 'sub', text: sub }));
    return el('div', { class: 'card' }, h, ...kids);
}
