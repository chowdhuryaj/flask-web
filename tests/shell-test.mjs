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

const { THEMES, DEFAULT_THEME, THEME_VARS, applyTheme, currentTheme, applyTextScale, currentTextScale,
        applyBoardZoom, currentBoardZoom, toggleTheme, modeOf, varsFor, TEXT_SCALE, BOARD_ZOOM } = await import('../themes.js?v=73');
const { bindCaptionBar, setCaption, setCaptionGroup, currentCaption, CAPTION_DEFAULTS } = await import('../caption.js?v=73');
const { TAB_TABLE, TAB_GROUPS, groupOf, SCREENS, BOARD_TABS, SIDE_TABS, screenOf, screensFor, tabsFor } = await import('../tab-registry.js?v=73');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

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

// ---- look-shell: screens (the top bar's second row) ----
eq(SCREENS.map((x) => x.id).join(), 'keymap,combos,behaviours,macros,device,test,trainer', 'screen order');
for (const t of TAB_TABLE) ok(SCREENS.some((x) => x.id === t.screen), `${t.id} has a screen`);
eq(screenOf('zmk-leader'), 'behaviours'); eq(screenOf('zmk-holdtiming'), 'behaviours'); eq(screenOf('keyboard'), 'device');
{
    const all = { trainerOnly: false, family: 'totem', caps: { zmkStudio: true, combos: true, macros: true, tapDance: true, customShift: true, leader: true, holdtap: true, gestures: false, mouse: false, rgbMap: false } };
    const tabs = tabsFor(all);
    const sc = screensFor(tabs);
    eq(sc.map((x) => x.id), ['keymap', 'combos', 'behaviours', 'macros', 'device', 'test', 'trainer'], 'totem shows every screen');
    eq(sc.find((x) => x.id === 'behaviours').tabs.map((t) => t.id), ['zmk-tapdance', 'zmk-shift', 'zmk-leader', 'zmk-holdtiming']);
    eq(sc.find((x) => x.id === 'keymap').tabs.length, 1, 'a one-tab screen has no sub-strip');
    eq(screensFor(tabsFor({ ...all, trainerOnly: true })).map((x) => x.id), ['trainer'], 'standalone trainer: one screen');
    // The board stays up for tabs that pick positions on it; only Keymap has the side panel.
    for (const id of ['zmk-keymap', 'zmk-combos', 'zmk-leader', 'zmk-holdtiming']) ok(BOARD_TABS.has(id), `${id} needs the board`);
    ok(!BOARD_TABS.has('zmk-macros') && !BOARD_TABS.has('keyboard'), 'macros / keyboard do not');
    eq([...SIDE_TABS], ['zmk-keymap']);
}

// ---- themes ----
eq(DEFAULT_THEME, 'graphite', 'default theme');
eq(currentTheme(), 'graphite', 'unset storage → default');
eq(THEMES.graphite.vars.bg, '#121212', 'Graphite: near-black');
eq(THEMES.graphite.vars.accent, '#d7f46c', 'one lime accent');
eq(THEMES.graphiteLight.vars.accent, '#d7f46c', 'light keeps the lime fill');
eq(THEMES.graphite.vars['on-accent'], '#1a1f05', 'dark ink on lime');
for (const id of ['graphite', 'graphiteLight']) for (const v of THEME_VARS) ok(varsFor(id)[v] != null, `${id} pins --${v}`);
for (const id of Object.keys(THEMES)) for (const v of THEME_VARS) ok(varsFor(id)[v] != null, `${id} resolves --${v}`);
eq(modeOf('graphite'), 'dark'); eq(modeOf('graphiteLight'), 'light'); eq(modeOf('nord'), 'dark'); eq(modeOf('solarized'), 'light');
applyTheme('nord');
eq(currentTheme(), 'nord'); eq(rootVars.get('--bg'), '#2e3440', 'nord pinned');
eq(rootVars.get('--c-layer') != null, true, 'older themes get the legend colours too');
applyTheme('classic');
eq(rootVars.get('--bg'), '#121212', 'System resolves to Graphite without an OS hint');
applyTheme('nope');
eq(currentTheme(), 'graphite', 'unknown theme → default');
toggleTheme(); eq(currentTheme(), 'graphiteLight', 'sun/moon: dark → light');
toggleTheme(); eq(currentTheme(), 'graphite', 'and back');

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
