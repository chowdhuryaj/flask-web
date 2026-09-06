# Appearance integration source review

**One narrow P2 finding; no other blocking findings in the audited diff.**

- **P2 — Layout Studio's faint token misses small-label contrast on selected/pressed keys.** `main.js:70` defines `faint: '#687382'`. Existing `.kb-svg .keyname` uses that token at 8 px (`styles.css:419`); selected key fill is `--accent-bg` (`412`) and pressed fill is `--ok-bg` (`413`). The new palette produces approximately **4.01:1** on `#e2ebfa` and **4.22:1** on `#e4f4ea`, below 4.5:1 for small text. Darken only the new palette's faint token enough for its tinted key surfaces; no change to prior palettes or geometry is needed. Ratios calculated directly from the source hex colors using WCAG relative luminance.

Reviewed `/tmp/astra-web-preservation.md` and actual diff against `d0b34f488d94af85024e00536dcecfb3d24559c1` in `/Users/aj/Flask-Svalboard/flask-web`. Runtime changes are confined to the theme/token table, paint declarations, and HTML cache stamps. No navigation, device, geometry, editor semantics, or zoom code changes were present.

Preservation evidence:

- `main.js:54–61,128–133`: all added optional tokens participate in `applyTheme` removal. Existing named themes and Classic therefore regain CSS fallbacks after switching away from Layout Studio.
- `styles.css:149–191`: header fallback values reproduce the prior background, text, border, hover, focus, and pill values. Warning/bad pills retain their existing rules; primary/danger buttons are excluded from the new neutral-control rule.
- `styles.css:323,403,1205`: card, SVG-key, and picker finishes use opt-in tokens; inspected original selectors had no overwritten key finish. Layout geometry and input hitboxes stay untouched.
- `main.js:874–889`: saved theme selection and independent zoom initialization/listeners are unchanged.
- `hud.js:82–98`: the popup copies the stylesheet URL and entire root inline style, which includes the new tokens. No new HUD-specific synchronization regression is introduced.

`git diff --check` passed. Read-only source review only; no screenshots, visual QA, browser tests, network, or hardware actions performed. Root handles baseline/current computed-style comparisons and offline workflow tests separately.
