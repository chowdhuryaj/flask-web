#!/usr/bin/env python3
"""look-shell checks. Run:  PORT=8141 python3 serve.py  then
PORT=8141 python3 tests/browser/lookshell.py

TOTEM offline preview at 1024 and 768 wide, dark and light:
- the three-zone Keymap screen (layer rail, board over dock, side panel) and the
  top bar (keyboard chip, undo/redo, "..." menu, theme switch, one Save);
- select a key + one modifier chip = a tap-hold, one undo step, no popover;
- plain tile pick auto-advances; armed modifiers + banner; drag a tile onto a key;
- Layers category tiles; the Layers index in the side panel jumps to a key;
- clicking the selected key again opens nothing;
- the menu entries exist and do not throw before look-extras' globals exist;
- no horizontal page scroll; zero page errors.
Screenshots land in tests/artifacts/lookshell/.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness as h  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = h.ROOT / 'tests' / 'artifacts' / 'lookshell'
FAIL = []


def check(ok, msg):
    if not ok:
        FAIL.append(msg)
        print('FAIL', msg)


def cap(page, i):
    return page.locator('#board-slot g.key').nth(i).text_content()


def key_index(page, text):
    return page.evaluate("""(t) => [...document.querySelectorAll('#board-slot g.key')]
        .findIndex((g) => g.querySelector('.cap-main')?.textContent === t)""", text)


def run(browser, size, theme):
    tag = f'{size[0]}-{theme}'
    ctx, page, errors = h.new_context(browser, viewport=size)
    page.add_init_script(f"localStorage.setItem('flask-theme', '{theme}')")
    h.open_workspace(page, 'TOTEM (ZMK)')
    # ---- frame ----
    check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{tag}: no horizontal page scroll')
    check(page.locator('.maintab').all_inner_texts()[0] == 'Keymap', f'{tag}: Keymap tab first')
    check(page.locator('#rail .bd-chip').count() >= 5, f'{tag}: layer rail pills')
    check(page.locator('.dock').count() == 1 and page.locator('#side .insp').count() == 1, f'{tag}: dock and side panel')
    check(page.locator('#save-btn.primary').count() == 1, f'{tag}: one primary Save')
    check(page.locator('#discard-btn').count() == 1 and page.locator('#offline-discard').is_hidden(), f'{tag}: one visible Discard')
    check(page.evaluate("getComputedStyle(document.body).backgroundColor") != 'rgba(0, 0, 0, 0)', f'{tag}: body background')
    check(page.evaluate("document.documentElement.dataset.theme") == ('dark' if theme == 'graphite' else 'light'), f'{tag}: theme mode')
    # nothing selected: shortcuts + layers index + lint
    check(page.locator('[data-card="shortcuts"]').count() == 1 and page.locator('[data-card="layers"]').count() == 1, f'{tag}: default side panel')
    chips = page.locator('.lyr-chip').all_inner_texts()
    check(any('key 26' in c and '&num' in c for c in chips), f'{tag}: layers index lists NUM <- key 26 &num ({chips})')
    check(page.locator('.lyr[data-layer="1"] .lyr-chip[data-combo]').count() >= 1, f'{tag}: combos count as a way in')
    if size[0] == 1024:
        page.screenshot(path=str(OUT / f'layout-{tag}.png'))
    # ---- select + one chip = tap-hold ----
    f_idx = key_index(page, 'F')
    page.locator('#board-slot g.key').nth(f_idx).click()
    check(page.locator('#side .insp[data-view="key"]').count() == 1, f'{tag}: selecting shows the inspector')
    check(page.locator('.slot.s-tap').is_visible() and page.locator('.slot.s-hold').is_visible(), f'{tag}: TAP and HOLD always visible')
    page.locator('.insp .chip[data-mod="Sft"]').click()
    page.wait_for_timeout(500)
    check('⇧' in page.locator('#board-slot g.key').nth(f_idx).text_content(), f'{tag}: one chip made F a mod-tap ({cap(page, f_idx)})')
    check(page.locator('.insp .ht-card').count() == 1 or page.locator('.ht-host').count() == 1, f'{tag}: timing card')
    check(page.locator('.picker-popover').count() == 0, f'{tag}: no popover')
    check(not page.locator('#undo-btn').is_disabled(), f'{tag}: undoable')
    page.locator('#board-slot g.key').nth(f_idx).click()   # click again: harmless
    page.wait_for_timeout(200)
    check(page.locator('.picker-popover, .modal-back').count() == 0, f'{tag}: click-again opens nothing')
    flavors = page.locator('.ht-card .flavor')
    if flavors.count():
        check(flavors.count() == 4 and all(len(t) > 40 for t in flavors.all_inner_texts()), f'{tag}: four flavours with a sentence each')
    if size[0] == 768:
        page.screenshot(path=str(OUT / f'inspector-taphold-{tag}.png'))
    page.locator('#undo-btn').click()
    page.wait_for_timeout(500)
    check('⇧' not in page.locator('#board-slot g.key').nth(f_idx).text_content(), f'{tag}: undo reverts it')
    # ---- plain pick auto-advances ----
    page.locator('#board-slot g.key').nth(0).click()
    page.locator('.tile[data-tile="key:letters:29:0"]').click()    # Z
    page.wait_for_timeout(400)
    check(cap(page, 0).startswith('Z'), f'{tag}: tile click assigns')
    check('Key 1' in page.locator('.insp-title').inner_text(), f'{tag}: selection advanced')
    # ---- type-to-assign and Press a key still work ----
    page.locator('#board-slot g.key').nth(2).click()
    page.get_by_role('button', name='Type-to-assign').click()
    page.keyboard.press('b')
    page.wait_for_timeout(400)
    check(cap(page, 2).startswith('B'), f'{tag}: type-to-assign wrote B ({cap(page, 2)})')
    check('Key 3' in page.locator('.insp-title').inner_text(), f'{tag}: type-to-assign advances')
    page.keyboard.press('Escape')
    page.get_by_role('button', name='Press a key').click()
    page.keyboard.press('n')
    page.wait_for_timeout(400)
    check(cap(page, 3).startswith('N'), f'{tag}: Press a key wrote N ({cap(page, 3)})')
    # ---- fonts are the vendored ones ----
    fonts = page.evaluate("async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family); }")
    check(any('Plus Jakarta' in f for f in fonts) and any('JetBrains' in f for f in fonts), f'{tag}: vendored fonts loaded ({fonts})')
    # ---- armed modifiers + banner ----
    page.locator('#board-slot g.key').nth(1).click()
    page.locator('.dock-mods .chip[data-mod="Ctl"]').click()
    check('Key tiles will send Ctl with the key' in page.locator('.dock-banner').inner_text(), f'{tag}: armed banner')
    page.locator('.tile[data-tile="key:letters:6:0"]').click()     # C
    page.wait_for_timeout(400)
    check(cap(page, 1).startswith('⌃C'), f'{tag}: next tile sent Ctl+C ({cap(page, 1)})')
    page.locator('.dock-banner .btn').click()
    # ---- drag a tile onto a key ----
    # Synthetic DnD: at 768 the board and the dock are not both on screen.
    page.evaluate("""() => {
        const dt = new DataTransfer();
        document.querySelector('.tile[data-tile="key:letters:4:0"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const k = document.querySelectorAll('#board-slot g.key')[5];
        k.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        k.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }""")
    page.wait_for_timeout(500)
    check(cap(page, 5).startswith('A'), f'{tag}: drag assigns ({cap(page, 5)})')
    # ---- layer tiles ----
    page.locator('.dock-side [data-tab="behaviours"]').click()
    page.locator('.dock-cats [data-cat="Layers"]').click()
    tiles = page.locator('.dock-grid .tile').all_inner_texts()
    check(any('mo' in t for t in tiles) and any(t.replace('\n', '').startswith('A') for t in tiles), f'{tag}: layer tiles (mo and A / layer)')
    for code in ('mo', 'tog', 'to', 'sl'):
        check(any(t.endswith(code) for t in tiles), f'{tag}: {code} tiles')
    if size[0] == 1024:
        page.locator('.dock-mods .chip[data-mod="Ctl"]').click()
        page.screenshot(path=str(OUT / f'palette-layer-tiles-{tag}.png'))
        page.locator('.dock-banner .btn').click()
    # ---- dock collapse ----
    page.locator('.dock-toggle').click()
    check(page.locator('.dock-body').is_hidden(), f'{tag}: dock collapses')
    page.locator('.dock-toggle').click()
    # ---- layers index jump ----
    page.keyboard.press('Escape'); page.keyboard.press('Escape')
    page.locator('.insp-head .btn').click() if page.locator('.insp-head .btn').count() else None
    page.locator('.lyr[data-layer="4"] .lyr-chip').first.click()
    page.wait_for_timeout(300)
    check('Key 26' in page.locator('.insp-title').inner_text(), f'{tag}: chip jumps to and selects key 26')
    # ---- menu ----
    page.locator('#more-btn').click()
    items = page.locator('#more-menu button:visible').all_inner_texts()
    check('Export .keymap' in items and 'Print layer sheet' in items, f'{tag}: menu entries ({items})')
    page.locator('#more-btn').click()
    # ---- theme switch ----
    page.locator('#theme-light' if theme == 'graphite' else '#theme-dark').click()
    page.wait_for_timeout(200)
    check(page.evaluate("document.documentElement.dataset.theme") == ('light' if theme == 'graphite' else 'dark'), f'{tag}: theme switch')
    # css/extras.css arrives with look-extras; until then its 404 is expected.
    errors = [e for e in errors if (h.ROOT / 'css' / 'extras.css').exists() or 'status of 404' not in e]
    check(not errors, f'{tag}: page errors {errors}')
    ctx.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = h.launch(p)
        for size in ((1024, 768), (768, 1024)):
            for theme in ('graphite', 'graphiteLight'):
                run(browser, size, theme)
        browser.close()
    print('lookshell:', 'FAIL' if FAIL else 'PASS')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
