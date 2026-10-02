// Caption bar plumbing (spec §2.6, native CaptionBus). Any element with
// data-caption="…" puts its text in the palette's caption bar while hovered
// or focused; leaving it restores the group's default line.
//
// Contract (stable for Phase 1):
//   installCaptions(root = document)   once; event delegation, no per-node wiring
//   bindCaptionBar(el)                 the element whose text shows the caption
//   setCaption(text | null)            show text; null = back to the default
//   setCaptionGroup(groupId)           default line follows the active group
//   CAPTION_DEFAULTS                   {keys, behaviour, device, trainer}
// Until WP1 binds a bar, setCaption only records the text (no DOM effect).

export const CAPTION_DEFAULTS = {
    keys: 'Select a key on the keyboard, then click a key here to assign it — the selection auto-advances.',
    behaviour: 'Click a tile to put it on the selected key · the pencil edits it.',
    // Behaviour tabs without tiles (Chords, Leader, Hold timing, ZMK Combos…).
    behaviourEdit: 'Changes apply live · Save in the status bar keeps them.',
    device: 'Changes apply live · Save in the status bar keeps them.',
    trainer: '',
};

let bar = null;
let group = 'keys';
let current = null;

const render = () => { if (bar) bar.textContent = current ?? CAPTION_DEFAULTS[group] ?? ''; };

export function bindCaptionBar(el) { bar = el; render(); }
export function setCaption(text) { current = text || null; render(); }
export function setCaptionGroup(id) { group = id; render(); }
export function currentCaption() { return current ?? CAPTION_DEFAULTS[group] ?? ''; }

export function installCaptions(root = document) {
    const enter = (e) => {
        const t = e.target.closest?.('[data-caption]');
        if (t) setCaption(t.dataset.caption);
    };
    const leave = (e) => {
        const from = e.target.closest?.('[data-caption]');
        const to = e.relatedTarget?.closest?.('[data-caption]');
        if (from && from !== to) setCaption(to?.dataset.caption ?? null);
    };
    root.addEventListener('pointerover', enter);
    root.addEventListener('focusin', enter);
    root.addEventListener('pointerout', leave);
    root.addEventListener('focusout', leave);
}
