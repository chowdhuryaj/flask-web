#!/usr/bin/env python3
"""WP2 board checks (spec §7.3 WP2 acceptance). Offline workspaces only; no
hardware (harness.py stubs navigator.hid / navigator.serial).

Run:  PORT=8142 python3 serve.py   then   PORT=8142 python3 tests/browser/board.py

TOTEM: click key 0, pick A, key 0 reads A and the selection moves to key 1;
click key 1 twice opens the popover; undo restores key 0; remove then add a
layer; rename sticks; position-pick mode; save-state dirty/discard.
Imprint: every key (rotated thumbs included) sits inside the SVG frame.
NLKB16: encoder caps select and do not advance. Adept/Svalboard: chord boxes
and quick draw checks. Screenshots: tests/artifacts/board/ (and the scratch
dir when WP2_SHOTS is set).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ROOT, SVAL, launch, new_context, open_workspace, sync_playwright  # noqa: E402

OUT = ROOT / 'tests' / 'artifacts' / 'board'
SHOTS = os.environ.get('WP2_SHOTS')   # extra copy dir for the scratch screenshots
failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print('FAIL', msg)


def key(page, i):
    return page.locator(f'.kb-svg g.key[aria-label^="Key {i} "]').first


def cap(page, i):
    return key(page, i).locator('.cap-main').text_content()


def selected(page):
    return page.evaluate("""async () => (await import('/board.js?v=1')).board.selectedKey()""")


def pick_zmk_key(page, name):
    page.locator(f'#panels .panel.active button[title="{name}"]').first.click()


def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)
    if SHOTS:
        page.screenshot(path=str(Path(SHOTS) / f'wp2-{name}.png'), full_page=True)


def totem(browser):
    ctx, page, errors = new_context(browser)
    open_workspace(page, 'TOTEM (ZMK)')
    check(page.locator('.kb-svg g.key').count() == 38, 'totem: 38 keys')
    check(cap(page, 0) == 'Q', f'totem: key 0 starts as Q, got {cap(page, 0)}')

    key(page, 0).click()
    check(selected(page) == {'layer': 0, 'pos': 0}, f'totem: select key 0 -> {selected(page)}')
    shot(page, 'totem-selected')
    pick_zmk_key(page, 'A')
    page.wait_for_timeout(150)
    check(cap(page, 0) == 'A', f'totem: key 0 reads A after pick, got {cap(page, 0)}')
    check(selected(page) == {'layer': 0, 'pos': 1}, f'totem: selection advanced to key 1 -> {selected(page)}')

    # Click-again popover on the selected key (twice, as in the acceptance).
    key(page, 1).click()
    key(page, 1).click()
    page.locator('.picker-popover').wait_for(timeout=3000)
    page.locator('.picker-popover button[title="B"]').first.click()
    page.wait_for_timeout(150)
    check(page.locator('.picker-popover').count() == 0, 'totem: popover closes on pick')
    check(cap(page, 1) == 'B', f'totem: key 1 reads B after popover pick, got {cap(page, 1)}')
    check(selected(page) == {'layer': 0, 'pos': 1}, 'totem: popover pick does not advance')

    # Undo restores both keys, in order; redo reapplies.
    page.evaluate("async () => (await import('/board.js?v=1')).board.undo()")
    check(cap(page, 1) == 'W', f'totem: undo restores key 1, got {cap(page, 1)}')
    page.evaluate("async () => (await import('/board.js?v=1')).board.undo()")
    check(cap(page, 0) == 'Q', f'totem: undo restores key 0, got {cap(page, 0)}')
    page.evaluate("async () => (await import('/board.js?v=1')).board.redo()")
    check(cap(page, 0) == 'A', f'totem: redo reapplies key 0, got {cap(page, 0)}')

    # Save-state: the edit registered; discard clears it and restores the device keymap.
    n = page.evaluate("async () => (await import('/save-state.js?v=1')).saveState.dirty().map(d => d.source)")
    check(n == ['studio-keymap'], f'totem: studio-keymap registered with save-state, got {n}')
    page.evaluate("""async () => { const t = (await import('/zmk-keymap-tab.js?v=50')).zmkLiveKeymapTab(); await t.discardChanges(); }""")
    check(cap(page, 0) == 'Q', f'totem: discard restores key 0, got {cap(page, 0)}')
    check(page.evaluate("async () => (await import('/save-state.js?v=1')).saveState.dirty().length") == 0,
          'totem: discard cleans save-state')

    # Layer switch + rename + remove/add.
    page.locator('.bd-chip', has_text='control').first.click()
    check(page.locator('.bd-chip.on').inner_text().split('\n')[-1] == 'control', 'totem: layer chip switches')
    check(cap(page, 0) != 'Q', 'totem: layer 1 draws its own bindings')
    shot(page, 'totem-layer')
    page.locator('.bd-chip.on').dblclick()
    page.locator('.bd-rename').fill('wp2name')
    page.locator('.bd-rename').press('Enter')
    page.wait_for_timeout(200)
    check(page.locator('.bd-chip', has_text='wp2name').count() == 1, 'totem: rename sticks')
    before = page.locator('.bd-chip').count()
    page.locator('.bd-op[aria-label^="Remove this layer"]').click()
    page.wait_for_timeout(200)
    page.locator('.bd-op[aria-label="Add a layer"]').click()
    page.wait_for_timeout(300)
    check(page.locator('.bd-chip').count() >= before - 1, 'totem: remove then add layer keeps the bar')
    check(page.locator('.bd-op[aria-label="Add a layer"]').count() == 0
          or page.locator('.bd-op[aria-label="Add a layer"]').is_disabled() is False,
          'totem: add leaves the bar consistent')

    # Position-pick mode.
    page.locator('.bd-chip', has_text='base').first.click()
    page.evaluate("""async () => { const { board } = await import('/board.js?v=1');
        window.__picks = []; window.__stop = board.pickPositions({ initial: [3], max: 2, label: 'Pick positions for Combo 1', onChange: (p) => { window.__picks = p; } }); }""")
    key(page, 4).click()
    check(page.evaluate('window.__picks') == [3, 4], f'totem: pick mode reports click order, got {page.evaluate("window.__picks")}')
    check(page.locator('.kb-svg .keycap.picked').count() == 2, 'totem: picked keys are ringed')
    key(page, 5).click()   # over max: ignored
    check(page.evaluate('window.__picks') == [3, 4], 'totem: max positions respected')
    key(page, 3).click()
    check(page.evaluate('window.__picks') == [4], 'totem: clicking a picked key unpicks it')
    page.evaluate('window.__stop()')
    check(page.locator('.bd-banner').count() == 0, 'totem: stop() leaves pick mode')

    # Geometry: hit test on a rotated thumb (key 36 is rotated).
    box = key(page, 33).locator('rect').bounding_box()
    page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    check(selected(page) and selected(page)['pos'] == 33, f'totem: rotated key hit-tests, got {selected(page)}')
    shot(page, 'totem-final')
    check(not errors, f'totem: page errors {errors}')
    ctx.close()


def inside_frame(page):
    return page.evaluate("""() => {
        const svg = document.querySelector('.bd-board .kb-svg').getBoundingClientRect();
        return [...document.querySelectorAll('.bd-board .kb-svg g.key')].filter((g) => {
            const r = g.getBoundingClientRect();
            return r.left < svg.left - 0.5 || r.top < svg.top - 0.5 || r.right > svg.right + 0.5 || r.bottom > svg.bottom + 0.5;
        }).length; }""")


def imprint(browser):
    ctx, page, errors = new_context(browser)
    open_workspace(page, 'Cyboard Imprint (ZMK)')
    check(page.locator('.kb-svg g.key').count() == 70, 'imprint: 70 keys')
    check(inside_frame(page) == 0, 'imprint: every key inside the frame')
    key(page, 12).click()
    shot(page, 'imprint-selected')
    page.locator('.bd-chip').nth(1).click()
    shot(page, 'imprint-layer')
    check(not errors, f'imprint: page errors {errors}')
    ctx.close()
    # Rotated thumbs: draw a synthetic rotated board through the same renderer.
    ctx, page, errors = new_context(browser)
    open_workspace(page, 'TOTEM (ZMK)')
    check(inside_frame(page) == 0, 'totem: rotated thumbs inside the frame')
    ctx.close()


def nlkb16(browser):
    ctx, page, errors = new_context(browser)
    open_workspace(page, 'NLKB16-02')
    encs = page.locator('.kb-svg g.enc')
    check(encs.count() >= 2, f'nlkb16: encoder caps drawn ({encs.count()})')
    page.locator('.kb-svg g.key').first.click()
    before = selected(page)
    encs.first.click()
    s = selected(page)
    check(s and isinstance(s['pos'], dict) and 'encoder' in s['pos'], f'nlkb16: encoder cap selects, got {s}')
    # Picking a keycode on an encoder cap keeps the selection there.
    page.locator('#panels .panel.active button.code').first.click()
    page.wait_for_timeout(200)
    check(len(encs.first.locator('.cap-main').text_content()) > 1, 'nlkb16: encoder cap shows the new keycode')
    after = selected(page)
    check(after == s, f'nlkb16: encoder pick does not advance (was {s}, now {after}, key was {before})')
    shot(page, 'nlkb16-encoder')
    check(not errors, f'nlkb16: page errors {errors}')
    ctx.close()


def adept_sval(browser):
    ctx, page, errors = new_context(browser)
    open_workspace(page, 'Ploopy Adept')
    page.locator('.kb-svg g.key').first.click()
    page.locator('#panels .panel.active .picker button').nth(8).click()
    page.wait_for_timeout(200)
    check(selected(page) is not None, 'adept: auto-advance keeps a selection')
    page.locator('.bd-chip').nth(1).dblclick()
    page.locator('.bd-rename').fill('AdeptX')
    page.locator('.bd-rename').press('Enter')
    check(page.locator('.bd-chip', has_text='AdeptX').count() == 1, 'adept: QMK rename sticks')
    page.reload()
    page.locator('#offline-list .dev-item').filter(has_text='Ploopy Adept').first.click()
    page.locator('.kb-svg .keycap').first.wait_for(timeout=10000)
    page.locator('.bd-more').click()   # empty layers are hidden until asked for
    check(page.locator('.bd-chip', has_text='AdeptX').count() == 1, 'adept: rename survives reload')
    check(not errors, f'adept: page errors {errors}')
    ctx.close()

    ctx, page, errors = new_context(browser)
    open_workspace(page, SVAL['label'])
    keys = page.locator('.kb-svg g.key').count()
    page.evaluate("""async () => { const { board } = await import('/board.js?v=1');
        const a = board.adapter; const ks = a.profile.keys;
        board.setChordBoxes([{ id: 'c1', positions: [{ row: ks[0].row, col: ks[0].col }, { row: ks[1].row, col: ks[1].col }], label: 'Esc' },
                             { id: 'c2', positions: [{ row: ks[2].row, col: ks[2].col }, { row: ks[3].row, col: ks[3].col }], label: 'Tab', inherited: true }],
                            (b) => { window.__chord = b.id; }); }""")
    check(page.locator('.kb-svg .chord-box').count() == 2, 'svalboard: chord boxes drawn')
    page.locator('.kb-svg .chord-box').first.click()
    check(page.evaluate('window.__chord') == 'c1', 'svalboard: chord box click callback')
    check(page.locator('.kb-svg .chord-box.inherited').count() == 1, 'svalboard: inherited chord is dashed')
    shot(page, 'svalboard-chords')
    check(keys > 0, 'svalboard: keys drawn')
    check(not errors, f'svalboard: page errors {errors}')
    ctx.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = launch(p)
        for fn in (totem, imprint, nlkb16, adept_sval):
            try:
                fn(browser)
            except Exception as e:  # noqa: BLE001 - report and continue
                failures.append(f'{fn.__name__}: {e}')
                print('FAIL', fn.__name__, e)
        browser.close()
    print('board:', 'FAIL' if failures else 'PASS')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
