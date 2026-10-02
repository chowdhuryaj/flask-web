// WP1 shell: every pre-change tab id maps to a group, themes/appearance
// settings clamp and persist, caption bar plumbing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Minimal DOM/localStorage so themes.js and caption.js run under node.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const rootVars = new Map();
globalThis.document = { documentElement: { style: {
    setProperty: (k, v) => rootVars.set(k, v), removeProperty: (k) => rootVars.delete(k) } } };

const { THEMES, DEFAULT_THEME, applyTheme, currentTheme, applyTextScale, currentTextScale,
        applyBoardZoom, currentBoardZoom, TEXT_SCALE, BOARD_ZOOM } = await import('../themes.js?v=61');
const { bindCaptionBar, setCaption, setCaptionGroup, currentCaption, CAPTION_DEFAULTS } = await import('../caption.js?v=61');
const { TAB_TABLE, TAB_GROUPS, groupOf } = await import('../tab-registry.js?v=61');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };

// ---- navigation: every id in the pre-redesign snapshot has a group ----
const before = JSON.parse(readFileSync(new URL('./fixtures/tabs-before-wp0.json', import.meta.url)));
const groups = new Set(TAB_GROUPS.map((g) => g.id));
for (const [ws, tabs] of Object.entries(before)) {
    if (ws.includes('@') || !Array.isArray(tabs)) continue;
    for (const [id] of tabs) ok(groups.has(groupOf(id)) && TAB_TABLE.some((t) => t.id === id), `${ws}/${id}`);
}
eq(TAB_GROUPS.map((g) => g.id).join(), 'keys,behaviour,device,trainer', 'group order');
// Native-only tools never get a row (AJ Q1/Q2).
for (const id of ['gmk70', 'build', 'bench', 'bake', 'tap-calibrator', 'teleport']) ok(!TAB_TABLE.some((t) => t.id === id), id);
eq(groupOf('keyboard'), 'device', 'keyboard tab group');

// ---- themes ----
eq(DEFAULT_THEME, 'keybrDark', 'default theme');
eq(currentTheme(), 'keybrDark', 'unset storage → default');
eq(THEMES.keybrDark.vars.bg, '#2b2b2b', 'keybr Dark bg (spec §2.1)');
eq(THEMES.keybrDark.vars.accent, '#867f7f', 'keybr Dark accent');
applyTheme('nord');
eq(currentTheme(), 'nord'); eq(rootVars.get('--bg'), '#2e3440', 'nord pinned');
applyTheme('classic');
ok(!rootVars.has('--bg'), 'classic clears pinned vars');
applyTheme('nope');
eq(currentTheme(), 'keybrDark', 'unknown theme → default');

// ---- text scale and board zoom ----
eq(currentTextScale(), 1.15, 'default text scale');
eq(applyTextScale(0.1), TEXT_SCALE.min, 'text scale clamps low');
eq(applyTextScale(9), TEXT_SCALE.max, 'text scale clamps high');
eq(applyTextScale(1.123), 1.1, 'rounds to the 0.05 step');
eq(currentTextScale(), 1.1, 'persisted'); eq(rootVars.get('--text-scale'), '1.1');
eq(currentBoardZoom(), 100, 'default board zoom');
eq(applyBoardZoom(40), BOARD_ZOOM.min); eq(applyBoardZoom(400), BOARD_ZOOM.max);
eq(applyBoardZoom(104), 100, 'rounds to the 10 step');
eq(rootVars.get('--board-zoom'), '1', 'board zoom is a ratio');

// ---- caption bar ----
const bar = { textContent: '' };
bindCaptionBar(bar);
eq(bar.textContent, CAPTION_DEFAULTS.keys, 'default line');
setCaptionGroup('behaviour'); eq(bar.textContent, CAPTION_DEFAULTS.behaviour, 'default follows group');
setCaption('hover text'); eq(bar.textContent, 'hover text');
setCaption(null); eq(currentCaption(), CAPTION_DEFAULTS.behaviour, 'leave restores default');

console.log(`shell-test: ${checks} checks OK`);
