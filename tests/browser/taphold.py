#!/usr/bin/env python3
"""Tap-hold in the key inspector (look-shell; replaces the WP3b popover composer
checks). Offline TOTEM workspace only; no hardware.

Run:  PORT=8153 python3 serve.py   then   PORT=8153 python3 tests/browser/taphold.py

- select F, tap the Gui chip: F becomes a hold-tap at once (one undo step), the
  cap shows tap F big with a hold sub-label, the binding is Hold-Tap L (live);
- a right-hand key defaults to the Right side (no extra click);
- Hold does Layer: one layer chip makes a layer-tap; HOLD key: HOLD box + a tile;
- the timing card shows the term slider and four flavours with a sentence each;
  the slider writes the key's slot and the edit lands in the one Save;
- the home-row mods preset applies 8 keys, one undo reverts them;
- after an edit the dock stays on the category the user was on.
Screenshots: tests/artifacts/taphold/.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ROOT, launch, new_context, open_workspace, sync_playwright  # noqa: E402

OUT = ROOT / 'tests' / 'artifacts' / 'taphold'
failures = []


def check(cond, msg):
    print('ok  ' if cond else 'FAIL', msg)
    if not cond:
        failures.append(msg)


KEY_INDEX = """(cap) => [...document.querySelectorAll('#board-slot g.key')]
    .findIndex((g) => g.querySelector('.cap-main')?.textContent === cap)"""


def keys(page):
    return page.locator('#board-slot g.key')


def undo(page):
    page.locator('#undo-btn').click()
    page.wait_for_timeout(300)


def totem(browser):
    OUT.mkdir(parents=True, exist_ok=True)
    ctx, page, errors = new_context(browser)
    open_workspace(page, 'TOTEM (ZMK)')
    i = page.evaluate(KEY_INDEX, 'F')
    check(i >= 0, 'a key reads F')
    keys(page).nth(i).click()
    check(page.locator('.slot.s-tap').is_visible() and page.locator('.slot.s-hold').is_visible(), 'TAP and HOLD boxes are visible with no extra click')
    check(page.locator('.insp [data-act="th-apply"]').count() == 0, 'there is no Apply button')
    page.locator('.dock-side [data-tab="behaviours"]').click()     # the dock category must survive the edit
    page.locator('.insp .chip[data-mod="Gui"]').click()
    page.wait_for_timeout(500)
    g = keys(page).nth(i)
    check(g.locator('.cap-main').text_content() == 'F' and g.locator('.cap-sub').text_content() == '⌘', 'F reads F with ⌘ under it')
    src = page.locator('.insp-src').text_content()
    check('Hold-Tap L (live)' in src, f'left-hand key on &fht_l: {src}')
    check(page.locator('.dock-side [data-tab="behaviours"].on').count() == 1, 'the dock stays on Behaviours after the edit')
    check(page.locator('.slot.s-hold .slot-val').text_content() == '⌘', 'HOLD box shows ⌘')
    # timing card
    page.locator('.ht-card').wait_for(timeout=5000)
    check(page.locator('.ht-card input[type=range]').count() == 1, 'timing card: term slider')
    fl = page.locator('.ht-card .flavor').all_inner_texts()
    check(len(fl) == 4 and all(len(t) > 40 for t in fl), f'four flavours with a sentence each ({len(fl)})')
    page.locator('.ht-card input[type=range]').evaluate('(s) => { s.value = 330; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); }')
    page.wait_for_timeout(400)
    term = page.evaluate("JSON.parse(localStorage.getItem('flask-offline-totem')).zmk.holdtap[13].term")
    check(term == 330, f'slider wrote the key slot (term {term})')
    dirty = page.evaluate("async () => (await import('/save-state.js?v=64')).saveState.dirty().map(d => d.label)")
    check('Hold-tap timing' in dirty, f'timing edit is in the one Save: {dirty}')
    page.locator('.ht-card .flavor').nth(2).click()
    page.wait_for_timeout(300)
    check(page.locator('.ht-card .flavor.on').count() == 1, 'one flavour selected')
    page.screenshot(path=str(OUT / 'totem-inspector.png'))
    # toggling the chip off returns to a plain key, in one undo step each
    page.locator('.insp .chip[data-mod="Gui"]').click()
    page.wait_for_timeout(400)
    check(keys(page).nth(i).locator('.cap-sub').count() == 0, 'chip off: plain F again')
    undo(page)
    check(keys(page).nth(i).locator('.cap-sub').count() == 1, 'undo brings the hold back')
    undo(page)
    check(keys(page).nth(i).locator('.cap-sub').count() == 0, 'second undo: plain F')

    # right-hand key defaults to the Right side
    j = page.evaluate(KEY_INDEX, 'J')
    keys(page).nth(j).click()
    check(page.locator('.insp [data-side="R"].on').count() == 1, 'a right-hand key defaults to Right')
    page.locator('.insp .chip[data-mod="Sft"]').click()
    page.wait_for_timeout(400)
    check('Hold-Tap R (live)' in page.locator('.insp-src').text_content(), 'right-hand key on &fht_r')
    undo(page)

    # Layer hold: one chip
    keys(page).nth(i).click()
    page.locator('.insp [data-kind="layer"]').click()
    page.locator('.insp [data-layer="1"]').click()
    page.wait_for_timeout(500)
    check(keys(page).nth(i).locator('.cap-sub.s-layer').count() == 1, 'layer-tap: blue layer sub-label')
    undo(page)

    # Hold key: arm the HOLD box, click a tile
    page.locator('.insp [data-kind="key"]').click()
    page.locator('.insp-holdkey .btn').click()
    check('HOLD key' in page.locator('.dock-banner').text_content(), 'dock says tiles will set the HOLD key')
    page.locator('.dock-side [data-tab="keys"]').click()
    page.locator('.dock-cats [data-cat="function"]').click()
    page.locator('.dock-grid .tile[data-tile^="key:function:"]').first.click()
    page.wait_for_timeout(500)
    check(page.locator('.slot.s-hold .slot-val').text_content() != '—', 'HOLD key set')
    undo(page)

    # Rotated thumbs keep their labels (live hold-taps on the default keymap)
    thumbs = page.evaluate("""() => [...document.querySelectorAll('#board-slot g.key.k-hold')]
        .filter(g => g.getAttribute('transform') && g.querySelector('.cap-sub')).length""")
    check(thumbs > 0, f'{thumbs} rotated thumb keys draw a hold sub-label')

    # Home-row mods preset
    keys(page).nth(i).click()
    page.locator('.insp [data-act="hrm"]').click()
    picked = page.locator('#board-slot .keycap.picked').count()
    check(picked == 8, f'home row pre-picked ({picked})')
    page.locator('.insp [data-order="GACS"]').click()
    page.screenshot(path=str(OUT / 'totem-homerow-pick.png'))
    check(not page.locator('.insp [data-act="hrm-apply"]').is_disabled(), 'preset Apply enabled')
    page.locator('.insp [data-act="hrm-apply"]').click()
    page.wait_for_timeout(500)
    holds = page.locator('#board-slot g.key.k-hold .cap-sub').evaluate_all('xs => xs.map(x => x.textContent)')
    check(sum(1 for t in holds if any(m in t for m in '⌘⌥⌃⇧')) >= 8, f'home-row caps {holds}')
    undo(page)
    check(page.evaluate(KEY_INDEX, 'F') >= 0 and keys(page).nth(i).locator('.cap-sub').count() == 0, 'one undo reverts the preset')
    check(not errors, f'no page errors {errors}')
    ctx.close()


def main():
    with sync_playwright() as p:
        browser = launch(p)
        try:
            totem(browser)
        except Exception as e:  # noqa: BLE001
            failures.append(f'totem: {e}')
            print('FAIL totem', e)
        browser.close()
    print('taphold:', 'FAIL' if failures else 'PASS')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
